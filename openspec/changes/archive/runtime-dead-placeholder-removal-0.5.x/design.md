# Design: Runtime Dead Placeholder Removal 0.5.x

## 1. Inventory

Confirmed via `grep_search` that the following four symbols have **no downstream reader beyond their own direct producer or test**:

| Symbol | Location | Consumer |
|--------|----------|----------|
| `buildCompoundPolicyPlaceholder` | `packages/octoclaw-policy/src/compound/index.ts` | `judgeFast()` in `packages/octoclaw-policy/src/judge/index.ts` only |
| `buildCompoundDelegationPlaceholder` | `extensions/octoclaw-runtime/src/payloads/delegation/compound/index.ts` | `runtime-payloads.ts` only |
| `createNoOpThreadAggregator` | `extensions/octoclaw-runtime/src/core/workflow/thread-aggregation.ts` | none (only its own test) |
| `createNoOpSurfaceBindingStore` | `extensions/octoclaw-runtime/src/core/requests/surface-binding.ts` | none (only its own test) |

Neither of the `compound:` fields is read by any downstream projection, status renderer, footer, test (beyond shape-assertion snapshots), or external consumer. They are pure produced-and-forgotten values.

## 2. Ordering

Three slices in order of increasing blast radius:

1. **Slice 1** — Delete `thread-aggregation.ts` and `surface-binding.ts`. Simplest: zero consumers, even tests only self-reference. Just drop the files and re-exports.
2. **Slice 2** — `buildCompoundDelegationPlaceholder` removal. Touches `runtime-payloads.ts` and its test. Single runtime-internal change.
3. **Slice 3** — `buildCompoundPolicyPlaceholder` removal. Touches `@octoclaw/policy` and its test; ripples one level to `runtime-payloads.ts` (but Slice 2 already cleaned that up).

## 3. Slice 1 detail

```bash
# delete
rm extensions/octoclaw-runtime/src/core/workflow/thread-aggregation.ts
rm extensions/octoclaw-runtime/src/core/requests/surface-binding.ts

# edit re-exports
# core/workflow/index.ts: drop "export * from './thread-aggregation.js'"
# core/requests/index.ts: drop "export * from './surface-binding.js'"
```

No typed exports leak; both `ThreadAwareStateAggregator` and `SurfaceBindingStore` types disappear cleanly because they are only used by the no-op themselves.

## 4. Slice 2 detail

### 4.1 `runtime-payloads.ts`

Current:

```ts
import { buildCompoundDelegationPlaceholder, materializeDelegatedWork } from "./payloads/delegation/index.js";
...
const compoundPlaceholder = buildCompoundDelegationPlaceholder();
...
return {
  delegation: {
    path: "...",
    materialized: { ... },
    compound: compoundPlaceholder,   // <— remove
  },
  ...
};
```

New:

```ts
import { materializeDelegatedWork } from "./payloads/delegation/index.js";
...
return {
  delegation: {
    path: "...",
    materialized: { ... },
  },
  ...
};
```

### 4.2 Tests

`runtime-payloads.test.ts` likely contains assertions such as:

```ts
expect(result.delegation.compound).toEqual({ schemaVersion: "octoclaw.delegation.compound/v1", ... });
```

These are deleted.

`payloads/delegation/index.test.ts` asserts export shape:

```ts
expect(Object.keys(publicApi).sort()).toEqual([
  "DELEGATION_PROFILES",
  "buildCompoundDelegationPlaceholder",   // <— remove
  ...
]);
```

Remove `"buildCompoundDelegationPlaceholder"` from the array.

### 4.3 Directory removal

`rm -r extensions/octoclaw-runtime/src/payloads/delegation/compound/`

## 5. Slice 3 detail

### 5.1 `judgeFast()` return type

Current:

```ts
export interface JudgeFastOutput {
  intent: IntentPacket;
  decision: PolicyDecision;
  compound: CompoundPolicyPlaceholder;   // <— remove
}

export function judgeFast(input: JudgeFastInput): JudgeFastOutput {
  const intent = buildIntentPacket(input.intent);
  return {
    intent,
    decision: judgePolicy(input),
    compound: buildCompoundPolicyPlaceholder(),   // <— remove
  };
}
```

New:

```ts
export interface JudgeFastOutput {
  intent: IntentPacket;
  decision: PolicyDecision;
}

export function judgeFast(input: JudgeFastInput): JudgeFastOutput {
  const intent = buildIntentPacket(input.intent);
  return {
    intent,
    decision: judgePolicy(input),
  };
}
```

### 5.2 Directory removal

`rm -r packages/octoclaw-policy/src/compound/`

Ensure `packages/octoclaw-policy/src/index.ts` does not re-export anything from `compound/`. (grep confirms it does not today.)

### 5.3 Tests

Any `toMatchObject({ compound: ... })` in `judge/index.test.ts` is removed.

## 6. Negative space

What we explicitly do **not** delete:

- `CoordinationMode` enum `"compound"` variant in:
  - `packages/octoclaw-contracts/src/delegate.ts`
  - `packages/octoclaw-contracts/src/schemas.ts`
  - `packages/octoclaw-policy/src/judge/index.ts`
- `packages/octoclaw-policy/src/spec/decision-policy-spec.ts` `coordination_mode_hint` arrays.
- `compound_route_not_available_on_phase2_live_path` rejection reason in `policy-resolver.ts`.
- `buildRuntimeTruthWorkflowStub` in `resolve/runtime-recovery.ts` — used by diagnostics.

These are vocabulary/contract elements, not live artefacts. Removing them would be a semantic change, not dead-code removal.

## 7. Verification commands

```bash
# before
wc -l packages/octoclaw-policy/src/compound/index.ts \
       extensions/octoclaw-runtime/src/payloads/delegation/compound/index.ts \
       extensions/octoclaw-runtime/src/core/workflow/thread-aggregation.ts \
       extensions/octoclaw-runtime/src/core/requests/surface-binding.ts

# after all slices
rg -n "buildCompoundPolicyPlaceholder|buildCompoundDelegationPlaceholder|createNoOpThreadAggregator|createNoOpSurfaceBindingStore" packages/ extensions/

pnpm check
pnpm test
```

Expected outcome:

- Line count reduction around 120 lines.
- `rg` returns no hits.
- `pnpm check` passes.
- `pnpm test` failure count unchanged from baseline (6 pre-existing).

## 8. Rollback

Each slice is an independent `git revert`. No data migration, no schema change, no user-visible change.

## 9. Out of scope cleanups

Tracked for later, not in this change:

- `advisor_assisted` / `threaded_subagents` / `multi_agent_controlled` runtime payload handling (kept as contract enum; live path only uses `solo_worker`).
- Legacy `OCTOCLAW_LEGACY_CLI_DELIVERY` flag (still referenced by Slack adapter fallback).
- Legacy `OCTOCLAW_SPAWN_BACKEND=legacy` default in many tests.

Those are larger semantic changes and do not fit the "dead placeholder" scope.
