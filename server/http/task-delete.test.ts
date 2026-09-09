import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { workspaceRoutes } from './workspace-routes.ts';
import { ResourceNotFoundError } from '../storage/errors.ts';
import { AgentService } from '../core/agent-service.ts';
import { ConnectionHub } from '../realtime/connection-hub.ts';
import { SqliteWorkspaceStore } from '../storage/sqlite-workspace-store.ts';
import type {
  ExecuteTurnHandlers,
  ExecuteTurnInput,
  ExecuteTurnResult,
  AgentRuntime,
} from '../runtime/agent-runtime.ts';

class FixtureRuntime implements AgentRuntime {
  readonly providerId = 'fixture';
  async executeTurn(
    _input: ExecuteTurnInput,
    _handlers: ExecuteTurnHandlers,
  ): Promise<ExecuteTurnResult> {
    return { status: 'completed' };
  }
  async interrupt() {
    return false;
  }
  async close() {}
}

async function setup() {
  const store = new SqliteWorkspaceStore(':memory:');
  const agents = new AgentService(store, new ConnectionHub(), [
    new FixtureRuntime(),
  ]);
  const project = store.createProject({
    id: crypto.randomUUID(),
    name: 'App',
    path: process.cwd(),
    isGitRepository: false,
    now: new Date().toISOString(),
  });
  const app = Fastify();
  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof ResourceNotFoundError) {
      await reply
        .code(404)
        .send({ error: { code: 'not_found', message: error.message } });
      return;
    }
    throw error;
  });
  await app.register(workspaceRoutes, {
    projects: { list: () => [] } as never,
    agents,
  });
  return { app, agents, project, store };
}

void test('DELETE /tasks/:taskId removes one task and 404s when missing', async (t) => {
  const { app, agents, project, store } = await setup();
  t.after(() => app.close());
  const task = agents.createTask({
    projectId: project.id,
    providerId: 'fixture',
  });

  const response = await app.inject({
    method: 'DELETE',
    url: `/tasks/${task.id}`,
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { data: { deleted: true } });
  assert.equal(store.getTask(task.id), undefined);

  const missing = await app.inject({
    method: 'DELETE',
    url: `/tasks/${task.id}`,
  });
  assert.equal(missing.statusCode, 404);
  await agents.close();
  store.close();
});

void test('DELETE /tasks removes only archived tasks', async (t) => {
  const { app, agents, project, store } = await setup();
  t.after(() => app.close());
  const active = agents.createTask({
    projectId: project.id,
    providerId: 'fixture',
  });
  const archived = agents.createTask({
    projectId: project.id,
    providerId: 'fixture',
  });
  agents.setArchived(archived.id, true);

  const response = await app.inject({ method: 'DELETE', url: '/tasks' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { data: { deleted: 1 } });
  assert.equal(store.getTask(archived.id), undefined);
  assert.ok(store.getTask(active.id));
  await agents.close();
  store.close();
});
