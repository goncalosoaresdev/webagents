import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderLimitsService } from './provider-limits.ts';
void test('usage reads coalesce, cache and allow explicit refresh', async () => {
  let calls = 0;
  const service = new ProviderLimitsService(
    new Map([
      [
        'codex',
        async () => {
          calls++;
          return {
            providerId: 'codex',
            checkedAt: new Date().toISOString(),
            windows: [],
            status: 'unavailable' as const,
          };
        },
      ],
    ]),
  );
  await Promise.all([service.read('codex'), service.read('codex')]);
  assert.equal(calls, 1);
  await service.read('codex');
  assert.equal(calls, 1);
  await service.read('codex', true);
  assert.equal(calls, 2);
  await service.close();
});
void test('provider errors become unavailable and shutdown cancels pending reads', async () => {
  const service = new ProviderLimitsService(
    new Map([
      [
        'codex',
        async () => {
          throw new Error('private upstream details');
        },
      ],
    ]),
  );
  assert.equal((await service.read('codex')).status, 'unavailable');
  await service.close();
  const waiting = new ProviderLimitsService(
    new Map([
      [
        'codex',
        async (signal) =>
          new Promise<never>((_, reject) => {
            if (signal.aborted) reject(new Error('aborted'));
            else
              signal.addEventListener('abort', () =>
                reject(new Error('aborted')),
              );
          }),
      ],
    ]),
  );
  const result = waiting.read('codex');
  await waiting.close();
  assert.equal((await result).status, 'unavailable');
});
