import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { GrokAcpClient } from './json-rpc-client.ts';
import { GrokDiscovery } from './discovery.ts';
import { GrokTurnRuntime, permissionChoice } from './turn-runtime.ts';
import { AgentService } from '../../core/agent-service.ts';
import { SqliteWorkspaceStore } from '../../storage/sqlite-workspace-store.ts';
import { ConnectionHub } from '../../realtime/connection-hub.ts';

async function fixture(context: TestContext, mode = 'normal') {
  const cwd = await mkdtemp(join(tmpdir(), 'webcode-grok-'));
  context.after(() => rm(cwd, { recursive: true, force: true }));
  const binaryPath = join(cwd, 'grok-fixture');
  await writeFile(
    binaryPath,
    `#!${process.execPath}
const readline = require('node:readline');
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
const mode = process.env.FIXTURE_MODE;
let promptId;
let sessionId = 'session-1';
setInterval(() => {}, 1000);
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') {
    if (mode === 'hang') return;
    if (mode === 'oversized') { process.stdout.write('x'.repeat(2 * 1024 * 1024 + 1)); return; }
    if (mode === 'malformed') { process.stdout.write('invalid-json\\n'); return; }
    if (mode === 'exit') { process.exit(1); }
    send({
      id: m.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { resume: {}, close: {} },
        },
        agentInfo: { name: 'grok', version: '1.0.13' },
        authMethods: mode === 'unauthenticated' ? [{ id: 'browser', name: 'Browser' }] : [],
      },
    });
    return;
  }
  if (m.method === 'authenticate') {
    send({ id: m.id, error: { code: -32000, message: 'interactive login required' } });
    return;
  }
  if (m.method === 'x.ai/models/list') {
    send({
      id: m.id,
      result: {
        currentModelId: 'grok-4.6',
        availableModels: [{ modelId: 'grok-4.6', name: 'Grok 4.6' }],
      },
    });
    return;
  }
  if (m.method === 'session/new' || m.method === 'session/load' || m.method === 'session/resume') {
    if (m.method !== 'session/new') sessionId = m.params.sessionId;
    send({
      id: m.id,
      result: {
        sessionId,
        configOptions: [
          { configId: 'model', value: { value: 'grok-4.6' }, options: [{ value: 'grok-4.6' }] },
          { configId: 'reasoning_effort', value: { value: 'high' }, options: ['low', 'high', 'xhigh'] },
        ],
      },
    });
    return;
  }
  if (m.method === 'session/set_config_option' || m.method === 'session/set_model') {
    send({ id: m.id, result: {} });
    return;
  }
  if (m.method === 'session/prompt') {
    promptId = m.id;
    if (mode === 'attachments') {
      const hasImage = (m.params.prompt || []).some((part) => part.type === 'image' && part.data);
      const hasDoc = JSON.stringify(m.params.prompt).includes('document.txt');
      if (!hasImage || !hasDoc) {
        send({ id: m.id, error: { code: -1, message: 'Attachment inputs missing' } });
        return;
      }
    }
    send({
      method: 'session/update',
      params: {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', messageId: 'msg', content: { type: 'text', text: 'Hi' } },
      },
    });
    if (mode === 'silent-turn') return;
    if (mode === 'bad-event') {
      send({
        method: 'session/update',
        params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: 8 } },
      });
      return;
    }
    send({
      id: 0,
      method: 'session/request_permission',
      params: {
        sessionId,
        toolCall: { toolCallId: 'call_1', title: 'echo hello', kind: 'execute' },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      },
    });
    return;
  }
  if (m.method === 'session/cancel') {
    if (promptId !== undefined) send({ id: promptId, result: { stopReason: 'cancelled' } });
    return;
  }
  if (m.id === 0 && m.result) {
    send({
      method: 'session/update',
      params: {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', messageId: 'msg', content: { type: 'text', text: 'Done' } },
      },
    });
    if (promptId !== undefined) send({ id: promptId, result: { stopReason: 'end_turn' } });
  }
});
`,
    { mode: 0o700 },
  );
  return {
    cwd,
    binaryPath,
    environment: { FIXTURE_MODE: mode },
    requestTimeoutMs: 2_000,
  };
}

for (const mode of ['oversized', 'malformed', 'exit']) {
  void test(`contains ${mode} provider output and closes the process`, async (context) => {
    const client = await GrokAcpClient.start(await fixture(context, mode));
    context.after(() => client.close());
    await assert.rejects(
      client.initialize(),
      mode === 'oversized'
        ? /oversized/
        : mode === 'malformed'
          ? /JSON/
          : /exited/,
    );
    await client.close();
    await assert.rejects(
      client.request('x.ai/models/list', {}),
      /closed|oversized|JSON|protocol/,
    );
  });
}

void test('request timeout and repeated close settle without pending processes', async (context) => {
  const client = await GrokAcpClient.start(await fixture(context, 'hang'));
  await assert.rejects(client.initialize(), /timed out/);
  const first = client.close();
  assert.equal(first, client.close());
  await first;
});

void test('discovery reports unauthenticated when only browser login is offered', async (context) => {
  const options = await fixture(context, 'unauthenticated');
  const snapshot = await new GrokDiscovery(options).probe();
  assert.equal(snapshot.health, 'unauthenticated');
  assert.match(snapshot.message ?? '', /grok login/);
});

void test('discovery lists models after a successful initialize', async (context) => {
  const options = await fixture(context);
  const snapshot = await new GrokDiscovery(options).probe();
  assert.equal(snapshot.health, 'ready');
  assert.equal(snapshot.version, '1.0.13');
  assert.equal(snapshot.models[0]?.id, 'grok-4.6');
});

void test('interrupt works during initialization and shutdown waits for execution', async (context) => {
  const runtime = new GrokTurnRuntime(await fixture(context, 'hang'));
  const job = runtime.executeTurn(
    { taskId: 'task', cwd: tmpdir(), prompt: 'test' },
    {
      onProviderThread() {},
      onProviderTurn() {},
      onEvent() {},
      async requestApproval() {
        return 'cancel';
      },
    },
  );
  const settled = job.then((result) => result.status);
  assert.equal(await runtime.interrupt('task'), true);
  await runtime.close();
  assert.equal(await settled, 'interrupted');
});

void test('two real subprocess turns can reuse native approval IDs', async (context) => {
  const options = await fixture(context);
  const runtime = new GrokTurnRuntime(options);
  const store = new SqliteWorkspaceStore(':memory:');
  const hub = new ConnectionHub();
  const service = new AgentService(store, hub, [runtime]);
  context.after(async () => {
    await service.close();
    store.close();
  });
  const now = new Date().toISOString();
  const project = store.createProject({
    id: crypto.randomUUID(),
    name: 'Test',
    path: options.cwd,
    isGitRepository: false,
    now,
  });
  const task = service.createTask({
    projectId: project.id,
    providerId: 'grok',
  });
  for (let i = 0; i < 2; i++) {
    let resolveApproval!: () => void;
    const requested = new Promise<void>((resolve) => {
      resolveApproval = resolve;
    });
    const remove = hub.add({
      readyState: 1,
      close() {},
      send(raw) {
        const message = JSON.parse(raw);
        if (message.data?.type === 'approval.requested') resolveApproval();
      },
    });
    service.startTurn(task.id, {
      clientRequestId: crypto.randomUUID(),
      prompt: 'hello',
    });
    await requested;
    const approval = service
      .getTask(task.id)
      .approvals.find((a) => a.status === 'pending')!;
    assert.ok(approval);
    service.resolveApproval(approval.id, 'accept');
    assert.equal(
      service.resolveApproval(approval.id, 'accept').decision,
      'accept',
    );
    await new Promise<void>((resolve) => {
      const removeFinished = hub.add({
        readyState: 1,
        close() {},
        send(raw) {
          const message = JSON.parse(raw);
          if (
            message.data?.type === 'turn.status' &&
            message.data.data.status === 'completed'
          ) {
            removeFinished();
            resolve();
          }
        },
      });
    });
    remove();
  }
  assert.equal(service.getTask(task.id).approvals.length, 2);
  assert.equal(service.getTask(task.id).task.providerThreadId, 'session-1');
});

void test('idle watchdog ends a live process that never completes its turn', async (context) => {
  const options = await fixture(context, 'silent-turn');
  const runtime = new GrokTurnRuntime({
    ...options,
    requestTimeoutMs: 1000,
    idleTimeoutMs: 500,
  });
  context.after(() => runtime.close());
  const result = await runtime.executeTurn(
    { taskId: 'task', cwd: options.cwd, prompt: 'hello' },
    {
      onProviderThread() {},
      onProviderTurn() {},
      onEvent() {},
      async requestApproval() {
        return 'cancel';
      },
    },
  );
  assert.equal(
    result.status === 'failed' || result.status === 'interrupted',
    true,
  );
});

void test('malformed supported notification fails only its execution', async (context) => {
  const options = await fixture(context, 'bad-event');
  const runtime = new GrokTurnRuntime(options);
  context.after(() => runtime.close());
  const result = await runtime.executeTurn(
    { taskId: 'task', cwd: options.cwd, prompt: 'hello' },
    {
      onProviderThread() {},
      onProviderTurn() {},
      onEvent() {},
      async requestApproval() {
        return 'cancel';
      },
    },
  );
  assert.equal(result.status, 'failed');
});

void test('delivers native images and a filesystem manifest', async (context) => {
  const options = await fixture(context, 'attachments');
  const imagePath = join(options.cwd, 'image');
  await writeFile(imagePath, 'image-fixture');
  const runtime = new GrokTurnRuntime(options);
  context.after(() => runtime.close());
  const events: string[] = [];
  const result = await runtime.executeTurn(
    {
      taskId: 'test',
      cwd: options.cwd,
      prompt: '',
      attachments: [
        {
          id: 'image',
          name: 'image.png',
          mime: 'image/png',
          size: 13,
          state: 'ready',
          path: imagePath,
        },
        {
          id: 'doc',
          name: 'document.txt',
          mime: 'application/octet-stream',
          size: 1,
          state: 'ready',
          path: join(options.cwd, 'doc'),
        },
      ],
    },
    {
      onProviderThread() {},
      onProviderTurn() {},
      onEvent(event) {
        events.push(event.type);
      },
      async requestApproval() {
        return 'accept';
      },
    },
  );
  assert.equal(result.status, 'completed');
  assert.equal(events.includes('agent.message.delta'), true);
});

void test('maps ACP permission kinds onto Webcode decisions and fails closed', () => {
  const options = [
    { optionId: 'allow-once', kind: 'allow_once' as const },
    { optionId: 'reject-once', kind: 'reject_once' as const },
  ];
  assert.deepEqual(permissionChoice(options, 'accept'), {
    outcome: { outcome: 'selected', optionId: 'allow-once' },
  });
  assert.deepEqual(permissionChoice(options, 'cancel'), {
    outcome: { outcome: 'cancelled' },
  });
  assert.throws(() => permissionChoice(options, 'acceptForSession'));
});
