import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentService } from './agent-service.ts';
import { SqliteWorkspaceStore } from '../storage/sqlite-workspace-store.ts';
import { ConnectionHub } from '../realtime/connection-hub.ts';
import type {
  AgentRuntime,
  ExecuteTurnInput,
  ExecuteTurnHandlers,
  ExecuteTurnResult,
} from '../runtime/agent-runtime.ts';
import type { ProviderSnapshot } from '../../lib/providers/contracts.ts';
import { buildTurnTimeline } from '../../lib/workspace/timeline.ts';
import {
  orchestrationSchema,
  providerMention,
} from '../../lib/workspace/orchestration.ts';
import {
  ExecutionReport,
  pathsOverlap,
  validateOrchestrationModel,
} from './orchestration.ts';

const orchestration = {
  worker: { providerId: 'muse', model: 'spark', reasoningEffort: 'high' },
};
const modes = ['read-only', 'workspace', 'full-access'] as const;
function snapshot(providerId: string): ProviderSnapshot {
  return {
    providerId,
    health: 'ready',
    checkedAt: new Date().toISOString(),
    models: [
      {
        id: providerId === 'codex' ? 'astra' : 'spark',
        label: providerId,
        inputModalities: ['text', 'image'],
        capabilities: [
          {
            id: 'reasoningEffort',
            label: 'Reasoning',
            defaultValue: 'high',
            values: [{ id: 'high', label: 'High' }],
          },
        ],
      },
    ],
  };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await tick();
  }
  assert.fail('Condition did not settle');
}
type Behavior = (
  input: ExecuteTurnInput,
  handlers: ExecuteTurnHandlers,
  signal?: AbortSignal,
) => Promise<ExecuteTurnResult>;
class Runtime implements AgentRuntime {
  readonly permissionModes = modes;
  calls: ExecuteTurnInput[] = [];
  interrupted: string[] = [];
  behavior?: Behavior;
  constructor(readonly providerId: string) {}
  async executeTurn(
    input: ExecuteTurnInput,
    handlers: ExecuteTurnHandlers,
    signal?: AbortSignal,
  ) {
    this.calls.push(input);
    handlers.onProviderThread(`${this.providerId}-thread`);
    handlers.onProviderTurn('native-turn');
    if (this.behavior) return this.behavior(input, handlers, signal);
    handlers.onEvent({
      type: 'agent.message.completed',
      data: {
        itemId: 'same-id',
        text: `${this.providerId} report ${this.calls.length}`,
      },
    });
    return { status: 'completed' as const };
  }
  async interrupt(id: string) {
    this.interrupted.push(id);
    return true;
  }
  async close() {}
}
function fixture(
  t: TestContext,
  options: ConstructorParameters<typeof AgentService>[3] = {},
  filename = ':memory:',
) {
  const store = new SqliteWorkspaceStore(filename);
  const lead = new Runtime('codex');
  const worker = new Runtime('muse');
  const hub = new ConnectionHub();
  const service = new AgentService(store, hub, [lead, worker], {
    probeProvider: async (id) => snapshot(id),
    ...options,
  });
  const project = store.createProject({
    id: randomUUID(),
    name: 'Test',
    path: '/tmp/orchestration-project',
    isGitRepository: false,
    now: 'now',
  });
  const task = service.createTask({
    projectId: project.id,
    providerId: 'codex',
    model: 'astra',
  });
  t.after(async () => {
    await service.close();
    store.close();
  });
  const start = (
    extra: Partial<Parameters<AgentService['startTurn']>[1]> = {},
  ) =>
    service.startTurn(task.id, {
      clientRequestId: randomUUID(),
      prompt: 'Implement a function and test it.',
      orchestration,
      ...extra,
    });
  return { store, service, lead, worker, task, project, start, hub };
}

void test('runs three phases in one turn, preserves lead thread, namespaces events and pins options', async (t) => {
  const { service, store, lead, worker, task, start } = fixture(t, {
    maxConcurrentTurns: 1,
  });
  const first = start();
  await until(() => !service.isBusy);
  const detail = service.getTask(task.id);
  assert.equal(detail.task.status, 'completed');
  assert.equal(detail.turns.length, 1);
  assert.equal(detail.task.providerThreadId, 'codex-thread');
  const executions = detail.turns[0].executions!;
  assert.deepEqual(
    executions.map((e) => [e.phase, e.status]),
    [
      ['plan', 'completed'],
      ['work', 'completed'],
      ['review', 'completed'],
    ],
  );
  assert.equal(lead.calls.length, 2);
  assert.equal(worker.calls.length, 1);
  assert.equal(lead.calls[0].permissionMode, 'read-only');
  assert.equal(worker.calls[0].permissionMode, 'workspace');
  assert.equal(lead.calls[1].permissionMode, 'workspace');
  assert.equal(lead.calls[1].providerThreadId, 'codex-thread');
  assert.equal(worker.calls[0].providerThreadId, undefined);
  assert.match(worker.calls[0].prompt, /codex report 1/);
  assert.match(lead.calls[1].prompt, /muse report 1/);
  assert.equal(executions[0].reasoningEffort, 'high');
  assert.equal(executions[1].providerThreadId, 'muse-thread');
  assert.equal(new Set(executions.map((e) => e.id)).size, 3);
  assert.equal(
    buildTurnTimeline(detail.events).filter((item) => item.kind === 'message')
      .length,
    3,
  );
  assert.deepEqual(
    detail.events
      .filter((e) => e.type === 'turn.status')
      .map((e) => e.data.status),
    ['running', 'completed'],
  );
  const retry = service.startTurn(task.id, {
    clientRequestId: first.turn.clientRequestId,
    prompt: first.turn.prompt,
    orchestration,
  });
  assert.equal(retry.created, false);
  assert.equal(retry.turn.id, first.turn.id);
  assert.equal(
    store.getTurn(first.turn.id)?.orchestration?.worker.model,
    'spark',
  );
  assert.throws(
    () =>
      service.startTurn(task.id, {
        clientRequestId: first.turn.clientRequestId,
        prompt: first.turn.prompt,
        orchestration: { worker: { providerId: 'muse', model: 'other' } },
      }),
    /different content/,
  );
});

void test('reused approval IDs across phases remain independent and cancellations settle them', async (t) => {
  const f = fixture(t);
  const behavior: Behavior = async (_input, handlers) => {
    const decision = await handlers.requestApproval({
      providerRequestId: 1,
      kind: 'command',
      summary: 'Run a check?',
      details: {},
    });
    assert.equal(decision, 'accept');
    handlers.onEvent({
      type: 'agent.message.completed',
      data: { text: 'checked' },
    });
    return { status: 'completed' };
  };
  f.lead.behavior = behavior;
  f.worker.behavior = behavior;
  const first = f.start();
  const seen = new Set<string>();
  for (let i = 0; i < 3; i++) {
    await until(() =>
      f.service
        .getTask(f.task.id)
        .approvals.some((a) => a.status === 'pending'),
    );
    const approval = f.service
      .getTask(f.task.id)
      .approvals.find((a) => a.status === 'pending')!;
    assert.ok(approval.executionId);
    assert.ok(!seen.has(approval.executionId));
    seen.add(approval.executionId);
    assert.match(approval.summary, /codex|muse/);
    assert.equal(
      f.service.startTurn(f.task.id, {
        clientRequestId: first.turn.clientRequestId,
        prompt: first.turn.prompt,
        orchestration,
      }).created,
      false,
    );
    f.service.resolveApproval(approval.id, 'accept');
  }
  await until(() => !f.service.isBusy);
  assert.equal(f.service.getTask(f.task.id).approvals.length, 3);
  assert.equal(f.service.getTask(f.task.id).task.status, 'completed');
});

void test('Stop cancels a worker approval, interrupts Muse and never launches review', async (t) => {
  const f = fixture(t);
  f.worker.behavior = async (_input, handlers) => {
    const decision = await handlers.requestApproval({
      providerRequestId: 1,
      kind: 'command',
      summary: 'Run?',
      details: {},
    });
    assert.equal(decision, 'cancel');
    handlers.onEvent({
      type: 'agent.message.completed',
      data: { text: 'late output must be ignored' },
    });
    return { status: 'completed' };
  };
  f.start();
  await until(() => f.service.getTask(f.task.id).approvals.length > 0);
  await f.service.interrupt(f.task.id);
  await until(() => !f.service.isBusy);
  assert.deepEqual(f.worker.interrupted, [f.worker.calls[0].taskId]);
  assert.equal(f.lead.calls.length, 1);
  const detail = f.service.getTask(f.task.id);
  assert.equal(detail.task.status, 'interrupted');
  assert.equal(detail.approvals[0].decision, 'cancel');
  assert.equal(detail.turns[0].executions![1].status, 'interrupted');
  assert.ok(
    !detail.events.some((e) => e.data.text === 'late output must be ignored'),
  );
});

void test('Stop before startup and between phase completion and transition prevents execution', async (t) => {
  const f = fixture(t);
  f.start();
  await f.service.interrupt(f.task.id);
  await until(() => !f.service.isBusy);
  assert.equal(f.lead.calls.length, 0);
  const original = f.hub.broadcastTaskEvent.bind(f.hub);
  f.hub.broadcastTaskEvent = (event) => {
    original(event);
    if (
      event.type === 'execution.status' &&
      event.data.phase === 'work' &&
      event.data.status === 'completed'
    )
      void f.service.interrupt(f.task.id);
  };
  f.start();
  await until(() => !f.service.isBusy);
  assert.equal(f.lead.calls.length, 1);
  assert.equal(f.service.getTask(f.task.id).task.status, 'interrupted');
});

void test('worker and review failures preserve completed phases without retry', async (t) => {
  const f = fixture(t);
  f.worker.behavior = async () => ({
    status: 'failed',
    error: 'Worker failed after a partial edit',
  });
  f.start();
  await until(() => !f.service.isBusy);
  assert.equal(f.lead.calls.length, 1);
  assert.deepEqual(
    f.service.getTask(f.task.id).turns[0].executions!.map((e) => e.status),
    ['completed', 'failed'],
  );
  f.worker.behavior = undefined;
  f.lead.behavior = async (_input, handlers) => {
    if (f.lead.calls.length === 3) throw new Error('private runtime failure');
    handlers.onEvent({
      type: 'agent.message.completed',
      data: { text: 'brief' },
    });
    return { status: 'completed' };
  };
  f.start();
  await until(() => !f.service.isBusy);
  const turn = f.service.getTask(f.task.id).turns[1];
  assert.deepEqual(
    turn.executions!.map((e) => e.status),
    ['completed', 'completed', 'failed'],
  );
  assert.doesNotMatch(turn.error!, /private runtime/);
});

void test('rejects empty and oversized completed briefs without running the worker', async (t) => {
  const f = fixture(t);
  for (const text of ['', 'x'.repeat(16_001)]) {
    f.lead.behavior = async (_input, handlers) => {
      handlers.onEvent({
        type: 'agent.message.delta',
        data: { text: 'not a final brief' },
      });
      handlers.onEvent({ type: 'agent.message.completed', data: { text } });
      return { status: 'completed' };
    };
    f.start();
    await until(() => !f.service.isBusy);
    assert.equal(f.service.getTask(f.task.id).task.status, 'failed');
    assert.equal(f.worker.calls.length, 0);
  }
});

void test('preflight rejects unavailable models and image incompatibility before any provider execution', async (t) => {
  const f = fixture(t, {
    probeProvider: async (id) => ({
      ...snapshot(id),
      health: id === 'muse' ? 'unavailable' : 'ready',
    }),
  });
  f.start();
  await until(() => !f.service.isBusy);
  assert.equal(f.lead.calls.length, 0);
  assert.match(f.service.getTask(f.task.id).turns[0].error!, /not ready/);
  assert.throws(
    () =>
      validateOrchestrationModel(snapshot('muse'), 'missing', undefined, false),
    /unavailable/,
  );
  assert.throws(
    () =>
      validateOrchestrationModel(snapshot('muse'), 'spark', 'invalid', false),
    /reasoning/,
  );
  const noImages = snapshot('muse');
  noImages.models[0].inputModalities = ['text'];
  assert.throws(
    () => validateOrchestrationModel(noImages, 'spark', undefined, true),
    /images/,
  );
});

void test('preserves read-only and full-access choices and forwards only prepared parent attachments', async (t) => {
  const asset = {
    id: randomUUID(),
    name: 'test.png',
    size: 10,
    mime: 'image/png',
    state: 'ready' as const,
    path: '/tmp/asset',
  };
  const f = fixture(t, {
    attachments: {
      bind: () => {},
      list: () => [asset],
      prepare: async () => [asset],
    },
  });
  for (const permissionMode of ['read-only', 'full-access'] as const) {
    f.start({ permissionMode, attachmentIds: [asset.id] });
    await until(() => !f.service.isBusy);
    assert.equal(f.worker.calls.at(-1)!.permissionMode, permissionMode);
    assert.equal(f.lead.calls.at(-1)!.permissionMode, permissionMode);
    assert.deepEqual(f.worker.calls.at(-1)!.attachments, [asset]);
  }
});

void test('workspace reservation is bidirectional, detects nested roots, and releases after stop', async (t) => {
  const f = fixture(t);
  const block: Behavior = async (_input, _handlers, signal) =>
    new Promise((resolve) => {
      signal!.addEventListener(
        'abort',
        () => resolve({ status: 'interrupted' }),
        { once: true },
      );
    });
  f.lead.behavior = block;
  const otherProject = f.store.createProject({
    id: randomUUID(),
    name: 'Nested',
    path: f.project.path + '/nested',
    isGitRepository: false,
    now: 'now',
  });
  const otherTask = f.service.createTask({
    projectId: otherProject.id,
    providerId: 'codex',
    model: 'astra',
  });
  const plain = () =>
    f.service.startTurn(otherTask.id, {
      clientRequestId: randomUUID(),
      prompt: 'Ordinary task',
    });
  f.start();
  assert.throws(plain, /overlaps/);
  await f.service.interrupt(f.task.id);
  await until(() => !f.service.isBusy);
  plain();
  assert.throws(() => f.start(), /overlaps/);
  await f.service.interrupt(otherTask.id);
  await until(() => !f.service.isBusy);
  f.lead.behavior = undefined;
  f.start();
  await until(() => !f.service.isBusy);
  assert.equal(f.service.getTask(f.task.id).task.status, 'completed');
});

void test('hard timeout cancels approval waiting and marks the sequence failed', async (t) => {
  const f = fixture(t, { orchestrationTimeoutMs: 15 });
  f.worker.behavior = async (_input, handlers) => {
    assert.equal(
      await handlers.requestApproval({
        providerRequestId: 1,
        kind: 'command',
        summary: 'Run?',
        details: {},
      }),
      'cancel',
    );
    return { status: 'interrupted' };
  };
  f.start();
  await new Promise((resolve) => setTimeout(resolve, 40));
  await until(() => !f.service.isBusy);
  assert.equal(f.service.getTask(f.task.id).task.status, 'failed');
  assert.match(f.service.getTask(f.task.id).turns[0].error!, /time limit/);
  assert.equal(f.lead.calls.length, 1);
});

void test('restart preserves completed phases, fails active execution and cancels approvals without replay', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'orchestration-recovery-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'workspace.sqlite');
  const store = new SqliteWorkspaceStore(filename);
  store.createProject({
    id: 'p',
    name: 'P',
    path: '/tmp/p',
    isGitRepository: false,
    now: 'now',
  });
  store.createTask({
    id: 't',
    projectId: 'p',
    providerId: 'codex',
    title: 'Test',
    now: 'now',
  });
  store.createTurn({
    id: 'turn',
    taskId: 't',
    clientRequestId: 'request',
    prompt: 'Work',
    orchestration,
    now: 'now',
  });
  store.setTaskStatus('t', 'running', 'now');
  store.setTurnStatus('turn', 'running', 'now');
  for (const phase of ['plan', 'work'] as const)
    store.createExecution({
      id: phase,
      turnId: 'turn',
      phase,
      providerId: phase === 'plan' ? 'codex' : 'muse',
      model: phase,
      permissionMode: 'workspace',
      status: phase === 'plan' ? 'completed' : 'running',
      prompt: 'test',
      result: phase === 'plan' ? 'retained brief' : undefined,
      createdAt: 'now',
    });
  store.createApproval({
    id: 'a',
    taskId: 't',
    turnId: 'turn',
    executionId: 'work',
    providerRequestId: 1,
    method: 'command',
    summary: 'Run?',
    details: {},
    now: 'now',
  });
  store.close();
  const reopened = new SqliteWorkspaceStore(filename);
  const runtime = new Runtime('codex');
  const service = new AgentService(reopened, new ConnectionHub(), [runtime]);
  const detail = service.getTask('t');
  assert.equal(detail.task.status, 'failed');
  assert.deepEqual(
    detail.turns[0].executions!.map((e) => e.status),
    ['completed', 'failed'],
  );
  assert.equal(detail.turns[0].executions![0].result, 'retained brief');
  assert.equal(detail.approvals[0].decision, 'cancel');
  assert.equal(runtime.calls.length, 0);
  assert.equal(
    detail.events.filter((e) => e.type === 'execution.status').length,
    1,
  );
  await service.close();
  reopened.close();
});

void test('mentions alone cannot enable routing; schemas and mention boundaries are explicit', () => {
  assert.equal(providerMention('email a@muse', 12), undefined);
  assert.deepEqual(providerMention('do this @mu', 11), {
    start: 8,
    end: 11,
    query: 'mu',
  });
  assert.equal(
    orchestrationSchema.safeParse({
      worker: { providerId: '../unknown', model: 'x' },
    }).success,
    false,
  );
  assert.equal(
    orchestrationSchema.safeParse({
      worker: { providerId: 'muse', model: 'x', permissionMode: 'full-access' },
    }).success,
    false,
  );
  assert.equal(pathsOverlap('/tmp/a', '/tmp/ab'), false);
  assert.equal(pathsOverlap('/tmp/a', '/tmp/a/b'), true);
  const report = new ExecutionReport(20);
  report.add({
    type: 'agent.message.completed',
    data: { itemId: 'a', text: 'original' },
  });
  report.add({
    type: 'agent.message.completed',
    data: { itemId: 'a', text: 'updated' },
  });
  assert.equal(report.finish(), 'updated');
});

void test('Stop detaches from discovery immediately and late discovery never starts the lead', async (t) => {
  let finish!: (value: ProviderSnapshot) => void;
  const f = fixture(t, {
    probeProvider: async (id) =>
      id === 'codex'
        ? snapshot(id)
        : new Promise((resolve) => {
            finish = resolve;
          }),
  });
  f.start();
  await until(() => Boolean(finish));
  await f.service.interrupt(f.task.id);
  await until(() => !f.service.isBusy);
  assert.equal(f.service.getTask(f.task.id).task.status, 'interrupted');
  finish(snapshot('muse'));
  await tick();
  assert.equal(f.lead.calls.length, 0);
});

void test('shutdown settles a worker approval and prevents review; maintenance rejects without creating a turn', async (t) => {
  let maintenance = true;
  const f = fixture(t, { maintenance: () => maintenance });
  assert.throws(() => f.start(), /update in progress/);
  assert.equal(f.service.getTask(f.task.id).turns.length, 0);
  maintenance = false;
  f.worker.behavior = async (_input, handlers) => {
    assert.equal(
      await handlers.requestApproval({
        providerRequestId: 1,
        kind: 'command',
        summary: 'Run?',
        details: {},
      }),
      'cancel',
    );
    return { status: 'completed' };
  };
  f.start();
  await until(() => f.service.getTask(f.task.id).approvals.length > 0);
  await f.service.close();
  assert.equal(f.service.getTask(f.task.id).task.status, 'interrupted');
  assert.equal(f.lead.calls.length, 1);
  assert.equal(f.service.isBusy, false);
});

for (const leadId of ['codex', 'muse', 'grok']) {
  for (const workerId of ['codex', 'muse', 'grok']) {
    void test(`${leadId} can orchestrate ${workerId}, preserving sessions and completing delta-only protocols`, async (t) => {
      const store = new SqliteWorkspaceStore(':memory:');
      const calls: { provider: string; input: ExecuteTurnInput }[] = [];
      const runtimes = ['codex', 'muse', 'grok'].map((provider) => {
        const runtime = new Runtime(provider);
        runtime.behavior = async (input, handlers) => {
          calls.push({ provider, input });
          handlers.onProviderThread(
            input.providerThreadId ?? `${provider}-${input.taskId}`,
          );
          if (provider === 'grok') {
            handlers.onEvent({
              type: 'agent.message.delta',
              data: { itemId: 'answer', text: 'Verified ' },
            });
            handlers.onEvent({
              type: 'agent.message.delta',
              data: { itemId: 'answer', text: `${provider} result` },
            });
          } else {
            handlers.onEvent({
              type: 'agent.message.delta',
              data: { itemId: 'answer', text: 'A partial result' },
            });
            handlers.onEvent({
              type: 'agent.message.completed',
              data: { itemId: 'answer', text: `Verified ${provider} result` },
            });
          }
          return { status: 'completed' };
        };
        return runtime;
      });
      const service = new AgentService(store, new ConnectionHub(), runtimes, {
        probeProvider: async (id) => ({
          ...snapshot(id),
          models: [
            { id: 'lead-model', label: 'Lead model', capabilities: [] },
            { id: 'worker-model', label: 'Worker model', capabilities: [] },
          ],
        }),
      });
      t.after(async () => {
        await service.close();
        store.close();
      });
      const project = store.createProject({
        id: randomUUID(),
        name: 'Test',
        path: '/tmp/multi-provider',
        isGitRepository: false,
        now: 'now',
      });
      const task = service.createTask({
        projectId: project.id,
        providerId: leadId,
        model: 'lead-model',
      });
      service.startTurn(task.id, {
        clientRequestId: randomUUID(),
        prompt: 'Do work',
        orchestration: {
          worker: { providerId: workerId, model: 'worker-model' },
        },
      });
      await until(() => !service.isBusy);
      const detail = service.getTask(task.id);
      assert.equal(detail.task.status, 'completed', detail.turns[0].error);
      assert.deepEqual(
        calls.map((call) => call.provider),
        [leadId, workerId, leadId],
      );
      assert.deepEqual(
        calls.map((call) => call.input.model),
        ['lead-model', 'worker-model', 'lead-model'],
      );
      assert.equal(calls[1].input.providerThreadId, undefined);
      assert.equal(
        calls[2].input.providerThreadId,
        `${leadId}-${calls[0].input.taskId}`,
      );
      assert.equal(
        detail.task.providerThreadId,
        calls[2].input.providerThreadId,
      );
      assert.match(
        calls[1].input.prompt,
        new RegExp(`Verified ${leadId} result`),
      );
      assert.match(
        calls[2].input.prompt,
        new RegExp(`Verified ${workerId} result`),
      );
      assert.doesNotMatch(calls[1].input.prompt, /partial result/);
      assert.doesNotMatch(calls[0].input.prompt, /Muse/);
      assert.doesNotMatch(calls[2].input.prompt, /Muse has/);
      assert.equal(new Set(calls.map((call) => call.input.taskId)).size, 3);
    });
  }
}

void test('uninstalled workers are rejected before recording a turn', async (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      f.start({
        orchestration: {
          worker: { providerId: 'not-installed', model: 'unknown' },
        },
      }),
    /unavailable/,
  );
  assert.equal(f.service.getTask(f.task.id).turns.length, 0);
});

void test('failed streaming worker cannot advance to review, and streamed reports stay bounded', async (t) => {
  const f = fixture(t);
  f.worker.behavior = async (_input, handlers) => {
    handlers.onEvent({
      type: 'agent.message.delta',
      data: { itemId: 'a', text: 'unfinished' },
    });
    return { status: 'failed', error: 'Lost connection' };
  };
  f.start();
  await until(() => !f.service.isBusy);
  assert.equal(f.lead.calls.length, 1);
  assert.equal(f.service.getTask(f.task.id).task.status, 'failed');
  const report = new ExecutionReport(10);
  report.add({
    type: 'agent.message.delta',
    data: { itemId: 'a', text: '12345' },
  });
  report.add({
    type: 'agent.message.delta',
    data: { itemId: 'a', text: '678901' },
  });
  assert.throws(() => report.finish(), /size limit/);
});
