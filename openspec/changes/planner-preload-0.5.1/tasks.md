# Tasks

## PC0 OpenSpec Setup

- [x] Create this 0.5.1 change with `proposal.md`, `design.md`, `tasks.md`, and `specs/planner-preload/spec.md`.
- [x] Keep P0/P1/P2/P3 scope, non-goals, rollout gates, and verification commands aligned across the OpenSpec files.
- [x] Map implemented code slices back to this task list before commit.
- [ ] Do not mark live Scheme B validation complete until real Slack artifacts prove the full native `sessions_send` path.

## P0 SR-P1 Soft-Budget Recovery

- [x] Treat the fixed 30s value as a soft runtime budget, not a hard prompt-injection redirect.
- [x] Record pending timeout but allow late final without spawn.
- [x] Allow one lightweight read-only tool after timeout.
- [x] Treat `skills/*/SKILL.md` reads as budget-neutral preparation.
- [x] Escalate only on write/long/multi-step/test/build/review/validation or a second real read-only tool.
- [x] Preserve accepted ACK semantics: no "task started" before native accepted result plus confirm.
- [x] Tests: `extension-entry.test.ts` budgeted-main soft timeout, late read-only, skill-read neutral, second read-only escalation.

## P1 Scheme B Feature-Flag Implementation

- [x] Add `OCTOCLAW_SPECULATIVE_PRELOAD=1` config resolver; default off.
- [x] Support explicit `pluginConfig.speculativePreload=true` so controlled live smokes do not depend on transient LaunchAgent env propagation.
- [x] Add speculative preload helper for label, standby spawn args, hint text, state serialization, and `sessions_send` args.
- [x] Inject `OCTOCLAW_SPECULATIVE_SPAWN_HINT` only for runtime delegate decisions, not user-text keywords.
- [x] Allow only exact matching standby `sessions_spawn(mode="session", thread=true, context="isolated", lightContext=true)` through the speculative whitelist.
- [x] Extend `NativeSpawnIntent` with `dispatchMode` and `speculativeSessionLabel`.
- [x] Keep ordinary `sessions_spawn` gate restricted to `dispatchMode=new_spawn`.
- [x] Add `sessions_send` gate restricted to `dispatchMode=send_to_speculative`.
- [x] Make `octoclaw_dispatch` return `dispatchMode=send_to_speculative` and `sessionsSendArgs` only after `after_tool_call` marks standby `ready`; call-start-only or failed standby falls back to `new_spawn`.
- [x] Preserve confirm/ACK fail-closed behavior for both new-spawn and send-to-speculative modes.
- [x] Tests: speculative hint injection, standby spawn allow/block, standby accepted/failed result tracking, `sessions_send` pending intent gate, dispatch `send_to_speculative`, fallback to `new_spawn`, dispatch-mode gate separation.

## P2 Live Slack Validation

- [x] Temporarily enable speculative preload in the gateway plugin config for a controlled Slack smoke.
- [x] Run a real Slack planner-native delegate smoke on `agent:main:slack:channel:c0as4dappu3`.
- [x] Capture artifact fields: neutralAckMs, acceptedAckMs, taskStartMs, finalMs, decision bucket, spawn/send gate events, confirm event, native intent accepted, WorkContract refs, footer via, duplicate final count, `completion_file_timeout`.
- [ ] Prove Scheme B path: `speculative_preload_hint_injected -> speculative_preload_spawn_allowed -> speculative_preload_spawn_ready -> dispatchMode=send_to_speculative -> sessions_send_intent_allowed -> dispatch_confirm_completed ok=true`.
- [x] Restore default-off flag after validation unless P3 explicitly approves an allowlist.

Attempt notes:

- 2026-05-05 attempt `/tmp/octoclaw-051-spec-preload-20260505T031657Z` was stopped after producing no report and no Scheme B replay events. Replay showed DM `reply/budgeted_main_then_delegate` events instead of `speculative_preload_*` / `sessions_send`; this is not accepted P2 evidence. The launchctl flag was unset and gateway restarted.
- 2026-05-05 attempt `/tmp/octoclaw-051-spec-preload-20260505T033234Z` used the Slack acceptance user token and reached channel `C0AS4DAPPU3` with `route=delegate` / `decision_bucket=must_delegate`, but did not produce `speculative_preload_hint_injected`. `octoclaw_dispatch` then failed with `blocked_by_recent_delegated_execution_guard:recent_delegated_without_new_work_ticket`. This is not accepted P2 evidence; follow-up patch added pluginConfig flag support and inconsistent delegate/new-work repair.
- 2026-05-05 attempt `/tmp/octoclaw-051-spec-preload-20260505T041647Z` reached `dispatchMode=send_to_speculative`, but replay/session logs showed the speculative `sessions_spawn(mode="session")` returned an OpenClaw channel binding error before `octoclaw_dispatch`; the old implementation treated call-start as ready and then blocked `sessions_send` by hash mismatch. This is not accepted P2 evidence; follow-up patch requires `after_tool_call` accepted result before `ready`, includes `agentId` in `sessionsSendArgs`, and fails closed to `new_spawn` when standby is failed or unsupported.
- 2026-05-05 attempt `/tmp/octoclaw-051-spec-preload-20260505T045934Z` proved fail-soft fallback after the `ready` hardening: real Slack thread `1777957174.840009`, WorkContract `wc-35688563ada5b134`, spawn intent `nsp_mos5v2mj_56832d8c`, runId `2f2544da-7880-4294-ab99-986ccca45350`, child session `agent:main:subagent:20454009-7f22-4447-9d20-97203e81281a`. Replay showed `dispatch_mode=new_spawn`, `sessions_spawn_intent_allowed`, `dispatch_confirm_completed ok=true`, `native_announce_final_delivered`, footer `via=native_announce`, delivery transport `slack_api`, target source `inbound_anchor`, footer source `envelope`, `completion_file_timeout=0`, duplicate final `0`. Harness overall gate failed only because accepted ACK arrived after the 120s harness window; runtime planner/confirm/final path succeeded. This is not accepted Scheme B `sessions_send` evidence.

## P3 OpenClaw Prep Performance Upstream Track

- [x] Add upstream-facing design doc: `docs/openclaw-prep-performance-upstream-design-2026-05-06.md`.
- [ ] Implement OctoClaw-only coarse prep benchmark replay event: `prePromptBuildMs`, `postPromptPreLlmMs`, `llmMs`, `visibleElapsedMs`.
- [ ] Extend nightly classifier/report with p50/p95 for coarse prep timing by route bucket, channel, and agent lane.
- [ ] Draft upstream OpenClaw PR 1: observability-only prep stages on embedded run metadata / `agent_end`, reusing existing `createEmbeddedRunStageTracker()` and `prepStages.mark("bundle-tools" | "system-prompt" | "stream-setup")`.
- [ ] Validate PR 1 has no behavior changes, no prompt/tool output changes, no user text/secrets in trace output, and disabled/zero-overhead default behavior.
- [ ] After PR 1 evidence, draft upstream OpenClaw PR 2: memory-only tool schema cache with conservative cache key, invalidation tests, and kill switch.
- [ ] Only after tool schema evidence, draft upstream OpenClaw PR 3/4: system prompt fragment stability contract, stable prompt cache, and conservative lazy fragment selection behind flags.
- [ ] Keep Slack warm pool / Scheme B default-off unless real evidence proves `sessions_send` latency benefit.

## P4 Rollout Decision

- [ ] Decide default-off, allowlist, or default-on using P2 evidence.
- [ ] If enabled beyond local validation, document rollback: unset `OCTOCLAW_SPECULATIVE_PRELOAD` and restart gateway.
- [ ] Do not start Scheme A pool work until Scheme B live evidence is stable.

## Verification

- [x] `git diff --check`
- [x] `./node_modules/.bin/tsc --build extensions/octoclaw-runtime/tsconfig.json --pretty false`
- [x] `./node_modules/.bin/vitest run extensions/octoclaw-runtime/src/extension-entry.test.ts extensions/octoclaw-runtime/src/tools/registration-planner.test.ts extensions/octoclaw-runtime/src/delegate/native-spawn-gate-confirm.test.ts extensions/octoclaw-runtime/src/delegate/native-spawn-intent.test.ts`
- [x] `./node_modules/.bin/vitest run extensions/octoclaw-runtime/src/extension-entry-neutral-ack.test.ts extensions/octoclaw-runtime/src/resolve/policy-resolver-judge-fallback.test.ts extensions/octoclaw-runtime/src/tools/registration-dispatch-honesty.test.ts extensions/octoclaw-runtime/src/fast-delegate/probe.test.ts extensions/octoclaw-runtime/src/fast-delegate/no-double-judge.test.ts extensions/octoclaw-runtime/src/fast-delegate/draft.test.ts`
- [x] `./node_modules/.bin/vitest run extensions/octoclaw-runtime/src/extension-entry.test.ts extensions/octoclaw-runtime/src/resolve/policy-resolver-judge-fallback.test.ts extensions/octoclaw-runtime/src/tools/registration-planner.test.ts tools/octoclawctl/src/cli.test.ts`

## Commits

- [x] `9ae92dd feat(runtime): add speculative preload planner slice`
- [x] `aa37aaa docs(openspec): add 0.5.1 planner preload change`
