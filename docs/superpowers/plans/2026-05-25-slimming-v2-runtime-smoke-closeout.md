# Slimming V2 Runtime Smoke Closeout

Date: 2026-05-25
Branch: `v0.6.0`

## Scope

This closeout covers the runtime-facing checks after native-first slimming v2:

- GitHub Actions JavaScript action runtime compatibility with Node 24.
- Post-deploy stability smoke coverage for user-visible Slack paths.
- Explicit distinction between automated local evidence and live Slack evidence.

## CI Node 24 Action Runtime

The project test runtime already uses `node-version: "22"`. The GitHub Actions
warning came from action implementations (`actions/checkout`, `actions/setup-node`,
`pnpm/action-setup`, Pages actions) running on GitHub's deprecated Node 20 action
runtime.

Mitigation:

- `.github/workflows/test.yml` sets `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true`.
- `.github/workflows/publish-capability-snapshot.yml` sets
  `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true`.

Acceptance:

- Push CI must pass with the env flag enabled.
- Publish Capability Snapshot must be manually dispatched once after the change,
  because that workflow is schedule/dispatch only and is not triggered by push.

Evidence:

- Push CI passed on commit `73c4fd61cb`.
- GitHub Actions annotated the run with
  `Node 20 actions are being forced to run on Node 24`, proving the workflow
  opt-in is active.
- Publish Capability Snapshot was manually confirmed green after the workflow
  change.

## Automated Runtime Smoke

Command:

```bash
node tools/octoclawctl/dist/cli.js stability post-deploy --output-dir /tmp/octoclaw-slimming-v2-smoke --format json
```

Result from the 2026-05-25 closeout run:

- Report:
  `/tmp/octoclaw-slimming-v2-smoke/stability-smoke-v2/2026-05-25-12-48-08-stability-report.json`
- Overall gate: `unknown`
- `synthetic_fixtures`: `pass`
- `provider_resilience`: `pass`
- `slack_delivery`: `unknown`
- Live skip reason: `missing_slack_env`

The `unknown` overall gate is expected for this local environment because live
Slack acceptance env vars were not available. It is not a runtime regression by
itself; it means the user-visible Slack lane still needs a real environment run.

## Slack Live Checklist

Run this when Slack acceptance credentials and a target channel/thread are
configured:

```bash
set -a
source ~/.openclaw/octoclaw-slack-acceptance.env
set +a
node tools/octoclawctl/dist/cli.js stability post-deploy \
  --config ~/.openclaw/octoclaw-slack-acceptance-config.json \
  --output-dir ~/.openclaw/reports \
  --format json
```

Required live case expectations:

- `reply_core.simple_chat`: final reply appears in Slack and compact footer is
  present for the final result.
- `streaming_core.long_reply`: no misleading ACK text appears during streaming.
- `delegate_core.native_final`: delegated run has accepted spawn/native evidence,
  final delivery is native announce, and footer includes `via=native_announce`.
- `footer_truth.current_model`: footer model matches replay/provenance evidence.
- `status_core.read_only`: read-only status check does not create a delegated
  child task.

Non-final sends must remain footer-free:

- neutral ACK
- route commit ACK
- status cards
- onboarding/wizard sends
- native delivery internals before final delivery

Pass criteria:

- Overall gate is `pass`.
- No `delegate_footer_without_spawn`.
- No `parent_echo_after_native_final`.
- No `native_spawn_redispatch_after_mismatch`.
- No `environment_unhealthy` failures.

Evidence from the 2026-05-25 live Slack run:

- Report:
  `/Users/guanbear/.openclaw/reports/stability-smoke-v2/2026-05-25-13-42-24-stability-report.json`
- Summary:
  `/Users/guanbear/.openclaw/reports/stability-smoke-v2/2026-05-25-13-42-24-stability-summary.txt`
- Overall gate: `pass`
- Failure count: `0`
- Lanes: `slack_delivery=pass`, `synthetic_fixtures=pass`,
  `provider_resilience=pass`
- Passed live cases: `reply_core.simple_chat`, `streaming_core.long_reply`,
  `delegate_core.native_final`, `footer_truth.current_model`,
  `status_core.read_only`

## Operator Quick Check

After deploy, the minimum operator read is:

```bash
node tools/octoclawctl/dist/cli.js stability review-latest \
  --output-dir ~/.openclaw/reports
```

Expected green shape:

```text
Review: ~/.openclaw/reports/stability-smoke-v2/<timestamp>-stability-report.json
Gate: pass
Lanes: slack_delivery=pass synthetic_fixtures=pass provider_resilience=pass
Failures (0):
```

If a deploy used `--restart`, also check the deploy output includes:

- `Post-deploy stability: gate=pass`
- `Report: ~/.openclaw/reports/stability-smoke-v2/<timestamp>-stability-report.json`
- No `Skipped live:` line when Slack credentials were intentionally supplied.

The JSON report is the durable artifact. The summary text is the human-readable
operator handoff and is safe to paste into Slack because stability artifacts are
sanitized.

## Current Residual Gap

No Slimming V2 runtime smoke gap remains after the 2026-05-25 live Slack pass.
The remaining operational requirement is to keep Slack acceptance credentials
available only in the operator environment and rotate any token that was pasted
into chat or shell history.
