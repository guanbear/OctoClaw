# OctoClaw Delegate Runtime Gap Closure

Date: 2026-04-22  
Branch target: `release/0.3.0-ts-rebuild`

## 1. Purpose

This document closes the gap between the current TS rebuild design and the verified live behavior seen on the Mac mini deployment.

It is not a speculative future design note. It is a runtime correction memo for issues already confirmed by:

1. remote logs
2. remote session transcripts
3. remote sqlite task records
4. current TS code on `release/0.3.0-ts-rebuild`

The core issue is:

> delegated work is being registered, but state association, execution progression, state readback, and failure propagation are not fully connected; at the same time, the main agent context is not clean enough, so internal delegation reasoning and old thread history flow back into the main agent.

---

## 2. Confirmed Production Symptoms

### 2.1 Dispatch says success, status surface says not found

Verified on remote host `guanbear@192.168.50.23`:

1. `octoclaw_dispatch` returned real delegated task ids
   - `4ebc15f4-f5fb-46c4-a1ca-294eeea92c70`
   - `c75d7500-a357-4ce9-9c00-275e0c93a7a2`
2. Both ids exist in `~/.openclaw/tasks/runs.sqlite` under `task_runs`
3. But `octoclaw_task_action details <id>` returned `Task ... not found`
4. `octoclaw_status` only surfaced stale records such as:
   - `queued-timeout-1`
   - `runner-stuck-1`

### 2.2 Registered tasks never progressed

The two delegated tasks above were real rows in `task_runs`, but remained:

1. `status = queued`
2. `delivery_status = pending`
3. no `progress_summary`
4. no `terminal_summary`
5. no `error`
6. no delivery state row in `task_delivery_state`

So the system did not fully fake registration, but it also did not execute through to a usable result.

### 2.3 Main agent context was polluted by full thread history

Remote session files show that follow-up turns were injected with:

1. full `[Thread history - for context]`
2. prior assistant delegation wording
3. prior delegated task ids
4. prior status narration

That means delegated follow-up grounding is currently too transcript-heavy.

### 2.4 Internal orchestration reasoning leaked to users

User-visible text included wording like:

1. "先确认一下我这边的派发边界"
2. "任务边界很清楚，适合独立派发执行"

This is orchestration reasoning, not user-facing value.

### 2.5 Contamination guard text leaked to users

User-visible text also included:

1. "这条追问命中了被子任务污染的会话上下文，我先按最新执行事实重绑后再回答，这次先不凭旧记忆下结论。"

This should be an internal guard, not a user reply.

---

## 3. Root Cause Summary

## 3.1 State authority split

Current live behavior shows a split-brain state model:

1. dispatch registration truth is present in `task_runs`
2. query surfaces still read `task-state.json`

So one subsystem says:

1. delegated task exists

while another says:

1. task not found

This is the primary cause of the observed contradiction.

## 3.2 Registration path and execution path are not fully wired together

The runtime can materialize a delegated row, but the child execution lifecycle is not consistently advancing through:

1. `queued`
2. `running`
3. `completed | failed | timed_out`
4. `delivery`

The design already contains workflow/recovery/delegate contracts, but the live path is not yet fully connected to them.

## 3.3 Follow-up grounding is too transcript-oriented

Instead of grounding follow-up through:

1. thread binding
2. active delegate task
3. current authority state

the system often re-injects large thread history.  
That increases:

1. token cost
2. confusion risk
3. main-agent mental load
4. context contamination

## 3.4 User-visible layer is not separated from orchestration layer

Main-agent visible input and user-facing output are still too close to internal control logic.

As a result:

1. the main agent explains delegation policy to the user
2. internal contamination handling leaks into user replies
3. old orchestration wording gets replayed back into future turns

---

## 4. Required Design Corrections

## 4.1 Single authority for delegated task truth

The system must define a single authority source for delegated task lifecycle.

For v1 live path, the recommended rule is:

1. authority source = native delegated task runtime state backed by `task_runs` plus native binding state
2. `task-state.json` = projection / cache / policy metadata only
3. status surfaces must never rely on projection-only truth when authority state exists

This implies:

1. `octoclaw_dispatch`
2. `octoclaw_status`
3. `octoclaw_task_action details`

must converge on the same authority layer.

### Required invariant

If the authority source contains a delegated task id, then:

1. `octoclaw_task_action details <task_id>` must resolve it
2. `octoclaw_status` must be able to surface it
3. the system must not return `Task ... not found`

## 4.2 Delegated lifecycle must be end-to-end, not registration-only

Delegated runtime must fully materialize and progress through a visible lifecycle.

Minimum required lifecycle:

1. `registered` or `planned`
2. `queued`
3. `running`
4. `completed | failed | timed_out`
5. `delivery_pending | delivered | delivery_failed`

At minimum, the following fields must become queryable from the authority state:

1. `task_id`
2. `flow_id`
3. `status`
4. `attempt_status`
5. `worker_pool`
6. `model_profile`
7. `created_at`
8. `last_event_at`
9. `progress_summary`
10. `terminal_summary`
11. `error`
12. `retryable`

## 4.3 Follow-up grounding must use a minimal delegate status packet

For delegated follow-up turns such as:

1. "好了吗"
2. "继续查"
3. "重新委派"
4. "完成了吗"

the main agent must not be grounded by replaying full thread history.

Instead, the system should:

1. resolve current thread binding
2. find the active or most recent delegate task for that thread
3. build a compact `delegate_status_packet`
4. inject only that packet plus minimal user-facing context

### `delegate_status_packet` minimum schema

```json
{
  "thread_binding_key": "",
  "delegate_task_id": "",
  "native_task_id": "",
  "native_flow_id": "",
  "status": "planned | queued | running | completed | failed | timed_out | blocked",
  "attempt_status": "queued | running | completed | failed | timed_out | recovering | cancelled | null",
  "worker_pool": "",
  "role": "",
  "model_profile": "",
  "created_at": "",
  "last_event_at": "",
  "progress_summary": "",
  "terminal_summary": "",
  "error": "",
  "retryable": false
}
```

### Injection rule

For delegated follow-up, inject:

1. current user ask
2. compact delegate status packet
3. optional thread summary

Do not inject by default:

1. full thread transcript
2. prior assistant orchestration wording
3. full worker logs
4. full replay timeline

## 4.4 Main-agent context hygiene is a first-class architecture goal

The main agent is allowed to know:

1. what was delegated
2. what the current status is
3. whether the task succeeded, failed, or timed out

The main agent should not need to know by default:

1. full dispatch reasoning
2. full worker execution trace
3. full old thread history
4. low-level runtime guard diagnostics

### Main-agent working-context rule

Default main-agent working context should be composed from:

1. `thread summary`
2. `checkpoint summary`
3. `structured task/delegate packet`
4. `artifact refs`

not from:

1. full transcript replay
2. full task event logs
3. user-visible copies of old internal reasoning

## 4.5 Internal reasoning must not leak into user-visible text

The following content categories are internal-only by default:

1. route rationale
2. delegation rationale
3. contamination handling rationale
4. judge confidence narration
5. route-packet self-justification

Examples of text that should stay internal:

1. "先确认一下我这边的派发边界"
2. "任务边界很清楚，适合独立派发执行"
3. "这条追问命中了被子任务污染的会话上下文"

### User-visible layer should be limited to

1. short ACK
2. authority status update
3. final result
4. clear failure/timeout explanation
5. explicit clarification request when needed

### Internal storage locations for orchestration reasoning

This content should instead go to:

1. `route_decision`
2. `dispatch metadata`
3. `replay events`
4. telemetry

## 4.6 Thread association must be explicit

Delegated tasks must remain linked to the originating thread.

Required binding surfaces:

1. canonical thread binding key
2. session key
3. requester session key
4. latest delegate task for that thread

If `sessionKey` is empty at materialization time, the runtime must still either:

1. derive and persist a canonical thread binding

or:

2. fail materialization clearly

It should not silently materialize a task that later cannot be found from the original thread context.

---

## 5. Required Runtime Behavior

## 5.1 Status query behavior

`octoclaw_status` and `octoclaw_task_action details` must behave as follows:

1. query authority state first
2. enrich with projection if available
3. enrich with replay/timeline if available
4. only return `not found` when the authority source truly has no matching record

## 5.2 Failure and timeout behavior

When delegated execution fails or times out:

1. authority state must be updated
2. the failure must be visible from the main thread
3. the task must expose `retryable`
4. recovery/retry decisions must be grounded in authority state, not inferred from transcript

## 5.3 Delivery behavior

Final delivery is not complete until:

1. a terminal task state exists
2. a handoff summary exists
3. delivery state is updated
4. the main thread can consume the result

---

## 6. Implementation Targets

Primary files to update:

1. `extensions/octoclaw-runtime/src/tools/registration.ts`
2. `extensions/octoclaw-runtime/src/conversation-grounding.ts`
3. `extensions/octoclaw-runtime/src/extension-entry.ts`
4. `extensions/octoclaw-runtime/src/replay/replay-logger.ts`
5. `extensions/octoclaw-runtime/src/plugin.ts`
6. `extensions/octoclaw-runtime/src/adapter/runtime-taskflow.ts`
7. `extensions/octoclaw-runtime/src/resolve/policy-resolver.ts`
8. `extensions/octoclaw-runtime/src/resolve/session.ts`

Secondary files that may need updates:

1. status-surface read-model consumers
2. sqlite-backed delegated task readers/writers
3. delivery relay plumbing
4. replay-to-follow-up grounding helpers

---

## 7. Acceptance Criteria

The runtime gap is considered closed only when all of the following are true:

1. a task id returned by `octoclaw_dispatch` can be queried immediately by `octoclaw_task_action details <id>`
2. delegated tasks no longer remain permanently in `queued/pending` without visible progression
3. delegated follow-up turns are grounded by compact authority status packets instead of full thread-history replay
4. user-visible replies no longer contain internal delegation reasoning
5. user-visible replies no longer contain contamination guard wording
6. failure, timeout, and retry state are visible from the main thread
7. the same delegated task is visible consistently across dispatch, status, details, and delivery surfaces

---

## 8. Recommended Delivery Order

Implement in this order:

1. unify delegated status read path around authority state
2. fix immediate `Task ... not found` false negatives
3. wire delegated lifecycle progression beyond `queued`
4. add compact follow-up delegate status packet
5. stop injecting full thread history by default for delegated follow-up
6. suppress internal orchestration reasoning from user-visible output
7. suppress contamination fallback leakage

This order is important because it restores truth first, then context hygiene, then wording quality.
