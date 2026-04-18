# Phase 5 Context: Execution Substrate Refactor

## Why this phase exists

Phase 1-4 completed the local rebuild baseline alignment, TS-first policy core, native-truth adapter seam, substrate-first projections, and gated advanced-routing contracts. However, recent live-path validation on the deployed macmini instance showed that the formal execution path still does not match the rebuild baseline captured in the canonical TS design and implementation plan dated 2026-04-15.

The critical failure was not a policy-routing miss. The system correctly judged an explicitly delegated command request as `spawn_single`, but the live delegation path still flowed through `lib/octoclaw_spawn.py`, which generated a shell wrapper containing `export PATH=...:$PATH`. OpenClaw exec preflight rejected that wrapper as likely shell-variable injection, so the delegated task never materialized and the main session executed the command directly. This proves the current execution substrate is still anchored to legacy Python/shell live-path helpers even though the formal design says it should not be.

## Canonical architecture baseline to align with

The authoritative design documents are on remote branch `origin/codex/docs-ts-rebuild-plan-2026-04-15`:

- `docs/octoclaw-ts-rebuild-design-v1.md`
- `docs/octoclaw-ts-rebuild-implementation-plan-2026-04-15.md`

Those documents explicitly lock the following constraints:

1. Formal product code is rewritten in TypeScript.
2. Python remains only for tests, ops scripts, one-off migration tools, and temporary analysis tools.
3. OpenClaw native task/flow becomes the execution truth plane.
4. Plugin/runtime-first integration is the primary architecture; CLI create is not the required control plane.
5. The execution/workflow plane is rebuilt around contracts, runtime-core orchestration, native task/flow truth, and substrate-first lifecycle handling.
6. Truth, projection, artifact, and telemetry stay as separate planes.

These points mean the Phase 5 problem is not "migrate old Python files to TS one by one." It is "finish the execution/workflow plane refactor so the shipped live path actually follows the formal TypeScript-first architecture."

## What is still wrong in the live path

The runtime extension still shells out to Python for core execution duties:

- `extensions/octoclaw-runtime/index.js` -> `dispatch_task.py`
- `extensions/octoclaw-runtime/index.js` -> `octoclaw_spawn.py`
- `extensions/octoclaw-runtime/index.js` -> `task-state-update.py`

The runner plane still depends on legacy Python/shell substrate:

- `lib/runner_queue.py`
- `lib/runner_loop.sh`
- `lib/runner_dispatch.py`

These are not test-only compatibility paths. They are active runtime dependencies. By the canonical design baseline, that means the execution substrate refactor is unfinished.

## What this phase is and is not

### This phase IS

- A formal execution/workflow plane refactor aligned to the TS rebuild design.
- A redesign of execution orchestration, task lifecycle truth, spawn substrate, runner substrate, and status-facing execution facts around TypeScript runtime-core and OpenClaw native task/flow truth.
- The phase that removes Python/shell from the live execution path, not just from design intent.

### This phase is NOT

- A file-by-file translation of `dispatch_task.py`, `octoclaw_spawn.py`, or `runner_queue.py` into TypeScript clones.
- A compatibility patch pass that keeps old CLI/script boundaries and merely changes language.
- A reintroduction of JSON files or helper scripts as formal execution truth.

## Target architecture for this phase

Phase 5 should complete the execution substrate around these module boundaries implied by the main design and implementation plan:

1. **Execution Orchestrator**
   - Consumes validated route decisions/work contracts.
   - Owns direct/runner/spawn materialization flow.
   - Does not shell out to Python dispatch or spawn scripts.

2. **Task Lifecycle Store**
   - Owns task registration, checkpoints, heartbeats, completion, failure, and artifact attachment.
   - Replaces `task-state-update.py` as a live-path authority.
   - Keeps truth/projection/artifact/telemetry separated.

3. **Spawn Substrate**
   - Materializes delegated subagent work through plugin/runtime-first OpenClaw-native seams.
   - Replaces `octoclaw_spawn.py` as a live-path authority.
   - Must not rely on shell wrappers to create delegated work.

4. **Runner Substrate**
   - Owns runner admission, lease/claim/heartbeat, bounded worker execution, and result materialization.
   - Replaces `runner_queue.py` and `runner_loop.sh` as live-path authorities.
   - Can still support daemon and on-demand modes, but the formal implementation is TS runtime code.

5. **Status/Observer Read Model**
   - Reads new lifecycle/native truth instead of legacy Python-owned state files.
   - Must remain projection-only and never become a second truth authority.

## Architecture alignment constraints carried from earlier phases

From Phase 2:

- Runtime ownership belongs in TS runtime-core, not Python dispatch or task-event glue.
- Delegation materialization carries explicit `readScope`, `writeScope`, and `workspaceMode`.
- Claims, deadlines, delivery state, and backpressure are first-class runtime requirements.

From Phase 3:

- OpenClaw native task/flow APIs are the formal truth plane.
- The wrapper/plugin seam must not fabricate a second truth authority.
- Projections and IM surfaces consume shared projection facts rather than reconstructing truth.

From Phase 4:

- Route decisions, judge outputs, compound plans, and recommendations are validated contracts.
- Advanced routing must fail closed or degrade safely before execution.
- Auto-router remains a read-only contract consumer, not a second orchestrator.

Phase 5 therefore cannot regress by reintroducing Python live-path authority under a new wrapper.

## Refactor objective

Rebuild the live execution/workflow plane so that:

1. Delegated task materialization follows validated policy decisions through TypeScript runtime-core and native task/flow adapters.
2. No live execution route from the shipped runtime extension requires Python or shell scripts except for explicitly out-of-scope ops/test tooling.
3. Runner, spawn, and lifecycle truth are substrate-first and contract-driven rather than file-script-driven.
4. The shipped behavior finally matches the canonical 2026-04-15 TS rebuild design.
