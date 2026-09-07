import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  AgentRuntime,
  ExecuteTurnHandlers,
  ExecuteTurnInput,
  ExecuteTurnResult,
} from '../runtime/agent-runtime.ts';
import { ConnectionHub } from '../realtime/connection-hub.ts';
import { SqliteWorkspaceStore } from '../storage/sqlite-workspace-store.ts';
import { AgentService } from './agent-service.ts';

class FixtureRuntime implements AgentRuntime {
  readonly providerId = 'fixture';
  async executeTurn(
    _input: ExecuteTurnInput,
    handlers: ExecuteTurnHandlers,
  ): Promise<ExecuteTurnResult> {
    handlers.onProviderThread('provider-thread');
    handlers.onProviderTurn('provider-turn');
    handlers.onEvent({
      type: 'agent.message.completed',
      data: { text: 'Done' },
    });
    return { status: 'completed' };
  }
  async interrupt() {
    return false;
  }
  async close() {}
}

void test('runs a provider-neutral turn and preserves idempotency', async () => {
  const store = new SqliteWorkspaceStore(':memory:');
  const project = store.createProject({
    id: crypto.randomUUID(),
    name: 'App',
    path: process.cwd(),
    isGitRepository: true,
    now: new Date().toISOString(),
  });
  const service = new AgentService(store, new ConnectionHub(), [
    new FixtureRuntime(),
  ]);
  const task = service.createTask({
    projectId: project.id,
    providerId: 'fixture',
  });
  const clientRequestId = crypto.randomUUID();
  const first = service.startTurn(task.id, {
    clientRequestId,
    prompt: 'Implement a reliable feature',
  });
  const duplicate = service.startTurn(task.id, {
    clientRequestId,
    prompt: 'Implement a reliable feature',
  });
  assert.equal(first.turn.id, duplicate.turn.id);
  assert.equal(duplicate.created, false);
  await new Promise((resolve) => setImmediate(resolve));
  const detail = service.getTask(task.id);
  assert.equal(detail.task.status, 'completed');
  assert.equal(detail.task.providerThreadId, 'provider-thread');
  assert.deepEqual(
    detail.events.map((event) => event.type),
    ['user.message', 'turn.status', 'agent.message.completed', 'turn.status'],
  );
  await service.close();
  store.close();
});

void test('shutdown waits for final status and rejects changed idempotency payloads', async () => {
  const store = new SqliteWorkspaceStore(':memory:');
  const now = new Date().toISOString();
  const project = store.createProject({
    id: crypto.randomUUID(),
    name: 'Test',
    path: '/tmp',
    isGitRepository: false,
    now,
  });
  let finish!: (result: ExecuteTurnResult) => void;
  class SlowRuntime extends FixtureRuntime {
    override async executeTurn(): Promise<ExecuteTurnResult> {
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
  }
  const service = new AgentService(store, new ConnectionHub(), [
    new SlowRuntime(),
  ]);
  const task = service.createTask({
    projectId: project.id,
    providerId: 'fixture',
  });
  const input = { clientRequestId: crypto.randomUUID(), prompt: 'hello' };
  service.startTurn(task.id, input);
  assert.throws(
    () => service.startTurn(task.id, { ...input, prompt: 'changed' }),
    /different content/,
  );
  assert.throws(
    () => service.startTurn(task.id, { ...input, model: 'changed' }),
    /different content/,
  );
  let closed = false;
  const closing = service.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  finish({ status: 'completed' });
  await closing;
  assert.equal(store.getTask(task.id)?.status, 'interrupted');
  assert.equal(
    service.getTask(task.id).events.at(-1)?.data.status,
    'interrupted',
  );
  store.close();
});

void test('provider maintenance rejects new turns without recording a message', async () => {
  const store = new SqliteWorkspaceStore(':memory:');
  const project = store.createProject({
    id: crypto.randomUUID(),
    name: 'App',
    path: process.cwd(),
    isGitRepository: true,
    now: new Date().toISOString(),
  });
  const service = new AgentService(
    store,
    new ConnectionHub(),
    [new FixtureRuntime()],
    { maintenance: () => true },
  );
  const task = service.createTask({
    projectId: project.id,
    providerId: 'fixture',
  });
  assert.throws(
    () =>
      service.startTurn(task.id, {
        clientRequestId: crypto.randomUUID(),
        prompt: 'Hello',
      }),
    /update in progress/,
  );
  assert.equal(service.getTask(task.id).turns.length, 0);
  await service.close();
  store.close();
});

void test('archiving preserves history and a new message atomically restores the task', async () => {
  const store = new SqliteWorkspaceStore(':memory:');
  const project = store.createProject({
    id: crypto.randomUUID(),
    name: 'App',
    path: process.cwd(),
    isGitRepository: true,
    now: new Date().toISOString(),
  });
  const service = new AgentService(store, new ConnectionHub(), [
    new FixtureRuntime(),
  ]);
  const task = service.createTask({
    projectId: project.id,
    providerId: 'fixture',
  });
  assert.ok(service.setArchived(task.id, true).archivedAt);
  assert.equal(service.listTasks().length, 0);
  assert.equal(service.listTasks(undefined, true).length, 1);
  const request = { clientRequestId: crypto.randomUUID(), prompt: 'Continue' };
  service.startTurn(task.id, request);
  assert.equal(service.getTask(task.id).task.archivedAt, undefined);
  assert.equal(service.listTasks().length, 1);
  await new Promise((resolve) => setImmediate(resolve));
  service.setArchived(task.id, true);
  service.startTurn(task.id, request);
  assert.ok(
    service.getTask(task.id).task.archivedAt,
    'Retrying an old message does not unarchive it',
  );
  assert.equal(service.getTask(task.id).turns.length, 1);
  assert.equal(service.setArchived(task.id, false).archivedAt, undefined);
  assert.throws(() => service.setArchived('missing', true), /not found/);
  await service.close();
  store.close();
});

void test('global task list includes active and archived tasks from every project', async () => {
  const store = new SqliteWorkspaceStore(':memory:');
  const service = new AgentService(store, new ConnectionHub(), [
    new FixtureRuntime(),
  ]);
  const projects = ['First', 'Second'].map((name) =>
    store.createProject({
      id: crypto.randomUUID(),
      name,
      path: `${process.cwd()}/${name}`,
      isGitRepository: false,
      now: new Date().toISOString(),
    }),
  );
  const tasks = projects.map((project) =>
    service.createTask({ projectId: project.id, providerId: 'fixture' }),
  );
  service.setArchived(tasks[1]!.id, true);
  assert.deepEqual(
    new Set(service.listTasks(undefined, true).map((task) => task.projectId)),
    new Set(projects.map((project) => project.id)),
  );
  assert.equal(service.listTasks().length, 1);
  service.startTurn(tasks[1]!.id, {
    clientRequestId: crypto.randomUUID(),
    prompt: 'Resume second project',
  });
  assert.equal(service.getTask(tasks[1]!.id).task.projectId, projects[1]!.id);
  assert.equal(service.listTasks().length, 2);
  await service.close();
  store.close();
});
