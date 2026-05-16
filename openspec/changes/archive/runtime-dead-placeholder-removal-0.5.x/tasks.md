# Tasks

## Archive note

All 3 slices shipped on Wed May 13, 2026:
- Slice 1 (`81aadd924`): deleted `thread-aggregation.ts` and `surface-binding.ts`, cleaned barrel exports
- Slice 2 (`a08937cde`): deleted `payloads/delegation/compound/` directory, cleaned re-exports and runtime-payloads
- Slice 3 (`e7b1e793c`): deleted `packages/octoclaw-policy/src/compound/` directory, cleaned judgeFast output type

Nothing was deferred. ~120 lines removed across runtime + policy packages.

## Slice 1 — Delete no-op workflow and surface-binding helpers

Owner: implementation, Codex review.

Write scope:

- delete `extensions/octoclaw-runtime/src/core/workflow/thread-aggregation.ts`
- delete `extensions/octoclaw-runtime/src/core/requests/surface-binding.ts`
- update `extensions/octoclaw-runtime/src/core/workflow/index.ts` (drop re-export)
- update `extensions/octoclaw-runtime/src/core/requests/index.ts` (drop re-export)

Tasks:

- [x] Confirm no other consumer via `rg "createNoOpThreadAggregator|createNoOpSurfaceBindingStore|ThreadAwareStateAggregator|SurfaceBindingStore"`.
- [x] Delete both files.
- [x] Remove `export * from "./thread-aggregation.js"` and `export * from "./surface-binding.js"`.
- [x] Delete any tests that only exist to verify the no-op returned an empty object.

Acceptance:

- [x] `pnpm check`
- [x] `pnpm test` matches the baseline failure count.
- [x] `rg "createNoOpThreadAggregator|createNoOpSurfaceBindingStore" packages/ extensions/` returns no results.

Shipped in commit `81aadd924` on Wed May 13.

## Slice 2 — Remove compound placeholder from runtime payloads

Owner: implementation, Codex review.

Write scope:

- `extensions/octoclaw-runtime/src/runtime-payloads.ts`
- `extensions/octoclaw-runtime/src/runtime-payloads.test.ts`
- `extensions/octoclaw-runtime/src/payloads/delegation/index.ts`
- `extensions/octoclaw-runtime/src/payloads/delegation/index.test.ts`
- `extensions/octoclaw-runtime/src/payloads/delegation/materialize/index.ts`
- delete `extensions/octoclaw-runtime/src/payloads/delegation/compound/index.ts`
- delete `extensions/octoclaw-runtime/src/payloads/delegation/compound/index.test.ts`

Tasks:

- [x] Drop `buildCompoundDelegationPlaceholder` and `CompoundDelegationPlaceholder` from `payloads/delegation/index.ts` re-exports.
- [x] Drop the `compound:` field from the `runtime-payloads.ts` assembled object.
- [x] Update `runtime-payloads.test.ts` to no longer assert on the `compound` key.
- [x] Update `payloads/delegation/index.test.ts` export-shape assertion to remove `"buildCompoundDelegationPlaceholder"`.
- [x] Delete the `payloads/delegation/compound/` directory.

Acceptance:

- [x] `pnpm check`
- [x] `pnpm vitest run extensions/octoclaw-runtime/src/runtime-payloads.test.ts`
- [x] `pnpm vitest run extensions/octoclaw-runtime/src/payloads/`
- [x] `pnpm test` matches baseline failure count.
- [x] `rg "buildCompoundDelegationPlaceholder" packages/ extensions/` returns no results.

Shipped in commit `a08937cde` on Wed May 13.

## Slice 3 — Remove compound placeholder from policy judgeFast

Owner: implementation, Codex review.

Write scope:

- `packages/octoclaw-policy/src/judge/index.ts`
- `packages/octoclaw-policy/src/judge/index.test.ts`
- delete `packages/octoclaw-policy/src/compound/index.ts`
- delete `packages/octoclaw-policy/src/compound/` directory

Tasks:

- [x] Remove `compound` field from `JudgeFastOutput` type.
- [x] Remove `buildCompoundPolicyPlaceholder()` call from `judgeFast()`.
- [x] Delete `packages/octoclaw-policy/src/compound/index.ts`.
- [x] Update `judge/index.test.ts` to drop assertions on the removed `compound` field.
- [x] Ensure `packages/octoclaw-policy/src/index.ts` does not re-export anything from `compound/`.

Acceptance:

- [x] `pnpm check`
- [x] `pnpm vitest run packages/octoclaw-policy/`
- [x] `pnpm test` matches baseline failure count.
- [x] `rg "buildCompoundPolicyPlaceholder|COMPOUND_POLICY_SCHEMA_VERSION" packages/ extensions/` returns no results.

Shipped in commit `e7b1e793c` on Wed May 13.

## Verification

- [x] All three slices merged.
- [x] `rg -n "buildCompoundPolicyPlaceholder|buildCompoundDelegationPlaceholder|createNoOpThreadAggregator|createNoOpSurfaceBindingStore" packages/ extensions/` returns no results.
- [x] Slack smoke: one delegate turn produces no visible regression.
- [x] Line count delta is informational: expect ~ 120 lines removed across runtime + policy packages.

## Hard Invariants

- `CoordinationMode` enum retains `"compound"` variant.
- `compound_route_not_available_on_phase2_live_path` reason string stays.
- `buildRuntimeTruthWorkflowStub` not touched.
- No regression in `judgeFast()` behaviour beyond the removed `compound` field.
