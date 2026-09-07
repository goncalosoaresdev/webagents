import { ProviderInstallations } from '../core/provider-installations.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { WebcodeApi } from '../../lib/api/client.ts';
import type { ProviderDiscovery } from '../../lib/providers/contracts.ts';
import { buildApp } from '../app.ts';
import type { ServerConfig } from '../config.ts';
import { ProviderRegistry } from '../core/provider-registry.ts';
import { InMemoryTicketStore } from '../security/websocket-tickets.ts';

const config: ServerConfig = {
  environment: 'test',
  host: '127.0.0.1',
  port: 8787,
  allowedOrigins: new Set(['https://webcode.example.com']),
  workspaceRoot: '/tmp',
  dataDirectory: '/tmp/webcode-test-data',
  providerCacheTtlMs: 30_000,
  providerProbeTimeoutMs: 1_000,
  websocketTicketTtlMs: 30_000,
  codex: { binaryPath: 'codex' },
  muse: { binaryPath: 'muse' },
  grok: { binaryPath: 'grok' },
  logLevel: 'silent',
};

function createDependencies() {
  const provider: ProviderDiscovery = {
    id: 'fixture',
    probe: async () => ({
      providerId: 'fixture',
      health: 'ready',
      models: [],
      checkedAt: new Date().toISOString(),
    }),
  };
  return {
    config,
    providers: new ProviderRegistry([provider], {
      cacheTtlMs: 30_000,
      probeTimeoutMs: 1_000,
    }),
    tickets: new InMemoryTicketStore({ ttlMs: 30_000 }),
  };
}

void test('exposes health and provider APIs during the pre-auth phase', async (context) => {
  const app = await buildApp(createDependencies());
  context.after(() => app.close());

  const health = await app.inject({ method: 'GET', url: '/healthz' });
  const providers = await app.inject({
    method: 'GET',
    url: '/api/v1/providers',
  });

  assert.equal(health.statusCode, 200);
  assert.equal(providers.statusCode, 200);
  assert.equal(providers.json().data[0].providerId, 'fixture');
});

void test('issues single-use websocket tickets', async (context) => {
  const dependencies = createDependencies();
  const app = await buildApp(dependencies);
  context.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/websocket-ticket',
    headers: {
      origin: 'https://webcode.example.com',
    },
  });
  assert.equal(response.statusCode, 200);
  const ticket = response.json().data.token as string;
  assert.equal(dependencies.tickets.consume(ticket), true);
  assert.equal(dependencies.tickets.consume(ticket), false);
});

void test('returns a stable error for unknown provider refreshes', async (context) => {
  const app = await buildApp(createDependencies());
  context.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/providers/missing/refresh',
  });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, 'provider_not_found');
});

void test('protects API and ticket issuance with authentication', async (context) => {
  const dependencies = createDependencies();
  const token = 'fixture-token-'.repeat(4);
  const app = await buildApp({
    ...dependencies,
    config: { ...config, authToken: token },
  });
  context.after(() => app.close());
  for (const [method, url] of [
    ['GET', '/api/v1/providers'],
    ['POST', '/api/v1/auth/websocket-ticket'],
  ] as const) {
    assert.equal((await app.inject({ method, url })).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          method,
          url,
          headers: { authorization: 'Bearer wrong' },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method,
          url,
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method,
          url,
          headers: {
            authorization: `Bearer ${token}`,
            origin: 'https://untrusted.example',
          },
        })
      ).statusCode,
      403,
    );
  }
  assert.equal(
    (await app.inject({ method: 'GET', url: '/healthz' })).statusCode,
    200,
  );
});

void test('provider installation endpoints authenticate and start a server-owned update', async (context) => {
  const dependencies = createDependencies();
  const token = 'fixture-token-'.repeat(4);
  let calls = 0;
  const installations = new ProviderInstallations(
    new Map([
      [
        'fixture',
        {
          name: 'Fixture',
          driver: {
            inspect: async () => ({ version: '1.0.0', canUpdate: true }),
            latest: async () => '1.1.0',
            update: async () => {
              calls++;
            },
          },
        },
      ],
    ]),
    dependencies.providers,
    () => false,
  );
  const app = await buildApp({
    ...dependencies,
    installations,
    config: { ...config, authToken: token },
  });
  context.after(() => app.close());
  for (const [method, url] of [
    ['GET', '/api/v1/provider-installations'],
    ['POST', '/api/v1/providers/fixture/installation/check'],
    ['POST', '/api/v1/providers/fixture/installation/update'],
  ] as const) {
    assert.equal((await app.inject({ method, url })).statusCode, 401);
  }
  assert.equal(calls, 0);
  const headers = { authorization: `Bearer ${token}` };
  const state = await app.inject({
    method: 'GET',
    url: '/api/v1/provider-installations',
    headers,
  });
  assert.equal(state.json().data[0].updateAvailable, true);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/providers/missing/installation/check',
        headers,
      })
    ).statusCode,
    404,
  );
  const update = await app.inject({
    method: 'POST',
    url: '/api/v1/providers/fixture/installation/update',
    headers,
  });
  assert.equal(update.statusCode, 202);
  assert.equal(calls, 1);
});

void test('terminal APIs require auth and websocket tickets cannot cross origins or be reused', async (context) => {
  const { TerminalService } = await import('../terminal/service.ts');
  const terminals = new TerminalService(
    () => '/tmp',
    () =>
      ({
        onData() {
          return { dispose() {} };
        },
        onExit() {
          return { dispose() {} };
        },
        write() {},
        resize() {},
        kill() {},
        pause() {},
        resume() {},
      }) as unknown as import('node-pty').IPty,
  );
  const token = 'terminal-token-'.repeat(4);
  const app = await buildApp({
    ...createDependencies(),
    terminals,
    config: { ...config, authToken: token },
  });
  context.after(() => app.close());
  const projectId = crypto.randomUUID(),
    id = crypto.randomUUID();
  const headers = { authorization: `Bearer ${token}` };
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/terminals',
        payload: { projectId, id },
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/terminals',
        payload: { projectId, id },
        headers,
      })
    ).statusCode,
    200,
  );
  const ticket = await app.inject({
    method: 'POST',
    url: `/api/v1/terminals/${id}/ticket`,
    headers,
  });
  const url = `/terminal-ws?id=${id}&ticket=${ticket.json().data.token}`;
  await assert.rejects(
    app.injectWS(url, {
      socket: { remoteAddress: '127.0.0.1' } as import('node:net').Socket,
      headers: { origin: 'https://other.example' },
    }),
    /401/,
  );
  const ws = await app.injectWS(url, {
    socket: { remoteAddress: '127.0.0.1' } as import('node:net').Socket,
    headers: { origin: 'https://webcode.example.com' },
  });
  const first = await new Promise<string>((resolve) =>
    ws.once('message', (data: Buffer) => resolve(data.toString())),
  );
  assert.equal(JSON.parse(first).type, 'snapshot');
  const resized = new Promise<string>((resolve) =>
    ws.once('message', (data: Buffer) => resolve(data.toString())),
  );
  ws.send(JSON.stringify({ type: 'resize', cols: 105, rows: 15 }));
  assert.deepEqual(JSON.parse(await resized), {
    type: 'resize',
    cols: 105,
    rows: 15,
  });
  assert.equal(
    ws.readyState,
    1,
    'Normal initial sizing keeps the connection open',
  );
  ws.terminate();
  await assert.rejects(
    app.injectWS(url, {
      socket: { remoteAddress: '127.0.0.1' } as import('node:net').Socket,
      headers: { origin: 'https://webcode.example.com' },
    }),
    /401/,
  );
  assert.equal(
    terminals.list(projectId).length,
    1,
    'Disconnect does not remove terminal',
  );
  // Exercise the real browser client's headers, not only a hand-built request.
  context.mock.method(
    globalThis,
    'fetch',
    async (url: string, init: RequestInit) => {
      const response = await app.inject({
        method: 'DELETE',
        url,
        headers: Object.fromEntries(new Headers(init.headers).entries()),
        ...(typeof init.body === 'string' ? { payload: init.body } : {}),
      });
      return new Response(response.body, { status: response.statusCode });
    },
  );
  const api = new WebcodeApi();
  api.setToken(token);
  assert.deepEqual(await api.endTerminal(id), { ended: true });
  assert.equal(terminals.list(projectId).length, 0);
});
