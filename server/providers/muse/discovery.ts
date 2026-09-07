import { z } from 'zod';
import type {
  ModelCapability,
  ProviderDiscovery,
  ProviderModel,
  ProviderSnapshot,
} from '../../../lib/providers/contracts.ts';
import { abortable, openMuse, type MuseOptions } from './client.ts';

export const reasoningEfforts = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'ultra',
] as const;

const modelEntry = z.object({
  modelId: z.string().min(1),
  displayLabel: z.string(),
  providerId: z.string(),
  isDefault: z.boolean(),
});

export const modelCatalog = z.object({
  source: z.string(),
  providerId: z.string(),
  models: z.array(modelEntry),
});

const effortLabels: Record<(typeof reasoningEfforts)[number], string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  ultra: 'Ultra',
};

export function parseMuseCatalog(value: unknown): ProviderModel[] {
  const catalog = modelCatalog.parse(value);
  return catalog.models
    .filter((model) => model.providerId === 'meta')
    .map((model) => ({
      id: model.modelId,
      label: model.displayLabel || model.modelId,
      isDefault: model.isDefault,
      inputModalities: ['text', 'image'],
      capabilities: [reasoningCapability()],
    }));
}

export function reasoningCapability(): ModelCapability {
  return {
    id: 'reasoningEffort',
    label: 'Reasoning',
    defaultValue: 'high',
    values: reasoningEfforts.map((id) => ({
      id,
      label: effortLabels[id],
      isDefault: id === 'high',
    })),
  };
}

export function parseMuseVersion(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return /(?:muse(?:\s+code)?)\s+(\d+\.\d+\.\d+)/i.exec(value)?.[1];
}

export class MuseDiscovery implements ProviderDiscovery {
  readonly id = 'muse';

  constructor(private readonly options: MuseOptions = {}) {}

  async probe(signal?: AbortSignal): Promise<ProviderSnapshot> {
    const checkedAt = new Date().toISOString();
    let host: Awaited<ReturnType<typeof openMuse>> | undefined;
    const abort = () => {
      void host?.client.close().catch(() => undefined);
    };
    try {
      signal?.throwIfAborted();
      host = await openMuse(
        {
          ...this.options,
          durable: false,
          shutdownTimeoutMs: this.options.shutdownTimeoutMs ?? 1_000,
        },
        'workspace',
        signal,
      );
      signal?.throwIfAborted();
      signal?.addEventListener('abort', abort, { once: true });
      const models = parseMuseCatalog(
        await abortable(
          host.connection.request('model/list', {}),
          signal ?? AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
        ),
      );
      if (!models.length) {
        return {
          providerId: this.id,
          health: 'unauthenticated',
          version: host.version,
          models: [],
          checkedAt,
          message:
            'Muse Code is installed. Sign in with muse login on the server or set META_API_KEY.',
        };
      }
      return {
        providerId: this.id,
        health: 'ready',
        version: host.version,
        models,
        checkedAt,
        ...(host.fingerprintWarning
          ? {
              message:
                'Muse protocol advanced since this integration was pinned. Tasks still run; update the SDK if behavior looks wrong.',
            }
          : {}),
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      return {
        providerId: this.id,
        health: 'unavailable',
        models: [],
        checkedAt,
        message: isMissingBinaryError(error)
          ? 'Muse Code was not found. Install it on the VPS and try again.'
          : 'Muse Code could not connect. Install a compatible Muse CLI and configure Meta credentials on the server.',
      };
    } finally {
      signal?.removeEventListener('abort', abort);
      await host?.client.close().catch(() => undefined);
    }
  }
}

function isMissingBinaryError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
