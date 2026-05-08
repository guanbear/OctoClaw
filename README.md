# OctoClaw v0.5.0

English | [简体中文](./README.zh-CN.md)

![OctoClaw banner](./banner.png)

> A TypeScript-first execution policy layer, delegation harness, feedback loop, and IM/operator surface for OpenClaw.

OctoClaw is no longer the old Python-script runtime. The current line keeps the live path inside the OpenClaw gateway / runtime extension, uses `reply | delegate` as the only live route authority, and treats `direct / runner / spawn_single / spawn_multi` as execution contracts or lanes.

## Current Design Entry Points

- [TS rebuild design v2](./docs/octoclaw-ts-rebuild-design-v2.md): current architecture baseline, completed work, and N0-N4 plan.
- [Role terminology](./docs/octoclaw-role-terminology.md): Observer / Patrol / Runner / Ctl boundaries.
- [Architecture map](./docs/octoclaw-architecture-map-2026-05-09.md): detailed module graph and data/control flow.
- [Repo debt cleanup plan](./docs/octoclaw-repo-debt-cleanup-plan-2026-05-09.md): archive boundaries, current entry points, and version/terminology policy.
- [State convergence](./docs/octoclaw-state-convergence-4-4-design.md): TaskFlow, WorkContract, `task-state.json`, and `policyState` truth hierarchy.
- [WorkContract delegation design](./docs/octoclaw-work-contract-centered-delegation-design-2026-04-25.md): delegation, handoff, and continuity contracts.
- [Judge / ACK policy spec](./docs/octoclaw-judge-ack-policy-spec-2026-04-21.md): judge, ACK, and policy labels.
- [Feedback loop contracts](./docs/octoclaw-feedback-loop-contracts.md): observe -> summarize -> review -> curate -> validate -> promote -> learn.
- [Auto Router Phase 5 design](./docs/octoclaw-phase5-auto-router-design-2026-04-30.md): shadow-first execution-contract recommender design.

Historical roadmaps, old planning workspaces, and validation evidence live under [docs/archive](./docs/archive/).

## Core Capabilities

- **Policy-first routing**: live route is `reply | delegate`; execution contract and lane selection happen below that boundary.
- **WorkContract-centered delegation**: delegated work carries route seal, scope, role, allowed tools, model profile, and continuity.
- **Managed TaskFlow substrate**: OpenClaw native TaskFlow owns lifecycle truth; OctoClaw owns durable projection and operator surfaces.
- **ACK / progress / final separation**: ACK confirms receipt, progress comes from execution transitions, final delivery comes from completion/result facts.
- **Native final delivery**: OpenClaw native announce/channel delivery owns final relay; OctoClaw records delivery metadata and status projection.
- **IM adapter registry**: Slack L2, Feishu L1, and WeChat L0 have baseline adapters and degradation behavior.
- **Feedback loop**: `octoclawctl nightly/review/curate/nightly-eval/promote` supports replay, review, fixtures, gates, and baseline promotion.
- **Unified operator CLI**: installation, deployment, enable/disable, status, nightly, review, and repair go through `octoclawctl`.

## Repository Layout

```text
packages/octoclaw-contracts      stable contracts: WorkContract, events, results, delivery, status projection
packages/octoclaw-policy         policy: intent, judge schema, route, role, model, gate
extensions/octoclaw-runtime      OpenClaw runtime extension: hooks, dispatch, ACK, IM, delivery, replay
extensions/octoclaw-status-surface
                                 status/details/queue/timeline read model and renderers
tools/octoclawctl                install, config, status, nightly, review, curate, calibration gate
schemas                          runtime / route / budget / outcome JSON schemas
eval                             minimal eval fixtures
docs                             current design docs
docs/archive                     historical plans, engineering logs, and validation evidence
```

## Quick Start

For source-managed installs and updates, use `octoclawctl`:

```bash
pnpm install
pnpm build
node tools/octoclawctl/dist/cli.js install
```

Deploy into an existing OpenClaw environment:

```bash
node tools/octoclawctl/dist/cli.js deploy
node tools/octoclawctl/dist/cli.js enable
node tools/octoclawctl/dist/cli.js status
```

Common config operations:

```bash
node tools/octoclawctl/dist/cli.js config get enabled
node tools/octoclawctl/dist/cli.js config set enabled true
node tools/octoclawctl/dist/cli.js config set features.delegation true
```

If `octoclawctl` is installed on your path, replace `node tools/octoclawctl/dist/cli.js` with `octoclawctl`.

## Operator Commands

```bash
octoclawctl status
octoclawctl details --task-id <task-id>
octoclawctl queue
octoclawctl timeline --task-id <task-id>
octoclawctl patrol
octoclawctl repair
```

Feedback loop:

```bash
octoclawctl nightly --format markdown
octoclawctl review
octoclawctl curate --task-id <turn-id>
octoclawctl nightly-eval run --config ~/.openclaw/nightly-eval-config.json --output-dir ~/.openclaw/workspace/tmp/octopus/nightly-eval
octoclawctl nightly-eval promote --output-dir ~/.openclaw/workspace/tmp/octopus/nightly-eval
```

## Current Roadmap

N0 is now closed: the active entry point is `octoclaw-ts-rebuild-design-v2.md`, while v1, the Phase 1/2 construction designs, and the 2026-04-30 roadmap are archive snapshots.

Next work follows v2 N1-N4:

1. Harden state truth and native completion relay.
2. Productize the IM capability matrix.
3. Build Auto Router shadow-first: recommend execution contracts without changing the live path.
4. Prepare release and open-source surfaces.

## Development Checks

```bash
pnpm check
pnpm test
git diff --check
```

For documentation-only changes, run at least:

```bash
git diff --check
```
