# OctoClaw Runtime Borrowings Execution v1

Date: 2026-03-30
Status: execution spec

This note turns the six post-DeerFlow/ClawTeam borrowings into one shared runtime surface.
It is intentionally narrower than the product design doc.

## Goal

Land these six capabilities without creating six disconnected side systems:

1. finer delegated event stream
2. harder IM thread/topic binding
3. artifact index plus retrieval
4. ownership lock plus dead-agent recovery
5. worker session resume store
6. todo/checklist persistence

## Design Rule

There is one runtime truth model for delegated work:

- `task-state.json` keeps normalized task truth
- task records carry:
  - `ownership`
  - `session_resume`
  - `checklist`
  - `artifacts`
- derived operational stores mirror that truth for fast retrieval:
  - `task-events.jsonl`
  - `session-thread-map.json`
  - `artifact-index.json`
  - `task-ownership.json`
  - `worker-session-store.json`
  - `task-checklists.json`

The stores above are not independent sources of truth.
They are recovery and retrieval surfaces derived from normalized task records.

## Runtime Truth Additions

### 1. Delegated Event Stream

`task-events.jsonl` should include explicit delegated lifecycle events, not just final status events.

New event families:

- `delegated_started`
- `ownership_claimed`
- `ownership_released`
- `session_bound`
- `progress_note`
- `retry_scheduled`
- `timeout_detected`
- `worker_resumed`
- `artifact_indexed`
- `checklist_updated`
- `dead_agent_recovered`

Each event should carry, when known:

- `task_id`
- `parent_id`
- `session_key`
- `session_thread_key`
- `route`
- `worker_pool`
- `phase`
- `status`
- `ownership_state`
- `resume_state`
- `artifact_count`
- `checklist_open_count`

### 2. IM Thread Binding

`session-thread-map.json` should store both:

- binding by `session_key`
- stable thread/topic identity by `origin + target + thread_id`

Required concepts:

- `binding_key = origin:target`
- `thread_key = origin:target:thread_or_root`
- `task_ids`
- `message_ids`
- `thread_state = active|closed`
- `last_task_id`
- `last_message_id`
- `closed_at`

The runtime should allow:

- follow-up reuse of the same bound thread
- inspection of which tasks already belong to a thread
- safe closure without losing history

### 3. Artifact Index

`artifact-index.json` is the fast retrieval surface over:

- `report_path`
- `context_path`
- `files_changed`
- `worker_result`
- parent/child aggregated artifacts

Each indexed artifact should have:

- `artifact_id`
- `task_id`
- `parent_id`
- `kind`
- `title`
- `path`
- `preview`
- `worker_pool`
- `phase`
- `status`
- `session_thread_key`
- `updated_at`

### 4. Ownership Lock

Every delegated task should normalize an `ownership` block:

- `owner_id`
- `owner_namespace`
- `owner_session_id`
- `run_id`
- `state = unclaimed|claimed|released|stale`
- `claimed_at`
- `last_heartbeat_at`
- `lease_seconds`
- `lease_expires_at`

Dead-agent recovery rule:

- if a task is non-final
- and ownership is claimed
- and heartbeat is stale
- mark ownership stale
- emit `dead_agent_recovered`
- return the task to a recoverable queue state

### 5. Worker Session Resume

Every delegated task should normalize a `session_resume` block:

- `resume_key`
- `agent_id`
- `agent_namespace`
- `session_id`
- `run_id`
- `session_status`
- `resume_state = none|active|ready|stale|complete`
- `last_observed_at`

This powers:

- patrol recovery
- operator inspection
- future resume-aware spawn behavior

### 6. Checklist Persistence

Every delegated task should normalize a `checklist` block:

- `kind`
- `items`
- `open_count`
- `completed_count`
- `updated_at`

Checklist sources:

- explicit task checklist if provided
- team parent step order
- default delegated checklist:
  - dispatch
  - execute
  - report
  - handoff

## Wiring Plan

The code path should be:

1. normalize task record
2. derive ownership/session_resume/checklist
3. write task-state
4. mirror to:
  - event log
  - thread map
  - artifact index
  - ownership store
  - session store
  - checklist store

## Integration Points

Primary writers:

- `lib/task-state-update.py`
- `lib/octoclaw_spawn.py`
- `lib/dispatch_task.py`

Recovery and liveness:

- `lib/patrol.py`

Read surfaces:

- `lib/status.sh`
- `lib/status_render.py`
- retrieval helper scripts

## Non-goals for This Slice

- full LangGraph-style orchestration
- replacing OpenClaw IM transport
- replacing ClawTeam session execution
- building a separate task database

## Success Criteria

This slice is successful when:

- delegated tasks emit granular runtime events
- session/thread bindings are stable across follow-ups
- artifacts can be listed and retrieved by task
- stale claimed tasks can be detected and recovered
- worker session metadata survives restarts
- checklist state survives summary/result generation
