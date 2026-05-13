# OctoClaw Nightly Evaluation Scheduler

Date: 2026-04-26  
Scope: D6 nightly evaluation orchestration for D3/D4/D5 evaluation steps.

## Purpose

`octoclawctl nightly-eval run` orchestrates D3 nightly evaluation, D4 Slack acceptance testing, and D5 calibration gate in a single configurable run. It produces an aggregate report with per-step status, overall gate, and recommendation. It does not mutate live policy, enable multi-agent, or perform online self-tuning.

Mac LaunchAgent support allows scheduling this as a nightly cron-like task without involving the OpenClaw runtime loop.

## Commands

### Run evaluation

```bash
octoclawctl nightly-eval run \
  --config ./nightly-eval-config.json \
  --output-dir ./reports/nightly-eval \
  [--format markdown|json]
```

### Install Mac LaunchAgent

```bash
octoclawctl nightly-eval install-launchagent \
  --config /absolute/path/to/nightly-eval-config.json \
  --output-dir /absolute/path/to/reports \
  [--schedule-hour 2] \
  [--log-dir /absolute/path/to/logs]
```

### Uninstall Mac LaunchAgent

```bash
octoclawctl nightly-eval uninstall-launchagent
```

### Preview plist (no installation)

```bash
octoclawctl nightly-eval print-plist \
  --config /absolute/path/to/nightly-eval-config.json \
  --output-dir /absolute/path/to/reports \
  [--schedule-hour 2]
```

## Config

The `--config` JSON file:

```json
{
  "replayPath": "/Users/guanbear/.octoclaw/replay/runtime-policy.jsonl",
  "slackAcceptanceConfig": "./slack-acceptance.json",
  "baseline": "./baseline-report.json",
  "candidate": "./candidate-report.json"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `replayPath` | Yes | Path to replay JSONL for D3 nightly evaluation |
| `slackAcceptanceConfig` | No | Path to D4 Slack acceptance config (enables D4 step) |
| `baseline` | No | Path to D5 baseline report (requires `candidate`) |
| `candidate` | No | Path to D5 candidate report (requires `baseline`) |

If `baseline` is provided without `candidate` (or vice versa), the config validation fails closed.

## Steps

| Step | Trigger | Output |
|------|---------|--------|
| D3 Nightly | Always (replayPath required) | NightlyReport JSON + MD |
| D4 Slack Acceptance | `slackAcceptanceConfig` present | SlackAcceptanceReport JSON + MD |
| D5 Calibration Gate | Both `baseline` and `candidate` present | CalibrationGateReport JSON + MD |

Steps that are not configured are marked `skipped`. Steps that fail are caught and marked `fail` with reason — they do not abort the entire run.

## Aggregate Report

The aggregate report contains:

- Per-step status: `pass`, `fail`, `unknown`, or `skipped`
- Overall gate: `fail` if any step failed, `unknown` if any step is unknown, `pass` only if all ran steps passed
- Recommendation status: `recommend_only`, `blocked`, or `unknown`
- `unknown` is never treated as `pass`

Output: `{timestamp}-nightly-eval.json` + `.md` in the output directory. The embedded D3 nightly report includes a cost/speed baseline table for `reply`, `delegate`, and `flow` lanes with p50/p95/p99 latency, cost status, cost/request, cost/success, fallback/retry, and context-pollution metrics. It also includes a model shadow comparison section that records baseline/live profile versus shadow recommendation while keeping `promotionAllowed=0`. Missing cost/latency is rendered as unknown/N/A and is not promoted as pass evidence.

## Mac LaunchAgent

### How it works

The LaunchAgent runs `octoclawctl nightly-eval run` on a daily schedule using macOS `launchd`. It does not run at login, does not keep alive, and is purely scheduled.

### Installation

```bash
octoclawctl nightly-eval install-launchagent \
  --config /Users/guanbear/.octoclaw/nightly-eval-config.json \
  --output-dir /Users/guanbear/.octoclaw/reports/nightly-eval \
  --schedule-hour 2
```

This creates `~/Library/LaunchAgents/ai.octoclaw.nightly-eval.plist` and loads it via `launchctl load`.

### Uninstallation

```bash
octoclawctl nightly-eval uninstall-launchagent
```

Unloads and removes the plist. Tolerates missing or already-unloaded agents.

### Logs

- stdout: `<logDir>/nightly-eval-stdout.log`
- stderr: `<logDir>/nightly-eval-stderr.log`
- Default log dir: `~/Library/Logs/octoclaw/`

## Safety Boundaries

- **No live mutation**: Does not modify policy, config, or route rules
- **No promotion**: All outputs are reports/recommendations only
- **No multi-agent**: Does not enable ClawTeam/tmux or multi-agent defaults
- **No runtime loop**: Scheduling is external (launchd), not inside OpenClaw runtime
- **Opt-in**: Requires explicit config path and output directory
- **Fail closed**: Missing config, malformed JSON, or missing required fields fail before any evaluation runs
- **Secret redaction**: All artifacts strip tokens, passwords, and API keys
- **Transcript stripping**: No raw child transcripts, worker CoT, or execution logs in artifacts

## Slack Delivery

`octoclawctl nightly-eval deliver-slack` sends a compact report-only summary of the latest `*-nightly-eval.json` artifact to the Slack target defined by a Slack acceptance config.

```bash
octoclawctl nightly-eval deliver-slack \
  --config /Users/guanbear/.openclaw/octoclaw-slack-acceptance-config.json \
  --output-dir /Users/guanbear/.openclaw/reports/nightly-eval
```

Delivery behavior:

- Reads the newest timestamped `*-nightly-eval.json` from the report directory.
- Uses `botTokenEnv` from the Slack acceptance config for report delivery; inline tokens are not accepted.
- Keeps `userTokenEnv` acceptance-prompt tokens out of report delivery so scheduled reports remain bot-authored.
- Sends only a compact sanitized summary: overall gate, step statuses, highlights, and local report path.
- Does not send raw transcripts, worker chain-of-thought, secrets, or execution logs.
- Does not mutate live policy, promote recommendations, or trigger self-tuning.

For scheduled delivery, keep the token in a local `600` permission env file and invoke `nightly-eval deliver-slack` after `nightly-eval run` from the LaunchAgent wrapper.
