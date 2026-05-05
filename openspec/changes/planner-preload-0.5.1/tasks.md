# Tasks

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
- [x] Add speculative preload helper for label, standby spawn args, hint text, state serialization, and `sessions_send` args.
- [x] Inject `OCTOCLAW_SPECULATIVE_SPAWN_HINT` only for runtime delegate decisions, not user-text keywords.
- [x] Allow only exact matching standby `sessions_spawn(mode="session", thread=true, context="isolated", lightContext=true)` through the speculative whitelist.
- [x] Extend `NativeSpawnIntent` with `dispatchMode` and `speculativeSessionLabel`.
- [x] Keep ordinary `sessions_spawn` gate restricted to `dispatchMode=new_spawn`.
- [x] Add `sessions_send` gate restricted to `dispatchMode=send_to_speculative`.
- [x] Make `octoclaw_dispatch` return `dispatchMode=send_to_speculative` and `sessionsSendArgs` when a standby session has started.
- [x] Preserve confirm/ACK fail-closed behavior for both new-spawn and send-to-speculative modes.
- [x] Tests: speculative hint injection, standby spawn allow/block, `sessions_send` pending intent gate, dispatch `send_to_speculative`, dispatch-mode gate separation.

## P2 Live Slack Validation

- [ ] Temporarily enable `OCTOCLAW_SPECULATIVE_PRELOAD=1` in the gateway environment for a controlled Slack smoke.
- [ ] Run a real Slack planner-native delegate smoke on `agent:main:slack:channel:c0as4dappu3`.
- [ ] Capture artifact fields: neutralAckMs, acceptedAckMs, taskStartMs, finalMs, decision bucket, spawn/send gate events, confirm event, native intent accepted, WorkContract refs, footer via, duplicate final count, `completion_file_timeout`.
- [ ] Prove Scheme B path: `speculative_preload_hint_injected -> speculative_preload_spawn_allowed -> dispatchMode=send_to_speculative -> sessions_send_intent_allowed -> dispatch_confirm_completed ok=true`.
- [ ] Restore default-off flag after validation unless P3 explicitly approves an allowlist.

## P3 Rollout Decision

- [ ] Decide default-off, allowlist, or default-on using P2 evidence.
- [ ] If enabled beyond local validation, document rollback: unset `OCTOCLAW_SPECULATIVE_PRELOAD` and restart gateway.
- [ ] Do not start Scheme A pool work until Scheme B live evidence is stable.

## Verification

- [x] `git diff --check`
- [x] `./node_modules/.bin/tsc --build extensions/octoclaw-runtime/tsconfig.json --pretty false`
- [x] `./node_modules/.bin/vitest run extensions/octoclaw-runtime/src/extension-entry.test.ts extensions/octoclaw-runtime/src/tools/registration-planner.test.ts extensions/octoclaw-runtime/src/delegate/native-spawn-gate-confirm.test.ts extensions/octoclaw-runtime/src/delegate/native-spawn-intent.test.ts`
- [x] `./node_modules/.bin/vitest run extensions/octoclaw-runtime/src/extension-entry-neutral-ack.test.ts extensions/octoclaw-runtime/src/resolve/policy-resolver-judge-fallback.test.ts extensions/octoclaw-runtime/src/tools/registration-dispatch-honesty.test.ts extensions/octoclaw-runtime/src/fast-delegate/probe.test.ts extensions/octoclaw-runtime/src/fast-delegate/no-double-judge.test.ts extensions/octoclaw-runtime/src/fast-delegate/draft.test.ts`

## Commits

- [x] `9ae92dd feat(runtime): add speculative preload planner slice`
