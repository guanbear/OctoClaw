---
phase: 05-execution-substrate-refactor
plan: 01
type: execute
wave: 3
depends_on:
  - 03-01
  - 04-03
files_modified:
  - .planning/ROADMAP.md
  - .planning/REQUIREMENTS.md
  - .planning/STATE.md
  - .planning/phases/05-execution-substrate-refactor/05-CONTEXT.md
  - .planning/phases/05-execution-substrate-refactor/05-PLAN.md
  - .planning/phases/05-execution-substrate-refactor/05-01-PLAN.md
autonomous: true
requirements:
  - RT-02
must_haves:
  truths:
    - "The live execution path no longer depends on Python or shell scripts as formal authorities for dispatch, spawn, runner lifecycle, or task-state writes."
    - "Execution truth flows through TypeScript runtime-core and OpenClaw native task/flow truth rather than legacy JSON/script ownership."
    - "The refactor follows the 2026-04-15 TS rebuild design and implementation plan, not the legacy script/module boundaries."
  artifacts:
    - path: ".planning/phases/05-execution-substrate-refactor/05-CONTEXT.md"
      provides: "Design-aligned execution substrate refactor rationale and boundaries"
    - path: "packages/octoclaw-runtime-core"
      provides: "Formal TS execution/workflow orchestration and lifecycle ownership"
    - path: "extensions/octoclaw-runtime/src"
      provides: "Plugin/runtime-first execution adapters that replace Python live-path helpers"
  key_links:
    - from: "extensions/octoclaw-runtime/index.js"
      to: "packages/octoclaw-runtime-core"
      via: "formal direct/runner/spawn execution orchestration"
      pattern: "dispatch|spawn|task-state|runner"
    - from: "packages/octoclaw-runtime-core"
      to: "extensions/octoclaw-runtime/src/adapter/runtime-taskflow.ts"
      via: "OpenClaw native task/flow truth seam"
      pattern: "bindSession|createManaged|runTask"
---

<objective>
Finish the TS rebuild by refactoring the live execution/workflow plane to match the canonical 2026-04-15 design: plugin/runtime-first, OpenClaw native task/flow truth, and no Python/shell authority in the formal live path.

Purpose: Replace the remaining Python/shell execution substrate instead of translating legacy scripts line-by-line, so the shipped runtime finally matches the architecture already locked in the main design and implementation plan.
Output: A formal execution substrate refactor plan that rebuilds orchestration, task lifecycle, spawn, runner, and status-truth integration around current TS contracts and native substrate truth.
</objective>

<context>
- `origin/codex/docs-ts-rebuild-plan-2026-04-15:docs/octoclaw-ts-rebuild-design-v1.md`
- `origin/codex/docs-ts-rebuild-plan-2026-04-15:docs/octoclaw-ts-rebuild-implementation-plan-2026-04-15.md`
- `.planning/ROADMAP.md`
- `.planning/REQUIREMENTS.md`
- `.planning/STATE.md`
- `.planning/phases/02-runtime-core-and-safe-delegation/02-02-SUMMARY.md`
- `.planning/phases/03-native-substrate-and-operator-surfaces/03-01-PLAN.md`
- `.planning/phases/03-native-substrate-and-operator-surfaces/03-03-SUMMARY.md`
- `.planning/phases/04-eval-gates-and-advanced-routing/04-03-SUMMARY.md`
- `extensions/octoclaw-runtime/index.js`
- `packages/octoclaw-runtime-core/`
- `extensions/octoclaw-runtime/src/`
</context>

<tasks>

<task type="planning">
  <name>Task 0: Stage the refactor through contract-first execution plans</name>
  <files>.planning/phases/05-execution-substrate-refactor/05-01-PLAN.md</files>
  <action>Break the execution substrate refactor into contract-first executable plans. The first plan must define the canonical execution orchestrator and lifecycle contracts before any live-path cutover work begins, so implementation follows the new architecture instead of migrating script boundaries forward.</action>
  <done>Phase 5 starts with a contract-first plan that anchors later live-path replacement work.</done>
</task>

<task type="research+design">
  <name>Task 1: Redefine the execution/workflow plane around current TS contracts and native truth</name>
  <files>.planning/phases/05-execution-substrate-refactor/05-CONTEXT.md, packages/octoclaw-runtime-core, extensions/octoclaw-runtime/src</files>
  <action>Define the formal execution orchestrator, task lifecycle store, spawn substrate, runner substrate, and observer/status truth interfaces around the current TypeScript runtime-core and OpenClaw native task/flow seam. Treat the old Python script boundaries as obsolete references only. Explicitly align with the design doc's Interaction/Policy Plane, Execution/Workflow Plane, and Truth/Projection/Artifact/Telemetry separation. Do not allow the new module boundaries to inherit the old CLI/script contract surface as the long-term architecture.</action>
  <done>The execution refactor has a design-aligned target module map and contract vocabulary that replaces legacy script-driven ownership.</done>
</task>

<task type="execute" tdd="true">
  <name>Task 2: Replace Python live-path authorities with TS runtime orchestration seams</name>
  <files>extensions/octoclaw-runtime/index.js, packages/octoclaw-runtime-core, extensions/octoclaw-runtime/src, tests/</files>
  <action>Cut the shipped runtime extension over to TypeScript-native execution orchestration. Remove Python/shell authority from direct dispatch, spawn materialization, runner queue/heartbeat, and task lifecycle write paths. Any transitional compatibility layer must be strictly out of the live authority path and must not own truth, orchestration, or execution status. Preserve validation-first execution semantics from Phase 4 and substrate-first truth semantics from Phase 3 while rebuilding the execution substrate around current TS contracts.</action>
  <acceptance_criteria>
    <criterion>The shipped runtime extension no longer shells out to `dispatch_task.py`, `octoclaw_spawn.py`, or `task-state-update.py` for formal live execution.</criterion>
    <criterion>Runner daemon or on-demand execution no longer depends on `runner_loop.sh` or `runner_queue.py` as formal runtime authorities.</criterion>
    <criterion>Delegated spawn requests that resolve to `spawn_single` or `spawn_multi` materialize through the TS/native runtime path without shell wrapper generation.</criterion>
    <criterion>Task lifecycle truth and execution provenance are emitted from the TS substrate and remain separate from projection and telemetry payloads.</criterion>
  </acceptance_criteria>
  <done>The formal live execution path is TS-native and matches the canonical rebuild design rather than the legacy script architecture.</done>
</task>

<task type="verification">
  <name>Task 3: Prove the refactor with live-path acceptance and no-Python-authority checks</name>
  <files>tests/, packages/octoclaw-evals, .planning/phases/05-execution-substrate-refactor</files>
  <action>Expand or add verification that catches the specific failure mode already seen in production-like use: route judged as delegated, but materialization falls back to Python/script glue and fails before native task creation. Include focused acceptance that a delegated request judged as `spawn_single` or `runner` actually produces native execution or explicit fail-closed TS-native errors, never shell-wrapper preflight failures. Add checks proving Python remains only in tests/ops/migration scopes and not as live execution authority.</action>
  <done>The execution substrate refactor has proof that delegated routes really materialize through TS/native runtime paths and that Python no longer owns live execution authority.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| policy decision -> execution orchestrator | Validated route/work-contract output enters formal execution authority |
| TS lifecycle store -> status/projection surfaces | Execution truth becomes read models without reintroducing a second truth authority |
| native task/flow substrate -> delegated delivery/status surfaces | Native truth is transformed into projection/artifact/telemetry planes |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-05-01 | T | `extensions/octoclaw-runtime/index.js` | mitigate | Remove Python script authority from live execution calls; force all live execution through TS orchestration seams. |
| T-05-02 | E | runner/spawn substrate | mitigate | Replace shell/Python runner and spawn control paths with TS-native orchestration and fail-closed validation. |
| T-05-03 | I | lifecycle/projection separation | mitigate | Keep task/flow truth separate from projection/artifact/telemetry stores so operator or IM reads cannot overwrite execution truth. |
| T-05-04 | D | delegated materialization | mitigate | Add acceptance that delegated routes materialize natively or fail closed without falling back to wrapper scripts or unsafe direct execution. |
</threat_model>

<verification>
- Focused runtime-extension and delegated-materialization acceptance proving no live execution authority remains in Python/shell.
- Live-path smoke on deployed OpenClaw instance showing delegated requests materialize natively or fail closed with TS-owned errors.
- Structural check that shipped runtime extension no longer invokes legacy Python live-path scripts for formal execution.
</verification>

<success_criteria>
- Formal live execution no longer depends on Python/sh authorities.
- Native task/flow truth and TS lifecycle orchestration own execution status and provenance.
- Delegated spawn and runner flows reflect the canonical TS rebuild design instead of legacy script glue.
</success_criteria>

<output>
After completion, create `.planning/phases/05-execution-substrate-refactor/05-SUMMARY.md` and update roadmap/state/requirements to reflect the execution substrate cutover.
</output>
