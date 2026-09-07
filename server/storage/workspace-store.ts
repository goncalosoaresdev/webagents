import type {
  ApprovalDecision,
  ApprovalRequest,
  Project,
  Task,
  TaskDetail,
  TaskEvent,
  TaskEventType,
  TaskStatus,
  Turn,
  TurnStatus,
} from '../../lib/workspace/contracts.ts';

export interface CreateProjectInput {
  id: string;
  name: string;
  path: string;
  isGitRepository: boolean;
  now: string;
}

export interface CreateTaskInput {
  id: string;
  projectId: string;
  providerId: string;
  title: string;
  model?: string;
  reasoningEffort?: string;
  now: string;
}

export interface CreateTurnInput {
  permissionMode?: import('../../lib/workspace/permissions.ts').PermissionMode;
  id: string;
  taskId: string;
  clientRequestId: string;
  prompt: string;
  model?: string;
  reasoningEffort?: string;
  requestJson?: string;
  now: string;
}

export interface AppendEventInput {
  taskId: string;
  turnId?: string;
  type: TaskEventType;
  data: Readonly<Record<string, unknown>>;
  now: string;
}

export interface CreateApprovalInput {
  id: string;
  taskId: string;
  turnId: string;
  providerRequestId: number;
  method: string;
  summary: string;
  details: Readonly<Record<string, unknown>>;
  now: string;
}

export interface WorkspaceStore {
  transaction<T>(operation: () => T): T;
  listProjects(): readonly Project[];
  getProject(id: string): Project | undefined;
  findProjectByPath(path: string): Project | undefined;
  createProject(input: CreateProjectInput): Project;

  listTasks(projectId?: string, includeArchived?: boolean): readonly Task[];
  setTaskArchived(id: string, archivedAt: string | null): void;
  getTask(id: string): Task | undefined;
  getTaskDetail(id: string, afterSequence?: number): TaskDetail | undefined;
  createTask(input: CreateTaskInput): Task;
  updateTaskTitle(id: string, title: string, now: string): void;
  setTaskProviderThreadId(
    id: string,
    providerThreadId: string,
    now: string,
  ): void;
  setTaskStatus(id: string, status: TaskStatus, now: string): void;

  createTurn(input: CreateTurnInput): { turn: Turn; created: boolean };
  findTurnByClientRequest(
    taskId: string,
    clientRequestId: string,
  ): Turn | undefined;
  getTurn(id: string): Turn | undefined;
  setTurnStatus(
    id: string,
    status: TurnStatus,
    now: string,
    options?: { providerTurnId?: string; error?: string },
  ): void;

  appendEvent(input: AppendEventInput): TaskEvent;
  listEvents(
    taskId: string,
    afterSequence?: number,
    limit?: number,
  ): readonly TaskEvent[];

  createApproval(input: CreateApprovalInput): ApprovalRequest;
  getApproval(id: string): ApprovalRequest | undefined;
  resolveApproval(
    id: string,
    decision: ApprovalDecision,
    now: string,
  ): ApprovalRequest | undefined;

  recoverIncompleteWork(now: string): void;

  close(): void;
}
