# 🐙 OctoClaw v1.5.0

English | [简体中文](./README.zh-CN.md)

![OctoClaw banner](./banner.png)

> A cost-sensitive multi-agent orchestration layer for OpenClaw.

OctoClaw is built for three things:

- lower cost through role-aware model routing
- faster response through a persistent runner and async workers
- better reliability through patrol, session awareness, and self-healing

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

- Route decision entry: [`octoclaw_route.py`](./lib/octoclaw_route.py)
- Unified dispatch entry: [`dispatch_task.py`](./lib/dispatch_task.py)
- Persistent runner:
  - [`runner-daemon.sh`](./lib/runner-daemon.sh)
  - [`runner_dispatch.py`](./lib/runner_dispatch.py)
  - [`runner_queue.py`](./lib/runner_queue.py)
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
3. Let `runner-daemon` run in the background
4. Route ambiguous work through `octoclaw_route.py`
5. Use `status.sh --format table` to inspect state
6. Run `eval_suite.py` once to establish a baseline

## Common Commands

```bash
# Route first
python3 /workspace/openclaw/skills/octopus/lib/octoclaw_route.py --task 'analyze this error and give me a fix plan'

# Unified dispatch entry
python3 /workspace/openclaw/skills/octopus/lib/dispatch_task.py --task 'check redis logs and port status' --command 'ss -lntp | grep 6379'

# Dispatch a lightweight job directly to runner
python3 /workspace/openclaw/skills/octopus/lib/runner_dispatch.py --command 'pwd' --summary 'check current directory'

# Status views
bash /workspace/openclaw/skills/octopus/lib/status.sh --format table
bash /workspace/openclaw/skills/octopus/lib/status.sh --format lanes

# Replay / eval
python3 /workspace/openclaw/skills/octopus/lib/eval_suite.py

# Force a patrol cycle
python3 /workspace/openclaw/skills/octopus/lib/patrol.py --force
```

## Project Layout

```text
.
├── README.md
├── README.zh-CN.md
├── SKILL.md
├── install.sh
├── CHANGELOG.md
├── RELEASE_NOTES_v0.1.0.md
├── eval/
└── lib/
    ├── dispatch_task.py
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
