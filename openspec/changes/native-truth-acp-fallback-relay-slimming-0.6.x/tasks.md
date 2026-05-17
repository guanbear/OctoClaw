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

- [ ] Add feature flag `nativeAcpFallbackMode`.
- [ ] In `delegate_backend_unavailable` mode, stop OctoClaw self-managed
      backend-unavailable retry for ACP paths.
- [ ] Record OpenClaw selected fallback runtime id if exposed.
- [ ] Ensure one WorkContract remains associated with the fallback run.
- [ ] Ensure no second OctoClaw task is created for the same backend failover.

Tests:

- [ ] `NTR-P2-007`
- [ ] `NTR-P2-008`
- [ ] `NTR-P2-009`

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

- [ ] Add the smallest runtime host type boundary needed by existing behavior.
  - Candidate files:
    - `extensions/octoclaw-runtime/src/runtime-host/types.ts`
    - `extensions/octoclaw-runtime/src/runtime-host/index.ts`
  - Required concepts:
    - `RuntimeHostId`
    - `RuntimeStatusSnapshot`
    - `RuntimeDeliverySnapshot`
    - `RuntimeFallbackSnapshot`
    - `HostRuntimeAdapter`
- [ ] Do not add `spawn()` unless a BDD scenario and call site require it.
- [ ] Do not add `cancel()` unless `octoclaw_task_action` routes cancellation
      through the host in this slice.
- [ ] Keep all types free of OpenClaw-only names except in the OpenClaw
      adapter file.

Tests:

- [ ] `NTR-P4-001`
- [ ] `NTR-P4-002`

### P4-B: OpenClaw adapter extraction

- [ ] Wrap existing OpenClaw native status lookup behind the adapter.
- [ ] Wrap native delivery lookup behind the adapter.
- [ ] Wrap ACP fallback snapshot read path behind the adapter.
- [ ] Move status/relay/fallback call sites to consume adapter snapshots.
- [ ] Prove outputs are identical to pre-extraction tests in OpenClaw mode.

Tests:

- [ ] `NTR-P4-003`
- [ ] `NTR-P4-004`
- [ ] `NTR-P4-005`

### P4-C: Hermes dry-run foundation only

- [ ] Add a Hermes capability matrix document or module.
  - Required statuses:
    - `acp`
    - `gatewayMessaging`
    - `sessionStorage`
    - `backgroundDelegation`
    - `deliveryReceipts`
    - `runtimeFallbacks`
- [ ] Add `runtimeHostMode = "openclaw" | "hermes_dry_run"` only if a runtime
      config flag is needed for reporting.
- [ ] `hermes_dry_run` may report capability gaps but must not spawn, deliver,
      or change OpenClaw live behavior.
- [ ] Do not add Hermes process management, config mutation, credentials,
      migration execution, or a live Hermes backend.

Tests:

- [ ] `NTR-P4-006`
- [ ] `NTR-P4-007`
- [ ] `NTR-P4-008`

## Phase 5: Deletion Closeout

### P5-A: Deletion ledger baseline

- [ ] Record before/after runtime production LOC.
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

- [ ] Create a deletion ledger in implementation notes.
- [ ] List every retained large module with a reason.

Tests:

- [ ] `NTR-P5-001`

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
