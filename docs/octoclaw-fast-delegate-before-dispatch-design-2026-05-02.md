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

**推荐形态：native planner acceleration**（`before_dispatch` 只缓存 draft，主 agent 仍然启动但只需 1 turn，后半段完全走原生链）。不推荐 `handled: true` + direct backend 作为首选，因为它绕开了 `registerSubagentRun`，丢失 native announce/delivery chain。

Target flow（native planner acceleration）：

```text
before_dispatch
  -> resolvePolicyDecisionForContext(prompt, managedCtx)
  -> policyState stores decision + WorkContract

  if fastDelegateAdmission(decision, state) == allow:
      -> 生成 FastSpawnPlan draft（含 sessionsSpawnArgs draft、prompt hash、TTL）
      -> 写入 policyState / SQLite
      -> return { handled: false }  ← 主 agent 仍然启动

  else:
      -> return { handled: false }
      -> before_model_resolve 读 policyState cache
      -> before_prompt_build 读 policyState cache

before_prompt_build（draft 命中时）：
  -> 注入最小工具路由指令（appendSystemContext）
  -> 主 agent 首轮直接调 octoclaw_dispatch({ fast: true, spawnPlanId }) + sessions_spawn
  -> 省去 2-3 轮 planner 犹豫，压成 1 turn

sessions_spawn + octoclaw_dispatch_confirm + native announce：完整原生链
```

`handled: true` + direct backend 作为次选，仅在有强烈极致延迟需求且 finalizer 桥接经过 smoke 验证后、通过 feature flag 单独启用。

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

**推荐方案：native planner acceleration（见 5.3）。**

使用 `api.runtime.subagent.run()` 或 gateway `agent` 直接调用（`handled: true`）技术上可行，但有明确的 native announce gap：这条路径不经过 `spawnSubagentDirect()`，不调用 `registerSubagentRun()`，子 agent 完成后没有原生 announce/delivery chain，需要 OctoClaw finalizer 桥接。除非明确接受这个 trade-off 并有可靠的 finalizer 兜底，否则不应作为首选。

OctoClaw 无论选哪条路都需要自己记录：

- WorkContract id
- run id
- child session key
- source route: `fast_delegate`
- backend: `planner_acceleration` / `direct_gateway_agent`
- Slack delivery target 和 footer provenance

这是薄兼容层，不是 full custom runtime。

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
- preferred backend (5.3) keeps full native announce/delivery chain;
- planner/confirm remains available for gray cases and native-chain validation.

### 5.3 Native Planner Acceleration（推荐路径）

这是与 slimming doc 原则完全兼容的快路径。核心思路：**`before_dispatch` 只预计算草稿，主 agent 仍然启动但只需 1 轮工具调用，后半段完全走原生链。**

正确命名：`FastSpawnPlan`（或 `NativeSpawnIntentDraft`），不是 `NativeSpawnIntent`。Draft 不推进执行状态，不发 ACK，不进入 status projection。

```text
message_received / before_dispatch:
  -> resolvePolicyDecisionForContext()，高置信 delegate
  -> 预计算 FastSpawnPlan（含 sessionKey、prompt hash、sessionsSpawnArgs draft）
  -> 写入 policyState / SQLite（TTL 60s）
  -> return { handled: false }  ← 主 agent 仍然启动，不直接 spawn

before_prompt_build:
  -> 检测到 FastSpawnPlan draft 命中（sessionKey + prompt hash 匹配）
  -> 注入 appendSystemContext（最小工具路由指令，不塞大上下文）：
     "OctoClaw 已为本轮准备好高置信委派草稿（planId=xxx）。
      直接调用 octoclaw_dispatch({ fast: true, spawnPlanId: 'xxx' })。
      如果 dispatch 返回 sessionsSpawnArgs，立即调用 sessions_spawn。
      不要先分析，不要直接回答。"

主 agent 首轮 LLM（只有 1 turn）：
  -> 调 octoclaw_dispatch({ fast: true, spawnPlanId: 'xxx' })

octoclaw_dispatch(fast=true) 重新校验 draft：
  校验项：spawnPlanId 存在、sessionKey 匹配、prompt hash 匹配、
          TTL 未过期、judge/policy 仍是 delegate、没有 conflict WorkContract、
          route seal / WorkContract refs 可生成
  校验通过 → materialize WorkContract + NativeSpawnIntent，返回 sessionsSpawnArgs
  校验失败 → 返回 pass_through，主 agent 退化到普通 planner/confirm 路径

主 agent 同一轮 LLM（1 turn 内完成）：
  -> 调原生 sessions_spawn（用 dispatch 返回的 sessionsSpawnArgs）
  -> 调 octoclaw_dispatch_confirm（校验 runId，写入 native refs）

子 agent 完整生命周期（原生链）：
  -> spawnSubagentDirect() + registerSubagentRun + native announce/delivery
```

**这个方案节省的是什么**：主 agent 对"要不要委派"的多轮犹豫（当前 2-3 个 LLM turns），把 planner 握手压成最短工具链（1 turn）。

**这个方案不节省的是**：OpenClaw embedded run startup（工具 bundle、system prompt、stream setup），child bootstrap（用 lightContext 已是 5-10s）。

**与 `handled: true` 路径的对比**：

| | `handled: true` + direct backend | Native planner acceleration（本节）|
| --- | --- | --- |
| Parent LLM turns | 0（绕过）| 1 turn |
| Native announce | 无（需 finalizer 补）| 完整（registerSubagentRun）|
| SpawnSubagentDirect import | 不需要 | 不需要 |
| api.runtime.subagent.run() | 需要 | 不需要 |
| slimming doc 原则兼容 | 需要 finalizer 桥接 | 完全兼容 |
| 延迟节省（parent）| 最大（省整个 parent 首轮）| 次之（省 2+ turns，保留 1 turn）|

**推荐**：优先实现 native planner acceleration。`handled: true` 路径作为后备选项，仅当极致延迟有强烈需求且 finalizer 桥接经过 smoke 验证后再启用，需要 feature flag 和明确 rollback。

### 5.4 Future Native Backend

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

## 7.5 Context And Result Delivery Model

Planner/native delegation and fast delegate deliberately use different context windows.

Planner/native path:

- The parent agent starts first and can see the normal OpenClaw run context: current prompt, system context, tool bundle, policy projection, and available conversation context.
- The child does not automatically inherit the full parent transcript. The default spawn args should keep `context="isolated"` and `lightContext=true`.
- The child prompt should be a compact task packet: user goal, deliverable, acceptance criteria, necessary guardrails, and explicit refs. Large context should move through attachments, workspace refs, or artifact refs instead of raw parent transcript.

Before-dispatch fast delegate path:

- The runtime runs earlier, before parent-model reasoning. It can rely on the inbound message, Slack/session/thread anchors, policyState/runtime ledger, recent receipts, and compact summaries.
- It must pass through when the request depends on broad parent conversation context, ambiguous follow-ups such as "the third point above", status/provenance questions, or missing deliverables.
- Fast admission is allowed only when the current inbound message plus compact refs are enough to start the child safely.

Child result delivery:

- The child result should be delivered directly through native announce or the future fast-delegate delivery path. The parent agent should not read the full child result and rewrite it.
- After delivery, the parent state keeps only compact receipt data: WorkContract id, run id, child session key, result hash, short summary, footer provenance, and artifact refs.
- Full child outputs are reopened only on demand, for example when the user explicitly asks for evidence, details, or the full report.

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

## 8.5 Feasibility Spike Before Implementation

PC15 must start with a feasibility spike. This spike does not start child runs and does not change user-visible behavior. It only proves that the OpenClaw hook surface and OctoClaw state model can support the design.

### Spike Questions

| Question | Why It Matters | Pass Evidence | Fail Action |
| --- | --- | --- | --- |
| Can `before_dispatch` see enough inbound fields? | Fast delegate needs prompt, channel, session, sender, group/direct, timestamp, and Slack anchor hints before agent startup | Probe captures `content`, `body`, `channel`, `sessionKey`, `senderId`, `isGroup`, `timestamp`, and any message/thread ts fields needed for metadata | Keep PC15 design-only and ask upstream/API change or use Slack ingress path instead |
| Can we build a managed ctx accepted by `isManagedAgentContext()`? | `resolvePolicyDecisionForContext()` returns null for unmanaged/subagent/cron contexts | Probe-created ctx passes `isManagedAgentContext()` for Slack channel/direct and explicit session cases | Add an adapter helper or stop; do not bypass the managed-context check |
| Does `resolvePolicyStateKey()` match later lifecycle hooks? | Cache miss means double judge and inconsistent WorkContract | `before_dispatch`, `before_model_resolve`, and `before_prompt_build` produce the same key or documented aliases | Fix ctx adapter before any fast admission work |
| Does prompt normalization match? | Cache miss can also come from `content` vs `bodyForAgent` vs prompt wrappers | `extractPromptText()`/normalizer outputs equivalent prompt across hook events | Add a shared prompt extractor for before-dispatch and lifecycle hooks |
| Does `handled=true` really short-circuit main agent lifecycle? | Fast delegate only helps if main agent does not start | A probe handler returns `handled=true` and proves no `before_model_resolve` / `before_prompt_build` for that turn | Do not use `before_dispatch` for fast delegate; investigate earlier hook or upstream support |
| Can the fast backend return accepted run evidence quickly? | Receipt must wait for real run id but should be much faster than planner/confirm | Dry-run or mocked backend contract shows run id, idempotency key, session key strategy, and error behavior | Keep planner/confirm as the only execution path until backend contract is solved |

### Probe Shape

The first runtime probe should be explicitly non-invasive:

```text
before_dispatch probe mode
  -> collect event/context fields
  -> construct candidate managed ctx
  -> compute stateKey/session aliases
  -> normalize prompt
  -> optionally call resolvePolicyDecisionForContext() behind a flag
  -> write replay event fast_delegate_probe
  -> return handled=false
```

Do not call `api.runtime.subagent.run()` in the probe. Do not send ACK or receipts from the probe. Do not alter planner/confirm behavior.

### 2026-05-03 Unit Probe Evidence

The first non-invasive feasibility probe is implemented in `extensions/octoclaw-runtime/src/fast-delegate/probe.ts`, with focused coverage in `extensions/octoclaw-runtime/src/fast-delegate/probe.test.ts`.

What is proven now:

- Slack channel events can build a candidate managed ctx accepted by `isManagedAgentContext()`.
- Slack direct events can build a candidate managed ctx accepted by `isManagedAgentContext()`.
- `resolvePolicyStateKey()` matches the later lifecycle key for normal Slack channel/direct cases.
- Slack thread/root mismatches are surfaced as explicit binding aliases instead of being hidden.
- Prompt extraction reuses the current `extractPromptText()` / session prompt equivalence logic for Slack mentions, harness wrappers, and busy-queue wrappers.
- Probe replay evidence is compact: it records hashes, lengths, keys, aliases, and metadata refs, not raw full user text.

What is not proven by this unit probe:

- OpenClaw host `before_dispatch` live field shape on macmini or production Slack.
- Whether returning `handled=true` from the real hook prevents `before_model_resolve` / `before_prompt_build` for that turn.
- Whether `api.runtime.subagent.run()` or the gateway agent backend can return accepted run evidence quickly enough for truthful `任务已启动。` receipts.

Do not treat this as runtime implementation approval. It only clears the Slack channel/direct unit feasibility part of PC15-0.

### Probe Replay Event

The replay event should be compact and redact user text beyond a short preview:

```json
{
  "event": "fast_delegate_probe",
  "sessionKey": "agent:main:slack:channel:...",
  "beforeDispatchStateKey": "agent:main:slack:channel:...",
  "lifecycleStateKey": "agent:main:slack:channel:...",
  "stateKeyMatch": true,
  "promptHash": "sha256:...",
  "promptEquivalent": true,
  "isManagedAgentContext": true,
  "hasSlackAnchor": true,
  "handledMode": "pass_through",
  "judgeInvoked": false,
  "decisionCacheHitLater": null
}
```

When the optional decision probe is enabled, add:

```json
{
  "decisionRoute": "delegate",
  "decisionBucket": "must_delegate",
  "judgeInvocationCount": 1,
  "laterLifecycleCacheHit": true
}
```

### Spike Exit Gates

PC15 can move from feasibility to implementation only when:

- Slack channel and Slack direct probes both produce stable state keys or documented aliases.
- Prompt parity passes for plain Slack mention, thread reply, codex-slack-e2e wrapper, and queued-busy prompt wrapper.
- `handled=true` short-circuit is proven in an isolated test with no child run.
- Pass-through with a precomputed decision proves later lifecycle hooks do not re-run LLM judge.
- Backend contract review chooses either `api.runtime.subagent.run()` or gateway `agent` for the first fast backend, with rollback documented.

## 9. Implementation Plan

### P0 Design And Harness

- Add this document and align OpenSpec wording.
- Run PC15-0 feasibility probes before opening runtime implementation.
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
| PC15-0 feasibility spike | Prove `before_dispatch` can support the design before implementation | Probe evidence for hook fields, managed ctx, stateKey/prompt parity, handled=true short-circuit, and backend contract feasibility |
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

### PC15 Test Slice Details

#### PC15-0 Feasibility Spike

Allowed files for spike implementation, when opened:

- a new test/probe module under `extensions/octoclaw-runtime/src/fast-delegate/` or `src/experiments/`;
- focused tests for the probe module;
- replay fixture updates.

Forbidden during spike:

- no child run;
- no accepted ACK;
- no finalizer/delivery changes;
- no judge semantic changes.

Required cases:

- Slack channel mention with explicit channel session key; unit-covered in `probe.test.ts`;
- Slack direct message session key; unit-covered in `probe.test.ts`;
- explicit non-Slack session key fallback;
- `handled=true` dummy result proving OpenClaw short-circuits later lifecycle;
- `handled=false` pass-through proving later cache reuse.

#### PC15-A Context Parity

Create fixtures that compare:

- raw `before_dispatch` event/context;
- candidate managed ctx produced by the adapter;
- lifecycle ctx used by `before_model_resolve` / `before_prompt_build`.

Assertions:

- `isManagedAgentContext(candidateCtx) === true` for user-facing turns;
- `resolvePolicyStateKeys(candidateCtx)[0]` equals lifecycle key or appears in lifecycle alias list;
- `buildPolicyMetadata(candidateCtx).session_key` equals the dispatchable user session key;
- message id/thread ts are preserved when present.

#### PC15-B Prompt Parity

Fixtures must cover:

- plain Slack text;
- Slack mention-stripped body;
- thread reply body;
- `codex-slack-e2e` wrapper;
- queued busy wrapper;
- body/content mismatch where one field contains transport metadata.

Assertions:

- prompt hashes match after normalization, or `promptsEquivalent()` returns true;
- no empty prompt is sent to `resolvePolicyDecisionForContext()`;
- prompt preview in replay is truncated and redacted.

#### PC15-C No Double Judge

Use a mocked judge provider or fetch spy. The exact seam may be `callLlmJudge`, the OpenAI-compatible endpoint, or the existing judge config fetch path.

Assertions:

- first `before_dispatch` decision path invokes judge at most once;
- later `before_model_resolve` returns cached decision;
- later `before_prompt_build` returns cached decision;
- WorkContract id and route seal stay stable across the three stages;
- timeout/degraded judge result is cached as pass-through rather than retried in the same turn.

#### PC15-D Pass-Through Compatibility

Run existing focused suites with the experiment disabled and enabled-but-pass-through:

- reply-route footer and message guard;
- route hint merge/objection;
- planner/confirm smoke unit path;
- native spawn gate block/allow;
- neutral ACK behavior.

Assertions:

- no changed user-visible text;
- no extra WorkContract for the same turn;
- no legacy queue/outbox writes introduced;
- no extra judge invocation.

#### PC15-E Fast Admission Fixtures

Admission allows only high-confidence cases:

- explicit "use a subagent/background/parallel worker";
- code edit plus tests/build;
- multi-step validation/review;
- expected duration over configured threshold with clear deliverable.

Admission passes through:

- status/provenance/footer/timeout follow-up;
- one-step lookup;
- simple summarize/rewrite/explain;
- judge timeout/degraded/abstain;
- bare mentions of `opencode`, `glm`, model names, or tools without a work command;
- missing expected deliverable;
- duplicate active WorkContract.

#### PC15-F Accepted Receipt Boundary

Mock backend responses:

- accepted with run id;
- accepted without run id;
- error;
- timeout;
- duplicate same idempotency key.

Assertions:

- only accepted with non-empty run id can produce `任务已启动。`;
- all other outcomes are silent pass-through or explicit failure without delegated/running claim;
- accepted receipt is deduped by turn/workContract/backend idempotency key.

#### PC15-G Idempotency

Use the same inbound Slack event twice and vary retry timing.

Assertions:

- same idempotency key;
- one backend run;
- one accepted receipt;
- one WorkContract binding;
- replay records duplicate suppression.

#### PC15-H Observability

Required replay/report fields:

- `fast_delegate_evaluated`;
- `fast_delegate_result=allowed|passed|disabled|probe_only|error`;
- `state_key_match`;
- `prompt_equivalent`;
- `judge_invocation_count`;
- `decision_cache_hit_later`;
- `backend_accept_ms` when backend is enabled;
- `footer_via=fast_delegate` for future finals.

#### PC15-I Backend Contract

Compare `api.runtime.subagent.run()` and gateway `agent` on:

- controllable `sessionKey`;
- returned `runId`;
- child session key strategy;
- provider/model override authorization;
- idempotency key behavior;
- `deliver:false` behavior;
- finalizer/delivery gap;
- abort/wait behavior;
- rollback flag.

Do not select a backend until this table is filled from code inspection or a local smoke.

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
