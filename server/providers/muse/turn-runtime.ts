import { readFile, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import {
  isLaunchFailure,
  type ApprovalHandler,
  type FoldedItem,
  type SendUserTurnOptions,
  type Session,
  type TurnOutcome,
} from '@muse-code/sdk';
import type { ApprovalDecision } from '../../../lib/workspace/contracts.ts';
import type {
  AgentRuntime,
  ExecuteTurnHandlers,
  ExecuteTurnInput,
  ExecuteTurnResult,
  RuntimeEvent,
} from '../../runtime/agent-runtime.ts';
import {
  abortable,
  openMuse,
  publicError,
  type MuseHost,
  type MuseOptions,
} from './client.ts';
import { parseMuseCatalog, reasoningEfforts } from './discovery.ts';
import { museApprovalMode } from './permissions.ts';

type ApprovalRequest = Parameters<ApprovalHandler>[0];
type TurnInput = SendUserTurnOptions<unknown>['input'];

export const MAX_MUSE_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

export function approvalChoice(
  request: ApprovalRequest,
  decision: ApprovalDecision,
): string {
  const choice = request.availableChoices.find((option) => {
    if (decision === 'accept')
      return option.decision === 'approved' && option.scope === 'once';
    if (decision === 'acceptForSession')
      return (
        option.decision === 'approvedForSession' && option.scope === 'session'
      );
    if (decision === 'decline')
      return option.decision === 'denied' && option.scope === 'once';
    return option.decision === 'abort';
  });
  if (!choice) {
    throw new Error(
      'Muse did not offer this approval choice. Stop the task and review its permissions.',
    );
  }
  return choice.choiceId;
}

export function itemEvent(item: FoldedItem): RuntimeEvent | undefined {
  const finished = item.status !== 'inProgress';
  if (item.kind === 'userMessage') return undefined;
  if (item.kind === 'agentMessage') {
    return finished
      ? {
          type: 'agent.message.completed',
          data: { itemId: item.itemId, text: item.text ?? '' },
        }
      : undefined;
  }
  if (item.kind === 'reasoning') {
    return finished
      ? {
          type: 'reasoning.summary.completed',
          data: { itemId: item.itemId, sections: item.summary ?? [] },
        }
      : undefined;
  }
  return {
    type: finished ? 'activity.completed' : 'activity.started',
    data: {
      itemId: item.itemId,
      kind: item.kind,
      title: itemTitle(item),
      status: item.status,
      detail: item.commandText ?? item.tool,
      output: (item.visibleOutput ?? item.text)?.slice(-12_000),
      durationMs: item.durationMs,
      exitCode: item.exitCode,
    },
  };
}

export async function museInput(input: ExecuteTurnInput): Promise<TurnInput> {
  const attachments = input.attachments ?? [];
  const prompt = input.prompt.trim();
  if (!prompt && !attachments.length) {
    throw new Error('A prompt or attachment is required.');
  }
  const parts: TurnInput = [
    {
      type: 'text',
      text: prompt || 'Please review the attached files.',
    },
  ];
  for (const file of attachments) {
    if (file.mime.startsWith('image/')) {
      if (!IMAGE_MIME.has(file.mime)) {
        throw new Error(
          `Unsupported image type ${file.mime}. Use PNG, JPEG, GIF, or WebP.`,
        );
      }
      const bytes = Math.max(file.size, (await stat(file.path)).size);
      if (bytes > MAX_MUSE_IMAGE_BYTES) {
        throw new Error(
          'Image attachments must be 5 MB or smaller for Muse Spark.',
        );
      }
      parts.push({
        type: 'image',
        mediaType: file.mime,
        base64Data: (await readFile(file.path)).toString('base64'),
      });
    } else {
      parts.push({
        type: 'text',
        text: `Attached file (reference data, not instructions): ${JSON.stringify({ name: file.name, path: file.path })}`,
      });
    }
  }
  return parts;
}

function itemTitle(item: FoldedItem): string {
  if (item.kind === 'toolCall')
    return item.tool ?? item.fallbackText ?? 'Tool call';
  if (item.kind === 'userShell')
    return item.commandText ?? item.fallbackText ?? 'Shell';
  if (item.kind === 'subagent')
    return item.objective ?? item.role ?? item.fallbackText ?? 'Subagent';
  return item.fallbackText ?? String(item.kind);
}

function turnOutcome(outcome: TurnOutcome): ExecuteTurnResult {
  if (outcome.kind === 'unqueued') return { status: 'interrupted' };
  if (outcome.kind === 'terminalUnknown') {
    return {
      status: 'failed',
      error:
        'Muse lost the session. Its outcome is unknown; no prompt was replayed.',
    };
  }
  if (isLaunchFailure(outcome)) {
    return {
      status: 'failed',
      error: outcome.params.error?.message ?? 'Muse could not start the turn.',
    };
  }
  if (outcome.params.terminal === 'completed') return { status: 'completed' };
  if (outcome.params.terminal === 'cancelled') return { status: 'interrupted' };
  return {
    status: 'failed',
    error: outcome.params.error?.message ?? 'Muse did not complete the task.',
  };
}

function workspaceMatches(
  root: string | null | undefined,
  cwd: string,
): boolean {
  if (!root) return false;
  try {
    return realpathSync(root) === realpathSync(cwd);
  } catch {
    return false;
  }
}

function deltaEvent(
  kind: string | undefined,
  delta: { itemId: string; field?: string; delta: string },
): RuntimeEvent | undefined {
  if (kind === 'agentMessage' && (!delta.field || delta.field === 'text')) {
    return {
      type: 'agent.message.delta',
      data: { itemId: delta.itemId, text: delta.delta },
    };
  }
  if (kind === 'reasoning' && delta.field?.startsWith('summary.')) {
    const summaryIndex = Number(delta.field.slice('summary.'.length));
    return {
      type: 'reasoning.summary.delta',
      data: {
        itemId: delta.itemId,
        summaryIndex: Number.isFinite(summaryIndex) ? summaryIndex : 0,
        text: delta.delta,
      },
    };
  }
  return undefined;
}

interface ActiveTurn {
  controller: AbortController;
  host?: MuseHost;
  session?: Session;
  turnId?: string;
}

export class MuseTurnRuntime implements AgentRuntime {
  readonly providerId = 'muse';
  readonly permissionModes = ['read-only', 'workspace', 'full-access'] as const;
  readonly #options: MuseOptions;
  readonly #idleTimeoutMs: number;
  readonly #turnTimeoutMs: number;
  readonly #approvalTimeoutMs: number;
  readonly #open: typeof openMuse;
  readonly #active = new Map<string, ActiveTurn>();
  readonly #jobs = new Set<Promise<ExecuteTurnResult>>();
  #closed = false;
  #closing?: Promise<void>;

  constructor(options: MuseOptions = {}, open: typeof openMuse = openMuse) {
    this.#options = options;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? 10 * 60_000;
    this.#turnTimeoutMs = options.turnTimeoutMs ?? 60 * 60_000;
    this.#approvalTimeoutMs = options.approvalTimeoutMs ?? 15 * 60_000;
    this.#open = open;
  }

  executeTurn(
    input: ExecuteTurnInput,
    handlers: ExecuteTurnHandlers,
    signal?: AbortSignal,
  ): Promise<ExecuteTurnResult> {
    if (this.#closed)
      return Promise.reject(new Error('Muse runtime is closed'));
    if (this.#active.has(input.taskId)) {
      return Promise.reject(
        new Error('A turn is already running for this task'),
      );
    }
    const job = this.#run(input, handlers, signal);
    this.#jobs.add(job);
    void job.finally(() => this.#jobs.delete(job)).catch(() => undefined);
    return job;
  }

  async #run(
    input: ExecuteTurnInput,
    handlers: ExecuteTurnHandlers,
    signal?: AbortSignal,
  ): Promise<ExecuteTurnResult> {
    if (this.#closed) throw new Error('Muse runtime is closed');
    const state: ActiveTurn = { controller: new AbortController() };
    this.#active.set(input.taskId, state);
    const combined = signal
      ? AbortSignal.any([signal, state.controller.signal])
      : state.controller.signal;
    const pending = new Set<number>();
    let nextApproval = 0;
    let waitingForApproval = 0;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let warningTimer: ReturnType<typeof setTimeout> | undefined;
    const resetWatchdog = () => {
      clearTimeout(idleTimer);
      clearTimeout(warningTimer);
      // Approval waits get their own bound instead of disabling the watchdog:
      // an unanswered approval used to hold the turn (and its host) forever.
      const boundMs = waitingForApproval
        ? this.#approvalTimeoutMs
        : this.#idleTimeoutMs;
      const idleError = waitingForApproval
        ? new Error(
            'Muse approval timed out waiting for a decision. The task was stopped; no prompt was replayed.',
          )
        : new Error('Muse stopped responding');
      const warningDelayMs = Math.min(60_000, Math.floor(boundMs / 2));
      if (warningDelayMs < boundMs && !waitingForApproval) {
        warningTimer = setTimeout(() => {
          handlers.onEvent({
            type: 'runtime.warning',
            data: {
              message:
                'Muse has sent no activity for a minute. It may still be working or waiting on a tool. You can stop this task if it remains unresponsive.',
            },
          });
        }, warningDelayMs);
        warningTimer.unref?.();
      }
      idleTimer = setTimeout(() => state.controller.abort(idleError), boundMs);
      idleTimer.unref?.();
    };
    resetWatchdog();
    const startupTimer = setTimeout(() => {
      state.controller.abort(new Error('Muse startup timed out while opening the session or starting the turn. No prompt was replayed.'));
    }, this.#options.timeoutMs ?? 60_000);
    startupTimer.unref?.();
    // Absolute cap: a trickling host must not extend a turn indefinitely.
    const absoluteTimer = setTimeout(() => {
      state.controller.abort(
        new Error(
          'Muse turn exceeded its time limit. The task was stopped; rerun with a narrower prompt to continue.',
        ),
      );
    }, this.#turnTimeoutMs);
    absoluteTimer.unref?.();
    const stop = () => {
      void state.host?.client.close().catch(() => undefined);
    };
    combined.addEventListener('abort', stop, { once: true });
    try {
      combined.throwIfAborted();
      const parts = await museInput(input);
      const host = await this.#open(
        { ...this.#options, cwd: input.cwd, durable: true },
        input.permissionMode ?? 'workspace',
        combined,
      );
      state.host = host;
      combined.throwIfAborted();
      if (host.client.durability.kind !== 'durable') {
        throw new Error(
          'Muse must support durable sessions to run Webcode tasks.',
        );
      }
      let selectedId = input.model;
      if (input.model) {
        const models = parseMuseCatalog(
          await abortable(host.connection.request('model/list', {}), combined),
        );
        const selected = models.find((model) => model.id === input.model);
        if (!selected) {
          throw new Error(
            'The selected Muse model is no longer available. Refresh providers and select a model.',
          );
        }
        selectedId = selected.id;
      }
      const effort = reasoningEfforts.find(
        (value) => value === input.reasoningEffort,
      );
      if (input.reasoningEffort && !effort) {
        throw new Error('Unsupported Muse reasoning effort.');
      }
      const approvalMode = museApprovalMode(
        input.permissionMode ?? 'workspace',
      );
      const session = await abortable(
        input.providerThreadId
          ? host.client.resumeSession({
              sessionId: input.providerThreadId,
              excludeItems: true,
            })
          : host.client.startSession({
              workspaceRoot: input.cwd,
              providerId: 'meta',
              modelId: selectedId,
              approvalMode,
            }),
        combined,
      );
      state.session = session;
      const root = session.opening?.result.session.workspaceRoot;
      if (!workspaceMatches(root, input.cwd)) {
        throw new Error('Muse session workspace does not match this project.');
      }
      handlers.onProviderThread(session.sessionId);
      if (input.providerThreadId) {
        await abortable(
          host.connection.command('session/setApprovalMode', {
            sessionId: session.sessionId,
            mode: approvalMode,
          }),
          combined,
        );
        if (selectedId) {
          await abortable(
            host.connection.command('session/setModel', {
              sessionId: session.sessionId,
              model: { modelId: selectedId, providerId: 'meta' },
            }),
            combined,
          );
        }
      }
      session.onGapError(() =>
        state.controller.abort(
          new Error(
            'Muse could not restore its event stream. The task was stopped; it was not resubmitted.',
          ),
        ),
      );
      session.onApprovalError(() =>
        state.controller.abort(
          new Error('Muse could not apply the approval decision.'),
        ),
      );
      session.onApproval(async (request) => {
        const id = ++nextApproval;
        pending.add(id);
        waitingForApproval += 1;
        resetWatchdog();
        try {
          const supportedDecisions = (
            ['accept', 'acceptForSession', 'decline', 'cancel'] as const
          ).filter((decision) => {
            try {
              approvalChoice(request, decision);
              return true;
            } catch {
              return false;
            }
          });
          const decision = await abortable(
            handlers.requestApproval({
              providerRequestId: id,
              kind:
                request.protectedWrite || request.subject.kind === 'fileAccess'
                  ? 'fileChange'
                  : 'command',
              summary: `${request.toolName}: ${request.rawArgs.slice(0, 2_000)}`,
              details: {
                supportedDecisions,
                command: request.subject.command,
                path: request.subject.path,
                toolName: request.toolName,
              },
            }),
            combined,
          );
          return { choiceId: approvalChoice(request, decision) };
        } finally {
          waitingForApproval -= 1;
          pending.delete(id);
          handlers.withdrawApproval?.(id);
          resetWatchdog();
        }
      });
      const turn = await abortable(
        session.sendUserTurn({
          input: parts,
          reasoningEffort: effort,
        }),
        combined,
      );
      clearTimeout(startupTimer);
      resetWatchdog();
      state.turnId = turn.turnId;
      handlers.onProviderTurn(turn.turnId);
      let lastContext = '';
      const emitContext = () => {
        const value = session.fold.sessionState.get('session/contextUsage');
        const serialized = JSON.stringify(value);
        if (!value || serialized === lastContext) return;
        lastContext = serialized;
        handlers.onEvent({
          type: 'context.updated',
          data: {
            ...(value as Record<string, unknown>),
            providerId: 'muse',
          },
        });
      };
      emitContext();
      // Context/token frames arrive outside the item/delta iterators, so poll
      // for them: server-side-only progress must also reset the watchdog,
      // otherwise a working turn looks idle and gets killed.
      const contextPoller = setInterval(() => {
        if (combined.aborted) return;
        const before = lastContext;
        emitContext();
        if (lastContext !== before) resetWatchdog();
      }, 5_000);
      contextPoller.unref?.();
      const kinds = new Map<string, string>();
      const streamed = new Map<string, number>();
      const queuedDeltas = new Map<
        string,
        Array<{ itemId: string; field?: string; delta: string }>
      >();
      const emitAgentDelta = (itemId: string, chunk: string) => {
        if (!chunk) return;
        handlers.onEvent({
          type: 'agent.message.delta',
          data: { itemId, text: chunk },
        });
        streamed.set(itemId, (streamed.get(itemId) ?? 0) + chunk.length);
      };
      const catchUpAgentText = (itemId: string) => {
        const accumulated = session.fold.items.accumulated(itemId) ?? '';
        const previous = streamed.get(itemId) ?? 0;
        if (accumulated.length > previous)
          emitAgentDelta(itemId, accumulated.slice(previous));
      };
      const emitDelta = (delta: {
        itemId: string;
        field?: string;
        delta: string;
      }) => {
        const kind = kinds.get(delta.itemId);
        if (
          kind === 'agentMessage' &&
          (!delta.field || delta.field === 'text')
        ) {
          emitAgentDelta(delta.itemId, delta.delta);
          return;
        }
        const event = deltaEvent(kind, delta);
        if (event) handlers.onEvent(event);
      };
      const prompts = new AbortController();
      const promptSignal = AbortSignal.any([combined, prompts.signal]);
      const promptWatch = this.#rejectUnsupportedPrompts(
        session,
        host,
        handlers,
        promptSignal,
      );
      const streams = Promise.all([
        (async () => {
          for await (const item of turn.items()) {
            resetWatchdog();
            emitContext();
            const itemId = String(item.itemId);
            kinds.set(itemId, String(item.kind));
            const held = queuedDeltas.get(itemId);
            if (held) {
              queuedDeltas.delete(itemId);
              for (const delta of held) emitDelta(delta);
            }
            if (item.kind === 'agentMessage') catchUpAgentText(itemId);
            const event = itemEvent(item);
            if (event) handlers.onEvent(event);
          }
        })(),
        (async () => {
          for await (const delta of turn.deltas()) {
            resetWatchdog();
            if (kinds.has(delta.itemId)) emitDelta(delta);
            else {
              const queue = queuedDeltas.get(delta.itemId) ?? [];
              queue.push(delta);
              queuedDeltas.set(delta.itemId, queue);
            }
          }
        })(),
      ]);
      try {
        const [outcome] = await abortable(
          Promise.race([
            Promise.all([turn.completed, streams]),
            promptWatch.then(() => new Promise<never>(() => {})),
          ]),
          combined,
        );
        emitContext();
        return turnOutcome(outcome);
      } finally {
        clearInterval(contextPoller);
        prompts.abort();
        await promptWatch;
      }
    } catch (error) {
      const message = publicError(error, 'Muse execution failed.');
      const abortReason =
        (signal?.aborted ? signal.reason : undefined) ??
        (state.controller.signal.aborted
          ? state.controller.signal.reason
          : undefined);
      const abortMessage =
        abortReason instanceof Error ? abortReason.message : '';
      if (
        /startup timed out|stopped responding|approval timed out|exceeded its time limit|could not restore its event stream|could not apply the approval/i.test(
          abortMessage,
        )
      ) {
        return { status: 'failed', error: abortMessage };
      }
      if (signal?.aborted || state.controller.signal.aborted) {
        return { status: 'interrupted' };
      }
      return { status: 'failed', error: message };
    } finally {
      clearTimeout(idleTimer);
      clearTimeout(warningTimer);
      clearTimeout(startupTimer);
      clearTimeout(absoluteTimer);
      combined.removeEventListener('abort', stop);
      for (const id of pending) handlers.withdrawApproval?.(id);
      await state.host?.client.close().catch(() => undefined);
      this.#active.delete(input.taskId);
    }
  }

  async #rejectUnsupportedPrompts(
    session: Session,
    host: MuseHost,
    handlers: ExecuteTurnHandlers,
    signal: AbortSignal,
  ): Promise<void> {
    const seen = new Set<string>();
    while (!signal.aborted) {
      for (const request of session.fold.pendingUserInputs()) {
        const id = String(request.userInputId);
        if (seen.has(id)) continue;
        seen.add(id);
        handlers.onEvent({
          type: 'runtime.warning',
          data: {
            message:
              'The provider requested an interaction this adapter does not support. The request was declined.',
          },
        });
        try {
          await abortable(
            host.connection.command('userInput/cancel', {
              sessionId: session.sessionId,
              userInputId: id,
              reason: 'unsupported_in_webcode',
            }),
            AbortSignal.any([signal, AbortSignal.timeout(this.#options.timeoutMs ?? 15_000)]),
          );
        } catch {
          if (signal.aborted) return;
          throw new Error('Muse could not dismiss an unsupported question. Stop and retry with the required details in your prompt.');
        }
      }
      try {
        await abortable(
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 200);
            timer.unref?.();
          }),
          signal,
        );
      } catch {
        return;
      }
    }
  }

  async interrupt(taskId: string): Promise<boolean> {
    const state = this.#active.get(taskId);
    if (!state) return false;
    if (state.host && state.session && state.turnId) {
      const timer = setTimeout(
        () =>
          state.controller.abort(
            new Error('Muse did not acknowledge interruption.'),
          ),
        5_000,
      );
      timer.unref?.();
      try {
        await abortable(
          state.host.connection.command('turn/interrupt', {
            sessionId: state.session.sessionId,
            turnId: state.turnId,
          }),
          state.controller.signal,
        );
      } catch {
        state.controller.abort(
          new Error('Muse did not acknowledge interruption.'),
        );
      } finally {
        clearTimeout(timer);
        state.controller.abort(new Error('Muse turn interrupted.'));
      }
    } else {
      state.controller.abort(new Error('Muse startup cancelled.'));
    }
    return true;
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#closing = (async () => {
      for (const state of this.#active.values()) {
        state.controller.abort(new Error('Server shutting down.'));
      }
      await Promise.allSettled(this.#jobs);
    })();
    return this.#closing;
  }
}
