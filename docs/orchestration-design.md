# Project deep dive and provider orchestration

Reviewed 2026-09-08. The bounded three-phase implementation is now present. Follow-up feedback expanded it to all compatible installed provider/model pairs and replaced the original composer bar with a compact searchable worker picker. Provider-pair restrictions below describe the original proposal, not the current implementation. This document retains the original design and baseline findings; see [Orchestration operation and manual checks](orchestration.md) for implemented behavior and validation.

## Recommendation

Keep Astra as the owner of the conversation. Let the user explicitly select Muse as its worker. Start with a bounded sequence: Astra prepares a brief, Muse performs the work, Astra reviews the result and answers the user. Use the existing provider runtimes and SQLite persistence. A general workflow engine, message broker, recursive agents, and parallel worktrees are unnecessary for this first version.

This first version is a server-managed sequence in which Astra authors the assignment and reviews the outcome. It does not give Astra an open-ended tool for choosing when and how many agents to launch. That distinction should be clear in the product.

## What exists today

| Area | Implementation | Relevance |
| --- | --- | --- |
| Browser | React 19, Vite, Tailwind; `app/page.tsx` owns much of the workspace state | Composer, sending, retry recovery, provider selection and handoff converge here. Extract the composer as part of this feature; avoid a page-wide rewrite. |
| HTTP | Fastify, Zod validation, bearer authentication, origin checks | Extend the existing turn submission endpoint with explicit orchestration metadata. |
| Execution | `server/core/agent-service.ts` owns lifecycle, approvals, concurrency and persistence | Keep it as the owner of the user turn. A small sequential runner can execute its three phases. |
| Provider boundary | `server/runtime/agent-runtime.ts`; Codex, Muse and Grok adapters | All already support execution, interruption and shutdown. Reuse these contracts. |
| Discovery | `server/core/provider-registry.ts` caches and coalesces live probes | Build autocomplete from live snapshots, including health, model IDs and capabilities. |
| Storage | SQLite tasks, turns, events and approvals | Supports transactional submission, request deduplication and restart recovery; lacks execution-level identity within a turn. |
| Synchronization | `lib/workspace/sync.ts` drains event pages and retries polling | Run orchestration on the server so disconnects do not affect execution. |
| Handoff | `app/page.tsx` and `lib/workspace/handoff.ts` | Creates a new task and sends a clipped conversation brief. There is no parent relationship or result return. |
| Supporting features | Persistent attachments, terminals, provider installation maintenance | Orchestration must respect attachment access and maintenance locks; terminals remain an independent source of filesystem changes. |

The current request path is composer → pending submission in session storage → turn endpoint → AgentService → one runtime → durable events → browser polling. The important ownership boundary is already sound: the browser requests work, and the server owns its lifetime.

The deployment boundary remains one user and one backend process. In-memory execution ownership is not safe across multiple backend replicas sharing a database. This feature should preserve the documented deployment model.

## Findings that affect implementation

### 1. A task and turn currently imply one provider execution

`Task.providerId` and `Task.providerThreadId` identify one provider conversation. `Turn.providerTurnId` identifies one native execution. The `#run` callback writes native thread IDs straight onto the task.

Calling Muse with those same callbacks would overwrite Astra's native thread ID. Finishing an intermediate phase through the existing finalizer would also mark the whole task completed too early. Add explicit phase execution identity and finalize the user turn only after the sequence ends.

### 2. Concurrency protects tasks, not projects

`AgentService.startTurn` checks its controller map by task ID and limits total active tasks to four. Two separate tasks can still operate in the same directory. Merely running Astra and Muse sequentially does not prevent a third task from changing their files.

For v1, hold an exclusive orchestration reservation for the canonical project path for the whole sequence. Admission must reject orchestration if another task in that path is running, and reject new ordinary turns while that reservation exists. Perform check-and-reserve synchronously before asynchronous work, and release in `finally`. Conservatively reserve even read-only orchestrations initially. Do not promise protection against terminal commands, external editors, or overlapping parent/child project directories: either detect overlapping registered roots at admission or explicitly reject them for orchestration. Cross-process filesystem isolation requires a separate design.

### 3. Approval and event identity must include the execution

SQLite currently enforces native approval request uniqueness by `(turn_id, provider_request_id)`. Provider adapters allocate identifiers locally per execution, so planning and review can reuse the same native number within one user turn. Add execution-scoped uniqueness for new executions while preserving existing approval records.

Timeline items are keyed by provider `itemId`. Namespace them with the execution ID; otherwise unrelated providers or resumed processes can merge messages and activities. Attribute worker output and approvals visibly to Muse instead of presenting them as Astra's own messages.

### 4. Stop currently targets the task's original runtime

`AgentService.interrupt` resolves the runtime using `task.providerId`. During the worker phase this would target Codex instead of Muse. Track the active runtime and execution ID under the orchestration's parent controller. Stop must abort the sequence, interrupt the current execution, cancel its approvals and prevent the next phase from starting. Recheck the abort signal at every phase boundary.

### 5. Retries need the complete orchestration selection

The existing request identity covers prompt, model, reasoning, attachments and permission mode. Add the normalized worker selection to it. The same request ID with a changed worker/model must conflict, and an exact retry must return the original turn without launching another worker. Update pending-send serialization, validation and restoration together.

### 6. Existing handoff is useful UX precedent, not an orchestration engine

Handoff runs from the browser, creates another task, resets permissions to workspace, and clips recent conversation text. It does not preserve a durable parent/worker relationship or automatically return results. Reusing it directly would lose ownership and potentially broaden a read-only request's permissions.

### 7. Model-controlled delegation is a separate protocol extension

The Codex adapter currently accepts approval requests and declines other server requests. Its local protocol types do not expose a delegation tool. Rendering `dynamicToolCall` activity does not implement tool execution. True model-controlled delegation would require verifying the installed CLI's tool registration/call/result protocol, adding a narrow delegation callback, and testing cancellation while the parent awaits a worker. Do not assume this support from an event name.

The fixed three-phase sequence avoids that protocol dependency. If choosing arbitrary subtasks is required in the first release, treat verified tool support as an implementation prerequisite and revise the scope accordingly.

## Composer behavior

Example: `Orchestrate the settings page redesign with @Muse`.

- Typing the standalone word `orchestrate` offers an inline action and may highlight the word. It does not silently enable execution routing: phrases such as “do not orchestrate this” and quoted documentation remain ordinary text.
- Typing `@` opens a provider/model picker. Show provider name, model label and availability. Selecting a result enables an explicit orchestration selection for the next message.
- Display a removable chip such as `Orchestrator: GPT Astra → Worker: Muse Spark`, using the actual discovered labels. Changing the main model changes the orchestrator, not the worker.
- Keep stable provider and model IDs in structured composer state; never infer the backend target from display names or model-generated text. Require a resolved worker selection before sending in orchestration mode.
- Arrow keys navigate; Enter/Tab select; Escape dismisses. Enter must select before it can send. Preserve Shift+Enter and IME composition behavior. Provide a clickable action for touch and keyboard users who do not type a trigger.
- Clear orchestration state after an acknowledged send and on a new task. Restore it exactly for an unconfirmed submission. Define deletion behavior: removing the provider selection disables orchestration, and stale decorative mention text must not keep an invisible selection active.
- Use live discovery, not `lib/providers/catalog.ts` fallback entries, to authorize choices. Revalidate server-side because readiness may change after selection. Do not hardcode an Astra or Spark model ID.

The current composer uses a native textarea, which cannot style individual words. Prefer a highlighted, accessible mode chip initially. If inline highlighting is required, use a noninteractive, `aria-hidden` mirror behind the textarea with identical wrapping, padding and scrolling. Verify selection, zoom, multiline input and IME behavior in a browser. Do not adopt a rich-text editor solely for one highlighted keyword.

## Smallest complete backend design

### Submission

Extend the existing turn body with optional structured metadata:

```ts
orchestration?: {
  worker: {
    providerId: string;
    model: string;
    reasoningEffort?: string;
  };
}
```

Absence preserves ordinary turn behavior. The server resolves and persists the effective lead and worker model/options at admission. For the first release, enable Codex as lead and Muse as worker; keep the data shape provider-neutral without advertising unverified combinations. Validate both providers' permissions and input capabilities. Read-only input must never become workspace or full access in a worker.

### Persistence and ownership

Add orchestration configuration to the turn and an execution table with: ID, turn ID, phase (`plan`, `work`, `review`), provider/model/options, native thread and turn IDs, effective permissions, status, input, bounded result/error, and timestamps. Enforce one execution per `(turn_id, phase)` for this bounded version. Explicit user retry creates a new turn; no hidden phase retry.

Keep one visible task and one user turn. Astra's native thread remains on the task. Muse's thread remains on its execution record. Planning and review resume the lead thread where supported; do not ever give Muse that native ID. Events and approvals carry execution identity. Ordinary historical turns retain their existing representation; migrate without rewriting their meaning.

Extend runtime invocation identity explicitly if needed so active process maps and interruption target an execution. Keep UI task identity separate. Factor the existing persistence/approval handler construction into a small helper used by normal and orchestrated execution rather than duplicating it three times.

### Sequence

1. **Plan — Astra:** inspect the request and repository in read-only mode and produce a bounded work brief covering objective, constraints, relevant files and acceptance checks. Persist the final assistant output. Empty or oversized output is an explicit failure; do not dispatch partial streamed text. A bounded prose brief is sufficient for one fixed worker—no JSON planning language is required.
2. **Work — Muse:** execute with the submitted permission mode, original user request, Astra's brief and authorized attachments. Use a fresh worker session per orchestration initially. Preserve the full activity history; retain a bounded completion report for the review input.
3. **Review — Astra:** resume the lead conversation, inspect the current files and worker report, perform permitted validation, then answer the user. Use the submitted permission mode so requested checks can run. Label the review phase clearly; planning read-only restrictions must not accidentally persist through resume. If validation cannot run under the selected permissions, report that explicitly.

The server, not prose emitted by a model, chooses phases, providers, permissions and paths. Treat the worker report as evidence to assess. Its claim that tests passed is not independent verification. Do not forward hidden reasoning, unrelated conversations or arbitrary server files as context.

Start with one worker execution and one review; no automatic repair loop. The lead can report incomplete work or a failed review, and the user can request a follow-up. A successful provider process does not prove the requested change is correct; distinguish execution completion from the review's stated outcome.

### Resource and failure rules

- Reserve one existing global execution slot for the sequence: only one provider process executes at a time. Do not occupy all slots with parents waiting to admit children. Installation maintenance remains blocked while the sequence is active.
- Persist each phase transition before publishing it. Browser closure does not terminate the run. Keep the parent turn running between phases.
- If planning or worker execution fails, stop the sequence and show the failed phase. Do not manufacture a successful review. Retain partial filesystem changes and diagnostics.
- If review fails, retain the worker's completed result but mark the parent failed. Do not rerun Muse automatically.
- On server restart, mark unfinished parent turns and executions failed and cancel approvals transactionally. Preserve completed phase records. Do not automatically replay work whose external effects are unknown.
- Add a bounded phase/overall execution budget in addition to existing inactivity watchdogs. Document whether approval waiting pauses that budget. No unlimited retries or delegation depth.
- Authorize attachments against the parent turn and project once, prepare only those assets for phases, and check both models' image support before admission. Do not silently omit unsupported images or bind arbitrary asset IDs requested by a model.

## UI result

Show a single expandable orchestration card in the conversation:

```text
GPT Astra → Muse Spark
✓ Astra prepared the assignment
● Muse is implementing the change
○ Astra review

[View worker activity]                  [Stop]
```

Display failed and interrupted phases distinctly. Worker approvals should identify Muse and expose the existing approve/decline controls. Keep one final answer from Astra when review succeeds. Reloading the task must reconstruct the card from durable execution state and events, not local timers.

## Implementation order and release checks

1. Resolve the existing Grok type-check errors so the baseline is clean.
2. Add turn configuration, execution persistence, migrations and execution-scoped events/approvals. Test old database upgrades and request identity conflicts.
3. Build the fixed sequence against controlled runtimes. Reuse AgentService finalization and ownership. Test failure, stop, shutdown, restart, workspace reservation and maintenance admission before involving real models.
4. Add the composer picker and phase card. Test keyboard selection, ordinary mentions, disabled providers, pending-send reloads, changing tasks, image incompatibility and attribution.
5. Run an authenticated end-to-end smoke test with the installed Codex and Muse CLIs in a disposable project: change a small function, run a real check, inspect worker edits, and verify Astra receives and reviews the result. This is required before describing the feature as production ready.

Critical regression cases include duplicate submission during each phase; cancellation between worker completion and review start; reused native approval IDs; duplicate native item IDs; unavailable worker after admission; truncated/empty briefing; worker failure after writing files; review failure; active ordinary task in the same or overlapping path; browser disconnect; and restart with a pending worker approval. Tests should assert observable execution counts, persisted state and events, not mirror implementation details.

## Baseline validation observed

- `npm test`: 115 tests discovered; 114 passed in the sandbox. The remaining attachment integration test could not bind `127.0.0.1` (`EPERM`). Re-running `server/http/attachments.test.ts` with localhost binding permitted passed both tests. No assertion failure remains from that run; a single unrestricted full-suite run was not performed.
- `npm run lint` and `npx tsc --noEmit`: both report three TS2322 errors in `server/providers/grok/turn-runtime.ts` at lines 227, 237 and 261. `sessionResultModels` declares only `{ id, isDefault }` while callers infer full `ProviderModel[]`. Align the helper's full model contract with `parseGrokModels` and its fallback; avoid a cast hiding missing metadata.
- `npm run build:all`: frontend and backend builds pass. Vite warns about a frontend chunk larger than 500 kB. This build does not replace type checking.
- No authenticated provider execution, browser interaction or deployment validation was performed during this review. Those remain release checks, not claimed evidence.

The working tree already contained a modified `package-lock.json` before this review. The initial review added documentation only. The subsequent implementation is described in the companion orchestration guide.
