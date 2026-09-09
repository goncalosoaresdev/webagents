import { orchestrationSchema } from '../../lib/workspace/orchestration.ts';
import {
  ExecutionReport,
  pathsOverlap,
  planningPrompt,
  workerPrompt,
  reviewPrompt,
  validateOrchestrationModel,
} from './orchestration.ts';
import type { ProviderSnapshot } from '../../lib/providers/contracts.ts';
import type {
  Orchestration,
  TurnExecution,
} from '../../lib/workspace/contracts.ts';
import type {
  ExecuteTurnInput,
  ExecuteTurnResult,
} from '../runtime/agent-runtime.ts';
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
  readonly #workspaces = new Map<
    string,
    { path: string; orchestration: boolean }
  >();
  readonly #activeExecutions = new Map<
    string,
    { runtime: AgentRuntime; id: string }
  >();
  readonly #controllers = new Map<string, AbortController>();
  #closed = false;
  #closing?: Promise<void>;
  readonly #runs = new Set<Promise<void>>();

  constructor(
    private readonly store: WorkspaceStore,
    private readonly hub: ConnectionHub,
    runtimes: readonly AgentRuntime[],
    private readonly options: {
      probeProvider?: (id: string) => Promise<ProviderSnapshot>;
      orchestrationTimeoutMs?: number;
      maintenance?: () => boolean;
      attachments?: Pick<AttachmentService, 'list' | 'bind' | 'prepare'>;
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

  deleteTask(id: string): { deleted: boolean } {
    const task = this.store.getTask(id);
    if (!task) throw new ResourceNotFoundError('Task', id);
    const controller = this.#controllers.get(id);
    if (controller) controller.abort();
    this.#controllers.delete(id);
    this.#workspaces.delete(id);
    this.#activeExecutions.delete(id);
    this.store.deleteTask(id);
    return { deleted: true };
  }

  deleteArchivedTasks(): { deleted: number } {
    const archived = this.store.listTasks(undefined, true).filter((task) => Boolean(task.archivedAt));
    for (const task of archived) {
      const controller = this.#controllers.get(task.id);
      if (controller) controller.abort();
      this.#controllers.delete(task.id);
      this.#workspaces.delete(task.id);
      this.#activeExecutions.delete(task.id);
    }
    const deleted = this.store.deleteArchivedTasks();
    return { deleted };
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
      orchestration?: Orchestration;
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
    if (input.orchestration) {
      if (!orchestrationSchema.safeParse(input.orchestration).success)
        throw new ConflictError('Choose a valid worker provider and model.');
      if (!(input.model ?? task.model))
        throw new ConflictError('Select a lead model before orchestrating.');
      const worker = this.#runtimes.get(input.orchestration.worker.providerId);
      if (!worker || !this.options.probeProvider)
        throw new ConflictError('Orchestration is unavailable.');
      const permission = input.permissionMode ?? 'workspace';
      if (
        !runtime.permissionModes?.includes('read-only') ||
        !runtime.permissionModes?.includes(permission) ||
        !worker.permissionModes?.includes(permission)
      )
        throw new ConflictError(
          'These providers do not support the required orchestration permissions.',
        );
    }
    const project = this.store.getProject(task.projectId);
    if (!project) throw new ResourceNotFoundError('Project', task.projectId);

    if (this.#controllers.size >= (this.options.maxConcurrentTurns ?? 4))
      throw new ConflictError(
        'All execution slots are busy. Try again shortly.',
      );
    const cwd = this.options.validatePath?.(project.path) ?? project.path;
    for (const running of this.#workspaces.values()) {
      if (
        (input.orchestration || running.orchestration) &&
        pathsOverlap(cwd, running.path)
      )
        throw new ConflictError(
          'This workspace overlaps an active task. Wait for it to finish before orchestrating or editing here.',
        );
    }
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
        orchestration: input.orchestration,
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
    controller.signal.addEventListener(
      'abort',
      () => this.#cancelApprovalsForTurn(created.turn.id),
      { once: true },
    );
    this.#controllers.set(taskId, controller);
    this.#workspaces.set(taskId, {
      path: cwd,
      orchestration: Boolean(input.orchestration),
    });
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
    const controller = this.#controllers.get(taskId);
    if (!controller) return false;
    // Abort the sequence first: a completion racing Stop must not launch another phase.
    controller.abort();
    const active = this.#activeExecutions.get(taskId);
    if (active) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          active.runtime.interrupt(active.id).catch(() => false),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 2_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
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
      ...(resolved.executionId ? { executionId: resolved.executionId } : {}),
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
      const prepared = await this.options.attachments?.prepare(turn.id);
      controller.signal.throwIfAborted();
      const result = turn.orchestration
        ? await this.#orchestrate(
            runtime,
            task,
            cwd,
            turn,
            prepared,
            controller,
          )
        : await this.#execute(
            runtime,
            task,
            turn,
            {
              taskId: task.id,
              providerThreadId: task.providerThreadId,
              cwd,
              prompt: input.prompt,
              model: turn.model,
              reasoningEffort: turn.reasoningEffort,
              permissionMode: turn.permissionMode ?? 'workspace',
              attachments: prepared,
            },
            controller,
          );

      finalStatus =
        turn.orchestration && result.status === 'failed' && result.error
          ? 'failed'
          : controller.signal.aborted
            ? 'interrupted'
            : result.status;
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
      if (this.#closed && controller.signal.aborted) {
        this.#emit(task.id, turn.id, 'runtime.warning', {
          message: 'This task stopped because the app server shut down or restarted. Completed file changes remain. Start a new turn to continue.',
        });
      }
      this.#controllers.delete(task.id);
      this.#workspaces.delete(task.id);
      this.#activeExecutions.delete(task.id);
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

  async #execute(
    runtime: AgentRuntime,
    task: Task,
    turn: Turn,
    input: ExecuteTurnInput,
    controller: AbortController,
    execution?: TurnExecution,
    report?: ExecutionReport,
  ): Promise<ExecuteTurnResult> {
    controller.signal.throwIfAborted();
    let listening = true;
    this.#activeExecutions.set(task.id, { runtime, id: input.taskId });
    const accepts = () => listening && !controller.signal.aborted;
    try {
      return await runtime.executeTurn(
        input,
        {
          onProviderThread: (id) => {
            if (!accepts()) return;
            if (execution)
              this.store.updateExecution(execution.id, {
                providerThreadId: id,
              });
            if (!execution || execution.phase !== 'work')
              this.store.setTaskProviderThreadId(
                task.id,
                id,
                new Date().toISOString(),
              );
          },
          onProviderTurn: (id) => {
            if (!accepts()) return;
            if (execution)
              this.store.updateExecution(execution.id, { providerTurnId: id });
            else
              this.store.setTurnStatus(
                turn.id,
                'running',
                new Date().toISOString(),
                { providerTurnId: id },
              );
          },
          onEvent: (event) => {
            if (!accepts()) return;
            report?.add(event);
            this.#onRuntimeEvent(
              task.id,
              turn.id,
              execution
                ? {
                    ...event,
                    data: {
                      ...event.data,
                      executionId: execution.id,
                      phase: execution.phase,
                      providerId: execution.providerId,
                      ...(typeof event.data.itemId === 'string'
                        ? { itemId: `${execution.id}:${event.data.itemId}` }
                        : {}),
                    },
                  }
                : event,
            );
          },
          requestApproval: (request) =>
            accepts()
              ? this.#requestApproval(
                  task.id,
                  turn.id,
                  execution
                    ? {
                        ...request,
                        summary: `${execution.providerId} · ${execution.phase}: ${request.summary}`,
                      }
                    : request,
                  execution?.id,
                )
              : Promise.resolve('cancel'),
          withdrawApproval: (requestId) => {
            if (!accepts()) return;
            for (const [id, pending] of this.#pendingApprovals) {
              if (
                pending.request.turnId === turn.id &&
                pending.request.executionId === execution?.id &&
                pending.runtimeRequestId === requestId
              )
                this.resolveApproval(id, 'cancel');
            }
          },
        },
        controller.signal,
      );
    } catch (cause) {
      this.options.onError?.(cause);
      return {
        status: controller.signal.aborted ? 'interrupted' : 'failed',
        error: controller.signal.aborted
          ? undefined
          : 'Provider execution failed. Check the server logs.',
      };
    } finally {
      listening = false;
      this.#activeExecutions.delete(task.id);
      this.#cancelApprovalsForTurn(turn.id);
    }
  }

  async #orchestrate(
    lead: AgentRuntime,
    task: Task,
    cwd: string,
    turn: Turn,
    attachments: ExecuteTurnInput['attachments'],
    controller: AbortController,
  ): Promise<ExecuteTurnResult> {
    const worker = turn.orchestration!.worker;
    const workerRuntime = this.#runtimes.get(worker.providerId)!;
    let timedOut = false;
    // A hard overall limit includes time spent waiting for approval.
    const timer = setTimeout(
      () => {
        timedOut = true;
        controller.abort();
      },
      this.options.orchestrationTimeoutMs ?? 60 * 60_000,
    );
    timer.unref?.();
    let execution: TurnExecution | undefined;
    try {
      // Discovery is shared and bounded by ProviderRegistry; Stop detaches this run immediately.
      const snapshots = await new Promise<ProviderSnapshot[]>(
        (resolve, reject) => {
          const abort = () => reject(controller.signal.reason);
          controller.signal.addEventListener('abort', abort, { once: true });
          Promise.all([
            this.options.probeProvider!(task.providerId),
            this.options.probeProvider!(worker.providerId),
          ])
            .then(resolve, reject)
            .finally(() =>
              controller.signal.removeEventListener('abort', abort),
            );
        },
      );
      controller.signal.throwIfAborted();
      const hasImages = Boolean(
        attachments?.some((asset) => asset.mime.startsWith('image/')),
      );
      validateOrchestrationModel(
        snapshots[0],
        turn.model!,
        turn.reasoningEffort,
        hasImages,
      );
      validateOrchestrationModel(
        snapshots[1],
        worker.model,
        worker.reasoningEffort,
        hasImages,
      );
      let brief = '';
      let workerReport = '';
      for (const phase of ['plan', 'work', 'review'] as const) {
        controller.signal.throwIfAborted();
        // The path may have been replaced since admission.
        if (this.options.validatePath) this.options.validatePath(cwd);
        const isWorker = phase === 'work';
        const runtime = isWorker ? workerRuntime : lead;
        const prompt =
          phase === 'plan'
            ? planningPrompt(turn.prompt)
            : isWorker
              ? workerPrompt(turn.prompt, brief)
              : reviewPrompt(turn.prompt, workerReport);
        execution = {
          id: randomUUID(),
          turnId: turn.id,
          phase,
          providerId: runtime.providerId,
          model: isWorker ? worker.model : turn.model!,
          reasoningEffort:
            (isWorker ? worker.reasoningEffort : turn.reasoningEffort) ??
            snapshots[isWorker ? 1 : 0].models
              .find(
                (model) => model.id === (isWorker ? worker.model : turn.model),
              )
              ?.capabilities.find(
                (capability) => capability.id === 'reasoningEffort',
              )?.defaultValue,
          permissionMode:
            phase === 'plan'
              ? 'read-only'
              : (turn.permissionMode ?? 'workspace'),
          status: 'running',
          prompt,
          createdAt: new Date().toISOString(),
        };
        const started = this.store.transaction(() => {
          this.store.createExecution(execution!);
          return this.store.appendEvent({
            taskId: task.id,
            turnId: turn.id,
            type: 'execution.status',
            data: {
              executionId: execution!.id,
              phase,
              providerId: runtime.providerId,
              status: 'running',
            },
            now: execution!.createdAt,
          });
        });
        this.hub.broadcastTaskEvent(started);
        const report = new ExecutionReport(phase === 'plan' ? 16_000 : 32_000);
        const outcome = await this.#execute(
          runtime,
          task,
          turn,
          {
            // Runtime taskId is an opaque process-ownership key, separate from the UI task.
            taskId: execution.id,
            providerThreadId: isWorker
              ? undefined
              : this.store.getTask(task.id)?.providerThreadId,
            cwd,
            prompt,
            model: execution.model,
            reasoningEffort: execution.reasoningEffort,
            permissionMode: execution.permissionMode,
            attachments,
          },
          controller,
          execution,
          report,
        );
        controller.signal.throwIfAborted();
        if (outcome.status !== 'completed') {
          this.#finishExecution(
            task.id,
            execution,
            outcome.status,
            undefined,
            outcome.error,
          );
          execution = undefined;
          return outcome;
        }
        const result = report.finish();
        this.#finishExecution(task.id, execution, 'completed', result);
        execution = undefined;
        if (phase === 'plan') brief = result;
        if (phase === 'work') workerReport = result;
      }
      return { status: 'completed' };
    } catch (cause) {
      const status =
        controller.signal.aborted && !timedOut ? 'interrupted' : 'failed';
      const error = timedOut
        ? 'Orchestration exceeded its execution time limit (including approval waiting).'
        : controller.signal.aborted
          ? undefined
          : cause instanceof Error
            ? cause.message
            : 'Orchestration failed.';
      if (execution)
        this.#finishExecution(task.id, execution, status, undefined, error);
      return { status, error };
    } finally {
      clearTimeout(timer);
    }
  }

  #finishExecution(
    taskId: string,
    execution: TurnExecution,
    status: TurnExecution['status'],
    result?: string,
    error?: string,
  ): void {
    const now = new Date().toISOString();
    const event = this.store.transaction(() => {
      this.store.updateExecution(execution.id, {
        status,
        result,
        error,
        completedAt: now,
      });
      return this.store.appendEvent({
        taskId,
        turnId: execution.turnId,
        type: 'execution.status',
        data: {
          executionId: execution.id,
          phase: execution.phase,
          providerId: execution.providerId,
          status,
          ...(error ? { error } : {}),
        },
        now,
      });
    });
    this.hub.broadcastTaskEvent(event);
  }

  #onRuntimeEvent(taskId: string, turnId: string, event: RuntimeEvent): void {
    this.#emit(taskId, turnId, event.type, event.data);
  }

  #requestApproval(
    taskId: string,
    turnId: string,
    request: RuntimeApprovalRequest,
    executionId?: string,
  ): Promise<ApprovalDecision> {
    const approval = this.store.createApproval({
      id: randomUUID(),
      taskId,
      turnId,
      executionId,
      providerRequestId: request.providerRequestId,
      method: request.kind,
      summary: request.summary,
      details: request.details,
      now: new Date().toISOString(),
    });
    this.#emit(taskId, turnId, 'approval.requested', {
      approvalId: approval.id,
      ...(executionId ? { executionId } : {}),
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
      this.resolveApproval(id, 'cancel');
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
  orchestration?: Orchestration;
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
    ...(input.orchestration
      ? [
          {
            orchestration: {
              worker: {
                providerId: input.orchestration.worker.providerId,
                model: input.orchestration.worker.model,
                reasoningEffort:
                  input.orchestration.worker.reasoningEffort ?? null,
              },
            },
          },
        ]
      : []),
    ...(input.attachmentIds?.length ? [input.attachmentIds] : []),
    ...(input.permissionMode && input.permissionMode !== 'workspace'
      ? [{ permissionMode: input.permissionMode }]
      : []),
  ]);
}
