# OctoClaw WorkContract Implementation Plan

Date: 2026-04-25
Companion design: `docs/octoclaw-work-contract-centered-delegation-design-2026-04-25.md`
OpenClaw source reference: `openclaw/openclaw` `release/2026.4.21` / `v2026.4.21`, commit `f788c88b4c508c335336fb292afed8c900656d6d`, package version `2026.4.21`

This plan is written for an implementation AI. Keep changes incremental. Do not rewrite the runtime in one pass.

## 0. Guardrails

1. Native TaskFlow remains execution lifecycle truth.
2. WorkContract is semantic/delegation truth, not native execution truth.
3. Execution coverage is checked before memory coverage.
4. Provenance/status follow-up with sufficient execution coverage is `reply.answer`, not `delegate`.
5. OMO-style continuity must be implemented as child-session resume, not by dumping child transcript into parent context.
6. Legacy `route_decision`, `router_decision_v2`, and `tool_policy` stay during migration as generated compatibility views.
7. Main-agent context must pass the existing context-budget/sanitizer boundary.
8. OpenClaw TaskFlow mutations must use `flowId + expectedRevision`; do not invent a parallel resume/claim mechanism as the primary guard.
9. TaskFlow creation is not proof of child execution. `spawnExecuted` must come from TaskRun/session/process evidence.
10. Store compact refs in native `stateJson`/`waitJson`, not full WorkContract, transcript, or route rationale.
11. Use OpenClaw 4.21 source semantics. In particular, persistent/thread-bound children may not announce completion through the parent path; read lifecycle/status from TaskRun/session evidence.

## WP0. Baseline audit and failing tests

### Goal

Create failing tests that describe the intended behavior before changing runtime logic.

### Files

- `extensions/octoclaw-runtime/src/replay/turn-execution-receipt.test.ts`
- `extensions/octoclaw-runtime/src/resolve/llm-judge.test.ts`
- `extensions/octoclaw-runtime/src/resolve/judge-context-packet.test.ts`
- `extensions/octoclaw-runtime/src/tools/registration-dispatch-honesty.test.ts`
- new: `extensions/octoclaw-runtime/src/resolve/execution-coverage-precheck.test.ts`

### Tests

1. Previous turn `route=reply`, `toolsUsed=["web_fetch"]`; user asks "did you use a subagent?"
   - expect `execution.supports_provenance_reply=true`
   - final route `reply`
   - dispatch/spawn forbidden
2. Previous turn `route=delegate`, `dispatchExecuted=true`, `spawnExecuted=true`, `resultMaterialized=true`; user asks "who did it?"
   - expect answer can cite delegated worker from receipt
3. `dispatchExecuted=true`, `spawnExecuted=false`; user asks "did dispatch succeed?"
   - expect honest "registered, not actually spawned/executed/resulted"
4. `memory.coverage=strong` but execution says `dispatchExecuted=false`
   - expect execution wins
5. Same delegate task follow-up with compatible child session
   - expect continuation mode `resume_preferred`
6. Native TaskFlow revision conflict during resume/materialization
   - expect WorkContract refreshes `nativeBinding` from current flow
   - expect no second dispatch/spawn is attempted in the same turn
7. Flow exists but no child TaskRun/session evidence exists
   - expect `dispatchExecuted=true`, `spawnExecuted=false`, and honest status

### Acceptance

Tests fail on current implementation for the missing coverage/session-continuity parts.

## WP1. Add contract types

### Goal

Add canonical types without changing behavior.

### Files

- new: `packages/octoclaw-contracts/src/work-contract.ts`
- update: `packages/octoclaw-contracts/src/index.ts`
- update: `packages/octoclaw-policy/src/judge/judge-schema.ts`

### Tasks

1. Add `WorkContract`, `WorkDecisionSeal`, `ReplyContract`, `DelegateContract`.
2. Add `ContextCoverageSnapshot`.
3. Add `ChildSessionContinuity` with OpenClaw-aligned fields:
   - `childSessionKey` required
   - `childSessionId?`
   - `providerSessionBinding?`
   - `runId?`
4. Add `NativeBindingRef` with OpenClaw-aligned fields:
   - `flowId`
   - `ownerKey`
   - `controllerId`
   - `revision`
   - `expectedRevision`
   - `status`
   - `taskId?`
   - `runId?`
   - `childSessionKey?`
   - `lastMutation?`
   - `lastMutationApplied?`
   - `lastMutationError?`
5. Add `JudgeMemoryLayer` and `JudgeExecutionLayer` to judge schema.
6. Add test fixtures for:
   - reply from execution coverage
   - delegate new work
   - delegate resume preferred child session

### Acceptance

```bash
pnpm --filter @octoclaw/contracts test
pnpm --filter @octoclaw/policy test
```

## WP1b. Judge Context Coverage

This work package aligns with the updated gap-closure WP1b.

### Goal

Make judge see structured memory and execution coverage before deciding route.

### Files

- `packages/octoclaw-policy/src/judge/judge-schema.ts`
- `extensions/octoclaw-runtime/src/resolve/judge-context-packet.ts`
- new: `extensions/octoclaw-runtime/src/resolve/execution-coverage-precheck.ts`
- new: `extensions/octoclaw-runtime/src/resolve/memory-coverage-precheck.ts`
- `extensions/octoclaw-runtime/src/resolve/policy-resolver.ts`
- `packages/octoclaw-policy/src/spec/decision-policy-spec.ts`
- `packages/octoclaw-policy/src/spec/prompt-builder.ts`

### Tasks

1. Move ad hoc `recent_execution` into `packet.execution`.
2. Implement `buildExecutionCoveragePrecheck(...)`.
3. Implement `buildMemoryCoveragePrecheck(...)`.
4. Run prechecks in this order:

```text
conversation grounding
continuation route reuse
execution coverage precheck
memory coverage precheck
buildJudgeContextPacket
local judge
validator / objection / remote judge
route seal commit
```

5. Add validator overrides:

```text
execution.supports_provenance_reply=true -> reply.answer
execution.supports_status_reply=true -> reply.answer
execution.requires_control_plane_refresh=true -> reply + status/task-action only
```

6. Update prompt/spec examples to remove old rule:

```text
execution truth/provenance follow-up -> delegate
```

and replace with:

```text
provenance/status with sufficient execution coverage -> reply.answer
new probe/work/tool execution/>1min -> delegate
```

### Acceptance

```bash
pnpm --filter @octoclaw/policy test
pnpm --filter octoclaw-runtime test -- judge-context execution-coverage provenance
```

## WP2. WorkContract builders and store

### Goal

Create/persist WorkContract and attach compact view to existing policy decision.

### Files

- new: `extensions/octoclaw-runtime/src/work-contract/builders.ts`
- new: `extensions/octoclaw-runtime/src/work-contract/store.ts`
- new: `extensions/octoclaw-runtime/src/work-contract/projectors.ts`
- `extensions/octoclaw-runtime/src/resolve/env.ts`
- `extensions/octoclaw-runtime/src/state/policy-state.ts`

### Tasks

1. Add `buildWorkDecisionSeal(...)`.
2. Add `buildWorkContractFromPolicy(...)`.
3. Add file-backed WorkContract ledger path.
4. Add `compactWorkContractView(...)` for legacy decision embedding.
5. Add `projectMainContextPacket(...)`.
6. Add `projectDelegateStatusPacket(...)`.
7. Update `PolicyStateEntry` to include:

```ts
workContractId?: string;
latestStatus?: WorkContractStatus;
latestExecutionReceipt?: TurnExecutionReceipt;
```

Do not remove legacy `decision` yet.

### Acceptance

1. Every policy-resolved turn can persist one WorkContract.
2. Existing tests still pass with legacy decision fields.
3. WorkContract ledger survives process restart.

## WP2b. OpenClaw TaskFlow adapter alignment

### Goal

Make OctoClaw materialization speak OpenClaw's native TaskFlow protocol before dispatch logic depends on it.

### Source references

- local OpenClaw: `src/plugins/runtime/runtime-taskflow.types.ts`
- local OpenClaw: `src/tasks/task-flow-registry.types.ts`
- local OpenClaw: `src/tasks/task-flow-registry.ts`
- local OpenClaw: `src/plugins/runtime/runtime-tasks.types.ts`
- local OpenClaw: `extensions/lobster/src/lobster-taskflow.ts`
- local OpenClaw: `src/agents/tools/sessions-spawn-tool.ts`
- local OpenClaw: `src/agents/subagent-spawn.ts`
- local OpenClaw: `src/agents/acp-spawn.ts`

All references above mean OpenClaw `release/2026.4.21`, not the local checkout's current `main` branch.

### Files

- new: `extensions/octoclaw-runtime/src/work-contract/native-taskflow-adapter.ts`
- new: `extensions/octoclaw-runtime/src/work-contract/native-taskflow-adapter.test.ts`
- `packages/octoclaw-contracts/src/work-contract.ts`
- `extensions/octoclaw-runtime/src/runtime-payloads.ts`

### Tasks

1. Implement a small adapter around the OpenClaw mutable TaskFlow runtime:

```ts
createManagedWorkFlow(contract)
resumeManagedWorkFlow(binding, step)
setWorkFlowWaiting(binding, wait)
finishWorkFlow(binding, result)
failWorkFlow(binding, error)
refreshNativeBinding(flowId)
```

2. Every mutation must pass `expectedRevision`.
3. On success, project returned `flow.revision` back into `NativeBindingRef.revision` and `expectedRevision`.
4. On `revision_conflict`, refresh the current flow and return a typed non-terminal result. Do not dispatch a second worker.
5. Use compact `stateJson`/`waitJson`:

```json
{
  "kind": "octoclaw_delegate_ref",
  "workContractId": "...",
  "delegateTaskId": "...",
  "attemptId": "...",
  "artifactRefs": []
}
```

6. Keep `runtime.tasks.flows` as read-only projection API; use legacy `runtime.taskFlow.bindSession` for mutations until OpenClaw exposes DTO mutations.
7. Allow TaskRun/session lifecycle evidence to arrive through OpenClaw 4.21 detached lifecycle plumbing, not only synchronous spawn tool return values.

### Acceptance

1. Adapter tests cover `createManaged`, `resume`, `setWaiting`, `finish`, `fail`.
2. Adapter tests cover `revision_conflict`, `not_found`, and `not_managed`.
3. WorkContract stores flow ids/revisions, not duplicated native flow state.
4. No full transcript, handoff packet, or route rationale is stored in native TaskFlow state.

## WP3. Policy resolver creates WorkContract

### Goal

Make WorkContract the canonical output after judge/validator.

### Files

- `extensions/octoclaw-runtime/src/resolve/policy-resolver.ts`
- `extensions/octoclaw-runtime/src/resolve/route-helpers.ts`
- `extensions/octoclaw-runtime/src/replay/replay-logger.ts`

### Tasks

1. After final route decision, build WorkContract.
2. Attach:

```ts
decision.workContractId = contract.workContractId;
decision.work_contract = compactWorkContractView(contract);
```

3. Generate legacy views from WorkContract:
   - `route_decision`
   - `tool_policy`
   - `router_decision_v2`
4. Record telemetry:
   - `executionCoverage`
   - `memoryCoverage`
   - `decisionSource`
   - `authority`
   - `parentContextTokensAdded`
5. Update `authoritativeDecisionRoute(...)` to prefer WorkContract route when present.

### Acceptance

1. Delegate decisions still dispatch.
2. Reply decisions still answer.
3. Coverage-supported provenance route is `reply`.
4. Legacy route fields match WorkContract route.

## WP4. Dispatch consumes sealed WorkContract

### Goal

Prevent freeform rejudge during dispatch.

### Files

- `extensions/octoclaw-runtime/src/tools/registration.ts`
- optionally split: `extensions/octoclaw-runtime/src/tools/handlers/dispatch.ts`

### Tasks

1. Add `workContractId`, `delegateTaskId`, `continuationMode` params to `octoclaw_dispatch`.
2. Primary path:

```text
load WorkContract -> verify sealed -> verify route=delegate -> dispatch
```

3. Compatibility path:

```text
legacy policyJson -> convert to WorkContract -> seal -> dispatch
```

4. Rejection rules:
   - missing sealed contract for delegated route
   - contract route is reply
   - provenance/status-only contract attempts dispatch
   - route seal mismatch
5. Return compact handoff with:
   - `workContractId`
   - `delegateTaskId`
   - `attemptId`
   - `nativeTaskId`
   - `nativeFlowId`
   - `childSessionKey`
   - `childSessionId` when provider/runtime id is available

### Acceptance

1. `octoclaw_dispatch(workContractId)` does not re-run judge.
2. `octoclaw_dispatch` rejects `reply.answer` provenance/status contracts.
3. Existing policyJson tests pass through compatibility adapter.

## WP5. Native materialization updates WorkContract

### Goal

Make runtime materialization a WorkContract state transition.

### Files

- `extensions/octoclaw-runtime/src/runtime-payloads.ts`
- `extensions/octoclaw-runtime/src/context/delegate-packets.ts`
- `extensions/octoclaw-runtime/src/work-contract/projectors.ts`
- `extensions/octoclaw-runtime/src/work-contract/native-taskflow-adapter.ts`

### Tasks

1. Add `materializeWorkContract(contract, ...)`.
2. Create/load native TaskFlow through WP2b adapter:
   - new dispatch -> `createManaged`
   - same-work follow-up -> `resume`
   - async worker pending -> `setWaiting`
   - worker success -> `finish`
   - worker failure/blocker -> `fail`
3. Use contract fields for:
   - role
   - model profile
   - acceptance criteria
   - read/write scope
   - thread binding
4. After native bind, update:
   - `delegate.nativeBinding`
   - `delegate.delegateTaskId`
   - `delegate.currentAttemptId`
   - `status`
   - `mainContext`
5. If a child TaskRun/session is created, bind:
   - `nativeBinding.taskId`
   - `nativeBinding.runId`
   - `nativeBinding.childSessionKey`
   - `delegate.childSessions[]`
6. Build `DelegateHandoffPacket` only from WorkContract projection.
7. Keep `runtime_truth` payload for compatibility but treat it as execution snapshot.
8. Record `TurnExecutionReceipt` separately:
   - TaskFlow created/resumed -> `dispatchExecuted=true`
   - child TaskRun/session/process actually started -> `spawnExecuted=true`
   - result packet/artifact materialized -> `resultMaterialized=true`

### Acceptance

1. Existing `runtime-payloads.test.ts` delegate task/attempt/native binding tests pass.
2. Handoff packet has no full transcript or route rationale.
3. WorkContract status changes when native binding succeeds/fails.
4. Revision conflict returns typed status and does not double-dispatch.

## WP6. OMO-style child-session continuity

### Goal

Resume existing child worker context for follow-ups and compatible retries.

### Files

- `packages/octoclaw-contracts/src/work-contract.ts`
- new: `extensions/octoclaw-runtime/src/work-contract/continuity.ts`
- `extensions/octoclaw-runtime/src/runtime-payloads.ts`
- `extensions/octoclaw-runtime/src/tools/registration.ts`
- `extensions/octoclaw-runtime/src/context/delegate-packets.ts`

### Tasks

1. Add `ChildSessionContinuity` to WorkContract.
2. Capture OpenClaw `childSessionKey` from `sessions_spawn`/TaskRun/subagent registry. This is required.
3. Capture provider/runtime `childSessionId` only when substrate/session-created metadata exposes it. If absent, keep it absent; do not fake it.
4. Capture `runId` from TaskRun/subagent/ACP spawn result when available.
5. Capture 4.21 delivery/announcement flags:
   - `expectsCompletionMessage`
   - persistent/thread-bound direct delivery when detected
   - group/member delivery context if present
6. Capture provider session binding from session store when available:
   - CLI `cliSessionBinding`
   - ACP runtime session id/runtime session name
   - session file/ref if exposed
7. Implement:

```ts
selectPreferredChildSession(contract, requestedMode)
markChildSessionPreferred(...)
markChildSessionRetired(...)
```

8. Resume rules:
   - same delegate task + compatible scope -> resume preferred
   - retry transient -> resume preferred
   - contamination/wrong scope/corrupt context -> new child session, retire old
   - new user intent -> new WorkContract
9. Add `continuationHint` to `MainContextPacket`.
10. Add compaction-safe summary:

```text
resume_dont_restart: workContractId=..., delegateTaskId=..., childSessionKey=..., childSessionId=optional
```

### Acceptance

1. Follow-up on same delegate task reuses preferred child session.
2. New intent does not reuse unrelated child session.
3. Retry can create new attempt while preserving or retiring child session according to reason.
4. Parent context includes handle, not child transcript.
5. If only `childSessionKey` is known, resume/status still work through OpenClaw session APIs.
6. If provider `childSessionId` is known, runtime can resume that provider session without parent manual stitching.
7. If `expectsCompletionMessage=false`, status/provenance still come from TaskRun/session lifecycle evidence.

## WP7. Main context, grounding, ACK, status projections

### Goal

Make parent-visible state projection-only.

### Files

- `extensions/octoclaw-runtime/src/context/context-budget.ts`
- `extensions/octoclaw-runtime/src/conversation-grounding.ts`
- `extensions/octoclaw-runtime/src/ack/ack-guard.ts`
- `extensions/octoclaw-runtime/src/extension-entry.ts`
- `extensions/octoclaw-runtime/src/tools/registration.ts`

### Tasks

1. Route all prompt injection through `MainContextPacket`.
2. Route delegated follow-up through `DelegateStatusPacket`.
3. Route provenance/status follow-up through `ExecutionCoveragePacket`.
4. ACK reads WorkContract/status/native/delivery only.
5. Tool guard reads WorkContract allowed/forbidden tools.
6. Apply context sanitizer to every parent-visible packet.

### Acceptance

1. ACK does not inspect `_judge_*` to infer route.
2. Status/provenance follow-up does not spawn.
3. Full thread history is never injected for delegated follow-up.

## WP8. Telemetry and harness

### Goal

Make mistakes explainable and regressions catchable.

### Files

- `extensions/octoclaw-runtime/src/replay/replay-logger.ts`
- `extensions/octoclaw-runtime/src/replay/*.test.ts`
- harness fixtures in existing evaluation locations

### Tasks

1. Extend `TurnExecutionReceipt` with:
   - `spawnExecuted`
   - `workContractId`
   - `childSessionKey`
   - `childSessionId`
   - `childRunId`
   - `nativeFlowRevision`
   - `nativeFlowExpectedRevision`
   - `nativeFlowMutation`
   - `nativeFlowMutationApplied`
   - `nativeFlowMutationError`
2. Record coverage telemetry fields:
   - `executionCoverage`
   - `executionSupportsProvenanceReply`
   - `executionSupportsStatusReply`
   - `executionRequiresControlPlaneRefresh`
   - `memoryCoverage`
   - `authority`
3. Add black-box harness cases from WP0.
4. Add pollution telemetry:
   - parent context tokens added
   - result packet tokens
   - artifact reopen count

### Acceptance

```bash
pnpm --filter octoclaw-runtime test -- replay telemetry coverage
```

## WP9. Migration cleanup

### Goal

Reduce duplicate mechanisms after WorkContract path is stable.

### Migration status

- `WorkContract` is the semantic/delegation truth for new code paths.
- Native TaskFlow remains the lifecycle/execution truth.
- `route_decision`, `router_decision_v2`, and `tool_policy` are retained as compatibility views for legacy hooks, replay, and acceptance tests; they must not become new scheduling truth.
- `router_decision_v2.compatibility_view = true` marks generated router fields as legacy projection.
- ACK reads explicit route phase, WorkContract projection, or `route_decision.route`; it must not infer route from `_judge_*` or `router_decision_v2`.
- Grounding/status follow-up uses replay/task-state adapters only to produce compact `DelegateStatusPacket`/execution facts. It must not infer delegated execution from route labels alone.
- Prompt similarity is fallback-only for non-explicit follow-up recovery; explicit provenance/status/meta prompts are handled by deterministic intent patterns first.
- Parent-visible context remains compact projection only: `MainContextPacket`, `DelegateStatusPacket`, `ExecutionCoveragePacket`, artifact refs, and telemetry summaries.

### Tasks

1. Mark legacy `router_decision_v2` as compatibility view.
2. Remove route inference from ACK and grounding.
3. Move prompt similarity lookup to fallback-only.
4. Keep old replay/task-state readers as adapters.
5. Document migration status in design docs.

### Acceptance

1. New code paths consume WorkContract first.
2. Legacy tests still pass.
3. No new top-level routes are introduced.
4. Main agent receives compact projections only.

## Recommended implementation order

1. WP0
2. WP1
3. WP1b
4. WP2
5. WP2b
6. WP3
7. WP4
8. WP5
9. WP6
10. WP7
11. WP8
12. WP9

Do not start WP6 before WP2b/WP4/WP5 have a persisted WorkContract and dispatch materialization path. Session continuity without a stable contract and native revision guard will recreate the current hidden-state problem.
