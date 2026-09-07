'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Upload } from 'tus-js-client';
import {
  Plus,
  X,
  RotateCcw,
  Download,
  FileText,
  FileCode2,
  FileSpreadsheet,
  FileArchive,
  File,
  ImageIcon,
  Check,
  ArrowUp,
  Loader2,
  AlertCircle,
  Expand,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import type { Attachment } from '@/lib/workspace/contracts';
import type { WebcodeApi } from '@/lib/api/client';

type Entry = {
  key: string;
  file?: File;
  asset?: Attachment;
  progress: number;
  uploadedId?: string;
  error?: string;
  running?: boolean;
};
export function AttachmentPicker({
  api,
  projectId,
  disabled,
  reset,
  onChange,
  children,
}: {
  children: ReactNode;
  api: WebcodeApi;
  projectId: string;
  disabled: boolean;
  reset: number;
  onChange: (assets: Attachment[], waiting: boolean) => void;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState<Entry>();
  const dragDepth = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const uploads = useRef(new Map<string, Upload>());
  const alive = useRef(true);
  const starting = useRef(new Set<string>());
  const cancelled = useRef(new Set<string>());
  const lastReset = useRef(reset);
  const key = `webcode.attachments.v1:${api.baseUrl}:${projectId}`;
  const change = useRef(onChange);
  useEffect(() => {
    change.current = onChange;
  }, [onChange]);
  useEffect(() => {
    alive.current = true;
    try {
      const saved = JSON.parse(
        localStorage.getItem(key) || '[]',
      ) as Attachment[];
      if (Array.isArray(saved))
        queueMicrotask(() => {
          if (alive.current)
            setEntries(
              saved
                .filter((a) => typeof a.id === 'string')
                .map((asset) => ({ key: asset.id, asset, progress: 100 })),
            );
        });
    } catch {
      /* Draft storage may be unavailable. */
    }
    const current = uploads.current;
    return () => {
      alive.current = false;
      for (const upload of current.values()) void upload.abort();
    };
  }, [key]);
  useEffect(() => {
    if (reset !== lastReset.current) {
      lastReset.current = reset;
      setEntries([]);
      try {
        localStorage.removeItem(key);
      } catch {
        /* Storage unavailable. */
      }
    }
  }, [reset, key]);
  useEffect(() => {
    change.current(
      entries.flatMap((e) => (e.asset ? [e.asset] : [])),
      entries.some((e) => !e.asset || !!e.error),
    );
    try {
      localStorage.setItem(
        key,
        JSON.stringify(entries.flatMap((e) => (e.asset ? [e.asset] : []))),
      );
    } catch {
      /* Files can still be sent without local persistence. */
    }
  }, [entries, key]);
  function update(id: string, value: Partial<Entry>) {
    if (alive.current)
      setEntries((current) =>
        current.map((e) => (e.key === id ? { ...e, ...value } : e)),
      );
  }
  async function start(entry: Entry) {
    if (starting.current.has(entry.key)) return;
    if (entry.uploadedId || entry.asset) {
      update(entry.key, { running: true, error: undefined });
      try {
        const asset = await api.completeAttachment(
          entry.uploadedId ?? entry.asset!.id,
        );
        update(entry.key, { asset, running: false, error: undefined });
      } catch (error) {
        update(entry.key, {
          running: false,
          error:
            error instanceof Error ? error.message : 'Verification failed.',
        });
      }
      return;
    }
    if (!entry.file) return;
    starting.current.add(entry.key);
    update(entry.key, { running: true, error: undefined });
    try {
      // Strong identity prevents resuming different bytes with the same filename.
      const digest = await crypto.subtle.digest(
        'SHA-256',
        await entry.file.arrayBuffer(),
      );
      const fingerprint = `${api.baseUrl}:${projectId}:${Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, '0')).join('')}`;
      if (!alive.current || cancelled.current.has(entry.key)) return;
      const upload = new Upload(entry.file, {
        endpoint: `${api.baseUrl}/uploads`,
        chunkSize: 1024 * 1024,
        retryDelays: [0, 1000, 3000, 5000, 10000],
        removeFingerprintOnSuccess: false,
        metadata: {
          name: entry.file.name,
          mime: entry.file.type,
          project: projectId,
        },
        fingerprint: async () => fingerprint,
        onBeforeRequest: (req) => {
          for (const [name, value] of Object.entries(api.authHeaders()))
            req.setHeader(name, value);
        },
        onProgress: (sent, total) =>
          update(entry.key, { progress: Math.round((sent / total) * 100) }),
        onError: (error) => {
          uploads.current.delete(entry.key);
          starting.current.delete(entry.key);
          update(entry.key, { running: false, error: error.message });
        },
        onSuccess: () => {
          const id = upload.url?.split('/').pop();
          if (!id) return;
          update(entry.key, { uploadedId: id });
          void api
            .completeAttachment(id)
            .then((asset) => {
              uploads.current.delete(entry.key);
              starting.current.delete(entry.key);
              update(entry.key, { asset, running: false, progress: 100 });
            })
            .catch((error) => {
              uploads.current.delete(entry.key);
              starting.current.delete(entry.key);
              update(entry.key, {
                running: false,
                error:
                  error instanceof Error
                    ? error.message
                    : 'Verification failed.',
              });
            });
        },
      });
      uploads.current.set(entry.key, upload);
      const previous = await upload.findPreviousUploads();
      if (previous[0]) upload.resumeFromPreviousUpload(previous[0]);
      if (alive.current) upload.start();
    } catch (error) {
      starting.current.delete(entry.key);
      update(entry.key, {
        running: false,
        error: error instanceof Error ? error.message : 'Upload failed.',
      });
    }
  }
  useEffect(() => {
    const available = 2 - entries.filter((e) => e.running).length;
    for (const entry of entries
      .filter((e) => !e.running && !e.asset && !e.error)
      .slice(0, Math.max(0, available)))
      void start(entry);
  });
  function add(files: FileList | File[]) {
    if (disabled) return;
    setNotice(
      files.length + entries.length > 8
        ? 'You can attach up to 8 files. The remaining files weren’t added.'
        : '',
    );
    setEntries((current) => [
      ...current,
      ...Array.from(files)
        .slice(0, Math.max(0, 8 - current.length))
        .map((file) => ({
          key: crypto.randomUUID(),
          file,
          progress: 0,
          ...(file.size === 0 ||
          file.size > (file.type.startsWith('image/') ? 10 : 50) * 1024 * 1024
            ? { error: 'Empty or too large. Images: 10 MiB; files: 50 MiB.' }
            : {}),
        })),
    ]);
  }
  async function remove(entry: Entry) {
    setEntries((current) => current.filter((e) => e.key !== entry.key));
    setNotice('');
    cancelled.current.add(entry.key);
    const upload = uploads.current.get(entry.key);
    await upload?.abort();
    uploads.current.delete(entry.key);
    const id =
      entry.asset?.id ?? entry.uploadedId ?? upload?.url?.split('/').pop();
    if (id) await api.removeAttachment(id).catch(() => {});
    setEntries((current) => current.filter((e) => e.key !== entry.key));
  }
  const ready = entries.filter((entry) => entry.asset && !entry.error).length;
  const failed = entries.filter((entry) => entry.error);
  const totalSize = entries.reduce(
    (sum, entry) => sum + (entry.asset?.size ?? entry.file?.size ?? 0),
    0,
  );
  return (
    <div
      className={`attachment-composer${dragging ? ' is-dragging' : ''}`}
      onDragEnter={(event) => {
        if (disabled || !event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        dragDepth.current++;
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (!disabled && event.dataTransfer.types.includes('Files')) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDragLeave={(event) => {
        event.preventDefault();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        if (event.dataTransfer.files.length) add(event.dataTransfer.files);
      }}
      onPaste={(event) => {
        if (!disabled && event.clipboardData.files.length) {
          event.preventDefault();
          add(event.clipboardData.files);
        }
      }}
    >
      <input
        id="composer-file-input"
        ref={input}
        type="file"
        multiple
        hidden
        disabled={disabled}
        onChange={(event) => {
          if (event.target.files) add(event.target.files);
          event.target.value = '';
        }}
      />
      {entries.length > 0 && (
        <div className="attachment-tray">
          <div className="attachment-tray-heading">
            <span>
              Attachments{' '}
              <span className="attachment-count">{entries.length}</span>
              <span className="attachment-total">{formatBytes(totalSize)}</span>
            </span>
            <output
              className={`attachment-summary${failed.length ? ' has-error' : ''}`}
            >
              {failed.length ? (
                <>
                  <AlertCircle size={12} />
                  {failed.length} need attention
                </>
              ) : ready === entries.length ? (
                <>
                  <Check size={12} />
                  All set
                </>
              ) : (
                <>
                  <Loader2 size={12} className="attachment-spin" />
                  Preparing {entries.length - ready}
                </>
              )}
            </output>
          </div>
          <div className="attachment-shelf" aria-label="Selected attachments">
            {entries.map((entry) => {
              const name =
                entry.asset?.name ?? entry.file?.name ?? 'Attachment';
              const image = isImage(entry);
              const state = entry.error
                ? 'error'
                : entry.asset
                  ? 'ready'
                  : entry.running
                    ? 'uploading'
                    : 'queued';
              return (
                <div
                  className={`attachment-tile ${image ? 'is-image' : 'is-document'} is-${state}`}
                  key={entry.key}
                >
                  {image ? (
                    <button
                      type="button"
                      className="attachment-image-open"
                      onClick={() => setPreview(entry)}
                      aria-label={`Preview ${name}`}
                    >
                      <MediaPreview entry={entry} api={api} />
                      <span className="attachment-expand">
                        <Expand size={14} />
                      </span>
                    </button>
                  ) : (
                    <div className="attachment-document-face">
                      <FileGlyph name={name} />
                      <span>{fileExtension(name)}</span>
                    </div>
                  )}
                  <button
                    type="button"
                    className="attachment-remove"
                    disabled={disabled}
                    aria-label={`Remove ${name}`}
                    title={`Remove ${name}`}
                    onClick={() => void remove(entry)}
                  >
                    <X size={13} />
                  </button>
                  <div className="attachment-tile-caption">
                    <strong title={name}>{name}</strong>
                    <div className="attachment-tile-meta">
                      <span>
                        {formatBytes(
                          entry.asset?.size ?? entry.file?.size ?? 0,
                        )}
                      </span>
                      {entry.error ? (
                        <button
                          type="button"
                          className="attachment-retry"
                          disabled={disabled || entry.running}
                          onClick={() => void start(entry)}
                          aria-label={`Retry ${name}`}
                        >
                          <RotateCcw size={11} />
                          Retry
                        </button>
                      ) : entry.asset ? (
                        <span className="attachment-ready" aria-label="Ready">
                          <Check size={12} />
                        </span>
                      ) : (
                        <span className="attachment-transfer">
                          {!entry.running
                            ? 'Queued'
                            : entry.progress === 100
                              ? 'Processing'
                              : `${entry.progress}%`}
                        </span>
                      )}
                    </div>
                  </div>
                  {!entry.asset && !entry.error && (
                    <progress
                      className="attachment-progress"
                      max={100}
                      value={entry.progress}
                      aria-label={`Uploading ${name}`}
                    />
                  )}
                </div>
              );
            })}
            {entries.length < 8 && (
              <button
                type="button"
                className="attachment-add-tile"
                disabled={disabled}
                aria-label="Add more attachments"
                onClick={() => input.current?.click()}
              >
                <Plus size={18} />
                <span>Add</span>
              </button>
            )}
          </div>
          {failed.length > 0 && (
            <div className="attachment-errors">
              {failed.map((entry) => (
                <details key={entry.key}>
                  <summary>
                    <AlertCircle size={13} />
                    <span>{friendlyError(entry.error!)}</span>
                    <span className="attachment-error-file">
                      {entry.asset?.name ?? entry.file?.name}
                    </span>
                  </summary>
                  <p>{entry.error}</p>
                </details>
              ))}
            </div>
          )}
        </div>
      )}
      {notice && <output className="attachment-notice">{notice}</output>}
      {children}
      {dragging && (
        <div className="attachment-drop-overlay">
          <span className="attachment-drop-icon">
            <ArrowUp size={22} />
          </span>
          <strong>Drop into the conversation</strong>
          <span>Images, documents, and code · up to 8 files</span>
        </div>
      )}
      <AttachmentViewer
        entry={preview}
        api={api}
        onClose={() => setPreview(undefined)}
      />
    </div>
  );
}

export function SentAttachments({
  attachments,
  api,
}: {
  attachments?: readonly Attachment[];
  api: WebcodeApi;
}) {
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<Entry>();
  const [downloading, setDownloading] = useState<string>();
  async function download(asset: Attachment) {
    setError('');
    setDownloading(asset.id);
    try {
      await api.downloadAttachment(asset);
    } catch {
      setError('Couldn’t download this file. Please try again.');
    } finally {
      setDownloading(undefined);
    }
  }
  return (
    <>
      {!!attachments?.length && (
        <div className="sent-attachments">
          {attachments.map((asset) => {
            const entry = { key: asset.id, asset, progress: 100 };
            return (
              <button
                type="button"
                className={`sent-attachment ${isImage(entry) ? 'is-image' : 'is-document'}`}
                key={asset.id}
                disabled={downloading === asset.id}
                aria-label={`${isImage(entry) ? 'Preview' : 'Download'} ${asset.name}`}
                onClick={() =>
                  isImage(entry) ? setPreview(entry) : void download(asset)
                }
              >
                {isImage(entry) ? (
                  <div className="sent-attachment-image">
                    <MediaPreview entry={entry} api={api} />
                    <span>
                      <Expand size={16} />
                    </span>
                  </div>
                ) : (
                  <div className="sent-file-icon">
                    <FileGlyph name={asset.name} />
                  </div>
                )}
                <div className="sent-attachment-caption">
                  <strong title={asset.name}>{asset.name}</strong>
                  <span>
                    {fileExtension(asset.name)} · {formatBytes(asset.size)}
                  </span>
                </div>
                {!isImage(entry) &&
                  (downloading === asset.id ? (
                    <Loader2 size={15} className="attachment-spin" />
                  ) : (
                    <Download size={15} className="sent-download-icon" />
                  ))}
              </button>
            );
          })}
        </div>
      )}
      {error && (
        <p className="attachment-notice" role="alert">
          {error}
        </p>
      )}
      <AttachmentViewer
        entry={preview}
        api={api}
        onClose={() => setPreview(undefined)}
      />
    </>
  );
}

function AttachmentViewer({
  entry,
  api,
  onClose,
}: {
  entry?: Entry;
  api: WebcodeApi;
  onClose: () => void;
}) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');
  return (
    <Dialog
      open={!!entry}
      onOpenChange={(open) => {
        if (!open) {
          setError('');
          onClose();
        }
      }}
    >
      <DialogContent className="attachment-viewer">
        <div className="attachment-viewer-header">
          <DialogTitle>
            {entry?.asset?.name ?? entry?.file?.name ?? 'Image preview'}
          </DialogTitle>
          <DialogDescription>
            {formatBytes(entry?.asset?.size ?? entry?.file?.size ?? 0)} · Image
            preview
          </DialogDescription>
        </div>
        {entry && (
          <div className="attachment-viewer-canvas">
            <MediaPreview entry={entry} api={api} full />
          </div>
        )}
        <div className="attachment-viewer-footer">
          <span>{error || 'Escape to close'}</span>
          {entry?.asset && (
            <button
              type="button"
              disabled={downloading}
              onClick={() => {
                setDownloading(true);
                setError('');
                void api
                  .downloadAttachment(entry.asset!)
                  .catch(() => setError('Download failed. Please try again.'))
                  .finally(() => setDownloading(false));
              }}
            >
              {downloading ? (
                <Loader2 size={15} className="attachment-spin" />
              ) : (
                <Download size={15} />
              )}
              Download original
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MediaPreview({
  entry,
  api,
  full = false,
}: {
  entry: Entry;
  api: WebcodeApi;
  full?: boolean;
}) {
  const [url, setUrl] = useState('');
  const [failed, setFailed] = useState(false);
  const assetId = entry.asset?.id;
  const file = entry.file;
  useEffect(() => {
    let disposed = false;
    let objectUrl = '';
    const request = file
      ? Promise.resolve(URL.createObjectURL(file))
      : assetId
        ? full
          ? api.attachmentImage(assetId)
          : api.attachmentPreview(assetId)
        : Promise.reject(new Error('No image'));
    void request
      .then((value) => {
        objectUrl = value;
        if (disposed) URL.revokeObjectURL(value);
        else {
          setUrl(value);
          setFailed(false);
        }
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [api, assetId, file, full]);
  // Local raster files and authorized server images only; SVG is never previewed.
  return url && !failed ? (
    // oxlint-disable-next-line no-img-element -- Authorized blob previews cannot use the image optimizer.
    <img
      src={url}
      alt={full ? (entry.asset?.name ?? entry.file?.name ?? 'Attachment') : ''}
      onError={() => setFailed(true)}
      className="attachment-media"
    />
  ) : (
    <span className="attachment-media-placeholder">
      {failed ? (
        <ImageIcon size={24} />
      ) : (
        <Loader2 size={19} className="attachment-spin" />
      )}
      {full && (
        <span>
          {failed
            ? 'Preview unavailable. You can still download the original.'
            : 'Loading image…'}
        </span>
      )}
    </span>
  );
}
function isImage(entry: Entry) {
  return (
    /^image\/(png|jpeg|webp|gif)$/.test(
      entry.asset?.mime ?? entry.file?.type ?? '',
    ) ||
    (!entry.file?.type &&
      /\.(png|jpe?g|webp|gif)$/i.test(entry.file?.name ?? ''))
  );
}
function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function fileExtension(name: string) {
  const extension = name.includes('.') ? name.split('.').pop() : '';
  return extension && extension.length <= 8 ? extension.toUpperCase() : 'FILE';
}
function FileGlyph({ name }: { name: string }) {
  const extension = fileExtension(name);
  const Icon =
    /^(TS|TSX|JS|JSX|PY|RB|GO|RS|HTML|CSS|JSON|YAML|YML|SH|SQL)$/.test(
      extension,
    )
      ? FileCode2
      : /^(CSV|XLS|XLSX|TSV)$/.test(extension)
        ? FileSpreadsheet
        : /^(ZIP|TAR|GZ|RAR|7Z)$/.test(extension)
          ? FileArchive
          : /^(PDF|DOC|DOCX|TXT|MD|RTF)$/.test(extension)
            ? FileText
            : File;
  return <Icon size={24} strokeWidth={1.35} />;
}
function friendlyError(error: string) {
  if (/large|size|limit|413/i.test(error))
    return 'This file exceeds the upload limit';
  if (/image|format|validat/i.test(error))
    return 'This format needs another look';
  if (/401|auth/i.test(error)) return 'Reconnect to finish this upload';
  return 'Upload interrupted. Your message is still here.';
}
