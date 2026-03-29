# OctoClaw State Machine Remediation v1

Date: 2026-03-29

Related:

- [octoclaw-product-design-v2-2026-03-27.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus/octoclaw-product-design-v2-2026-03-27.md)
- [octoclaw-task-display-schema-v1-2026-03-29.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus/octoclaw-task-display-schema-v1-2026-03-29.md)
- [octoclaw-display-layer-productization-plan-v1-2026-03-29.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus/octoclaw-display-layer-productization-plan-v1-2026-03-29.md)
- [octoclaw-direction-analysis-2026-03-19.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus/octoclaw-direction-analysis-2026-03-19.md)

## 1. Why this document exists

The Slack delegated-research incident on 2026-03-29 exposed a structural gap:

- the task was not "still running"
- a later delegated worker had already finished
- but the system still made the operator experience feel like "it never completed"

This is not just one bug.

It is a state-model problem:

- runtime truth
- operator truth
- user-safe handoff truth

are still partially collapsed into one `status` field and a few summaries.

## 2. Incident summary

Observed sequence:

1. Earlier delegated research attempts failed or were archived as stale dispatches.
2. A retried research worker finished around `2026-03-29 17:12:38 +08:00`.
3. The worker produced a report that clearly said:
   - the Zhihu page and cited sources could not be reliably fetched
   - a content-level summary would be too speculative
   - the safest deliverable was a conservative, user-ready explanation of the evidence boundary
4. Later "写完了吗 / 还没写完吗" follow-up tasks reported this as effectively "not finished".

That means OctoClaw did not lack execution.

It lacked a stable way to express:

- execution is complete
- result is blocked by evidence/source access
- a user-safe handoff is already ready

## 3. Root cause

### 3.1 One field is doing too much work

Current code still uses task `status` for too many meanings at once:

- lifecycle state
- final outcome
- patrol routing
- operator display
- notification diffing

Examples in current code:

- [task-state-update.py](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus/lib/task-state-update.py)
- [task_display.py](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus/lib/task_display.py)
- [patrol.py](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus/lib/patrol.py)

This creates ambiguity between:

- `running`
- `done`
- `failed`
- `blocked`
- `deferred`

Especially:

- `blocked` exists in the brief/result protocol design
- but the runtime writer does not have a first-class terminal `blocked` finish path
- and the display layer treats `blocked` as an active task state

So "work finished, but user-facing conclusion is blocked on evidence or materials" currently has no stable home.

### 3.2 Lifecycle completion and result completeness are different things

In this incident, the worker **did finish its assigned work**:

- retry the research
- determine evidence availability
- produce the safest directly reusable handoff

But the worker did **not** complete the user's ideal outcome:

- a content-level source-backed explanation of the article and its cited blogs

Today these two are both compressed into "done vs not done".

That is the core design flaw.

### 3.3 User-safe handoff readiness is not a tracked state

The older design already hinted at this:

- dispatch output should be user-safe
- workers should return a structured summary/result
- artifact-first should avoid losing long outputs

But OctoClaw still does not explicitly track:

- whether a task has a user-safe handoff ready
- whether the handoff is a full answer, a blocked explanation, or only an internal progress stub

As a result, follow-up workers and IM renderers fall back to heuristics:

- current summary text
- report presence
- recent task history

Those heuristics are fragile.

### 3.4 Session-bound observability is not hard enough

The affected delegated research tasks had empty `session_key`.

That means:

- task anchors could not be pushed back to the originating IM thread
- per-session state continuity was degraded
- the operator had to infer progress from patrol/state files instead of seeing a stable anchor in Slack

This is not acceptable for delegated IM work.

`session_key` must be treated as required observability metadata for any IM-originated delegated task.

## 4. What the design documents already got right

The design documents were pointing in the right direction:

- [octoclaw-product-design-v2-2026-03-27.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus/octoclaw-product-design-v2-2026-03-27.md)
  says the system should standardize:
  - brief input
  - worker output
  - artifact-first delivery
  - explainable decisions
- [octoclaw-task-display-schema-v1-2026-03-29.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus/octoclaw-task-display-schema-v1-2026-03-29.md)
  already asks:
  - what is happening now
  - what is blocked on me
  - what artifacts are ready
- [octoclaw-direction-analysis-2026-03-19.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus/octoclaw-direction-analysis-2026-03-19.md)
  already warned against:
  - relying only on `status`
  - guessing task fate without better runtime evidence

So the problem is not that the product thinking was wrong.

The problem is that implementation stopped one layer too early:

- schema exists
- protocol exists
- display contract exists
- but the state model underneath them is still too flat

## 5. New canonical model

OctoClaw should stop treating `status` as the only truth.

Introduce three orthogonal state dimensions.

### 5.1 `lifecycle_state`

This answers:

- where is the execution right now

Allowed values:

- `planned`
- `queued`
- `running`
- `finalizing`
- `finished`
- `cancelled`

### 5.2 `outcome_state`

This answers:

- what did the work conclude

Allowed values:

- `pending`
- `done`
- `blocked`
- `failed`
- `partial`
- `cancelled`

Notes:

- `blocked` means execution reached a meaningful stop condition but could not continue without external change
- `partial` means some useful output exists, but requested scope is only partially covered
- `failed` means runtime or logic broke in a way that did not produce a valid blocked/done conclusion

### 5.3 `handoff_state`

This answers:

- what can the operator or main brain safely say to the user now

Allowed values:

- `none`
- `internal_only`
- `user_safe_ready`
- `delivered`

This is the missing layer in the Slack incident.

The Zhihu task should have ended as:

- `lifecycle_state=finished`
- `outcome_state=blocked`
- `handoff_state=user_safe_ready`

That is very different from:

- still running
- spawn failed
- no answer yet

## 6. Required new task fields

Every delegated task record should grow these fields:

- `lifecycle_state`
- `outcome_state`
- `handoff_state`
- `blocked_on`
- `blocked_reason`
- `deliverable_kind`
- `user_safe_summary`
- `result_ready_at`
- `handoff_ready_at`
- `observability_health`

### 6.1 `blocked_on`

Suggested taxonomy:

- `user_input`
- `source_access`
- `tool_unavailable`
- `permission`
- `quota`
- `review_gate`
- `upstream_dependency`

### 6.2 `deliverable_kind`

Suggested taxonomy:

- `final_answer`
- `blocked_explanation`
- `partial_answer`
- `failure_report`
- `internal_progress`

### 6.3 `observability_health`

Suggested taxonomy:

- `healthy`
- `degraded_missing_session_key`
- `degraded_missing_run_id`
- `degraded_missing_anchor`
- `degraded_inconsistent_result`

## 7. Event model

Current system still infers too much from snapshots.

OctoClaw should add a per-task event stream.

Suggested event kinds:

- `route_selected`
- `dispatch_started`
- `worker_started`
- `artifact_ready`
- `source_blocked`
- `result_ready`
- `handoff_ready`
- `user_notified`
- `retry`
- `fallback`
- `failed`

Minimum event payload:

```json
{
  "time": "2026-03-29T17:12:38+08:00",
  "kind": "handoff_ready",
  "task_id": "research-20260329090912001942",
  "lifecycle_state": "finished",
  "outcome_state": "blocked",
  "handoff_state": "user_safe_ready",
  "message": "Evidence boundary summary ready for user relay"
}
```

This is the main mechanism that would have made the incident obvious much earlier.

## 8. Patrol and status rules

### 8.1 Patrol should reason about lifecycle, not only task status

Patrol currently spends a lot of effort inferring:

- stuck
- orphan
- ghost completion
- timeout

That is fine for lifecycle detection.

But it should stop deciding user-facing completion solely from `status`.

Patrol should instead:

1. treat `lifecycle_state` as execution truth
2. treat `outcome_state` as result truth
3. treat `handoff_state` as messaging truth

### 8.2 Follow-up questions must target `handoff_state`

Questions like:

- `写完了吗`
- `还没完成吗`
- `结果呢`

should not be answered by checking only whether a task is `done`.

They should answer:

1. Is execution still running?
2. Is there already a user-safe handoff?
3. Is the handoff a full answer, blocked explanation, or partial answer?

### 8.3 Blocked final results must show up in recent finals

Today recent-finish logic is basically done/failed.

That is wrong for research and analysis work.

`blocked` with `handoff_state=user_safe_ready` is a valid finished result and should appear in:

- status recent results
- IM thread updates
- operator timeline
- replay/eval samples

## 9. IM and session requirements

### 9.1 `session_key` must become mandatory for IM-originated delegation

If a task originates from Slack, Feishu, Telegram, WeChat, WebChat, or similar:

- no delegated task should be created without `session_key`
- if missing, the system should emit an observability error immediately

This is more important than silent best-effort execution.

### 9.2 Task anchor lifecycle should follow `handoff_state`

Task anchor rules:

- on dispatch: send/update anchor
- on blocked final with user-safe handoff: update anchor to blocked explanation
- on done final with user-safe handoff: update anchor to completed answer
- on failed: update anchor to failure with retry path

This would have made the Slack thread self-explanatory.

## 10. Can ClawTeam and DeerFlow ideas help earlier detection?

Yes.

### 10.1 ClawTeam

ClawTeam is already the right execution runtime:

- task
- inbox
- board
- tmux
- worker visibility

But OctoClaw currently underuses it as a state source.

What we should borrow more aggressively from the ClawTeam side:

- runtime identity is explicit
- parent/child lineage is explicit
- execution ownership is explicit

What OctoClaw still needs to add on top:

- result semantics
- handoff readiness
- observability invariants

### 10.2 DeerFlow-like protocol lessons

DeerFlow publicly presents itself as a research-oriented multi-agent flow with:

- sub-agents
- sandbox execution
- report generation
- human review surfaces

The key lesson worth borrowing is not a specific framework detail.

It is this:

> research workflows should expose checkpoint artifacts and deliverable readiness earlier than final answer time.

Applied to OctoClaw, that means:

- report exists
- report quality/state exists
- user-safe relay exists

should all be first-class tracked signals.

If we had that, the 17:12 Zhihu task would have shown:

- research finished
- blocked on source access
- conservative handoff ready

instead of leaving later tasks to guess.

## 11. Immediate remediation plan

### Slice A: state model

Add to runtime task record:

- `lifecycle_state`
- `outcome_state`
- `handoff_state`
- `blocked_on`
- `blocked_reason`
- `user_safe_summary`

Do not overload `status` any further.

### Slice B: writer commands

Extend [task-state-update.py](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus/lib/task-state-update.py):

- add `blocked` finish command
- add explicit outcome/handoff update flags
- keep `status` as compatibility mirror during migration

### Slice C: spawn/result contract

Update worker protocol:

- worker must emit `outcome_state`
- worker must emit whether summary is `user_safe`
- worker may finish `blocked` without being considered runtime failure

### Slice D: patrol

Update [patrol.py](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus/lib/patrol.py):

- detect missing `session_key` as observability degradation
- treat `finished + blocked + user_safe_ready` as valid terminal state
- send blocked-final notifications
- stop interpreting every non-done result as "still unfinished"

### Slice E: display/IM

Update display surfaces so they can distinguish:

- `running`
- `finished but blocked`
- `finished with full answer`
- `failed`

### Slice F: replay/eval

Add replay cases for:

- execution finished, outcome blocked, handoff ready
- execution finished, outcome partial, handoff ready
- missing session key on delegated task
- report exists but no user-safe summary

## 12. What should not be done

Do not patch this by only:

- changing one Slack prompt
- adding more summary heuristics
- treating every "evidence不足" string as failed
- forcing all blocked work to appear as active `blocked`

Those would hide the symptom, not solve the model.

## 13. Final conclusion

Yes, OctoClaw's current state tracking and state machine still have a structural issue.

The main problem is not "a task got stuck".

The main problem is:

- execution completion
- outcome resolution
- user-safe handoff readiness

are not separated cleanly enough.

That is why:

- a task can be finished
- a blocked explanation can already be ready
- and yet the operator experience still feels like "it never completed"

So this should be handled as a system-design correction, not just a bugfix.
