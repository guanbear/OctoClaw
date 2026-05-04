# Spec Delta: 0.5.0 Planner/Confirm Delegation

## ADDED Requirements

### Requirement: Planner Output Does Not Execute

When `OCTOCLAW_SPAWN_BACKEND=planner`, `octoclaw_dispatch` SHALL produce a compact native spawn intent and SHALL NOT spawn, materialize legacy execution, write running state, or send delegate accepted ACK.

#### Scenario: planner creates spawn intent

- WHEN judge/admission selects delegate
- AND the planner backend is enabled
- THEN `octoclaw_dispatch` SHALL return `status=requires_native_spawn`
- AND SHALL include `spawnIntentId`, `workContractId`, `nextTool=sessions_spawn`, `confirmTool=octoclaw_dispatch_confirm`, and compact `sessionsSpawnArgs`
- AND SHALL NOT create completion binding, scheduler queue, child finalizer work, or delivery outbox work.

### Requirement: Native Spawn Requires Matching Intent

OctoClaw SHALL gate `sessions_spawn` calls with a pending `NativeSpawnIntent` bound to the current session, TTL, and canonical args hash.

#### Scenario: no pending intent

- WHEN the main agent calls `sessions_spawn`
- AND no pending intent exists for the current session
- THEN OctoClaw SHALL block the tool call
- AND SHALL report that `octoclaw_dispatch` is required first.

#### Scenario: args mismatch

- WHEN the main agent calls `sessions_spawn`
- AND the canonical hash of the tool args differs from the pending intent hash
- THEN OctoClaw SHALL block the tool call
- AND SHALL NOT update WorkContract native refs.

#### Scenario: intent expired

- WHEN the pending intent TTL has expired
- THEN OctoClaw SHALL block `sessions_spawn`
- AND SHALL require a fresh `octoclaw_dispatch`.

### Requirement: Confirm Requires Native Run Evidence

`octoclaw_dispatch_confirm` SHALL require native accepted run evidence before recording a successful delegation.

#### Scenario: accepted with runId

- WHEN native `sessions_spawn` returns accepted
- AND `octoclaw_dispatch_confirm` receives a matching `spawnIntentId`, `workContractId`, and non-empty `runId`
- THEN OctoClaw SHALL write WorkContract native refs
- AND SHALL mark the intent accepted
- AND SHALL send at most one delegate accepted ACK.

#### Scenario: accepted without runId

- WHEN confirm input has `sessionsSpawnStatus=accepted`
- AND `runId` is missing or empty
- THEN confirm SHALL fail closed
- AND SHALL NOT write native refs
- AND SHALL NOT send delegate accepted ACK.

#### Scenario: duplicate confirm after accepted

- WHEN an already accepted intent is confirmed again with the same `runId`
- THEN confirm SHALL return idempotent success
- AND SHALL NOT send duplicate ACK.

#### Scenario: conflicting confirm

- WHEN an already accepted intent is confirmed with a different `runId`
- THEN confirm SHALL return conflict
- AND SHALL preserve the first accepted native refs.

### Requirement: Delegate ACK Is Truthful

OctoClaw SHALL NOT tell the user that work has been handed to a sub-agent until confirm has accepted native run evidence.

#### Scenario: delegate candidate before spawn

- WHEN judge/admission selects delegate
- AND native `sessions_spawn` has not been accepted and confirmed
- THEN user-visible ACK SHALL NOT say handed off, running, completed, or successful.

#### Scenario: native spawn error

- WHEN native `sessions_spawn` returns error
- THEN OctoClaw SHALL record failed confirm or failed intent state
- AND SHALL NOT send delegate accepted ACK.

### Requirement: Completion Uses Native Announce On Planner Path

Planner path SHALL rely on OpenClaw native subagent announce/delivery for child completion.

#### Scenario: child does not write completion file

- WHEN a planner-spawned child run completes
- AND no `.completion.json` is written
- THEN completion SHALL still return through native announce/delivery
- AND OctoClaw SHALL NOT send a duplicate final message from completion binding or delivery outbox.

### Requirement: WorkContract Stores Metadata Only

WorkContract SHALL store native refs and semantic contract fields, but SHALL NOT become the execution lifecycle truth source.

#### Scenario: status projection

- WHEN WorkContract has `openclawRunId`
- THEN status projection SHALL query OpenClaw native runs/flows/subagent registry
- AND SHALL NOT infer running/succeeded/failed solely from WorkContract fields.

### Requirement: Worker Slices Are Bounded By OpenSpec

Parallel implementation work SHALL be split into bounded OpenSpec task slices with explicit ownership and tests.

#### Scenario: worker claims a slice

- WHEN a GLM-5.1 or cheaper worker starts an implementation slice
- THEN the slice SHALL declare owned files, forbidden files, truth source, expected tests, and acceptance evidence
- AND the worker SHALL NOT modify hot-path files outside the slice.

#### Scenario: leader-owned hot path

- WHEN a change affects spawn authorization, `before_tool_call`, dispatch planner output, confirm semantics, judge admission, or user-visible delegate ACK
- THEN Codex leader or a strong-model review SHALL own or approve the change before merge.

### Requirement: Context Pollution Is Bounded

Planner/confirm packets SHALL keep parent context compact and sanitized.

#### Scenario: planner output

- WHEN `octoclaw_dispatch` returns planner output
- THEN it SHALL NOT include raw child transcript, full judge packet, policy traces, ledger rows, or execution logs
- AND large context SHALL be passed by attachment or workspace reference instead of parent tool-result payload.

### Requirement: Neutral Inbound ACK Is Pre-Route And Truthful

OctoClaw SHALL support a route-independent neutral inbound ACK for Slack when configured.

#### Scenario: inbound Slack message before route decision

- WHEN a Slack inbound message has a valid channel/message anchor
- THEN OctoClaw SHALL send or request at most one neutral ACK within the configured 1-5s target
- AND the ACK SHALL only indicate received/deciding
- AND SHALL NOT claim delegation, spawn success, running state, or completion.

#### Scenario: no valid ACK anchor

- WHEN OctoClaw cannot resolve a stable inbound Slack anchor
- THEN it SHALL fail closed with replay/diagnostic evidence such as `no_valid_thread_target`
- AND SHALL NOT guess the target from a session key.

### Requirement: Startup-Cost-Aware Delegation

Delegation decisions SHALL account for native spawn cold-start cost and SHALL avoid delegating short work by default.

#### Scenario: one-step fresh lookup

- WHEN the request is a one-step fresh lookup with a short expected answer
- THEN the decision bucket SHALL be `must_reply/main_fast_path` or `budgeted_main_then_delegate`
- AND `fresh_live_lookup` SHALL NOT force delegate by itself.

#### Scenario: hard delegate signal

- WHEN the request explicitly asks for background/subagent/parallel work, code edits, tests/builds, long commands, multi-step tools, review/validation, or expected duration over 90-120s
- THEN the decision bucket MAY be `must_delegate`
- AND the decision SHALL record reason codes, duration hint, tool need hint, startup cost policy, and hard delegate signal.

#### Scenario: budget escalation

- WHEN a budgeted main fast path exceeds a fixed 30s soft main execution budget, exceeds 1-2 read-only tool calls, needs write/long-running work, or exceeds context budget
- THEN OctoClaw SHALL record budget metrics including `elapsedMs`, `maxWallMs=30000`, `visibleElapsedMs`, `budgetStartSource`, tool counts, and escalation reason
- AND timer expiry without a reliable interrupt/reinjection point SHALL record `budgeted_main_escalated_pending` rather than direct spawn or accepted ACK
- AND a final reply produced after the soft budget SHALL be delivered normally, recorded as `budgeted_main_completed_late`, and SHALL NOT create a spawn
- AND the next ordinary tool or prompt-injection boundary MAY be blocked or rewritten to require `octoclaw_dispatch`
- AND escalation SHALL use the planner/native path `octoclaw_dispatch -> sessions_spawn -> octoclaw_dispatch_confirm`
- AND OctoClaw SHALL NOT direct spawn or claim the task has started before `sessions_spawn` accepted and `octoclaw_dispatch_confirm` succeeds.

### Requirement: Planner Spawn Context Is Isolated And Compact

Planner-generated `sessions_spawn` arguments SHALL use OpenClaw public tool parameters and keep child context isolated by default.

#### Scenario: planner builds sessions_spawn args

- WHEN `octoclaw_dispatch` returns `sessionsSpawnArgs`
- THEN args SHALL include `context=isolated` and `lightContext=true` unless a tested exception needs `context=fork`
- AND SHALL keep task payload compact
- AND SHALL NOT include target/delivery parameters rejected by OpenClaw `sessions_spawn`.

### Requirement: NativeSpawnIntent Transitions Are Atomic And Observable

Native spawn intent status changes SHALL be safe under retry, restart, and lock contention.

#### Scenario: concurrent confirm or transition

- WHEN multiple confirm or transition attempts race on the same intent
- THEN only valid status/hash/session transitions SHALL succeed
- AND repeated same-run confirm SHALL be idempotent
- AND conflicting run evidence SHALL preserve the first accepted refs.

#### Scenario: SQLite busy or lock contention

- WHEN SQLite returns busy/locked during an authorization or confirm transition
- THEN OctoClaw SHALL retry/back off or fail with explicit replay evidence
- AND SHALL NOT treat the failure as no task, no spawn, or successful delegation.

### Requirement: Native Announce Footer Preserves Delegate Provenance

Footer is a debug projection and SHALL not contradict accepted native refs.

#### Scenario: child final delivered through native announce

- WHEN a planner-spawned child final is delivered back through the parent Slack thread
- AND accepted native refs or child announce provenance bind it to a WorkContract
- THEN debug footer SHALL show delegate/native provenance such as `route=delegate` and `via=subagent` or `via=native_announce`
- AND SHALL NOT be overwritten by the parent delivery turn route as `route=reply | via=policy`.

### Requirement: Slack Delivery Port Is 0.5.x Immediate And Slack-Only

Slack message delivery hot path SHOULD move away from CLI/shell after 0.5.0 Must + Should acceptance.

#### Scenario: Slack native delivery path

- WHEN PC13 is enabled
- THEN Slack neutral ACK, delegate accepted ACK, thread reply, native announce final delivery, and debug footer SHALL use a Slack delivery port or explicit Slack reaction backend
- AND SHALL NOT call `openclaw message send` or parse CLI stdout/stderr on the hot path
- AND `OCTOCLAW_LEGACY_CLI_DELIVERY=1` SHALL restore the old Slack CLI path.

#### Scenario: non-Slack IM

- WHEN PC13 changes Slack delivery
- THEN non-Slack IM behavior SHALL remain on existing fallback
- AND SHALL NOT become a 0.5.x immediate acceptance blocker.

### Requirement: Nightly Regression Harness Records Required Metrics

Regression reports SHALL make route quality, latency, footer, and legacy fallback behavior observable.

#### Scenario: nightly report

- WHEN the nightly or Slack acceptance harness runs planner-confirm scenarios
- THEN the report SHALL include neutral ACK latency, route decision/bucket, spawn allowed latency, confirm ACK latency, child progress/final latency, footer provenance, whether `completion_file_timeout` appeared, and whether legacy CLI delivery was used.

### Requirement: Before-Dispatch Fast Delegate Reuses Existing Judge

The before-dispatch fast delegate design SHALL reuse the existing OctoClaw policy resolver and judge outputs. It SHALL NOT introduce a second semantic judge or independent keyword router.

#### Scenario: feasibility is proven before implementation

- WHEN PC15 moves from design to runtime implementation
- THEN OctoClaw SHALL first prove that `before_dispatch` exposes sufficient inbound fields, can construct a managed context, can align state key and prompt normalization with later lifecycle hooks, and can short-circuit main-agent lifecycle with `handled=true`
- AND this proof SHALL NOT start child runs, send delegate accepted ACK, or alter planner/confirm behavior.

#### Scenario: before_dispatch computes policy first

- WHEN a before-dispatch fast delegate experiment evaluates an inbound turn
- THEN it SHALL call the same policy decision path used by the current lifecycle, such as `resolvePolicyDecisionForContext()`
- AND it SHALL persist the decision in `policyState` with the same normalized prompt and state key expected by later lifecycle hooks.

#### Scenario: pass-through does not re-judge

- WHEN before-dispatch evaluates a turn and returns `handled=false`
- AND OpenClaw continues into `before_model_resolve` and `before_prompt_build`
- THEN later hooks SHALL reuse the cached policy decision
- AND LLM judge SHALL be invoked at most once for that inbound turn.

#### Scenario: fast admission is a guard, not a judge

- WHEN an existing policy decision is evaluated for fast delegate
- THEN fast admission SHALL only allow direct background execution for high-confidence delegate decisions with an allowed WorkContract/admission and clear expected deliverable
- AND uncertain, timed-out, degraded, follow-up, status/provenance, simple-reply, or bare model/tool mention cases SHALL pass through.

#### Scenario: no false delegate receipt

- WHEN fast admission allows a future direct-run backend
- THEN OctoClaw SHALL NOT send a delegate accepted receipt until that backend returns accepted run evidence with a non-empty run id.

#### Scenario: planner remains native gray path

- WHEN fast admission passes through or is disabled
- THEN planner/confirm behavior SHALL remain unchanged
- AND native `sessions_spawn` planner/confirm acceptance tests SHALL still pass.
