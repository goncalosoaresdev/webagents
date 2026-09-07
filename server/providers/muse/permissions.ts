import type { StartSessionOptions } from '@muse-code/sdk';
import type { PermissionMode } from '../../../lib/workspace/permissions.ts';

export type MuseApprovalMode = Exclude<
  StartSessionOptions['approvalMode'],
  null | undefined
>;

export function museServeArguments(
  mode: PermissionMode = 'workspace',
  options: { durable?: boolean } = {},
): string[] {
  const args = ['serve'];
  if (options.durable === false) args.push('--no-session-log');
  else args.push('--trust-workspace');
  if (mode === 'read-only') {
    args.push(
      '--disable-write',
      '--disable-shell',
      '--sandbox-network',
      'restricted',
    );
  } else if (mode === 'full-access') {
    args.push('--disable-sandbox');
  }
  return args;
}

export function museApprovalMode(
  mode: PermissionMode = 'workspace',
): MuseApprovalMode {
  switch (mode) {
    case 'read-only':
      return 'denyUnmatched';
    case 'full-access':
      return 'allowAll';
    default:
      return 'onRequest';
  }
}
