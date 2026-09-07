import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLimits } from './limits.ts';
import {
  resetLabel,
  tightestRemaining,
} from '../../../lib/providers/limits.ts';
const time = '2026-09-06T12:00:00.000Z';
void test('prefers bucket data, converts consumed percentages and preserves unknowns', () => {
  const value = parseLimits(
    {
      rateLimits: { primary: { usedPercent: 99 } },
      rateLimitsByLimitId: {
        codex: {
          primary: { usedPercent: 30, windowDurationMins: 300 },
          secondary: { usedPercent: null, windowDurationMins: 10080 },
        },
      },
    },
    time,
  );
  assert.equal(value.windows.length, 2);
  assert.equal(value.windows[0]?.remainingPercent, 70);
  assert.equal(value.windows[0]?.label, '5-hour window');
  assert.equal(value.windows[1]?.remainingPercent, null);
  assert.equal(value.windows[1]?.label, 'Weekly');
});
void test('handles legacy, malformed, over-limit, and unavailable payloads', () => {
  assert.equal(parseLimits(null, time).status, 'unavailable');
  assert.equal(
    parseLimits({ rateLimits: { primary: { usedPercent: '5' } } }, time)
      .windows[0]?.remainingPercent,
    null,
  );
  assert.equal(
    parseLimits({ rateLimits: { primary: { usedPercent: 120 } } }, time)
      .windows[0]?.remainingPercent,
    0,
  );
  assert.equal(
    parseLimits({ rateLimits: { primary: { usedPercent: -20 } } }, time)
      .windows[0]?.remainingPercent,
    100,
  );
});
void test('does not show stale or expired remaining allowance as current', () => {
  const value = parseLimits(
    {
      rateLimits: {
        primary: { usedPercent: 85, resetsAt: Date.parse(time) / 1000 + 60 },
      },
    },
    time,
  );
  assert.equal(tightestRemaining(value, Date.parse(time)), 15);
  assert.equal(tightestRemaining(value, Date.parse(time) + 61000), null);
  assert.equal(tightestRemaining(value, Date.parse(time) + 180000), null);
  assert.equal(resetLabel(null, 0), 'Reset time unavailable');
  assert.equal(resetLabel(3600, 0), 'Resets in 1h 0m');
});
