import type { AttachmentService } from '../attachments/service.ts';
import { randomUUID } from 'node:crypto';
import type {
  ApprovalDecision,
  ApprovalRequest,
  Task,
  TaskDetail,
  TaskEvent,
  Turn,
} from '../../lib/workspace/contracts.ts';
import type {
  AgentRuntime,
  RuntimeApprovalRequest,
  RuntimeEvent,
} from '../runtime/agent-runtime.ts';
import { ConflictError, ResourceNotFoundError } from '../storage/errors.ts';
import type { WorkspaceStore } from '../storage/workspace-store.ts';
import type { ConnectionHub } from '../realtime/connection-hub.ts';

interface PendingApproval {
  request: ApprovalRequest;
  runtimeRequestId: number;
  resolve(decision: ApprovalDecision): void;
}

export class AgentService {
  readonly #runtimes = new Map<string, AgentRuntime>();
  readonly #pendingApprovals = new Map<string, PendingApproval>();
  readonly #controllers = new Map<string, AbortController>();
  #closed = false;
  #closing?: Promise<void>;
  readonly #runs = new Set<Promise<void>>();

  constructor(
    private readonly store: WorkspaceStore,
    private readonly hub: ConnectionHub,
    runtimes: readonly AgentRuntime[],
    private readonly options: {
      maintenance?: () => boolean;
      attachments?: AttachmentService;
      validatePath?: (path: string) => string;
      maxConcurrentTurns?: number;
      onError?: (error: unknown) => void;
    } = {},
  ) {
    for (const runtime of runtimes) {
      if (this.#runtimes.has(runtime.providerId))
        throw new Error(`Duplicate runtime: ${runtime.providerId}`);
      this.#runtimes.set(runtime.providerId, runtime);
    }
    this.store.recoverIncompleteWork(new Date().toISOString());
  }

  get isBusy(): boolean {
    return this.#controllers.size > 0;
  }

  listTasks(projectId?: string, includeArchived = false): readonly Task[] {
    return this.store.listTasks(projectId, includeArchived);
  }

  setArchived(id: string, archived: boolean): Task {
    const task = this.store.getTask(id);
    if (!task) throw new ResourceNotFoundError('Task', id);
    this.store.setTaskArchived(
      id,
      archived ? (task.archivedAt ?? new Date().toISOString()) : null,
    );
    return this.store.getTask(id)!;
  }

  getTask(id: string, afterSequence = 0): TaskDetail {
    const detail = this.store.getTaskDetail(id, afterSequence);
    if (!detail) throw new ResourceNotFoundError('Task', id);
    return {
      ...detail,
      turns: detail.turns.map((turn) => ({
        ...turn,
        attachments: this.options.attachments?.list(turn.id) ?? [],
      })),
    };
  }

  createTask(input: {
    projectId: string;
    providerId: string;
    title?: string;
    model?: string;
    reasoningEffort?: string;
    permissionMode?: import('../../lib/workspace/permissions.ts').PermissionMode;
  }): Task {
    if (!this.store.getProject(input.projectId))
      throw new ResourceNotFoundError('Project', input.projectId);
    if (!this.#runtimes.has(input.providerId))
      throw new ResourceNotFoundError('Provider runtime', input.providerId);
    return this.store.createTask({
      id: randomUUID(),
      projectId: input.projectId,
      providerId: input.providerId,
      title: input.title?.trim().slice(0, 120) || 'New task',
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      now: new Date().toISOString(),
    });
  }

  startTurn(
    taskId: string,
    input: {
      attachmentIds?: string[];
      clientRequestId: string;
      prompt: string;
      model?: string;
      reasoningEffort?: string;
      permissionMode?: import('../../lib/workspace/permissions.ts').PermissionMode;
    },
  ): { turn: Turn; created: boolean } {
    if (this.#closed) throw new ConflictError('Server is shutting down.');
    const task = this.store.getTask(taskId);
    if (!task) throw new ResourceNotFoundError('Task', taskId);
    const existing = this.store.findTurnByClientRequest(
      taskId,
      input.clientRequestId,
    );
    if (existing) {
      if (
        existing.prompt !== input.prompt ||
        (existing.requestJson &&
          existing.requestJson !== requestIdentity(input))
      ) {
        throw new ConflictError(
          'This request ID was already used with different content.',
        );
      }
      return { turn: existing, created: false };
    }
    if (this.options.maintenance?.())
      throw new ConflictError(
        'Provider update in progress. Try again when it finishes.',
      );
    if (this.#controllers.has(taskId) || task.status === 'running')
      throw new ConflictError('A turn is already running for this task.');
    const runtime = this.#runtimes.get(task.providerId);
    if (!runtime)
      throw new ResourceNotFoundError('Provider runtime', task.providerId);
    if (
      input.permissionMode &&
      input.permissionMode !== 'workspace' &&
      !runtime.permissionModes?.includes(input.permissionMode)
    )
      throw new ConflictError(
        'This provider does not support the selected permission mode.',
      );
    const project = this.store.getProject(task.projectId);
    if (!project) throw new ResourceNotFoundError('Project', task.projectId);

    if (this.#controllers.size >= (this.options.maxConcurrentTurns ?? 4))
      throw new ConflictError(
        'All execution slots are busy. Try again shortly.',
      );
    const cwd = this.options.validatePath?.(project.path) ?? project.path;
    const now = new Date().toISOString();
    const initialEvents: TaskEvent[] = [];
    const created = this.store.transaction(() => {
      const created = this.store.createTurn({
        id: randomUUID(),
        taskId,
        clientRequestId: input.clientRequestId,
        prompt: input.prompt,
        model: input.model ?? task.model,
        reasoningEffort: input.reasoningEffort ?? task.reasoningEffort,
        permissionMode: input.permissionMode ?? 'workspace',
        requestJson: requestIdentity(input),
        now,
      });
      if (!created.created) return created;
      this.store.setTaskArchived(taskId, null);
      if (input.attachmentIds?.length && !this.options.attachments)
        throw new ConflictError('Attachments are unavailable.');
      this.options.attachments?.bind(
        created.turn.id,
        task.projectId,
        input.attachmentIds ?? [],
      );
      if (task.title === 'New task')
        this.store.updateTaskTitle(taskId, titleFromPrompt(input.prompt), now);
      this.store.setTaskStatus(taskId, 'running', now);
      this.store.setTurnStatus(created.turn.id, 'running', now);
      initialEvents.push(
        this.store.appendEvent({
          taskId,
          turnId: created.turn.id,
          type: 'user.message',
          data: { text: input.prompt },
          now,
        }),
      );
      initialEvents.push(
        this.store.appendEvent({
          taskId,
          turnId: created.turn.id,
          type: 'turn.status',
          data: { status: 'running' },
          now,
        }),
      );
      return created;
    });
    if (!created.created) return created;
    for (const event of initialEvents) this.hub.broadcastTaskEvent(event);

    const controller = new AbortController();
    this.#controllers.set(taskId, controller);
    const run = this.#run(runtime, task, cwd, created.turn, input, controller)
      .catch((error: unknown) => {
        this.options.onError?.(error);
      })
      .finally(() => this.#runs.delete(run));
    this.#runs.add(run);
    return { turn: this.store.getTurn(created.turn.id)!, created: true };
  }

  async interrupt(taskId: string): Promise<boolean> {
    const task = this.store.getTask(taskId);
    if (!task) throw new ResourceNotFoundError('Task', taskId);
    const runtime = this.#runtimes.get(task.providerId);
    if (!runtime || !this.#controllers.has(taskId)) return false;
    const controller = this.#controllers.get(taskId)!;
    // Give the provider a brief opportunity to interrupt cooperatively, then
    // force cancellation even if its acknowledgement/completion never arrives.
    const timer = setTimeout(() => controller.abort(), 2_000);
    try {
      await Promise.race([
        runtime.interrupt(taskId).catch(() => false),
        new Promise<void>((resolve) =>
          controller.signal.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        ),
      ]);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    return true;
  }

  resolveApproval(id: string, decision: ApprovalDecision): ApprovalRequest {
    const pending = this.#pendingApprovals.get(id);
    const existing = this.store.getApproval(id);
    if (!existing) throw new ResourceNotFoundError('Approval request', id);
    if (existing.status === 'resolved' && existing.decision === decision)
      return existing;
    if (!pending || existing.status !== 'pending')
      throw new ConflictError('Approval request is no longer pending.');
    const resolved = this.store.resolveApproval(
      id,
      decision,
      new Date().toISOString(),
    )!;
    this.#pendingApprovals.delete(id);
    this.#emit(resolved.taskId, resolved.turnId, 'approval.resolved', {
      approvalId: id,
      decision,
    });
    pending.resolve(decision);
    return resolved;
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#closing = (async () => {
      for (const controller of this.#controllers.values()) controller.abort();
      for (const pending of this.#pendingApprovals.values())
        pending.resolve('cancel');
      await Promise.allSettled(
        [...this.#runtimes.values()].map((runtime) => runtime.close()),
      );
      await Promise.allSettled(this.#runs);
    })();
    return this.#closing;
  }

  async #run(
    runtime: AgentRuntime,
    task: Task,
    cwd: string,
    turn: Turn,
    input: { prompt: string; model?: string; reasoningEffort?: string },
    controller: AbortController,
  ): Promise<void> {
    let finalStatus: 'completed' | 'failed' | 'interrupted' = 'failed';
    let error: string | undefined;
    try {
      const result = await runtime.executeTurn(
        {
          taskId: task.id,
          providerThreadId: task.providerThreadId,
          cwd,
          permissionMode: turn.permissionMode ?? 'workspace',
          attachments: await this.options.attachments?.prepare(turn.id),
          prompt: input.prompt,
          model: input.model ?? task.model,
          reasoningEffort: input.reasoningEffort ?? task.reasoningEffort,
        },
        {
          onProviderThread: (id) =>
            this.store.setTaskProviderThreadId(
              task.id,
              id,
              new Date().toISOString(),
            ),
          onProviderTurn: (id) =>
            this.store.setTurnStatus(
              turn.id,
              'running',
              new Date().toISOString(),
              { providerTurnId: id },
            ),
          onEvent: (event) => this.#onRuntimeEvent(task.id, turn.id, event),
          requestApproval: (request) =>
            this.#requestApproval(task.id, turn.id, request),
          withdrawApproval: (requestId) => {
            for (const [id, pending] of this.#pendingApprovals) {
              if (
                pending.request.turnId === turn.id &&
                pending.runtimeRequestId === requestId
              )
                this.resolveApproval(id, 'cancel');
            }
          },
        },
        controller.signal,
      );
      finalStatus = controller.signal.aborted ? 'interrupted' : result.status;
      error = result.error;
    } catch (cause) {
      finalStatus = controller.signal.aborted ? 'interrupted' : 'failed';
      this.options.onError?.(cause);
      error = controller.signal.aborted
        ? undefined
        : 'Provider execution failed. Check the server logs.';
      if (error)
        this.#emit(task.id, turn.id, 'runtime.error', { message: error });
    } finally {
      this.#controllers.delete(task.id);
      this.#cancelApprovalsForTurn(turn.id);
      const now = new Date().toISOString();
      const event = this.store.transaction(() => {
        this.store.setTurnStatus(turn.id, finalStatus, now, { error });
        this.store.setTaskStatus(task.id, finalStatus, now);
        return this.store.appendEvent({
          taskId: task.id,
          turnId: turn.id,
          type: 'turn.status',
          data: { status: finalStatus, ...(error ? { error } : {}) },
          now,
        });
      });
      this.hub.broadcastTaskEvent(event);
    }
  }

  #onRuntimeEvent(taskId: string, turnId: string, event: RuntimeEvent): void {
    this.#emit(taskId, turnId, event.type, event.data);
  }

  #requestApproval(
    taskId: string,
    turnId: string,
    request: RuntimeApprovalRequest,
  ): Promise<ApprovalDecision> {
    const approval = this.store.createApproval({
      id: randomUUID(),
      taskId,
      turnId,
      providerRequestId: request.providerRequestId,
      method: request.kind,
      summary: request.summary,
      details: request.details,
      now: new Date().toISOString(),
    });
    this.#emit(taskId, turnId, 'approval.requested', {
      approvalId: approval.id,
      kind: approval.kind,
      summary: approval.summary,
      details: approval.details,
    });
    return new Promise((resolve) =>
      this.#pendingApprovals.set(approval.id, {
        request: approval,
        runtimeRequestId: request.providerRequestId,
        resolve,
      }),
    );
  }

  #cancelApprovalsForTurn(turnId: string): void {
    for (const [id, pending] of this.#pendingApprovals) {
      if (pending.request.turnId !== turnId) continue;
      this.store.resolveApproval(id, 'cancel', new Date().toISOString());
      pending.resolve('cancel');
      this.#pendingApprovals.delete(id);
    }
  }

  #emit(
    taskId: string,
    turnId: string | undefined,
    type: TaskEvent['type'],
    data: Readonly<Record<string, unknown>>,
  ): void {
    const event = this.store.appendEvent({
      taskId,
      turnId,
      type,
      data,
      now: new Date().toISOString(),
    });
    this.hub.broadcastTaskEvent(event);
  }
}

function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.trim().split(/\r?\n/, 1)[0] ?? 'New task';
  return firstLine.replace(/\s+/g, ' ').slice(0, 80) || 'New task';
}

function requestIdentity(input: {
  attachmentIds?: string[];
  prompt: string;
  model?: string;
  reasoningEffort?: string;
  permissionMode?: import('../../lib/workspace/permissions.ts').PermissionMode;
}): string {
  return JSON.stringify([
    input.prompt,
    input.model ?? null,
    input.reasoningEffort ?? null,
    ...(input.attachmentIds?.length ? [input.attachmentIds] : []),
    ...(input.permissionMode && input.permissionMode !== 'workspace'
      ? [{ permissionMode: input.permissionMode }]
      : []),
  ]);
}
