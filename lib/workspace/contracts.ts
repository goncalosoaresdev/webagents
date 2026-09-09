export interface Attachment {
  id: string;
  name: string;
  size: number;
  mime: string;
  state: 'uploading' | 'verifying' | 'ready' | 'deleting';
}

export type TaskStatus =
  | 'idle'
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted';
export type TurnStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted';

export interface Project {
  id: string;
  name: string;
  path: string;
  isGitRepository: boolean;
  branch?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  projectId: string;
  providerId: string;
  providerThreadId?: string;
  title: string;
  status: TaskStatus;
  model?: string;
  reasoningEffort?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface Orchestration {
  worker: { providerId: string; model: string; reasoningEffort?: string };
}

export type ExecutionPhase = 'plan' | 'work' | 'review';
export interface TurnExecution {
  id: string;
  turnId: string;
  phase: ExecutionPhase;
  providerId: string;
  model: string;
  reasoningEffort?: string;
  permissionMode: import('./permissions.ts').PermissionMode;
  providerThreadId?: string;
  providerTurnId?: string;
  status: TurnStatus;
  prompt: string;
  result?: string;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

export interface Turn {
  orchestration?: Orchestration;
  executions?: readonly TurnExecution[];
  permissionMode?: import('./permissions.ts').PermissionMode;
  attachments?: readonly Attachment[];
  id: string;
  taskId: string;
  providerTurnId?: string;
  clientRequestId: string;
  model?: string;
  reasoningEffort?: string;
  requestJson?: string;
  prompt: string;
  status: TurnStatus;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

export type TaskEventType =
  | 'context.updated'
  | 'execution.status'
  | 'user.message'
  | 'agent.message.delta'
  | 'agent.message.completed'
  | 'reasoning.summary.delta'
  | 'reasoning.summary.completed'
  | 'activity.started'
  | 'activity.completed'
  | 'approval.requested'
  | 'approval.resolved'
  | 'turn.status'
  | 'runtime.warning'
  | 'runtime.error';

export interface TaskEvent {
  sequence: number;
  taskId: string;
  turnId?: string;
  type: TaskEventType;
  data: Readonly<Record<string, unknown>>;
  createdAt: string;
}

export type ApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel';

export interface ApprovalRequest {
  executionId?: string;
  id: string;
  taskId: string;
  turnId: string;
  kind: 'command' | 'fileChange';
  summary: string;
  details: Readonly<Record<string, unknown>>;
  status: 'pending' | 'resolved';
  decision?: ApprovalDecision;
  createdAt: string;
  resolvedAt?: string;
}

export interface TaskDetail {
  task: Task;
  project: Project;
  turns: readonly Turn[];
  events: readonly TaskEvent[];
  nextSequence: number;
  hasMore: boolean;
  approvals: readonly ApprovalRequest[];
}
