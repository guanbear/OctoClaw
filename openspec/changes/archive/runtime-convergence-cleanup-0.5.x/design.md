# Design

## Overview

This change removes old runtime wheels after the planner/native `sessions_spawn -> octoclaw_dispatch_confirm -> native announce` path has become the intended execution path.

The desired runtime is:

```text
user turn
  -> policy/judge/admission
  -> WorkContract sealed in SQLite metadata ledger
  -> NativeSpawnIntent persisted
  -> octoclaw_dispatch returns sessionsSpawnArgs
  -> main agent calls native sessions_spawn
  -> octoclaw_dispatch_confirm records accepted run evidence
  -> OpenClaw native announce/delivery handles child final
  -> OctoClaw projection builder renders status/details/grounding
```

Everything outside that line is either metadata/audit/projection or a migration/import tool. It must not become a second runtime truth source.

## Authority Boundaries

### Execution Lifecycle

OpenClaw native owns:

- child session creation;
- run acceptance;
- run/flow/subagent status;
- native completion announce;
- channel delivery retry/fallback.

OctoClaw must not mark `spawnExecuted=true`, running, completed, delivered, or failed from WorkContract alone, from `task-state.json` alone, from a completion file, or from a fake detached runtime id.

### Metadata

OctoClaw SQLite owns:

- WorkContract JSON and revisions;
- route seal and judge metadata;
- `native_spawn_intents`;
- accepted native refs;
- delegation tickets / attempts / queue metadata where still needed;
- runtime events and diagnostics.

`native_spawn_intents` is an auxiliary planner/confirm table. It is not one of the six original N1 canonical runtime tables, but it is part of the metadata ledger.

### Projection

`task-state.json` is a generated read-model cache. It can be deleted, corrupted, quarantined, and rebuilt. It is useful for operator/status surfaces, but not as a durable truth source.

The projection builder should read:

- SQLite WorkContract/native refs/spawn intents;
- OpenClaw native run/flow/subagent registry where available;
- runtime events/replay tail for diagnostics;
- historical task-state only during explicit migration/backfill.

It should write:

- `task-state.json`;
- status/details packets;
- grounding packets;
- degraded diagnostics.

## Delete-First Policy

Delete means:

- remove default registration/wiring;
- remove normal runtime call sites;
- remove product environment flags that preserve old paths;
- remove tests that assert old runtime behavior;
- keep only import-only migration tests if historical data must still be readable.

Do not hide deleted behavior behind:

- `OCTOCLAW_LEGACY_*`;
- `OCTOCLAW_ENABLE_OLD_*`;
- automatic alias forwarding;
- silent fallback to task-state;
- fake no-op runtime objects;
- direct SDK spawn fallback.

## Work Package Design

### WP-A Docs And Invariants

Add guardrail tests before implementation expands. Tests may initially document current gaps, but they must describe the target as delete-first.

Important assertions:

- planner prompt excludes completion file requirement;
- planner path does not schedule child finalizer;
- planner path does not queue delivery outbox;
- `octoclaw_spawn` is not a target entrypoint;
- task-state truth fallback is not target behavior.

### WP-B SQLite Metadata Default

Make WorkContract store default to SQLite.

Expected changes:

- `resolveRuntimeLedgerFlag()` default becomes `metadata` or enforce-equivalent.
- `saveWorkContract()` writes SQLite first.
- `loadWorkContract()` and `listWorkContractsBySession()` read SQLite first and do not silently fall back to task-state.
- task-state backfill is explicit migration/import, with degraded/backfill event output.
- SQLite open failure is degraded/fail-closed, not empty success.

Risk:

- Some tests may assume task-state-only fixtures. Update those tests to seed SQLite or call the explicit migration helper.

### WP-C Projection Builder

Centralize status projection so task-state is output, not truth.

Expected changes:

- Introduce or converge on a `StatusProjectionBuilder`.
- Replace direct task-state truth reads in ACK/status/details/grounding/watchdog.
- Quarantine corrupt task-state and rebuild from SQLite/native refs.
- Show explicit degraded markers when native registry or SQLite is unavailable.

Risk:

- Many UI/status paths read task-state today. The worker must avoid broad rewrites by replacing readers behind a narrow helper first.

### WP-D Remove Completion File / Child Finalizer

Remove completion file protocol from planner/native runtime.

Expected changes:

- `buildSubagentSpawnMessage()` no longer includes completion path/template/instructions.
- `octoclaw_dispatch` planner path does not create completion binding and does not call `scheduleChildCompletionFinalizer()`.
- startup does not register child-finalizer recovery loop.
- `OCTOCLAW_LEGACY_COMPLETION_FILE` product flag is removed.
- `completion_bindings` is no longer a normal completion gate. If kept temporarily, it is import/orphan diagnostic only.

Risk:

- Some historical tests assert completion timeout. Replace with native announce tests or import-only tests.

### WP-E Remove Delivery Outbox

Remove JSON delivery outbox from runtime.

Expected changes:

- no startup `flushDeliveryOutbox()` interval;
- no normal `queueOutboxDelivery()` call;
- delivery failure recorded to SQLite/replay/projection as pending/degraded;
- no new outbox file writes;
- historical replay import can read old events but cannot drive delivery.

Risk:

- Slack delivery tests must prove failure is visible and not falsely delivered.

### WP-F Remove Legacy Entrypoints

Remove public ways to bypass planner/dispatch.

Expected changes:

- `octoclaw_spawn` tool registration deleted.
- `octoclaw_spawn` removed from tool policy/system prompt allowlists.
- no alias to dispatch; old tool calls fail fast with guidance.
- direct `runtime.subagent.run()` fallback deleted from planner backend.
- fake detached runtime registration deleted.

Risk:

- Old docs/tests may refer to `octoclaw_spawn`. Update docs to say it is removed.

### WP-G Smoke And Audit

After WP-B through WP-F:

- run focused test matrix;
- run full `pnpm test` and `pnpm check` when practical;
- run Slack/acceptance smoke when credentials/environment exist;
- record metrics in tasks.md and reports.

Required smoke fields:

- thread ts;
- WorkContract id;
- spawnIntentId;
- runId;
- childSessionKey;
- `native_announce_completion_matched` count;
- `completion_file_timeout` count;
- `legacy_outbox_queued` count;
- duplicate final count;
- footer route/via;
- task-state rebuild/degraded marker if exercised.

## Failure Semantics

- SQLite unavailable: degraded/fail closed, no silent empty task list.
- Native registry unavailable: projection degraded, no fake running/completed state.
- Missing task-state: rebuild if possible.
- Corrupt task-state: quarantine and rebuild if possible.
- Delivery failure: pending/degraded, not delivered.
- Old tool call: fail fast and point to `octoclaw_dispatch`.
- No native accepted run id: no `spawnExecuted=true`, no delegate accepted ACK.

## Test Strategy

Use focused tests for each work package, then integration smoke.

Focused examples:

```bash
pnpm vitest run extensions/octoclaw-runtime/src/config/index.test.ts extensions/octoclaw-runtime/src/tools/registration-planner.test.ts
pnpm vitest run extensions/octoclaw-runtime/src/runtime-ledger/__tests__/runtime-ledger.test.ts extensions/octoclaw-runtime/src/work-contract/store.test.ts
pnpm vitest run extensions/octoclaw-runtime/src/runtime-ledger/__tests__/projection-rebuild.test.ts extensions/octoclaw-runtime/src/state/native-status-projector.test.ts
pnpm vitest run extensions/octoclaw-runtime/src/delegate/child-finalizer.test.ts extensions/octoclaw-runtime/src/extension-entry.test.ts
pnpm vitest run extensions/octoclaw-runtime/src/delivery/delivery-outbox.test.ts extensions/octoclaw-runtime/src/im/slack/slack-adapter.test.ts
pnpm vitest run extensions/octoclaw-runtime/src/tools/manifest-contracts.test.ts extensions/octoclaw-runtime/src/tools/registration-dispatch-honesty.test.ts
pnpm --filter @octoclaw/runtime run check
```

Full checks:

```bash
pnpm test
pnpm check
```

## Review Checklist

Reviewers must reject changes that:

- reintroduce task-state truth fallback;
- add long-lived compatibility flags;
- alias `octoclaw_spawn` to dispatch;
- use completion files for new planner/native runtime;
- queue delivery outbox for new runtime;
- treat WorkContract refs as execution status;
- create fake runtime capabilities;
- skip tests for the real live path.
