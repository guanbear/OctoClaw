# Tasks

## Slice 1 — Delete no-op workflow and surface-binding helpers

Owner: implementation, Codex review.

Write scope:

- delete `extensions/octoclaw-runtime/src/core/workflow/thread-aggregation.ts`
- delete `extensions/octoclaw-runtime/src/core/requests/surface-binding.ts`
- update `extensions/octoclaw-runtime/src/core/workflow/index.ts` (drop re-export)
- update `extensions/octoclaw-runtime/src/core/requests/index.ts` (drop re-export)

Tasks:

- [ ] Confirm no other consumer via `rg "createNoOpThreadAggregator|createNoOpSurfaceBindingStore|ThreadAwareStateAggregator|SurfaceBindingStore"`.
- [ ] Delete both files.
- [ ] Remove `export * from "./thread-aggregation.js"` and `export * from "./surface-binding.js"`.
- [ ] Delete any tests that only exist to verify the no-op returned an empty object.

Acceptance:

- [ ] `pnpm check`
- [ ] `pnpm test` matches the baseline failure count.
- [ ] `rg "createNoOpThreadAggregator|createNoOpSurfaceBindingStore" packages/ extensions/` returns no results.

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

- [ ] Drop `buildCompoundDelegationPlaceholder` and `CompoundDelegationPlaceholder` from `payloads/delegation/index.ts` re-exports.
- [ ] Drop the `compound:` field from the `runtime-payloads.ts` assembled object.
- [ ] Update `runtime-payloads.test.ts` to no longer assert on the `compound` key.
- [ ] Update `payloads/delegation/index.test.ts` export-shape assertion to remove `"buildCompoundDelegationPlaceholder"`.
- [ ] Delete the `payloads/delegation/compound/` directory.

Acceptance:

- [ ] `pnpm check`
- [ ] `pnpm vitest run extensions/octoclaw-runtime/src/runtime-payloads.test.ts`
- [ ] `pnpm vitest run extensions/octoclaw-runtime/src/payloads/`
- [ ] `pnpm test` matches baseline failure count.
- [ ] `rg "buildCompoundDelegationPlaceholder" packages/ extensions/` returns no results.

## Slice 3 — Remove compound placeholder from policy judgeFast

Owner: implementation, Codex review.

Write scope:

- `packages/octoclaw-policy/src/judge/index.ts`
- `packages/octoclaw-policy/src/judge/index.test.ts`
- delete `packages/octoclaw-policy/src/compound/index.ts`
- delete `packages/octoclaw-policy/src/compound/` directory

Tasks:

- [ ] Remove `compound` field from `JudgeFastOutput` type.
- [ ] Remove `buildCompoundPolicyPlaceholder()` call from `judgeFast()`.
- [ ] Delete `packages/octoclaw-policy/src/compound/index.ts`.
- [ ] Update `judge/index.test.ts` to drop assertions on the removed `compound` field.
- [ ] Ensure `packages/octoclaw-policy/src/index.ts` does not re-export anything from `compound/`.

Acceptance:

- [ ] `pnpm check`
- [ ] `pnpm vitest run packages/octoclaw-policy/`
- [ ] `pnpm test` matches baseline failure count.
- [ ] `rg "buildCompoundPolicyPlaceholder|COMPOUND_POLICY_SCHEMA_VERSION" packages/ extensions/` returns no results.

## Verification

- [ ] All three slices merged.
- [ ] `rg -n "buildCompoundPolicyPlaceholder|buildCompoundDelegationPlaceholder|createNoOpThreadAggregator|createNoOpSurfaceBindingStore" packages/ extensions/` returns no results.
- [ ] Slack smoke: one delegate turn produces no visible regression.
- [ ] Line count delta is informational: expect ~ 120 lines removed across runtime + policy packages.

## Hard Invariants

- `CoordinationMode` enum retains `"compound"` variant.
- `compound_route_not_available_on_phase2_live_path` reason string stays.
- `buildRuntimeTruthWorkflowStub` not touched.
- No regression in `judgeFast()` behaviour beyond the removed `compound` field.
