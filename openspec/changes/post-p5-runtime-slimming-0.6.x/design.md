# Design: Post-P5 Runtime Slimming

## Current Evidence

P5 hard deletion left runtime production LOC around 40k. The largest remaining
runtime areas are still active:

- `resolve/`
- `tools/`
- `ack/`
- `im/`
- `hooks/`
- `delegate/`
- `state/`
- `runtime-ledger/`

This change should not try to delete these by directory. It should remove
specific historical switches and adapter tails with live evidence.

## Candidate Risk Matrix

| Candidate | Risk | Why | Default Decision |
| --- | --- | --- | --- |
| `OCTOCLAW_LEGACY_RUNTIME_LEDGER` | Low | Config output appears unused outside tests | Delete in P6-A |
| `OCTOCLAW_LEGACY_HEURISTIC_MODE` | Low/Medium | Switch is removable, helper still protects old records | Delete env switch only in P6-B |
| `OCTOCLAW_LEGACY_CLI_DELIVERY` | Medium/High | Slack rollback path may be useful if Slack API breaks | Delete only after tests/smoke in P6-C |
| `OCTOCLAW_NATIVE_ACP_FALLBACK_MODE` | Medium | Directionally obsolete, but dispatch metadata tests depend on it | Collapse carefully in P6-D |
| `runtime-payloads.ts` helper boundaries | Medium | Active dispatch/spawn payload path | Consolidate only after behavior locks in P6-E |
| runtime-ledger ticket/attempt/event tables | High | Hot path uses them for ticket enforcement and confirm | Do not delete |

## P6-A: Legacy Runtime Ledger Config

### Observed references

Live source currently defines:

- `RuntimeLedgerLegacyMode`
- `resolveLegacyRuntimeLedgerMode()`
- `PlannerSpawnConfig.legacyRuntimeLedgerMode`

Search indicates the mode is not consumed by planner or dispatch code outside
config tests. The implementation should verify this again before editing.

### Desired shape

`resolvePlannerSpawnConfig()` should return only live planner config:

```ts
{
  spawnBackend,
  plannerAllowlist,
  intentTtlMs,
}
```

No env named `OCTOCLAW_LEGACY_RUNTIME_LEDGER` should remain outside archive
docs or historical implementation notes.

## P6-B: Legacy Heuristic Env Switch

### Important distinction

Delete the env switch, not the compatibility behavior.

The helper is still used by:

- `resolve/session.ts`
- `tools/runtime-status.ts`
- `resolve/native-announce.ts`

Those call sites must keep this invariant:

- new tasks with native evidence never use legacy heuristic authority;
- old records without native fields may render read-only compatibility;
- fallback usage is observable through replay.

### Desired shape

`legacyHeuristicVerdict()` no longer reads process env. It becomes a pure
read-only classifier:

```ts
if (!hasLegacySignal || hasNativeTruth || hasKnownNativeId) source = "none";
else source = "legacy_heuristic_read_only";
```

Tests should continue to prove hot paths do not import this helper for
new-task truth.

## P6-C: Slack CLI Delivery Rollback

### Precondition

Before deletion, run targeted Slack API delivery tests:

- `extensions/octoclaw-runtime/src/im/slack/slack-adapter.test.ts`
- `extensions/octoclaw-runtime/src/im/slack/slack-smoke.test.ts`
- ACK/delegate tests that currently set `OCTOCLAW_LEGACY_CLI_DELIVERY`

If those tests only use legacy CLI to avoid Slack API setup, rewrite them with
Slack API mocks instead of preserving the rollback path.

### Desired shape

`sendText()` always uses `executeSlackApiSend()` after target resolution.

`executeLegacyCliSend()` and `legacyCliDeliveryEnabled()` disappear.

Transport handling should be conservative:

- live send results should no longer return `legacy_cli`;
- persisted/old record renderers may still tolerate string transport values if
  type contracts are intentionally broad.

## P6-D: Native ACP Fallback Mode

### Direction

OpenClaw owns ACP backend failover. OctoClaw should read and report
`acp.fallbacks`, not expose a parallel enforcement switch.

### Desired shape

Keep:

- `loadNativeAcpFallbackSnapshot()`
- `readNativeAcpFallbackSnapshot()`
- metadata that reports primary/fallback runtime ids
- classification helpers if they are still useful for replay explanations

Remove or collapse:

- `NativeAcpFallbackMode`
- `resolveNativeAcpFallbackMode()`
- `shouldDelegateBackendUnavailableToNative()`
- `buildEnforceFallbackReplayMetadata()`
- dispatch branches whose only purpose is `delegate_backend_unavailable`

The replacement metadata should say native fallback is host-owned, for example:

```json
{
  "owner": "openclaw_acp",
  "fallbackAttempted": false,
  "reason": "host_runtime_owns_backend_failover"
}
```

Do not claim a fallback was attempted unless OpenClaw exposes that fact.

## P6-E: Runtime Payload Consolidation

### Current boundary

`runtime-payloads.ts` imports runtime-only helpers:

- `payloads/delegation/index.ts`
- `payloads/fast-reply/index.ts`

If those helpers are still used only by `runtime-payloads.ts` and their tests,
they can be inlined or moved beside `runtime-payloads.ts`.

### Guardrail

This slice must not change:

- dispatch payload keys used by `tools/handlers/dispatch.ts`
- spawn payload keys used by `tools/registration.ts`
- public exports from `src/index.ts` unless tests prove there are no consumers
- native helper action names: `create-managed-flow`, `run-task`

## LOC Reporting

Every phase must record:

```bash
find extensions/octoclaw-runtime/src -type f \( -name '*.ts' -o -name '*.tsx' \) \
  ! -name '*.test.ts' ! -path '*/__tests__/*' -print0 | xargs -0 wc -l | tail -n 1
```

Do not count tests as production LOC. Record test LOC separately if a phase
deletes substantial tests.

