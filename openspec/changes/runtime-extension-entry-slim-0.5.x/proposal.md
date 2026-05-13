# Change: Runtime Extension Entry Slim 0.5.x

## Purpose

`extensions/octoclaw-runtime/src/extension-entry.ts` is 5234 lines and holds at least five independent concerns in the same module state. This change splits it into focused files without changing runtime behaviour. Target: `extension-entry.ts` under 1000 lines; no new file over 400 lines.

## Problem

Today `extension-entry.ts` contains:

1. Hook orchestration for `before_prompt_build`, `before_tool_call`, `before_model_resolve`, `after_tool_call`, `agent_end`.
2. ACK subsystem module-level state: `LATENCY_ACK_DELAY_MS`, `pendingLatencyAckTimers`, `pendingNeutralInboundAckTimers`, `pendingNeutralInboundAckTextFallbackTimers`, `pendingBudgetedMainTimers`, plus delay resolution helpers.
3. IM footer mode selection and legacy env toggle parsing.
4. Large inline delegation system-context strings (`OCTOCLAW_DELEGATION_SYSTEM_CONTEXT` etc.).
5. Dispatch result parsing and user-visible text generation.
6. Speculative preload hook branches (~400 lines).
7. Budgeted-main state parsing and escalation timers.
8. Grounded prompt memoization.

Effects:

- Any change touches shared module state; tests must reset many globals.
- New maintainers cannot locate responsibility without reading 5k lines.
- Blast radius of routine edits is the whole hook layer.

## Scope

Split in five slices, each an independent commit:

- **Slice A** — ACK subsystem global state → `ack/ack-scheduler.ts`.
- **Slice B** — Footer mode / legacy toggle parsing → `im/footer-mode.ts`.
- **Slice C** — Delegation system-context strings and slim toggle → `delegate/system-context.ts`.
- **Slice D** — Speculative preload `before_tool_call` branch → `delegate/speculative-preload-handler.ts`.
- **Slice E** — Hook orchestration per hook name → `hooks/before-prompt-build.ts`, `hooks/before-tool-call.ts`, `hooks/before-model-resolve.ts`, `hooks/after-tool-call.ts`, `hooks/agent-end.ts`.

`extension-entry.ts` ends as a thin `register(pi)` binding.

## Non-Goals

- No behaviour change.
- No policy / route / ACK timing change.
- No type surface change on exported symbols (plugin register API stable).
- Module-level `Map<string, ReturnType<typeof setTimeout>>` remain module-scoped — do not convert to class instances (would change test reset semantics).
- Do not refactor `conversation-grounding.ts` or `resolve/policy-resolver.ts` in this change.

## Target Behaviour

Identical observable behaviour. `pnpm test` output must be equivalent before and after each slice except for renamed test files (allowed) and removed `extension-entry.ts` private duplicates (allowed).

## Acceptance Gate

- Each slice: `pnpm check && pnpm test` stays at the same failure baseline (the 6 pre-existing failures in improvement plan appendix B are tolerated).
- `extension-entry.ts` < 1000 lines after Slice E.
- No new file exceeds 400 lines.
- No new dependency cycle introduced (verified via `pnpm check`).
- Slack smoke unchanged.

## Rollout

Slice-by-slice merge. Each slice = one reviewable PR with:

- moved code
- updated imports at old + new sites
- no net behaviour change
- tests still green

If any slice introduces a regression that cannot be pinpointed within the slice diff, revert that slice only; others remain merged.

## Risks

- **Timer/state ordering**: if a `Map` is moved without its reset hook, tests pass individually but flake in batch. Mitigation: every moved Map has a `resetForTests()` entry point and a paired test that asserts reset clears state.
- **Circular imports**: moving helpers could create `extension-entry → hooks/x → ack/ack-scheduler → extension-entry` cycles. Mitigation: `pnpm check` after each slice; refactor if TypeScript reports circular.
- **Scope creep**: tempting to "fix" neighbouring code while refactoring. Forbidden in this change; file issues instead.
