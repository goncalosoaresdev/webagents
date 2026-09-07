import type {
  ApprovalDecision,
  TaskEventType,
} from '../../lib/workspace/contracts.ts';

export interface ExecuteTurnInput {
  permissionMode?: import('../../lib/workspace/permissions.ts').PermissionMode;
  attachments?: readonly (import('../../lib/workspace/contracts.ts').Attachment & {
    path: string;
  })[];
  taskId: string;
  providerThreadId?: string;
  cwd: string;
  prompt: string;
  model?: string;
  reasoningEffort?: string;
}

export interface RuntimeEvent {
  type: TaskEventType;
  data: Readonly<Record<string, unknown>>;
}

export interface RuntimeApprovalRequest {
  providerRequestId: number;
  kind: 'command' | 'fileChange';
  summary: string;
  details: Readonly<Record<string, unknown>>;
}

export interface ExecuteTurnHandlers {
  onProviderThread(providerThreadId: string): void;
  onProviderTurn(providerTurnId: string): void;
  onEvent(event: RuntimeEvent): void;
  requestApproval(request: RuntimeApprovalRequest): Promise<ApprovalDecision>;
  withdrawApproval?(requestId: number): void;
}

export interface ExecuteTurnResult {
  status: 'completed' | 'failed' | 'interrupted';
  error?: string;
}

export interface AgentRuntime {
  readonly providerId: string;
  readonly permissionModes?: readonly import('../../lib/workspace/permissions.ts').PermissionMode[];
  executeTurn(
    input: ExecuteTurnInput,
    handlers: ExecuteTurnHandlers,
    signal?: AbortSignal,
  ): Promise<ExecuteTurnResult>;
  interrupt(taskId: string): Promise<boolean>;
  close(): Promise<void>;
}
