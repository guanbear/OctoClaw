# Design

## Overview

The target runtime path is:

```text
user turn
  -> resolver/judge creates initial decision metadata
  -> main either replies, uses bounded main-fast-path tools, or calls octoclaw_dispatch
  -> octoclaw_dispatch calls DispatchAdmission
  -> DispatchAdmission returns allow/reject and may create NativeSpawnIntent
  -> sessions_spawn/sessions_send is allowed only if NativeIntentGate matches the pending intent
  -> dispatch_confirm records accepted native run evidence
  -> status/footer/dashboard render projections from ledger/native refs
```

`octoclaw_dispatch` is the only place where reply can become delegate. `sessions_spawn` is not a second router; it only proves the main agent is using the exact native spawn plan OctoClaw created.

## Current Gate Ownership To Remove

| Current owner | Current behavior | Target behavior |
| --- | --- | --- |
| `before_tool_call` WorkContract forbidden check | Blocks `octoclaw_dispatch` | Never blocks dispatch; records advisory only |
| `before_tool_call` route hint required check | Blocks tools before hint | Does not block dispatch; ordinary tools use budget policy |
| `workflowEnforcementRule()` | Blocks workflow violations | Advisory/test helper; no dispatch block |
| route seal mismatch in dispatch | Hard rejects without shared evidence model | Moves into `DispatchAdmission` with supersede rules |
| budgeted-main guard | Blocks ordinary tools and instructs dispatch | Writes escalation evidence; dispatch must consume it |
| native spawn gate | Blocks direct spawn | Kept as hard bypass guard |

## DispatchAdmission

Create or extend `extensions/octoclaw-runtime/src/dispatch-admission.ts` with a single function:

```ts
export function evaluateDispatchAdmission(input: DispatchAdmissionInput): DispatchAdmissionDecision
```

Inputs:

- tool params;
- policy metadata;
- cached decision;
- route seal state;
- WorkContract candidate;
- explicit WorkContract id flag;
- budgeted-main state/evidence;
- recent execution follow-up context;
- native execution evidence.

Decision variants:

```ts
type DispatchAdmissionDecision =
  | {
      allowed: true;
      action: "new_delegate" | "existing_delegate" | "supersede_reply_seal";
      route: "delegate";
      reason: string;
      decision: UnknownRecord;
      workContract?: WorkContract;
      audit: UnknownRecord;
    }
  | {
      allowed: false;
      route: "reply" | "delegate";
      reason: string;
      terminal: boolean;
      retryable: boolean;
      audit: UnknownRecord;
    };
```

Allowed reasons:

- `force_route_delegate`;
- `model_override`;
- `conversation_control_delegate`;
- `accepted_objection_delegate`;
- `budgeted_main_escalation`;
- `explicit_new_work`;
- `valid_existing_delegate_work_contract`.

Reject reasons:

- `status_followup_no_new_spawn`;
- `provenance_followup_no_new_spawn`;
- `explicit_work_contract_invalid`;
- `explicit_work_contract_not_dispatchable`;
- `already_has_accepted_native_run`;
- `ambiguous_dispatch_without_deliverable`;
- `route_seal_supersede_not_structured`;

## Route Seal Supersede

Reply seal may be superseded only when all are true:

- target route is delegate;
- there is no accepted native run for the current WorkContract;
- the dispatch call contains structured delegate evidence;
- the request is not status/provenance follow-up.

The new decision must persist:

- old route seal id;
- new route seal id;
- supersede reason;
- source `dispatch_admission`;
- selected model if provided.

Explicit `workContractId` remains strict. If the caller names a WorkContract id, admission must not silently switch to a different contract unless the id was stale and not explicit.

## Before Tool Call

`extension-entry.ts` should become a thin hook:

Hard blocks:

- direct `sessions_spawn` without pending NativeSpawnIntent;
- direct `sessions_send` without matching speculative send intent;
- args hash mismatch;
- execution/status follow-up direct spawn.

Non-blocking/advisory:

- route hint requirement;
- workflow enforcement;
- WorkContract forbidden tools;
- reply contract forbidden dispatch;
- ledger/projection degraded context.

Budget behavior:

- observe ordinary tools in reply route;
- allow bounded read-only main fast path;
- write escalation evidence on wall time/tool/write-risk budget;
- if it blocks a high-risk ordinary tool, it must guarantee the next `octoclaw_dispatch` reaches `DispatchAdmission`.

## WorkContract Forbidden Tools

`forbiddenTools` stays in schemas for compatibility and replay, but live dispatch authority no longer consumes it directly.

Interpretation changes:

- for reply contracts: "auto-spawn is not the default";
- for status follow-up: "spawn must be rejected by DispatchAdmission";
- for explicit dispatch: "arbiter must evaluate whether structured evidence supersedes the reply contract".

## Workflow Enforcement

`workflowEnforcementRule()` should stop being a hard runtime gate for dispatch.

Acceptable uses:

- compact prompt projection;
- advisory audit events;
- focused tests for policy projections;
- optional ordinary-tool warning under delegate route.

Unacceptable use:

- returning a `before_tool_call` block for `octoclaw_dispatch`.

## User Visible Truth

Dispatch state wording must follow evidence:

| Evidence | Allowed wording |
| --- | --- |
| route seal only | planned/selected route only |
| WorkContract only | work contract prepared only |
| NativeSpawnIntent only | dispatch plan created, waiting for native spawn |
| sessions_spawn accepted + confirm | delegated/started |
| final native announce/result | completed |

No Slack reply may say "任务已启动" or "已派发" before native accepted run evidence and dispatch confirm.

## Tests

Required test groups:

1. Explicit delegate after stale reply seal.
2. Budgeted-main escalation reaches dispatch admission.
3. Graphify-like multi-step install/analyze task does not hit dispatch/spawn dead zone.
4. Read-only version/release lookup stays main fast path.
5. Status/provenance follow-up cannot spawn.
6. Direct native spawn bypass remains blocked.
7. Explicit invalid WorkContract id fails closed.
8. User-visible dispatch status uses native evidence.

Suggested commands:

```bash
pnpm vitest run \
  extensions/octoclaw-runtime/src/__tests__/extension-entry-policy-route-hint.test.ts \
  extensions/octoclaw-runtime/src/tools/registration-dispatch-honesty.test.ts \
  extensions/octoclaw-runtime/src/replay/work-contract-tool-guard.test.ts

pnpm --filter @octoclaw/runtime run check
```

## Migration Notes

This is a behavior convergence, not a schema migration.

Existing route seals and WorkContracts remain readable. The live path changes how they are interpreted:

- old reply forbidden dispatch is no longer an outer hook block;
- dispatch admission may reject or supersede with audit;
- old tests expecting generic forbidden messages should be rewritten to expect structured dispatch admission results.

## Risks

Risk: Over-permissive dispatch.

Mitigation: direct native spawn remains blocked; status/provenance follow-up reject remains in DispatchAdmission; explicit WorkContract id stays strict.

Risk: Main agent does more direct tool work.

Mitigation: budgeted-main still observes and escalates; high-risk ordinary tools can block, but dispatch must remain reachable.

Risk: Losing replay clarity.

Mitigation: route seal supersede writes old/new seal ids and reason. WorkContract forbidden tools remain replay metadata.

Risk: Centralizing gates creates one larger hard-to-review function.

Mitigation: `DispatchAdmission` must be staged and enumerated: normalize request, classify follow-up/new-work, validate explicit WorkContract, evaluate seal supersede, allow/reject spawn intent. It must return stable enum reasons rather than freeform strings.

Risk: User-visible status still overclaims progress.

Mitigation: admission allow means only "dispatch plan created"; started/delegated wording requires native `sessions_spawn` accepted plus `octoclaw_dispatch_confirm` evidence. Footer model must prefer actual spawn/selected dispatch model and use `unknown/pending` instead of policy default when evidence is missing.
