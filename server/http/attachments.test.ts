import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { AttachmentService } from '../attachments/service.ts';
import { attachmentRoutes } from './attachment-routes.ts';
import { SqliteWorkspaceStore } from '../storage/sqlite-workspace-store.ts';
import { createBearerAuthHook } from '../security/bearer-auth.ts';
import { AgentService } from '../core/agent-service.ts';
import { ConnectionHub } from '../realtime/connection-hub.ts';
import type { ExecuteTurnInput } from '../runtime/agent-runtime.ts';

void test(
  'authenticated uploads resume, finalize, bind atomically and survive restart',
  { timeout: 5_000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'webcode-attachments-'));
    const store = new SqliteWorkspaceStore(join(dir, 'db.sqlite'));
    const project = store.createProject({
      id: crypto.randomUUID(),
      name: 'Test',
      path: dir,
      isGitRepository: false,
      now: new Date().toISOString(),
    });
    let attachments = new AttachmentService(
      store.attachmentDatabase,
      join(dir, 'assets'),
    );
    const app = Fastify();
    app.addHook('onRequest', createBearerAuthHook('test-token'));
    await app.register(attachmentRoutes, { prefix: '/api/v1', attachments });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    t.after(async () => {
      await app.close();
      attachments.close();
      store.close();
      await rm(dir, { recursive: true, force: true });
    });
    const headers = {
      authorization: 'Bearer test-token',
      'tus-resumable': '1.0.0',
    };
    const meta = (name: string, mime = 'text/plain') =>
      Object.entries({ name, mime, project: project.id })
        .map(([k, v]) => `${k} ${Buffer.from(v).toString('base64')}`)
        .join(',');
    const unauthorized = await fetch(address + '/api/v1/uploads', {
      method: 'POST',
      headers: {
        'upload-length': '5',
        'tus-resumable': '1.0.0',
        'upload-metadata': meta('hello.txt'),
      },
    });
    assert.equal(unauthorized.status, 401);
    const created = await fetch(address + '/api/v1/uploads', {
      method: 'POST',
      headers: {
        ...headers,
        'upload-length': '5',
        'upload-metadata': meta('../hello.txt'),
      },
    });
    assert.equal(created.status, 201, await created.text());
    const location = created.headers.get('location')!;
    const id = location.split('/').pop()!;
    const patch = (offset: number, body: string) =>
      fetch(new URL(location, address), {
        method: 'PATCH',
        headers: {
          ...headers,
          'upload-offset': String(offset),
          'content-type': 'application/offset+octet-stream',
        },
        body,
      });
    assert.equal((await patch(0, 'he')).status, 204);
    assert.equal((await patch(0, 'xx')).status, 409);
    const head = await fetch(new URL(location, address), {
      method: 'HEAD',
      headers,
    });
    assert.equal(head.headers.get('upload-offset'), '2');
    await assert.rejects(attachments.finalize(id), /incomplete/);
    assert.equal((await patch(2, 'llo')).status, 204);
    const asset = await attachments.finalize(id);
    assert.equal(asset.state, 'ready');
    assert.equal(asset.name, '../hello.txt');
    assert.equal(
      attachments.path(id).startsWith(join(dir, 'assets', 'objects')),
      true,
    );
    assert.deepEqual(await attachments.finalize(id), asset);
    assert.equal((await patch(5, '!')).status, 409);
    const download = await fetch(
      `${address}/api/v1/attachments/${id}/content`,
      {
        headers,
      },
    );
    assert.equal(await download.text(), 'hello');
    assert.equal(download.headers.get('x-content-type-options'), 'nosniff');

    let delivered: ExecuteTurnInput | undefined;
    let notifyDelivered!: () => void;
    const delivery = new Promise<void>((resolve) => {
      notifyDelivered = resolve;
    });
    const agents = new AgentService(
      store,
      new ConnectionHub(),
      [
        {
          providerId: 'fixture',
          async executeTurn(input) {
            delivered = input;
            notifyDelivered();
            return { status: 'completed' };
          },
          async interrupt() {
            return false;
          },
          async close() {},
        },
      ],
      { attachments },
    );
    const task = agents.createTask({
      projectId: project.id,
      providerId: 'fixture',
    });
    const request = {
      clientRequestId: crypto.randomUUID(),
      prompt: '',
      attachmentIds: [id],
    };
    const result = agents.startTurn(task.id, request);
    assert.equal(agents.startTurn(task.id, request).turn.id, result.turn.id);
    assert.throws(
      () => agents.startTurn(task.id, { ...request, attachmentIds: [] }),
      /different content/,
    );
    // Startup is cancellable; verify delivery before asking the service to shut down.
    await delivery;
    await agents.close();
    assert.notEqual(delivered?.attachments?.[0]?.path, attachments.path(id));
    assert.ok(delivered?.attachments?.[0]?.path.includes('/execution/'));
    assert.equal(agents.getTask(task.id).turns[0]?.attachments?.[0]?.id, id);
    await assert.rejects(attachments.remove(id), /retained/);
    const before = store.getTaskDetail(task.id)!.turns.length;
    assert.throws(
      () =>
        store.transaction(() => {
          const turn = store.createTurn({
            id: crypto.randomUUID(),
            taskId: task.id,
            clientRequestId: crypto.randomUUID(),
            prompt: '',
            now: new Date().toISOString(),
          });
          attachments.bind(turn.turn.id, crypto.randomUUID(), [id]);
        }),
      /unavailable/,
    );
    assert.equal(store.getTaskDetail(task.id)!.turns.length, before);
    attachments.close();
    attachments = new AttachmentService(
      store.attachmentDatabase,
      join(dir, 'assets'),
    );
    assert.equal((await attachments.prepare(result.turn.id))[0]?.id, id);
    await writeFile(attachments.path(id), 'other');
    await assert.rejects(
      attachments.prepare(result.turn.id),
      /content changed/,
    );
  },
);

void test('rejects fake images and expires unbound files without deleting sent assets', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'webcode-attachment-validation-'));
  const store = new SqliteWorkspaceStore(':memory:');
  const project = store.createProject({
    id: crypto.randomUUID(),
    name: 'Test',
    path: dir,
    isGitRepository: false,
    now: new Date().toISOString(),
  });
  const service = new AttachmentService(store.attachmentDatabase, dir);
  t.after(async () => {
    service.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const { Upload } = await import('@tus/server');
  const id = crypto.randomUUID();
  store.attachmentDatabase
    .prepare('INSERT INTO attachment_assets VALUES (?, ?, ?, ?, ?, NULL, ?, ?)')
    .run(id, project.id, 'fake.png', 5, 'image/png', 'uploading', 0);
  await service.files.create(new Upload({ id, size: 5, offset: 0 }));
  await writeFile(join(dir, 'uploads', id), 'hello');
  await assert.rejects(service.finalize(id), /cannot be validated/);
  await service.sweep();
  assert.equal(service.row(id), undefined);
});
