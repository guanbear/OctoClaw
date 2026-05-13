# Tasks

## Slice A — ACK Scheduler

Owner: implementation, Codex review.

Write scope:

- `extensions/octoclaw-runtime/src/ack/ack-scheduler.ts` (new)
- `extensions/octoclaw-runtime/src/ack/ack-scheduler.test.ts` (new)
- `extensions/octoclaw-runtime/src/extension-entry.ts` (imports + call-site rewrites)

Tasks:

- [ ] Create `ack-scheduler.ts` with all four timer Maps and the key helpers.
- [ ] Move `LATENCY_ACK_DELAY_MS` into the scheduler.
- [ ] Add `AckScheduler.resetForTests()` clearing every Map.
- [ ] Replace `extension-entry.ts` inline calls with `AckScheduler.*`.
- [ ] Unit test: schedule + cancel round-trip; reset clears state.

Acceptance:

- [ ] `pnpm check`
- [ ] `pnpm vitest run extensions/octoclaw-runtime/src/ack/`
- [ ] `pnpm test` matches the baseline failure count (6 pre-existing, see improvement plan appendix B).
- [ ] `extension-entry.ts` line count drops by ≥ 80.

## Slice B — Footer Mode

Owner: implementation, Codex review.

Write scope:

- `extensions/octoclaw-runtime/src/im/footer-mode.ts` (new)
- `extensions/octoclaw-runtime/src/im/footer-mode.test.ts` (new)
- `extensions/octoclaw-runtime/src/extension-entry.ts`

Tasks:

- [ ] Extract `resolveFooterMode(pluginConfig)` into `footer-mode.ts`.
- [ ] Preserve `OCTOCLAW_FOOTER_DEBUG` and `OCTOCLAW_REPLY_PROJECTION_FOOTER` legacy env parsing unchanged.
- [ ] Unit tests cover off / compact / debug matrix with legacy env overrides.
- [ ] Replace inline call sites in `extension-entry.ts`.

Acceptance:

- [ ] `pnpm check`
- [ ] `pnpm test` matches baseline.
- [ ] `rg "OCTOCLAW_FOOTER_DEBUG" extensions/octoclaw-runtime/src/extension-entry.ts` returns nothing.

## Slice C — Delegation System Context

Owner: implementation, Codex review.

Write scope:

- `extensions/octoclaw-runtime/src/delegate/system-context.ts` (new)
- `extensions/octoclaw-runtime/src/extension-entry.ts`

Tasks:

- [ ] Move `OCTOCLAW_DELEGATION_SYSTEM_CONTEXT`, `OCTOCLAW_DELEGATION_SLIM_SYSTEM_CONTEXT`, and `resolveSlimMainContextEnabled` into `system-context.ts`.
- [ ] Replace imports in `extension-entry.ts`.

Acceptance:

- [ ] `pnpm check`
- [ ] `pnpm test` matches baseline.
- [ ] `rg "OCTOCLAW_DELEGATION_SYSTEM_CONTEXT" extensions/octoclaw-runtime/src/extension-entry.ts` returns nothing.

## Slice D — Speculative Preload Handler

Owner: implementation, Codex review.

Write scope:

- `extensions/octoclaw-runtime/src/delegate/speculative-preload-handler.ts` (new)
- `extensions/octoclaw-runtime/src/delegate/speculative-preload-handler.test.ts` (new)
- `extensions/octoclaw-runtime/src/extension-entry.ts`

Tasks:

- [ ] Extract speculative preload branch from `before_tool_call` into a single function.
- [ ] Return `{ handled: true, response }` when intercepting; `{ handled: false }` otherwise.
- [ ] Move related helpers (speculative-preload state parsing, spawn matcher, alias resolver) alongside.
- [ ] Unit tests for hit / miss / alias / stale states.

Acceptance:

- [ ] `pnpm check`
- [ ] `pnpm vitest run extensions/octoclaw-runtime/src/delegate/`
- [ ] `pnpm test` matches baseline.
- [ ] Slack smoke: speculative preload turn dispatches once.

## Slice E — Per-Hook Files

Owner: implementation, Codex review.

Write scope:

- `extensions/octoclaw-runtime/src/hooks/before-prompt-build.ts` (new)
- `extensions/octoclaw-runtime/src/hooks/before-tool-call.ts` (new)
- `extensions/octoclaw-runtime/src/hooks/before-model-resolve.ts` (new)
- `extensions/octoclaw-runtime/src/hooks/after-tool-call.ts` (new)
- `extensions/octoclaw-runtime/src/hooks/agent-end.ts` (new)
- `extensions/octoclaw-runtime/src/extension-entry.ts` (thin composition)

Tasks:

- [ ] Move each hook body into its own file as a `make<HookName>Hook(pi)` factory.
- [ ] `extension-entry.ts` ends as `register(pi)` registering each factory.
- [ ] No behaviour change.
- [ ] Delete any inline helpers that are now single-use inside a moved hook.

Acceptance:

- [ ] `pnpm check`
- [ ] `pnpm test` matches baseline.
- [ ] `extension-entry.ts` < 1000 lines.
- [ ] No new hook file > 400 lines.
- [ ] Slack smoke: one reply turn + one delegate turn + one status follow-up.

## WP-F Final Verification

Owner: operator, Codex review.

- [ ] `rg "^export.*from.*extension-entry" extensions/` returns no new results after all slices.
- [ ] `rg "new Map<string, " extensions/octoclaw-runtime/src/extension-entry.ts` returns no timer maps.
- [ ] `wc -l extensions/octoclaw-runtime/src/extension-entry.ts` < 1000.
- [ ] No new `any` types introduced (grep `: any` before/after).
- [ ] `pnpm test` matches baseline failure count.

## Hard Invariants

- No behaviour change.
- No change to plugin register API.
- No change to ACK timing constants or priorities.
- No new dependency cycles.
- Module-scoped state stays module-scoped (no class conversion).
