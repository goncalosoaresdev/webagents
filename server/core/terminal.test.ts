import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { IPty } from 'node-pty';
import { TerminalService } from '../terminal/service.ts';
import type { TerminalOutput } from '../../lib/workspace/terminal.ts';
function fixture() {
  let output!: (data: string) => void;
  let exit!: (value: { exitCode: number; signal?: number }) => void;
  let killed = 0;
  const inputs: string[] = [];
  const service = new TerminalService(
    () => '/tmp',
    () =>
      ({
        onData: (fn: (data: string) => void) => {
          output = fn;
          return { dispose() {} };
        },
        onExit: (
          fn: (event: { exitCode: number; signal?: number }) => void,
        ) => {
          exit = fn;
          return { dispose() {} };
        },
        write: (data: string) => inputs.push(data),
        resize() {},
        pause() {},
        resume() {},
        kill: () => {
          killed++;
        },
      }) as unknown as IPty,
  );
  const session = service.create('project', randomUUID());
  return {
    service,
    session,
    output: (data: string) => output(data),
    exit: () => exit({ exitCode: 0 }),
    inputs,
    killed: () => killed,
  };
}
function snapshot(service: TerminalService, id: string) {
  return new Promise<Extract<TerminalOutput, { type: 'snapshot' }>>(
    (resolve) => {
      const detach = service.attach(id, (event) => {
        if (event.type === 'snapshot') {
          detach();
          resolve(event);
        }
      });
    },
  );
}
void test('detached terminal preserves screen, background output and process identity', async () => {
  const f = fixture();
  f.output('before refresh\r\n');
  assert.match(
    (await snapshot(f.service, f.session.id)).data,
    /before refresh/,
  );
  assert.equal(f.killed(), 0);
  f.output('while disconnected\r\n');
  assert.match(
    (await snapshot(f.service, f.session.id)).data,
    /while disconnected/,
  );
  assert.equal(f.service.list('project')[0]!.id, f.session.id);
  f.service.write(f.session.id, 'pwd\r');
  assert.deepEqual(f.inputs, ['pwd\r']);
  f.service.close();
  assert.equal(f.killed(), 1);
});
void test('tickets are scoped, single-use, and invalid after explicit ending', () => {
  const f = fixture();
  const ticket = f.service.ticket(f.session.id);
  assert.equal(f.service.consumeTicket(ticket.token, 'other'), false);
  assert.equal(f.service.consumeTicket(ticket.token, f.session.id), false);
  const valid = f.service.ticket(f.session.id);
  assert.equal(f.service.consumeTicket(valid.token, f.session.id), true);
  assert.equal(f.service.consumeTicket(valid.token, f.session.id), false);
  const last = f.service.ticket(f.session.id);
  f.service.end(f.session.id);
  assert.equal(f.service.consumeTicket(last.token, f.session.id), false);
  assert.equal(f.service.list('project').length, 0);
});
void test('creation is idempotent and capped; exited sessions preserve final output', async () => {
  const f = fixture();
  assert.equal(f.service.create('project', f.session.id).id, f.session.id);
  f.output('final result');
  f.exit();
  assert.equal((await snapshot(f.service, f.session.id)).status, 'exited');
  assert.match((await snapshot(f.service, f.session.id)).data, /final result/);
  for (let i = 0; i < 3; i++) f.service.create('project', randomUUID());
  assert.throws(
    () => f.service.create('project', randomUUID()),
    /limit reached/,
  );
  f.service.close();
});
void test(
  'real shell remains alive while detached and retains shell variables',
  { timeout: 10000 },
  async () => {
    const service = new TerminalService(() => process.cwd());
    const session = service.create('project', randomUUID());
    try {
      service.write(
        session.id,
        "WEBCODE_TERMINAL_TEST=preserved; printf '\\nFIRST_READY\\n'\r",
      );
      async function waitFor(text: string) {
        for (let i = 0; i < 80; i++) {
          const state = await snapshot(service, session.id);
          if (state.data.includes(text)) return;
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        assert.fail(`Terminal output missing: ${text}`);
      }
      await waitFor('FIRST_READY');
      service.write(
        session.id,
        'printf \'\\nVALUE:%s\\n\' "$WEBCODE_TERMINAL_TEST"\r',
      );
      await waitFor('VALUE:preserved');
    } finally {
      service.close();
    }
  },
);

void test('replay represents the current screen rather than replaying erased output', async () => {
  const f = fixture();
  f.output('old screen\r\n\u001b[2J\u001b[Hcurrent screen');
  const state = await snapshot(f.service, f.session.id);
  assert.match(state.data, /current screen/);
  assert.doesNotMatch(state.data, /old screen/);
  f.service.close();
});
void test('pending attaches also count toward connection limits and can be cancelled', () => {
  const f = fixture();
  const detach = Array.from({ length: 4 }, () =>
    f.service.attach(f.session.id, () => {}),
  );
  assert.throws(() => f.service.attach(f.session.id, () => {}), /Too many/);
  detach[0]!();
  detach[0]!();
  f.service.attach(f.session.id, () => {})();
  for (const close of detach) close();
  f.service.close();
});
