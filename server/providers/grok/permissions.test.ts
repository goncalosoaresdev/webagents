import assert from 'node:assert/strict';
import test from 'node:test';
import {
  grokAgentArguments,
  grokSandbox,
  grokSessionMeta,
} from './permissions.ts';

void test('permission modes map to distinct Grok sandbox and session flags', () => {
  assert.deepEqual(grokAgentArguments('read-only', '/project'), [
    '--no-auto-update',
    '--cwd',
    '/project',
    '--sandbox',
    'read-only',
    'agent',
    '--no-leader',
    'stdio',
  ]);
  assert.deepEqual(grokAgentArguments('workspace', '/project'), [
    '--no-auto-update',
    '--cwd',
    '/project',
    '--sandbox',
    'workspace',
    'agent',
    '--no-leader',
    'stdio',
  ]);
  assert.deepEqual(grokAgentArguments('full-access', '/project'), [
    '--no-auto-update',
    '--cwd',
    '/project',
    'agent',
    '--no-leader',
    'stdio',
  ]);
  assert.equal(grokSandbox('read-only'), 'read-only');
  assert.equal(grokSandbox('workspace'), 'workspace');
  assert.equal(grokSandbox('full-access'), 'off');
  assert.deepEqual(
    grokAgentArguments('workspace', '/project', {
      model: 'grok-4.6',
      reasoningEffort: 'high',
    }),
    [
      '--no-auto-update',
      '--cwd',
      '/project',
      '--sandbox',
      'workspace',
      'agent',
      '--no-leader',
      '--model',
      'grok-4.6',
      '--reasoning-effort',
      'high',
      'stdio',
    ],
  );
  assert.equal(grokSessionMeta('workspace'), undefined);
  assert.deepEqual(grokSessionMeta('full-access'), { yoloMode: true });
});
