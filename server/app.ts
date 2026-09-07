import type { TerminalService } from './terminal/service.ts';
import { terminalApi, terminalSocket } from './terminal/routes.ts';
import type { ProviderInstallations } from './core/provider-installations.ts';
import type { ProviderLimitsService } from './core/provider-limits.ts';
import { attachmentRoutes } from './http/attachment-routes.ts';
import type { AttachmentService } from './attachments/service.ts';
import { createBearerAuthHook } from './security/bearer-auth.ts';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { RawData } from 'ws';
import { z } from 'zod';
import type { ServerConfig } from './config.ts';
import {
  ProviderNotFoundError,
  ProviderRegistry,
} from './core/provider-registry.ts';
import { ConnectionHub } from './realtime/connection-hub.ts';
import type { TicketStore } from './security/websocket-tickets.ts';
import type { AgentService } from './core/agent-service.ts';
import type { ProjectService } from './core/project-service.ts';
import { InvalidProjectPathError } from './core/project-service.ts';
import {
  AttachmentValidationError,
  ConflictError,
  ResourceNotFoundError,
} from './storage/errors.ts';
import { workspaceRoutes } from './http/workspace-routes.ts';
import type { WorkspaceStore } from './storage/workspace-store.ts';

const providerParamsSchema = z.object({
  providerId: z.string().min(1).max(64),
});
const ticketQuerySchema = z.object({ ticket: z.string().min(32).max(256) });
const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ping'),
    requestId: z.string().max(128).optional(),
  }),
  z.object({
    type: z.literal('providers.refresh'),
    providerId: z.string().min(1).max(64),
  }),
]);

export interface AppDependencies {
  terminals?: TerminalService;
  installations?: ProviderInstallations;
  limits?: ProviderLimitsService;
  attachments?: AttachmentService;
  config: ServerConfig;
  providers: ProviderRegistry;
  tickets: TicketStore;
  projects?: ProjectService;
  agents?: AgentService;
  store?: WorkspaceStore;
  hub?: ConnectionHub;
}

export async function buildApp(
  dependencies: AppDependencies,
): Promise<FastifyInstance> {
  const { config, providers, tickets, projects, agents } = dependencies;
  const hub = dependencies.hub ?? new ConnectionHub();
  const app = Fastify({
    trustProxy: false,
    bodyLimit: 256 * 1024,
    requestTimeout: 30_000,
    connectionTimeout: 10_000,
    keepAliveTimeout: 72_000,
    genReqId: () => randomUUID(),
    logger:
      config.environment === 'test'
        ? false
        : {
            level: config.logLevel,
            serializers: {
              req: (request: {
                method?: string;
                url?: string;
                id?: string;
              }) => ({
                method: request.method,
                url: request.url?.split('?')[0],
                id: request.id,
              }),
            },
            redact: {
              paths: [
                'req.headers.authorization',
                'req.query.ticket',
                'request.headers.authorization',
              ],
              censor: '[redacted]',
            },
          },
  });

  await app.register(helmet, { global: true });
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
  });
  await app.register(cors, {
    credentials: false,
    methods: ['GET', 'POST', 'OPTIONS', 'HEAD', 'PATCH', 'DELETE'],
    exposedHeaders: [
      'Location',
      'Upload-Offset',
      'Upload-Length',
      'Tus-Resumable',
    ],
    origin(origin, callback) {
      callback(null, origin === undefined || config.allowedOrigins.has(origin));
    },
  });
  await app.register(websocket, {
    options: {
      maxPayload: 64 * 1024,
      perMessageDeflate: false,
    },
  });

  if (dependencies.terminals)
    terminalSocket(app, dependencies.terminals, config);

  const unsubscribe = providers.subscribe((snapshot) =>
    hub.broadcastProviderSnapshot(snapshot),
  );
  app.addHook('onClose', async () => {
    unsubscribe();
    dependencies.terminals?.close();
    await dependencies.installations?.close();
    await dependencies.limits?.close();
    dependencies.attachments?.close();
    await agents?.close();
    hub.closeAll();
    await providers.close();
    dependencies.store?.close();
  });

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof AttachmentValidationError) {
      await reply.code(400).send({
        error: { code: 'invalid_attachment', message: error.message },
      });
      return;
    }
    if (error instanceof ProviderNotFoundError) {
      await reply.code(404).send({
        error: { code: 'provider_not_found', message: error.message },
      });
      return;
    }
    if (error instanceof ResourceNotFoundError) {
      await reply
        .code(404)
        .send({ error: { code: 'not_found', message: error.message } });
      return;
    }
    if (error instanceof ConflictError) {
      await reply
        .code(409)
        .send({ error: { code: 'conflict', message: error.message } });
      return;
    }
    if (error instanceof InvalidProjectPathError) {
      await reply.code(400).send({
        error: { code: 'invalid_project_path', message: error.message },
      });
      return;
    }
    if (isErrorWithStatus(error, 429)) {
      await reply.code(429).send({
        error: {
          code: 'rate_limit_exceeded',
          message: 'Too many requests. Try again shortly.',
        },
      });
      return;
    }
    request.log.error({ err: error }, 'request failed');
    await reply.code(500).send({
      error: {
        code: 'internal_error',
        message: 'The server could not complete the request.',
      },
    });
  });

  app.get('/healthz', async () => ({ status: 'ok' as const }));
  app.get('/readyz', async () => ({
    status: 'ready' as const,
    providers: providers.ids,
  }));

  await app.register(
    async (api) => {
      if (config.authToken)
        api.addHook('onRequest', createBearerAuthHook(config.authToken));
      api.addHook('onRequest', async (request, reply) => {
        if (
          request.headers.origin &&
          !config.allowedOrigins.has(request.headers.origin)
        ) {
          await reply.code(403).send({
            error: {
              code: 'origin_forbidden',
              message: 'Origin is not allowed.',
            },
          });
        }
      });
      if (dependencies.terminals)
        await terminalApi(api, dependencies.terminals);
      if (dependencies.attachments)
        await api.register(attachmentRoutes, {
          attachments: dependencies.attachments,
        });
      if (dependencies.limits) {
        api.get<{ Params: { providerId: string } }>(
          '/providers/:providerId/limits',
          async (request) => ({
            data: await dependencies.limits!.read(request.params.providerId),
          }),
        );
        api.post<{ Params: { providerId: string } }>(
          '/providers/:providerId/limits/refresh',
          { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
          async (request) => ({
            data: await dependencies.limits!.read(
              request.params.providerId,
              true,
            ),
          }),
        );
      }
      if (dependencies.installations) {
        api.get('/provider-installations', async () => ({
          data: await dependencies.installations!.list(),
        }));
        api.post<{ Params: { providerId: string } }>(
          '/providers/:providerId/installation/check',
          { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } },
          async (request) => ({
            data: await dependencies.installations!.read(
              request.params.providerId,
              true,
            ),
          }),
        );
        api.post<{ Params: { providerId: string } }>(
          '/providers/:providerId/installation/update',
          { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } },
          async (request, reply) => {
            const data = await dependencies.installations!.update(
              request.params.providerId,
            );
            return reply.code(202).send({ data });
          },
        );
      }
      api.get('/providers', async () => ({ data: await providers.list() }));

      api.post(
        '/providers/:providerId/refresh',
        { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
        async (request, reply) => {
          const parsed = providerParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            await reply.code(400).send({
              error: {
                code: 'invalid_request',
                message: 'A valid provider id is required.',
              },
            });
            return;
          }
          return {
            data: await providers.probe(parsed.data.providerId, {
              force: true,
            }),
          };
        },
      );

      if (projects && agents)
        await api.register(workspaceRoutes, { projects, agents });

      api.post(
        '/auth/websocket-ticket',
        { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
        async () => ({ data: tickets.issue() }),
      );
    },
    { prefix: '/api/v1' },
  );

  app.get(
    '/ws',
    {
      websocket: true,
      preValidation: async (request, reply) => {
        const origin = request.headers.origin;
        if (origin && !config.allowedOrigins.has(origin)) {
          await reply.code(403).send({
            error: {
              code: 'origin_forbidden',
              message: 'Origin is not allowed.',
            },
          });
          return;
        }
        const query = ticketQuerySchema.safeParse(request.query);
        if (!query.success || !tickets.consume(query.data.ticket)) {
          await reply.code(401).send({
            error: {
              code: 'invalid_ticket',
              message: 'WebSocket ticket is invalid or expired.',
            },
          });
        }
      },
    },
    (socket) => {
      const remove = hub.add(socket);
      socket.on('close', remove);
      socket.on('error', remove);
      socket.on('message', (raw) => {
        let payload: unknown;
        try {
          payload = JSON.parse(rawDataToText(raw));
        } catch {
          socket.send(
            JSON.stringify({
              type: 'error',
              error: {
                code: 'invalid_json',
                message: 'Message must be valid JSON.',
              },
            }),
          );
          return;
        }
        const message = clientMessageSchema.safeParse(payload);
        if (!message.success) {
          socket.send(
            JSON.stringify({
              type: 'error',
              error: {
                code: 'invalid_message',
                message: 'Unsupported realtime message.',
              },
            }),
          );
          return;
        }
        if (message.data.type === 'ping') {
          socket.send(
            JSON.stringify({ type: 'pong', requestId: message.data.requestId }),
          );
          return;
        }
        void providers
          .probe(message.data.providerId, { force: true })
          .catch((error: unknown) => {
            if (socket.readyState !== 1) return;
            const code =
              error instanceof ProviderNotFoundError
                ? 'provider_not_found'
                : 'provider_refresh_failed';
            socket.send(
              JSON.stringify({
                type: 'error',
                error: { code, message: 'Provider refresh failed.' },
              }),
            );
          });
      });
      socket.send(JSON.stringify({ type: 'server.hello', protocolVersion: 1 }));
      void providers
        .list()
        .then((snapshots) => {
          for (const snapshot of snapshots) {
            if (socket.readyState === 1)
              socket.send(
                JSON.stringify({ type: 'provider.snapshot', data: snapshot }),
              );
          }
        })
        .catch(() => socket.close(1011, 'Provider discovery failed'));
    },
  );

  return app;
}

function rawDataToText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

function isErrorWithStatus(error: unknown, statusCode: number): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'statusCode' in error &&
    error.statusCode === statusCode
  );
}
