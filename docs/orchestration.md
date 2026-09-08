# Orchestration

The first implementation runs a fixed sequence in one task and one user turn:

1. The selected lead model prepares a read-only assignment.
2. The selected worker model implements the assignment.
3. The lead resumes its own conversation to review the work and answer the user.

Any ready installed provider can lead or work, including Codex → Muse, Muse → Codex, Grok in either role, and different models from the same provider. Both runtimes must support the required permission modes. It does not expose a model-controlled delegation tool or recursive/parallel agents. The server chooses the three phases; the lead authors the work brief and reviews the result.

## Composer

Select a lead model, then type `@` and choose a worker model in the message box. The mention picker groups ready models by provider. A plain mention alone never changes execution routing.

The mention picker uses live provider snapshots. Arrow keys navigate, Enter or Tab selects, Escape dismisses, and Shift+Enter remains a newline. Selecting from a typed mention replaces the partial mention with the model label and arms the worker. Deleting that label from the message disarms the worker and clears the glow. The Orchestrate indicator in the project strip is display-only: it glows while a worker is armed, without naming the model, and it never opens a picker. To switch workers, type `@` again and choose another model; to disarm, choose “Remove worker” at the top of the mention list. The lead remains in the existing main model control. Changing the lead model preserves the worker choice. Machine-style model IDs are formatted for readability, while routing always uses the original IDs. The mention picker is unavailable when the message box is disabled, including while a turn is running. The selection applies only to the next submission, clears after acknowledgement or task navigation, and is retained in an unconfirmed submission for retry/reload.

The UI marks only the armed indicator state, not individual characters in the textarea. It retains native text editing and IME handling.

## Execution and persistence

The existing `POST /api/v1/tasks/:taskId/turns` accepts:

```json
{
  "clientRequestId": "<uuid>",
  "prompt": "Implement the requested change",
  "model": "<discovered lead model ID>",
  "permissionMode": "workspace",
  "orchestration": {
    "worker": {
      "providerId": "muse",
      "model": "<discovered worker model ID>",
      "reasoningEffort": "<optional discovered effort>"
    }
  }
}
```

The schema rejects unknown worker fields and malformed provider IDs. Admission rejects worker providers without a registered runtime. Permission support and workspace conflicts are checked synchronously at admission. Live health, model, reasoning and image compatibility are checked on the server after the turn is persisted and before any phase starts. A failed live preflight leaves a failed turn with a visible explanation; it does not start the lead or worker.

The submitted selection participates in request identity. Reusing a request ID with a changed selection conflicts; an exact retry returns the existing turn. No automatic model substitution, phase retries or restart replay occur. Models are pinned per execution; an omitted reasoning effort resolves to its discovered default when available.

A SQLite migration adds the orchestration selection to turns, a `turn_executions` table, and execution-scoped approval identity. The execution table stores one typed JSON record per `(turn, phase)` with the effective inputs, native IDs, status, bounded report/error, and timestamps. Existing tasks and approvals migrate in place. Completed execution records are immutable in normal operation; recovery changes only unfinished executions.

`GET /api/v1/tasks/:taskId` includes `turn.orchestration` and `turn.executions`. Phase transitions also produce durable `execution.status` events. Provider item IDs are namespaced by execution; provider messages and approvals are attributed to their phase. The worker's native session ID never replaces the lead's task session ID, including when both use the same provider.

## Permissions, cancellation and resource limits

- Planning always uses read-only permissions. Work and review use the user's selected permission mode. A read-only request remains read-only throughout; full access is never inferred from a worker report.
- Only attachments authorized for the submitted parent turn are passed into the phase inputs. Existing attachment preparation still restores historical assets for a resumed lead conversation. Both selected models must support submitted images.
- One global execution slot is reserved for the entire sequence. Only one phase executes at a time. Provider installation maintenance stays blocked while orchestration is active.
- A process-local reservation blocks new tasks in the same canonical project path or a parent/child path. Starting orchestration also rejects an already-active task in those paths. Reservations release after finalization or cancellation.
- Reservations govern Webcode agent tasks. They do not isolate changes made through terminals, external editors, another backend process, or deliberate cross-project access in full-access mode. The application retains its single-user, single-backend deployment model.
- **Stop** aborts the sequence, cancels pending approvals and interrupts the current provider execution. It also prevents startup if cancellation arrives during discovery or between phases. Closing a browser tab does not stop server work.
- The sequence has a one-hour hard execution limit, including approval waiting, in addition to provider inactivity watchdogs. It starts after attachment preparation. Timeout fails the turn and aborts the active provider.
- Planning accepts at most 16,000 characters of completed assistant report; worker and review reports accept at most 32,000 characters. Empty/oversized reports fail the phase. Delta-only providers such as Grok have their text assembled into a report, but it is consumed only after a successful turn completion. Completed-message events replace the corresponding streamed text to avoid duplication. Failed/interrupted streams and reasoning never become the next phase's brief.
- Worker failure stops the sequence. Review failure retains the completed worker result but fails the parent turn. A successful provider exit is an execution outcome, not a claim that the requested change passed verification.
- On restart, unfinished turns/executions fail and approvals are cancelled. Completed phases and partial filesystem changes remain. No commands are automatically replayed.

## Manual integration checks

Use a disposable project with the providers you want to test installed and authenticated as the backend service account. Browser and real-provider integration are intentionally left for manual validation.

1. Choose GPT Astra from the live Codex model list. Type a small change with `@mu`, select Muse Spark, and confirm the Orchestrate indicator in the project strip glows. Confirm clicking the indicator does nothing. Type `@` again to switch workers; change the main model control to test Muse → Codex and Grok in either role. Check arrows, Tab/Enter, Escape, Shift+Enter, IME input if applicable, and the click/touch mention picker. Choose “Remove worker” from the mention list and verify the indicator stops glowing.
2. Submit a small implementation with a concrete test. Confirm there is one task and one user turn, with lead assignment, Muse implementation and lead review. Inspect Muse's activity, the actual file changes and the lead's final verification. Worker text must appear under Muse's phase.
3. Reload or close/reopen the task during work. Phase statuses and approvals should recover from the server. An unconfirmed submission must retain the same request ID and selected worker without duplicating execution.
4. Stop during Muse execution or a pending approval. The task should settle as interrupted, the approval should cancel, and review must not begin. Already-written files are retained.
5. Repeat with read-only permissions. Neither agent should make changes. For a workspace run requiring approval, verify that the request identifies the provider and phase and that Allow once/Decline reaches that execution.
6. While orchestration runs, attempt another task in the same or nested project. Expect a conflict. After the orchestration settles, verify the other task can run. A different, non-overlapping project may still run within the global limit.
7. Try an unavailable worker or an incompatible image model. Expect a disabled selection or a failed preflight without provider execution, never a silently substituted provider or omitted attachment.
8. In the disposable environment, restart the backend during work. Confirm unfinished work is failed and not replayed, completed phase records survive, and there are no pending approvals from the previous process.

## Automated verification

Controlled-runtime tests cover the three phases, lead session ownership, input/report transfer, permission inheritance, attachment forwarding, approval and event ID collisions, duplicate submissions, worker/review failures, empty/oversized reports, workspace reservations, maintenance, timeout, Stop and shutdown races, and restart recovery. HTTP tests exercise authentication, schema validation, request conflicts and persisted phase responses. Server-rendered component tests check attribution and explicit selection behavior; they do not substitute for browser interaction tests. Existing provider tests continue to use controlled subprocesses rather than paid provider calls.


Validation after provider-pair and composer feedback (2026-09-08): all 144 automated tests passed, including all nine Codex/Muse/Grok lead-worker combinations, same-provider session isolation, streamed report handling, and ready-model selection. Lint, TypeScript checking, and production builds passed. Browser and live-provider integration remain manual; the frontend chunk-size warning remains.
