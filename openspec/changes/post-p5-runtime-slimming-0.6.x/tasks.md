# Tasks: Post-P5 Runtime Slimming

## Baseline

- [x] Record current production LOC for `extensions/octoclaw-runtime/src`.
- [x] Record current test LOC for `extensions/octoclaw-runtime/src`.
- [x] Run `git status --short` and note unrelated dirty files.
- [x] Confirm P5 guard still passes:

```bash
pnpm vitest run extensions/octoclaw-runtime/src/runtime-host/p5-slimming-guard.test.ts
```

## P6-A: Delete Dead Legacy Runtime-Ledger Config

- [x] Search references:

```bash
rg -n "OCTOCLAW_LEGACY_RUNTIME_LEDGER|resolveLegacyRuntimeLedgerMode|legacyRuntimeLedgerMode|RuntimeLedgerLegacyMode" extensions packages tools -g '*.ts'
```

- [x] Remove `RuntimeLedgerLegacyMode`.
- [x] Remove `resolveLegacyRuntimeLedgerMode()`.
- [x] Remove `legacyRuntimeLedgerMode` from `PlannerSpawnConfig`.
- [x] Update `resolvePlannerSpawnConfig()` tests.
- [x] Add/keep a guard that `OCTOCLAW_LEGACY_RUNTIME_LEDGER` is absent from
      live runtime code.
- [x] Verify:

```bash
pnpm vitest run extensions/octoclaw-runtime/src/config/index.test.ts
pnpm check
```

## P6-B: Remove Legacy Heuristic Env Switch Only

- [x] Search references:

```bash
rg -n "OCTOCLAW_LEGACY_HEURISTIC_MODE|resolveLegacyHeuristicMode|legacyHeuristicVerdict|legacy_heuristic" extensions/octoclaw-runtime/src -g '*.ts'
```

- [x] Remove `resolveLegacyHeuristicMode()`.
- [x] Remove env reads of `OCTOCLAW_LEGACY_HEURISTIC_MODE`.
- [x] Keep `legacyHeuristicVerdict()` as read-only compatibility.
- [x] Keep `legacy_heuristic_fallback_used` replay event.
- [x] Update tests to assert read-only behavior without an env switch.
- [x] Do not remove `legacy-heuristics.ts` unless old-record display migration
      is explicitly approved in a separate change.
- [x] Verify:

```bash
pnpm vitest run \
  extensions/octoclaw-runtime/src/state/legacy-heuristics.test.ts \
  extensions/octoclaw-runtime/src/tools/runtime-status.test.ts \
  extensions/octoclaw-runtime/src/tools/runtime-task-projection.test.ts \
  extensions/octoclaw-runtime/src/runtime-host/p5-slimming-guard.test.ts
pnpm check
```

## P6-C: Remove Slack CLI Delivery Rollback

- [x] Search references:

```bash
rg -n "OCTOCLAW_LEGACY_CLI_DELIVERY|legacyCliDeliveryEnabled|executeLegacyCliSend|legacy_cli" extensions/octoclaw-runtime/src -g '*.ts'
```

- [x] Rewrite tests that set `OCTOCLAW_LEGACY_CLI_DELIVERY` to use Slack API
      mocks or delivery envelope assertions.
- [x] Remove `legacyCliDeliveryEnabled()`.
- [x] Remove `executeLegacyCliSend()`.
- [x] Make `sendText()` always call `executeSlackApiSend()` for Slack delivery.
- [x] Remove live docs that advertise Slack CLI rollback.
- [x] Decide whether type unions keep `legacy_cli` only for persisted old
      records; if kept, document that it is render-only.
- [x] Verify:

```bash
pnpm vitest run \
  extensions/octoclaw-runtime/src/im/slack/slack-adapter.test.ts \
  extensions/octoclaw-runtime/src/im/slack/slack-smoke.test.ts \
  extensions/octoclaw-runtime/src/delegate/native-spawn-gate-confirm.test.ts \
  extensions/octoclaw-runtime/src/ack/__tests__/route-commit-ack.test.ts \
  extensions/octoclaw-runtime/src/ack/__tests__/delegate-without-dispatch.test.ts \
  extensions/octoclaw-runtime/src/ack/__tests__/execution-transition-notifier.test.ts
pnpm check
```

## P6-D: Collapse Native ACP Fallback Mode

- [x] Search references:

```bash
rg -n "OCTOCLAW_NATIVE_ACP_FALLBACK_MODE|NativeAcpFallbackMode|resolveNativeAcpFallbackMode|delegate_backend_unavailable|buildEnforceFallbackReplayMetadata|shouldDelegateBackendUnavailableToNative" extensions/octoclaw-runtime/src -g '*.ts'
```

- [x] Keep reading OpenClaw `acp.fallbacks`.
- [x] Remove OctoClaw-side `delegate_backend_unavailable` mode.
- [x] Replace dispatch metadata with host-owned fallback observation.
- [x] Update tests to prove OctoClaw does not self-manage backend failover.
- [x] Verify:

```bash
pnpm vitest run \
  extensions/octoclaw-runtime/src/delegate/native-acp-fallback.test.ts \
  extensions/octoclaw-runtime/src/tools/registration-planner.test.ts \
  extensions/octoclaw-runtime/src/tools/registration-dispatch-honesty.test.ts \
  extensions/octoclaw-runtime/src/runtime-host/openclaw-adapter.test.ts
pnpm check
```

## P6-E: Consolidate Runtime Payload Helpers

- [x] Confirm helper imports are local-only:

```bash
rg -n "payloads/fast-reply|payloads/delegation|buildTsRuntimeDispatchPayload|buildTsRuntimeSpawnPayload" extensions packages tools -g '*.ts'
```

- [x] If helpers are only used by `runtime-payloads.ts`, inline or co-locate
      them without changing payload shape.
- [x] Keep public `runtime-payloads.ts` exports stable unless consumer search
      proves safe removal.
- [x] Verify:

```bash
pnpm vitest run \
  extensions/octoclaw-runtime/src/runtime-payloads.test.ts \
  extensions/octoclaw-runtime/src/resolve/policy-resolver-judge-fallback.test.ts \
  extensions/octoclaw-runtime/src/tools/registration-dispatch-honesty.test.ts
pnpm check
```

## Final Closeout

- [x] Run targeted suites for every touched phase.
- [x] Run:

```bash
pnpm check
pnpm test
git diff --check
```

- [x] Record before/after production LOC and test LOC.
- [x] Record deleted flags/functions/files.
- [x] Confirm none of these strings remain in live code/non-archive docs unless
      intentionally render-only:

```text
OCTOCLAW_LEGACY_RUNTIME_LEDGER
OCTOCLAW_LEGACY_HEURISTIC_MODE
OCTOCLAW_LEGACY_CLI_DELIVERY
OCTOCLAW_NATIVE_ACP_FALLBACK_MODE
delegate_backend_unavailable
```

- [x] Leave runtime-ledger ticket enforcement intact.
- [x] Leave WorkContract intact.
- [x] Do not mark complete if Slack delivery tests are weakened.

## Implementation Notes

### LOC

| Step | Production LOC | Test LOC |
| --- | ---: | ---: |
| Baseline | 40368 | 32804 |
| After P6-A | 40357 | 32775 |
| After P6-B | 40351 | 32785 |
| After P6-C | 40181 | 32535 |
| After P6-D | 40127 | 32530 |
| After P6-E / final | 39958 | 32115 |

Net from P6 baseline: production -410, tests -689, total -1099.

### Deleted Or Collapsed

- P6-A: `RuntimeLedgerLegacyMode`, `resolveLegacyRuntimeLedgerMode()`, `PlannerSpawnConfig.legacyRuntimeLedgerMode`.
- P6-B: `OCTOCLAW_LEGACY_HEURISTIC_MODE` env switch and resolver; retained `legacyHeuristicVerdict()` as old-record read-only display compatibility.
- P6-C: `OCTOCLAW_LEGACY_CLI_DELIVERY`, `legacyCliDeliveryEnabled()`, `executeLegacyCliSend()`, Slack CLI payload parsing path. `legacy_cli` remains only in the broad delivery result transport type for persisted old-record tolerance.
- P6-D: `OCTOCLAW_NATIVE_ACP_FALLBACK_MODE`, `NativeAcpFallbackMode`, `resolveNativeAcpFallbackMode()`, `shouldDelegateBackendUnavailableToNative()`, and enforcement replay metadata builder. Dispatch now records host-owned `openclaw_acp` fallback observation.
- P6-E: deleted the standalone `payloads/fast-reply` and `payloads/delegation` helper trees after co-locating runtime-only helpers in `runtime-payloads.ts`.

### Verification

- P6 targeted suites: passed.
- `pnpm check`: passed.
- `pnpm test`: 149 files passed; 1949 passed, 1 skipped, 1 todo.
- `git diff --check`: passed.
