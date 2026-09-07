import {
  MuseClient,
  spawnMspConnection,
  readSessionDurability,
} from '@muse-code/sdk';
import type { PermissionMode } from '../../../lib/workspace/permissions.ts';
import { museServeArguments } from './permissions.ts';

export interface MuseOptions {
  binaryPath?: string;
  cwd?: string;
  museHome?: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  durable?: boolean;
  environment?: NodeJS.ProcessEnv;
}

const FORWARDED_ENV = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'SHELL',
  'MODEL_API_KEY',
  'META_API_KEY',
  'MUSE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
] as const;

const BLOCKED_ENV = new Set(['WEBCODE_AUTH_TOKEN']);

export function museEnvironment(
  museHome?: string,
  extra?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { MUSE_NO_AUTO_UPDATE: '1' };
  for (const key of FORWARDED_ENV) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if (museHome) env.MUSE_HOME = museHome;
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (BLOCKED_ENV.has(key) || value === undefined) continue;
      env[key] = value;
    }
  }
  return env;
}

export function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('Aborted'));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

export function publicError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message)
    return error.message.slice(0, 500);
  return fallback;
}

export async function openMuse(
  options: MuseOptions,
  mode: PermissionMode = 'workspace',
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const handshake = spawnMspConnection({
    command: options.binaryPath ?? 'muse',
    args: museServeArguments(mode, { durable: options.durable ?? true }),
    cwd: options.cwd,
    env: museEnvironment(options.museHome, {
      ...options.environment,
      ...(options.cwd ? { PWD: options.cwd } : {}),
    }),
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? 8_000,
  });
  const close = () => {
    void handshake.close().catch(() => undefined);
  };
  const deadline = AbortSignal.timeout(options.timeoutMs ?? 15_000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  if (combined.aborted) {
    close();
    throw combined.reason ?? new Error('Muse handshake cancelled.');
  }
  combined.addEventListener('abort', close, { once: true });
  try {
    const host = await handshake.initialize({
      clientInfo: { name: 'webcode', version: '0.1.0' },
    });
    combined.throwIfAborted();
    const client = new MuseClient(host.connection, {
      host,
      durability: readSessionDurability(host.initializeResult),
    });
    return {
      client,
      connection: host.connection,
      version: host.initializeResult.serverInfo.version,
      fingerprintWarning: host.fingerprintWarning,
    };
  } catch (error) {
    const tail = handshake.child.stderrTail.join('\n').trim().slice(0, 400);
    await handshake.close().catch(() => undefined);
    if (tail) {
      throw new Error(`${publicError(error, 'Muse host failed.')} ${tail}`);
    }
    throw error;
  } finally {
    combined.removeEventListener('abort', close);
  }
}

export type MuseHost = Awaited<ReturnType<typeof openMuse>>;
