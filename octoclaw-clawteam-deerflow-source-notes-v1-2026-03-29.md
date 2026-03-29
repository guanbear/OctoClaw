# OctoClaw ClawTeam + DeerFlow Source Notes v1

Date: 2026-03-29

## 1. Source baseline

This note is based on actual source, not only prior design docs.

### 1.1 Local source references

- DeerFlow clone:
  - `/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/deer-flow`
- ClawTeam source snapshot exported from the VM-installed package:
  - `/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/clawteam`

### 1.2 What this note focuses on

Only source areas that matter for OctoClaw:

- runtime state
- task lifecycle
- delegation / subagent execution
- session or thread mapping
- artifacts and user-facing deliverables
- early anomaly detection

## 2. What ClawTeam actually gives us

ClawTeam is smaller and simpler than OctoClaw.

That is useful.

It is opinionated around:

- file-backed team/task truth
- mailbox messaging
- liveness-aware spawn registry
- operator waiting / progress output

### 2.1 Task truth is explicit and narrow

In [tasks.py](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/clawteam/team/tasks.py), every task is its own JSON file, and the task model is intentionally small:

- `pending`
- `in_progress`
- `completed`
- `blocked`

Important behaviors:

- blocked dependencies become first-class task state at creation time
- lock ownership is explicit
- stale locks are released if the owning agent is dead

Relevant source:

- [tasks.py:22](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/clawteam/team/tasks.py#L22)
- [tasks.py:54](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/clawteam/team/tasks.py#L54)
- [tasks.py:88](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/clawteam/team/tasks.py#L88)
- [tasks.py:146](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/clawteam/team/tasks.py#L146)

Main lesson for OctoClaw:

> keep execution state simple, and do not hide liveness/ownership inside summaries.

### 2.2 Spawn liveness is a separate registry

ClawTeam does not try to infer process liveness only from task status.

It keeps a separate spawn registry with:

- backend
- tmux target
- pid
- spawned_at

Then it checks liveness by:

- tmux pane state
- fallback PID check

Relevant source:

- [registry.py:12](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/clawteam/spawn/registry.py#L12)
- [registry.py:39](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/clawteam/spawn/registry.py#L39)
- [registry.py:73](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/clawteam/spawn/registry.py#L73)
- [registry.py:109](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/clawteam/spawn/registry.py#L109)

Main lesson for OctoClaw:

> process/session liveness should not be reconstructed only from task snapshots.

This directly supports the state-machine remediation direction.

### 2.3 Waiting logic distinguishes pending vs blocked vs completed

ClawTeam's waiter is not fancy, but it is honest.

It separately tracks:

- completed
- in_progress
- pending
- blocked

And when an agent dies, it resets abandoned `in_progress` tasks to `pending`.

Relevant source:

- [waiter.py:15](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/clawteam/team/waiter.py#L15)
- [waiter.py:86](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/clawteam/team/waiter.py#L86)
- [waiter.py:154](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/clawteam/team/waiter.py#L154)

And the CLI surfaces that explicitly:

- [commands.py:1139](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/clawteam/cli/commands.py#L1139)
- [commands.py:1207](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/clawteam/cli/commands.py#L1207)

Main lesson for OctoClaw:

> blocked should remain visible as a distinct result class, not be collapsed into "still running" or "not done yet".

### 2.4 Session persistence is first-class, but simple

ClawTeam stores session state per agent:

- `session_id`
- `last_task_id`
- free-form `state`

Relevant source:

- [sessions.py:16](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/clawteam/spawn/sessions.py#L16)
- [sessions.py:41](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/clawteam/spawn/sessions.py#L41)

Main lesson for OctoClaw:

> session continuity should be explicit storage, not only whatever patrol can rediscover later.

### 2.5 Board data is aggregated from multiple truth sources

ClawTeam board data is a composed view:

- team config
- task store
- inbox counts
- event log
- cost summary

Relevant source:

- [collector.py:12](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/clawteam/board/collector.py#L12)
- [collector.py:42](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/clawteam/board/collector.py#L42)
- [collector.py:64](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/clawteam/board/collector.py#L64)

Main lesson for OctoClaw:

> board/status should remain a derived operator view, not the place where truth is invented.

## 3. What DeerFlow actually gives us

DeerFlow is much broader than ClawTeam.

For OctoClaw, the most relevant parts are:

- ThreadState
- task delegation events
- thread/topic mapping for IM
- artifact serving
- todo state persistence across context loss

### 3.1 ThreadState is explicit and extensible

DeerFlow does not hide everything in ad-hoc message parsing.

Its thread runtime state has explicit slots for:

- sandbox
- thread_data
- title
- artifacts
- todos
- uploaded_files
- viewed_images

Relevant source:

- [thread_state.py:1](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/deer-flow/backend/packages/harness/deerflow/agents/thread_state.py#L1)
- [thread_state.py:19](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/deer-flow/backend/packages/harness/deerflow/agents/thread_state.py#L19)

Main lesson for OctoClaw:

> user-facing work needs explicit runtime fields for artifact and progress-related truth, not only a flattened task record.

### 3.2 Subagent execution emits explicit runtime events

This is one of the most important differences from current OctoClaw.

DeerFlow's `task` tool explicitly emits:

- `task_started`
- `task_running`
- `task_completed`
- `task_failed`
- `task_timed_out`

Relevant source:

- [task_tool.py:123](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/deer-flow/backend/packages/harness/deerflow/tools/builtins/task_tool.py#L123)
- [task_tool.py:153](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/deer-flow/backend/packages/harness/deerflow/tools/builtins/task_tool.py#L153)
- [task_tool.py:168](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/deer-flow/backend/packages/harness/deerflow/tools/builtins/task_tool.py#L168)

And the underlying executor tracks an explicit subagent status enum:

- `PENDING`
- `RUNNING`
- `COMPLETED`
- `FAILED`
- `TIMED_OUT`

Relevant source:

- [executor.py:21](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/deer-flow/backend/packages/harness/deerflow/subagents/executor.py#L21)
- [executor.py:48](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/deer-flow/backend/packages/harness/deerflow/subagents/executor.py#L48)
- [executor.py:368](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/deer-flow/backend/packages/harness/deerflow/subagents/executor.py#L368)

Main lesson for OctoClaw:

> event stream matters; snapshots alone are too late and too ambiguous.

This is exactly why DeerFlow-style execution can reveal "it finished, but the result is X-type" earlier than OctoClaw currently does.

### 3.3 IM thread mapping is explicit

DeerFlow has a dedicated channel store that maps:

- `channel_name`
- `chat_id`
- `topic_id`

to a persistent DeerFlow thread id.

Relevant source:

- [store.py:16](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/deer-flow/backend/app/channels/store.py#L16)
- [store.py:69](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/deer-flow/backend/app/channels/store.py#L69)

Its Slack adapter uses `thread_ts` as `topic_id`, and immediately binds the inbound message to that thread topic.

Relevant source:

- [slack.py:211](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/deer-flow/backend/app/channels/slack.py#L211)

Main lesson for OctoClaw:

> IM origin identity should be a hard mapping layer, not something that delegated tasks may or may not remember later.

This strongly supports making `session_key` mandatory for IM-originated delegated work.

### 3.4 Artifacts are first-class HTTP resources

DeerFlow exposes artifacts through a dedicated router, not just raw filesystem paths passed around inside summaries.

Relevant source:

- [artifacts.py:74](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/deer-flow/backend/app/gateway/routers/artifacts.py#L74)

And the architecture docs explicitly show upload → artifact URL → later consumption.

Relevant source:

- [ARCHITECTURE.md:373](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/deer-flow/backend/docs/ARCHITECTURE.md#L373)

Main lesson for OctoClaw:

> artifact-first should not stop at "write a markdown file"; it should extend to artifact readiness and stable retrieval.

### 3.5 Todo state survives summarization loss

DeerFlow's todo middleware handles a subtle but important failure mode:

- state still contains todos
- but the original tool call has scrolled out of context
- so the middleware injects a reminder

Relevant source:

- [todo_middleware.py:1](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/deer-flow/backend/packages/harness/deerflow/agents/middlewares/todo_middleware.py#L1)
- [todo_middleware.py:67](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/deer-flow/backend/packages/harness/deerflow/agents/middlewares/todo_middleware.py#L67)

Main lesson for OctoClaw:

> state and transcript are different things.

OctoClaw currently still loses too much meaning when only summaries survive.

## 4. What not to borrow

### 4.1 Do not copy DeerFlow's full LangGraph stack

OctoClaw does not need to become DeerFlow.

We should borrow:

- explicit thread/task state
- explicit event model
- artifact readiness
- topic/thread mapping

We should not borrow wholesale:

- full LangGraph runtime architecture
- all middleware layering
- all gateway surface area

### 4.2 Do not collapse OctoClaw into ClawTeam's minimal task model

ClawTeam's task model is intentionally lean:

- pending
- in_progress
- completed
- blocked

OctoClaw needs more because it also owns:

- user-safe handoff semantics
- route/model/review explanation
- IM operator surface
- replay/eval

So ClawTeam should remain execution runtime input, not the whole product model.

## 5. Source-based conclusion for OctoClaw

### 5.1 ClawTeam confirms the need for separate liveness truth

ClawTeam source supports the idea that OctoClaw should separate:

- task state
- process/session liveness
- board view

This validates:

- separate observability health fields
- separate liveness evidence
- less guessing from a single `status`

### 5.2 DeerFlow confirms the need for explicit evented delegation state

DeerFlow source validates that delegated execution benefits from:

- explicit runtime events
- persistent thread/topic identity
- artifact URLs/readiness
- state distinct from prompt context

This strongly validates the OctoClaw remediation direction:

- `lifecycle_state`
- `outcome_state`
- `handoff_state`

### 5.3 The Slack incident would have been easier to detect under both systems

With ClawTeam-like liveness truth:

- we would know whether the worker/session was really still alive

With DeerFlow-like task events:

- we would know the worker reached terminal execution
- and we could surface the exact terminal category sooner

What neither gives us directly:

- OctoClaw-specific user-safe handoff semantics

That still has to be designed in OctoClaw itself.

## 6. Recommended next steps

The most justified direction remains:

1. keep ClawTeam as execution runtime
2. keep DeerFlow as reference for event/state/artifact design
3. continue translating those ideas into OctoClaw-native runtime truth

The first source-backed slice is already in progress or landed:

- `lifecycle_state`
- `outcome_state`
- `handoff_state`
- delegated event log
- IM-originated `session_key` hard requirement
- persistent `session_target / session_thread_key`

## 7. Highest-value borrowings still worth implementing

### 7.1 Explicit task event stream as a first-class product surface

DeerFlow does not rely only on final state snapshots. It emits explicit runtime progression:

- task started
- task running / incremental progress
- task completed
- task failed
- task timed out

For OctoClaw, this means the next useful expansion is not just "more logging", but a stable event taxonomy for:

- `agent_message`
- `progress_note`
- `timeout`
- `retry`
- `operator_ack`
- `anchor_sent / anchor_edited / anchor_failed`

This is the cleanest path to making Slack/WebChat/operator surfaces explain *what happened* instead of only *what the final status field says*.

### 7.2 IM thread mapping should become a hard routing primitive

DeerFlow's channel store treats conversation/topic identity as durable state, not an afterthought.

OctoClaw should continue this direction by making:

- thread reuse
- thread close/archive
- follow-up-to-original-thread
- stale binding cleanup

explicit runtime operations rather than implicit heuristics.

This is not Slack-specific. It applies equally to any IM channel with the concept of:

- chat
- room
- thread
- topic

### 7.3 Artifact-first retrieval should become a real access layer

DeerFlow shows that artifact-first is more than "write a markdown report".
The important missing piece is stable retrieval.

OctoClaw should add a proper artifact index over:

- `report`
- `context`
- `files_changed`
- `worker_result`
- future screenshots / bundles / summaries

with stable metadata such as:

- artifact kind
- title
- preview
- readiness
- retrieval path / link

### 7.4 Ownership lock and dead-agent recovery

ClawTeam's task store and spawn registry are strong references for execution safety:

- ownership lock is explicit
- liveness is checked against real process/tmux state
- dead workers cause task recovery, not silent drift

OctoClaw should borrow this directly for delegated work so that:

- a task cannot be "running forever" without an owner
- abandoned tasks can move back to a recoverable queue state
- patrol can explain *who owns the task* and *whether that worker is alive*

### 7.5 Session resume store for delegated workers

ClawTeam persists agent session identity separately from task truth.
That is valuable for OctoClaw because runtime task records alone are not enough for reliable resume.

Useful fields to add:

- `agent_id`
- `session_id`
- `last_task_id`
- `resume_state`
- `saved_at`

This would make tmux-backed and long-running delegated work much more restart-tolerant.

### 7.6 Todo/checklist memory across context loss

DeerFlow's todo middleware solves a subtle but important failure mode:

- the state still knows the checklist
- but the active context window forgets it

OctoClaw can borrow this pattern for:

- parent-task step checklist
- worker progress checklist
- post-summary checklist reminder
- operator-visible "what remains" surface

This is especially valuable for long research, multi-step repair, and heavy-profile work.

## 8. Recommended implementation order

If we continue from highest value and lowest architectural regret, the order should be:

1. expand delegated event stream
2. harden IM session/thread mapping
3. add artifact index and retrieval surface
4. add ownership lock and dead-agent recovery
5. add worker session resume store
6. add todo/checklist persistence

This keeps ClawTeam responsible for execution, DeerFlow as the reference for explicit state/event/artifact patterns, and OctoClaw responsible for the productized runtime truth above them.
