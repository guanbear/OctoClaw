# OctoClaw + ClawTeam Unified Runtime v1.2 (2026-03-25)

## 1. Core Direction

The right long-term shape is not:

- OctoClaw does all orchestration and all execution management itself
- ClawTeam is only used for `spawn_multi`

The better shape is:

> **OctoClaw remains the orchestration brain. ClawTeam becomes the shared execution/collaboration runtime for all non-direct work.**

That means:

- `direct` stays in the main agent
- `runner` enters the shared collaboration runtime as a special executor
- `spawn_single` enters the shared collaboration runtime as a single worker task
- `spawn_multi` enters the shared collaboration runtime as a task graph / team flow
- heavy execution semantics are applied as a **profile/protocol** on top of `spawn_single` or `spawn_multi`, not as a separate runtime

Operationally, all non-direct work should also be visible in a tmux-backed workbench:

- `runner`: one stable daemon pane / slot
- `spawn_single`: one focused worker pane
- `spawn_multi`: multiple worker panes or tiled windows

For OctoClaw itself, the preferred near-term operator mode should be:

- `SUPERVISOR_MODE=tmux`
- one fixed tmux window for `runner-daemon`
- one fixed tmux window for `patrol-loop`
- later merge or align this workbench with ClawTeam task/inbox/board

## 2. Layered Model

### 2.1 OctoClaw layer: the brain

OctoClaw should continue owning:

- route decisions
- role hints
- tier hints
- model / profile resolution
- cost / budget / quota / plan-state policy
- patrol / recovery / redispatch policy
- runner fast-path policy

This is where OctoClaw has structural advantage.

### 2.2 ClawTeam layer: the runtime fabric

ClawTeam should provide the shared runtime surface for non-direct work:

- task objects
- inbox / result collection
- event history
- board
- tmux windows / panes
- worktree / workspace isolation where useful

This is where ClawTeam has structural advantage.

### 2.3 Executor layer: actual workers

Execution can still vary:

- OpenClaw subagents
- OctoClaw persistent runner
- future custom executors

So the runtime should not assume all workers are identical.

## 3. Route Mapping

### 3.1 `direct`

`direct` remains outside ClawTeam runtime.

Reason:

- no need for task shell
- no need for board slot
- no need for tmux process

### 3.2 `runner`

`runner` should be modeled as a **special worker type**, not as a normal interactive subagent.

Recommended shape:

- create a task in the shared runtime
- assign `executor=runner`
- use ClawTeam task/inbox/event/board as the collaboration shell
- expose one stable tmux slot for the runner daemon
- keep actual execution inside OctoClaw runner daemon / queue

This preserves:

- fast path latency
- existing runner reliability
- unified observability

The key distinction is:

- the runner itself is long-lived
- each runner job still executes in a fresh shell subprocess
- the runner daemon is recycled by policy rather than by per-job spawn

Recommended recycle policy:

- per-job shell isolation
- recycle after `RUNNER_MAX_JOBS_PER_WORKER`
- recycle after `RUNNER_MAX_AGE_MINUTES`
- recycle after `RUNNER_MAX_IDLE_SECONDS` once it has already served work

### 3.3 `spawn_single`

`spawn_single` should use the same shared runtime:

- create a task
- assign one worker
- collect deliverables via inbox / artifacts
- open a dedicated tmux pane / window by default for inspection and takeover

This avoids the current split where only multi-step work gets rich collaboration semantics.

### 3.4 `spawn_multi`

`spawn_multi` should map to:

- task graph
- role-specific workers
- dependencies / unblock flow
- board / tmux / worktree where relevant

This is where ClawTeam already fits naturally.

### 3.5 Heavy profile, not heavy runtime

The current preferred direction is:

- do **not** introduce a separate DeerFlow-like runtime yet
- instead define a **heavy profile** on top of the ClawTeam runtime

This heavy profile should add:

- stricter brief / constraints / expected-output schema
- stronger summary / artifact requirements
- longer timeout and background expectations
- optional dedicated workspace / sandbox
- stronger review and merge gate

So in practice:

- simple / medium work uses normal `spawn_single` / `spawn_multi`
- long research / sandbox-heavy / recursive tasks use `spawn_single` or `spawn_multi` **with heavy protocol enabled**

This keeps one runtime surface while still borrowing DeerFlow's execution philosophy.

## 4. Why tmux still matters

tmux is not the task store.
tmux is not the mailbox.

tmux is the **interactive process workspace**:

- one live terminal slot per worker
- attach / inspect / intervene
- session survives SSH disconnect
- tiled dashboard for swarm observation

In the unified runtime, tmux should be treated as the default operator surface for all non-direct work.
The difference is not whether tmux exists, but what the tmux slot represents:

- for `runner`, tmux represents the long-lived daemon
- for `spawn_single`, tmux represents the worker session
- for `spawn_multi`, tmux represents the team workspace

Without tmux, ClawTeam can still offer:

- task store
- inbox
- event log

But with tmux, it becomes a much stronger swarm runtime:

- more observable
- easier to debug
- easier to supervise
- easier to manually recover

## 5. Key Architectural Insight

The most important shift is:

> **All non-direct work should converge onto one shared runtime surface.**

Without this, the system stays split:

- runner has one state model
- single subagent has another
- multi-agent work has another

That causes:

- fragmented observability
- duplicated recovery logic
- inconsistent result collection
- different board/status semantics

With one shared runtime surface:

- every non-direct unit gets a task identity
- every non-direct unit can emit results the same way
- every non-direct unit can appear in the same board
- every non-direct unit can be audited and supervised consistently

## 6. Recommended Runtime Contract

Each non-direct execution unit should expose:

- `task_id`
- `route`
- `executor_type`
- `owner`
- `role`
- `tier`
- `model/profile`
- `status`
- `summary`
- `artifacts`
- `report_path`
- `events`
- `inbox delivery`

Suggested executor types:

- `runner`
- `subagent`
- `team`

Suggested worker classes:

- `octopus-runner`
- `octopus-fix`
- `octopus-scout`
- `octopus-writer`
- `octopus-analyze`
- `octopus-power`
- `octopus-test`

## 7. Model Selection Ownership

Model selection should stay with OctoClaw.

Why:

- route and model are coupled
- role and model are coupled
- budget and model are coupled
- runner and model are coupled
- plan-state / quota are OctoClaw-native concerns

So the runtime contract should look like:

1. OctoClaw decides route
2. OctoClaw resolves role / tier / model / profile
3. OctoClaw passes `model/profile` directly as runtime parameters
4. ClawTeam runtime executes that decision

That means ClawTeam should be treated as:

- execution fabric
- not the policy engine

The first integration step should therefore be direct parameter passing, not deep ClawTeam policy changes.
Later, this can be generalized into a resolver hook if upstream contribution makes sense.

## 8. What ClawTeam gives OctoClaw

If unified runtime is adopted, OctoClaw gains:

- task/inbox as first-class collaboration primitives
- one board for runner + single + multi work
- tmux-based intervention points
- cleaner result collection
- cleaner debugging
- less black-box swarm behavior

## 9. What OctoClaw still uniquely contributes

Even after adopting more of ClawTeam runtime, OctoClaw still owns:

- route intelligence
- dynamic model selection
- cost-aware policy
- plan-state / subscription logic
- runner fast path
- patrol/self-healing
- OpenClaw-specific integration depth

## 10. Immediate Implementation Direction

Short-term implementation should follow this order:

1. keep OctoClaw route / patrol / model resolution as-is
2. wire ClawTeam `task/inbox` CLI as the shared collaboration substrate
3. pass `model/profile` directly from OctoClaw into ClawTeam spawn/task metadata
4. expose tmux for all non-direct work
5. keep runner as a special executor backed by queue + daemon + recycle policy

This gives one operator-visible runtime without giving up OctoClaw's orchestration advantage.

So adopting ClawTeam runtime does not erase OctoClaw value.
It sharpens it.

## 10. Implementation Roadmap

### Phase 0: Current validation

Already done in partial form:

- mirrored `tasks / inbox / events / board`
- report excerpt return path
- stronger final-answer rules

### Phase 1: Task/inbox CLI integration

Goal:

- connect OctoClaw bridge to real `clawteam task/inbox` commands
- keep local mirror for observability and rollback safety

Output:

- `backend=hybrid`
- real inbox send
- initial task sync

### Phase 2: Single-task runtime unification

Goal:

- route `spawn_single` through shared runtime shell
- every single worker gets task + inbox + board presence

Output:

- no more special-case single-task black boxes

### Phase 3: Runner shell unification

Goal:

- runner jobs get task shells and board visibility
- execution still handled by OctoClaw runner daemon

Output:

- one runtime surface for runner + subagent

### Phase 4: Multi-task DAG runtime

Goal:

- full dependency graph for `spawn_multi`
- optional tmux/worktree integration

Output:

- richer orchestration and supervision

### Phase 5: Heavy protocol on unified runtime

Goal:

- support long-running research / sandbox-heavy / recursive tasks without introducing a separate runtime
- keep the same task/inbox/board/tmux surface
- only upgrade execution semantics when needed

Output:

- heavy profile for selected `spawn_single` / `spawn_multi` jobs
- stronger artifact-first flows
- clearer review / merge rules

### Phase 6: tmux-centered operations mode

Goal:

- board attach for live monitoring
- per-worker panes/windows
- manual intervention model

Output:

- swarm becomes observable and recoverable in real time

## 11. PR Direction for Future Open Source Contribution

### To ClawTeam upstream

Best contribution target:

- generic resolver hooks before spawn
- profile/model resolver command
- external policy integration point

This keeps upstream general and reusable.

### To ClawTeam-OpenClaw

Best contribution target:

- OctoClaw-style dynamic role-aware model/profile selection
- budget/plan-aware policy
- runner fast-path concepts
- patrol/self-healing concepts

This is more likely to fit the OpenClaw-specific fork.

## 12. Final Recommendation

The target architecture should be:

> **OctoClaw as the decision/policy brain**
> **ClawTeam as the shared execution and collaboration runtime**
> **tmux as the interactive swarm operations surface**

And importantly:

> **This should apply to all non-direct work, not only `spawn_multi`.**
