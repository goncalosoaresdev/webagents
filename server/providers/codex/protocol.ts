/**
 * Codex App Server request contracts used by Webcode.
 *
 * Keep these definitions aligned with the output of:
 * `codex app-server generate-ts --out <directory>`
 *
 * The App Server protocol is versioned with the installed Codex CLI. Defining
 * the supported request surface here prevents protocol enum values from being
 * passed through the JSON-RPC client as unchecked strings.
 */

export type CodexApprovalPolicy =
  | 'untrusted'
  | 'on-request'
  | 'never'
  | {
      granular: {
        sandbox_approval: boolean;
        rules: boolean;
        skill_approval: boolean;
        request_permissions: boolean;
        mcp_elicitations: boolean;
      };
    };

export type CodexSandboxMode =
  | 'read-only'
  | 'workspace-write'
  | 'danger-full-access';

export type CodexSandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; networkAccess: boolean }
  | {
      type: 'workspaceWrite';
      writableRoots: string[];
      networkAccess: boolean;
      excludeTmpdirEnvVar: boolean;
      excludeSlashTmp: boolean;
    };

interface ThreadConfiguration {
  model?: string | null;
  cwd?: string | null;
  approvalPolicy?: CodexApprovalPolicy | null;
  sandbox?: CodexSandboxMode | null;
}

export interface CodexRequestParams {
  initialize: {
    clientInfo: { name: string; title: string | null; version: string };
    capabilities: {
      experimentalApi: boolean;
      requestAttestation: boolean;
    } | null;
  };
  'account/rateLimits/read': Record<string, never>;
  'account/read': { refreshToken?: boolean };
  'model/list': {
    cursor?: string | null;
    limit?: number | null;
    includeHidden?: boolean | null;
  };
  'thread/start': ThreadConfiguration & {
    serviceName?: string | null;
  };
  'thread/resume': ThreadConfiguration & {
    threadId: string;
    excludeTurns?: boolean;
  };
  'turn/start': {
    threadId: string;
    input: Array<
      | { type: 'text'; text: string; text_elements: never[] }
      | { type: 'localImage'; path: string }
    >;
    cwd?: string | null;
    approvalPolicy?: CodexApprovalPolicy | null;
    sandboxPolicy?: CodexSandboxPolicy | null;
    model?: string | null;
    effort?: string | null;
  };
  'turn/interrupt': { threadId: string; turnId: string };
}

export type CodexRequestMethod = keyof CodexRequestParams;

export interface CodexNotificationParams {
  initialized: undefined;
}

export type CodexNotificationMethod = keyof CodexNotificationParams;
