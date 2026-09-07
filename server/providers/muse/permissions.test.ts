import assert from 'node:assert/strict';
import test from 'node:test';
import { museApprovalMode, museServeArguments } from './permissions.ts';

void test('permission modes map to distinct Muse serve flags and wire modes', () => {
  assert.deepEqual(museServeArguments('read-only'), [
    'serve',
    '--trust-workspace',
    '--disable-write',
    '--disable-shell',
    '--sandbox-network',
    'restricted',
  ]);
  assert.deepEqual(museServeArguments('workspace'), [
    'serve',
    '--trust-workspace',
  ]);
  assert.deepEqual(museServeArguments('full-access'), [
    'serve',
    '--trust-workspace',
    '--disable-sandbox',
  ]);
  assert.deepEqual(museServeArguments('workspace', { durable: false }), [
    'serve',
    '--no-session-log',
  ]);
  assert.equal(museApprovalMode('read-only'), 'denyUnmatched');
  assert.equal(museApprovalMode('workspace'), 'onRequest');
  assert.equal(museApprovalMode('full-access'), 'allowAll');
});
