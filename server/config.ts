import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

const DEFAULT_DEVELOPMENT_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

const environmentSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    WEBCODE_HOST: z.string().min(1).default('127.0.0.1'),
    WEBCODE_PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
    WEBCODE_ALLOWED_ORIGINS: z.string().optional(),
    WEBCODE_AUTH_TOKEN: z.string().min(32).optional(),
    WEBCODE_WORKSPACE_ROOT: z.string().min(1).default(process.cwd()),
    WEBCODE_ATTACHMENT_QUOTA_BYTES: z.coerce
      .number()
      .int()
      .min(1024 * 1024)
      .default(10 * 1024 * 1024 * 1024),
    WEBCODE_ATTACHMENT_MIN_FREE_BYTES: z.coerce
      .number()
      .int()
      .min(0)
      .default(256 * 1024 * 1024),
    WEBCODE_DATA_DIR: z.string().min(1).default(resolve(process.cwd(), 'data')),
    WEBCODE_PROVIDER_CACHE_TTL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(300_000)
      .default(30_000),
    WEBCODE_PROVIDER_PROBE_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(60_000)
      .default(20_000),
    WEBCODE_WS_TICKET_TTL_MS: z.coerce
      .number()
      .int()
      .min(5_000)
      .max(120_000)
      .default(30_000),
    CODEX_BIN: z.string().min(1).default('codex'),
    CODEX_HOME: z.string().min(1).optional(),
    MUSE_BIN: z.string().min(1).default('muse'),
    MUSE_HOME: z.string().min(1).optional(),
    GROK_BIN: z.string().min(1).default('grok'),
    GROK_HOME: z.string().min(1).optional(),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
  })
  .superRefine((environment, context) => {
    if (
      (environment.NODE_ENV === 'production' ||
        !['127.0.0.1', '::1', 'localhost'].includes(
          environment.WEBCODE_HOST,
        )) &&
      !environment.WEBCODE_AUTH_TOKEN
    ) {
      context.addIssue({
        code: 'custom',
        path: ['WEBCODE_AUTH_TOKEN'],
        message: 'is required in production or on a non-loopback interface',
      });
    }
    if (
      environment.NODE_ENV === 'production' &&
      !environment.WEBCODE_ALLOWED_ORIGINS
    ) {
      context.addIssue({
        code: 'custom',
        path: ['WEBCODE_ALLOWED_ORIGINS'],
        message: 'is required in production',
      });
    }
  });

export interface ServerConfig {
  environment: 'development' | 'test' | 'production';
  host: string;
  port: number;
  allowedOrigins: ReadonlySet<string>;
  authToken?: string;
  workspaceRoot: string;
  dataDirectory: string;
  attachmentLimits?: { quotaBytes: number; minimumFreeBytes: number };
  providerCacheTtlMs: number;
  providerProbeTimeoutMs: number;
  websocketTicketTtlMs: number;
  codex: {
    binaryPath: string;
    codexHome?: string;
  };
  muse: {
    binaryPath: string;
    museHome?: string;
  };
  grok: {
    binaryPath: string;
    grokHome?: string;
  };
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
}

export function loadConfig(
  source: Record<string, string | undefined> = process.env,
): ServerConfig {
  const result = environmentSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map(
        (issue) => `${issue.path.join('.') || 'environment'} ${issue.message}`,
      )
      .join('; ');
    throw new Error(`Invalid server configuration: ${details}`);
  }

  const environment = result.data;
  const requestedWorkspaceRoot = isAbsolute(environment.WEBCODE_WORKSPACE_ROOT)
    ? environment.WEBCODE_WORKSPACE_ROOT
    : resolve(environment.WEBCODE_WORKSPACE_ROOT);
  let workspaceRoot: string;
  try {
    if (!statSync(requestedWorkspaceRoot).isDirectory())
      throw new Error('not a directory');
    workspaceRoot = realpathSync(requestedWorkspaceRoot);
  } catch {
    throw new Error(
      `Invalid server configuration: WEBCODE_WORKSPACE_ROOT is not a readable directory: ${requestedWorkspaceRoot}`,
    );
  }
  const allowedOrigins = parseOrigins(
    environment.WEBCODE_ALLOWED_ORIGINS,
    environment.NODE_ENV === 'development' ? DEFAULT_DEVELOPMENT_ORIGINS : [],
  );
  const dataDirectory = isAbsolute(environment.WEBCODE_DATA_DIR)
    ? environment.WEBCODE_DATA_DIR
    : resolve(environment.WEBCODE_DATA_DIR);

  return {
    environment: environment.NODE_ENV,
    host: environment.WEBCODE_HOST,
    port: environment.WEBCODE_PORT,
    allowedOrigins,
    authToken: environment.WEBCODE_AUTH_TOKEN,
    workspaceRoot,
    dataDirectory,
    attachmentLimits: {
      quotaBytes: environment.WEBCODE_ATTACHMENT_QUOTA_BYTES,
      minimumFreeBytes: environment.WEBCODE_ATTACHMENT_MIN_FREE_BYTES,
    },
    providerCacheTtlMs: environment.WEBCODE_PROVIDER_CACHE_TTL_MS,
    providerProbeTimeoutMs: environment.WEBCODE_PROVIDER_PROBE_TIMEOUT_MS,
    websocketTicketTtlMs: environment.WEBCODE_WS_TICKET_TTL_MS,
    codex: {
      binaryPath: environment.CODEX_BIN,
      ...(environment.CODEX_HOME ? { codexHome: environment.CODEX_HOME } : {}),
    },
    muse: {
      binaryPath: environment.MUSE_BIN,
      ...(environment.MUSE_HOME ? { museHome: environment.MUSE_HOME } : {}),
    },
    grok: {
      binaryPath: environment.GROK_BIN,
      ...(environment.GROK_HOME ? { grokHome: environment.GROK_HOME } : {}),
    },
    logLevel: environment.LOG_LEVEL,
  };
}

function parseOrigins(
  value: string | undefined,
  defaults: readonly string[],
): ReadonlySet<string> {
  const origins = value
    ? value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean)
    : [...defaults];

  for (const origin of origins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error(
        `Invalid server configuration: WEBCODE_ALLOWED_ORIGINS contains ${origin}`,
      );
    }
    if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) {
      throw new Error(
        `Invalid server configuration: WEBCODE_ALLOWED_ORIGINS contains ${origin}`,
      );
    }
  }
  return new Set(origins);
}
