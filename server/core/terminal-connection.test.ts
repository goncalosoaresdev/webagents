import test from 'node:test';
import assert from 'node:assert/strict';
import {
  terminalDimensions,
  terminalCloseMessage,
} from '../../lib/workspace/terminal-connection.ts';
void test('unmeasured or hidden dock geometry is never sent as a resize', () => {
  for (const size of [
    undefined,
    { cols: NaN, rows: 20 },
    { cols: 80, rows: NaN },
    { cols: Infinity, rows: 20 },
    { cols: 0, rows: 0 },
  ])
    assert.equal(terminalDimensions(size), undefined);
  assert.deepEqual(terminalDimensions({ cols: 103.5, rows: 26.1 }), {
    cols: 103,
    rows: 26,
  });
  assert.deepEqual(terminalDimensions({ cols: 999, rows: 1 }), {
    cols: 300,
    rows: 5,
  });
});
void test('permanent rejections surface a useful status instead of reconnecting forever', () => {
  assert.match(terminalCloseMessage(1008)!, /rejected/);
  assert.match(terminalCloseMessage(1009)!, /limit/);
  assert.equal(terminalCloseMessage(1006), undefined);
  assert.equal(terminalCloseMessage(1013), undefined);
});
