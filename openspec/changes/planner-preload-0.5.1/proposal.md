# Change: OctoClaw 0.5.1 Planner Preload And Soft-Budget Recovery

## Purpose

Improve post-0.5.0 planner/native responsiveness without weakening the native `sessions_spawn` planner/confirm correctness boundary.

0.5.1 has three immediate goals:

- Fix SR-P1 budgeted-main behavior so the 30s budget is a soft execution budget, not a hard redirect that breaks simple replies or one-step lookups.
- Keep the feature-flagged Scheme B speculative preload slice default-off; it was useful for probing but Slack warm-session evidence did not prove acceptable task-start latency.
- Re-prioritize responsiveness work toward OpenClaw prep performance after Slack warm-session probes showed insufficient latency benefit: first collect OctoClaw coarse prep benchmark evidence, then use OpenClaw 2026.5.4 prep-stage logs and pursue the remaining upstream surfaces, worker `toolsAllow` propagation, tool schema cache, and finally system prompt lazy/cache.

## Scope

- P0: SR-P1 budgeted-main soft timeout recovery.
- P1: Scheme B feature-flag implementation, default off.
- P2: Real Slack live validation for Scheme B latency, native announce delivery, footer provenance, and duplicate/timeout guards.
- P3: OpenClaw prep performance evidence and upstream design: OctoClaw replay coarse timing, 2026.5.4 rebaseline, upstream exposure of existing embedded run prep stages to hook/meta surfaces, worker `toolsAllow` propagation, tool schema cache design, system prompt lazy/cache design.
- P4: Rollout decision after live evidence; optional allowlist or default enablement only after P2 passes.

## Non-Goals

- No Scheme A persistent standby session pool in 0.5.1.
- No direct import of OpenClaw internal spawn modules.
- No `api.runtime.subagent.run()` as the main path.
- No accepted delegate ACK before native accepted run evidence and `octoclaw_dispatch_confirm`.
- No keyword-based routing or user-text-only speculative preload trigger.
- No default enablement of speculative preload without live Slack evidence.
- No broad judge rewrite.
- No non-Slack IM delivery expansion in this change.
- No production tool schema or prompt cache before benchmark evidence and cache-key tests exist.
- No OpenClaw-core behavior changes in the first upstream PR; start with observability-only `prepMetrics`.

## Acceptance Gate

A 0.5.1 slice is acceptable only when:

- It preserves the 0.5.0 strict planner/confirm state machine: `planned -> spawn_call_started -> accepted`; never `planned -> accepted`.
- It preserves WorkContract as metadata/semantic truth and OpenClaw native run/session state as execution truth.
- It records replay events for budget escalation, speculative preload hint/spawn, `sessions_send` gate allow/block, confirm, ACK, and final delivery where applicable.
- It keeps Scheme B behind `OCTOCLAW_SPECULATIVE_PRELOAD=1` or explicit `pluginConfig.speculativePreload=true` until live validation passes.
- It proves locally that ordinary `sessions_spawn` and speculative `sessions_send` intents cannot mask each other.
- It includes Slack live artifacts before any rollout/default-enable task is marked complete.
- It records prep-performance plans in `docs/openclaw-prep-performance-upstream-design-2026-05-06.md`, keeps the local OpenClaw 2026.5.4 baseline explicit, and does not treat warm pool as the primary 0.5.1 latency fix for Slack.
