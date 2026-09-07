import type {
  ModelCapability,
  ProviderDiscovery,
  ProviderModel,
  ProviderSnapshot,
} from '../../../lib/providers/contracts.ts';
import {
  CodexAppServerClient,
  type CodexProcessOptions,
} from './json-rpc-client.ts';

interface CodexModelRecord {
  model: string;
  displayName?: string;
  isDefault?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: Array<{ reasoningEffort: string }>;
  defaultServiceTier?: string;
  serviceTiers?: Array<{ id: string; name?: string; description?: string }>;
}

export class CodexDiscovery implements ProviderDiscovery {
  readonly id = 'codex';
  readonly #options: CodexProcessOptions;

  constructor(options: CodexProcessOptions) {
    this.#options = options;
  }

  async probe(signal?: AbortSignal): Promise<ProviderSnapshot> {
    const checkedAt = new Date().toISOString();
    let client: CodexAppServerClient | undefined;
    const abort = () => void client?.close();
    try {
      signal?.throwIfAborted();
      client = await CodexAppServerClient.start(this.#options);
      signal?.throwIfAborted();
      signal?.addEventListener('abort', abort, { once: true });
      const initialization = asRecord(await client.initialize());
      const account = asRecord(await client.request('account/read', {}));
      const accountRecord = asRecordOrNull(account.account);
      const requiresAuth = account.requiresOpenaiAuth === true;
      if (!accountRecord && requiresAuth) {
        return {
          providerId: this.id,
          health: 'unauthenticated',
          models: [],
          checkedAt,
          message: 'Run codex login on the VPS.',
        };
      }

      const models = await listModels(client);
      const version = parseCodexVersion(initialization.userAgent);
      return {
        providerId: this.id,
        health: 'ready',
        models,
        checkedAt,
        ...(version ? { version } : {}),
        ...(accountRecord ? { accountLabel: accountLabel(accountRecord) } : {}),
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      return {
        providerId: this.id,
        health: isMissingBinaryError(error) ? 'unavailable' : 'unavailable',
        models: [],
        checkedAt,
        message: safeErrorMessage(error),
      };
    } finally {
      signal?.removeEventListener('abort', abort);
      await client?.close();
    }
  }
}

export async function listModels(
  client: CodexAppServerClient,
): Promise<ProviderModel[]> {
  const result: ProviderModel[] = [];
  let cursor: string | undefined;
  const cursors = new Set<string>();
  do {
    const response = asRecord(
      await client.request('model/list', cursor ? { cursor } : {}),
    );
    const data = Array.isArray(response.data) ? response.data : [];
    for (const raw of data) {
      const model = parseModel(raw);
      if (model) result.push(model);
    }
    cursor =
      typeof response.nextCursor === 'string' && response.nextCursor
        ? response.nextCursor
        : undefined;
    if (cursor && (cursors.has(cursor) || cursors.size >= 100))
      throw new Error('Invalid model pagination');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return result;
}

export function parseModel(value: unknown): ProviderModel | null {
  const record = asRecord(value) as Partial<CodexModelRecord>;
  if (typeof record.model !== 'string' || !record.model.trim()) return null;
  const capabilities: ModelCapability[] = [];
  const efforts = Array.isArray(record.supportedReasoningEfforts)
    ? record.supportedReasoningEfforts
    : [];
  if (efforts.length) {
    capabilities.push({
      id: 'reasoningEffort',
      label: 'Reasoning',
      defaultValue: record.defaultReasoningEffort,
      values: efforts.flatMap((entry) =>
        typeof entry?.reasoningEffort === 'string'
          ? [
              {
                id: entry.reasoningEffort,
                label: effortLabel(entry.reasoningEffort),
                isDefault:
                  entry.reasoningEffort === record.defaultReasoningEffort,
              },
            ]
          : [],
      ),
    });
  }
  const tiers = Array.isArray(record.serviceTiers) ? record.serviceTiers : [];
  if (tiers.length) {
    capabilities.push({
      id: 'serviceTier',
      label: 'Service tier',
      defaultValue: record.defaultServiceTier ?? 'default',
      values: [
        {
          id: 'default',
          label: 'Standard',
          isDefault: !record.defaultServiceTier,
        },
        ...tiers.flatMap((tier) =>
          typeof tier?.id === 'string'
            ? [
                {
                  id: tier.id,
                  label: tier.name || titleCase(tier.id),
                  description: tier.description,
                  isDefault: tier.id === record.defaultServiceTier,
                },
              ]
            : [],
        ),
      ],
    });
  }
  return {
    ...(Array.isArray(asRecord(value).inputModalities)
      ? {
          inputModalities: (
            asRecord(value).inputModalities as unknown[]
          ).filter((v): v is string => typeof v === 'string'),
        }
      : {}),
    id: record.model,
    isDefault: record.isDefault === true,
    label: record.displayName || record.model,
    capabilities,
  };
}

export function parseCodexVersion(userAgent: unknown): string | undefined {
  if (typeof userAgent !== 'string') return undefined;
  return /\bCodex(?:\s+Desktop)?\/([^\s(]+)/i.exec(userAgent)?.[1];
}

function accountLabel(account: Record<string, unknown>): string {
  if (account.type === 'chatgpt' && typeof account.email === 'string')
    return account.email;
  if (account.type === 'apiKey') return 'OpenAI API key';
  if (account.type === 'amazonBedrock') return 'Amazon Bedrock';
  return 'Authenticated';
}

function effortLabel(value: string): string {
  return (
    (
      {
        none: 'None',
        minimal: 'Minimal',
        low: 'Low',
        medium: 'Medium',
        high: 'High',
        xhigh: 'Extra high',
        max: 'Max',
        ultra: 'Ultra',
      } as Record<string, string>
    )[value] ?? titleCase(value)
  );
}

function titleCase(value: string): string {
  return value
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}
function asRecordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}
function isMissingBinaryError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
function safeErrorMessage(error: unknown): string {
  if (!isMissingBinaryError(error) && error instanceof Error && error.message)
    return 'Codex discovery failed. Check the CLI installation and authentication on the server.';
  return 'Codex CLI was not found. Install it on the VPS and try again.';
}
