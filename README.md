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

## Routing Modes

| Mode | Use case | lower tiers | higher tiers |
| --- | --- | --- | --- |
| `balanced` | default daily mode | lower-cost general models | stronger reasoning / coding models |
| `quality` | quality-first work | strong models by default | top-end models when needed |
| `cost` | batch / cheap mode | cheaper models whenever possible | only escalate when necessary |
| `private` | privacy-sensitive mode | private / self-hosted models | private / self-hosted models |
| `auto` | dynamic selection | local speed / price / capability driven | local speed / price / capability driven |

## Quick Start

```bash
bash /workspace/openclaw/skills/octopus/install.sh
```

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

Recommended gradual rollout switches in `tmp/octopus-config.json`:

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
    "hooks": {
      "before_model_resolve": true,
      "before_prompt_build": true,
      "before_tool_call": true,
      "agent_end": true
    }
  }
}
```

Suggested rollout presets for `bin/runtime-policy-rollout.sh`:

- `RUNTIME_POLICY_PRESET=conservative`
  - installs the extension
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

# Replay / eval
python3 /workspace/openclaw/skills/octopus/lib/eval_suite.py

# Runtime policy replay log
tail -n 30 /workspace/tmp/octopus/runtime-policy-replay.jsonl

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

# Uninstall runtime-policy rollout state and extension link
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

Enable it in `tmp/octopus-config.json`:

```json
{
  "clawteam_bridge": {
    "enabled": true,
    "backend": "hybrid",
    "team_name": "octopus-validation",
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
    "profile_by_label": {
      "octopus-fix": "coding",
      "octopus-scout": "research"
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
OctoClaw still computes `label / tier / model / thinking`, then maps them to an OpenClaw `--profile` when a profile mapping is configured.
Because current OpenClaw TUI exposes `--profile` rather than a direct `--model` flag, the recommended integration is:

- OctoClaw owns runtime model policy
- OctoClaw maps `label / tier / model` to a profile when needed
- ClawTeam receives the final OpenClaw command and runs it in tmux

See [clawteam-integration-analysis-2026-03-25.md](./clawteam-integration-analysis-2026-03-25.md) for the architecture notes and tradeoffs.
See [octoclaw-clawteam-unified-runtime-v1-2026-03-25.md](./octoclaw-clawteam-unified-runtime-v1-2026-03-25.md) for the target unified runtime design.

## Runtime Policy Decision

OctoClaw now exposes a structured runtime policy entry:

- script: [`lib/octoclaw_policy.py`](./lib/octoclaw_policy.py)
- schema: [`schemas/runtime-policy-decision-v1.schema.json`](./schemas/runtime-policy-decision-v1.schema.json)
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
- workers receive brief-first task packets
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

## Design Notes

- [SKILL.md](./SKILL.md)
- [octopus-direction-analysis-2026-03-19.md](./octopus-direction-analysis-2026-03-19.md)
- [octopus-roadmap-multi-agent-cost-speed-2026-03-20.md](./octopus-roadmap-multi-agent-cost-speed-2026-03-20.md)
