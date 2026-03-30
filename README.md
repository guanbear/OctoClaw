# 🐙 OctoClaw v1.5.0

English | [简体中文](./README.zh-CN.md)

![OctoClaw banner](./banner.png)

> A cost-sensitive multi-agent orchestration layer for OpenClaw.

OctoClaw is built for three things:

- lower cost through role-aware model routing
- faster response through a persistent runner and async workers
- better reliability through patrol, session awareness, and self-healing

Recommended operator setup for the unified runtime direction:

- `SUPERVISOR_MODE=tmux`
- one fixed `tmux` slot for `runner-daemon`
- one fixed `tmux` slot for `patrol-loop`
- later attach ClawTeam task/inbox/board on top of the same workbench

---

## Why OctoClaw

OctoClaw is not just a proxy router and not just an agent template.

It sits between the main OpenClaw agent and sub-agents, then handles:

- task decomposition and role assignment
- role-aware model selection
- a runner fast path for lightweight shell / API / status work
- patrol-based recovery and redispatch
- text-first status rendering for non-card environments

## Core Features

- Runtime policy decision entry: [`octoclaw_policy.py`](./lib/octoclaw_policy.py)
- Route decision entry: [`octoclaw_route.py`](./lib/octoclaw_route.py)
- Unified dispatch entry: [`dispatch_task.py`](./lib/dispatch_task.py)
- Generic runner playbooks: [`runner_playbooks.py`](./lib/runner_playbooks.py)
- Runtime extension tools:
  - `octoclaw_policy_decide`
  - `octoclaw_route`
  - `octoclaw_route_hint`
  - `octoclaw_dispatch`
  - `octoclaw_status`
- Persistent runner:
  - [`runner-daemon.sh`](./lib/runner-daemon.sh)
  - [`runner_dispatch.py`](./lib/runner_dispatch.py)
  - [`runner_queue.py`](./lib/runner_queue.py)
  - per-job fresh shell execution with worker recycling by jobs / age / idle
- Session-aware patrol: [`patrol.py`](./lib/patrol.py)
- Text status views: [`status.sh`](./lib/status.sh)
- Minimal replay/eval harness: [`eval_suite.py`](./lib/eval_suite.py)

Recent design notes worth reading before deeper runtime changes:

- [octoclaw-state-machine-remediation-v1-2026-03-29.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus/octoclaw-state-machine-remediation-v1-2026-03-29.md)
- [octoclaw-clawteam-deerflow-source-notes-v1-2026-03-29.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus/octoclaw-clawteam-deerflow-source-notes-v1-2026-03-29.md)
- [octoclaw-anthropic-agent-engineering-notes-v1-2026-03-30.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus/octoclaw-anthropic-agent-engineering-notes-v1-2026-03-30.md)

Recent runtime slices now also land two DeerFlow/ClawTeam-inspired observability primitives:

- delegated task event log: `/workspace/tmp/octopus/task-events.jsonl`
- persistent IM thread map: `/workspace/tmp/octopus/session-thread-map.json`

OctoClaw uses them to keep `task-state`, task anchors, patrol notifications, and IM follow-ups aligned around:

- `lifecycle_state`
- `outcome_state`
- `handoff_state`
- `session_key` / `session_target` / `session_thread_key`

The next source-backed borrowings from ClawTeam and DeerFlow are still the right track, but Anthropic's official guidance suggests doing them in this order:

1. richer delegated task events
   status: landed
2. harder IM thread/topic binding
   status: landed (baseline thread-truth and anchor reuse)
3. ownership lock plus dead-agent recovery
4. delegated worker session resume
5. artifact index and retrieval
6. todo/checklist persistence across context loss

In other words:

- first harden delegated runtime truth and continuity
- then improve artifact retrieval
- then add stronger context-persistence layers

## Model Selection

OctoClaw now treats `auto` as the default, policy-first mode:

- primary selectors are `worker_pool / phase / profile / route`
- `model-policy.json` is the source of truth when available
- `octoclaw-mode.json` only keeps `auto` and `custom`

## Quick Start

```bash
bash /workspace/openclaw/skills/octopus/install.sh
```

For source-managed installs and upgrades, prefer the new manager entry:

```bash
bash /workspace/openclaw/skills/octopus/bin/octoclaw-manage.sh install
```

That flow keeps a tracked source checkout under `/workspace/openclaw/repos/octoclaw`, syncs the runtime skill directory, then runs `install.sh reconcile`.

Recommended minimal open-source path:

1. Install the skill
2. Keep notifications on `auto` or `none`
3. Prefer `SUPERVISOR_MODE=tmux` and let `runner-daemon` / `patrol-loop` run in tmux
4. Enable the bundled runtime extension from `extensions/octoclaw-runtime`
5. Treat `direct` as a whitelist: only `hard_runner_only` is pre-cut by code; all other ambiguous work should submit `octoclaw_route_hint`, then let runtime policy merge and enforce dispatch
6. Treat `system_preferred_route` as a starting bias, not the final answer; the final route may change after main-brain hint merge or sticky lane reuse on follow-up work
7. Use sticky lane conservatively: once a session enters `spawn_single` or `spawn_multi`, follow-up prompts like “继续 / next step / 再查一下 / add tests” can stay on the same lane without re-discovering the whole topology
8. Use `status.sh --format table` to inspect state
9. Run `eval_suite.py` once to establish a baseline

Recommended gradual rollout switches in `tmp/octoclaw-config.json`:

```json
{
  "runtime_policy": {
    "enabled": true,
    "switches": {
      "hard_runner_only": true,
      "route_hint_required": true,
      "replay_logging": true,
      "direct_model_override": true,
      "delegation_enforcement": true
    },
    "route_stickiness": {
      "enabled": true,
      "ttl_minutes": 180,
      "apply_on_followup_only": true
    },
    "route_language_packs": {
      "enabled": ["zh", "en"],
      "available": ["zh", "en", "ja", "ko", "es", "pt", "ru"]
    },
    "hooks": {
      "before_model_resolve": true,
      "before_prompt_build": true,
      "before_tool_call": true,
      "agent_end": true
    }
  }
}
```

Route-language packs are intentionally conservative:

- default is `zh + en`
- optional packs are `ja / ko / es / pt / ru`
- command-style common patterns still stay loaded for everyone
- install/setup flows can enable extra packs later without making the default router noisier

Example: turn on Japanese and Spanish only when you actually need them

```json
{
  "runtime_policy": {
    "route_language_packs": {
      "enabled": ["zh", "en", "ja", "es"]
    }
  }
}
```

Or apply the same override directly during rollout:

```bash
bash /workspace/openclaw/skills/octopus/bin/runtime-policy-rollout.sh install --preset conservative --route-language-packs zh,en,ja,es
```

Suggested rollout presets for `bin/runtime-policy-rollout.sh`:

- `RUNTIME_POLICY_PRESET=conservative`
  - installs a real extension directory into `~/.openclaw/extensions/octoclaw-runtime`
  - keeps replay on
  - disables route-hint enforcement and delegation hard blocks
- `RUNTIME_POLICY_PRESET=guided`
  - enables route-hint collection and prompt guidance
  - keeps direct model override and hard delegation enforcement off
- `RUNTIME_POLICY_PRESET=enforced`
  - enables the full runtime-policy path, including delegation enforcement
  - best used only after replay validation

## Common Commands

```bash
# Source-managed install / update
bash /workspace/openclaw/skills/octopus/bin/octoclaw-manage.sh install
bash /workspace/openclaw/skills/octopus/bin/octoclaw-manage.sh update
bash /workspace/openclaw/skills/octopus/bin/octoclaw-manage.sh status

# Reconcile a local checked-out tree without prompts
bash /workspace/openclaw/skills/octopus/install.sh reconcile --non-interactive --extension-install-mode rsync

# Sync guanzhicheng.com from the tracked VM clone into the runtime directories
bash /workspace/openclaw/skills/octopus/bin/deploy-guanzhicheng-vm.sh

# Runtime extension install target
ls ~/.openclaw/extensions/octoclaw-runtime

# Recommended no-systemd supervisor mode
SUPERVISOR_MODE=tmux PATROL_MODE=loop bash /workspace/openclaw/skills/octopus/install.sh

# Conservative runtime-policy rollout
bash /workspace/openclaw/skills/octopus/bin/runtime-policy-rollout.sh install --preset conservative

# Guided runtime-policy rollout
bash /workspace/openclaw/skills/octopus/bin/runtime-policy-rollout.sh install --preset guided

# Fully enforced runtime-policy rollout
bash /workspace/openclaw/skills/octopus/bin/runtime-policy-rollout.sh install --preset enforced

# Attach to the OctoClaw tmux workbench
tmux attach -t octoclaw-runtime

# In OpenClaw, prefer these tools when available:
# octoclaw_policy_decide
# octoclaw_route
# octoclaw_route_hint
# octoclaw_dispatch
# octoclaw_status

# Runtime policy decision object
python3 /workspace/openclaw/skills/octopus/lib/octoclaw_policy.py --task 'compare these two services and decide whether to delegate'

# Main-brain route hint merge
python3 /workspace/openclaw/skills/octopus/lib/octoclaw_policy.py --task 'look at the nginx error log and summarize the likely cause' --route-hint-json '{"route_hint":"spawn_single","work_type":"research","phase":"inspect","review_required":false,"confidence":0.78,"reason":"needs log reading plus reasoning","source":"main_agent"}'

# Inspect the system preferred route first
python3 /workspace/openclaw/skills/octopus/lib/octoclaw_route.py --task 'analyze this error and give me a fix plan'

# Unified dispatch entry
python3 /workspace/openclaw/skills/octopus/lib/dispatch_task.py --task 'check redis logs and port status' --command 'ss -lntp | grep 6379'

# Natural-language local inspection can be dispatched directly
python3 /workspace/openclaw/skills/octopus/lib/dispatch_task.py --task 'check the machine python version, disk usage, and memory status, then summarize it'

# Dispatch a lightweight job directly to runner
python3 /workspace/openclaw/skills/octopus/lib/runner_dispatch.py --command 'pwd' --summary 'check current directory'

# Status views
bash /workspace/openclaw/skills/octopus/lib/status.sh --format table
bash /workspace/openclaw/skills/octopus/lib/status.sh --format lanes

# Status view now includes replay-based promotion hints when runtime-policy replay is enabled
bash /workspace/openclaw/skills/octopus/lib/status.sh --format table

# Replay / eval
python3 /workspace/openclaw/skills/octopus/lib/eval_suite.py

# Runtime policy replay log
tail -n 30 /workspace/tmp/octopus/runtime-policy-replay.jsonl

# Summarize replay signals before promoting conservative -> guided
python3 /workspace/openclaw/skills/octopus/lib/replay_summary.py --phase conservative

# Summarize replay signals before promoting guided -> enforced
python3 /workspace/openclaw/skills/octopus/lib/replay_summary.py --phase guided

# Replay summaries also include worker_pool counts for taxonomy rollouts

# Review replay sessions before labeling or tuning routing rules
python3 /workspace/openclaw/skills/octopus/lib/replay_review.py --focus blocked

# Curate replay sessions into portable eval/review cases
python3 /workspace/openclaw/skills/octopus/lib/replay_curate.py --focus all --dedupe-by prompt --output /tmp/octoclaw-curated-cases.json

# Enable nightly replay automation (default is off)
bash /workspace/openclaw/skills/octopus/bin/replay-automation.sh enable --schedule-hour-local 2

# Enable the optional LLM review layer for nightly replay analysis
bash /workspace/openclaw/skills/octopus/bin/replay-automation.sh enable --llm-review-enabled true --llm-review-max-cases 24

# Run replay automation once manually
bash /workspace/openclaw/skills/octopus/bin/replay-automation.sh run --format text

# Render a cron command for nightly execution
bash /workspace/openclaw/skills/octopus/bin/replay-automation.sh render-cron

# Recommended: enable this only after conservative observation has started producing useful replay

# Replay event schema and sample fixtures
cat /workspace/openclaw/skills/octopus/schemas/runtime-policy-replay-event-v1.schema.json
cat /workspace/openclaw/skills/octopus/tests/fixtures/runtime-policy-replay-events-v1.json

# Sticky lane state for follow-up routing
cat /workspace/tmp/octopus/route-stickiness.json

# Force a patrol cycle
python3 /workspace/openclaw/skills/octopus/lib/patrol.py --force

# Disable runtime policy without uninstalling the extension
bash /workspace/openclaw/skills/octopus/bin/runtime-policy-rollout.sh disable

# Re-enable runtime policy after a paused rollout
bash /workspace/openclaw/skills/octopus/bin/runtime-policy-rollout.sh enable --preset guided

# Show the current runtime-policy config fragment
bash /workspace/openclaw/skills/octopus/bin/runtime-policy-rollout.sh show

# Check replay-based readiness using the current rollout phase
bash /workspace/openclaw/skills/octopus/bin/runtime-policy-rollout.sh check --format text

# Print a compact next-preset recommendation
bash /workspace/openclaw/skills/octopus/bin/runtime-policy-rollout.sh recommend --format text

# Uninstall runtime-policy rollout state and extension directory
bash /workspace/openclaw/skills/octopus/bin/runtime-policy-rollout.sh uninstall

```

## ClawTeam Bridge Validation

OctoClaw now includes an optional bridge layer with three modes:

- `mirror`: local ClawTeam-style mirror only
- `hybrid`: local mirror + optional CLI hooks
- `cli`: prefer CLI hooks while retaining mirror artifacts for observability

The bridge can mirror task updates into a minimal ClawTeam-style layout:

- tasks: `/workspace/tmp/octopus/clawteam-bridge/tasks`
- inbox: `/workspace/tmp/octopus/clawteam-bridge/inbox`
- events: `/workspace/tmp/octopus/clawteam-bridge/events`
- board: `/workspace/tmp/octopus/clawteam-bridge/board.json`

Unified runtime task records now carry enough lineage metadata for Phase 2 runtime convergence:

- `task_kind`: `subtask`, `team_parent`, `team_step`
- `parent_id` / `child_ids`
- normalized `route / runtime / executor_type / worker_pool / work_type / phase / protocol / artifacts`

Runner jobs now use the same record envelope as the rest of the unified runtime:

- `runner_dispatch.py` registers a normalized runtime task up front
- `runner_loop.sh` writes a shared markdown report plus structured runner result metadata
- `task-state.json`, bridge mirror, and handoff payloads all reuse the same `report_path / artifacts / summary`
- `artifacts.operator_surface` now carries operator-facing workbench hints, so `runner` / `spawn_single` / `spawn_multi` can expose the same tmux or ClawTeam runtime surface

When `spawn_multi` is used, the bridge board also emits `lineages` so operators can inspect the parent task and its DAG children from one place.
Those board briefs prefer `worker_pool` for display ownership, then fallback to legacy labels when a worker pool is unavailable.
When child steps move through `running / done / failed`, the `team_parent` record now auto-rolls up child status, step summaries, and step reports, then emits a parent-level result mail when the DAG finishes or fails.
`status.sh` now renders these parent/child relationships directly in `compact / table / lanes`, and also prints the current workbench mode / tmux session so you can inspect the unified runtime surface without manually opening `board.json`.

Enable it in `tmp/octoclaw-config.json`:

```json
{
  "clawteam_bridge": {
    "enabled": true,
    "backend": "hybrid",
    "team_name": "octoclaw-validation",
    "inbox_owner": "main",
    "emit_result_mail": true,
    "clawteam_bin": "clawteam",
    "clawteam_data_dir": "",
    "auto_create_team": true
  },
  "spawn_execution": {
    "enabled": true,
    "backend": "clawteam",
    "backend_name": "tmux",
    "workspace": false,
    "default_profile": "",
    "profile_by_model_prefix": {
      "omniroute/cx/": "coding",
      "zhipu/": "research"
    }
  }
}
```

If `backend` is `hybrid` or `cli`, the bridge can also run configurable `clawteam` command templates for:

- team init
- task sync
- inbox send

Current default behavior:

- native CLI sync now uses `team spawn-team`, `task create/update`, and `inbox send`
- OctoClaw stores its own task mirror while also keeping a `task-map.json` for ClawTeam task IDs
- `clawteam_data_dir` defaults to `<bridge root>/clawteam-data`, so it does not pollute your global `~/.clawteam`

This mode still does not replace OctoClaw routing or patrol. It only adds ClawTeam-style collaboration plumbing with low integration risk.

`spawn_execution` lets OctoClaw directly execute `spawn_single` through `clawteam spawn tmux ...`.
OctoClaw now computes `worker_pool / phase / profile / model / thinking` first, then optionally maps the final model to an OpenClaw `--profile` for the execution layer.
Because current OpenClaw TUI exposes `--profile` rather than a direct `--model` flag, the recommended integration is:

- OctoClaw owns runtime model policy
- OctoClaw maps the final selected model to a profile only when needed by the execution backend
- ClawTeam receives the final OpenClaw command and runs it in tmux

See [clawteam-integration-analysis-2026-03-25.md](./clawteam-integration-analysis-2026-03-25.md) for the architecture notes and tradeoffs.
See [octoclaw-clawteam-unified-runtime-v1-2026-03-25.md](./octoclaw-clawteam-unified-runtime-v1-2026-03-25.md) for the target unified runtime design.

Useful inspection commands:

```bash
# Unified runtime task records
cat /workspace/tmp/octopus/task-state.json

# ClawTeam-style board, including parent/child lineages for spawn_multi
cat /workspace/tmp/octopus/clawteam-bridge/board.json
```

## Runtime Policy Decision

OctoClaw now exposes a structured runtime policy entry:

- script: [`lib/octoclaw_policy.py`](./lib/octoclaw_policy.py)
- schema: [`schemas/runtime-policy-decision-v1.schema.json`](./schemas/runtime-policy-decision-v1.schema.json)
- replay schema: [`schemas/runtime-policy-replay-event-v1.schema.json`](./schemas/runtime-policy-replay-event-v1.schema.json)
- replay fixtures: [`tests/fixtures/runtime-policy-replay-events-v1.json`](./tests/fixtures/runtime-policy-replay-events-v1.json)
- runtime tool: `octoclaw_policy_decide`
- command: `/octopolicy`

The decision object is the stable contract between:

- OpenClaw plugin / hook wiring
- OctoClaw route and model policy
- ClawTeam task metadata
- UI / replay / eval surfaces

It includes:

- route decision
- model/profile decision
- default skill bundle
- review policy
- prompt contract
- tool policy
- hook interface hints for:
  - `before_model_resolve`
  - `before_prompt_build`
  - `before_tool_call`
  - `agent_end`

Current runtime extension support is exposed as tool/command entrypoints first.
The `hook_interface` payload is emitted now so future plugin hook binding can consume the same contract without changing the schema.

## Model Policy Inputs

Auto mode now considers four input layers:

- Local speed metrics: `/workspace/tmp/octopus/model-speed.json`
- Benchmark snapshot: `/workspace/tmp/octopus/model-benchmarks.json`
- Plan state: `/workspace/tmp/octopus/model-plan-state.json`
- Pricing model: `/workspace/tmp/octopus/model-pricing.json`

Recommended benchmark sources:

- PinchBench for OpenClaw agent suitability
- Artificial Analysis for coding / reasoning capability
- Claw-Eval for real-world agent workflow performance
- OpenClaw live compatibility as your local validation layer
- OpenRouter rankings as a low-weight ecosystem / availability signal

How we use them:

- PinchBench, Artificial Analysis, and Claw-Eval are primary benchmark inputs
- OpenClaw live compatibility is a local feedback layer
- OpenRouter rankings are secondary only; they help with ecosystem / routing confidence, not core capability ranking
- `main_model` is chosen with a capability floor first, then ranked within eligible candidates; fast/cheap mid-tier models should not win the main brain slot just on latency or price

What can be inferred automatically:

- available models from `openclaw models list --json`
- local TTFT / TPS / error-rate if your local latency source exists
- pricing mode and default billing cycle once you map a model pattern

What still needs user-maintained or provider-synced data:

- monthly / yearly plan renewal date
- remaining request / prompt ratio
- whether a plan should be used before expiry
- fallback model when quota gets low
- optional monthly budget for token-priced models
- current-month spend if you want budget-aware fallback

In practice:

- package type (`subscription_request_plan`, `subscription_prompt_plan`, `subscription_seat_plan`, `token_pack`) can be seeded once and then reused
- billing cycle (`monthly`, `yearly`, `one_time`) can usually be seeded once and reused
- live remaining quota usually cannot be inferred reliably without provider-specific APIs, so keep it in `model-plan-state.json` or add a provider sync later
- token-priced models can also be budget-governed with `monthly_budget_cny`, `current_month_spent_cny`, `soft_limit_ratio`, and `hard_limit_ratio`

## Harness Direction

OctoClaw follows a lightweight harness direction by default:

- runtime policy decides route / review / skill bundle
- workers receive brief-first task packets (`octoclaw.brief/v1`)
- workers are asked to return a structured result contract (`octoclaw.worker_result/v1`)
- long outputs become artifacts instead of bloating the main context
- task / inbox / board make delegation observable

This is meant to improve efficiency and reduce token waste, not to make every request heavier.

Heavier protocol rules are only turned on for complex `spawn_single` / `spawn_multi` work.

## Project Layout

```text
.
├── README.md
├── README.zh-CN.md
├── SKILL.md
├── install.sh
├── CHANGELOG.md
├── RELEASE_NOTES_v0.1.0.md
├── schemas/
├── extensions/
│   └── octoclaw-runtime/
├── eval/
└── lib/
    ├── octoclaw_policy.py
    ├── dispatch_task.py
    ├── runner_playbooks.py
    ├── runner_routing.py
    ├── runner_dispatch.py
    ├── runner_queue.py
    ├── runner_loop.sh
    ├── runner-daemon.sh
    ├── patrol.py
    ├── status.sh
    └── eval_suite.py
```

## Open-Source Release Materials

- [CHANGELOG.md](./CHANGELOG.md)
- [RELEASE_NOTES_v0.1.0.md](./RELEASE_NOTES_v0.1.0.md)
- [CONTRIBUTING.md](./CONTRIBUTING.md)
- [LICENSE](./LICENSE)

## Archived Design Notes

- [SKILL.md](./SKILL.md)
- [octoclaw-direction-analysis-2026-03-19.md](./octoclaw-direction-analysis-2026-03-19.md)
- [octoclaw-roadmap-multi-agent-cost-speed-2026-03-20.md](./octoclaw-roadmap-multi-agent-cost-speed-2026-03-20.md)
