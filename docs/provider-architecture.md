# Provider architecture

Webcode is a single-user, single-process VPS workspace. SQLite owns application history;
provider CLIs own their native thread history. Browsers can disconnect without cancelling work.

## Contracts and ownership

- `ProviderDiscovery` in `lib/providers/contracts.ts` supplies live health and model capabilities.
- `AgentRuntime` in `server/runtime/agent-runtime.ts` is the sole execution contract. Implement
  `executeTurn`, `interrupt`, and `close`; register discovery and execution in `server/index.ts`.
- `AgentService` owns task/turn state, operation deduplication, approvals, execution limits,
  and transactional persistence. Pass canonical workspace paths through its validation callback.
- `RuntimeEvent` uses Webcode event names. Adapters validate native payloads before translating
  them. Public approvals contain `kind`, a summary, and normalized details; native method names
  and native correlation identifiers do not belong in public contracts.
- Each runtime assigns approval request identifiers local to one execution. The adapter maps
  those identifiers to its native protocol, including withdrawal via `withdrawApproval`.

Adding a provider does not require a new transport or an orchestrator branch. A provider must
honor cancellation during initialization as well as execution, and `close()` must settle all
owned executions. It must validate model/options against its own capabilities and fail closed
for unsupported interactive requests. Implement tests using a controlled subprocess, without
real account credentials or model calls.

The UI discovers reasoning choices and default models. Execution currently accepts text, model,
and reasoning effort. Other option types (including discovered service tiers) need explicit
execution/UI support before they are advertised as selectable features.

## Codex lifecycle

One `codex app-server` process serves **one turn**. Subsequent turns resume the saved native
thread in a new process. Do not assume process/session-scoped permissions survive between turns.
The adapter supports command and file-change approvals. Other interaction types are rejected
and emit a warning until a corresponding normalized Webcode interaction is implemented.

The client performs initialize/initialized, validates incoming envelopes and known event shapes,
bounds frames before newline buffering, bounds queued writes and stderr, handles stream errors,
and closes a POSIX process group with TERM followed by KILL. Repeated closure shares a promise.
The runtime tracks executions before spawning so Stop and shutdown cover startup races.
A 30-minute inactivity watchdog closes an unresponsive process; it pauses while awaiting approval.
The constructor accepts `idleTimeoutMs` for deployments requiring a different threshold.

The request surface was checked against locally generated Codex CLI 0.152.0 schemas.
Use an explicitly managed Codex CLI version. Generate protocol schemas using
`codex app-server generate-ts` / `generate-json-schema` when upgrading, compare them with
`server/providers/codex/protocol.ts`, and run the adapter tests. Unknown notification methods
are ignored for forward compatibility; malformed supported messages fail the execution.
Reference: https://learn.chatgpt.com/docs/app-server

## Durability and recovery

Turn submission IDs are unique within a task. An exact retry returns the original turn;
reusing the ID with a different payload returns a conflict. Effective model and reasoning effort
are recorded with each new turn. Browser session storage retains an unconfirmed submission
before dispatch, so retries and reloads within that tab preserve its operation ID. It does not
automatically replay prompts on restart or share unsent drafts across devices.

Turn creation/status and their initial/final events commit atomically. Persist before broadcasting.
Shutdown rejects new turns, cancels active executions, waits for finalization, then closes storage.
On startup, incomplete work is marked failed and pending approvals are cancelled. This does not
undo filesystem changes made before a crash and does not infer that an interrupted command is
safe to execute again. Back up both Webcode data and the provider's native history.

Task history is paginated with `nextSequence` and `hasMore`. Clients drain pages, merge by sequence,
and subsequently request only newer events. Polling retries failures with bounded exponential
backoff and wakes on focus/network recovery. Idle tasks and task lists continue to synchronize
for cross-device activity. WebSockets remain an optional transport; slow consumers are disconnected
and must recover from durable HTTP history. Do not derive per-task gaps from consecutive global
sequence values: other tasks share the sequence counter.

## Production boundaries

Production and non-loopback listeners require `WEBCODE_AUTH_TOKEN` (at least 32 characters).
All versioned APIs, including WebSocket ticket issuance, require it. The browser holds the token
in memory, not browser storage. Use HTTPS; reload requires sign-in. Tickets are short-lived,
single-use, and checked against allowed origins. Request logs exclude query strings.

The workspace root is the default browsing and clone destination. Explicitly registered projects
may live elsewhere on the server. Registration resolves symlinks to a canonical directory; execution
requires that exact registered directory to still exist and resolve to the same location. Browsing
and registration use the service account’s filesystem access. This is not a replacement for
an unprivileged Unix user, Codex's sandbox, or container isolation. Limit access to the backend
listener; forwarded IP headers are not trusted. Default execution concurrency is four turns.

Run only one backend against a data directory. Multi-replica operation needs shared atomic
ownership, distributed tickets, and coordinated recovery; an in-memory execution map is not a
cross-process lock. Provide TLS/reverse-proxy routing, service supervision, resource limits,
and tested backups as part of VPS deployment.

### Per-message permissions

The composer selects `read-only`, `workspace` (default), or `full-access`. The
turn endpoint validates the enum, stores it on the turn, and includes nondefault
modes in request identity. Retries therefore cannot silently change permissions.
Selection affects the next message, not an already running turn. New tasks and
switching tasks reset the composer to Workspace; pending-send recovery restores
its exact submitted selection.

Codex maps these settings on both thread start/resume and turn start:

| Mode        | Approval policy | Sandbox                                                                |
| ----------- | --------------- | ---------------------------------------------------------------------- |
| Read only   | never           | readOnly, network disabled                                             |
| Workspace   | on-request      | workspaceWrite, project and temporary files writable, network disabled |
| Full access | never           | dangerFullAccess                                                       |

Full access removes Codex sandbox restrictions, subject to the server OS account's
permissions. It does not change Webcode API authentication. Provider runtimes must
advertise support for nondefault modes; unsupported selections are rejected.
These mappings use the [Codex App Server protocol](https://developers.openai.com/codex/app-server).
The UI intentionally uses these concrete modes rather than promising approval
behavior that this adapter does not implement. No tests were run for this change
at the user's request.

### Account usage indicator

The composer reads authenticated `/api/v1/providers/:providerId/limits` and can
explicitly POST to its `/refresh` endpoint. Reads are coalesced and cached for
60 seconds, with a separate bounded Codex process so usage errors do not affect
model discovery. The client polls while visible and refreshes on focus.

Codex uses `account/rateLimits/read`. Multiple buckets take precedence over the
legacy single-bucket view. Percentages are converted from used to remaining;
unknown values stay unknown. Expired windows and data older than two minutes
are not displayed as current allowance. This is account usage, not task token
usage. The interface does not redeem resets or purchase credits.

## Provider installation settings

Settings → Providers reads server installation health independently of model discovery. The provider-neutral `InstallationDriver` contract supplies inspection, latest-release lookup, and updating; the composition root registers Codex and Muse. Authenticated installation routes reuse the existing origin checks and rate limits. Reads coalesce and cache for one minute; update requests return an accepted status while the server owns the job. Closing the settings panel does not cancel an update.

Codex compares its executable's version with the official npm package's stable release. Unknown release checks remain unknown. In-app updating supports writable global npm installations and Homebrew Codex casks, and requires that the configured executable resolves to that exact installation. Homebrew installations check the Homebrew cask release API and run a scoped cask upgrade; npm installations check the npm stable release and install a pinned version. The installed executable version is re-read after either update. It uses a fixed package name, validated pinned version, fixed registry, no shell, bounded output, and a three-minute process timeout. It verifies the executable version after installation and refreshes provider discovery. It never invokes sudo. Standalone, bundled, custom, or image-managed installations display manual-management guidance instead of updating a different binary.

Updates require all tasks to be idle. New turns are rejected during maintenance without recording a user message; duplicate update requests share a job. This lock is process-local: run one Webcode server process per installation. Job status is in memory; a server restart re-inspects the installation. Package-manager updates are not transactional and have no automatic rollback; after a failed/interrupted update, check the installation again and repair with the original installer if necessary. Container installations should be upgraded through a rebuilt image for persistence.

Official installation reference: [Codex CLI](https://developers.openai.com/codex/cli).

## Muse lifecycle

One `muse serve` process serves **one turn**. Subsequent turns resume the saved native session in a new process. Webcode uses the official `@muse-code/sdk` facade for handshake, session start/resume, turn streaming, and approvals. Model listing, model selection, approval-mode changes, and interruption use the SDK connection's protocol commands because those verbs are not on the facade.

Muse sandbox posture is fixed for the host lifetime and is selected from Webcode permission modes:

| Mode        | Serve flags                                                                             | Approval mode |
| ----------- | --------------------------------------------------------------------------------------- | ------------- |
| Read only   | `--disable-write --disable-shell --sandbox-network restricted` | denyUnmatched |
| Workspace   | default sandbox, `--trust-workspace`                           | onRequest     |
| Full access | `--disable-sandbox`                                            | allowAll      |

The adapter requires durable sessions and refuses ephemeral hosts (`--no-session-log`). Discovery uses a memory-only host so model probes do not write session logs. The host process is spawned with the project as `cwd` and `PWD`; `muse serve` does not accept `--workspace`. Execution keeps the durable log and gives the host several seconds to drain on close so that log can flush. It validates the selected Meta model, maps Muse Spark reasoning efforts, and sends images as MSP image parts capped at 5 MB so they fit the protocol frame limit. Other attachments are named as reference data, not instructions. Native approval IDs stay inside the adapter. Clarifying prompts that Webcode cannot render are declined with a warning; the turn is not left hanging. Streaming deltas that arrive before their item are buffered, then emitted in order.

Muse Code is installed with Meta's official installer, not npm. Settings show version and health; in-app updating is not offered. Authenticate the VPS user with `muse login` or `META_API_KEY`. Account usage is not exposed over MSP. The composer still shows the limits control, in the same unavailable state as Grok.

Official references: [Muse Code](https://ai.developer.meta.com/docs/muse-code), [SDK](https://github.com/meta-models/muse-code-sdk).

## Grok lifecycle

One `grok agent stdio` process serves **one turn**. Subsequent turns resume the saved ACP session in a new process. Webcode speaks Agent Client Protocol v1 over newline-delimited JSON-RPC. Do not call the xAI chat API from this adapter, and do not use `grok -p`.

Grok sandbox posture is fixed for the process lifetime and is selected from Webcode permission modes:

| Mode        | Spawn flags                                                        | Session `_meta`                          |
| ----------- | ------------------------------------------------------------------ | ---------------------------------------- |
| Read only   | `grok --cwd <project> --sandbox read-only agent --no-leader stdio` | none (ask)                               |
| Workspace   | `grok --cwd <project> --sandbox workspace agent --no-leader stdio` | none (ask; `session/request_permission`) |
| Full access | `grok --cwd <project> agent --no-leader stdio`                     | `yoloMode: true`                         |

`--cwd`, sandbox, and `--no-auto-update` are global CLI flags and must come before `agent`. `--cwd` is the absolute project path so Grok's sandbox does not canonicalize `.`. The adapter advertises no client filesystem or terminal capabilities; Grok owns tools. It authenticates with a cached Grok login or `XAI_API_KEY`, reads models from initialize `_meta.modelState`, and sets model/reasoning through `session/set_config_option`. Images are ACP image parts; other attachments are named as reference data. Native ACP identifiers stay inside the adapter.

Authenticate the VPS user with `grok login --device-auth` or `XAI_API_KEY`. Settings show version and health; in-app updating is not offered. Account usage is not exposed over ACP, so the composer limits indicator stays unavailable for Grok.

Official references: [Grok Build](https://docs.x.ai/build/overview), [ACP](https://agentclientprotocol.com).

Homebrew update reference: [Homebrew upgrade](https://docs.brew.sh/Manpage#upgrade-options-installed_formula-installed_cask-). Automatic cleanup and unrelated dependent checks are disabled for the scoped Codex upgrade.
