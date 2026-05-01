# OctoClaw WorkContract-Centered Delegation Design v2

Date: 2026-04-25
Branch reference: `release/0.3.0-ts-rebuild`
OpenClaw source reference: `openclaw/openclaw` `release/2026.4.21` / `v2026.4.21`, commit `f788c88b4c508c335336fb292afed8c900656d6d`, package version `2026.4.21`

## 1. Decision

Keep native TaskFlow as the authoritative execution lifecycle truth.

Add a small OctoClaw `WorkContract` as the authoritative semantic and delegation contract.

The two are not competing truths:

```text
Native TaskFlow
  Owns: flow lifecycle, flowId, ownerKey, status, revision, expectedRevision
        guarded mutations, wait/resume/finish/fail/cancel execution facts.

Native TaskRun / session registry / process supervisor
  Owns: child run/session identity, childSessionKey/sessionId/runId,
        spawn/terminal events, delivery status, runtime process evidence.

WorkContract
  Owns: user ask, intent class, route seal, reply/delegate contract, scope,
        acceptance criteria, child-session continuity, parent-visible context,
        artifact refs, next action.

TurnExecutionReceipt / ExecutionCoveragePacket
  Owns: provenance/status evidence for current or recent turns.
  It is derived from receipts, route seal, tool receipts, native facts, delivery.

Artifact index
  Owns: durable worker reports, context packs, verification evidence, patches,
        operator surfaces, selected log excerpts.

ACK / status / IM display / conversation grounding
  Own: projections only. They do not invent route or execution truth.
```

This is the smallest shape that preserves the current OctoClaw direction while borrowing the useful part of OMO: stable child-session continuity and "resume, do not restart".

## 2. Why the previous design needed tightening

The first WorkContract draft had the right center of gravity, but it under-modeled two things now made explicit in the updated docs:

1. `execution coverage` is a first-class judge-context layer.
2. provenance/status follow-up is often `reply.answer`, not `delegate`.

The updated design docs say:

- `execution coverage` answers "who did it / how was it checked / did dispatch really execute".
- `memory coverage` answers stable background, preferences, and prior design context.
- If memory and execution conflict, execution wins.
- A provenance/status follow-up with sufficient execution coverage must not spawn a new worker.

Therefore WorkContract v2 treats coverage as pre-judge input and records the coverage snapshot used to seal the route. It does not turn every provenance/status question into delegated work.

## 3. Existing implementation facts this design uses

Current code already has many of the pieces:

1. `packages/octoclaw-contracts/src/delegate.ts`
   - `DelegateTask`, `DelegateAttempt`, `NativeTaskBinding`, `ResumePacket`, `StatusQueryPacket`.
2. `packages/octoclaw-contracts/src/delegate-context.ts`
   - `DelegateHandoffPacket`, `WorkerResultPacket`, `DelegateStatusPacket`, context budgets.
3. `extensions/octoclaw-runtime/src/resolve/policy-resolver.ts`
   - local/remote judge, validator overrides, route/model/review policy output.
4. `extensions/octoclaw-runtime/src/resolve/judge-context-packet.ts`
   - structured judge packet builder, currently core/continuation/binding/evidence.
5. `extensions/octoclaw-runtime/src/replay/replay-logger.ts`
   - `TurnExecutionReceipt`, already the correct source for provenance.
6. `extensions/octoclaw-runtime/src/extension-entry.ts`
   - `buildRecentExecutionFacts(...)` and policy hooks, but recent execution is currently appended as ad hoc packet data.
7. `extensions/octoclaw-runtime/src/runtime-payloads.ts`
   - materializes native workflow/task, creates delegate task/attempt, and builds handoff packet.
8. `extensions/octoclaw-runtime/src/state/policy-state.ts`
   - current mixed state store; should become a compatibility store plus WorkContract pointer.
9. `extensions/octoclaw-runtime/src/context/context-budget.ts`
   - already enforces the right parent-context hygiene and should become mandatory boundary.

The refactor should not throw these away. It should place them behind one contract surface.

## 4. Source references to borrow

### 4.1 OMO session_id continuity

OMO's important idea is not merely "return a session id". It is a continuity protocol:

1. A delegated task returns `<task_metadata>session_id: ...</task_metadata>`.
2. Follow-up work resumes that exact child session instead of spawning a new one.
3. The orchestrator stores preferred sessions per active task.
4. Compaction reminders explicitly say "resume, do not restart".
5. Continuation preserves child context while keeping parent context smaller.

OctoClaw should borrow this as `ChildSessionContinuity`.

OMO exposes `session_id` directly to the main agent. OctoClaw should prefer a safer handle:

```text
parent-visible continuation handle:
  workContractId + delegateTaskId + childSessionKey

normal tool call:
  octoclaw_dispatch({ workContractId, continuationMode: "resume_preferred" })

fallback/debug:
  octoclaw_dispatch({ delegateTaskId, childSessionKey })
```

The parent agent should usually continue by `workContractId` or `delegateTaskId`; runtime chooses the preferred child session. The raw child session identity should still be stored because it is the actual continuity identity.

### 4.2 OpenClaw TaskFlow/session/run primitives

The OpenClaw `release/2026.4.21` source gives the concrete substrate this design should align with:

1. `src/plugins/runtime/runtime-taskflow.types.ts`
   - managed TaskFlow mutations are `createManaged`, `setWaiting`, `resume`, `finish`, `fail`, `requestCancel`, `cancel`, and `runTask`.
   - every mutation after create is guarded by `expectedRevision`.
   - mutation errors are `not_found`, `not_managed`, and `revision_conflict`.
2. `src/tasks/task-flow-registry.types.ts`
   - the native record shape is `flowId`, `syncMode`, `ownerKey`, `controllerId`, `revision`, `status`, `goal`, `currentStep`, `stateJson`, `waitJson`.
3. `extensions/lobster/src/lobster-taskflow.ts`
   - the working pattern is create managed flow, run work, then `setWaiting`/`finish`/`fail`; resume first calls `resume({ flowId, expectedRevision })`, then mutates with the returned revision.
4. `src/agents/tools/sessions-spawn-tool.ts`, `src/agents/subagent-spawn.ts`, and `src/agents/acp-spawn.ts`
   - multi-agent dispatch is mostly LLM choice under tool affordance plus code-level policy: the model sees `sessions_spawn`/`subagents`, while code enforces depth, max children, allowed agents, sandbox, run registry, and child session creation.
   - OpenClaw uses `childSessionKey` and `runId` as primary parent-visible child handles; CLI/ACP provider `sessionId` is stored under session-store/runtime metadata.
   - 4.21 also threads `expectsCompletionMessage`, group/member delivery context, direct thread delivery for persistent child sessions, and role-context failure metadata. Therefore OctoClaw must not assume every child completion is announced through the same parent message path.
5. `src/agents/subagent-registry-lifecycle.ts`
   - child completion freezes a compact result and finalizes TaskRun state; parent surfaces receive lifecycle/status projections, not full child transcript.
6. `src/plugins/runtime/runtime-tasks.types.ts`
   - DTO `runtime.tasks.flows` remains read-only projection in 4.21, while mutable managed-flow operations still live under legacy `runtime.taskFlow.bindSession`.
   - 4.21 exports `DetachedTaskLifecycleRuntime`; execution receipts should allow TaskRun/session lifecycle evidence to come from detached lifecycle plumbing, not only immediate spawn tool return values.

Implication for OctoClaw:

```text
native TaskFlow unique truth is still correct,
but "native execution truth" is the combination of:
  TaskFlow lifecycle: flow status/revision/wait/resume/finish/fail
  TaskRun registry: task/run/delivery/terminal status
  session registry: childSessionKey/sessionId/provider binding
  TurnExecutionReceipt: per-turn provenance packet
```

WorkContract must reference these native truths; it must not duplicate them as its own hidden scheduler.

## 5. New canonical contracts

### 5.1 WorkContract

Add `packages/octoclaw-contracts/src/work-contract.ts`.

```ts
export type WorkRoute = "reply" | "delegate";

export type IntentClass =
  | "plain_chat"
  | "runtime_read_model"
  | "execution_followup"
  | "local_surface_lookup"
  | "fresh_live_lookup"
  | "delegated_work"
  | "undetermined";

export type WorkContractStatus =
  | "draft"
  | "sealed"
  | "materializing"
  | "planned"
  | "queued"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export interface WorkContract {
  schemaVersion: "octoclaw.work_contract.v1";
  workContractId: string;
  turnId: string;
  sessionKey: string;
  userAsk: string;
  intentClass: IntentClass;
  route: WorkRoute;
  status: WorkContractStatus;

  coverage: ContextCoverageSnapshot;
  decision: WorkDecisionSeal;
  reply?: ReplyContract;
  delegate?: DelegateContract;
  continuity: WorkContinuity;
  mainContext: MainContextPacket;
  telemetry: WorkContractTelemetry;

  createdAt: string;
  updatedAt: string;
}
```

### 5.2 ContextCoverageSnapshot

This records what the system knew before route seal. It is not the execution truth itself; it is a decision-time evidence snapshot.

```ts
export interface ContextCoverageSnapshot {
  precheckOrder: [
    "conversation_grounding",
    "continuation_route_reuse",
    "execution_coverage",
    "memory_coverage",
    "build_judge_context_packet",
    "local_judge",
    "validator_or_remote",
    "route_seal_commit"
  ];
  execution: JudgeExecutionLayer;
  memory: JudgeMemoryLayer;
  conflict: boolean;
  authority: "execution_wins" | "memory_only" | "none";
}
```

For provenance/status follow-up:

```text
execution.supports_provenance_reply=true -> route=reply, replyMode=answer
execution.supports_status_reply=true -> route=reply, replyMode=answer
execution.requires_control_plane_refresh=true -> route=reply, allowed control tool only
```

Do not create a delegated work unit to prove whether a delegated work unit existed.

### 5.3 WorkDecisionSeal

```ts
export interface WorkDecisionSeal {
  source:
    | "continuation"
    | "execution_coverage"
    | "local_judge"
    | "remote_judge"
    | "validator"
    | "main_agent_route_hint"
    | "policy_rule";
  route: WorkRoute;
  replyMode?: "answer" | "clarify";
  delegateRole?: "observer" | "default" | "code" | "research" | "review";
  confidence?: number;
  reasonCodes: string[];
  routeSealId?: string;
  judgeTraceRef?: string;
  sealedAt: string;
}
```

Legacy `route_decision`, `router_decision_v2`, and `tool_policy` should be generated from this, not treated as peer truths.

### 5.4 ReplyContract

```ts
export interface ReplyContract {
  replyMode: "answer" | "clarify" | "status_summary";
  grounding:
    | "none"
    | "memory"
    | "execution_receipt"
    | "control_plane_status"
    | "artifact_summary";
  allowedTools: string[];
  forbiddenTools: string[];
  evidenceRefs: string[];
}
```

For provenance/status cases, `grounding` should usually be `execution_receipt` or `control_plane_status`.

### 5.5 DelegateContract

```ts
export interface DelegateContract {
  delegateTaskId: string;
  currentAttemptId: string | null;
  role: "observer" | "default" | "code" | "research" | "review";
  coordinationMode: "solo_worker" | "advisor_assisted" | "multi_agent_controlled";
  acceptanceCriteria: string[];
  scope: {
    read: string[];
    write: string[];
    workspaceMode: "read_only" | "write_allowed";
    scopeFingerprint: string;
  };
  modelProfile: string;
  nativeBinding: NativeBindingRef | null;
  childSessions: ChildSessionContinuity[];
  artifactRefs: DelegateArtifactRef[];
  nextAction: "dispatch" | "wait" | "open_artifact" | "ask_user" | "retry" | "deliver";
  blocker?: string;
}
```

### 5.6 ChildSessionContinuity

This is the explicit OMO borrowing.

```ts
export interface ChildSessionContinuity {
  /**
   * OpenClaw parent-visible session key, e.g. agent:codex:subagent:<uuid>.
   * This is the stable handle for sessions_send/subagents/status APIs.
   */
  childSessionKey: string;
  /**
   * Provider/runtime session id when known, e.g. Codex/CLI/ACP session id.
   * This may be absent at spawn time. Never fake it.
   */
  childSessionId?: string;
  /**
   * CLI/ACP provider-specific binding when OpenClaw stores one in SessionEntry.
   * Keep this as metadata; do not expose it as the normal parent handle.
   */
  providerSessionBinding?: {
    provider: "codex" | "claude-code" | "acp" | string;
    sessionId?: string;
    runtimeSessionName?: string;
    sessionFile?: string;
  };
  runId?: string;
  expectsCompletionMessage?: boolean;
  directThreadDelivery?: boolean;
  delegateTaskId: string;
  firstAttemptId: string;
  latestAttemptId: string;
  agentRole: string;
  modelProfile: string;
  category?: string;
  parentSessionKey: string;
  threadBindingKey: string;
  scopeFingerprint: string;
  status: "created" | "running" | "idle" | "blocked" | "completed" | "failed" | "retired";
  reuseState: "preferred" | "eligible" | "blocked" | "retired";
  reuseBlockedReason?: string;
  lastPromptHash?: string;
  lastResultArtifactRef?: string;
  lastEventAt?: string;
}
```

Reuse rules:

1. Same `delegateTaskId`, compatible `scopeFingerprint`, same role family -> prefer resume.
2. Retry due to transient error -> prefer resume if child context is healthy.
3. Retry due to context contamination, wrong scope, or corrupted child session -> create new child session and mark old one `retired`.
4. User follow-up on same work -> resume preferred child session.
5. New user intent -> new WorkContract; do not reuse child session just because it exists.

This gives OctoClaw the benefit of OMO `session_id` continuity while matching OpenClaw 4.21 real handles: `childSessionKey` is the normal parent-visible identity, `childSessionId` is provider/runtime continuity when available, and `runId` is execution evidence. `expectsCompletionMessage` and `directThreadDelivery` are important because a persistent/thread-bound child may deliver directly to its own thread instead of announcing completion through the parent path.

Current implementation gap as of 2026-05-01: `continuationMode=resume_preferred` can select and store a preferred `childSessionKey`, but live dispatch still creates a fresh random child session before calling the subagent runtime. N1 must thread the selected key into spawn/resume materialization and prove with tests that follow-up dispatch reuses the preferred child session unless the contract says it is retired or incompatible.

### 5.7 NativeBindingRef

```ts
export interface NativeBindingRef {
  /**
   * OpenClaw TaskFlow identity and owner.
   * `nativeFlowId` may be kept as a compatibility alias, but new code should use flowId.
   */
  flowId: string;
  nativeFlowId?: string;
  ownerKey: string;
  controllerId: "octoclaw.delegate" | string;

  /**
   * Native optimistic concurrency. Every setWaiting/resume/finish/fail/cancel
   * must pass the revision it observed.
   */
  revision: number;
  expectedRevision: number;

  /**
   * Linked TaskRun identity, if dispatch created a native child task/run.
   */
  taskId?: string;
  nativeTaskId?: string;
  runId?: string;
  childSessionKey?: string;

  syncMode: "managed" | "task_mirrored";
  status: "queued" | "running" | "waiting" | "blocked" | "succeeded" | "failed" | "cancelled" | "lost";
  currentStep?: string;
  waitKind?: string;
  stateRef?: string;
  waitRef?: string;
  requesterOriginRef?: string;
  boundAt?: string;
  lastMutation?: "createManaged" | "runTask" | "setWaiting" | "resume" | "finish" | "fail" | "requestCancel" | "cancel";
  lastMutationApplied?: boolean;
  lastMutationError?: "not_found" | "not_managed" | "revision_conflict";
}
```

This is a pointer to native execution truth. It is not a replacement for native truth. `resumeGeneration` should not be the primary guard because OpenClaw already has revisioned mutations; if OctoClaw keeps an attempt counter, it belongs on `DelegateAttempt`, not on the TaskFlow binding.

### 5.8 MainContextPacket

```ts
export interface MainContextPacket {
  summary: string;
  statusLine: string;
  visibleIds: {
    workContractId: string;
    delegateTaskId?: string;
    attemptId?: string;
    nativeTaskId?: string;
    nativeFlowId?: string;
    childSessionKey?: string;
    childSessionId?: string;
  };
  continuationHint?: {
    handle: string;
    preferredMode: "resume_preferred" | "status_only" | "new_attempt";
    text: "resume_dont_restart";
  };
  artifactRefs: string[];
  nextAction: string;
  tokenBudget: {
    maxResumeTokens: 700;
    maxArtifactSummaryTokens: 250;
  };
  forbiddenContent: Array<
    | "full_transcript"
    | "internal_route_rationale"
    | "delegation_rationale"
    | "contamination_guard_text"
    | "worker_chain_of_thought"
    | "raw_execution_log"
  >;
}
```

The main agent can know the whole picture by seeing ids, status, artifacts, next action, and continuation handle. It does not need child transcript or internal route rationale.

## 6. Updated lifecycle

### 6.1 New user turn

```text
before_prompt_build
  1. conversation grounding
  2. continuation route reuse
  3. execution coverage precheck
  4. memory coverage precheck
  5. build JudgeContextPacket(memory + execution)
  6. call local judge
  7. validator / objection / remote judge
  8. route seal commit
  9. create and persist WorkContract
 10. inject only MainContextPacket + allowed tool instruction
```

Important:

- execution coverage runs before memory coverage
- memory never proves execution provenance
- execution wins over memory on provenance/status
- sufficient execution coverage can seal `reply.answer`

### 6.2 Reply path

For direct answer:

```text
WorkContract.route = reply
ReplyContract.grounding = none | memory | execution_receipt | artifact_summary
allowedTools = []
```

For provenance/status with sufficient coverage:

```text
WorkContract.route = reply
ReplyContract.grounding = execution_receipt
reasonCodes includes execution_coverage_supports_provenance_reply
forbiddenTools includes octoclaw_dispatch, octoclaw_spawn
```

For status requiring refresh:

```text
WorkContract.route = reply
ReplyContract.grounding = control_plane_status
allowedTools = ["octoclaw_status", "octoclaw_task_action"]
forbiddenTools includes octoclaw_dispatch, octoclaw_spawn
```

### 6.3 Delegate path

For new work requiring external lookup, workspace inspection, command execution, or long-running work:

```text
WorkContract.route = delegate
DelegateContract.nextAction = dispatch
DelegateContract.nativeBinding = null
DelegateContract.childSessions = []
```

Then:

```text
octoclaw_dispatch(workContractId)
  -> load sealed WorkContract
  -> reject if route != delegate
  -> create or load managed OpenClaw TaskFlow
  -> mutate TaskFlow only through expectedRevision
  -> create DelegateTask / DelegateAttempt if missing
  -> optionally runTask/link native TaskRun
  -> bind flowId/taskId/runId/childSessionKey
  -> create or resume child session according to continuity policy
  -> build DelegateHandoffPacket from WorkContract
  -> update WorkContract
```

The OpenClaw-compatible materialization state machine should be:

```text
new dispatch
  createManaged({ controllerId: "octoclaw.delegate", goal, currentStep: "dispatch", stateJson: compact ref })
  -> optionally runTask({ flowId, childSessionKey, runId, task })
  -> setWaiting(..., currentStep: "await_worker") if worker is asynchronous
  -> finish/fail when worker result materializes

follow-up / retry
  load flow by flowId
  -> resume({ flowId, expectedRevision, status: "running", currentStep: "resume_delegate" })
  -> dispatch resume into preferred childSessionKey
  -> setWaiting/finish/fail using the returned revision

revision_conflict
  -> refresh native flow
  -> update WorkContract.nativeBinding from current flow
  -> return status/retry instruction; do not blindly double-dispatch
```

Store only compact refs in `stateJson`/`waitJson` (`workContractId`, `delegateTaskId`, `attemptId`, artifact refs, brief status). Do not store full WorkContract, full handoff packet, transcript, or route rationale inside native TaskFlow state.

Retry contract:

1. `/octotask retry` and `octoclaw_task_action retry` must be state-changing operations, not status/detail aliases.
2. Retry creates a new attempt under the same `delegateTaskId`; it does not invent a new user-visible task unless the user explicitly starts new work.
3. Retry chooses child-session behavior from the continuity rules above: transient failure resumes preferred child session; contamination/scope mismatch retires it and creates a new one.
4. Retry writes durable task-state, WorkContract attempt metadata, replay event, and status/timeline projection before or atomically with dispatch materialization.
5. `stop`, `approve`, and `reject` must either have similarly explicit state transitions or remain absent from the public action enum.

### 6.4 Worker handoff

`DelegateHandoffPacket` should be a projection from WorkContract:

```text
WorkContract.delegate.scope -> readScope/writeScope/workspaceMode
WorkContract.delegate.acceptanceCriteria -> acceptanceCriteria
WorkContract.delegate.role/modelProfile -> role/modelProfile
WorkContract.continuity -> threadBindingKey
WorkContract.mainContext.artifactRefs -> artifactRefs
```

It must not include full transcript, route rationale, hidden guard text, worker chain of thought, or raw execution logs.

### 6.5 Result and parent resume

Worker result updates:

```text
WorkerResultPacket
  -> artifact index
  -> DelegateAttempt terminal status
  -> WorkContract.delegate.artifactRefs
  -> WorkContract.mainContext refresh
  -> TurnExecutionReceipt
```

Parent receives only:

- terminal summary
- key findings
- changed files
- verification
- blockers
- artifact refs
- continuation handle

### 6.6 Follow-up

Follow-up routing must first decide whether the user asks about existing execution or asks for new work.

```text
ask "who did that / did you use a subagent / what is status"
  -> execution coverage precheck
  -> reply.answer or reply + control-plane status

ask "why did dispatch fail / why no spawn / no_dispatch_evidence"
  -> execution coverage + task-state status precheck
  -> reply.answer or reply + control-plane status
  -> never create a new delegate task just to explain dispatch failure

ask "continue/fix/check more/write patch"
  -> resolve WorkContract/delegateTaskId
  -> resume preferred child session if compatible
  -> no new route judge unless new intent/scope conflict
```

Implementation invariant:

1. `execution_followup`, `status_followup`, `provenance_followup`, and `dispatch_failure_followup` must be blocked from `octoclaw_dispatch` and `octoclaw_spawn`.
2. The main agent's route hint / objection is a useful correction signal, but the stable fix must live in deterministic front-gate classification and dispatch/spawn guards.
3. A sealed delegate WorkContract with no dispatch/spawn evidence is not an active worker. It is a planned/registered/anomalous state that should be answered from status projection.

### 6.7 Concurrent tasks and amendments

OctoClaw should distinguish new independent work from dependent work and amendments to existing work before dispatch:

| user intent | relation | policy |
|-------------|----------|--------|
| new independent task | `independent` | spawn in parallel if capacity allows |
| task depends on unfinished result | `depends_on` | queue after dependency and show explicit `queued_after` |
| small clarification / extra constraint for running task | `amends` | steer preferred child session if the child supports steering |
| scope changes but current output may still be useful | `amends` | queue-after current attempt and inherit artifact refs |
| direction is wrong or unsafe to continue | `amends` | request cancel / retire child session / spawn replacement under a new attempt |
| user asks why/status/provenance | `status_only` | reply from status; do not spawn |

The decision cannot be based on semantic distance alone. It must use:

1. WorkContract read/write scope and scope fingerprint.
2. Whether the current attempt has started, produced checkpoints, or materialized useful artifacts.
3. Whether child session continuity is healthy, contaminated, blocked, or retired.
4. Whether the runtime can deliver a steering message to the existing child.
5. Whether write scopes conflict with existing running tasks.

If the host or runtime serializes main-session turns, OctoClaw must not silently skip dispatch. Independent tasks should still become separate durable task records and either spawn concurrently or enter an explicit `queued/blocked` state with a reason such as `parent_session_busy`, `worker_capacity_full`, or `dependency_pending`.

## 7. How this changes current components

### 7.1 `judge-schema.ts`

Add:

- `JudgeMemoryLayer`
- `JudgeExecutionLayer`
- `memory?: JudgeMemoryLayer`
- `execution?: JudgeExecutionLayer`

Do not keep `recent_execution` as ad hoc packet data.

### 7.2 `execution-coverage-precheck.ts`

New runtime file.

Inputs:

- `TurnExecutionReceipt`
- recent policy state entries
- route seal
- tool receipts
- dispatch honesty receipts
- delivery receipts
- native task projection if id exists

Output:

- `JudgeExecutionLayer`
- telemetry fields

It must not call `octoclaw_dispatch`, `octoclaw_spawn`, `sessions_spawn`, or external tools.

### 7.3 `memory-coverage-precheck.ts`

New runtime file.

Inputs:

- bootstrap memory
- active-memory summary if already available
- explicit metadata

It should not call memory tools or run another LLM in v1.

### 7.4 `policy-resolver.ts`

Change sequence:

```text
collect execution coverage
collect memory coverage
build JudgeContextPacket
call judge
apply coverage validator
build WorkDecisionSeal
create WorkContract
emit legacy PolicyDecision view
```

Coverage validator must force:

```text
execution.supports_provenance_reply -> reply.answer
execution.supports_status_reply -> reply.answer
execution.requires_control_plane_refresh -> reply with control tools only
```

### 7.5 `route-helpers.ts`

Keep legacy normalization, but new canonical route should be:

```ts
route = decision.work_contract?.route ?? authoritativeDecisionRoute(decision)
```

Over time, `route_decision`, `tool_policy`, and `router_decision_v2` become compatibility views.

### 7.6 `registration.ts`

`octoclaw_dispatch` should accept:

```ts
{
  workContractId?: string;
  delegateTaskId?: string;
  continuationMode?: "new" | "resume_preferred" | "new_attempt" | "status_only";
  policyJson?: string; // compatibility only
}
```

Rules:

1. If `workContractId` exists, load contract and do not rejudge route.
2. If only legacy `policyJson` exists, convert to WorkContract and seal.
3. If route is `reply`, reject dispatch.
4. If WorkContract says provenance/status-only, reject dispatch/spawn.
5. If continuing same delegate task, prefer child session resume.
6. If the prompt is a dispatch-failure follow-up, reject dispatch/spawn and return state-grounded status payload.
7. If a new request relates to existing running work, resolve relation first: `independent`, `depends_on`, `amends`, or `status_only`.

### 7.7 `runtime-payloads.ts`

Materialization should consume WorkContract:

```text
materializeWorkContract(contract)
  -> taskFlow.bindSession({ sessionKey: contract.sessionKey })
  -> createManaged/resume with expectedRevision
  -> runTask or spawn child session as required
  -> startDelegateAttempt(...)
  -> create/update ChildSessionContinuity
  -> build handoff from contract
  -> update nativeBinding
  -> return dispatch payload
```

Do not rebuild scope/model/role from scattered legacy decision fields when WorkContract is present.

Use the legacy mutable TaskFlow API for mutations (`runtime.taskFlow.bindSession`) because the current DTO `runtime.tasks.flows` is read-only. Use DTO views for status projection once materialization has completed.

### 7.8 `PolicyStateEntry`

Slim target:

```ts
interface PolicyStateEntryV2 {
  workContractId?: string;
  routeSeal?: RouteSeal;
  latestStatus?: WorkContractStatus;
  latestExecutionReceipt?: TurnExecutionReceipt;
  ackGuardKey?: string;
  pendingDeliveryIds?: string[];
  canonicalSessionKey?: string;
  updatedAt?: number;
  createdAt?: number;
}
```

Legacy `decision` can stay during migration, but new code should prefer WorkContract store.

### 7.9 `conversation-grounding.ts`

Grounding should render one of:

1. `MainContextPacket`
2. `DelegateStatusPacket`
3. `ExecutionCoveragePacket`
4. `ArtifactSummaryPacket`

It should not merge replay/task/cache fields into a new truth shape.

### 7.10 ACK

ACK reads:

- WorkContract route/status/nextAction
- native binding state
- materialization failure
- delivery status

ACK must not infer route from `_judge_*`, regex, or raw prompt.

## 8. Telemetry and harness requirements

Every route-sealed WorkContract should emit:

```json
{
  "workContractId": "...",
  "route": "reply",
  "decisionSource": "execution_coverage",
  "executionCoverage": "recent_turn",
  "executionSupportsProvenanceReply": true,
  "executionSupportsStatusReply": false,
  "executionRequiresControlPlaneRefresh": false,
  "memoryCoverage": "strong",
  "memoryFreshnessRisk": "low",
  "authority": "execution_wins",
  "dispatchExecuted": false,
  "spawnExecuted": false,
  "nativeTaskId": "",
  "nativeFlowId": "",
  "nativeFlowRevision": 0,
  "nativeFlowExpectedRevision": 0,
  "nativeFlowMutation": "",
  "nativeFlowMutationApplied": false,
  "nativeFlowMutationError": "",
  "childSessionKey": "",
  "childSessionId": "",
  "childRunId": "",
  "resultMaterialized": false,
  "deliveryStatus": "delivered",
  "parentContextTokensAdded": 420
}
```

Harness must cover:

1. provenance follow-up after main-session tool use -> `reply.answer`
2. provenance follow-up after real delegated result -> `reply.answer` from receipt
3. dispatch registered but spawn not executed -> honest status, not completed
4. execution coverage missing -> no spawn, answer no verifiable record or control-plane status
5. memory says one thing, execution says another -> execution wins
6. same delegate task follow-up -> resume preferred child session
7. retry with compatible child context -> resume child session under new attempt
8. retry after contamination/scope conflict -> new child session, old retired
9. full transcript is never injected into `MainContextPacket`
10. TaskFlow `revision_conflict` refreshes/projections instead of double-dispatching
11. flow created but no TaskRun/session spawn -> honest `spawnExecuted=false`

## 9. Non-goals

1. Do not replace native TaskFlow.
2. Do not make WorkContract the execution lifecycle truth.
3. Do not let memory decide route.
4. Do not answer provenance by spawning a new subagent.
5. Do not expose full child transcript to the parent by default.
6. Do not add top-level routes such as `runner`, `spawn_single`, `spawn_multi`, or `multi_agent`.
7. Do not make the main agent manually choose arbitrary child sessions.
8. Do not treat TaskFlow creation as proof that a worker spawned or completed.
9. Do not store full WorkContract, handoff, transcript, or route rationale in TaskFlow `stateJson`.

## 10. End-state summary

The target system should be explainable in one paragraph:

OctoClaw first checks existing execution and memory coverage, then judge/validator seals a WorkContract. If the turn is a provenance or status follow-up and execution coverage is enough, the contract is `reply.answer`. If the turn needs new work, the contract is `delegate`; dispatch materializes it into OpenClaw TaskFlow using `flowId + expectedRevision`, records TaskRun/session evidence, and child-session continuity lets follow-ups resume the same worker context. Native TaskFlow/TaskRun/session state remains execution truth; WorkContract is the semantic and handoff contract; artifacts hold detailed content; main agent receives compact projections only.
