import type { PermissionMode } from '../../../lib/workspace/permissions.ts';
import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
  CodexSandboxPolicy,
} from './protocol.ts';

export function codexPermissions(
  mode: PermissionMode,
  cwd: string,
): {
  approvalPolicy: CodexApprovalPolicy;
  sandbox: CodexSandboxMode;
  sandboxPolicy: CodexSandboxPolicy;
} {
  switch (mode) {
    case 'read-only':
      return {
        approvalPolicy: 'never',
        sandbox: 'read-only',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
      };
    case 'full-access':
      return {
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        sandboxPolicy: { type: 'dangerFullAccess' },
      };
    case 'workspace':
      return {
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: [cwd],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      };
    default:
      throw new Error('Unsupported permission mode.');
  }
}
