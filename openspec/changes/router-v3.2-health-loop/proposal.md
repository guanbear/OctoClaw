# Change: Auto Router V3.2 — Model Health Loop (reuses OpenClaw native)

Date: 2026-05-16
Target release: v0.6.0 (after V3.1)
Design reference: `docs/octoclaw-auto-router-v3.2-health-loop-2026-05-16.md`

## Why

Three gaps remain after V3.1:

1. `RouterLiteHealth` already declares `recentFailureRate`, `p50/p95LatencyMs`,
   `toolCallFailureRate`, `timeoutRate`, but **none of these fields are
   populated** from real runtime calls. They get filled only from
   `openclaw status --usage`, which is a quota signal, not a quality signal.
2. `capability probe` records `lastProbeOkAt` on the wizard config, but the
   result never feeds `model.health.cooldown`. Probe failure does not affect
   the next routing decision.
3. The original V3 design talked about an internal health system without
   noticing that **OpenClaw already has a full native fallback list**
   (`openclaw models fallbacks list/add/remove`) and a one-shot model runner
   (`openclaw infer model run`). Building a parallel system means duplicating
   work and risking divergence from the user's actual configuration.

## Scope

V3.2 closes those gaps by:

1. Defining one `HealthEvent` schema shared by runtime delegated turns and
   probe calls.
2. Persisting events to `~/.openclaw/octoclaw/router-lite/model-health.jsonl`
   (7-day retention).
3. Aggregating into `ModelHealthSnapshot` (last 50 calls / 30-min sliding
   window) on every `model-intel refresh` and on plugin startup.
4. Defining 4 cooldown triggers (rate_limit_429 / high_failure_rate /
   probe_failure / high_p95_drift) with explicit durations and recovery
   rules.
5. Reading OpenClaw's native fallback list as ground truth for tie-breaking
   in the scorer.
6. Emitting `router_native_fallback_suggestion` events when a fallback model
   is cooled down — but **never** auto-applying changes to OpenClaw config.
7. Surfacing health state in `octoclawctl router health show <model>` and
   the IM footer.

## Non-Goals

- No auto-mutation of `openclaw models fallbacks` (suggestion-only).
- No periodic re-probe loop. Probe stays manual CLI.
- No new background daemon. Aggregation is on-demand or refresh-time.
- No gateway-wide health gating (gateway stability events are context only).
- No new web UI; CLI + footer only.

## Acceptance Gate

- [ ] `HealthEvent` schema exists in `packages/octoclaw-router/src/health/event.ts`
- [ ] Runtime `after_tool_call` / `agent_end` hooks emit one HealthEvent per
      delegated turn end, swallowed-error-safe
- [ ] `capability probe` emits one HealthEvent per probe
- [ ] Aggregator reads jsonl, produces `ModelHealthSnapshot`, retention pruning
      to 7 days
- [ ] Four cooldown rules implemented and unit-tested
- [ ] `model-intel.ts` `buildModelIntelSnapshot` reads health snapshot and
      populates `model.health.{recentFailureRate,p50LatencyMs,p95LatencyMs,
      cooldown,cooldownReason,cooldownUntil,toolCallFailureRate,timeoutRate,
      lastSuccessfulCallAt,lastFailedCallAt,lastErrorCodes}`
- [ ] Scorer reads `openclaw models fallbacks list --json` and respects user's
      ordering on tied scores
- [ ] When a `fallback#N` model is cooled down, runtime emits
      `router_native_fallback_suggestion` event with concrete `openclaw models
      fallbacks remove ...` command
- [ ] CLI: `router health show <model>`, `router health list [--cooldown-only]`,
      `router health aggregate`, `router health suggest-fallbacks`
- [ ] IM footer shows fallback reason when default model was cooled down
- [ ] `pnpm check && pnpm test` green
- [ ] Hard invariants in design §10 covered by tests

## Out of scope (V3.3 / parking)

- Periodic auto re-probe of cooled-down models
- Auto-apply of `router_native_fallback_suggestion`
- Cross-gateway health aggregation (multi-instance OctoClaw)
- Health-driven model demotion in promotion gate
