import test from 'node:test';
import assert from 'node:assert/strict';
import { codexPermissions } from './permissions.ts';
void test('permission modes map to distinct enforced Codex policies', () => {
  assert.deepEqual(codexPermissions('read-only', '/project'), { approvalPolicy: 'never', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } });
  const workspace = codexPermissions('workspace', '/project');
  assert.equal(workspace.approvalPolicy, 'on-request');
  assert.equal(workspace.sandboxPolicy.type, 'workspaceWrite');
  assert.deepEqual(codexPermissions('full-access', '/project'), { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } });
});
