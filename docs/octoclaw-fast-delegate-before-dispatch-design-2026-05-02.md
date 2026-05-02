# OctoClaw Fast Delegate Before-Dispatch Design

Date: 2026-05-02

Related docs:

- `docs/octoclaw-native-slimming-implementation-plan-2026-05-01.md`
- `docs/octoclaw-openclaw-native-slimming-review-2026-05-01.md`
- `docs/octoclaw-judge-dispatch-complexity-improvement-2026-05-01.md`
- `openspec/changes/planner-confirm-0.5.0-refactor/`

## 1. Why This Exists

The `sessions_spawn planner/confirm` refactor made the delegation truth more native and more honest, but it moved user-visible delegate acknowledgement behind the main agent startup and the parent model's first tool decision. In real Slack smoke tests this can put `任务已启动。` more than a minute after the inbound message.

That is contrary to OctoClaw's product goal: acknowledge early, avoid blocking the main agent, reduce main-agent context pollution, and use cheaper child models for background work.

The performance recovery direction is therefore not to throw away the native planner work, and not to rebuild the old full runtime wheel. The new fast path is:

```text
Slack inbound
  -> OpenClaw native ackReaction/status reaction
  -> OpenClaw before_dispatch plugin hook
      -> reuse existing OctoClaw judge/policy decision
      -> if high-confidence delegate: start child directly and handle the turn
      -> otherwise pass through to normal main-agent path
```

This path bypasses parent-agent model startup and first-round planner/tool negotiation only for obvious delegated work.

## 2. Current Judge Stage

Current OctoClaw judge/policy decision is generated inside the agent run lifecycle, not at Slack ingress:

```text
OpenClaw agent run starts
  -> OctoClaw before_model_resolve
      -> resolvePolicyDecisionForContext()
      -> resolveStatelessPolicyDecision() when policyState has no cache
      -> judgePolicy() + optional LLM judge
      -> policyState.set(...)
  -> OctoClaw before_prompt_build
      -> resolvePolicyDecisionForContext()
      -> usually returns cached policyState decision
  -> main model reads prompt and tools
```

Source anchors:

- `extensions/octoclaw-runtime/src/extension-entry.ts`: `before_model_resolve` calls `resolvePolicyDecisionForContext()`.
- `extensions/octoclaw-runtime/src/extension-entry.ts`: `before_prompt_build` calls the same function and starts OctoClaw ACK guard/timers.
- `extensions/octoclaw-runtime/src/resolve/policy-resolver.ts`: `resolvePolicyDecisionForContext()` returns cached `policyState` when `promptsEquivalent(existing.prompt, prompt)` is true.
- `extensions/octoclaw-runtime/src/resolve/policy-resolver.ts`: no cache calls `resolveStatelessPolicyDecision()`, then writes `policyState` and attaches WorkContract.

Important implication: the existing judge already has a cache boundary. The fast path should move the first call earlier, not create a second judge.

## 3. Design Decision

Do not rewrite judge.

Add a new `before_dispatch` fast delegate entrypoint that calls the same `resolvePolicyDecisionForContext()` / policy resolver used today. If the result is not safe enough for immediate delegation, return `handled=false` and let OpenClaw continue normally. Later lifecycle hooks must reuse the cached decision.

Target flow:

```text
before_dispatch
  -> resolvePolicyDecisionForContext(prompt, managedCtx)
  -> policyState stores decision + WorkContract

  if fastDelegateAdmission(decision, state) == allow:
      -> api.runtime.subagent.run() or gateway agent
      -> record runId / childSessionKey / WorkContract binding
      -> send accepted receipt
      -> return { handled: true, text?: receipt }

  else:
      -> return { handled: false }
      -> before_model_resolve reads policyState cache
      -> before_prompt_build reads policyState cache
```

The fast admission guard is not a new judge. It is a safety check over the existing judge result.

## 4. Fast Delegate Admission

Fast delegate admission should be conservative. It answers only this question:

> Is the existing judge/policy decision strong enough to skip the main agent and start background work immediately?

Initial allow conditions:

- `route_decision.route == "delegate"`.
- WorkContract/admission says execution is allowed.
- Judge succeeded or route source is an accepted deterministic policy rule.
- Confidence is above the configured threshold when present.
- `expected_deliverable` or equivalent task summary is non-empty.
- The task is new work, not a status/provenance/follow-up question.
- No active duplicate or conflicting WorkContract exists for the same turn/thread.
- Delegation is not disabled by config or session policy.
- The task is not a simple reply that the main agent can answer faster.

Initial deny/pass-through conditions:

- Judge timed out, abstained, or returned degraded output.
- Route is `reply` or `observer_probe` without explicit fast-delegate support.
- User is asking about prior task status, provenance, footer, timeout, or result location.
- There is no clear deliverable.
- The request only mentions a model/tool name, for example bare `opencode`, `glm`, `codex`, or `tool`, without asking it to do work.
- Dispatch would require user confirmation, write approval, or ambiguous workspace ownership.

When denied, do not send a failure. Just pass through to the normal path.

## 5. Execution Backend

### 5.1 0.5.x Practical Backend

Use `api.runtime.subagent.run()` or gateway `agent` as the first practical fast backend.

OctoClaw still records minimal runtime truth:

- WorkContract id
- run id
- child session key selected by OctoClaw or returned/inferred by backend
- source route: `fast_delegate`
- backend: `openclaw.gateway_agent` or `plugin_runtime_subagent_run`
- Slack delivery target and footer provenance

This is a small compatibility layer, not a full custom runtime.

### 5.2 Difference From The Old Wheel

Old OctoClaw wheel:

- owned scheduling and execution semantics;
- owned child lifecycle truth;
- owned timeout/completion interpretation;
- owned delivery and recovery;
- could drift from OpenClaw native lifecycle.

Fast delegate small wheel:

- OpenClaw still runs the actual agent/model/session/tools;
- OctoClaw only decides fast route, records minimal ledger, and adapts Slack UX;
- completion/finalizer exists only to bridge the fact that plugin runtime direct spawn is not yet equivalent to tool-level `sessions_spawn`;
- planner/confirm remains available for gray cases and native-chain validation.

The tradeoff is explicit: recover speed now while keeping the execution engine inside OpenClaw.

### 5.3 Future Native Backend

If OpenClaw later exposes a plugin SDK API equivalent to tool-level `sessions_spawn`, replace the backend with that API. The public API would need to return or persist the same truth that `sessions_spawn` has today:

- child session key;
- run id;
- requester origin;
- subagent registry registration;
- announce/delivery behavior;
- idempotency;
- model/thinking override policy;
- thread binding semantics;
- cleanup/failure lifecycle.

Until that API exists, do not block 0.5.x responsiveness on it.

## 6. Avoiding Double Judge

The fast path must not cause judge to run twice.

Required behavior:

```text
before_dispatch generated decision
  -> policyState contains prompt + decision + routeSeal
  -> before_model_resolve calls resolvePolicyDecisionForContext()
  -> cache hit, no LLM judge call
  -> before_prompt_build calls resolvePolicyDecisionForContext()
  -> cache hit, no LLM judge call
```

Implementation requirements:

- Build a managed context for `before_dispatch` that resolves the same state key as later lifecycle hooks.
- Use the same normalized prompt as later lifecycle hooks.
- Store aliases when Slack/channel/session identifiers differ.
- Add regression tests that spy on the LLM judge call and prove it runs once at most.
- Record cache-hit evidence in replay or debug logs for acceptance.

If state key or prompt normalization differs, the system may silently re-judge. That is a release blocker for this fast path.

## 7. ACK Semantics

There are three different ACK/status concepts and they must not be conflated:

| Layer | Timing | Owner | Meaning |
| --- | --- | --- | --- |
| Inbound reaction ACK | immediately after Slack inbound | OpenClaw Slack `ackReaction` / status reactions | Message was received and is being processed |
| Fast delegate receipt | after child run accepted | OctoClaw fast delegate path | Background child has actually been started |
| Final footer | on final delivery | OctoClaw message/footer hook | Provenance of final result |

Do not say `任务已启动。` before the backend returns an accepted run id.

For fast delegate, final footer should report a delegate source such as:

```text
route=delegate | ... | via=fast_delegate
```

For native planner/confirm finals, continue to report:

```text
route=delegate | ... | via=native_announce
```

## 8. Relationship To Planner/Confirm

The planner/confirm chain remains useful, but it should no longer be the only path for delegated work.

Use fast delegate when:

- the existing judge result is strongly delegate;
- the task is obvious background work;
- main-agent reasoning is not needed before spawn.

Use planner/confirm when:

- the task is gray or needs parent-agent reasoning;
- the model should inspect context before deciding;
- exact tool-level native `sessions_spawn` registry/announce behavior is required for the test.

Use normal reply when:

- the task is simple;
- it is a follow-up/status/provenance question;
- fast admission is uncertain.

## 9. Implementation Plan

### P0 Design And Harness

- Add this document and align OpenSpec wording.
- Add focused tests for policy decision cache reuse across `before_dispatch`, `before_model_resolve`, and `before_prompt_build`.
- Fix Slack acceptance harness regex so `route=reply |` is escaped and does not reject neutral ACK text.

### P1 Hook And Shared Decision

- Register OpenClaw `before_dispatch` in OctoClaw runtime.
- Extract a helper that builds the same policy metadata used by later lifecycle hooks.
- Call `resolvePolicyDecisionForContext()` from `before_dispatch`.
- Ensure `policyState` aliases are written for Slack channel/session variants.

### P2 Fast Admission Guard

- Implement `fastDelegateAdmission(decision, state, metadata)` as a small deterministic guard.
- Reuse existing judge fields and WorkContract fields.
- Add deny/pass-through tests for status follow-up, provenance follow-up, bare model/tool mentions, and uncertain judge output.

### P3 Direct Child Run

- Start child via `api.runtime.subagent.run()` or gateway `agent`.
- Persist run binding in runtime ledger and WorkContract metadata.
- Send accepted receipt only after run id is present.
- Add idempotency key based on turn/session/workContractId to avoid duplicate child runs.

### P4 Finalizer And Slack Delivery

- Reuse the existing native announce/direct delivery fixes where possible.
- Keep finalizer minimal and scoped to fast delegate backend gaps.
- Ensure final footer is `delegate` and `via=fast_delegate`, not `reply`.

### P5 Real Slack Smoke

- Record first reaction ACK latency.
- Record judge timing and whether cache was reused.
- Record fast admission result.
- Record child run accepted time.
- Record final footer provenance.
- Keep planner/confirm smoke separate from fast-delegate smoke.

## 9.5 Test Slices Before Runtime Implementation

Do these test/design slices before implementing direct child run. They are intentionally smaller than the full fast delegate feature, so workers can help without drifting into runtime rewrite.

| Slice | Purpose | Required Evidence |
| --- | --- | --- |
| PC15-A context parity | Build a managed context for `before_dispatch` that resolves the same policy state key as later lifecycle hooks | Slack channel, Slack direct, explicit session, and fallback cases produce the same key or documented aliases |
| PC15-B prompt parity | Ensure before-dispatch and lifecycle hooks normalize the same user prompt | Body/content/thread metadata variants do not create cache misses |
| PC15-C no double judge | Prove moving the first decision earlier does not run judge twice | A mocked LLM judge/provider is called at most once across before-dispatch, before-model-resolve, and before-prompt-build |
| PC15-D pass-through compatibility | Prove denied/disabled fast admission leaves current behavior unchanged | Existing reply, route-hint, planner/confirm, footer tests continue passing with cache reuse |
| PC15-E fast admission fixtures | Prove admission is conservative and not a second judge | Explicit background/subagent/parallel allows; status/provenance/simple/one-step lookup/judge-timeout/bare model mention passes through |
| PC15-F accepted receipt boundary | Preserve truthful ACK semantics for future direct backend | No `任务已启动。` before accepted run id exists |
| PC15-G idempotency | Avoid duplicate direct runs on Slack retry/replay | Same inbound turn idempotency key starts at most one child |
| PC15-H observability | Make smoke/eval useful | Replay records evaluated/allowed/pass, cache hit/miss, judge invocation count, accepted timing, footer provenance |
| PC15-I backend contract | Decide `api.runtime.subagent.run()` vs gateway `agent` safely | Contract table covers inputs, returned refs, idempotency, model override, delivery/finalizer gaps, rollback |

Runtime implementation starts only after PC15-A through PC15-D are reviewed. Direct-run backend starts only after PC15-I is reviewed.

## 10. Acceptance Criteria

- For high-confidence delegate prompts, main agent does not start.
- Judge/LLM judge runs at most once per inbound turn.
- Later lifecycle hooks hit policyState cache when the turn is passed through.
- Slack visible inbound reaction ACK p95 <= 3s when OpenClaw Slack config is correct.
- Fast delegate accepted receipt p50 <= 6s and p95 <= 15s on macmini acceptance channel.
- No user-visible `任务已启动。` before accepted run id.
- Final footer uses `route=delegate` and `via=fast_delegate` for fast path.
- Planner/confirm path still passes native smoke and reports `via=native_announce`.
- Slack acceptance harness no longer treats neutral ACK as rejected final due to unescaped regex.

## 11. Open Questions

- Whether `api.runtime.subagent.run()` can reliably expose or infer child session key for all channels.
- Whether we should prefer gateway `agent` directly over plugin runtime for better idempotency and session-key control.
- Whether OpenClaw upstream will expose a public plugin SDK API equivalent to tool-level `sessions_spawn`.
- Whether fast delegate should support observer/read-only lanes in 0.5.x or defer them to planner/confirm.

## 12. Recommendation

Make this the 0.5.x performance recovery direction:

- Keep judge logic stable.
- Move the first decision earlier.
- Use policyState to avoid duplicate judge.
- Use fast delegate only for high-confidence delegated work.
- Keep planner/confirm as the native/gray path.
- Keep the small finalizer/delivery bridge only until OpenClaw exposes a fully equivalent direct native spawn API.
