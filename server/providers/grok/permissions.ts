import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PermissionMode } from '../../../lib/workspace/permissions.ts';

export type GrokSandboxProfile = 'read-only' | 'workspace' | 'off';

export function grokWorkingDirectory(cwd: string): string {
  const absolute = resolve(cwd);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

export function grokAgentArguments(
  mode: PermissionMode = 'workspace',
  cwd?: string,
  selection?: { model?: string; reasoningEffort?: string },
): string[] {
  const args = ['--no-auto-update'];
  if (cwd) args.push('--cwd', grokWorkingDirectory(cwd));
  if (mode === 'read-only') args.push('--sandbox', 'read-only');
  else if (mode === 'workspace') args.push('--sandbox', 'workspace');
  args.push('agent', '--no-leader');
  if (selection?.model) args.push('--model', selection.model);
  if (selection?.reasoningEffort)
    args.push('--reasoning-effort', selection.reasoningEffort);
  args.push('stdio');
  return args;
}

export function grokSandbox(
  mode: PermissionMode = 'workspace',
): GrokSandboxProfile {
  if (mode === 'read-only') return 'read-only';
  if (mode === 'full-access') return 'off';
  return 'workspace';
}

export function grokSessionMeta(
  mode: PermissionMode = 'workspace',
): Record<string, unknown> | undefined {
  return mode === 'full-access' ? { yoloMode: true } : undefined;
}
