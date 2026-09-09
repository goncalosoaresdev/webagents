import assert from 'node:assert/strict';
import test from 'node:test';
import { threadContext } from '../../lib/providers/context.ts';
import type { TaskEvent } from '../../lib/workspace/contracts.ts';
const event = (data: Record<string, unknown>): TaskEvent => ({
  sequence: 1,
  taskId: 'task',
  type: 'context.updated',
  data: { providerId: 'codex', ...data },
  createdAt: '',
});

void test('context follows latest occupancy including compaction, not cumulative usage', () => {
  assert.deepEqual(
    threadContext(
      [
        event({ usedTokens: 900, windowTokens: 1000 }),
        event({ usedTokens: 200, windowTokens: 1000 }),
      ],
      'codex',
    ),
    { used: 200, window: 1000, percent: 20 },
  );
});
void test('unknown or invalid values never imply an empty context window', () => {
  assert.equal(threadContext([], 'codex'), null);
  for (const usedTokens of [-1, NaN, Infinity, '100'])
    assert.equal(
      threadContext([event({ usedTokens, windowTokens: 1000 })], 'codex'),
      null,
    );
  assert.deepEqual(
    threadContext([event({ usedTokens: 100, windowTokens: null })], 'codex'),
    { used: 100, window: null, percent: null },
  );
});
void test('provider and worker sessions do not contaminate thread context', () => {
  assert.equal(
    threadContext([event({ usedTokens: 100, windowTokens: 1000 })], 'muse'),
    null,
  );
  assert.equal(
    threadContext(
      [event({ usedTokens: 100, windowTokens: 1000, executionId: 'worker' })],
      'codex',
    ),
    null,
  );
  assert.equal(
    threadContext([event({ usedTokens: 1200, windowTokens: 1000 })], 'codex')
      ?.percent,
    100,
  );
});
