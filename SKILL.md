---
name: octoclaw
metadata:
  author: openclaw-community
  version: "0.6.0"
  timestamp: "2026-05-09"
  stable: false
tags:
  - multi-agent
  - scheduler
  - productivity
description: >
  OctoClaw is the TypeScript-first policy, delegation, status, and operator
  layer for OpenClaw. Use it when a turn should be routed through
  reply/delegate policy, WorkContract-backed delegation, runtime status, IM
  delivery, or feedback-loop tooling.
postInstall: |
  ![](./banner.png)
  OctoClaw is installed. Current live route authority is `reply | delegate`.
  Use `octoclaw_dispatch` for delegated work and `octoclaw_status` for status.
---

# OctoClaw Runtime Skill

This skill describes the current `v0.6.0` runtime line. It intentionally does
not describe the old Python `octoclaw_spawn.py`, completion-file finalizer, or
JSON delivery-outbox runtime. Those were historical mechanisms and must not be
reintroduced as compatibility paths.

## Current Authority

| Layer | Authority |
|------|-----------|
| live route | `reply | delegate` only |
| execution lifecycle | OpenClaw native TaskFlow / `sessions_spawn` / native announce |
| OctoClaw metadata | SQLite runtime ledger: WorkContract, route seal, native refs, spawn intent, audit events |
| status display | generated projection from metadata + native lifecycle |
| `task-state.json` | rebuildable read-model cache, not truth |
| replay log | observability and evaluation evidence, not runtime truth |

## Main-Agent Rules

1. For direct answers, use `reply`; do not create work.
2. For delegated work, call `octoclaw_dispatch`; do not hand-write spawn args.
3. After native spawn is accepted, confirm with `octoclaw_dispatch_confirm`.
4. For status/provenance/follow-up questions, use `octoclaw_status` or
   `octoclaw_task_action`; do not dispatch new work just to explain old work.
5. Do not call or recreate `octoclaw_spawn`.
6. Do not use completion files, child-finalizer recovery, or JSON delivery
   outbox as the normal final-delivery mechanism.
7. Do not treat `task-state.json` as durable truth. Missing or corrupt
   task-state must be rebuilt or reported degraded.
8. Do not inject raw child transcripts into the parent context.

## Tool Use

| Tool | Use |
|------|-----|
| `octoclaw_route_hint` | Ask the runtime for route guidance before model/tool escalation. |
| `octoclaw_policy_decide` / `octoclaw_route` | Resolve policy and route facts. |
| `octoclaw_dispatch` | Create a WorkContract-backed delegation plan and native spawn intent. |
| `octoclaw_dispatch_confirm` | Bind accepted native `runId` / `childSessionKey` evidence back to OctoClaw metadata. |
| `octoclaw_task_action` | Read task details, queue, artifacts, or supported task operations. |
| `octoclaw_status` | Render status/details/queue/timeline from projection. |
| `octoclaw_crash_recovery` | Run explicit recovery diagnostics. |

## Auto Router Commands

| Command | Use |
|---------|-----|
| `octoclawctl router wizard [--incremental]` | Create or update local router plan/budget/override config. |
| `octoclawctl router decisions [--since 7d]` | Inspect shadow-to-live promotion decisions. |
| `octoclawctl router cost report [--period 7d]` | Review local cost grouped by model, complexity, and route. |
| `octoclawctl router cost budget set --monthly <usd>` | Store the local monthly router budget. |
| `octoclawctl router score override <model> <tier>=<score>` | Override a model score for a complexity tier. |
| `octoclawctl router model mark <model> --dispreferred-for <tier>` | Soft-avoid a model for a tier. |
| `octoclawctl router model ban <model> --for <tier>` | Hard-exclude a model for a tier. |

## Delegation Contract

Delegated work must carry:

- WorkContract id and route seal.
- scope and allowed tools.
- role / worker-pool / model profile metadata.
- native spawn intent id.
- accepted native refs after confirm.
- status projection derived from native lifecycle and OctoClaw metadata.

`spawnExecuted=true` requires accepted native run evidence. A child session key by
itself is only a reference; it is not execution proof.

## Status Questions

These are status-surface requests, not new work:

- "OctoClaw status"
- "task status"
- "which task is running?"
- "why did it not dispatch?"
- "who handled the previous task?"
- "show queue/details/timeline"

Answer through `octoclaw_status` or `octoclaw_task_action`. If no verifiable
record exists, say that clearly and do not invent a task.

## Current Docs

- `README.md` / `README.zh-CN.md`: operator-facing overview.
- `docs/octoclaw-architecture-map-2026-05-09.md`: detailed module graph.
- `docs/octoclaw-ts-rebuild-design-v2.md`: architecture baseline.
- `docs/octoclaw-runtime-convergence-cleanup-plan-2026-05-07.md`: runtime cleanup handoff.
- `docs/octoclaw-repo-debt-cleanup-plan-2026-05-09.md`: archive/version/terminology cleanup.
- `docs/archive/`: historical material only.

## Forbidden Legacy Paths

Do not reintroduce these as product runtime behavior:

- `octoclaw_spawn` as a public tool or alias.
- plugin `runtime.subagent.run()` fallback.
- fake detached runtime capability registration.
- child completion files as normal final protocol.
- child-finalizer recovery loop.
- JSON delivery outbox for new planner/native runtime tasks.
- resident runner / tmux / ClawTeam as required substrate.
