# Change: Runtime Dead Placeholder Removal 0.5.x

## Purpose

Remove four placeholder/no-op artefacts that were planted during the early TS rebuild but never wired to consumers. They mislead new maintainers into thinking the system supports more than it does, add TS type noise, and keep `pnpm check` building unused code.

## Problem

`grep_search` confirms the following are either unused or only referenced by their own test:

1. **`packages/octoclaw-policy/src/compound/`** — `buildCompoundPolicyPlaceholder()` returns `{ schemaVersion: "octoclaw.compound_policy/v1", availableInLivePath: false, reason: "phase1_compound_disabled" }`. Produced by `judgeFast()`. No downstream code reads the `compound` field.
2. **`extensions/octoclaw-runtime/src/payloads/delegation/compound/`** — `buildCompoundDelegationPlaceholder()` returns `{ schemaVersion: "octoclaw.delegation.compound/v1", availableInPhase1: false, reason: "ws4_compound_placeholder" }`. Added to `runtime-payloads.ts` return under `compound:`. Nothing reads it.
3. **`extensions/octoclaw-runtime/src/core/workflow/thread-aggregation.ts`** — `createNoOpThreadAggregator()`. Exported via `core/workflow/index.ts`. No consumer.
4. **`extensions/octoclaw-runtime/src/core/requests/surface-binding.ts`** — `createNoOpSurfaceBindingStore()`. Exported via `core/requests/index.ts`. No consumer.

The v2 rebuild doc explicitly states: "不要为未来功能先造空插件、空目录、空 registry，除非已经有明确消费者". These four all violate that rule.

## Scope

Delete the placeholder files, remove their re-exports, and update the two functions (`judgeFast()` return type, `runtime-payloads.ts` assembly) that still reference them. Snapshot-test updates where needed.

Ordered as three minimum-blast-radius slices:

- **Slice 1** — Remove `thread-aggregation.ts` + `surface-binding.ts` (zero consumers; smallest risk).
- **Slice 2** — Drop `compound:` field from `runtime-payloads.ts` assembly; remove `buildCompoundDelegationPlaceholder`.
- **Slice 3** — Drop `compound:` field from `judgeFast()` return type; remove `buildCompoundPolicyPlaceholder`.

Each slice is an independent PR.

## Non-Goals

- Do not remove the `CoordinationMode` enum value `"compound"`. It is reserved vocabulary and has tests verifying non-use in live paths.
- Do not remove `buildRuntimeTruthWorkflowStub`. It has an active single-purpose consumer (tests around diagnostics rendering).
- Do not remove `DELEGATION_PROFILES`, `createNoOpAdvisorAdapter`, `createDelegationRoleRegistry`. Each has active integration.
- Do not modify `compound_route_not_available_on_phase2_live_path` reason strings in `policy-resolver.ts` — those describe live rejection of compound route requests and must stay.

## Target Behaviour

- No `build*Placeholder` functions exported.
- No `createNoOp*` functions exported from core/workflow or core/requests.
- `judgeFast()` return type no longer has `compound` field.
- `runtime-payloads.ts` return object no longer has `compound` field.
- Tests that asserted on the placeholder shape are deleted or updated to reflect the new shape.

## Acceptance Gate

- `pnpm check` passes after each slice.
- `pnpm test` failure count does not increase beyond the 6 pre-existing (improvement plan appendix B).
- `rg -n "buildCompoundPolicyPlaceholder|buildCompoundDelegationPlaceholder|createNoOpThreadAggregator|createNoOpSurfaceBindingStore" packages/ extensions/` returns no results.
- Bundle size: `dist/` output for runtime extension drops by a measurable amount (informational, not blocking).

## Rollout

- Slice 1 = 1 PR (smallest).
- Slice 2 = 1 PR.
- Slice 3 = 1 PR.

Each slice is independently revertable via git revert.

## Risks

- **External consumer**: none known. This plugin's public export surface is through `@octoclaw/policy` and runtime hook registration; placeholder symbols are not referenced in any plugin manifest or external spec.
- **Snapshot tests**: `runtime-payloads.test.ts` or `judge/index.test.ts` may have snapshots or `.toMatchObject` calls that include the `compound` field. These are updated as part of the slice that removes the field.
- **Contract spec documentation**: none of the removed symbols appear in `schemas/` JSON schemas.

## Why Now

- Supports the W-1 Auto Router Lite wiring by cleaning pack exports first.
- Supports the W-3 extension-entry slim by reducing the amount of code the runtime imports.
- Aligns with the `octoclaw-ts-rebuild-design-v2.md` explicit rule against empty placeholders.
