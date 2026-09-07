import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { SqliteWorkspaceStore } from '../storage/sqlite-workspace-store.ts';

void test('persists project, task, turn, event, and approval records', () => {
  const store = new SqliteWorkspaceStore(':memory:');
  const now = new Date().toISOString();
  const project = store.createProject({
    id: crypto.randomUUID(),
    name: 'App',
    path: '/work/app',
    isGitRepository: true,
    now,
  });
  const task = store.createTask({
    id: crypto.randomUUID(),
    projectId: project.id,
    providerId: 'codex',
    title: 'Test task',
    now,
  });
  const turn = store.createTurn({
    id: crypto.randomUUID(),
    taskId: task.id,
    clientRequestId: crypto.randomUUID(),
    prompt: 'Hello',
    now,
  });
  assert.equal(turn.created, true);
  assert.equal(
    store.createTurn({
      id: crypto.randomUUID(),
      taskId: task.id,
      clientRequestId: turn.turn.clientRequestId,
      prompt: 'Ignored',
      now,
    }).created,
    false,
  );
  store.appendEvent({
    taskId: task.id,
    turnId: turn.turn.id,
    type: 'user.message',
    data: { text: 'Hello' },
    now,
  });
  const approval = store.createApproval({
    id: crypto.randomUUID(),
    taskId: task.id,
    turnId: turn.turn.id,
    providerRequestId: 7,
    method: 'command',
    summary: 'Run tests',
    details: {},
    now,
  });
  store.resolveApproval(approval.id, 'accept', now);
  const detail = store.getTaskDetail(task.id);
  assert.equal(detail?.events[0]?.data.text, 'Hello');
  assert.equal(detail?.approvals[0]?.decision, 'accept');
  store.close();
});

void test('marks incomplete work failed during restart recovery', () => {
  const store = new SqliteWorkspaceStore(':memory:');
  const now = new Date().toISOString();
  const project = store.createProject({
    id: crypto.randomUUID(),
    name: 'App',
    path: '/work/app',
    isGitRepository: false,
    now,
  });
  const task = store.createTask({
    id: crypto.randomUUID(),
    projectId: project.id,
    providerId: 'codex',
    title: 'Task',
    now,
  });
  const turn = store.createTurn({
    id: crypto.randomUUID(),
    taskId: task.id,
    clientRequestId: crypto.randomUUID(),
    prompt: 'Work',
    now,
  }).turn;
  store.setTaskStatus(task.id, 'running', now);
  store.setTurnStatus(turn.id, 'running', now);
  store.recoverIncompleteWork(new Date(Date.now() + 1_000).toISOString());
  assert.equal(store.getTask(task.id)?.status, 'failed');
  assert.equal(store.getTurn(turn.id)?.status, 'failed');
  assert.equal(store.listEvents(task.id)[0]?.type, 'turn.status');
  store.close();
});

void test('permits reused approval IDs across turns and keeps each decision independent', () => {
  const store = new SqliteWorkspaceStore(':memory:');
  const now = new Date().toISOString();
  store.createProject({
    id: 'p',
    name: 'P',
    path: '/tmp',
    isGitRepository: false,
    now,
  });
  store.createTask({
    id: 't',
    projectId: 'p',
    providerId: 'codex',
    title: 'T',
    now,
  });
  for (const id of ['one', 'two']) {
    store.createTurn({
      id,
      taskId: 't',
      clientRequestId: id,
      prompt: 'hello',
      now,
    });
    store.createApproval({
      id,
      taskId: 't',
      turnId: id,
      providerRequestId: 0,
      method: 'command',
      summary: 'Run?',
      details: {},
      now,
    });
    store.resolveApproval(id, id === 'one' ? 'accept' : 'decline', now);
  }
  assert.equal(store.getApproval('one')?.decision, 'accept');
  assert.equal(store.getApproval('two')?.decision, 'decline');
  store.close();
});

void test('migrates a v1 database without losing tasks, approvals, or events', async (context) => {
  const { default: Database } = await import('better-sqlite3');
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const directory = await mkdtemp(join(tmpdir(), 'webcode-migration-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, 'workspace.sqlite');
  const legacy = new Database(filename);
  legacy.exec(
    await readFile(
      new URL('../fixtures/workspace-v1.sql', import.meta.url),
      'utf8',
    ),
  );
  legacy.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES (1,'2026-09-05');
    INSERT INTO projects VALUES ('p','P','/tmp',0,'now','now');
    INSERT INTO tasks VALUES ('t','p','codex','native-thread','Test','completed',NULL,NULL,'now','now',NULL);
    INSERT INTO turns VALUES ('turn','t','native-turn','request','hello','completed',NULL,'now','now');
    INSERT INTO approvals VALUES ('a','t','turn',0,'command','Run?','{}','resolved','accept','now','now');
    INSERT INTO task_events (task_id,turn_id,event_type,payload_json,created_at) VALUES ('t','turn','agent.message.completed','{"text":"Saved answer"}','now');`);
  legacy.close();
  const store = new SqliteWorkspaceStore(filename);
  const detail = store.getTaskDetail('t')!;
  assert.equal(detail.task.providerThreadId, 'native-thread');
  assert.equal(detail.approvals[0].decision, 'accept');
  assert.equal(detail.events[0].data.text, 'Saved answer');
  assert.equal(detail.turns[0].providerTurnId, 'native-turn');
  store.createTurn({
    id: 'next',
    taskId: 't',
    clientRequestId: 'next',
    prompt: 'next',
    now: 'now',
  });
  store.createApproval({
    id: 'b',
    taskId: 't',
    turnId: 'next',
    providerRequestId: 0,
    method: 'command',
    summary: 'Run?',
    details: {},
    now: 'now',
  });
  store.close();
  const reopened = new SqliteWorkspaceStore(filename);
  assert.equal(reopened.getTaskDetail('t')?.approvals.length, 2);
  reopened.close();
});
