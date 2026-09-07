import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ProviderDiscovery,
  ProviderSnapshot,
} from '../../lib/providers/contracts.ts';
import {
  ProviderNotFoundError,
  ProviderRegistry,
} from './provider-registry.ts';

const NOW = Date.parse('2026-09-04T12:00:00.000Z');

function readySnapshot(providerId: string): ProviderSnapshot {
  return {
    providerId,
    health: 'ready',
    models: [],
    checkedAt: new Date(NOW).toISOString(),
  };
}

void test('deduplicates concurrent probes and serves a fresh cached snapshot', async () => {
  let calls = 0;
  const provider: ProviderDiscovery = {
    id: 'fixture',
    async probe() {
      calls += 1;
      await Promise.resolve();
      return readySnapshot('fixture');
    },
  };
  const registry = new ProviderRegistry([provider], {
    cacheTtlMs: 30_000,
    probeTimeoutMs: 1_000,
    now: () => NOW,
  });

  const [first, second] = await Promise.all([
    registry.probe('fixture'),
    registry.probe('fixture'),
  ]);
  const cached = await registry.probe('fixture');

  assert.equal(calls, 1);
  assert.equal(first, second);
  assert.equal(cached, first);
});

void test('normalizes a rejected provider probe and continues serving other providers', async () => {
  const registry = new ProviderRegistry(
    [
      {
        id: 'broken',
        probe: async () => {
          throw new Error('fixture failed');
        },
      },
      { id: 'ready', probe: async () => readySnapshot('ready') },
    ],
    { cacheTtlMs: 30_000, probeTimeoutMs: 1_000, now: () => NOW },
  );

  const snapshots = await registry.list();

  assert.deepEqual(
    snapshots.map(({ providerId, health }) => ({ providerId, health })),
    [
      { providerId: 'broken', health: 'unavailable' },
      { providerId: 'ready', health: 'ready' },
    ],
  );
  assert.equal(snapshots[0]?.message, 'fixture failed');
});

void test('rejects duplicate and unknown provider identifiers', async () => {
  const fixture: ProviderDiscovery = {
    id: 'fixture',
    probe: async () => readySnapshot('fixture'),
  };
  assert.throws(
    () =>
      new ProviderRegistry([fixture, fixture], {
        cacheTtlMs: 1_000,
        probeTimeoutMs: 1_000,
      }),
    /Duplicate provider id/,
  );
  const registry = new ProviderRegistry([fixture], {
    cacheTtlMs: 1_000,
    probeTimeoutMs: 1_000,
  });
  await assert.rejects(() => registry.probe('missing'), ProviderNotFoundError);
});

void test('enforces the timeout even when an adapter ignores cancellation', async () => {
  const registry = new ProviderRegistry(
    [{ id: 'stuck', probe: () => new Promise(() => undefined) }],
    { cacheTtlMs: 1_000, probeTimeoutMs: 10 },
  );

  const snapshot = await registry.probe('stuck');

  assert.equal(snapshot.health, 'unavailable');
  assert.equal(snapshot.message, 'Provider probe timed out');
});

void test('cancels active provider work during shutdown', async () => {
  let aborted = false;
  const registry = new ProviderRegistry(
    [
      {
        id: 'active',
        probe: (signal) =>
          new Promise((_, reject) => {
            signal?.addEventListener(
              'abort',
              () => {
                aborted = true;
                reject(signal.reason);
              },
              { once: true },
            );
          }),
      },
    ],
    { cacheTtlMs: 1_000, probeTimeoutMs: 1_000 },
  );
  const probe = registry.probe('active');

  await registry.close();
  await probe;

  assert.equal(aborted, true);
  await assert.rejects(() => registry.probe('active'), /registry is closed/);
});
