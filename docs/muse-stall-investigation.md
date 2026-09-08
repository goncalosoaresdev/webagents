# Muse stall investigation — 2026-09-08

## Observed incidents

Read-only inspection of the local workspace database found:

- Standalone Muse turn `5a0b77e0-a78b-4334-b4f2-3edc29b9e6d0`: started at 13:49:50 UTC, interrupted at 14:02:01 UTC, with no persisted provider activity between those events.
- Orchestrated turn `b58ee3fe-549f-4a7d-a1ae-b94a9f1b2f60`: Codex planning completed, Muse work began at 14:26:24 UTC, the last recorded tool completed at 14:30:31 UTC, and the worker was interrupted at 14:52:18 UTC. Review never began. The last recorded tool itself completed successfully; these records do not prove why Muse subsequently stopped emitting activity.
- An earlier Codex → Muse → Codex execution completed all three phases. This is an intermittent failure, not a universal provider-pair rejection.

## Findings and changes

1. Model listing, session opening/resuming, configuration and turn submission after handshake shared a 30-minute idle watchdog. Added an overall startup deadline (60 seconds by default, configurable with the runtime timeout option), with an explicit error and no automatic replay.
2. Unsupported user questions were cancelled through an unbounded protocol command. Cleanup awaited that command even after cancellation or completion. Cancellation now observes the turn signal and a 15-second command deadline (or configured timeout). A rejection or deadline fails the turn with a specific explanation.
3. A successful interruption acknowledgement cleared the fallback timer even if Muse never sent its terminal event. Stop now aborts local execution after the bounded interrupt attempt, allowing host cleanup and task settlement.
4. Runtime warning events were persisted but omitted from the response UI. They now render in ordinary responses and the corresponding orchestration phase. Muse emits an inactivity warning after one minute without item/delta activity. The existing 30-minute hard inactivity deadline remains to accommodate long-running tools; approval waiting pauses inactivity timers.

The orchestration state machine correctly withheld review while its worker had not completed. Muse runtime cleanup could therefore hold up the entire sequence. No independent orchestration scheduler defect was established from these incidents.

## Verification and limits

TypeScript checking passes. Three added controlled MSP regression scenarios pass using Node's built-in TypeScript transformation. Twelve existing runtime scenarios and five client/catalog/permission tests also passed. The normal test runner fails in the local esbuild installation; SQLite integration fails loading better-sqlite3. The warning-render regression was added but could not execute through that runner. Full-suite and live-provider/browser verification remain outstanding. No production deployment or user task replay was performed.
