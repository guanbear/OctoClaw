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

- [x] Locate or define explicit test bot/session config.
- [x] Fail closed when config is missing.
- [x] Test plain chat, delegated work, ledger follow-up, status reply, provenance guard, and Slack tool exposure audit.
- [x] Keep test bot separate from production live path.
- [x] Add CLI: `octoclawctl slack-acceptance --config <json> --output-dir <dir> [--format markdown|json]`.
- [x] Explicit Slack test bot/session config; missing config/token/target fails closed.
- [x] 7 cases: plain_chat, fresh_lookup, delegated_work, status_panel, provenance_followup, route_objection_correction, no_lie_materialized_no_spawn.
- [x] Pull Slack thread replies, measure ACK/final timing, content assertions.
- [x] Status/provenance/no-lie support replayPath no-spawn assertion.
- [x] Save sanitized JSON + Markdown artifacts; no secrets, no raw child transcript.
- [x] Slack-facing tool exposure audit: only message.send/update/react/typing allowed.
- [x] Mock Slack client tests, missing config fail closed, secret redaction, content assertion, no-spawn replay tests.
- [x] Document D4 CLI/config/safety usage.
- [x] Add OpenSpec requirement for real Slack acceptance harness.
- [x] 93 test files, 854 tests passing. Build clean.

## D5 Calibration Gate

- [x] Compare baseline vs candidate route/judge/model recommendations.
- [x] Gate latency, cost, quality, acceptance, context pollution, fallback, and timeout metrics.
- [x] Treat `unknown` as not pass.
- [x] Emit recommendation and rollback target only; no online self-tuning.
- [x] CLI: `octoclawctl calibration-gate --baseline <json> --candidate <json> --output-dir <dir> [--format markdown|json]`.
- [x] Input reads D3 nightly report AND D4 slack acceptance report; missing metrics → unknown, not pass.
- [x] CLI normalizes raw D3/D4 reports and aggregate wrapper inputs.
- [x] 6 calibration dimensions: latency, cost, acceptance, noLie, contextPollution, fallbackTimeout.
- [x] Cost dimension uses explicit `metrics.costUsd`; missing cost stays unknown, not pass.
- [x] Rollback target = explicit baseline rollback target or baseline report ID when gate passes; null otherwise.
- [x] Pure gate function — no I/O, no API calls, no config mutation, no live promotion.
- [x] Save sanitized JSON + Markdown report artifacts.
- [x] 27 calibration tests + 8 CLI parse tests. 94 test files, 889 tests passing. Build clean.

## D6 Nightly Evaluation Scheduler

- [x] CLI: `octoclawctl nightly-eval run --config <json> --output-dir <dir> [--format markdown|json]`.
- [x] Orchestrates D3 nightly, D4 slack acceptance (optional), D5 calibration gate (optional) in one run.
- [x] Config must specify replayPath; slackAcceptanceConfig/baseline/candidate optional.
- [x] Aggregate report with per-step pass/fail/unknown/skipped status, overall gate, recommendation.
- [x] Unknown never equals pass; all-skipped yields unknown.
- [x] Sanitized aggregate artifacts (JSON + Markdown) with secret redaction and transcript stripping.
- [x] Mac LaunchAgent support: `install-launchagent`, `uninstall-launchagent`, `print-plist`.
- [x] LaunchAgent is opt-in, requires explicit config path and output dir.
- [x] LaunchAgent runs `octoclawctl nightly-eval run` on schedule, stdout/stderr log to configurable dir.
- [x] No OpenClaw runtime cron/loop; external scheduling only.
- [x] No live policy mutation, no promotion, no default multi-agent.
- [x] 24 nightly-eval tests + 15 CLI parse tests. 95 test files, 928 tests passing. Build clean.
