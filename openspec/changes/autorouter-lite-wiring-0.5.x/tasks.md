# Tasks

## WP-1 Snapshot Loader

Owner: implementation, Codex review.

Write scope:

- `extensions/octoclaw-runtime/src/router-lite/snapshot-loader.ts`
- `extensions/octoclaw-runtime/src/router-lite/__tests__/snapshot-loader.test.ts`

Tasks:

- [ ] Implement `resolveSnapshotPath(workspaceRoot?)` with `OCTOCLAW_ROUTER_SNAPSHOT_PATH` override.
- [ ] Implement `loadRouterLiteSnapshot()` with 60 s mtime-aware cache.
- [ ] Implement `isValidSnapshot()` schema guard.
- [ ] Fail-open on any fs / JSON / schema error; never throw.
- [ ] Add unit tests for missing file, corrupt JSON, wrong schema version, valid load, cache reuse, mtime invalidation, env override.

Acceptance:

- [ ] `pnpm vitest run extensions/octoclaw-runtime/src/router-lite/__tests__/snapshot-loader.test.ts`
- [ ] Loader never throws under any input.
- [ ] Cache spy proves fs read is not repeated within TTL.

## WP-2 Request Builder

Owner: implementation, Codex review.

Write scope:

- `extensions/octoclaw-runtime/src/router-lite/request-builder.ts`
- `extensions/octoclaw-runtime/src/router-lite/__tests__/request-builder.test.ts`

Tasks:

- [ ] Implement `buildRouterLiteRequest(input)` returning `RouterLiteRequest | null`.
- [ ] Return null when any of `route | confidence | complexity | complexityConfidence` is missing.
- [ ] Map `statusOrProvenanceRequest`, `sessionControlRequest`, `explicitOverride` from runtime signals.
- [ ] Never read raw transcript; only structured signals.
- [ ] Unit tests: missing judge, partial judge, valid judge, signal propagation.

Acceptance:

- [ ] `pnpm vitest run extensions/octoclaw-runtime/src/router-lite/__tests__/request-builder.test.ts`
- [ ] No transcript-like field is accessed (search: `rg "prompt|transcript|history" request-builder.ts` should be empty).

## WP-3 Shadow Bridge

Owner: implementation, Codex review.

Write scope:

- `extensions/octoclaw-runtime/src/router-lite/shadow-bridge.ts`
- `extensions/octoclaw-runtime/src/router-lite/__tests__/shadow-bridge.test.ts`

Tasks:

- [ ] Implement `emitRouterLiteShadowEvent(input)`.
- [ ] Wrap body in `try/catch`; log once with `[router-lite]` prefix on error.
- [ ] Compute `estimatedCostDeltaUsd` via fixed token footprint.
- [ ] Implement `resolveShadowEventPath()` with `OCTOCLAW_ROUTER_SHADOW_PATH` override.
- [ ] Unit tests for: snapshot missing, valid flow, low confidence, status request, selector throws, writer throws.

Acceptance:

- [ ] `pnpm vitest run extensions/octoclaw-runtime/src/router-lite/__tests__/shadow-bridge.test.ts`
- [ ] All failure modes return void silently.
- [ ] Logger.warn is called exactly once per failure.

## WP-4 Policy Resolver Call Site

Owner: implementation, Codex review.

Write scope:

- `extensions/octoclaw-runtime/src/resolve/policy-resolver.ts`
- `extensions/octoclaw-runtime/src/resolve/__tests__/policy-resolver-shadow.test.ts` (new)

Tasks:

- [ ] Add one call to `emitRouterLiteShadowEvent()` at end of `resolvePolicyDecisionForContext()`.
- [ ] Extract helpers `resolveActualModel(decision)` and `buildRuntimeSignalsFromContext(context, decision)`.
- [ ] Add integration tests: reply + valid judge emits; delegate + valid judge emits; missing judge skips; invalid snapshot path unaffects policy decision.
- [ ] Assert shadow throw cannot affect policy decision return value (use vi.spyOn to force throw).

Acceptance:

- [ ] `pnpm vitest run extensions/octoclaw-runtime/src/resolve/__tests__/policy-resolver-shadow.test.ts`
- [ ] `pnpm vitest run extensions/octoclaw-runtime/src/resolve/policy-resolver.test.ts` (existing tests still pass)
- [ ] Inject throwing selector → policy-resolver returns normal decision.

## WP-5 CLI `router shadow-report`

Owner: implementation, Codex review.

Write scope:

- `tools/octoclawctl/src/cli.ts`
- `tools/octoclawctl/src/cli.test.ts`

Tasks:

- [ ] Add `router shadow-report [--path <jsonl>] [--format text|json]` sub-command.
- [ ] Reuse `generateShadowReport()` from `@octoclaw/policy/router-lite`.
- [ ] Text format matches design §9 example.
- [ ] JSON format returns the `ShadowReportSummary` object directly.
- [ ] Test on fixture jsonl with 5-10 events.

Acceptance:

- [ ] `pnpm vitest run tools/octoclawctl/src/cli.test.ts`
- [ ] `octoclawctl router shadow-report --help` shows usage.

## WP-6 Verification And Observation

Owner: operator, Codex review.

Tasks:

- [ ] `pnpm --filter @octoclaw/runtime run check`
- [ ] `pnpm test` (tolerating the 6 pre-existing failures listed in improvement plan appendix B)
- [ ] Deploy to local OpenClaw.
- [ ] Slack smoke: 3 delegated turns, 3 reply turns, 1 status-followup. Expect shadow.jsonl to grow by exactly 7 lines.
- [ ] Run `octoclawctl router model-intel refresh` once; re-run smoke; verify snapshotId in jsonl matches new snapshot.
- [ ] 7-day observation: daily `octoclawctl router shadow-report`, capture ignoredReasonCounts.

Acceptance:

- [ ] No `[router-lite]` warn entries after warmup (first 24 h).
- [ ] Snapshot reload via `octoclawctl router model-intel refresh` is reflected in next shadow event within 1 minute (cache TTL).
- [ ] 7-day shadow-report contains ≥ 100 events and at least 20 with a `recommendedModel`.
- [ ] No user-visible regression in Slack ACK, footer, or dispatch.

## Hard Invariants

- `configured=false` never appears as `recommendedModel` in any shadow event.
- `quotaPressure=unknown` never yields `ignoredReason=null` with a recommended model.
- Removing snapshot file has zero effect on live routing.
- Live route stays `reply | delegate`.
