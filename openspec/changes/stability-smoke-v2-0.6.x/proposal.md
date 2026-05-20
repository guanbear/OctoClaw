# Change: Stability Smoke v2

Date: 2026-05-20
Target release: v0.6.x

## Purpose

Replace the old Slack smoke/nightly shape with a stability-focused acceptance system. The new suite should verify that OctoClaw's user-visible Slack behavior and supporting replay evidence match the current architecture: streaming, ACKs, delegation, native child finals, footer truth, router model selection, wizard behavior, provider fallback, and restart-window handling.

This change keeps live routing behavior unchanged. It improves the test, report, scheduling, and AI review loop around the existing system.

## Problem

The current nightly and Slack acceptance checks are useful but dated:

- The default Slack acceptance case list is small and partially legacy.
- Recent fixes for native final delivery, ACK timing, footer model truth, provider 402 handling, and read-only command escalation were covered by ad hoc smoke runs rather than a maintained suite.
- Nightly replay lanes classify many of the right events, but the live Slack smoke does not enforce the same contracts.
- Nightly AI review sees generic pass/fail summaries rather than structured stability failure packets.
- The scheduled job is still shaped around route/judge quality more than operational stability.

## Scope

### WP-A: Stability Case Schema And Catalog

- Add a case-pack schema that supports live Slack, synthetic fixture, replay-only, router-model, wizard, and provider cases.
- Add a fixed catalog for post-deploy, nightly, and weekly packs.
- Add severity, tags, expected evidence, and failure-code mapping.

### WP-B: Slack Acceptance Evidence Assertions

- Extend Slack acceptance to assert footer/replay fields directly.
- Add model expectation resolution from current OpenClaw/router state.
- Add ACK/thread/streaming/delegate/native-final contracts as first-class assertions.

### WP-C: Synthetic And Replay Stability Lanes

- Add synthetic fixtures for known ACK, spawn, final, footer, wizard, provider, and restart failures.
- Produce normalized failure packets.
- Reuse existing nightly lanes where possible instead of rebuilding replay classification.

### WP-D: AI Case Selection And Review

- Add GLM-5.1 based case-pack generation from recent replay, reports, commits, and current config.
- Escalate only ambiguous/high-risk reviews to GPT-5.5.
- Update AI review to classify failures as `runtime_bug`, `smoke_spec_bug`, or `environment_issue`.

### WP-E: OpenClaw Scheduled Orchestration

- Add or wire `octoclawctl stability` commands for post-deploy, nightly, weekly, review-latest, and fix-draft.
- Prefer OpenClaw scheduled tasks for nightly orchestration.
- Keep macOS launchd compatibility only as a fallback wrapper if still needed.

## Non-Goals

- Do not change router live policy, model selection, ACK behavior, streaming behavior, or delegate runtime behavior in this change.
- Do not add a new task engine or new live truth source.
- Do not automatically mutate OpenClaw model fallback order.
- Do not make AI-generated case packs authoritative without schema validation.
- Do not store Slack tokens, API keys, raw transcripts, full prompts, or full responses in reports.
- Do not automatically commit, push, or deploy fixes from nightly.

## Acceptance Gate

This change is complete when:

- [ ] Post-deploy smoke runs a small live Slack pack and blocks on core stability failures.
- [ ] Nightly stability runs live selected cases, synthetic fixtures, replay classification, router model consistency, and AI review.
- [ ] Weekly full acceptance can run broader wizard/provider/restart/failure-injection scenarios.
- [ ] Reports contain normalized failure codes and structured failure packets.
- [ ] AI review uses GLM-5.1 by default and GPT-5.5 only for escalation.
- [ ] OpenClaw scheduled tasks can invoke the nightly workflow and post a compact Slack summary.
- [ ] Known recent regressions are represented in BDD scenarios.
- [ ] `pnpm check && pnpm test` passes, or unrelated pre-existing failures are documented with targeted green tests.

## Risk Notes

- Live Slack smoke can be flaky if it asserts answer wording too strongly. Keep gates structural and evidence-backed.
- AI-generated cases can drift. Validate generated case packs against schema and cap live Slack volume.
- Synthetic fixtures can become stale if replay event schema changes. Tests must fail clearly on schema mismatch.
- Provider failure tests must use controlled simulation unless explicitly configured for live probing.

