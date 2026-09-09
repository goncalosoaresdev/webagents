import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { CodexAppServerClient } from './json-rpc-client.ts';
import { CodexTurnRuntime } from './turn-runtime.ts';
import { AgentService } from '../../core/agent-service.ts';
import { SqliteWorkspaceStore } from '../../storage/sqlite-workspace-store.ts';
import { ConnectionHub } from '../../realtime/connection-hub.ts';

async function fixture(context: TestContext, mode = 'normal') {
  const cwd = await mkdtemp(join(tmpdir(), 'webcode-rpc-'));
  context.after(() => rm(cwd, { recursive: true, force: true }));
  const binaryPath = join(cwd, 'codex-fixture');
  await writeFile(
    binaryPath,
    `#!${process.execPath}
const readline = require('node:readline');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const mode = process.env.FIXTURE_MODE;
setInterval(() => {}, 1000);
readline.createInterface({input: process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') {
    if (mode === 'hang') return;
    if (mode === 'oversized') { process.stdout.write('x'.repeat(2 * 1024 * 1024 + 1)); return; }
    if (mode === 'malformed') { process.stdout.write('invalid-json\\n'); return; }
    if (mode === 'exit') { process.exit(1); }
    send({id:m.id,result:{userAgent:'Codex/fixture'}});
  } else if (m.method === 'model/list') {
    send({id:m.id,result:{data:[{model:'fixture',isDefault:true,inputModalities:['text','image']}],nextCursor:null}});
  } else if (m.method === 'thread/start' || m.method === 'thread/resume') {
    send({id:m.id,result:{thread:{id:'thread'}}});
  } else if (m.method === 'turn/start') {
    if (mode === 'attachments' && (!m.params.input.some(i => i.type === 'localImage' && require('node:fs').readFileSync(i.path, 'utf8') === 'image-fixture') || !m.params.input.some(i => i.type === 'text' && i.text.includes('document.txt')))) { send({id:m.id,error:{code:-1,message:'Attachment inputs missing'}}); return; }
    send({id:m.id,result:{turn:{id:'turn'}}});
    if (mode === 'silent-turn') return;
    if (mode === 'bad-event') { send({method:'item/agentMessage/delta',params:{itemId:5,delta:8}}); return; }
    send({id:0,method:'item/commandExecution/requestApproval',params:{threadId:'thread',turnId:'turn',itemId:'command',command:'echo hello'}});
  } else if (m.id === 0 && m.result) {
    send({method:'thread/tokenUsage/updated',params:{threadId:'thread',turnId:'turn',tokenUsage:{last:{totalTokens:1234},total:{totalTokens:99999},modelContextWindow:10000}}});
    send({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{id:'answer',type:'agentMessage',text:'Done'}}});
    send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}});
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
    const client = await CodexAppServerClient.start(
      await fixture(context, mode),
    );
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
      client.request('account/read', {}),
      /closed|oversized|JSON|protocol/,
    );
  });
}
void test('request timeout and repeated close settle without pending processes', async (context) => {
  const client = await CodexAppServerClient.start(
    await fixture(context, 'hang'),
  );
  await assert.rejects(client.initialize(), /timed out/);
  const first = client.close();
  assert.equal(first, client.close());
  await first;
});
void test('interrupt works during initialization and shutdown waits for execution', async (context) => {
  const runtime = new CodexTurnRuntime(await fixture(context, 'hang'));
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
  const rejected = assert.rejects(job);
  assert.equal(await runtime.interrupt('task'), true);
  await runtime.close();
  await rejected;
});
void test('two real subprocess turns can reuse native approval IDs', async (context) => {
  const options = await fixture(context);
  const runtime = new CodexTurnRuntime(options);
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
    providerId: 'codex',
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
});

void test('idle watchdog ends a live process that never completes its turn', async (context) => {
  const options = await fixture(context, 'silent-turn');
  const runtime = new CodexTurnRuntime({
    ...options,
    requestTimeoutMs: 1000,
    idleTimeoutMs: 500,
  });
  context.after(() => runtime.close());
  await assert.rejects(
    runtime.executeTurn(
      { taskId: 'task', cwd: options.cwd, prompt: 'hello' },
      {
        onProviderThread() {},
        onProviderTurn() {},
        onEvent() {},
        async requestApproval() {
          return 'cancel';
        },
      },
    ),
    /exited|closed/,
  );
});
void test('malformed supported notification fails only its execution', async (context) => {
  const options = await fixture(context, 'bad-event');
  const runtime = new CodexTurnRuntime(options);
  context.after(() => runtime.close());
  await assert.rejects(
    runtime.executeTurn(
      { taskId: 'task', cwd: options.cwd, prompt: 'hello' },
      {
        onProviderThread() {},
        onProviderTurn() {},
        onEvent() {},
        async requestApproval() {
          return 'cancel';
        },
      },
    ),
  );
});

void test('delivers native local images and a filesystem manifest without base64', async (context) => {
  const options = await fixture(context, 'attachments');
  const imagePath = join(options.cwd, 'image');
  await writeFile(imagePath, 'image-fixture');
  const runtime = new CodexTurnRuntime(options);
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
          size: 1,
          state: 'ready',
          path: join(options.cwd, 'doc'),
        },
      ],
    },
    {
      onProviderThread() {},
      onProviderTurn() {},
      onEvent() {},
      async requestApproval() {
        return 'accept';
      },
    },
  );
  assert.equal(result.status, 'completed');
});

void test('captures provider context occupancy instead of cumulative tokens', async (context) => {
  const options = await fixture(context);
  const runtime = new CodexTurnRuntime(options);
  context.after(() => runtime.close());
  const reports: unknown[] = [];
  await runtime.executeTurn(
    { taskId: 'task', cwd: options.cwd, prompt: 'hello' },
    {
      onProviderThread() {},
      onProviderTurn() {},
      onEvent(event) {
        if (event.type === 'context.updated') reports.push(event.data);
      },
      async requestApproval() {
        return 'accept';
      },
    },
  );
  assert.deepEqual(reports, [
    { providerId: 'codex', usedTokens: 1234, windowTokens: 10000 },
  ]);
});
