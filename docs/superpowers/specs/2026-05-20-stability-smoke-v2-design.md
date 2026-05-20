# OctoClaw Stability Smoke v2 Design

Date: 2026-05-20

## Goal

Rebuild OctoClaw's Slack smoke and nightly checks around operational stability, not only route accuracy. The new system should catch the failures users actually see in Slack: wrong or late ACKs, missing native child finals, misleading delegate footers, model-selection drift, wizard flow breakage, provider fallback failures, and restart-window message loss.

The system should use real Slack interactions selectively, synthetic/replay fixtures for broad coverage, and AI-assisted case selection/review to keep the nightly useful without turning it into a noisy long-running chat script.

## Current Problems

- The current Slack acceptance config is still centered on a small legacy 8-case suite.
- Nightly replay lanes already classify route, ACK, execution transition, delegation, and delivery, but the live Slack smoke is not organized around those stability contracts.
- Some recent fixes were only covered by ad hoc smoke configs, for example native child final delivery and delegate ACK timing.
- Nightly AI review exists, but its input summary is too generic. It can miss concrete failure classes such as `footer says delegate but no spawn evidence`.
- The current nightly job is closer to "did the judge route reasonably" than "did every user-visible feature behave according to contract".

## Principles

1. **Live Slack is scarce evidence.** Run real Slack only for high-value paths that prove the end-to-end integration.
2. **Synthetic fixtures provide breadth.** ACK/thread/final/footer/wizard/provider edge cases should be covered without needing every case to hit Slack.
3. **Replay is truth for diagnosis.** Slack text assertions must be backed by replay evidence: WorkContract, spawn intent, child session, transition events, footer metadata, delivery transport, and stage timings.
4. **AI selects and reviews, it does not define truth.** GLM-5.1 can curate cases and classify failures, but gates come from structured contracts.
5. **GPT-5.5 is escalation.** Use GLM-5.1 for routine case generation and review; use GPT-5.5 for ambiguous cross-report diagnosis or high-risk repair planning.
6. **Scheduled jobs are orchestration only.** OpenClaw scheduled tasks should invoke `octoclawctl` commands and persist artifacts; they should not embed evaluation logic.

## Architecture

Stability Smoke v2 has four stages:

1. **Case selection**
   - Read recent replay, recent Slack acceptance reports, current OpenClaw/router config, health snapshot, and recent commits.
   - GLM-5.1 builds a small daily case pack from a fixed catalog plus recent failures.
   - If the generated pack is invalid or confidence is low, retry or escalate review to GPT-5.5.

2. **Execution**
   - Post-deploy smoke runs a small live Slack pack.
   - Nightly stability runs selected live Slack cases, synthetic fixtures, replay classifiers, router/model consistency checks, and wizard state-machine checks.
   - Full acceptance runs every 3 days for longer wizard/provider/failure-injection flows.

3. **Scoring**
   - Produce a single stability report with lanes for Slack delivery, ACK, streaming, delegation, footer truth, router model choice, wizard, provider fallback, and replay health.
   - Gate blockers are structural contract failures, not minor answer wording differences.

4. **Review and repair**
   - Convert failures into structured packets with case id, thread ts, prompt hash, footer fields, work contract id, spawn intent id, child session, replay event ids, stage timings, and related commits.
   - AI review classifies each packet as `runtime_bug`, `smoke_spec_bug`, or `environment_issue`.
   - Automated Codex fix drafts are allowed only for small, evidence-backed `runtime_bug` items. Otherwise the job records blockers and next actions.
   - Fix drafts are local drafts only. They must not commit, push, deploy, restart Gateway, or mutate OpenClaw config.
   - If a draft changes more than 5 files, changes more than 300 lines, touches runtime delegate/ACK/router hot paths, or has failing validation, it is marked `needs_human_review` and stops.
   - Even a passing draft requires explicit user confirmation before Codex commits, deploys, or restarts anything.

## Case Packs

### Post-Deploy Smoke

Target duration: 5-8 minutes.

Required live cases:

- `reply_core.simple_chat`: Slack reply path returns in thread, no spawn, footer `route=reply`.
- `streaming_core.long_reply`: streaming/partial mode does not produce misleading ACK text.
- `delegate_core.native_final`: delegate ACK, native spawn evidence, native child final, footer `via=native_announce`.
- `footer_truth.current_model`: reported route/model/footer agree with replay evidence.
- `status_core.read_only`: status/read-only query does not escalate to delegate.

Any failure is a deploy blocker.

### Nightly Stability

Target duration: 30-60 minutes.

Runs:

- Post-deploy pack.
- AI-selected live Slack cases from recent risk areas.
- Synthetic ACK/thread/delivery/footer fixtures.
- Router model-choice matrix for simple/normal/deep complexities.
- Wizard state-machine fixtures and one lightweight live wizard entry/resume check.
- Provider failure simulation and health/fallback suggestion checks.
- Replay classifier over the last 24 hours.

### 3-Day Full Acceptance

Runs every 3 days and covers the broad suite:

- Full Slack wizard flow.
- Model discovery and proposal/acceptance analysis.
- Health cooldown and fallback suggestion scenarios.
- Restart-window and shutting-down behavior.
- Provider 402/429/timeout cases.
- Duplicate final and parent echo regression cases.

## Stability Lanes

- `slack_delivery`: message sent, thread target correct, no delivery API failure.
- `ack_contract`: neutral ACK and accepted ACK timing/thread/text are correct.
- `streaming_contract`: native streaming channels do not get conflicting status ACKs.
- `delegate_contract`: delegate claims require WorkContract, spawn intent, child session, and native final.
- `footer_truth`: route/model/via/worker/workContract/complexity match replay truth.
- `router_model_choice`: selected models match current router config, OpenClaw availability, health cooldown, and native fallback order.
- `wizard_contract`: Slack wizard starts, resumes, handles duplicate clicks, and remains non-blocking.
- `provider_resilience`: 402/429/timeout produce fallback or clear failure, never a bare provider error.
- `nightly_replay`: replay lanes for route, ACK, transition, delegation, and delivery remain healthy.

## Failure Taxonomy

The report should emit normalized failure codes:

- `ack_late`
- `ack_missing`
- `ack_wrong_thread`
- `misleading_ack`
- `streaming_ack_conflict`
- `delegate_footer_without_spawn`
- `spawn_missing`
- `native_final_missing`
- `native_final_wrong_footer`
- `duplicate_final`
- `parent_echo_after_native_final`
- `model_footer_mismatch`
- `router_model_mismatch`
- `wizard_flow_stuck`
- `wizard_idempotency_failed`
- `provider_no_fallback`
- `gateway_restart_drop`
- `smoke_spec_mismatch`
- `environment_unhealthy`

## Model Use

- GLM-5.1:
  - Daily case selection.
  - Failure packet summarization.
  - Routine AI review.
  - Suggested smoke-spec adjustments.
- GPT-5.5:
  - Ambiguous cross-report diagnosis.
  - High-impact repair planning.
  - Review of generated fixes when GLM confidence is low.

AI outputs must never override structured gates. They only explain, group, and recommend.

## OpenClaw Scheduling

Use OpenClaw scheduled tasks as the orchestrator:

- `octoclaw stability post-deploy`
- `octoclaw stability nightly`
- `octoclaw stability full --cadence 3d`
- `octoclaw stability review-latest`
- `octoclaw stability fix-draft`

The scheduled task runs `octoclawctl`, loads Slack credentials from the existing local env file, writes reports under `~/.openclaw/reports/stability-smoke-v2/`, and posts a compact Slack summary.

## Implementation Scope

Expected additions:

- A stability smoke config/case-pack schema.
- A case catalog with live, synthetic, replay, router, wizard, and provider cases.
- A case-pack generator using GLM-5.1 with GPT-5.5 fallback.
- Extensions to Slack acceptance assertions for footer/replay/model expectations.
- A stability report and failure packet format.
- Updated nightly orchestration script or `octoclawctl` subcommands.
- Updated AI review and fix-draft prompts.
- A confirmation gate so generated fixes are reviewed by the user before commit/deploy.

Non-goals:

- No runtime routing behavior change.
- No new live task engine.
- No automatic OpenClaw fallback mutation.
- No credential storage in reports.
- No automated fix commit/push from scheduled jobs.
- No automated deploy/restart from nightly or 3-day full acceptance.

## Acceptance

The change is ready when:

- Post-deploy smoke covers the core Slack user-visible paths and finishes under 8 minutes in normal conditions.
- Nightly stability produces a report that can explain ACK, delegate, footer, wizard, router model, provider, and replay failures separately.
- Synthetic fixtures cover known regressions from recent repairs.
- AI review produces actionable grouped findings without relying on raw transcripts or secrets.
- OpenClaw scheduling can run nightly and every-3-day full acceptance without macOS launchd-specific logic.
- AI review can generate repair drafts, but commit/deploy requires explicit user confirmation.
- Existing `pnpm check` and `pnpm test` remain green.
