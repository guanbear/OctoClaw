# OctoClaw v0.6.0 Release Notes Draft

Date: 2026-05-22  
Status: release candidate draft

## Summary

OctoClaw `v0.6.0` focuses on making OpenClaw delegation stable, observable, and releasable:

- native OpenClaw TaskFlow is the source of execution truth
- Slack delivery, streaming, ACK, footer truth, and native sub-agent final delivery are covered by full stability smoke
- Auto Router can select delegated-lane models from local configuration, capability/price snapshots, and health cooldowns
- migration is AI-runbook first, with a thin wizard only for secrets and explicit user choices
- package publishing now excludes compiled test files and includes package-local README/LICENSE

## Compatibility

- OpenClaw: `>= 2026.5.12`
- Node.js: `>= 22`
- Local judge: optional
- Remote judge: OpenAI-compatible endpoint supported through setup
- Slack: supported and live-smoked
- Feishu: adapter/card/status/onboarding support present; target-machine smoke required for Feishu-only deployments

## Highlights

### Native Runtime Truth

OctoClaw now treats OpenClaw native TaskFlow as the execution authority. WorkContract and SQLite runtime ledger store metadata and audit trails, while task-state projections remain rebuildable display state.

This reduces duplicate runtime ownership and prevents old failure modes where OctoClaw believed a task had completed without durable native evidence.

### Stable Native Delegation

The planner path now binds `octoclaw_dispatch`, `sessions_spawn`, `octoclaw_dispatch_confirm`, and native child final delivery through spawn intents and WorkContracts.

Covered cases include:

- delegated native final delivery
- footer route truth
- difficulty/footer projection
- duplicate final suppression
- parallel child spawn/status evidence
- repeated dispatch before spawn, which now reuses the pending native planner intent instead of issuing a second ticket

### Gateway Restart Recovery

OctoClaw now registers a `gateway_start` recovery hook. After Gateway restart it scans OpenClaw `tasks/runs.sqlite` for native child runs with `status=succeeded` and `delivery_status=pending`, persists a restart delivery outbox item, re-sends the terminal result through the existing IM delivery path, and marks the native row delivered only after send success.

### Slack Stability Smoke v2

The release gate uses `octoclawctl stability full` to exercise:

- simple reply
- long streaming reply
- delegated native final
- current-model footer truth
- read-only status query
- two parallel child sessions while the main session remains responsive
- wizard contract
- provider fallback resilience
- nightly replay fixtures

Latest verified report:

```text
/Users/guanbear/.openclaw/reports/stability-smoke-v2/2026-05-22-05-28-49-stability-report.json
overallGate=pass
failureCount=0
```

### Auto Router

Auto Router now supports delegated-lane model selection with:

- model capability and price refresh
- same-provider discovery proposals
- local-only wizard state
- budget/cost reporting
- health events and cooldown-aware fallback suggestions
- local promotion evidence before live changes

Hard rules remain:

- main-agent model is not silently switched
- unconfigured models do not enter live routing
- router does not mutate OpenClaw fallback order
- secrets are read from OpenClaw config and are not stored in router state

### Migration And Feishu

The migration guide now documents the intended release operating model:

- AI assistant follows the runbook and performs diagnostics/repair
- wizard asks only for user-authorized choices
- no-local-judge machines are guided toward remote judge setup
- Feishu-only machines have a separate manual smoke path until a live Feishu harness exists

Guide: [`docs/octoclaw-migration-onboarding-feishu-guide.md`](./octoclaw-migration-onboarding-feishu-guide.md)

## Packaging

The `@octoclaw/cli` package now includes:

- package-local `README.md`
- package-local `LICENSE`
- compiled runtime files under `dist/`

It excludes:

- compiled test files matching `dist/**/*.test.*`

Latest inspected tarball size:

```text
205.7 kB
```

## Verification Snapshot

Latest local verification before this draft:

```text
pnpm check
pnpm test
git diff --check
npx gitnexus detect-changes -r OctoClaw
node tools/octoclawctl/dist/cli.js deploy --skip-build --restart
node tools/octoclawctl/dist/cli.js stability full --format json
```

Observed full test result:

```text
173 test files passed
2311 tests passed
1 skipped
1 todo
```

Deploy readiness on the Slack release machine:

```text
6 pass, 1 warn, 0 fail
warn: Feishu not configured on this Slack-only machine
```

## Known Limitations

- Feishu support needs a live target-machine smoke before declaring Feishu-only migration complete.
- WeChat, Telegram, and Discord adapters have contract tests but not the same live harness depth as Slack.
- Auto Router leaderboard/capability data is a cold-start prior; local routing and shadow evidence remain higher authority.
- Multi-agent topologies beyond scoped sub-agents are intentionally not enabled by default.
- Gateway restart recovery replays completed pending native results; it does not auto-rerun failed/lost child tasks.

## Upgrade Notes

1. Upgrade OpenClaw to `2026.5.12` or newer.
2. Install or update OctoClaw.
3. Run:

```bash
octoclawctl init
octoclawctl doctor
octoclawctl router model-intel refresh
octoclawctl deploy
```

4. If no local judge exists, run:

```bash
octoclawctl init --auto-remote-judge
```

5. Run the release checklist before publishing or migrating a production machine:

```text
docs/release-checklist.md
```
