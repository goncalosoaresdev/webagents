import assert from 'node:assert/strict';
import test from 'node:test';
import { SqliteWorkspaceStore } from '../storage/sqlite-workspace-store.ts';
import { readTask, pollWithRecovery } from '../../lib/workspace/sync.ts';

void test('recovers more than 5000 events and fetches only new events on reconnect', async () => {
  const store = new SqliteWorkspaceStore(':memory:');
  const now = new Date().toISOString();
  const project = store.createProject({
    id: 'p',
    name: 'P',
    path: '/tmp',
    isGitRepository: false,
    now,
  });
  const task = store.createTask({
    id: 't',
    projectId: project.id,
    providerId: 'fixture',
    title: 'Test',
    now,
  });
  store.transaction(() => {
    for (let i = 0; i < 5001; i++)
      store.appendEvent({
        taskId: task.id,
        type: 'agent.message.delta',
        data: { text: 'x' },
        now,
      });
  });
  const cursors: number[] = [];
  const reader = {
    async task(id: string, after = 0) {
      cursors.push(after);
      return store.getTaskDetail(id, after)!;
    },
  };
  const first = await readTask(reader, task.id);
  assert.equal(first.events.length, 5001);
  assert.deepEqual(cursors, [0, 5000]);
  store.appendEvent({
    taskId: task.id,
    type: 'agent.message.completed',
    data: { text: 'done' },
    now,
  });
  const second = await readTask(reader, task.id, first);
  assert.equal(second.events.length, 5002);
  assert.equal(cursors.at(-1), 5001);
  store.close();
});
void test('polling recovers after failure, wakes on focus, and stops after disposal', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const listeners = new Map<string, () => void>();
  const environment = {
    addEventListener: (name: string, listener: unknown) =>
      listeners.set(name, listener as () => void),
    removeEventListener: (name: string) => listeners.delete(name),
  } as unknown as Window;
  let attempts = 0;
  let errors = 0;
  const stop = pollWithRecovery(
    async () => {
      attempts++;
      if (attempts === 1) throw new Error('offline');
      return 800;
    },
    () => {
      errors++;
    },
    environment,
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(errors, 1);
  context.mock.timers.tick(1000);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(attempts, 2);
  listeners.get('focus')!();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(attempts, 3);
  stop();
  context.mock.timers.tick(30_000);
  assert.equal(attempts, 3);
  assert.equal(listeners.size, 0);
});
