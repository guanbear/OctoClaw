# OctoClaw

English | [简体中文](./README.zh-CN.md)

<p align="center">
  <img src="./icon.png" alt="OctoClaw icon" width="96" height="96">
</p>

![OctoClaw banner](./banner.png)

[![CI](https://github.com/guanbear/OctoClaw/actions/workflows/test.yml/badge.svg)](https://github.com/guanbear/OctoClaw/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/@octoclaw/cli?label=%40octoclaw%2Fcli)](https://www.npmjs.com/package/@octoclaw/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> Auto-delegation, status truth, and cost-aware model routing for OpenClaw agents.
>
> OctoClaw keeps the main agent responsive by moving slow or uncertain work into native OpenClaw sub-agents, then reports durable task truth back to Slack, Feishu, WeChat, and the CLI.

---

## The problems it fixes

**Your main agent stalls on one big task.**
You ask it to write a script, do a bit of research, or run a test pass — then it sits for several minutes with no signal, sometimes ten-plus. You can't tell if it's still working or already dead, and you're not brave enough to interrupt.

**Every turn burns your most expensive model.**
"Can you check xxx for me?" lights up a frontier model's input tokens. Small asks, heavy artillery, end-of-month bill shock.

**Your main context gets buried.**
Raw sub-task output, intermediate reasoning, tool-call logs — they all pile into the main conversation. Thirty turns later the agent is still dragging the trash around.

**"Task completed" but nothing to show.**
You know "it finished running" but can't tell whether it actually produced a result, where the artifact is, or whether the failure was the task's or the substrate's.

OctoClaw fixes those four things.

---

## What it does

- 🧠 **Automatic sub-agent delegation** — `reply | delegate` decides per turn whether the main agent answers directly or spawns a background sub-agent
- 🪶 **Lightweight judge** — a local Ollama model or a cheap remote endpoint decides the route, so your main model never burns tokens just to decide "reply vs delegate"
- 💰 **Cost-aware model selection** — shadow mode compares "what if we'd used a cheaper model?" on real traffic, only promotes when the data holds
- 📚 **Auto-discovered model intel** — prices and capabilities pulled from OpenRouter, models.dev, and OpenClaw's provider catalog; cross-source disagreements are flagged, not silently overwritten. Uses PinchBench / Aider / SWE-bench / BFCL as cold-start priors — but **your local replay data always outranks any leaderboard**
- 🧹 **Main context stays clean** — sub-agents run with their own context; only compact result packets come back, never raw transcripts
- 📊 **Trustworthy status** — lifecycle truth comes from OpenClaw's native TaskFlow; metadata lives in SQLite; states like `running_slow` / `stalled` / `timed_out` / `degraded_completed_without_result` have crisp meanings
- 🔁 **Recoverable tasks** — delegation tickets, retry attempts, amendment protocol (`steer_child` / `queue_after` / `cancel_and_respawn`)
- 💬 **IM out of the box** — Slack (streaming + thread), Feishu (thread), WeChat (plain text), with explicit degradation per tier
- 🔧 **One CLI for everything ops** — `octoclawctl` handles install, deploy, status, nightly review, calibration gates

## Release status

OctoClaw is approaching the `0.6.x` release line.

| Surface | Status | Notes |
|---|---:|---|
| OpenClaw runtime plugin | ✅ release candidate | Built against OpenClaw `2026.5.12` native TaskFlow and Slack plugin contracts |
| Slack | ✅ live-smoked | Streaming, ACK, footer truth, native final delivery, and parallel child status are covered by `stability full` |
| Auto Router | ✅ gated live for delegated lanes | Uses local config, model pricing/capability snapshots, health cooldowns, and local promotion evidence |
| Feishu | ⚠️ adapter ready; target smoke required | Card/status/onboarding paths exist, but release migration should smoke on the Feishu-only target machine |
| WeChat / Telegram / Discord | ⚠️ adapter tiers | Plain/rich delivery contracts are present; not all channels have live acceptance harnesses |

- Release checklist: [`docs/release-checklist.md`](./docs/release-checklist.md)
- Release notes draft: [`docs/release-notes-v0.6.0.md`](./docs/release-notes-v0.6.0.md)
- Migration and Feishu-only runbook: [`docs/octoclaw-migration-onboarding-feishu-guide.md`](./docs/octoclaw-migration-onboarding-feishu-guide.md)

---

## Why it's built this way

### 1. Built on OpenClaw's native TaskFlow — no wheel reinvented

Lifecycle truth (running / completed / failed / timeout) comes from OpenClaw itself. OctoClaw does **not** run a second task-state machine. An earlier iteration tried that — the state engine drifted from the substrate, restarts left "completed" tasks with no artifact, and operators lost trust. Never again.

Three layers, each with a clear job:

| Layer | Authority | What it owns |
|---|---|---|
| OpenClaw native TaskFlow | **execution lifecycle** | whether the process is alive, whether `runId` was accepted, whether native announce delivered |
| SQLite runtime ledger | **metadata + audit** | WorkContract, route seal, spawn intent, event log |
| `task-state.json` | **rebuildable status cache** | deletable; the two layers above can reconstruct it |

No resident daemon. No runner pool.

### 2. Sub-agent first; multi-agent later, only if the data says yes

Multi-agent looks sexy but only pays off when **concurrency buys latency**, **isolation buys correctness**, and **specialization buys quality** — all three at once. Otherwise it's pure cost multiplication plus coordination overhead plus hidden state drift.

OctoClaw stays on `solo_worker`: the main agent is a coordinator; it spawns one sub-agent per scoped task. When nightly data actually proves a multi-agent topology is cheaper / faster / better for a given task class, we'll turn on `advisor_assisted` or `threaded_subagents` for that class. Not before.

### 3. A cheap judge routes, so your main model doesn't have to

Letting the main model decide "should I reply or delegate?" has three costs:

- **Slow** — frontier-model first-turn latency is 2-5 s before any visible output
- **Expensive** — you're paying frontier input-token prices just to pick a route
- **Polluting** — that reasoning stays in the main context for every subsequent turn

OctoClaw's judge is a separate layer:

- **Runs locally** — Ollama + **Qwen3 0.6B** works as a judge, sub-second latency, $0 marginal cost
- **Runs on cheap endpoints** — Groq, any OpenAI-compatible cheap model works
- **Outputs just four fields** — `route`, `confidence`, `complexity`, `complexityConfidence`. Small models handle this easily.
- **Supports shadow mode** — run the judge without using its verdict, compare against the main model's judgment over a week, then promote

This keeps your main model doing the only thing it's good for: the actual work.

### 4. The main agent's context stays clean

When a sub-agent finishes, its raw transcript, tool calls, and internal reasoning never re-enter the main conversation. What comes back is a compact packet:

```json
{
  "status": "success",
  "summary": "Fixed the type errors in foo.ts",
  "artifacts": ["src/foo.ts"],
  "keyFindings": [...]
}
```

The main context stays small, so turn 50 is still fast and still cheap.

### 5. ACK is three-stage and doesn't fight your stream

- **ACK0 (instant)** — a 300 ms reaction emoji on Slack, or a short text within 2.5 s
- **Progress tiers (non-streaming channels only)** — "still working" nudges at 12 s / 30 s / 90 s
- **Final delivery** — handled by OpenClaw's native announce/channel delivery; OctoClaw only keeps a small restart-recovery outbox for native results that completed before IM delivery

On Slack (native streaming), progress tiers are automatically skipped because the user is already watching text arrive live.

---

## Quick start

Prerequisites:

- OpenClaw `>= 2026.5.12`
- Node.js `>= 22`
- `pnpm` for source installs
- At least one IM channel: Slack or Feishu for production use
- A judge model: local Qwen3 0.6B through Ollama, or a remote OpenAI-compatible model such as `gpt-5.4-mini`

From source:

```bash
pnpm install
pnpm build

# Install into your OpenClaw environment
node tools/octoclawctl/dist/cli.js install
node tools/octoclawctl/dist/cli.js deploy
node tools/octoclawctl/dist/cli.js enable
node tools/octoclawctl/dist/cli.js status
```

When using a released CLI package:

```bash
npm install -g @octoclaw/cli
octoclawctl init
octoclawctl install
octoclawctl deploy
octoclawctl doctor
```

Migrating to a new machine, running without a local judge, or installing into a Feishu-only environment: follow [`docs/octoclaw-migration-onboarding-feishu-guide.md`](./docs/octoclaw-migration-onboarding-feishu-guide.md). The intended flow is AI-runbook first, thin wizard only for secrets and explicit config choices.

Once `octoclawctl` is on your PATH:

```bash
octoclawctl status                       # current projection
octoclawctl doctor                       # release readiness
octoclawctl details --task-id <id>       # per-task detail
octoclawctl queue                        # running / queued
octoclawctl timeline --task-id <id>      # step-by-step trace
octoclawctl patrol                       # health check
octoclawctl repair                       # bounded recovery

# Cost-aware routing
octoclawctl router model-intel refresh   # refresh capability / pricing snapshot
octoclawctl router model-config analyze  # find cheaper same-provider candidates
octoclawctl router shadow-report         # review shadow comparisons
```

---

## How it works

```text
user turn
  │
  ├─ intent grounding + execution coverage
  │
  ├─ judge  (lightweight model, <1 s)
  │     └─ outputs: route / confidence / complexity / complexityConfidence
  │
  ├─ WorkDecisionSeal → WorkContract → delegation ticket
  │
  ├─ route commit ACK
  │
  ├─ reply path
  │     └─ main agent answers from evidence; no new execution unit
  │
  └─ delegate path
        ├─ octoclaw_dispatch → native sessions_spawn
        ├─ octoclaw_dispatch_confirm (binds accepted run evidence)
        ├─ sub-agent runs under native TaskFlow, separate context
        ├─ native announce delivers the final result
        └─ status projection + IM footer reflect durable facts
```

---

## Auto Router (cost-aware model selection)

Auto Router v3 lives in `@octoclaw/router`. V1 is a single balanced mode for delegated/sub-agent model choice; the main agent is never silently switched.

1. `octoclawctl router wizard` writes local plan, budget, privacy, language, restricted-model, and same-provider discovery config to `~/.openclaw/octoclaw/router-wizard.json`; `--config <answers.json>` supports a scripted 7-step answer file
2. `octoclawctl router model-intel refresh` pulls configured models, public prices, capabilities, and quota pressure into one snapshot
3. `octoclawctl router promotion review --input <shadow.jsonl>` evaluates local shadow samples and writes promotion decisions
4. `octoclawctl router decisions --since 7d` shows shadow-to-live promotion audit records
5. `octoclawctl router cost report --period 7d` groups spend by model, complexity, and route, and includes prediction plus budget status when configured
6. `octoclawctl router score override`, `router model mark`, and `router model ban` keep user overrides local

Evidence priority: **your OpenClaw config and local routing data > packaged snapshot > external leaderboards and catalogs.**
External data can seed scoring, but auto-promotion requires local shadow evidence.

Hard rules:
- Unknown quota is never treated as free
- Unconfigured models never go live
- A shadow failure can never change actual routing
- All cost, shadow, wizard, and decision data stays local in V1

---

## Project structure

```text
packages/octoclaw-contracts       stable contracts (WorkContract, events, results, delivery, projection)
packages/octoclaw-policy          policy (intent, judge schema, route, role, model, gate, router)
extensions/octoclaw-runtime       OpenClaw runtime plugin (hooks, dispatch, ACK, IM, delivery, replay)
extensions/octoclaw-status-surface
                                  status / details / queue / timeline read-model and renderers
tools/octoclawctl                 install, deploy, status, nightly, review, curate, calibration
schemas                           JSON schemas
eval                              minimal eval fixtures
docs                              current design docs
docs/archive                      historical plans and evidence
```

---

## Roadmap

- **0.6.x release candidate** — native TaskFlow truth, Slack stability smoke, Auto Router delegated-lane live mode, AI-first migration runbook
- **Next** — Feishu-only target smoke, packaged install rehearsal, release tag, and channel-specific acceptance expansion
- **Later** — broader IM live harnesses, richer status surfaces, and data-backed multi-agent topologies only where measured wins justify the overhead

Full architecture baseline: [`docs/octoclaw-ts-rebuild-design-v2.md`](./docs/octoclaw-ts-rebuild-design-v2.md).
Detailed module map: [`docs/octoclaw-architecture-map-2026-05-09.md`](./docs/octoclaw-architecture-map-2026-05-09.md).

---

## Development

```bash
pnpm check   # typecheck + build for all workspace packages
pnpm test    # vitest
git diff --check
```

For docs-only changes, `git diff --check` is enough.

---

## Contributing

- Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) before your first PR
- Larger changes go through [`openspec/changes/`](./openspec/README.md) — `proposal.md` / `design.md` / `tasks.md` first, code after
- Respect the hard invariants in [`docs/octoclaw-ts-rebuild-design-v2.md`](./docs/octoclaw-ts-rebuild-design-v2.md)

---

## Design philosophy

> **Stop rewriting OctoClaw. The job now is turning a "rebuild-finished system" into a "releasable, verifiable, recoverable, evolvable" one.**

— from the current v2 design baseline

Early project. Expect sharp edges. File issues — we read them.

---

## License

MIT. See [`LICENSE`](./LICENSE).
