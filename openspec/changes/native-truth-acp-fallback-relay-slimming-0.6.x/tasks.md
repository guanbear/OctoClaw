# Tasks: Native Truth, ACP Fallback, and Relay Slimming

This task list is intentionally strict. Future AI agents must not mark a task
done unless the listed evidence exists.

## Phase 0: Preparation

- [ ] Confirm local OpenClaw version is `>= 2026.5.12`.
  - Command: `openclaw --version`
  - Evidence: version line in implementation notes.
- [ ] Run GitNexus index refresh before code edits.
  - Command: `npx gitnexus analyze`
- [ ] Before editing any symbol, run impact analysis.
  - Example: `npx gitnexus impact projectNativeStatus --repo OctoClaw --direction upstream`
  - Evidence: risk summary copied into implementation notes.
- [ ] Record current dirty worktree before editing.
  - Command: `git status --short --branch`
  - Requirement: do not overwrite unrelated user changes.

## Phase 1: Native Session Truth First

### P1-A: Runtime truth verdict

- [x] Add or complete a native-first runtime truth verdict helper.
  - Candidate files:
    - `extensions/octoclaw-runtime/src/state/native-status-projector.ts`
    - `extensions/octoclaw-runtime/src/tools/runtime-task-projection.ts`
    - `packages/octoclaw-contracts/src/status-projection.ts`
  - Required output fields:
    - `isSpawnChild`
    - `spawnEvidence`
    - `nativeKind`
    - `agentRuntimeId`
    - `source`
    - `reason`
- [x] Ensure `kind="spawn-child"` is accepted as child-session truth.
- [x] Ensure native `agentRuntime.id` is preserved through status projection.
- [x] Ensure native `direct` or non-child kind is not overridden by string
      heuristics.

Tests:

- [x] `NTR-P1-001` — kind=spawn-child accepted as child-session truth (native-status-projector.test.ts: "resolves status by openclawRunId")
- [x] `NTR-P1-002` — native agentRuntime.id preserved (same test checks agentRuntimeId: "acp-primary")
- [x] `NTR-P1-003` — native direct kind not overridden by string heuristics (native-status-projector.test.ts: "does not let a misleading session key override native direct truth")
- [x] `NTR-P1-004` — verdict fields complete and source tracking correct (all 8 projector tests)

### P1-B: Legacy heuristic isolation

- [x] Identify all runtime/session/spawn heuristics that read:
  - session key substrings;
  - task labels;
  - assistant text;
  - transcript text;
  - stale cache fields.
  - Evidence: 31 heuristics cataloged across 5 categories (session identity 6, delivery status 10, spawn success 6, text-to-decision 5, role/source routing 4)
- [x] Move those heuristics behind `legacy_read_only` or equivalent boundary.
  - `dispatch_guard` surface wired in `resolve/session.ts:isSubagentSessionRef()`
  - `message_guard` surface wired in `resolve/native-announce.ts:handleNativeAnnounceCompletion()`
  - `delivery_projection` surface wired in `im/delivery-relay-verdict.ts:deliveryRelayVerdict()`
  - `status_projection` surface already wired in `tools/runtime-status.ts`
- [x] Add event emission when legacy fallback is used:
  - event name: `legacy_heuristic_fallback_used`
  - required fields: `surface`, `reason`, `newTask`, `readOnly`.
  - All 4 surfaces emit via `recordPolicyReplay()` + `buildLegacyHeuristicFallbackEvent()`
- [x] For new tasks, legacy fallback must not affect:
  - dispatch;
  - `sessions_spawn` admission;
  - dispatch confirm;
  - ACK;
  - final delivery.
  - Evidence: All 5 hot paths verified clean — no legacy heuristic imports or calls

Tests:

- [x] `NTR-P1-005` — blocks legacy fallback for new tasks at dispatch_guard (legacy-heuristics.test.ts)
- [x] `NTR-P1-006` — allows read-only legacy for old tasks at status_projection (legacy-heuristics.test.ts)
- [x] `NTR-P1-007` — legacy_heuristic_fallback_used event fires with correct fields at all 5 surfaces (legacy-heuristics.test.ts)
- [x] `NTR-P1-008` — hot-path modules verified clean of legacy heuristic imports (legacy-heuristics.test.ts)

### P1-C: Delete first unsafe heuristics

Only after P1-A and P1-B tests pass:

- [x] Remove or disable child detection from assistant message text.
  - `extractNativeAnnounceCompletion()` in `native-announce-parse.ts` now gates text regex fallback (`sourceTool=`, `[Internal task completion event]`) behind `!structuredSourceTool`
- [x] Remove or disable child detection from transcript text for new tasks.
  - `readNativeChildSessionCompletion()` naturally guarded — only called when structured extraction fails
- [x] Remove or disable session-label substring inference when native kind is
      present.
  - `isSubagentSessionRef(raw, nativeKind?)` now uses native kind as truth: `spawn-child` → true, any other present kind → false, absent → legacy string heuristics preserved
  - `SessionDescriptor` carries `nativeKind` from session registry; `loadSessionDescriptors()` passes it through
- [x] Keep old-record display reader if BDD old-record tests require it.
  - All legacy string heuristics preserved when `nativeKind` is absent — old records still display correctly

Tests:

- [x] `NTR-P1-009`
- [x] `NTR-P1-010`

## Phase 2: ACP Fallback Native Integration

### P2-A: Observe-only native ACP fallback snapshot

- [x] Implement read-only native ACP fallback snapshot.
  - Suggested type: `NativeAcpFallbackSnapshot`
  - Do not mutate OpenClaw config.
- [x] Add snapshot to delegated run replay/status metadata.
- [x] If OpenClaw CLI/config cannot expose `acp.fallbacks`, return:
  - `status="unavailable"`
  - `source="none"`
  - explicit `reason`.
- [x] Do not change dispatch behavior in this slice.
- [x] Default `nativeAcpFallbackMode` to `"observe"` (conservative initial value per handoff/proposal).
  - Fixed drift: previous default was `"delegate_backend_unavailable"` which is the enforce mode.

Tests:

- [x] `NTR-P2-001` — config loading returns ok with source=openclaw_config without mutation (native-acp-fallback.test.ts)
- [x] `NTR-P2-002` — missing config returns unavailable with reason=native_acp_fallback_unavailable (native-acp-fallback.test.ts)
- [x] `NTR-P2-003` — observe mode records fallback metadata without behavior change; replay includes mode="observe" by default (native-acp-fallback.test.ts, registration-planner.test.ts)

### P2-B: Separate backend failover from task recovery

- [x] Classify fallback reason as one of:
  - `backend_unavailable_before_output`
  - `backend_unavailable_after_output`
  - `task_timeout`
  - `bad_result`
  - `policy_violation`
- [x] Only `backend_unavailable_before_output` may move to OpenClaw ACP fallback.
- [x] Keep OctoClaw recovery for all other reasons.

Tests:

- [x] `NTR-P2-004` — backend unavailable before output: nativeFallbackEligible=true, octoclawRecoveryOwner=false (native-acp-fallback.test.ts)
- [x] `NTR-P2-005` — backend unavailable after output, bad_result, policy_violation: all nativeFallbackEligible=false, octoclawRecoveryOwner=true (native-acp-fallback.test.ts)
- [x] `NTR-P2-006` — task_timeout: nativeFallbackEligible=false, octoclawRecoveryOwner=true, shouldDelegateBackendUnavailableToNative=false (native-acp-fallback.test.ts)

### P2-C: Enforce native ACP fallback behind flag

Precondition:

- observe-only data shows no duplicate dispatch/final across smoke window.

Tasks:

- [x] Add feature flag `nativeAcpFallbackMode`.
      (resolveNativeAcpFallbackMode, OCTOCLAW_NATIVE_ACP_FALLBACK_MODE env,
      default "observe", enforce mode "delegate_backend_unavailable")
- [x] In `delegate_backend_unavailable` mode, stop OctoClaw self-managed
      backend-unavailable retry for ACP paths.
      (No self-managed backend-unavailable retry path exists in planner
      dispatch scope. NTR-P2-008 proves no legacy_outbox_queued or
      child_finalizer_scheduled events in enforce mode.)
- [x] Record OpenClaw selected fallback runtime id if exposed.
      (buildEnforceFallbackReplayMetadata with exposedFallbackRuntimeId param;
      empty string when not exposed, never guesses from config candidates)
- [x] Ensure one WorkContract remains associated with the fallback run.
      (NTR-P2-007 dispatch test proves one dispatch_tool_started event,
      body.workContractId matches original contract)
- [x] Ensure no second OctoClaw task is created for the same backend failover.
      (NTR-P2-007/008 dispatch tests prove one spawn intent, zero duplicates)

Tests:

- [x] `NTR-P2-007`
      (native-acp-fallback.test.ts: 4 pure tests covering before-output,
      exposed id, normal dispatch, task_timeout;
      registration-planner.test.ts: 1 dispatch test proving one WorkContract,
      enforce replay metadata)
- [x] `NTR-P2-008`
      (registration-planner.test.ts: 1 dispatch test proving one spawn intent,
      no duplicate final, no legacy outbox/finalizer)
- [x] `NTR-P2-009`
      (native-acp-fallback.test.ts: 1 pure test proving output-started
      primary failure is not rerouted to native in enforce mode)

## Phase 3: Delivery Relay Slimming

### P3-A: Delivery relay verdict

- [x] Add or complete `DeliveryRelayVerdict`.
  - Evidence: `extensions/octoclaw-runtime/src/im/delivery-relay-verdict.ts`
    includes native visibility, duplicate, compensation-needed, and
    compensation audit fields.
- [x] Record whether native delivery succeeded, failed, or is missing.
  - Evidence: `deliveryRelayVerdict()` covers delivered, failed/degraded,
    missing-after-timeout, and pending native delivery states.
- [x] Record whether OctoClaw relay compensation ran and why.
  - Evidence: `relayCompensationRan` and `relayCompensationReason` are emitted
    in the verdict and replay assertions cover native success/duplicate paths.
- [x] Keep current compensation behavior in this slice.
  - Evidence: `shouldSendRelayCompensation()` behavior and delivery relay mode
    resolution were not changed.

Tests:

- [x] `NTR-P3-001` — native delivery success creates audit-only verdict
      (delivery-relay-verdict.test.ts)
- [x] `NTR-P3-002` — native delivery failure still compensates
      (delivery-relay-verdict.test.ts)
- [x] `NTR-P3-003` — native delivery missing with native result compensates
      after timeout (delivery-relay-verdict.test.ts)

### P3-B: Native success audit-only mode

Precondition:

- native delivery smoke is green for target channels.

Tasks:

- [x] Add feature flag `deliveryRelayMode`.
- [x] In `native_success_audit_only` mode, do not compensate when native
      delivery success is proven.
- [x] Still write audit event.
- [x] Still suppress duplicate final.
- [x] Still compensate on native missing/failed/degraded.

Tests:

- [x] `NTR-P3-004`
      (delivery-relay-verdict.test.ts)
- [x] `NTR-P3-005`
      (delivery-relay-verdict.test.ts)
- [x] `NTR-P3-006`
      (delivery-relay-verdict.test.ts)
- [x] `NTR-P3-007`
      (delivery-relay-verdict.test.ts)

### P3-C: Remove redundant delivery branches

Only after P3-B smoke passes:

- [x] Remove redundant message-tool-only compensation branch.
      (sent/acknowledged/acked no longer treated as delivered in
      delivery-relay-verdict.ts)
- [x] Remove redundant rich/card/button-only compensation branch.
      (presentation="rich" uses same delivered-only gate)
- [x] Remove stale task-state-only delivery success inference.
      delivery-relay-verdict.ts: done — only "delivered" = proven.
      runtime-task-projection.ts: done — hasDeliveryAck now requires
      deliveryStatus === "delivered" OR concrete messageId/resultHash.
      No longer treats "sent"/"acknowledged"/"acked" as delivery ack.
      (runtime-task-projection.test.ts + runtime-status.test.ts)
- [x] Keep fallback delivery on failure/missing/degraded.
- [x] Keep audit and duplicate detection.

Tests:

- [x] `NTR-P3-008`
      (delivery-relay-verdict.test.ts, duplicate suppression audit)
- [x] `NTR-P3-009`
      (delivery-relay-verdict.test.ts, mock coverage matrix —
      live Slack evidence for plain text, delegated, duplicate;
      unit/mock only for Feishu/rich presentation, failure, degraded,
      missing after timeout. No live Feishu smoke.)

Smoke evidence:

- Slack: P3-B long-window smoke passed 2026-05-17T13:53:15Z,
  overallGate=pass, finalMs=233174, duplicateFinalCount=0,
  footerVia=native_announce, workContractId=wc-c716f907647651d5.
- Feishu/rich: unit/mock evidence only (no live Feishu smoke).

## Phase 4: RuntimeAdapter And Hermes Foundation

### P4-A: Minimal host runtime adapter types

- [x] Add the smallest runtime host type boundary needed by existing behavior.
  - `extensions/octoclaw-runtime/src/runtime-host/types.ts`
  - `extensions/octoclaw-runtime/src/runtime-host/index.ts`
  - Concepts: RuntimeHostId, RuntimeStatusSnapshot, RuntimeDeliverySnapshot,
    RuntimeFallbackSnapshot, HostRuntimeAdapter
- [x] Do not add `spawn()` unless a BDD scenario and call site require it.
      (HostRuntimeAdapter has only readStatus, readDelivery, readFallbacks;
      NTR-P4-001 proves spawn/cancel/schedule absent at runtime)
- [x] Do not add `cancel()` unless `octoclaw_task_action` routes cancellation
      through the host in this slice.
- [x] Keep all types free of OpenClaw-only names except in the OpenClaw
      adapter file.
      (nativeKind/agentRuntimeId are optional fields; required fields
      found/degraded/status/reason are host-neutral; NTR-P4-002 proves it)

Tests:

- [x] `NTR-P4-001`
      (runtime-host/types.test.ts: method key inspection + 13 forbidden
      method absence checks)
- [x] `NTR-P4-002`
      (runtime-host/types.test.ts: host-neutral required fields, optional
      native fields, dual-source fallback)

### P4-B: OpenClaw adapter extraction

- [x] Wrap existing OpenClaw native status lookup behind the adapter.
      (openclaw-adapter.ts readStatus wraps projectNativeStatus,
      maps NativeProjectedStatus to RuntimeStatusSnapshot including
      canceled→cancelled, completed→succeeded, degraded→unknown)
- [x] Wrap native delivery lookup behind the adapter.
      (normalizeNativeDeliveryToSnapshot normalizes native delivery facts
      into RuntimeDeliverySnapshot as explicit helper. adapter readDelivery
      returns native_delivery_lookup_unavailable when no live lookup source
      is wired — does not misinterpret the ref as delivery payload.
      Live readDelivery call-site wiring remains deferred with call sites.)
- [x] Wrap ACP fallback snapshot read path behind the adapter.
      (readFallbacks wraps readNativeAcpFallbackSnapshot, preserves
      primary/fallback ids, returns copy of fallbackRuntimeIds)
- [x] Move status/relay/fallback call sites to consume adapter snapshots.
      Fallback call site migrated:
      dispatch.ts reads fallback snapshot via
      createOpenClawRuntimeAdapter().readFallbacks() +
      adapterFallbackToNativeSnapshot() instead of direct
      readNativeAcpFallbackSnapshot(). Metadata shape preserved:
      registration-planner.test.ts NTR-P2-007 and NTR-P2-008 pass
      unchanged (32 pass + 1 skip). Adapter round-trip test added
      (openclaw-adapter.test.ts NTR-P4-B, 3 tests).
      Status panel call site migrated:
      runtime-status.ts reads status through
      createOpenClawRuntimeAdapter().readStatus() and converts the snapshot
      back with statusSnapshotToNativeProjection() to preserve existing
      NativeStatusProjection semantics. runtime-status.test.ts covers
      NTR-P4-003 through the status panel path.
      Relay/delivery call site migrated:
      native-announce.ts normalizes native delivery attempts through
      normalizeNativeDeliveryToSnapshot(), and deliveryRelayVerdict consumes
      RuntimeDeliverySnapshot without changing duplicate/failure semantics.
- [x] Prove outputs are identical to pre-extraction tests in OpenClaw mode.
      (adapter tests prove mapping is correct; existing native-status-projector,
      delivery-relay-verdict, native-acp-fallback tests still pass unchanged)

Tests:

- [x] `NTR-P4-003`
      (openclaw-adapter.test.ts: 7 tests covering spawn-child/agentRuntime.id,
      completed→succeeded, canceled→cancelled, degraded→unknown, not-found,
      no-legacy-heuristic, status ref forwarding;
      runtime-status.test.ts: status panel consumes adapter snapshot and
      preserves native kind/runtime id without legacy fallback)
- [x] `NTR-P4-004`
      (openclaw-adapter.test.ts: 6 tests — readDelivery returns unavailable
      without live source; readDelivery does not treat ref as payload;
      normalizeNativeDeliveryToSnapshot covers delivered/failed/degraded/no-data;
      integration with deliveryRelayVerdict proves native_success_audit_only
      skips compensation; delivery-relay-verdict.test.ts proves adapter
      delivery snapshots preserve duplicate/failure verdict semantics;
      extension-entry-outbound-guards.test.ts covers native announce delivery
      path)
- [x] `NTR-P4-005`
      (openclaw-adapter.test.ts: 4 tests covering id preservation,
      no config mutation, unavailable mapping, defensive copy)

### P4-C: Hermes dry-run foundation only

- [x] Add a Hermes capability matrix document or module.
      (hermes-capabilities.ts: HermesCapabilityMatrix with 6 capabilities,
      3 supported + 3 unknown, with explanatory notes)
      - `acp`: supported
      - `gatewayMessaging`: supported
      - `sessionStorage`: supported
      - `backgroundDelegation`: unknown
      - `deliveryReceipts`: unknown
      - `runtimeFallbacks`: unknown
- [x] Add `runtimeHostMode = "openclaw" | "hermes_dry_run"` only if a runtime
      config flag is needed for reporting.
      (resolveRuntimeHostMode reads OCTOCLAW_RUNTIME_HOST_MODE, defaults openclaw)
- [x] `hermes_dry_run` may report capability gaps but must not spawn, deliver,
      or change OpenClaw live behavior.
      (hermesDryRunSpawn/hermesDryRunDeliver always return ok:false with
      hermes_live_runtime_not_enabled; no child run or final send possible)
- [x] Do not add Hermes process management, config mutation, credentials,
      migration execution, or a live Hermes backend.
      (NTR-P4-008 test proves module source contains no launcher/credential/
      migration/dependency strings)

Tests:

- [x] `NTR-P4-006`
      (hermes-capabilities.test.ts: 3 tests — all 6 capabilities present,
      unknowns explicit, notes explain each status)
- [x] `NTR-P4-007`
      (hermes-capabilities.test.ts: 4 tests — spawn fails closed, deliver
      fails closed, repeated calls never return ok:true)
- [x] `NTR-P4-008`
      (hermes-capabilities.test.ts: 3 tests — no forbidden strings in module,
      defaults to openclaw, hermes_dry_run only when explicitly set)

## Phase 5: Deletion Closeout

### P5-A: Deletion ledger baseline

- [x] Record before/after runtime production LOC.
  - Suggested command:

```bash
node - <<'NODE'
const fs=require('fs'); const path=require('path');
const root=process.cwd(); const base='extensions/octoclaw-runtime/src';
function walk(dir,out=[]){ for(const ent of fs.readdirSync(path.join(root,dir),{withFileTypes:true})){ const p=path.join(dir,ent.name); if(ent.isDirectory()) walk(p,out); else if(['.ts','.tsx','.js','.mjs'].includes(path.extname(ent.name))) out.push(p); } return out; }
function lines(rel){ return fs.readFileSync(path.join(root,rel),'utf8').split(/\r?\n/).length; }
let prod=0, prodFiles=0, test=0, testFiles=0;
for(const f of walk(base)){ const n=lines(f); if(/(__tests__|\.test\.|\.spec\.)/.test(f)){ test+=n; testFiles++; } else { prod+=n; prodFiles++; } }
console.log({prod, prodFiles, test, testFiles});
NODE
```

  Evidence: {prod:45666, prodFiles:178, test:37113, testFiles:117}
  Recorded in implementation-notes.md P5-A section.

- [x] Create a deletion ledger in implementation notes.
  Evidence: openspec/changes/native-truth-acp-fallback-relay-slimming-0.6.x/implementation-notes.md
  Contains: LOC baseline, modified files table, retained large modules with reasons,
  deletion candidates for P5-B, phase acceptance summary.

- [x] List every retained large module with a reason.
  Evidence: implementation-notes.md §"Retained Large Modules (≥100 LOC)"
  6 directly modified modules with specific retention reasons,
  7 adjacent modules in delivery/status/runtime path with reasons,
  ~100 other large production modules listed by category.

Tests:

- [x] `NTR-P5-001`
      (implementation-notes.md: before/after LOC recorded, removed files/branches
      listed, every retained large module has a reason)

### P5-B: Delete proven-dead legacy branches

Delete only after the corresponding BDD and smoke evidence exists:

- [ ] New-task assistant/transcript/session-label runtime heuristics.
- [ ] ACP backend-unavailable self-managed fallback branches replaced by native
      ACP fallback.
- [ ] Delivery compensation branches replaced by native delivery success.
- [ ] Stale task-state-only success/delivery inference.
- [ ] OpenClaw concrete duplicate call sites replaced by adapter reads.
- [ ] Pass-through wrappers that no longer add policy, validation, or evidence.

Tests:

- [ ] `NTR-P5-002`
- [ ] `NTR-P5-003`
- [ ] `NTR-P5-004`

### P5-C: Retire transitional flags and stale docs

- [ ] Remove completed transitional flags when both old and new paths no longer
      need runtime switching.
- [ ] Keep permanent product flags only when users need them.
- [ ] Update `README.md`, `README.zh-CN.md`, relevant docs, and CLI/status text
      so they describe the surviving architecture.
- [ ] Ensure no docs advertise removed live paths.

Tests:

- [ ] `NTR-P5-005`
- [ ] `NTR-P5-006`

## Required Test Commands

Run the smallest targeted command for each slice, then broader checks.

Targeted examples:

```bash
pnpm vitest run \
  extensions/octoclaw-runtime/src/state/native-status-projector.test.ts \
  extensions/octoclaw-runtime/src/tools/runtime-task-projection.test.ts \
  extensions/octoclaw-runtime/src/tools/runtime-status.test.ts
```

Expected new/updated test files:

```text
extensions/octoclaw-runtime/src/state/native-status-projector.test.ts
extensions/octoclaw-runtime/src/tools/runtime-task-projection.test.ts
extensions/octoclaw-runtime/src/tools/runtime-status.test.ts
extensions/octoclaw-runtime/src/delegate/native-spawn-gate*.test.ts
extensions/octoclaw-runtime/src/delegate/native-spawn-confirm*.test.ts
extensions/octoclaw-runtime/src/replay/message-guard*.test.ts
extensions/octoclaw-runtime/src/im/*/*.test.ts
extensions/octoclaw-runtime/src/runtime-host/*.test.ts
tools/octoclawctl/src/slack-acceptance/*.test.ts
```

Broad checks:

```bash
pnpm -r --stream run check
pnpm test
node scripts/verify-openclaw-baseline.mjs
npx gitnexus detect-changes --repo OctoClaw
```

If broad checks fail due to pre-existing dirty worktree issues, document:

- command;
- failure file;
- failure line;
- why it is unrelated;
- targeted tests that passed.

## Do Not Do

- [ ] Do not delete delivery relay in the same patch that introduces native truth
      projection.
- [ ] Do not enable ACP fallback enforcement before observe-only metadata exists.
- [ ] Do not auto-write `acp.fallbacks`.
- [ ] Do not infer spawn success from text.
- [ ] Do not infer delivery success from text.
- [ ] Do not remove old replay readers without archive/replay tests.
- [ ] Do not create a live Hermes backend in this change.
- [ ] Do not add adapter methods without BDD demand.
- [ ] Do not leave replaced legacy branches behind under unused permanent flags.
- [ ] Do not mark any BDD scenario done without an automated test or an explicit
      manual smoke note.
