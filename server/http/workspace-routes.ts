import { orchestrationSchema } from '../../lib/workspace/orchestration.ts';
import { permissionModes } from '../../lib/workspace/permissions.ts';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AgentService } from '../core/agent-service.ts';
import type { ProjectService } from '../core/project-service.ts';

const id = z.uuid();
const projectBody = z.object({
  path: z.string().trim().min(1).max(4096),
  name: z.string().trim().min(1).max(120).optional(),
});
const directoryQuery = z.object({ path: z.string().max(4096).optional() });
const cloneBody = z.object({
  source: z.enum(['git', 'github']),
  value: z.string().trim().min(1).max(4096),
});
const taskBody = z.object({
  projectId: id,
  providerId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  title: z.string().trim().min(1).max(120).optional(),
  model: z.string().trim().min(1).max(128).optional(),
  reasoningEffort: z.string().trim().min(1).max(32).optional(),
});
const taskQuery = z.object({
  projectId: id.optional(),
  includeArchived: z.enum(['true', 'false']).optional(),
});
const detailQuery = z.object({
  after: z.coerce.number().int().min(0).optional(),
});
const params = z.object({ taskId: id });
const approvalParams = z.object({ approvalId: id });
const turnBody = z.object({
  orchestration: orchestrationSchema.optional(),
  permissionMode: z.enum(permissionModes).optional(),
  attachmentIds: z.array(id).max(8).optional(),
  clientRequestId: id,
  prompt: z.string().trim().max(100_000),
  model: z.string().trim().min(1).max(128).optional(),
  reasoningEffort: z.string().trim().min(1).max(32).optional(),
});
const decisionBody = z.object({
  decision: z.enum(['accept', 'acceptForSession', 'decline', 'cancel']),
});

export interface WorkspaceRoutesOptions {
  projects: ProjectService;
  agents: AgentService;
}

export const workspaceRoutes: FastifyPluginAsync<
  WorkspaceRoutesOptions
> = async (app, options) => {
  app.get('/projects', async () => ({ data: options.projects.list() }));
  app.get('/projects/directories', async (request, reply) => {
    const query = parse(directoryQuery, request.query, reply);
    if (!query) return;
    return { data: await options.projects.listDirectories(query.path) };
  });
  app.post(
    '/projects',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = parse(projectBody, request.body, reply);
      if (!body) return;
      return reply
        .code(201)
        .send({ data: options.projects.add(body.path, body.name) });
    },
  );
  app.post(
    '/projects/clone',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = parse(cloneBody, request.body, reply);
      if (!body) return;
      return reply
        .code(201)
        .send({ data: await options.projects.clone(body.source, body.value) });
    },
  );

  app.get('/tasks', async (request, reply) => {
    const query = parse(taskQuery, request.query, reply);
    if (!query) return;
    return {
      data: options.agents.listTasks(
        query.projectId,
        query.includeArchived === 'true',
      ),
    };
  });
  app.post('/tasks', async (request, reply) => {
    const body = parse(taskBody, request.body, reply);
    if (!body) return;
    return reply.code(201).send({ data: options.agents.createTask(body) });
  });
  app.post('/tasks/:taskId/archive', async (request, reply) => {
    const path = parse(params, request.params, reply);
    const body = parse(
      z.object({ archived: z.boolean() }),
      request.body,
      reply,
    );
    if (!path || !body) return;
    return { data: options.agents.setArchived(path.taskId, body.archived) };
  });
  app.delete('/tasks', async () => {
    return { data: options.agents.deleteArchivedTasks() };
  });
  app.delete('/tasks/:taskId', async (request, reply) => {
    const path = parse(params, request.params, reply);
    if (!path) return;
    return { data: options.agents.deleteTask(path.taskId) };
  });
  app.get('/tasks/:taskId', async (request, reply) => {
    const path = parse(params, request.params, reply);
    const query = parse(detailQuery, request.query, reply);
    if (!path || !query) return;
    return { data: options.agents.getTask(path.taskId, query.after ?? 0) };
  });
  app.post(
    '/tasks/:taskId/turns',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const path = parse(params, request.params, reply);
      const body = parse(turnBody, request.body, reply);
      if (!path || !body) return;
      if (!body.prompt && !body.attachmentIds?.length)
        return reply
          .code(400)
          .send({ error: { message: 'Add a message or attachment.' } });
      const result = options.agents.startTurn(path.taskId, body);
      return reply.code(result.created ? 202 : 200).send({ data: result.turn });
    },
  );
  app.post('/tasks/:taskId/interrupt', async (request, reply) => {
    const path = parse(params, request.params, reply);
    if (!path) return;
    return {
      data: { interrupted: await options.agents.interrupt(path.taskId) },
    };
  });
  app.post('/approvals/:approvalId/decision', async (request, reply) => {
    const path = parse(approvalParams, request.params, reply);
    const body = parse(decisionBody, request.body, reply);
    if (!path || !body) return;
    return {
      data: options.agents.resolveApproval(path.approvalId, body.decision),
    };
  });
};

function parse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  reply: { code(statusCode: number): { send(value: unknown): unknown } },
): T | undefined {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  void reply.code(400).send({
    error: {
      code: 'invalid_request',
      message: 'Request data is invalid.',
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    },
  });
  return undefined;
}
