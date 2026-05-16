# Tasks

## Archive note

All 5 planned slices + 3 additional extractions shipped in commit `d6d35ca71` on Fri May 16, 2026.
`extension-entry.ts` reduced from 3981 to 909 lines (77% reduction). 16 new files created, all under 400 lines.

Actual file paths differ slightly from the original spec (e.g. `hooks/` instead of `im/` for footer-mode, `hooks/` instead of `delegate/` for system-context and speculative-preload). The additional extractions beyond the original 5 slices were: outbound guards, outbound reply dispatch, native announce system (5 files), and budgeted-main lifecycle.

Nothing was deferred.

## Slice A — ACK Scheduler

Owner: implementation, Codex review.

Write scope:

- `extensions/octoclaw-runtime/src/ack/ack-scheduler.ts` (new)
- `extensions/octoclaw-runtime/src/ack/ack-scheduler.test.ts` (new)
- `extensions/octoclaw-runtime/src/extension-entry.ts` (imports + call-site rewrites)

Tasks:

- [x] Create `ack-scheduler.ts` with all four timer Maps and the key helpers.
- [x] Move `LATENCY_ACK_DELAY_MS` into the scheduler.
- [x] Add `AckScheduler.resetForTests()` clearing every Map.
- [x] Replace `extension-entry.ts` inline calls with `AckScheduler.*`.
- [x] Unit test: schedule + cancel round-trip; reset clears state.

Acceptance:

- [x] `pnpm check`
- [x] `pnpm vitest run extensions/octoclaw-runtime/src/ack/`
- [x] `pnpm test` matches the baseline failure count (6 pre-existing, see improvement plan appendix B).
- [x] `extension-entry.ts` line count drops by ≥ 80.

Shipped in prior commits. ACK Maps already in `ack/ack-scheduler.ts` before this change packet was created.

## Slice B — Footer Mode

Owner: implementation, Codex review.

Write scope:

- `extensions/octoclaw-runtime/src/hooks/footer-mode.ts` (new, 327 lines)
- `extensions/octoclaw-runtime/src/extension-entry.ts`

Tasks:

- [x] Extract `resolveFooterMode(pluginConfig)` into `footer-mode.ts`.
- [x] Preserve `OCTOCLAW_FOOTER_DEBUG` and `OCTOCLAW_REPLY_PROJECTION_FOOTER` legacy env parsing unchanged.
- [x] Unit tests cover off / compact / debug matrix with legacy env overrides.
- [x] Replace inline call sites in `extension-entry.ts`.

Acceptance:

- [x] `pnpm check`
- [x] `pnpm test` matches baseline.
- [x] `rg "OCTOCLAW_FOOTER_DEBUG" extensions/octoclaw-runtime/src/extension-entry.ts` returns nothing.

Shipped in commit `d6d35ca71`. Actual target: `hooks/footer-mode.ts`.

## Slice C — Delegation System Context

Owner: implementation, Codex review.

Write scope:

- `extensions/octoclaw-runtime/src/hooks/system-context.ts` (new, 53 lines)
- `extensions/octoclaw-runtime/src/extension-entry.ts`

Tasks:

- [x] Move `OCTOCLAW_DELEGATION_SYSTEM_CONTEXT`, `OCTOCLAW_DELEGATION_SLIM_SYSTEM_CONTEXT`, and `resolveSlimMainContextEnabled` into `system-context.ts`.
- [x] Replace imports in `extension-entry.ts`.

Acceptance:

- [x] `pnpm check`
- [x] `pnpm test` matches baseline.
- [x] `rg "OCTOCLAW_DELEGATION_SYSTEM_CONTEXT" extensions/octoclaw-runtime/src/extension-entry.ts` returns nothing.

Shipped in commit `d6d35ca71`. Actual target: `hooks/system-context.ts`.

## Slice D — Speculative Preload Handler

Owner: implementation, Codex review.

Write scope:

- `extensions/octoclaw-runtime/src/hooks/speculative-preload-handler.ts` (new, 141 lines)
- `extensions/octoclaw-runtime/src/extension-entry.ts`

Tasks:

- [x] Extract speculative preload branch from `before_tool_call` into a single function.
- [x] Return `{ handled: true, response }` when intercepting; `{ handled: false }` otherwise.
- [x] Move related helpers (speculative-preload state parsing, spawn matcher, alias resolver) alongside.
- [x] Unit tests for hit / miss / alias / stale states.

Acceptance:

- [x] `pnpm check`
- [x] `pnpm vitest run extensions/octoclaw-runtime/src/delegate/`
- [x] `pnpm test` matches baseline.
- [x] Slack smoke: speculative preload turn dispatches once.

Shipped in commit `d6d35ca71`. Actual target: `hooks/speculative-preload-handler.ts`.

## Slice E — Per-Hook Files

Owner: implementation, Codex review.

Write scope:

- `extensions/octoclaw-runtime/src/hooks/before-model-resolve.ts` (new, 110 lines)
- `extensions/octoclaw-runtime/src/hooks/after-tool-call.ts` (new, 111 lines)
- `extensions/octoclaw-runtime/src/hooks/agent-end.ts` (new, 199 lines)
- `extensions/octoclaw-runtime/src/hooks/message-lifecycle.ts` (new, 302 lines)
- `extensions/octoclaw-runtime/src/hooks/before-dispatch.ts` (new, 70 lines)
- `extensions/octoclaw-runtime/src/extension-entry.ts` (thin composition)

Plus additional extractions beyond the original spec:
- `extensions/octoclaw-runtime/src/resolve/outbound-guards.ts` (294 lines)
- `extensions/octoclaw-runtime/src/resolve/outbound-reply-dispatch.ts` (130 lines)
- `extensions/octoclaw-runtime/src/resolve/native-announce.ts` (369 lines)
- `extensions/octoclaw-runtime/src/resolve/native-announce-delivery.ts` (266 lines)
- `extensions/octoclaw-runtime/src/resolve/native-announce-parse.ts` (184 lines)
- `extensions/octoclaw-runtime/src/resolve/native-announce-state.ts` (225 lines)
- `extensions/octoclaw-runtime/src/resolve/native-announce-types.ts` (28 lines)
- Budgeted-main lifecycle appended to `budgeted-main.ts`

Tasks:

- [x] Move each hook body into its own file as a `make<HookName>Hook(pi)` factory.
- [x] `extension-entry.ts` ends as `register(pi)` registering each factory.
- [x] No behaviour change.
- [x] Delete any inline helpers that are now single-use inside a moved hook.

Acceptance:

- [x] `pnpm check`
- [x] `pnpm test` matches baseline.
- [x] `extension-entry.ts` < 1000 lines. (Final: **909 lines**)
- [x] No new hook file > 400 lines.
- [x] Slack smoke: one reply turn + one delegate turn + one status follow-up.

Shipped in commit `d6d35ca71`. Extraction went beyond original 5-slice plan: 16 new files total, extension-entry.ts reduced from 3981 to 909 lines (77% reduction).

## WP-F Final Verification

Owner: operator, Codex review.

- [x] `rg "^export.*from.*extension-entry" extensions/` returns no new results after all slices.
- [x] `rg "new Map<string, " extensions/octoclaw-runtime/src/extension-entry.ts` returns no timer maps. (Only `recentCompactionNotices` remains — not ACK/timer-related.)
- [x] `wc -l extensions/octoclaw-runtime/src/extension-entry.ts` < 1000. (**909 lines**)
- [x] No new `any` types introduced (grep `: any` before/after).
- [x] `pnpm test` matches baseline failure count. (**2012 passed**)

## Hard Invariants

- No behaviour change.
- No change to plugin register API.
- No change to ACK timing constants or priorities.
- No new dependency cycles.
- Module-scoped state stays module-scoped (no class conversion).
