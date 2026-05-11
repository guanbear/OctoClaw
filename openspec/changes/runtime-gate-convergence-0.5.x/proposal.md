# Change: Runtime Gate Convergence 0.5.x

## Purpose

Converge OctoClaw runtime gates so delegated work has one dispatch admission authority and one native spawn bypass guard. The goal is to reduce complexity and eliminate dead zones where `octoclaw_dispatch` is forbidden while direct `sessions_spawn` is also forbidden.

## Problem

The current live path has too many independent hard veto points:

- route seal mismatch checks;
- WorkContract `forbiddenTools`;
- route hint required checks;
- workflow enforcement;
- budgeted-main tool guard;
- dispatch-time sealed decision checks;
- native pending intent gate;
- runtime ledger/projection follow-up guards.

These gates are individually reasonable, but together they create unstable behavior:

- explicit delegate/model requests can be blocked by stale reply seals;
- budgeted-main escalation can tell the main agent to call dispatch, but another gate can forbid dispatch;
- direct native spawn is correctly blocked, but there is no reliable way back to dispatch;
- read-only lookup can be misrouted into delegation;
- user-visible status can imply dispatch failed while the main agent continues doing work.

## Scope

This change includes:

- Make `octoclaw_dispatch` the only delegated-work admission authority.
- Keep native `sessions_spawn` / `sessions_send` intent gate only as a bypass guard.
- Downgrade route hint, WorkContract forbidden tools, workflow enforcement, and budgeted-main signals to advisory/evidence unless handled by dispatch admission.
- Centralize stale reply seal supersede rules.
- Preserve fail-closed behavior for direct spawn bypass, explicit invalid WorkContract ids, and status/provenance follow-ups.
- Add invariant tests for explicit delegate, budget escalation, status follow-up, read-only lookup, and graphify-like multi-step work.

## Non-Goals

- Do not add keyword-based routing or blocking.
- Do not add a new scheduler, resident runner, warm pool, or direct native spawn path.
- Do not bypass `octoclaw_dispatch`.
- Do not weaken `sessions_spawn` pending intent validation.
- Do not claim dispatch/spawn success without native accepted run evidence.
- Do not preserve old gate behavior behind long-lived flags.

## Target Authority Model

Hard authority is limited to:

1. `DispatchAdmission`
   - Owns delegate/reply transition, WorkContract selection, stale seal supersede, status follow-up rejection, and NativeSpawnIntent creation.
2. `NativeIntentGate`
   - Owns direct `sessions_spawn` / `sessions_send` bypass prevention by matching pending intent hash and session.

Everything else is metadata, evidence, prompt guidance, audit, or projection.

## Acceptance Gate

This change is acceptable only when:

- `before_tool_call` no longer hard-blocks `octoclaw_dispatch` because of reply WorkContract forbidden tools, route hint preconditions, or workflow enforcement.
- budgeted-main escalation can always reach `octoclaw_dispatch` admission.
- explicit delegate/model dispatch can supersede a stale unexecuted reply seal with structured audit.
- direct `sessions_spawn` without pending intent remains blocked.
- status/provenance follow-ups remain reply/control and cannot spawn.
- read-only one-shot lookup remains main fast path unless budget is exceeded.
- dispatch rejections are structured terminal/retryable results from dispatch admission, not generic outer hook blocks.
- user-visible "started/delegated" text requires native spawn accepted plus confirm evidence.

## Rollout

1. Add tests that reproduce current gate dead zones and encode target invariants.
2. Centralize dispatch admission in `dispatch-admission.ts`.
3. Shrink `before_tool_call` to native intent gate plus budget/advisory bookkeeping.
4. Downgrade workflow/WorkContract forbidden dispatch behavior.
5. Fix user-visible dispatch status/footer truth.
6. Run focused tests, runtime check, and Slack smoke.

Rollback is git revert. Do not add a compatibility flag that restores old multi-gate behavior.
