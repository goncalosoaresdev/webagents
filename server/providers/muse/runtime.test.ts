import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { EXPECTED_SCHEMA_FINGERPRINT } from '@muse-code/sdk';
import { MuseDiscovery } from './discovery.ts';
import { MAX_MUSE_IMAGE_BYTES, MuseTurnRuntime } from './turn-runtime.ts';
import { AgentService } from '../../core/agent-service.ts';
import { SqliteWorkspaceStore } from '../../storage/sqlite-workspace-store.ts';
import { ConnectionHub } from '../../realtime/connection-hub.ts';

async function fixture(context: TestContext, mode = 'normal') {
  const cwd = await mkdtemp(join(tmpdir(), 'webcode-muse-'));
  context.after(() => rm(cwd, { recursive: true, force: true }));
  const binaryPath = join(cwd, 'muse-fixture');
  await writeFile(
    binaryPath,
    `#!${process.execPath}
const readline = require('node:readline');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const mode = process.env.FIXTURE_MODE;
const fingerprint = process.env.MUSE_FINGERPRINT;
const now = '2026-09-07T12:00:00.000Z';
let cursor = 0;
let pendingTurn = null;
const nextCursor = () => String(++cursor).padStart(4, '0');
const sourceRange = () => ({
  first: { id: 'e' + cursor, sequence: cursor },
  last: { id: 'e' + cursor, sequence: cursor },
  stream: { id: 'run', kind: 'run' },
});
const sessionObject = (params) => ({
  activeTurnId: null,
  createdAt: now,
  forkedFrom: null,
  modelId: params.modelId ?? 'muse-spark-1.3',
  path: '/tmp/muse-session',
  providerId: 'meta',
  sessionId: params.sessionId || 'session-1',
  status: 'idle',
  turnCount: 0,
  updatedAt: now,
  workspaceRoot: mode === 'wrong-root' ? '/tmp/other-workspace' : params.workspaceRoot,
});
setInterval(() => {}, 1000);
process.stdin.on('end', () => process.exit(0));
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialized') return;
  if (m.method === 'initialize') {
    if (mode === 'hang') return;
    if (mode === 'exit') process.exit(1);
    send({
      jsonrpc: '2.0',
      id: m.id,
      result: {
        experimentalApi: false,
        grantedCapabilities: [],
        museHome: '/tmp/muse-home',
        platformFamily: 'unix',
        platformOs: 'macos',
        schema: { version: 1, fingerprint },
        serverInfo: { name: 'muse', version: '1.0.3' },
        sessionDurability: mode === 'ephemeral' ? 'ephemeral' : 'durable',
        userAgent: 'muse/fixture',
      },
    });
    return;
  }
  if (m.method === 'model/list') {
    if (mode === 'model-hang') return;
    send({
      jsonrpc: '2.0',
      id: m.id,
      result: {
        source: 'providerCatalog',
        providerId: 'meta',
        profileId: null,
        models: [{
          modelId: 'muse-spark-1.3',
          displayLabel: 'Muse Spark 1.3',
          providerId: 'meta',
          isDefault: true,
          isActive: false,
          contextLimit: null,
          cost: null,
          description: null,
          outputLimit: null,
          profileId: null,
          releaseDate: null,
        }],
      },
    });
    return;
  }
  if (m.method === 'session/start' || m.method === 'session/resume') {
    const session = sessionObject(m.params || {});
    const result = m.method === 'session/resume'
      ? {
          history: { items: null, mode: 'none', noneReason: 'excluded', snapshot: null },
          pendingRequests: [],
          session,
          viewCursor: nextCursor(),
        }
      : { session, viewCursor: nextCursor() };
    send({ jsonrpc: '2.0', id: m.id, result });
    return;
  }
  if (m.method === 'session/setApprovalMode' || m.method === 'session/setModel') {
    send({
      jsonrpc: '2.0',
      id: m.id,
      result: {
        commandId: m.params.commandId,
        status: 'accepted',
        applyOutcome: 'completed',
        effectiveMode: { mode: m.params.mode || 'onRequest', source: 'approvalReconfigure' },
      },
    });
    return;
  }
  if (m.method === 'turn/interrupt') {
    send({
      jsonrpc: '2.0',
      id: m.id,
      result: { commandId: m.params.commandId, status: 'accepted', turnId: m.params.turnId },
    });
    if (mode === 'interrupt-ack-only') return;
    send({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        sessionId: m.params.sessionId,
        turnId: m.params.turnId,
        terminal: 'cancelled',
        viewCursor: nextCursor(),
        sourceRange: sourceRange(),
      },
    });
    return;
  }
  if (m.method === 'userInput/cancel') {
    if (mode === 'user-input-hang') return;
    send({
      jsonrpc: '2.0',
      id: m.id,
      result: { commandId: m.params.commandId, status: 'accepted', userInputId: m.params.userInputId },
    });
    if (pendingTurn) completeTurn(pendingTurn.sessionId, pendingTurn.turnId);
    return;
  }
  if (m.method === 'approval/decide') {
    send({
      jsonrpc: '2.0',
      id: m.id,
      result: {
        approvalId: m.params.approvalId,
        commandId: m.params.commandId,
        status: 'accepted',
        terminal: true,
      },
    });
    if (pendingTurn) completeTurn(pendingTurn.sessionId, pendingTurn.turnId);
    return;
  }
  if (m.method === 'turn/start') {
    if (mode === 'attachments') {
      const parts = m.params.input || [];
      const hasImage = parts.some((part) => part.type === 'image' && part.base64Data === Buffer.from('image-fixture').toString('base64'));
      const hasDoc = parts.some((part) => part.type === 'text' && String(part.text).includes('document.txt'));
      if (!hasImage || !hasDoc) {
        send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'Attachment inputs missing', data: { kind: 'invalidParams' } } });
        return;
      }
    }
    const turnId = m.params.commandId;
    const sessionId = m.params.sessionId;
    pendingTurn = { sessionId, turnId };
    send({
      jsonrpc: '2.0',
      id: m.id,
      result: {
        commandId: turnId,
        disposition: 'started',
        startedNewTurn: true,
        status: 'accepted',
        turnId,
      },
    });
    if (mode === 'silent-turn' || mode === 'interrupt-ack-only') return;
    send({
      jsonrpc: '2.0',
      method: 'turn/started',
      params: {
        commandId: turnId,
        sessionId,
        turnId,
        viewCursor: nextCursor(),
        sourceRange: sourceRange(),
      },
    });
    if (mode === 'user-input' || mode === 'user-input-hang') {
      send({
        jsonrpc: '2.0',
        method: 'userInput/requested',
        params: {
          itemId: 'ask-1',
          questions: [{ header: 'Choose', id: 'q1', options: [{ label: 'Yes' }], question: 'Continue?', selection: { mode: 'single' } }],
          sessionId,
          toolCallId: 'call-1',
          toolName: 'ask',
          turnId,
          userInputId: 'input-1',
          viewCursor: nextCursor(),
        },
      });
      return;
    }
    if (mode === 'approval') {
      send({
        jsonrpc: '2.0',
        method: 'approval/requested',
        params: {
          approvalId: 'approval-1',
          availableChoices: [
            { choiceId: 'once', decision: 'approved', label: 'Allow once', scope: 'once' },
            { choiceId: 'deny', decision: 'denied', label: 'Reject', scope: 'once' },
            { choiceId: 'abort', decision: 'abort', label: 'Stop', scope: 'once' },
          ],
          currentRequirementId: { approvalId: 'approval-1', sourceIndex: 0 },
          itemId: 'tool-1',
          judgeEscalated: false,
          protectedWrite: false,
          rawArgs: '{"command":"echo hello"}',
          sessionId,
          sourceRange: sourceRange(),
          subject: { kind: 'shell', command: 'echo hello' },
          taskId: 'task-1',
          toolCallId: 'call-1',
          toolName: 'shell',
          turnId,
          viewCursor: nextCursor(),
        },
      });
      return;
    }
    completeTurn(sessionId, turnId);
  }
});

function completeTurn(sessionId, turnId) {
  const itemId = 'msg-1';
  const started = {
    jsonrpc: '2.0',
    method: 'item/started',
    params: {
      sessionId,
      viewCursor: nextCursor(),
      item: { itemId, kind: 'agentMessage', revision: 1, status: 'inProgress', turnId, text: '' },
    },
  };
  const delta = {
    jsonrpc: '2.0',
    method: 'item/delta',
    params: { sessionId, itemId, delta: 'Done', viewCursor: nextCursor() },
  };
  if (mode === 'delta-first') {
    send(delta);
    send(started);
  } else {
    send(started);
    send(delta);
  }
  send({
    jsonrpc: '2.0',
    method: 'item/completed',
    params: {
      sessionId,
      viewCursor: nextCursor(),
      sourceRange: sourceRange(),
      item: { itemId, kind: 'agentMessage', revision: 2, status: 'completed', turnId, text: 'Done' },
    },
  });
  send({ jsonrpc: '2.0', method: 'session/contextUsage', params: {
    sessionId, viewCursor: nextCursor(), sourceRange: sourceRange(),
    usedTokens: 250, windowTokens: 1000, pressure: 'normal',
  } });
  send({
    jsonrpc: '2.0',
    method: 'turn/completed',
    params: {
      sessionId,
      turnId,
      terminal: 'completed',
      viewCursor: nextCursor(),
      sourceRange: sourceRange(),
    },
  });
}
`,
    { mode: 0o700 },
  );
  return {
    cwd,
    binaryPath,
    timeoutMs: 2_000,
    idleTimeoutMs: 30 * 60_000,
    environment: {
      FIXTURE_MODE: mode,
      MUSE_FINGERPRINT: EXPECTED_SCHEMA_FINGERPRINT,
    },
  };
}

function handlers(
  overrides: Partial<Parameters<MuseTurnRuntime['executeTurn']>[1]> = {},
) {
  return {
    onProviderThread() {},
    onProviderTurn() {},
    onEvent() {},
    async requestApproval() {
      return 'cancel' as const;
    },
    ...overrides,
  };
}

void test('discovers Muse models from a controlled MSP host', async (context) => {
  const options = await fixture(context);
  const discovery = new MuseDiscovery({
    binaryPath: options.binaryPath,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    environment: options.environment,
  });
  const snapshot = await discovery.probe();
  assert.equal(snapshot.health, 'ready');
  assert.equal(snapshot.version, '1.0.3');
  assert.equal(snapshot.models[0]?.id, 'muse-spark-1.3');
});

void test('completes a Muse turn through the SDK facade', async (context) => {
  const options = await fixture(context);
  const runtime = new MuseTurnRuntime({
    binaryPath: options.binaryPath,
    timeoutMs: options.timeoutMs,
    environment: options.environment,
  });
  context.after(() => runtime.close());
  const events: string[] = [];
  const result = await runtime.executeTurn(
    {
      taskId: 'task',
      cwd: options.cwd,
      prompt: 'hello',
      model: 'muse-spark-1.3',
    },
    handlers({
      onEvent(event) {
        events.push(event.type);
      },
    }),
  );
  assert.equal(result.status, 'completed');
  assert.ok(events.includes('agent.message.delta'));
  assert.ok(events.includes('agent.message.completed'));
  assert.ok(events.includes('context.updated'));
});

void test('interrupt works during initialization and shutdown waits for execution', async (context) => {
  const options = await fixture(context, 'hang');
  const runtime = new MuseTurnRuntime({
    binaryPath: options.binaryPath,
    timeoutMs: options.timeoutMs,
    environment: options.environment,
  });
  const job = runtime.executeTurn(
    { taskId: 'task', cwd: options.cwd, prompt: 'test' },
    handlers(),
  );
  assert.equal(await runtime.interrupt('task'), true);
  await runtime.close();
  const result = await job;
  assert.equal(result.status, 'interrupted');
});

void test('maps Muse approvals onto Webcode decisions', async (context) => {
  const options = await fixture(context, 'approval');
  const runtime = new MuseTurnRuntime({
    binaryPath: options.binaryPath,
    timeoutMs: options.timeoutMs,
    environment: options.environment,
  });
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
    providerId: 'muse',
  });
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
    .approvals.find((item) => item.status === 'pending')!;
  assert.ok(approval);
  assert.equal(approval.kind, 'command');
  service.resolveApproval(approval.id, 'accept');
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
});

void test('rejects ephemeral Muse hosts and mismatched workspaces', async (context) => {
  const ephemeral = await fixture(context, 'ephemeral');
  const runtime = new MuseTurnRuntime({
    binaryPath: ephemeral.binaryPath,
    timeoutMs: ephemeral.timeoutMs,
    environment: ephemeral.environment,
  });
  context.after(() => runtime.close());
  const lost = await runtime.executeTurn(
    { taskId: 'task', cwd: ephemeral.cwd, prompt: 'hello' },
    handlers(),
  );
  assert.equal(lost.status, 'failed');
  assert.match(lost.error ?? '', /durable/);

  const mismatched = await fixture(context, 'wrong-root');
  const other = new MuseTurnRuntime({
    binaryPath: mismatched.binaryPath,
    timeoutMs: mismatched.timeoutMs,
    environment: mismatched.environment,
  });
  context.after(() => other.close());
  const result = await other.executeTurn(
    { taskId: 'task-2', cwd: mismatched.cwd, prompt: 'hello' },
    handlers(),
  );
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /workspace/);
});

void test('delivers native images and a filesystem manifest to Muse', async (context) => {
  const options = await fixture(context, 'attachments');
  const imagePath = join(options.cwd, 'image.png');
  await writeFile(imagePath, 'image-fixture');
  await writeFile(join(options.cwd, 'document.txt'), 'notes');
  const runtime = new MuseTurnRuntime({
    binaryPath: options.binaryPath,
    timeoutMs: options.timeoutMs,
    environment: options.environment,
  });
  context.after(() => runtime.close());
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
          size: 5,
          state: 'ready',
          path: join(options.cwd, 'document.txt'),
        },
      ],
    },
    handlers(),
  );
  assert.equal(result.status, 'completed');
});

void test('idle watchdog ends a live process that never completes its turn', async (context) => {
  const options = await fixture(context, 'silent-turn');
  const runtime = new MuseTurnRuntime({
    binaryPath: options.binaryPath,
    timeoutMs: options.timeoutMs,
    idleTimeoutMs: 400,
    environment: options.environment,
  });
  context.after(() => runtime.close());
  const result = await runtime.executeTurn(
    { taskId: 'task', cwd: options.cwd, prompt: 'hello' },
    handlers(),
  );
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /stopped responding|timed out|abort/i);
});

void test('streams deltas that arrive before their item', async (context) => {
  const options = await fixture(context, 'delta-first');
  const runtime = new MuseTurnRuntime({
    binaryPath: options.binaryPath,
    timeoutMs: options.timeoutMs,
    environment: options.environment,
  });
  context.after(() => runtime.close());
  const events: string[] = [];
  const result = await runtime.executeTurn(
    { taskId: 'task', cwd: options.cwd, prompt: 'hello' },
    handlers({
      onEvent(event) {
        events.push(event.type);
      },
    }),
  );
  assert.equal(result.status, 'completed');
  assert.ok(events.includes('agent.message.delta'));
  assert.ok(events.includes('agent.message.completed'));
});

void test('declines unsupported Muse user prompts and still completes', async (context) => {
  const options = await fixture(context, 'user-input');
  const runtime = new MuseTurnRuntime({
    binaryPath: options.binaryPath,
    timeoutMs: options.timeoutMs,
    environment: options.environment,
  });
  context.after(() => runtime.close());
  const events: string[] = [];
  const result = await runtime.executeTurn(
    { taskId: 'task', cwd: options.cwd, prompt: 'hello' },
    handlers({
      onEvent(event) {
        events.push(event.type);
      },
    }),
  );
  assert.equal(result.status, 'completed');
  assert.ok(events.includes('runtime.warning'));
});

void test('rejects empty prompts and oversized images without spawning a turn', async (context) => {
  const options = await fixture(context);
  const runtime = new MuseTurnRuntime({
    binaryPath: options.binaryPath,
    timeoutMs: options.timeoutMs,
    environment: options.environment,
  });
  context.after(() => runtime.close());
  const empty = await runtime.executeTurn(
    { taskId: 'empty', cwd: options.cwd, prompt: '   ' },
    handlers(),
  );
  assert.equal(empty.status, 'failed');
  assert.match(empty.error ?? '', /prompt or attachment/);

  const imagePath = join(options.cwd, 'huge.png');
  await writeFile(imagePath, 'tiny');
  const huge = await runtime.executeTurn(
    {
      taskId: 'huge',
      cwd: options.cwd,
      prompt: 'look',
      attachments: [
        {
          id: 'image',
          name: 'huge.png',
          mime: 'image/png',
          size: MAX_MUSE_IMAGE_BYTES + 1,
          state: 'ready',
          path: imagePath,
        },
      ],
    },
    handlers(),
  );
  assert.equal(huge.status, 'failed');
  assert.match(huge.error ?? '', /5 MB/);
});

void test('interrupts a running Muse turn and rejects work after close', async (context) => {
  const options = await fixture(context, 'silent-turn');
  const runtime = new MuseTurnRuntime({
    binaryPath: options.binaryPath,
    timeoutMs: options.timeoutMs,
    environment: options.environment,
  });
  const job = runtime.executeTurn(
    { taskId: 'task', cwd: options.cwd, prompt: 'hello' },
    handlers(),
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(await runtime.interrupt('task'), true);
  const result = await job;
  assert.equal(result.status, 'interrupted');
  await runtime.close();
  await assert.rejects(
    runtime.executeTurn(
      { taskId: 'later', cwd: options.cwd, prompt: 'hello' },
      handlers(),
    ),
    /closed/,
  );
});

void test('fails promptly when Muse never acknowledges an unsupported question', { timeout: 10_000 }, async (context) => {
  const options = await fixture(context, 'user-input-hang');
  const runtime = new MuseTurnRuntime({ ...options, timeoutMs: 500 });
  context.after(() => runtime.close());
  const result = await runtime.executeTurn(
    { taskId: 'question', cwd: options.cwd, prompt: 'hello' },
    handlers(),
  );
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /could not dismiss an unsupported question/);
});

void test('bounds startup after a successful handshake', { timeout: 10_000 }, async (context) => {
  const options = await fixture(context, 'model-hang');
  const runtime = new MuseTurnRuntime({ ...options, timeoutMs: 500 });
  context.after(() => runtime.close());
  const result = await runtime.executeTurn(
    { taskId: 'startup', cwd: options.cwd, prompt: 'hello', model: 'muse-spark-1.3' },
    handlers(),
  );
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /startup timed out/);
});

void test('Stop settles even when Muse acknowledges without completing', { timeout: 10_000 }, async (context) => {
  const options = await fixture(context, 'interrupt-ack-only');
  const runtime = new MuseTurnRuntime(options);
  context.after(() => runtime.close());
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const job = runtime.executeTurn(
    { taskId: 'stop', cwd: options.cwd, prompt: 'hello' },
    handlers({ onProviderTurn: started }),
  );
  await ready;
  await runtime.interrupt('stop');
  assert.equal((await job).status, 'interrupted');
});

void test('unanswered approvals fail instead of holding the turn forever', { timeout: 10_000 }, async (context) => {
  const options = await fixture(context, 'approval');
  const runtime = new MuseTurnRuntime({ ...options, approvalTimeoutMs: 300 });
  context.after(() => runtime.close());
  const result = await runtime.executeTurn(
    { taskId: 'approval-stall', cwd: options.cwd, prompt: 'hello' },
    handlers({
      requestApproval: () => new Promise<never>(() => {}),
    }),
  );
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /approval timed out/);
});

void test('absolute turn timeout caps a trickling host', { timeout: 10_000 }, async (context) => {
  const options = await fixture(context, 'silent-turn');
  const runtime = new MuseTurnRuntime({
    ...options,
    idleTimeoutMs: 60_000,
    turnTimeoutMs: 300,
  });
  context.after(() => runtime.close());
  const result = await runtime.executeTurn(
    { taskId: 'absolute-cap', cwd: options.cwd, prompt: 'hello' },
    handlers(),
  );
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /time limit/);
});
