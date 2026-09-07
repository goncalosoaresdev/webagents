import type {
  ModelCapability,
  ProviderDiscovery,
  ProviderModel,
  ProviderSnapshot,
} from '../../../lib/providers/contracts.ts';
import { GrokAcpClient, type GrokProcessOptions } from './json-rpc-client.ts';

const effortLabels: Record<string, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
};

const defaultEfforts = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;

export function reasoningCapability(
  values: readonly string[] = defaultEfforts,
  defaultValue = 'high',
): ModelCapability {
  const efforts = values.length ? values : defaultEfforts;
  const fallback = efforts.includes(defaultValue) ? defaultValue : efforts[0];
  return {
    id: 'reasoningEffort',
    label: 'Reasoning',
    defaultValue: fallback,
    values: efforts.map((id) => ({
      id,
      label: effortLabels[id] ?? titleCase(id),
      isDefault: id === fallback,
    })),
  };
}

export function parseGrokModels(value: unknown): ProviderModel[] {
  const record = asRecord(value);
  const nested = asRecord(record.modelState);
  const models = Array.isArray(record.availableModels)
    ? record.availableModels
    : Array.isArray(nested.availableModels)
      ? nested.availableModels
      : Array.isArray(record.models)
        ? record.models
        : [];
  const current =
    typeof record.currentModelId === 'string'
      ? record.currentModelId
      : typeof nested.currentModelId === 'string'
        ? nested.currentModelId
        : undefined;
  return models.flatMap((raw) => {
    const model = asRecord(raw);
    const meta = asRecord(model._meta);
    const id =
      typeof model.modelId === 'string'
        ? model.modelId
        : typeof model.id === 'string'
          ? model.id
          : '';
    if (!id.trim()) return [];
    const efforts = parseEffortValues(model, meta);
    const supports =
      model.supportsReasoningEffort === false ||
      meta.supportsReasoningEffort === false
        ? false
        : true;
    const defaultEffort =
      typeof meta.reasoningEffort === 'string'
        ? meta.reasoningEffort
        : efforts.find((entry) => entry.default)?.id;
    return [
      {
        id,
        label:
          (typeof model.name === 'string' && model.name) ||
          (typeof model.label === 'string' && model.label) ||
          (typeof model.displayName === 'string' && model.displayName) ||
          id,
        isDefault: model.isDefault === true || id === current,
        inputModalities: ['text', 'image'],
        capabilities: supports
          ? [
              reasoningCapability(
                efforts.map((entry) => entry.id),
                defaultEffort,
              ),
            ]
          : [],
      },
    ];
  });
}

export function parseInitialize(initialization: unknown): {
  version?: string;
  models: ProviderModel[];
} {
  const record = asRecord(initialization);
  const meta = asRecord(record._meta);
  const agentInfo = asRecord(record.agentInfo);
  const version =
    (typeof meta.agentVersion === 'string' && meta.agentVersion) ||
    parseGrokVersion(agentInfo.version) ||
    (typeof agentInfo.version === 'string' ? agentInfo.version : undefined);
  return { version, models: parseGrokModels(meta) };
}

export function parseAccountLabel(value: unknown): string | undefined {
  const meta = asRecord(asRecord(value)._meta);
  if (typeof meta.email === 'string' && meta.email) return meta.email;
  if (typeof meta.subscription_tier === 'string' && meta.subscription_tier)
    return meta.subscription_tier;
  return undefined;
}

export function parseConfigOptions(value: unknown): {
  models: string[];
  efforts: string[];
  currentModel?: string;
  currentEffort?: string;
} {
  const options = Array.isArray(value) ? value : [];
  let models: string[] = [];
  let efforts: string[] = [];
  let currentModel: string | undefined;
  let currentEffort: string | undefined;
  for (const raw of options) {
    const option = asRecord(raw);
    const id = typeof option.configId === 'string' ? option.configId : '';
    const current = configValue(option.value);
    const allowed = parseOptionValues(option);
    if (id === 'model') {
      models = allowed;
      currentModel = current;
    }
    if (id === 'reasoning_effort') {
      efforts = allowed;
      currentEffort = current;
    }
  }
  return { models, efforts, currentModel, currentEffort };
}

export function parseGrokVersion(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return /(?:grok(?:[\s-]+build)?|xai-grok-pager)\s+v?(\d+\.\d+\.\d+)/i.exec(
    value,
  )?.[1];
}

export function parseAuthMethods(
  value: unknown,
): { id: string; name?: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const method = asRecord(raw);
    return typeof method.id === 'string' && method.id
      ? [
          {
            id: method.id,
            ...(typeof method.name === 'string' ? { name: method.name } : {}),
          },
        ]
      : [];
  });
}

export function selectAuthMethod(
  methods: readonly { id: string; name?: string }[],
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!methods.length) return undefined;
  const hasKey = Boolean(env.XAI_API_KEY || env.GROK_CODE_XAI_API_KEY);
  let best: { id: string; score: number } | undefined;
  for (const method of methods) {
    const id = method.id.toLowerCase();
    const name = (method.name ?? '').toLowerCase();
    let score = 0;
    if (id.includes('api_key') || name.includes('api key'))
      score = hasKey ? 3 : 0;
    else if (
      id.includes('cached') ||
      id.includes('token') ||
      name.includes('cached')
    )
      score = 2;
    if (!best || score > best.score) best = { id: method.id, score };
  }
  return best && best.score > 0 ? best.id : undefined;
}

export async function authenticateGrok(
  client: GrokAcpClient,
  initialization: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<
  { status: 'ready'; result?: unknown } | { status: 'unauthenticated' }
> {
  const methods = parseAuthMethods(asRecord(initialization).authMethods);
  if (!methods.length) return { status: 'ready' };
  const methodId = selectAuthMethod(methods, env);
  if (!methodId) return { status: 'unauthenticated' };
  return {
    status: 'ready',
    result: await client.request('authenticate', {
      methodId,
      _meta: { headless: true },
    }),
  };
}

export async function listModels(
  client: GrokAcpClient,
): Promise<ProviderModel[]> {
  try {
    return parseGrokModels(await client.request('x.ai/models/list', {}));
  } catch {
    return [];
  }
}

export class GrokDiscovery implements ProviderDiscovery {
  readonly id = 'grok';
  readonly #options: GrokProcessOptions;

  constructor(options: GrokProcessOptions) {
    this.#options = options;
  }

  async probe(signal?: AbortSignal): Promise<ProviderSnapshot> {
    const checkedAt = new Date().toISOString();
    let client: GrokAcpClient | undefined;
    const abort = () => void client?.close();
    try {
      signal?.throwIfAborted();
      client = await GrokAcpClient.start(this.#options);
      signal?.throwIfAborted();
      signal?.addEventListener('abort', abort, { once: true });
      const initialization = await client.initialize();
      const { version, models: initializedModels } =
        parseInitialize(initialization);
      let accountLabel: string | undefined;
      try {
        const auth = await authenticateGrok(client, initialization, {
          ...process.env,
          ...this.#options.environment,
        });
        if (auth.status === 'unauthenticated') {
          return {
            providerId: this.id,
            health: 'unauthenticated',
            models: [],
            checkedAt,
            ...(version ? { version } : {}),
            message:
              'Run grok login --device-auth as the Webcode user, or set XAI_API_KEY.',
          };
        }
        accountLabel = parseAccountLabel(auth.result);
      } catch {
        return {
          providerId: this.id,
          health: 'unauthenticated',
          models: [],
          checkedAt,
          ...(version ? { version } : {}),
          message:
            'Run grok login --device-auth as the Webcode user, or set XAI_API_KEY.',
        };
      }
      const models = initializedModels.length
        ? initializedModels
        : await listModels(client);
      return {
        providerId: this.id,
        health: 'ready',
        models,
        checkedAt,
        ...(version ? { version } : {}),
        ...(accountLabel ? { accountLabel } : {}),
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      return {
        providerId: this.id,
        health: 'unavailable',
        models: [],
        checkedAt,
        message: isMissingBinaryError(error)
          ? 'Grok Build was not found. Install it on the VPS and try again.'
          : 'Grok Build could not connect. Install a compatible grok CLI and authenticate on the server.',
      };
    } finally {
      signal?.removeEventListener('abort', abort);
      await client?.close();
    }
  }
}

function parseEffortValues(
  model: Record<string, unknown>,
  meta: Record<string, unknown>,
): { id: string; default?: boolean }[] {
  const values = Array.isArray(model.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts
    : Array.isArray(model.reasoningEfforts)
      ? model.reasoningEfforts
      : Array.isArray(meta.reasoningEfforts)
        ? meta.reasoningEfforts
        : [];
  return values.flatMap((entry) => {
    if (typeof entry === 'string') return [{ id: entry }];
    const record = asRecord(entry);
    const id =
      typeof record.value === 'string'
        ? record.value
        : typeof record.reasoningEffort === 'string'
          ? record.reasoningEffort
          : typeof record.id === 'string'
            ? record.id
            : '';
    return id
      ? [{ id, ...(record.default === true ? { default: true } : {}) }]
      : [];
  });
}

function parseOptionValues(option: Record<string, unknown>): string[] {
  const values = Array.isArray(option.options)
    ? option.options
    : Array.isArray(option.allowedValues)
      ? option.allowedValues
      : [];
  return values.flatMap((entry) => {
    if (typeof entry === 'string') return [entry];
    const record = asRecord(entry);
    const value = configValue(record.value) ?? optionalString(record.id);
    return value ? [value] : [];
  });
}

function configValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  const record = asRecord(value);
  return typeof record.value === 'string' ? record.value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function titleCase(value: string): string {
  return value
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isMissingBinaryError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
