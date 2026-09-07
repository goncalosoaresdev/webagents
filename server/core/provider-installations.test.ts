import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderInstallations } from './provider-installations.ts';
import { ProviderRegistry } from './provider-registry.ts';
import {
  isNewerVersion,
  stableVersion,
  type InstallationDriver,
} from './installation-driver.ts';
function fixture(overrides: Partial<InstallationDriver> = {}, busy = false) {
  const providers = new ProviderRegistry(
    [
      {
        id: 'codex',
        probe: async () => ({
          providerId: 'codex',
          health: 'ready',
          models: [],
          checkedAt: new Date().toISOString(),
        }),
      },
    ],
    { cacheTtlMs: 60000, probeTimeoutMs: 1000 },
  );
  return new ProviderInstallations(
    new Map([
      [
        'codex',
        {
          name: 'Codex',
          driver: {
            inspect: async () => ({ version: '1.2.0', canUpdate: true }),
            latest: async () => '1.10.0',
            update: async () => {},
            ...overrides,
          },
        },
      ],
    ]),
    providers,
    () => busy,
  );
}
void test('release comparison is numeric and rejects non-stable versions', () => {
  assert.equal(isNewerVersion('1.9.0', '1.10.0'), true);
  assert.equal(isNewerVersion('2.0.0', '1.10.0'), false);
  assert.equal(isNewerVersion('1.10.0', '1.10.0'), false);
  assert.equal(isNewerVersion('1.10.0-beta', '1.10.0'), false);
  assert.equal(stableVersion('1.2.0; command'), false);
});
void test('installation reads coalesce and cache version checks', async () => {
  let calls = 0;
  const service = fixture({
    latest: async () => {
      calls++;
      return '1.10.0';
    },
  });
  const [a, b] = await Promise.all([
    service.read('codex'),
    service.read('codex'),
  ]);
  assert.equal(a, b);
  assert.equal(a.updateAvailable, true);
  await service.list();
  assert.equal(calls, 1);
  await service.close();
});
void test('failed release checks remain unknown and cannot trigger an update', async () => {
  const service = fixture({
    latest: async () => {
      throw new Error('Offline');
    },
  });
  const state = await service.read('codex');
  assert.equal(state.latestVersion, undefined);
  assert.equal(state.updateAvailable, false);
  assert.match(state.message!, /Could not check/);
  await assert.rejects(service.update('codex'), /No supported update/);
});
void test('running tasks and externally managed installs block updates', async () => {
  await assert.rejects(fixture({}, true).update('codex'), /running tasks/);
  await assert.rejects(
    fixture({
      inspect: async () => ({ version: '1.2.0', canUpdate: false }),
    }).update('codex'),
    /No supported update/,
  );
});
void test('updates coalesce, expose maintenance and finish independently of requests', async () => {
  let finish!: () => void,
    calls = 0;
  const wait = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const service = fixture({
    inspect: async () => ({
      version: calls ? '1.10.0' : '1.2.0',
      canUpdate: true,
    }),
    update: async (version) => {
      assert.equal(version, '1.10.0');
      calls++;
      await wait;
    },
  });
  const results = await Promise.all([
    service.update('codex'),
    service.update('codex'),
  ]);
  assert.equal(results[0].updateState, 'updating');
  assert.equal(calls, 1);
  assert.equal(service.isUpdating(), true);
  finish();
  await service.close();
  const state = await service.read('codex');
  assert.equal(state.updateState, 'succeeded');
  assert.equal(state.installedVersion, '1.10.0');
  assert.equal(service.isUpdating(), false);
});
void test('failed updates release maintenance and report failure without claiming success', async () => {
  const service = fixture({
    update: async () => {
      throw new Error('Private details');
    },
  });
  await service.update('codex');
  await service.close();
  const state = await service.read('codex');
  assert.equal(state.updateState, 'failed');
  assert.equal(state.installedVersion, '1.2.0');
  assert.equal(service.isUpdating(), false);
  assert.doesNotMatch(state.message!, /Private/);
});
