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

- [ ] Add or complete a native-first runtime truth verdict helper.
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
- [ ] Ensure `kind="spawn-child"` is accepted as child-session truth.
- [ ] Ensure native `agentRuntime.id` is preserved through status projection.
- [ ] Ensure native `direct` or non-child kind is not overridden by string
      heuristics.

Tests:

- [ ] `NTR-P1-001`
- [ ] `NTR-P1-002`
- [ ] `NTR-P1-003`
- [ ] `NTR-P1-004`

### P1-B: Legacy heuristic isolation

- [ ] Identify all runtime/session/spawn heuristics that read:
  - session key substrings;
  - task labels;
  - assistant text;
  - transcript text;
  - stale cache fields.
- [ ] Move those heuristics behind `legacy_read_only` or equivalent boundary.
- [ ] Add event emission when legacy fallback is used:
  - event name: `legacy_heuristic_fallback_used`
  - required fields: `surface`, `reason`, `newTask`, `readOnly`.
- [ ] For new tasks, legacy fallback must not affect:
  - dispatch;
  - `sessions_spawn` admission;
  - dispatch confirm;
  - ACK;
  - final delivery.

Tests:

- [ ] `NTR-P1-005`
- [ ] `NTR-P1-006`
- [ ] `NTR-P1-007`
- [ ] `NTR-P1-008`

### P1-C: Delete first unsafe heuristics

Only after P1-A and P1-B tests pass:

- [ ] Remove or disable child detection from assistant message text.
- [ ] Remove or disable child detection from transcript text for new tasks.
- [ ] Remove or disable session-label substring inference when native kind is
      present.
- [ ] Keep old-record display reader if BDD old-record tests require it.

Tests:

- [ ] `NTR-P1-009`
- [ ] `NTR-P1-010`

## Phase 2: ACP Fallback Native Integration

### P2-A: Observe-only native ACP fallback snapshot

- [ ] Implement read-only native ACP fallback snapshot.
  - Suggested type: `NativeAcpFallbackSnapshot`
  - Do not mutate OpenClaw config.
- [ ] Add snapshot to delegated run replay/status metadata.
- [ ] If OpenClaw CLI/config cannot expose `acp.fallbacks`, return:
  - `status="unavailable"`
  - `source="none"`
  - explicit `reason`.
- [ ] Do not change dispatch behavior in this slice.

Tests:

- [ ] `NTR-P2-001`
- [ ] `NTR-P2-002`
- [ ] `NTR-P2-003`

### P2-B: Separate backend failover from task recovery

- [ ] Classify fallback reason as one of:
  - `backend_unavailable_before_output`
  - `backend_unavailable_after_output`
  - `task_timeout`
  - `bad_result`
  - `policy_violation`
- [ ] Only `backend_unavailable_before_output` may move to OpenClaw ACP fallback.
- [ ] Keep OctoClaw recovery for all other reasons.

Tests:

- [ ] `NTR-P2-004`
- [ ] `NTR-P2-005`
- [ ] `NTR-P2-006`

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

- [ ] Add or complete `DeliveryRelayVerdict`.
- [ ] Record whether native delivery succeeded, failed, or is missing.
- [ ] Record whether OctoClaw relay compensation ran and why.
- [ ] Keep current compensation behavior in this slice.

Tests:

- [ ] `NTR-P3-001`
- [ ] `NTR-P3-002`
- [ ] `NTR-P3-003`

### P3-B: Native success audit-only mode

Precondition:

- native delivery smoke is green for target channels.

Tasks:

- [ ] Add feature flag `deliveryRelayMode`.
- [ ] In `native_success_audit_only` mode, do not compensate when native
      delivery success is proven.
- [ ] Still write audit event.
- [ ] Still suppress duplicate final.
- [ ] Still compensate on native missing/failed/degraded.

Tests:

- [ ] `NTR-P3-004`
- [ ] `NTR-P3-005`
- [ ] `NTR-P3-006`
- [ ] `NTR-P3-007`

### P3-C: Remove redundant delivery branches

Only after P3-B smoke passes:

- [ ] Remove redundant message-tool-only compensation branch.
- [ ] Remove redundant rich/card/button-only compensation branch.
- [ ] Remove stale task-state-only delivery success inference.
- [ ] Keep fallback delivery on failure/missing/degraded.
- [ ] Keep audit and duplicate detection.

Tests:

- [ ] `NTR-P3-008`
- [ ] `NTR-P3-009`

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
- [ ] Do not mark any BDD scenario done without an automated test or an explicit
      manual smoke note.
