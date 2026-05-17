# Change: Native Runtime Slimming and Host Adapter Foundation

Date: 2026-05-17
Target release: v0.6.x
OpenClaw baseline: >= 2026.5.12
Related implementation seed:
- `extensions/octoclaw-runtime/src/state/native-status-projector.ts`
- `extensions/octoclaw-runtime/src/tools/runtime-task-projection.ts`
- `extensions/octoclaw-runtime/src/tools/runtime-status.ts`

## Purpose

Make OctoClaw trust OpenClaw native runtime facts first, move backend failover
toward OpenClaw native ACP fallback, shrink OctoClaw delivery relay from a
primary compensation layer into an audit plus last-resort fallback layer, and
introduce a minimal host runtime adapter seam so future Hermes support does not
require rewriting OctoClaw policy.

The goal is not merely fewer lines. The goal is a smaller truth surface:

1. OpenClaw native run/session/delivery facts are execution truth.
2. WorkContract remains semantic and continuity truth.
3. OctoClaw policy decides what should happen.
4. OpenClaw runtime owns backend availability and delivery once native support
   is proven.
5. Legacy heuristics are never allowed to invent new-task facts.
6. Host-runtime-specific code is isolated behind one small adapter boundary.
7. Code reduction is a delivery goal, not a nice-to-have.

## Problem

OctoClaw still carries defensive logic from before OpenClaw exposed stronger
native facts:

- session-kind inference from strings or stale task-state fields;
- contaminated/subagent guards that sometimes infer identity from old context;
- runner/spawn fallback paths that overlap with OpenClaw ACP fallback;
- delivery relay compensation for message-tool-only, rich presentation, and
  card/button-only reply gaps that OpenClaw 2026.5.12 has improved;
- replay/status/patrol paths that can treat cache or heuristics as if they were
  current runtime truth;
- OpenClaw-specific assumptions scattered through policy, status, delivery, and
  recovery call sites, which would make a later Hermes migration look like a
  rewrite instead of an adapter swap.

This makes the code harder to reason about and increases duplicate-dispatch,
duplicate-final, and false-start risk.

## Scope

This change is split into five implementation phases. Do not reorder them.

### Phase 1: Native session truth first

Use OpenClaw native fields as the primary source for child/session/runtime
projection:

- `kind`, especially `spawn-child`;
- `agentRuntime.id`;
- `runId`;
- `flowId`;
- `childSessionKey`;
- native task/run/flow status.

Legacy heuristics may remain only as read-only legacy adapters for old
task-state or replay data. They must be tagged and observable.

### Phase 2: ACP fallback observe, then adopt

Read OpenClaw native ACP fallback configuration and runtime fallback facts.
Initially record them in OctoClaw replay/status only. After observe-only data
proves no double-dispatch or double-answer behavior, move backend-unavailable
failover from OctoClaw self-managed fallback branches to OpenClaw `acp.fallbacks`.

Important distinction:

- Runtime backend unavailable before output: OpenClaw ACP fallback can own it.
- Worker produced bad output, timed out, or violated task contract: OctoClaw
  recovery/retry still owns it.

### Phase 3: Delivery relay slimming

Treat OpenClaw native delivery as authoritative when it exists and is successful.
OctoClaw relay becomes:

- audit log for native delivery;
- duplicate-final detector;
- fallback only when native delivery is missing, failed, or explicitly degraded.

### Phase 4: Host RuntimeAdapter foundation

Move OpenClaw-specific runtime reads/writes behind a minimal adapter boundary.
The adapter exposes only what OctoClaw policy needs:

- spawn/dispatch accepted evidence;
- run/session/status lookup;
- native delivery receipt lookup;
- runtime fallback snapshot;
- cancel/status/action primitives when already supported by the host.

Initial live implementation is OpenClaw only. Hermes support in this change is
limited to:

- a capability matrix;
- disabled/dry-run adapter shape;
- tests proving the OpenClaw path does not import Hermes or change behavior.

Do not implement a live Hermes backend in this change.

### Phase 5: Deletion closeout

After P1-P4 tests and Slack/Feishu smoke pass, delete historical code instead
of wrapping it:

- unsafe new-task heuristics;
- self-managed backend-unavailable fallback branches replaced by native ACP
  fallback;
- delivery compensation branches replaced by native delivery success;
- stale docs and flags that advertise removed live paths;
- pass-through adapters and duplicated status projectors that no longer own
  behavior.

## Non-Goals

- Do not remove WorkContract.
- Do not remove TaskFlow/native run projection.
- Do not add a new task engine.
- Do not add a generic multi-host framework. Add only the minimal
  RuntimeAdapter seam required by current behavior.
- Do not reintroduce ClawTeam/tmux as a default live dependency.
- Do not auto-edit user OpenClaw `acp.fallbacks` configuration.
- Do not delete delivery relay before real Slack/Feishu smoke proves native
  delivery reliability.
- Do not use transcript text or assistant wording as proof that a task spawned,
  completed, or delivered.
- Do not enable Hermes as a live runtime in this change.

## Hard Invariants

1. TaskFlow created does not imply `spawnExecuted`.
2. `spawnExecuted` requires native accepted evidence:
   `kind="spawn-child"` or accepted `runId` or accepted `childSessionKey`.
3. A user-visible "task started" or "delegated" claim requires accepted native
   spawn evidence and dispatch confirm.
4. A user-visible "delivered" claim requires native delivery success or explicit
   OctoClaw fallback delivery success.
5. Legacy heuristic fallback must never affect new-task dispatch, confirm, ACK,
   or delivery decisions.
6. If native registry is unavailable, projections must say `degraded` or `lost`,
   not silently infer success.
7. OpenClaw ACP fallback must not create a second OctoClaw task or second
   user-facing final.
8. RuntimeAdapter must not invent facts; it only normalizes native host facts.
9. Code deletion must happen after behavior is locked by BDD and smoke; do not
   leave legacy branches behind under permanent flags.

## Current Seed State

Already landed before this change package:

- `NativeStatusProjection` includes `nativeKind` and `agentRuntimeId`.
- `statusFromNativeRecord()` extracts `record.kind` / `record.agentRuntime.id`.
- runtime status panel displays `native=<kind>/<runtime-id>`.
- targeted tests cover propagation into runtime projection.
- Runtime extension production code measured on 2026-05-17 is roughly 45k LOC.
  The exact number will drift, but implementation must report before/after LOC
  for `extensions/octoclaw-runtime/src` and explain any major module that stays
  large.

This package continues from that seed. Do not redo it unless tests show drift.

## Acceptance Gate

This change is complete only when all gates pass:

- [ ] New-task status projection is native-first and never uses legacy string
      inference when native facts exist.
- [ ] Legacy heuristic fallback emits observable reason codes and is read-only.
- [ ] A coverage report shows legacy fallback hit count for new tasks is zero
      across the selected smoke window.
- [ ] OpenClaw ACP fallback config/facts are read and recorded in replay/status
      in observe-only mode.
- [ ] Backend-unavailable fallback is handled by OpenClaw ACP fallback behind a
      feature flag with no duplicate task or duplicate final.
- [ ] Delivery relay is bypassed for proven native delivery success behind a
      feature flag.
- [ ] Native delivery failure/missing/degraded still triggers OctoClaw fallback.
- [ ] OpenClaw-specific runtime access flows through a minimal
      `RuntimeAdapter` boundary.
- [ ] Hermes migration foundation exists as capability mapping and dry-run
      adapter shape only; it does not affect live OpenClaw behavior.
- [ ] Legacy code replaced by native truth/fallback/delivery is deleted, not
      hidden under unused flags.
- [ ] Runtime production LOC is materially lower than baseline, with a deletion
      ledger listing removed files/branches and retained-risk explanations.
- [ ] Slack and Feishu smoke cover plain text, rich/card/button-only, delegated
      final, and message-tool-only replies.
- [ ] `pnpm -r --stream run check` passes or any unrelated pre-existing failure
      is documented with file and error.
- [ ] Targeted Vitest suites in `bdd.md` pass.

## Rollout Flags

Use feature flags. Do not skip observe-only rollout.

Suggested flags:

```typescript
nativeTruthMode: "observe" | "enforce";
legacyHeuristicMode: "read_only" | "disabled";
nativeAcpFallbackMode: "observe" | "delegate_backend_unavailable";
deliveryRelayMode: "compensate" | "native_success_audit_only";
runtimeHostMode: "openclaw" | "hermes_dry_run";
```

Default values for first implementation:

```typescript
nativeTruthMode = "observe";
legacyHeuristicMode = "read_only";
nativeAcpFallbackMode = "observe";
deliveryRelayMode = "compensate";
runtimeHostMode = "openclaw";
```

## AI Execution Contract

Future AI implementers must follow these rules:

1. Start with tests from `bdd.md`.
2. Implement one phase at a time.
3. Never delete a legacy branch before adding telemetry that proves whether it is
   still used.
4. Never use a prompt, assistant message, transcript snippet, session label, or
   task title as runtime fact.
5. Do not change delivery behavior and ACP fallback behavior in the same patch.
6. Keep every behavior switch behind a named flag until smoke passes.
7. If a test requires real Slack/Feishu credentials, mark it as smoke/manual and
   add a mock equivalent that runs in CI.
8. Do not introduce a live Hermes dependency. Phase 4 is adapter extraction and
   capability mapping only.
9. Every phase after P1 must remove more runtime complexity than it adds, or the
   implementer must document why the temporary increase is necessary and which
   P5 deletion task will remove it.
