import type Database from 'better-sqlite3';
import { Server } from '@tus/server';
import { FileStore } from '@tus/file-store';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, createReadStream, statfsSync, statSync } from 'node:fs';
import { copyFile, rename, open, unlink, mkdir, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import type { Attachment } from '../../lib/workspace/contracts.ts';
import {
  AttachmentValidationError,
  ConflictError,
  ResourceNotFoundError,
} from '../storage/errors.ts';

// Vinext declares sharp's default export as unknown. Keep the server-only surface explicit.
const inspectImage = sharp as (
  path: string,
  options: { limitInputPixels: number },
) => {
  metadata(): Promise<{
    format?: string;
    width?: number;
    height?: number;
    pages?: number;
  }>;
  resize(options: {
    width: number;
    height: number;
    fit: 'inside';
    withoutEnlargement: boolean;
  }): { png(): { toFile(path: string): Promise<unknown> } };
};
const MiB = 1024 * 1024;
const ttl = 24 * 60 * 60 * 1000;
interface AssetRow {
  id: string;
  project: string;
  name: string;
  size: number;
  mime: string;
  sha256: string | null;
  state: string;
  created: number;
}
export class AttachmentService {
  readonly active = new Set<string>();
  readonly tus: Server;
  readonly files: FileStore;
  private readonly finalizing = new Map<string, Promise<Attachment>>();
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(
    private readonly db: Database.Database,
    readonly directory: string,
    private readonly limits = {
      quotaBytes: 10 * 1024 * MiB,
      minimumFreeBytes: 256 * MiB,
    },
  ) {
    mkdirSync(resolve(directory, 'objects'), { recursive: true, mode: 0o700 });
    db.exec(`CREATE TABLE IF NOT EXISTS attachment_assets (
      id TEXT PRIMARY KEY, project TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL,
      size INTEGER NOT NULL, mime TEXT NOT NULL, sha256 TEXT, state TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS turn_attachments (
      turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      asset_id TEXT NOT NULL REFERENCES attachment_assets(id), position INTEGER NOT NULL,
      PRIMARY KEY(turn_id, position), UNIQUE(turn_id, asset_id));`);
    this.files = new FileStore({ directory: resolve(directory, 'uploads') });
    this.tus = new Server({
      path: '/api/v1/uploads',
      datastore: this.files,
      relativeLocation: true,
      maxSize: 50 * MiB,
      namingFunction: () => randomUUID(),
      getFileIdFromRequest: (req) =>
        new URL(req.url).pathname.match(/\/uploads\/([0-9a-f-]{36})$/)?.[1],
      onUploadCreate: async (_req, upload) => {
        const { name, project, mime } = upload.metadata ?? {};
        if (
          !name ||
          name.length > 255 ||
          Array.from(name).some(
            (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
          ) ||
          !project ||
          !db.prepare('SELECT id FROM projects WHERE id = ?').get(project) ||
          !upload.size ||
          upload.size > 50 * MiB ||
          (mime?.startsWith('image/') && upload.size > 10 * MiB)
        )
          throw {
            status_code: 400,
            body: 'Invalid file, project, or size. Images: 10 MiB; files: 50 MiB.',
          };
        const reserved = db
          .prepare(
            'SELECT COALESCE(SUM(size),0) AS total FROM attachment_assets',
          )
          .get() as { total: number };
        const disk = statfsSync(directory);
        if (
          reserved.total + upload.size > this.limits.quotaBytes ||
          disk.bavail * disk.bsize <
            2 * upload.size + this.limits.minimumFreeBytes
        )
          throw { status_code: 413, body: 'Attachment storage is full.' };
        db.prepare(
          'INSERT INTO attachment_assets VALUES (?, ?, ?, ?, ?, NULL, ?, ?)',
        ).run(
          upload.id,
          project,
          name,
          upload.size,
          mime?.slice(0, 120) || 'application/octet-stream',
          'uploading',
          Date.now(),
        );
        return {};
      },
      onIncomingRequest: async (req, id) => {
        if (req.method === 'GET' || req.headers.get('x-http-method-override'))
          throw { status_code: 405, body: 'Unsupported upload method.' };
        if (id && req.method !== 'POST') {
          const row = this.row(id);
          if (!row) throw { status_code: 404, body: 'Upload not found.' };
          if (req.method === 'DELETE')
            throw {
              status_code: 405,
              body: 'Use the attachment cancellation endpoint.',
            };
          if (req.method === 'PATCH' && row.state !== 'uploading')
            throw { status_code: 409, body: 'Upload is already finalized.' };
        }
      },
    });
    this.timer = setInterval(
      () => void this.sweep().catch(() => {}),
      15 * 60 * 1000,
    );
    this.timer.unref();
  }
  close() {
    clearInterval(this.timer);
  }
  row(id: string): AssetRow | undefined {
    return this.db
      .prepare('SELECT * FROM attachment_assets WHERE id = ?')
      .get(id) as AssetRow | undefined;
  }
  path(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id))
      throw new ResourceNotFoundError('Attachment', id);
    return resolve(this.directory, 'objects', id);
  }
  get(id: string): Attachment {
    const row = this.row(id);
    if (!row) throw new ResourceNotFoundError('Attachment', id);
    return {
      id: row.id,
      name: row.name,
      size: row.size,
      mime: row.mime,
      state: row.state as Attachment['state'],
    };
  }
  finalize(id: string): Promise<Attachment> {
    if (this.active.has(id))
      throw new ConflictError('Upload is still active. Retry shortly.');
    if (this.finalizing.size >= 2 && !this.finalizing.has(id))
      throw new ConflictError('Verification slots are busy. Retry shortly.');
    const pending = this.finalizing.get(id);
    if (pending) return pending;
    const job = this.verify(id).finally(() => this.finalizing.delete(id));
    this.finalizing.set(id, job);
    return job;
  }
  private async verify(id: string): Promise<Attachment> {
    const row = this.row(id);
    if (!row) throw new ResourceNotFoundError('Attachment', id);
    if (row.state === 'ready') return this.get(id);
    const upload = await this.files.getUpload(id);
    if (upload.offset !== row.size)
      throw new ConflictError(
        'Upload is incomplete. Resume it before sending.',
      );
    this.db
      .prepare("UPDATE attachment_assets SET state = 'verifying' WHERE id = ?")
      .run(id);
    const source = resolve(this.directory, 'uploads', id);
    try {
      let mime = 'application/octet-stream';
      const metadata = await inspectImage(source, {
        limitInputPixels: 40_000_000,
      })
        .metadata()
        .catch(() => undefined);
      if (metadata) {
        if (
          !['png', 'jpeg', 'webp', 'gif'].includes(metadata.format ?? '') ||
          !metadata.width ||
          !metadata.height ||
          row.size > 10 * MiB ||
          metadata.width * metadata.height * (metadata.pages ?? 1) > 40_000_000
        )
          throw new ConflictError(
            'Unsupported or oversized image. Use PNG, JPEG, WebP or GIF.',
          );
        mime = `image/${metadata.format}`;
      } else if (
        row.mime.startsWith('image/') ||
        /\.(png|jpe?g|webp|gif|heic|heif|svg)$/i.test(row.name)
      ) {
        throw new ConflictError(
          'This image cannot be validated. Export it as PNG or JPEG and try again.',
        );
      }
      const hash = createHash('sha256');
      let bytes = 0;
      for await (const chunk of createReadStream(source)) {
        hash.update(chunk);
        bytes += chunk.length;
      }
      if (bytes !== row.size)
        throw new ConflictError('File size changed during verification.');
      const destination = this.path(id);
      await copyFile(source, destination + '.part');
      const handle = await open(destination + '.part', 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(destination + '.part', destination);
      if (mime.startsWith('image/'))
        await inspectImage(source, { limitInputPixels: 40_000_000 })
          .resize({
            width: 320,
            height: 240,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .png()
          .toFile(destination + '.preview.png');
      const folder = await open(resolve(this.directory, 'objects'), 'r');
      try {
        await folder.sync();
      } finally {
        await folder.close();
      }
      this.db
        .prepare(
          "UPDATE attachment_assets SET state = 'ready', mime = ?, sha256 = ? WHERE id = ?",
        )
        .run(mime, hash.digest('hex'), id);
      return this.get(id);
    } catch (error) {
      this.db
        .prepare(
          "UPDATE attachment_assets SET state = 'uploading' WHERE id = ?",
        )
        .run(id);
      throw error;
    }
  }
  bind(turnId: string, project: string, ids: readonly string[]) {
    if (ids.length > 8 || new Set(ids).size !== ids.length)
      throw new AttachmentValidationError(
        'Choose up to eight distinct attachments.',
      );
    let total = 0;
    for (const [position, id] of ids.entries()) {
      const row = this.row(id);
      if (!row || row.project !== project || row.state !== 'ready')
        throw new AttachmentValidationError(
          'An attachment is unavailable or not ready. Remove it and upload again.',
        );
      try {
        if (statSync(this.path(id)).size !== row.size) throw new Error();
      } catch {
        throw new AttachmentValidationError(
          'An attachment is missing. Upload it again.',
        );
      }
      total += row.size;
      if (total > 100 * MiB)
        throw new AttachmentValidationError(
          'Attachments exceed the 100 MiB message limit.',
        );
      this.db
        .prepare('INSERT INTO turn_attachments VALUES (?, ?, ?)')
        .run(turnId, id, position);
    }
  }
  list(turnId: string): Attachment[] {
    return (
      this.db
        .prepare(
          'SELECT asset_id AS id FROM turn_attachments WHERE turn_id = ? ORDER BY position',
        )
        .all(turnId) as { id: string }[]
    ).map(({ id }) => this.get(id));
  }
  async prepare(turnId: string) {
    const turn = this.db
      .prepare('SELECT task_id FROM turns WHERE id = ?')
      .get(turnId) as { task_id: string };
    const executionDir = resolve(this.directory, 'execution', turn.task_id);
    await mkdir(executionDir, { recursive: true, mode: 0o700 });
    const historical = this.db
      .prepare(
        'SELECT DISTINCT asset_id AS id FROM turn_attachments JOIN turns ON turns.id = turn_id WHERE task_id = ?',
      )
      .all(turn.task_id) as { id: string }[];
    // Rehydrate history too: a resumed provider conversation may reference earlier paths.
    for (const item of historical) {
      const asset = this.get(item.id);
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(this.path(asset.id)))
        hash.update(chunk);
      if (hash.digest('hex') !== this.row(asset.id)?.sha256)
        throw new ConflictError('Attachment content changed. Upload it again.');
      const target = resolve(executionDir, asset.id);
      await copyFile(this.path(asset.id), target + '.part');
      await chmod(target + '.part', 0o400);
      await rename(target + '.part', target);
    }
    return this.list(turnId).map((asset) => ({
      ...asset,
      path: resolve(executionDir, asset.id),
    }));
  }
  async remove(id: string) {
    if (this.active.has(id) || this.finalizing.has(id))
      throw new ConflictError('Attachment is being verified.');
    if (
      this.db
        .prepare('SELECT 1 FROM turn_attachments WHERE asset_id = ?')
        .get(id)
    )
      throw new ConflictError('Sent attachments are retained with their task.');
    // Claim synchronously before any await so a new turn cannot bind this asset.
    this.db
      .prepare("UPDATE attachment_assets SET state = 'deleting' WHERE id = ?")
      .run(id);
    await this.files.remove(id).catch(() => {});
    await unlink(this.path(id)).catch(() => {});
    await unlink(this.path(id) + '.part').catch(() => {});
    await unlink(this.path(id) + '.preview.png').catch(() => {});
    this.db.prepare('DELETE FROM attachment_assets WHERE id = ?').run(id);
  }
  async sweep() {
    // Completed upload staging is no longer needed once an asset belongs to a turn.
    const bound = this.db
      .prepare('SELECT DISTINCT asset_id AS id FROM turn_attachments')
      .all() as { id: string }[];
    for (const { id } of bound)
      if (!this.active.has(id) && !this.finalizing.has(id))
        await this.files.remove(id).catch(() => {});
    const expired = this.db
      .prepare(
        'SELECT id FROM attachment_assets WHERE created < ? AND id NOT IN (SELECT asset_id FROM turn_attachments)',
      )
      .all(Date.now() - ttl) as { id: string }[];
    for (const row of expired)
      if (!this.active.has(row.id) && !this.finalizing.has(row.id))
        await this.remove(row.id);
  }
}
