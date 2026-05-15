# Tasks

## WP-A Design And Invariant Tests

Owner: Codex design, OpenCode/GLM implementation, Codex review.

Write scope:

- `docs/octoclaw-runtime-gate-convergence-design-2026-05-12.md`
- `openspec/changes/runtime-gate-convergence-0.5.x/**`
- `extensions/octoclaw-runtime/src/__tests__/extension-entry-policy-route-hint.test.ts`
- `extensions/octoclaw-runtime/src/tools/registration-dispatch-honesty.test.ts`
- `extensions/octoclaw-runtime/src/replay/work-contract-tool-guard.test.ts`

Tasks:

- [x] Add explicit delegate after stale reply seal test.
- [x] Add budgeted-main escalation cannot deadlock test.
- [x] Add graphify-like install/analyze dispatch path test.
- [x] Add read-only lookup remains main fast path test.
- [x] Add status/provenance follow-up cannot spawn test.
- [x] Add direct native spawn bypass still blocked test.
- [x] Add explicit invalid WorkContract id fail-closed test.

Acceptance:

- [x] Focused tests fail on current dead-zone behavior or pass only when target behavior is already implemented.
- [x] No test relies on user-text keyword matching as the authority.

Evidence (2026-05-12):

```
pnpm vitest run \
  extensions/octoclaw-runtime/src/__tests__/extension-entry-policy-route-hint.test.ts \
  extensions/octoclaw-runtime/src/tools/registration-dispatch-honesty.test.ts \
  extensions/octoclaw-runtime/src/replay/work-contract-tool-guard.test.ts

Test Files  3 passed (3)
Tests  106 passed (106)
```

Invariant coverage:

| # | Invariant | File | Status |
|---|-----------|------|--------|
| 1 | explicit delegate after stale reply seal reaches dispatch admission | registration-dispatch-honesty.test.ts `[target-WP-B]` | ✓ pass |
| 2 | budgeted-main escalation cannot deadlock | extension-entry-policy-route-hint.test.ts `[invariant-1]` | ✓ pass |
| 3 | graphify-like multi-step install/analyze no dead zone | extension-entry-policy-route-hint.test.ts `[invariant-2]` | ✓ pass |
| 4 | read-only lookup stays main fast path, not write_tool_detected | extension-entry-policy-route-hint.test.ts `[invariant-4]` + `[invariant-4b]` | ✓ pass |
| 5 | status/provenance follow-up cannot spawn | registration-dispatch-honesty.test.ts `[target-WP-A.5]` | ✓ pass |
| 6 | direct sessions_spawn without NativeSpawnIntent blocked | extension-entry-policy-route-hint.test.ts `[invariant-3]` | ✓ pass |
| 7 | explicit invalid WorkContract id fails closed | registration-dispatch-honesty.test.ts `[target-WP-A.7]` | ✓ pass |

Additional target tests in work-contract-tool-guard.test.ts:

- `[target]` workflowEnforcementRule does not block octoclaw_dispatch with explicit forceRoute delegate evidence → ✓ pass
- `[target-WP-B]` workflowEnforcementRule does not block under budgeted-main escalated delegate route → ✓ pass

## WP-B Centralize Dispatch Admission

Owner: OpenCode/GLM implementation, Codex review.

Write scope:

- `extensions/octoclaw-runtime/src/dispatch-admission.ts`
- `extensions/octoclaw-runtime/src/tools/registration.ts`
- `extensions/octoclaw-runtime/src/tools/registration-dispatch-honesty.test.ts`
- `extensions/octoclaw-runtime/src/replay/policy-utils.ts`
- `extensions/octoclaw-runtime/src/replay/work-contract-tool-guard.test.ts`

Tasks:

- [x] Add `evaluateDispatchAdmission()`.
- [x] Keep `evaluateDispatchAdmission()` staged with stable enum reasons; do not move old hook `if` branches wholesale into one larger function.
- [x] Move stale reply seal supersede into dispatch admission.
- [x] Move budgeted-main dispatch allowance into dispatch admission.
- [x] Move explicit delegate/model override dispatch allowance into dispatch admission.
- [x] Keep explicit WorkContract id validation fail-closed.
- [x] Return structured terminal/retryable reject decisions from dispatch.

Acceptance:

- [x] `octoclaw_dispatch` is not rejected by an outer hook before admission.
- [x] Dispatch admission audit records old/new route seal on supersede via `sealed_*_dispatch_allowed` replay events.
- [x] `pnpm vitest run extensions/octoclaw-runtime/src/tools/registration-dispatch-honesty.test.ts`

Evidence (2026-05-12):

```
pnpm vitest run \
  extensions/octoclaw-runtime/src/__tests__/extension-entry-policy-route-hint.test.ts \
  extensions/octoclaw-runtime/src/tools/registration-dispatch-honesty.test.ts \
  extensions/octoclaw-runtime/src/replay/work-contract-tool-guard.test.ts

Test Files  3 passed (3)
Tests  106 passed (106)
```

## WP-C Shrink `before_tool_call`

Owner: OpenCode/GLM implementation, Codex review.

Write scope:

- `extensions/octoclaw-runtime/src/extension-entry.ts`
- `extensions/octoclaw-runtime/src/__tests__/extension-entry-policy-route-hint.test.ts`
- `extensions/octoclaw-runtime/src/delegate/native-spawn-gate.ts`

Tasks:

- [x] Keep hard blocks only for native spawn/send intent bypass and args mismatch.
- [x] Remove or downgrade `octoclaw_dispatch` WorkContract forbidden block.
- [x] Remove or downgrade `octoclaw_dispatch` route hint precondition block.
- [x] Remove or downgrade `octoclaw_dispatch` workflow enforcement block.
- [x] Ensure budgeted-main high-risk block writes escalation evidence that dispatch admission consumes.
- [x] Keep high-risk ordinary-tool blocks available, but prove the next `octoclaw_dispatch` reaches admission.
- [x] Preserve execution/status follow-up direct spawn block.

Acceptance:

- [x] `rg "WorkContract forbids octoclaw_dispatch" extensions/octoclaw-runtime/src/extension-entry.ts` returns no live block.
- [x] direct `sessions_spawn` without pending intent remains blocked.
- [x] focused hook tests pass.

Evidence (2026-05-12):

```
pnpm vitest run \
  extensions/octoclaw-runtime/src/__tests__/extension-entry-policy-route-hint.test.ts \
  extensions/octoclaw-runtime/src/tools/registration-dispatch-honesty.test.ts \
  extensions/octoclaw-runtime/src/replay/work-contract-tool-guard.test.ts

Test Files  3 passed (3)
Tests  106 passed (106)
```

## WP-D Downgrade Workflow And WorkContract Forbidden Dispatch Semantics

Owner: OpenCode/GLM implementation, Codex review.

Write scope:

- `extensions/octoclaw-runtime/src/replay/policy-utils.ts`
- `extensions/octoclaw-runtime/src/replay/work-contract-tool-guard.test.ts`
- `extensions/octoclaw-runtime/src/resolve/work-contract-coverage.test.ts`
- `packages/octoclaw-contracts/src/work-contract.ts` only if type docs need clarification.

Tasks:

- [x] Clarify reply dispatch forbidden helper semantics by removing it from the registration live path and keeping it only as a compatibility helper.
- [x] Make `workflowEnforcementRule()` advisory for dispatch.
- [x] Keep ordinary tool warnings/budget behavior.
- [x] Update tests that currently assert hard forbidden dispatch.

Acceptance:

- [x] No live path treats reply `forbiddenTools=["octoclaw_dispatch"]` as an outer hook dispatch veto.
- [x] Status/provenance follow-up still cannot spawn through DispatchAdmission.

## WP-E User Visible Truth And Footer

Owner: OpenCode/GLM implementation, Codex review.

Write scope:

- `extensions/octoclaw-runtime/src/tools/registration.ts`
- `extensions/octoclaw-runtime/src/im-status-renderer.ts`
- `extensions/octoclaw-runtime/src/extension-entry.ts`
- related footer/status tests.

Tasks:

- [x] Ensure `model` footer uses actual selected/spawn model when available.
- [x] Ensure "started/delegated" wording requires native accepted run plus confirm.
- [x] Add "main fallback" status when dispatch was rejected and main executed bounded fallback.
- [x] Remove misleading generic "还没派发成功" on structured admission reject.

Acceptance:

- [x] No user-visible started/delegated claim without native evidence.
- [x] Footer does not show policy default model when child spawn used explicit model.

## WP-F Verification And Deploy

Owner: Codex.

Tasks:

- [x] Run focused gate tests.
- [x] Run `pnpm --filter @octoclaw/runtime run check`.
- [ ] Run `npx gitnexus detect-changes --scope staged` before commit.
- [ ] Deploy to local OpenClaw.
- [ ] Slack smoke:
  - [ ] explicit gpt-5.5 subagent request;
  - [ ] graphify-like multi-step delegated task;
  - [ ] read-only release/version lookup;
  - [ ] status/provenance follow-up;
  - [ ] direct footer/model inspection.

Acceptance:

- [ ] No `WorkContract forbids octoclaw_dispatch`.
- [ ] No `sealed_decision_required` for structured explicit delegate.
- [ ] No dispatch/spawn dead zone.
- [ ] No false "started/delegated" wording.
