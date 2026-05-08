# OctoClaw Repo Debt Cleanup Plan

Date: 2026-05-09
Branch: `v0.5.0`
Status: current repository hygiene plan

This plan covers repository debt that is outside the runtime cleanup work. The
runtime cleanup itself is tracked in
[`octoclaw-runtime-convergence-cleanup-plan-2026-05-07.md`](./octoclaw-runtime-convergence-cleanup-plan-2026-05-07.md).

## 1. Scope

This plan covers three debt classes:

1. Archive and documentation boundaries.
2. Version and terminology alignment.
3. Current architecture entry points.

It does not delete runtime code, change routing behavior, or replace the
OpenSpec runtime convergence work.

## 2. Archive Boundary

The active repository root should contain only current product surfaces,
fixtures, source packages, schemas, tools, and current design docs.

### Active root directories

| Path | Status | Rule |
|------|--------|------|
| `packages/` | current | Workspace packages. |
| `extensions/` | current | Runtime and status extensions. |
| `tools/` | current | Operator CLI and helper tools. |
| `schemas/` | current | JSON schema contracts. |
| `eval/` | current fixtures only | Keep task fixtures; generated reports go to archive. |
| `openspec/` | current change specs | Keep active change proposals and tasks. |
| `docs/` | current docs + archive | Current docs at top level, history under `docs/archive/`. |

### Archived engineering logs

Moved to `docs/archive/engineering-log/`:

| Old path | New path |
|----------|----------|
| `.planning/` | `docs/archive/engineering-log/planning/` |
| `.sisyphus/` | `docs/archive/engineering-log/sisyphus/` |
| `.omx/` | `docs/archive/engineering-log/omx/` |
| `reports/` | `docs/archive/engineering-log/reports/` |
| `eval/reports/` | `docs/archive/engineering-log/eval/reports/` |

These files are retained for traceability. They are not current plans unless a
current document explicitly links to them.

## 3. Current Entry Points

Use these docs first:

| Topic | Current entry |
|-------|---------------|
| Overall architecture | [`octoclaw-ts-rebuild-design-v2.md`](./octoclaw-ts-rebuild-design-v2.md) |
| Detailed module map | [`octoclaw-architecture-map-2026-05-09.md`](./octoclaw-architecture-map-2026-05-09.md) |
| Runtime cleanup | [`octoclaw-runtime-convergence-cleanup-plan-2026-05-07.md`](./octoclaw-runtime-convergence-cleanup-plan-2026-05-07.md) |
| Repo hygiene | this document |
| Role terminology | [`octoclaw-role-terminology.md`](./octoclaw-role-terminology.md) |
| State truth | [`octoclaw-state-convergence-4-4-design.md`](./octoclaw-state-convergence-4-4-design.md) |
| Auto Router Lite | [`octoclaw-phase5-auto-router-design-2026-04-30.md`](./octoclaw-phase5-auto-router-design-2026-04-30.md) |

Historical docs under `docs/archive/` can explain why a decision was made, but
they must not override the current entries above.

## 4. Version Policy

`v0.5.0` is the current branch/release line. The following should match:

| File | Target |
|------|--------|
| `version.txt` | `0.5.0` |
| `README.md` / `README.zh-CN.md` | `OctoClaw v0.5.0` |
| workspace package versions | `0.5.0` |
| `extensions/octoclaw-runtime/openclaw.plugin.json` | `0.5.0` |
| `SKILL.md` metadata version | `0.5.0` |

Future release branches should update all rows in one version-only commit.

## 5. Terminology Policy

Use these terms consistently:

| Term | Current meaning |
|------|-----------------|
| live route | `reply | delegate` only. |
| execution contract / lane | `direct`, `runner`, `spawn_single`, `spawn_multi`, `observe`, `session_control`; not live route authority. |
| OpenClaw native TaskFlow | execution lifecycle truth. |
| SQLite runtime ledger | OctoClaw metadata and audit truth. |
| `task-state.json` | generated read-model cache and projection. |
| replay log | observability/eval evidence, not behavior truth. |
| native final delivery | OpenClaw native announce/channel delivery. |

Do not describe these as current product paths:

- `octoclaw_spawn` as a live tool or alias.
- completion files as normal final delivery protocol.
- child-finalizer recovery as normal runtime.
- JSON delivery outbox for new runtime tasks.
- fake detached runtime capability.
- Python as route/status authority.
- resident runner, tmux, or ClawTeam as required substrate.

## 6. Remaining Cleanup

### Should do

1. Keep top-level `docs/` focused on current docs; move stale active-looking docs
   to `docs/archive/` after adding a current replacement or banner.
2. Keep generated reports out of the root. New generated evidence belongs under
   `docs/archive/engineering-log/reports/` unless it is part of a live OpenSpec
   change.
3. Update historical docs only with short "superseded by" banners, not
   wholesale rewrites.
4. Keep README and SKILL aligned with the runtime cleanup plan.

### Do not do automatically

1. Do not delete `docs/archive/` history without a separate approval.
2. Do not rewrite old archived evidence paths inside archived files; those paths
   are part of the historical record.
3. Do not change runtime behavior while doing repo hygiene.

## 7. Review Checklist

Before merging repo hygiene changes:

```bash
git diff --check
rg "v1\\.5\\.0|octoclaw_spawn.py|child-finalizer|delivery outbox" README.md README.zh-CN.md SKILL.md
rg "reports/\\*\\*|\\.planning/|\\.sisyphus/|\\.omx/" README.md docs/*.md openspec/changes/runtime-convergence-cleanup-0.5.x/tasks.md
```

Expected result: active entry docs may mention removed paths only as forbidden
or historical paths; they must not instruct maintainers to use them. Historical
references inside `docs/archive/` are allowed.
