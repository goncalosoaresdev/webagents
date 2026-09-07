import type {
  ProviderLimits,
  LimitWindow,
} from '../../../lib/providers/limits.ts';
import { windowLabel } from '../../../lib/providers/limits.ts';
import {
  CodexAppServerClient,
  type CodexProcessOptions,
} from './json-rpc-client.ts';
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const finite = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
export function parseLimits(value: unknown, checkedAt: string): ProviderLimits {
  const response = record(value),
    buckets = record(response.rateLimitsByLimitId);
  const entries = Object.keys(buckets).length
    ? Object.entries(buckets)
    : response.rateLimits
      ? [['codex', response.rateLimits] as const]
      : [];
  const windows: LimitWindow[] = [];
  for (const [id, raw] of entries) {
    const bucket = record(raw);
    for (const key of ['primary', 'secondary']) {
      const window = record(bucket[key]);
      if (!Object.keys(window).length) continue;
      const used = finite(window.usedPercent),
        duration = finite(window.windowDurationMins),
        reset = finite(window.resetsAt);
      const durationMinutes =
        duration !== null && duration > 0 ? duration : null;
      const label = windowLabel(
        durationMinutes,
        key === 'primary' ? 'Primary window' : 'Secondary window',
      );
      windows.push({
        id: `${id}:${key}`,
        label:
          id === 'codex'
            ? label
            : `${typeof bucket.limitName === 'string' ? bucket.limitName : id} · ${label}`,
        durationMinutes,
        remainingPercent:
          used === null ? null : Math.max(0, Math.min(100, 100 - used)),
        resetsAt: reset !== null && reset > 0 ? reset : null,
      });
    }
  }
  return {
    providerId: 'codex',
    checkedAt,
    windows,
    status: windows.some((w) => w.remainingPercent !== null)
      ? 'available'
      : 'unavailable',
  };
}
export async function readCodexLimits(
  options: CodexProcessOptions,
  signal: AbortSignal,
): Promise<ProviderLimits> {
  let client: CodexAppServerClient | undefined;
  const abort = () => void client?.close();
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    client = await CodexAppServerClient.start(options);
    signal.throwIfAborted();
    await client.initialize();
    const account = record(
      record(await client.request('account/read', {})).account,
    );
    const limits = parseLimits(
      await client.request('account/rateLimits/read', {}),
      new Date().toISOString(),
    );
    return {
      ...limits,
      ...(typeof account.email === 'string'
        ? { accountLabel: account.email }
        : {}),
    };
  } finally {
    signal.removeEventListener('abort', abort);
    await client?.close();
  }
}
