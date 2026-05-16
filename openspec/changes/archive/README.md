# Archived Changes

Each subdirectory here represents a change package whose production code has
shipped to `main`. They are retained for historical context (design notes,
acceptance gates, evidence).

If a change shipped only partially, the full original package is moved here and
the remaining work is created as a fresh change (or moved to `parking/`).

## Inventory

| Change id | Shipped | Deferred to |
|-----------|---------|-------------|
| `ack-delegation-evaluation-harness` | Full delegation evaluation harness | — |
| `autorouter-lite-model-intel-shadow` | Snapshot refresh + config analyze CLI + selector | — |
| `autorouter-lite-wiring-0.5.x` | Runtime shadow-bridge call site, snapshot loader, request builder, shadow-report CLI | — |
| `runtime-streaming-ack-skip-0.5.x` | `channelStreaming` capability + ack-timing/ack-guard skip on Slack native | — |
| `runtime-convergence-cleanup-0.5.x` | Dispatch admission convergence + dispatch-honesty tests | Live Slack smoke (no env) |
| `router-v3-0.6.x` | Phase A package extraction, Phase B capability snapshot + scoring, Phase C shadow evaluator + promotion + decisions CLI + nightly review, Phase D shadow report + override CLI + cost report core | `parking/router-v3-wizard-and-release/`: D1 7-step interactive wizard, D6 plan quota auto-poll, E release polish |
| `v0.6-friendly-errors-doctor` | `@octoclaw/errors` package, `octoclawctl doctor` 5-check, judge timeout/parse error code wiring | — |
| `v0.6-npm-cli-distribution` | `@octoclaw/cli` package rename, init wizard, bin entries | — |
| `v0.6-im-discord-adapter` | Discord adapter + registration | — |
| `v0.6-im-telegram-adapter` | Telegram adapter + registration | — |
| `v0.6-github-presence` | Issue/PR templates, code of conduct, security policy, contributing guide | Repo Settings (Discussions, social preview) — manual operator action |
| `runtime-dead-placeholder-removal-0.5.x` | All 3 slices: no-op aggregators, compound delegation placeholder, compound policy placeholder | — |
| `runtime-extension-entry-slim-0.5.x` | All 5 slices + 3 additional extractions: extension-entry.ts 3981→909 lines (16 new files) | — |

Each archived change's `tasks.md` keeps its original checklist plus a short
preamble headed `## Archive note` recording what shipped, what was skipped, and
where deferred work lives.
