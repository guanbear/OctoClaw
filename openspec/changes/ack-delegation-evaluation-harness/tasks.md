# Tasks

## D1 Route Commit ACK

- [x] Add route-commit ACK decision/projection packet.
- [x] Dedupe by session/thread/turn/routeCommitId.
- [x] Record replay/telemetry for sent/skipped/duplicate outcomes.
- [x] Skip safely when no valid target exists without poisoning dedupe.
- [x] Test delegate/status/reply/no-target/dedupe/no-running wording.
- [x] Commit: `16fb3d7 feat: add truthful route commit ack`.

## D2 Execution ACK and Anomaly Notification

- [x] Add execution transition notifier over projected lifecycle facts.
- [x] Wire dispatch/materialization live path.
- [x] Wire materialized-without-spawn live anomaly.
- [x] Wire spawn-start and spawn-failure live paths.
- [x] Wire watchdog queued stale, heartbeat stale, and timeout paths.
- [x] Wire result-ready and delivery-failed live paths.
- [x] Persist replay/telemetry for sent/skipped/duplicate/failed outcomes.
- [x] Store compact parent-visible anomaly packet without transcript fields.
- [x] Test real dispatch, watchdog, result, delivery, dedupe, and sanitizer paths.
- [x] Build: `@octoclaw/contracts`, `@octoclaw/runtime`, `@octoclaw/runtime-core`.
- [x] Commit: `7af489b feat: add execution ack and anomaly notifications`.

## D3 Nightly Evaluation Harness

- [x] Define replay input schema for route/judge/ACK/delegation cases.
- [x] Produce nightly route-quality metrics and examples.
- [x] Include false delegate, false reply, unclear, ACK timing, and delivery failure lanes.
- [x] Output report only; no live policy mutation.
- [x] Sanitize samples — no raw child transcript in output.
- [x] Fail closed on malformed input; unknown never counts as pass.
- [x] Test route quality, ACK metrics, delegation health, sanitizer, report rendering, no-auto-promote.

## D4 Real Slack Acceptance Harness

- [ ] Locate or define explicit test bot/session config.
- [ ] Fail closed when config is missing.
- [ ] Test plain chat, delegated work, ledger follow-up, status reply, provenance guard, and Slack tool exposure audit.
- [ ] Keep test bot separate from production live path.

## D5 Calibration Gate

- [ ] Compare baseline vs candidate route/judge/model recommendations.
- [ ] Gate latency, cost, quality, acceptance, context pollution, fallback, and timeout metrics.
- [ ] Treat `unknown` as not pass.
- [ ] Emit recommendation and rollback target only; no online self-tuning.
