import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { PermissionMode } from '../../../lib/workspace/permissions.ts';
import { grokAgentArguments, grokWorkingDirectory } from './permissions.ts';

const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
type JsonRpcId = number | string;
export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}
export interface JsonRpcServerRequest extends JsonRpcNotification {
  id: JsonRpcId;
}
interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: NodeJS.Timeout;
}
export interface GrokProcessOptions {
  binaryPath?: string;
  cwd: string;
  grokHome?: string;
  environment?: Partial<NodeJS.ProcessEnv>;
  requestTimeoutMs?: number;
  permissionMode?: PermissionMode;
  model?: string;
  reasoningEffort?: string;
}

export class GrokAcpClient {
  readonly #pending = new Map<JsonRpcId, PendingRequest>();
  readonly #notificationListeners = new Set<
    (notification: JsonRpcNotification) => void
  >();
  readonly #serverRequestListeners = new Set<
    (request: JsonRpcServerRequest) => void
  >();
  readonly #exitPromise: Promise<Error>;
  #resolveExit!: (error: Error) => void;
  #nextId = 1;
  #stderr = Buffer.alloc(0);
  #buffer = Buffer.alloc(0);
  #closed = false;
  #exited = false;
  #closing?: Promise<void>;
  #failure?: Error;

  private constructor(
    readonly child: ChildProcessWithoutNullStreams,
    readonly requestTimeoutMs: number,
  ) {
    this.#exitPromise = new Promise((resolve) => {
      this.#resolveExit = resolve;
    });
    this.#bindProcess();
  }

  static async start(options: GrokProcessOptions): Promise<GrokAcpClient> {
    const env = { ...process.env, ...options.environment };
    delete env.WEBCODE_AUTH_TOKEN;
    env.GROK_DISABLE_AUTOUPDATER = '1';
    if (options.grokHome) env.GROK_HOME = options.grokHome;
    const child = spawn(
      options.binaryPath ?? 'grok',
      grokAgentArguments(options.permissionMode ?? 'workspace', options.cwd, {
        model: options.model,
        reasoningEffort: options.reasoningEffort,
      }),
      {
        cwd: grokWorkingDirectory(options.cwd),
        env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      },
    );
    const client = new GrokAcpClient(child, options.requestTimeoutMs ?? 15_000);
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    return client;
  }

  initialize(): Promise<unknown> {
    return this.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'webcode', title: 'Webcode', version: '0.1.0' },
      clientCapabilities: {},
    });
  }

  request(
    method: string,
    params?: unknown,
    timeoutMs?: number,
  ): Promise<unknown> {
    if (this.#closed)
      return Promise.reject(this.#failure ?? new Error('Grok ACP is closed'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timeout = timeoutMs ?? this.requestTimeoutMs;
      const timer =
        timeout > 0
          ? setTimeout(() => {
              this.#pending.delete(id);
              reject(new Error(`Grok request timed out: ${method}`));
            }, timeout)
          : undefined;
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#write({
          id,
          method,
          ...(params === undefined ? {} : { params }),
        });
      } catch (error) {
        if (timer) clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.#write({ method, ...(params === undefined ? {} : { params }) });
  }
  onNotification(
    listener: (notification: JsonRpcNotification) => void,
  ): () => void {
    this.#notificationListeners.add(listener);
    return () => this.#notificationListeners.delete(listener);
  }
  onServerRequest(
    listener: (request: JsonRpcServerRequest) => void,
  ): () => void {
    this.#serverRequestListeners.add(listener);
    return () => this.#serverRequestListeners.delete(listener);
  }
  respond(id: JsonRpcId, result: unknown): void {
    this.#write({ id, result });
  }
  respondError(id: JsonRpcId, code: number, message: string): void {
    this.#write({ id, error: { code, message } });
  }
  waitForExit(): Promise<Error> {
    return this.#exitPromise;
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#rejectPending(this.#failure ?? new Error('Grok ACP closed'));
    this.#closing = this.#stop();
    return this.#closing;
  }
  async #stop(): Promise<void> {
    if (this.#exited) return;
    this.child.stdin.destroy();
    this.#kill('SIGTERM');
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.#exitPromise,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 2_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (!this.#exited) {
      this.#kill('SIGKILL');
      this.child.stdout.destroy();
      this.child.stderr.destroy();
      await this.#exitPromise;
    }
  }
  #kill(signal: NodeJS.Signals): void {
    try {
      if (process.platform !== 'win32' && this.child.pid)
        process.kill(-this.child.pid, signal);
      else this.child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
        this.child.kill(signal);
    }
  }
  #fail(error: Error): void {
    this.#failure ??= error;
    this.#rejectPending(error);
    void this.close();
  }
  #bindProcess(): void {
    this.child.stdout.on('data', (chunk: Buffer) => {
      if (this.#closed) return;
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline;
        const part = chunk.subarray(offset, end);
        if (this.#buffer.length + part.length > MAX_MESSAGE_BYTES) {
          this.#fail(new Error('Grok returned an oversized protocol message'));
          return;
        }
        this.#buffer = Buffer.concat([this.#buffer, part]);
        if (newline < 0) return;
        const line = this.#buffer.toString('utf8');
        this.#buffer = Buffer.alloc(0);
        try {
          this.#receive(JSON.parse(line));
        } catch (error) {
          this.#fail(
            error instanceof Error
              ? error
              : new Error('Invalid Grok protocol message'),
          );
          return;
        }
        offset = newline + 1;
      }
    });
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.#stderr = Buffer.concat([this.#stderr, chunk]).subarray(
        -MAX_STDERR_BYTES,
      );
    });
    for (const stream of [
      this.child.stdin,
      this.child.stdout,
      this.child.stderr,
    ]) {
      stream.on('error', (error) => {
        if (!this.#closed) this.#fail(error);
      });
    }
    this.child.once('error', (error) => {
      this.#failure = error;
      this.#rejectPending(error);
    });
    this.child.once('close', (code, signal) => {
      this.#exited = true;
      this.#closed = true;
      const detail = this.#stderr
        .toString('utf8')
        .trim()
        .split('\n')
        .slice(-3)
        .join('\n');
      const error =
        this.#failure ??
        new Error(
          `Grok ACP exited (${signal ?? code ?? 'unknown'})${detail ? `: ${detail}` : ''}`,
        );
      this.#rejectPending(error);
      this.#resolveExit(error);
    });
  }
  #receive(value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid Grok protocol envelope');
    const message = value as Record<string, unknown>;
    const id =
      typeof message.id === 'number' || typeof message.id === 'string'
        ? message.id
        : undefined;
    if (typeof message.method === 'string') {
      if (id !== undefined) {
        for (const listener of this.#serverRequestListeners)
          listener({ id, method: message.method, params: message.params });
      } else {
        for (const listener of this.#notificationListeners)
          listener({ method: message.method, params: message.params });
      }
    } else if (
      id !== undefined &&
      ('result' in message || 'error' in message)
    ) {
      const pending = this.#pending.get(id);
      if (!pending) return;
      if (pending.timer) clearTimeout(pending.timer);
      this.#pending.delete(id);
      if (message.error) {
        const error = message.error as { message?: unknown };
        pending.reject(
          new Error(
            typeof error.message === 'string'
              ? error.message
              : 'Grok request failed',
          ),
        );
      } else pending.resolve(message.result);
    } else throw new Error('Invalid Grok protocol envelope');
  }
  #write(payload: Record<string, unknown>): void {
    if (this.#closed) throw new Error('Grok ACP is closed');
    const serialized = `${JSON.stringify({ jsonrpc: '2.0', ...payload })}\n`;
    if (Buffer.byteLength(serialized) > MAX_MESSAGE_BYTES)
      throw new Error('Grok request is too large');
    if (
      this.child.stdin.writableLength + Buffer.byteLength(serialized) >
      MAX_MESSAGE_BYTES
    )
      throw new Error('Grok input queue is full');
    this.child.stdin.write(serialized, (error) => {
      if (error && !this.#closed) this.#fail(error);
    });
  }
  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
