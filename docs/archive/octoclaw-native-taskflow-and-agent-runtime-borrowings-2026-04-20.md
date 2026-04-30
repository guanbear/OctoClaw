# OctoClaw Native TaskFlow and Agent Runtime Borrowings (2026-04-20)

## 1. Why this note exists

This note is the detailed source-level companion to:

- [octoclaw-ts-rebuild-design-v1.md](../octoclaw-ts-rebuild-design-v1.md)
- [octoclaw-ts-rebuild-implementation-plan-2026-04-15.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus-macmini/docs/octoclaw-ts-rebuild-implementation-plan-2026-04-15.md)

Its purpose is not to redesign OctoClaw from scratch.

Its purpose is to answer a narrower and more practical question:

> When OctoClaw rebuilds around OpenClaw native `task/flow`, what should we actually borrow from the agent systems we already studied, and where should each borrowing land?

The focus is intentionally narrow:

1. native `task/flow` integration
2. single delegated worker lifecycle
3. child worker context / resume / retry / recovery
4. status / timeline / progress push
5. future multi-agent expansion

This note is source-oriented and implementation-oriented. It is not just a list of inspirations.

---

## 2. Source baseline

### 2.1 Local source references already available

This note is based on local source snapshots and repository notes that already exist in this workspace:

- [oh-my-openagent](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/oh-my-openagent)
- [hermes-agent](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/hermes-agent)
- [clawteam](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/clawteam)
- [deer-flow](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/deer-flow)
- [get-shit-done](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/get-shit-done)

And these earlier design/source notes:

- [octoclaw-anthropic-agent-engineering-notes-v1-2026-03-30.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus-macmini/docs/archive/design-notes/octoclaw-anthropic-agent-engineering-notes-v1-2026-03-30.md)
- [octoclaw-review-and-action-plan-v1-2026-04-02.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus-macmini/docs/archive/design-notes/octoclaw-review-and-action-plan-v1-2026-04-02.md)
- [octoclaw-clawteam-deerflow-source-notes-v1-2026-03-29.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus-macmini/docs/archive/design-notes/octoclaw-clawteam-deerflow-source-notes-v1-2026-03-29.md)
- [deerflow-clawteam-open-source-analysis-2026-03-26.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus-macmini/docs/archive/design-notes/deerflow-clawteam-open-source-analysis-2026-03-26.md)
- [octoclaw-product-design-v2-2026-03-27.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus-macmini/docs/archive/design-notes/octoclaw-product-design-v2-2026-03-27.md)

### 2.2 External public references

These public references are also useful as cross-checks:

- [open-multi-agent](https://github.com/JackChen-me/open-multi-agent)
- [ClawTeam-OpenClaw](https://github.com/win4r/ClawTeam-OpenClaw)
- [Oh My OpenAgent docs](https://ohmyopenagent.com/docs)
- [OpenClaw cron / job docs](https://docs.openclaw.ai/automation/cron-jobs)
- [GitHub engineering note: multi-agent workflows often fail](https://github.blog/ai-and-ml/generative-ai/multi-agent-workflows-often-fail-heres-how-to-engineer-ones-that-dont/)

---

## 3. Final conclusions first

This note can be compressed into 10 conclusions.

1. **OpenClaw native `task/flow` must be the execution source of truth.**
2. **OctoClaw should still keep its own product-layer objects:** `delegate_task`, `delegate_attempt`, `resume_packet`, `status projection`.
3. **Single delegate must be designed as a first-class lifecycle, not as a temporary shortcut before multi-agent.**
4. **Child workers should receive typed handoff packets, not full transcripts.**
5. **Recovery must be classified and orchestrated; child workers should not decide their own next step.**
6. **Status/timeline/progress push should come from runtime truth plus projection, not from raw child logs.**
7. **Parallelism should be model-assisted but scheduler-enforced.**
8. **Session continuity and subagent linkage matter, but they must not become a second hidden truth source.**
9. **Background concurrency, stale timeout, lock ownership, retry backoff, and worktree isolation all have real value, but they belong to runtime and recovery, not top-level route semantics.**
10. **Future multi-agent should extend `route=delegate`, not replace the single-delegate foundation.**

The practical result is:

> OctoClaw should become `policy + projection + recovery + status` on top of OpenClaw native `task/flow`, while borrowing execution/runtime patterns from ClawTeam, DeerFlow, Oh My OpenAgent, Hermes, and open-multi-agent.

---

## 4. What the core object model should be

Before discussing borrowings project by project, it helps to fix the target layering.

### 4.1 The 4 layers we should keep separate

#### A. User/Product layer

Objects the user and main agent care about:

- thread
- surface anchor
- user-visible delegated work
- delivery result
- status/timeline view

#### B. OctoClaw policy/recovery layer

Objects OctoClaw itself owns:

- route decision
- reply mode
- delegate role
- complexity
- scope
- delegate task
- delegate attempt
- recovery packet
- resume packet

#### C. OpenClaw execution substrate

Objects OpenClaw owns:

- native flow
- native task
- native event stream
- native checkpoint / result / terminal state

#### D. Backend / workspace / tooling layer

Actual execution surfaces:

- on-demand worker
- optional runner
- worktree
- shell/tool provider
- model/provider backend

### 4.2 Why this separation matters

Without this split, the system easily collapses into one of two bad shapes:

1. OctoClaw re-creates a second task system on top of native flow/task.
2. OctoClaw gives up its product/recovery semantics and tries to expose native flow/task directly as user semantics.

Both are wrong.

The correct shape is:

- native flow/task = execution truth
- OctoClaw delegate task/attempt = policy and product truth
- status surface = projection over both

---

## 5. Borrowings from OpenClaw native task/flow

The most important borrowing is also the easiest to forget:

> **Do not borrow "task" as an abstract concept only. Borrow native `task/flow` as the substrate that all delegated execution must bind to.**

Earlier notes already landed this direction:

- [octoclaw-anthropic-agent-engineering-notes-v1-2026-03-30.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus-macmini/docs/archive/design-notes/octoclaw-anthropic-agent-engineering-notes-v1-2026-03-30.md:269)
- [octoclaw-review-and-action-plan-v1-2026-04-02.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus-macmini/docs/archive/design-notes/octoclaw-review-and-action-plan-v1-2026-04-02.md:188)

### 5.1 What to borrow

1. native creation and execution via runtime seam
2. native status / terminal state / event stream
3. possible native subtask / DAG support as future substrate
4. native session binding and cancellation surfaces where available

### 5.2 What not to do

1. do not keep `task-state.json` as execution truth
2. do not keep patrol/reconcile as the primary truth source
3. do not let CLI create become the main delegated creation path when plugin/runtime seam exists

### 5.3 Design consequence

Every delegated work item should bind to native flow/task through an explicit mapping:

- `delegate_task_id`
- `attempt_id`
- `native_flow_id`
- `native_task_id`
- `claim_owner`
- `resume_generation`

This binding is not optional polish. It is the center of the whole rebuild.

---

## 6. Borrowings from ClawTeam and ClawTeam-OpenClaw

ClawTeam and ClawTeam-OpenClaw are valuable not because OctoClaw should become a tmux swarm by default, but because they encode several durable runtime ideas.

### 6.1 What the source clearly gives us

#### A. Explicit task store with lock ownership

ClawTeam task storage and lock ownership are explicit in:

- [team/tasks.py](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/clawteam/team/tasks.py#L39)
- [team/tasks.py](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/clawteam/team/tasks.py#L114)
- [team/tasks.py](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/clawteam/team/tasks.py#L161)

Important behaviors:

1. blocked dependencies are first-class
2. ownership lock is explicit
3. stale locks can be released when the lock holder is dead

Borrowing:

- OctoClaw should preserve explicit ownership / lease / claim, even after moving execution truth to native flow/task.

#### B. Explicit session persistence for resume

ClawTeam session persistence is explicit:

- [spawn/sessions.py](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/clawteam/spawn/sessions.py#L39)

Borrowing:

- delegated worker session identity should be stored explicitly
- resume should not depend on re-discovering a session from logs or history

#### C. Worktree isolation and checkpointing

ClawTeam workspace manager shows isolated worktree creation and checkpointing:

- [workspace/manager.py](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/clawteam/workspace/manager.py#L46)
- [workspace/manager.py](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/clawteam/workspace/manager.py#L58)
- [workspace/manager.py](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/clawteam/workspace/manager.py#L107)
- [workspace/manager.py](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/clawteam/workspace/manager.py#L169)

Borrowing:

- isolated worktree is a backend/workspace decision
- checkpoints should be explicit lifecycle events
- cleanup and merge are post-execution workflow concerns, not model concerns

#### D. Spawn resilience and retry/backoff

Public ClawTeam-OpenClaw docs explicitly mention:

- retry with backoff
- idempotency keys
- task locking
- worktree isolation

See:

- [ClawTeam-OpenClaw README](https://github.com/win4r/ClawTeam-OpenClaw)

Borrowing:

- spawn retry and dedupe should be first-class runtime behavior
- repeated attempt should not create duplicate user-visible work

### 6.2 What not to borrow

1. do not make tmux a system prerequisite
2. do not treat swarm/team runtime as the default path
3. do not let ClawTeam semantics replace OctoClaw user-safe status semantics

### 6.3 Design consequence

From ClawTeam, OctoClaw should borrow:

1. ownership and stale-lock semantics
2. session persistence
3. worktree isolation
4. spawn retry/backoff
5. dependency-aware waiting

But these should now land on top of native flow/task, not as a parallel truth source.

---

## 7. Borrowings from DeerFlow

DeerFlow is the strongest reference for explicit evented execution.

### 7.1 What the source clearly gives us

#### A. Task progression should not be hidden inside final state

Earlier source notes already captured the key point:

- [octoclaw-clawteam-deerflow-source-notes-v1-2026-03-29.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus-macmini/docs/archive/design-notes/octoclaw-clawteam-deerflow-source-notes-v1-2026-03-29.md:403)

Borrowing:

- delegated execution needs explicit progression events
- `checkpoint` and `deliverable_ready` should exist before final completion

#### B. Topic/thread identity should be explicit

Earlier source notes also documented DeerFlow's explicit thread/topic mapping:

- [octoclaw-clawteam-deerflow-source-notes-v1-2026-03-29.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus-macmini/docs/archive/design-notes/octoclaw-clawteam-deerflow-source-notes-v1-2026-03-29.md:235)

Borrowing:

- IM thread binding must be a hard mapping layer
- delegated work should not "remember" thread identity only through prompt context

#### C. Artifact readiness and retrieval should be first-class

Again from the source note:

- [octoclaw-clawteam-deerflow-source-notes-v1-2026-03-29.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus-macmini/docs/archive/design-notes/octoclaw-clawteam-deerflow-source-notes-v1-2026-03-29.md:262)

Borrowing:

- artifact-first should mean retrievable artifact objects, not only markdown dumped into summaries

#### D. State and transcript are different things

The todo middleware lesson remains important:

- [octoclaw-clawteam-deerflow-source-notes-v1-2026-03-29.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus-macmini/docs/archive/design-notes/octoclaw-clawteam-deerflow-source-notes-v1-2026-03-29.md:280)

Borrowing:

- delegate task state should survive summarization loss
- resume should be explicit state, not transcript rediscovery

### 7.2 What not to borrow

1. do not import the full LangGraph runtime
2. do not force every task through a heavy planner/reporter topology
3. do not make the whole product graph-shaped before the single delegate lifecycle is stable

### 7.3 Design consequence

From DeerFlow, OctoClaw should borrow:

1. explicit event stream
2. artifact readiness
3. state distinct from prompt context
4. thread/topic binding as durable state

These are the reasons the delegated lifecycle in OctoClaw should explicitly include:

- checkpoint
- blocked
- deliverable_ready
- recovery
- resume packet

---

## 8. Borrowings from Oh My OpenAgent

Oh My OpenAgent is especially useful because it is closer to a harness/runtime than a pure framework paper.

### 8.1 What the source clearly gives us

#### A. Category-first delegation

OmO configuration centers on categories rather than raw model names:

- [docs/reference/configuration.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/oh-my-openagent/docs/reference/configuration.md#L282)

Borrowing:

- delegated worker selection should prefer category/role/profile thinking over ad-hoc model overrides

This matches the current OctoClaw direction:

- route
- delegate_role
- complexity
- model_profile

#### B. Background task concurrency and stale timeout

Public OmO docs expose:

- `defaultConcurrency`
- `providerConcurrency`
- `modelConcurrency`
- `staleTimeoutMs`

See:

- [Oh My OpenAgent docs](https://ohmyopenagent.com/docs)

Borrowing:

- even single delegate should have explicit concurrency and stale timeout gates
- timeout should be tied to actual activity, not only wall-clock duration

#### C. Parent-linked subagent session creation

The background agent spawner creates a child session explicitly linked to the parent:

- [background-agent/spawner.ts](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/oh-my-openagent/src/features/background-agent/spawner.ts#L87)
- [background-agent/spawner.ts](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/oh-my-openagent/src/features/background-agent/spawner.ts#L96)
- [background-agent/spawner.ts](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/oh-my-openagent/src/features/background-agent/spawner.ts#L140)
- [background-agent/spawner.ts](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/oh-my-openagent/src/features/background-agent/spawner.ts#L218)

Borrowing:

- child session identity should be explicit
- child should carry parent linkage
- resume should work on a stored child session, not a brand-new interpretation of the original request

#### D. Session state classification includes retry/running/busy

OmO has a small but important session status classifier:

- [session-status-classifier.ts](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/oh-my-openagent/src/features/background-agent/session-status-classifier.ts#L1)

Borrowing:

- runtime should distinguish active/retrying/running states rather than collapsing all "not done" states together

#### E. Circuit-breaker mindset for background loops

Its background manager tests show explicit loop/circuit-breaker thinking:

- [manager-circuit-breaker.test.ts](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/oh-my-openagent/src/features/background-agent/manager-circuit-breaker.test.ts#L42)

Borrowing:

- repeated retries should not be infinite
- recovery should have caps, loop detection, and parent notification

### 8.2 What not to borrow

1. do not absorb a huge hooks surface into OctoClaw core
2. do not make background tasks a second hidden orchestration system
3. do not let category routing silently replace explicit policy spec

### 8.3 Design consequence

From OmO, OctoClaw should borrow:

1. concurrency gates
2. stale timeout
3. child-parent session linkage
4. activity-aware recovery
5. circuit-breaker style retry limits

These belong in runtime/recovery, not in route semantics.

---

## 9. Borrowings from Hermes Agent

Hermes matters less for task DAG semantics and more for continuity and session lifecycle.

### 9.1 What the source clearly gives us

Hermes release notes highlight:

- inactivity-based timeouts tied to actual activity rather than wall clock
- subagent sessions linked to parent
- shared thread sessions
- session lifecycle hooks

See:

- [RELEASE_v0.8.0.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/hermes-agent/RELEASE_v0.8.0.md#L21)
- [RELEASE_v0.8.0.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/hermes-agent/RELEASE_v0.8.0.md#L91)
- [RELEASE_v0.8.0.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/hermes-agent/RELEASE_v0.8.0.md#L113)
- [RELEASE_v0.8.0.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/hermes-agent/RELEASE_v0.8.0.md#L254)

Borrowing:

1. timeouts should consider activity
2. child session should link to parent session
3. session finalize/reset hooks are useful seams
4. continuity across CLI and gateway is valuable

### 9.2 What not to borrow

1. do not move long-term memory into route authority
2. do not import a self-improving learning loop into hot path
3. do not let session continuity become another hidden truth source

### 9.3 Design consequence

Hermes reinforces the need for:

1. explicit session lifecycle hooks
2. activity-aware stale detection
3. parent-child linkage for delegated work
4. durable but compact resume packets

---

## 10. Borrowings from open-multi-agent

open-multi-agent is the most relevant reference for future controlled multi-agent execution.

### 10.1 What the public implementation says

Its README is explicit:

- the coordinator decomposes a goal into a task DAG
- the task queue runs independent tasks in parallel
- failures cascade to dependents
- teams can mix models/providers
- persistence/checkpointing is intentionally not built in

See:

- [open-multi-agent README](https://github.com/JackChen-me/open-multi-agent)

### 10.2 What to borrow

1. task DAG as a runtime/scheduler concept
2. independent-task parallel execution
3. dependency-aware cascade failure
4. coordinator decomposition as a model-assisted step

### 10.3 What not to borrow

1. do not copy its lack of persistence/checkpointing
2. do not drop native substrate truth in favor of an in-memory orchestration-only runtime
3. do not let future multi-agent replace the single delegate foundation

### 10.4 Design consequence

For OctoClaw, the right reading is:

- model can help decide whether a task is worth splitting
- scheduler must decide whether the split can run in parallel
- native flow/task and OctoClaw recovery/status layers must remain the durable truth

In other words:

> open-multi-agent is a good decomposition and DAG reference, but not a persistence/runtime truth reference.

---

## 11. Borrowings from Get Shit Done, Bernstein, and GitHub's engineering guidance

These are not the main runtime substrates, but they reinforce important guardrails.

### 11.1 Get Shit Done

The strongest recurring lesson is:

- phase boundaries
- explicit plan/validate/revise discipline
- context packs instead of transcript bloat

Borrowing:

- retries and revisions should pass through explicit gates
- child retries should not become uncontrolled self-loops

### 11.2 Bernstein

The most relevant pattern is:

- short-lived agents
- deterministic scheduling
- worktree isolation
- verification before landing

Borrowing:

- success should include verification, not just agent self-report
- workspace isolation belongs in runtime/workspace mode, not in route labels

### 11.3 GitHub engineering note

GitHub's 2026 note emphasizes that multi-agent failures mostly come from missing structure rather than missing model capability.

See:

- [GitHub blog: multi-agent workflows often fail](https://github.blog/ai-and-ml/generative-ai/multi-agent-workflows-often-fail-heres-how-to-engineer-ones-that-dont/)

Borrowing:

- structure first
- explicit ordering / validation / state boundaries
- avoid assuming models alone will keep related tasks coordinated

### 11.4 Status visualization and operator surface

The source projects we studied do not share one universal UI, but they do share a strong pattern:

> **agent systems become unmanageable when runtime truth exists but is not projected into a stable operator-facing status surface.**

The most relevant borrowings are:

#### A. ClawTeam: board / task status / owner visibility

ClawTeam explicitly exposes:

- `team status`
- `task list`
- `board show`
- task owner / task status / blocked state / in-progress counts

See for example:

- [cli/commands.py](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/clawteam/cli/commands.py#L516)
- [cli/commands.py](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/clawteam/cli/commands.py#L884)
- [cli/commands.py](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/clawteam/cli/commands.py#L1147)
- [templates/hedge-fund.toml](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/clawteam/templates/hedge-fund.toml#L16)

Borrowing:

1. operator surfaces should not be "developer only"
2. queue / blocked / owner / in-progress counts should be first-class
3. a board/list mental model is useful, even before a rich UI exists

#### B. Hermes: background status, delivery tracking, notifications

Hermes release notes show several status-surface ideas that matter a lot:

- full session id in `/status`
- delivery failure tracking in job status
- notification when background processes complete
- shared thread sessions and subagent linkage

See:

- [RELEASE_v0.8.0.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/hermes-agent/RELEASE_v0.8.0.md#L91)
- [RELEASE_v0.8.0.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/hermes-agent/RELEASE_v0.8.0.md#L118)
- [RELEASE_v0.8.0.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/hermes-agent/RELEASE_v0.8.0.md#L202)
- [RELEASE_v0.8.0.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/hermes-agent/RELEASE_v0.8.0.md#L216)

Borrowing:

1. status is not only pull-based; it should also support proactive completion/failure notification
2. status should include session linkage and delivery outcome, not only task state
3. background tasks need explicit user-visible completion semantics

#### C. Oh My OpenAgent: background session states and stale/runtime health

Oh My OpenAgent is valuable less for a polished UI and more for runtime-facing status classification:

- background task concurrency
- session status classification
- retry / resume logic
- stale timeout / background recovery hooks

See:

- [docs/reference/configuration.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/oh-my-openagent/docs/reference/configuration.md#L282)
- [spawner.ts](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/oh-my-openagent/src/features/background-agent/spawner.ts#L140)
- [spawner.ts](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/oh-my-openagent/src/features/background-agent/spawner.ts#L218)
- [session-status-classifier.ts](/Users/guanzhicheng/Documents/Playground/openclaw-projects/_source_refs/oh-my-openagent/src/features/background-agent/session-status-classifier.ts#L1)

Borrowing:

1. status surfaces should expose whether work is running, retrying, stale, resumable, or backgrounded
2. timeouts and stale detection belong in the visible state model, not only internal logs
3. "background but alive" and "background but stale" must be visibly different

#### D. DeerFlow: evented progression over final-state-only thinking

From DeerFlow, the strongest lesson is still:

- progression should be evented
- checkpoint / deliverable-ready matters
- transcript is not status truth

Borrowing:

1. timeline should be a first-class surface, not a debug-only afterthought
2. "checkpoint emitted" and "deliverable ready" are status facts, not just internal implementation details
3. future UI should be able to replay task progression from structured events

### 11.5 Design consequence

For OctoClaw, these borrowings imply:

1. `status/details/queue/timeline/attempts` should be formal product surfaces
2. user surface, main-agent query surface, and operator surface should all project from the same runtime truth
3. future richer UI should reuse the same view model rather than inventing another task truth
4. child status visibility is a first-class requirement even for single delegate, not just for future multi-agent

---

## 12. What this means for single delegate right now

The design consequence for v1 is very concrete.

### 12.1 Single delegate must include all of the following

1. explicit `delegate_task`
2. explicit `delegate_attempt`
3. explicit mapping to `native_flow_id` and `native_task_id`
4. explicit handoff packet
5. explicit checkpoint/progress events
6. explicit timeout categories
7. explicit recovery taxonomy
8. explicit resume packet to main thread
9. explicit status/timeline projection
10. explicit attempts/operator view model

### 12.2 Success must mean more than "worker exited 0"

At minimum:

1. attempt terminal success
2. acceptance/validation pass
3. delivery or artifact handoff complete
4. no unresolved waiting-input/recovery condition

### 12.3 Retry must not create a new user-visible task each time

Retry may create:

- a new attempt
- a new native task
- sometimes even a new native flow

But the user-facing delegated work should still be one `delegate_task`.

---

## 13. What this means for future multi-agent

Multi-agent should extend, not replace, this structure.

### 13.1 Top-level route should remain stable

Keep:

- `reply`
- `delegate`

Then extend under:

- `coordination_mode = solo_worker | advisor_assisted | multi_agent_controlled`

### 13.2 Multi-agent should reuse the single delegate substrate

That means:

1. `delegate task` still exists
2. it may bind to one native flow with multiple native child tasks
3. the scheduler may materialize a DAG under that flow
4. attempts and recovery still exist
5. status/timeline still project from runtime truth

### 13.3 Parallelism should be model-assisted but scheduler-enforced

Borrowed pattern:

- model hints whether decomposition is worthwhile
- scheduler enforces dependency, write scope, queue pressure, budget, and max parallelism

This is the same conclusion already reflected in `design-v1`, and it is consistent with:

- ClawTeam-OpenClaw
- open-multi-agent
- GitHub's structure-first guidance

---

## 14. What not to borrow, even if it looks attractive

There are several tempting moves that would likely make OctoClaw worse.

1. **Do not make tmux or swarm runtime the default execution substrate.**
2. **Do not replace native flow/task with another task truth store.**
3. **Do not let child workers own recovery policy.**
4. **Do not push all ambiguity into the main agent.**
5. **Do not let retry loops grow without caps, loop detection, and lineage.**
6. **Do not feed full transcript/logs to every child.**
7. **Do not treat multi-agent as a prerequisite for solving single delegate lifecycle problems.**
8. **Do not collapse route, role, workspace, backend, and coordination into one black-box model decision.**

---

## 15. Recommended implementation order

This should be the next-order implementation sequence, consistent with both the source borrowings and the rebuild plan.

### Phase A: single delegate durability first

1. delegate task <-> native flow/task binding
2. attempt lineage
3. checkpoint / progress / deliverable-ready events
4. timeout categories
5. recovery taxonomy
6. main-thread resume packet
7. status/details/queue/timeline projection

### Phase B: context and session continuity

1. typed handoff packet
2. artifact refs as first-class input
3. session/parent-child linkage
4. recovery-driven resume

### Phase C: controlled multi-agent

1. coordinator decomposition hint
2. scheduler DAG materialization
3. dependency-aware parallel execution
4. failure cascade
5. one-level controlled hierarchy only

This order matters because:

> If single delegate lifecycle truth is weak, multi-agent will only multiply uncertainty and debugging cost.

---

## 16. Final decision summary

If we compress everything into one final implementation stance, it should be this:

1. **Borrow native execution truth from OpenClaw.**
2. **Borrow ownership, session persistence, and worktree isolation from ClawTeam.**
3. **Borrow evented progression, artifact readiness, and state-vs-transcript discipline from DeerFlow.**
4. **Borrow activity-aware timeout, background concurrency, and child-session linkage from OmO and Hermes.**
5. **Borrow decomposition/DAG ideas from open-multi-agent, but only after single delegate is stable.**
6. **Borrow structure-first guardrails from GitHub/GSD/Bernstein, not free-form autonomous loops.**

The resulting OctoClaw architecture should be:

> **OpenClaw native `task/flow` as execution truth; OctoClaw as policy, projection, delivery, and recovery layer; single delegate as the stable foundation; controlled multi-agent as a later extension over the same substrate.**
