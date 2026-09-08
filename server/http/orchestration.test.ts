import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../app.ts';
import { loadConfig } from '../config.ts';
import { AgentService } from '../core/agent-service.ts';
import { ProjectService } from '../core/project-service.ts';
import { ProviderRegistry } from '../core/provider-registry.ts';
import { ConnectionHub } from '../realtime/connection-hub.ts';
import { SqliteWorkspaceStore } from '../storage/sqlite-workspace-store.ts';
import { InMemoryTicketStore } from '../security/websocket-tickets.ts';
import type { AgentRuntime } from '../runtime/agent-runtime.ts';
import type { TaskDetail } from '../../lib/workspace/contracts.ts';

void test('authenticated turn API validates orchestration, persists phases and deduplicates submissions', async (t) => {
  const store = new SqliteWorkspaceStore(':memory:');
  const hub = new ConnectionHub();
  const providers = new ProviderRegistry(
    ['codex', 'muse'].map((id) => ({
      id,
      probe: async () => ({
        providerId: id,
        health: 'ready' as const,
        checkedAt: new Date().toISOString(),
        models: [{ id: 'model', label: 'Model', capabilities: [] }],
      }),
    })),
    { cacheTtlMs: 1000, probeTimeoutMs: 1000 },
  );
  let calls = 0;
  const runtimes: AgentRuntime[] = ['codex', 'muse'].map((providerId) => ({
    providerId,
    permissionModes: ['read-only', 'workspace', 'full-access'],
    executeTurn: async (_input, handlers) => {
      calls++;
      handlers.onProviderThread(providerId + '-thread');
      handlers.onEvent({
        type: 'agent.message.completed',
        data: { itemId: '1', text: providerId + ' result' },
      });
      return { status: 'completed' };
    },
    interrupt: async () => true,
    close: async () => {},
  }));
  const agents = new AgentService(store, hub, runtimes, {
    probeProvider: (id) => providers.probe(id),
  });
  const projects = new ProjectService(store, process.cwd());
  const project = projects.add(process.cwd());
  const task = agents.createTask({
    projectId: project.id,
    providerId: 'codex',
    model: 'model',
  });
  const token = 'orchestration-test-token-'.repeat(2);
  const config = loadConfig({ NODE_ENV: 'test', WEBCODE_AUTH_TOKEN: token });
  const app = await buildApp({
    config,
    store,
    hub,
    agents,
    projects,
    providers,
    tickets: new InMemoryTicketStore({ ttlMs: 30000 }),
  });
  t.after(() => app.close());
  const payload = {
    clientRequestId: randomUUID(),
    prompt: 'Implement this',
    orchestration: { worker: { providerId: 'muse', model: 'model' } },
  };
  const url = `/api/v1/tasks/${task.id}/turns`;
  const headers = { authorization: `Bearer ${token}` };
  assert.equal(
    (await app.inject({ method: 'POST', url, payload })).statusCode,
    401,
  );
  for (const worker of [
    { providerId: '../grok', model: 'model' },
    { providerId: 'muse', model: '' },
    { providerId: 'muse', model: 'model', permissionMode: 'full-access' },
  ]) {
    const response = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: { ...payload, orchestration: { worker } },
    });
    assert.equal(response.statusCode, 400);
  }
  assert.equal(store.getTaskDetail(task.id)!.turns.length, 0);
  const first = await app.inject({ method: 'POST', url, headers, payload });
  assert.equal(first.statusCode, 202);
  const retry = await app.inject({ method: 'POST', url, headers, payload });
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.json().data.id, first.json().data.id);
  const conflict = await app.inject({
    method: 'POST',
    url,
    headers,
    payload: {
      ...payload,
      orchestration: { worker: { providerId: 'muse', model: 'changed' } },
    },
  });
  assert.equal(conflict.statusCode, 409);
  for (let i = 0; agents.isBusy && i < 50; i++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(agents.isBusy, false);
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/tasks/${task.id}`,
    headers,
  });
  const detail = response.json<{ data: TaskDetail }>().data;
  assert.equal(detail.task.status, 'completed');
  assert.equal(detail.turns[0].executions?.length, 3);
  assert.equal(detail.turns[0].orchestration?.worker.providerId, 'muse');
  assert.equal(calls, 3);
});
