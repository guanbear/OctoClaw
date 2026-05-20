# OctoClaw Stability Smoke v2 — Scheduled Task Setup

## Commands

| Command | Purpose | Schedule |
|---|---|---|
| `octoclawctl stability post-deploy` | Core live Slack smoke after deploy | On deploy |
| `octoclawctl stability nightly` | Mixed evidence stability run | Daily |
| `octoclawctl stability full --cadence 3d` | Broad acceptance suite | Every 3 days (default) |
| `octoclawctl stability review-latest` | Read and classify latest report failures | On demand |
| `octoclawctl stability fix-draft` | Guarded local fix draft for runtime bugs | On demand |

All commands accept `--output-dir <dir>` (required for run commands), `--config <config>`, and `--format json`. Run commands write three artifacts under `stability-smoke-v2/`: a full JSON report, a Markdown report, and a compact sanitized summary text file for scheduled Slack delivery.

## OpenClaw Scheduled Task Setup

### 1. Nightly

```bash
octoclawctl stability nightly \
  --output-dir ~/.openclaw/reports \
  --config ~/.openclaw/octoclaw-stability-config.json
```

Set `SLACK_BOT_TOKEN` and `SLACK_USER_TOKEN` in the scheduled task environment. If missing, live Slack cases are skipped as `environment_unhealthy` while synthetic, replay, router, wizard, and AI review lanes still run.

### 2. Full Acceptance (Every 3 Days)

```bash
octoclawctl stability full \
  --output-dir ~/.openclaw/reports \
  --cadence 3d \
  --config ~/.openclaw/octoclaw-stability-config.json
```

The `--cadence` flag accepts `Nd` (days), `Nh` (hours), `Nm` (minutes). Default is `3d`.

### 3. Post-Deploy Smoke

```bash
octoclawctl stability post-deploy \
  --output-dir ~/.openclaw/reports
```

Run after each deploy. Any blocker case failure is a deploy rollback signal.

### 4. Review and Fix

```bash
# Review the latest report
octoclawctl stability review-latest --output-dir ~/.openclaw/reports

# Generate a guarded fix draft (no commit/push/deploy/restart)
octoclawctl stability fix-draft --output-dir ~/.openclaw/reports
```

Fix-draft produces local guarded instructions only. It will never commit, push, deploy, restart Gateway, or mutate OpenClaw config.

## Migration from Old Nightly/Slack Acceptance Config

### Old Setup

```bash
octoclawctl nightly-eval run \
  --config ~/.openclaw/octoclaw-nightly-eval-config.json \
  --output-dir ~/.openclaw/reports
octoclawctl nightly-eval deliver-slack \
  --config ~/.openclaw/octoclaw-slack-acceptance-config.json \
  --output-dir ~/.openclaw/reports
```

### New Setup

Replace the nightly-eval + slack-acceptance pair with a single command:

```bash
octoclawctl stability nightly \
  --output-dir ~/.openclaw/reports
```

Key differences:

- **Single command** replaces two-step nightly-eval + deliver-slack.
- **Structured lanes** instead of a single report: Slack delivery, ACK contract, streaming, delegation, footer truth, router model choice, wizard, provider resilience, nightly replay, and AI review.
- **Missing Slack env is not fatal**: live Slack cases are skipped as `environment_unhealthy`, but synthetic/replay/router/wizard/AI lanes still run.
- **Sanitized reports**: reports are compact and contain no tokens, API keys, full prompts, or raw transcripts.
- **Cadence-aware full acceptance**: `stability full --cadence 3d` replaces ad-hac 3-day scheduling.

### Migration Steps

1. Keep existing nightly-eval config as backup. Stability Smoke v2 does not read it.
2. Set `SLACK_BOT_TOKEN` in the scheduled task environment (or remove it to run non-live lanes only).
3. Update the scheduled task command from `nightly-eval run` to `stability nightly`.
4. Replace the separate `nightly-eval deliver-slack` step with scheduled delivery of the generated `*-stability-summary.txt` artifact. The summary is compact and sanitized; the stability command itself does not store credentials or mutate Slack configuration.
5. Add a second scheduled task for `stability full --cadence 3d` every 3 days.

## Report Location

Reports are written under `<output-dir>/stability-smoke-v2/` with timestamps:

```
<output-dir>/stability-smoke-v2/
  2026-05-20T12-00-00-stability-report.json
  2026-05-20T12-00-00-stability-report.md
  2026-05-20T12-00-00-stability-summary.txt
```

## Safety Constraints

- Fix-draft never commits, pushes, deploys, restarts Gateway, or mutates OpenClaw config.
- Reports contain no Slack tokens, API keys, full prompts, or raw transcripts.
- Missing Slack credentials skip live cases gracefully; they do not fail the entire run.
- No new daemon or background worker is added. Scheduling is handled by OpenClaw tasks or system schedulers.
