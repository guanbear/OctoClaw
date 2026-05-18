# Change: Post-P5 Runtime Slimming

Date: 2026-05-18
Target release: v0.6.x
Depends on: `native-truth-acp-fallback-relay-slimming-0.6.x` P5 hard deletion

## Purpose

P5 removed the large dead compatibility layers. This change handles the next
smaller class of debt: live but historical fallback switches and pass-through
payload boundaries that survived P5 because they needed separate risk review.

The target is a simpler runtime without losing current behavior:

1. OpenClaw native runtime remains the live execution authority.
2. WorkContract and runtime-ledger ticket enforcement remain intact.
3. Slack delivery uses the native Slack API path by default and, if accepted,
   no longer carries a CLI rollback path.
4. Legacy heuristic compatibility remains read-only unless a later archive
   migration explicitly removes old-record display.
5. OpenClaw ACP fallback is observed as host truth; OctoClaw does not keep a
   user switch that pretends it owns backend failover.
6. Runtime payload helper modules are collapsed only when behavior is already
   locked by tests.

This is not expected to be another 10k-line deletion. A good result is smaller
and cleaner by roughly hundreds to low thousands of lines, with fewer permanent
flags and less historical branching.

## Problem

After P5, these live paths still contain compatibility or transitional code:

- `OCTOCLAW_LEGACY_RUNTIME_LEDGER` / `legacyRuntimeLedgerMode` appears to be a
  dead config surface: it is resolved in config but not consumed by live runtime
  code outside config tests.
- `OCTOCLAW_LEGACY_HEURISTIC_MODE` disables a read-only compatibility boundary.
  The boundary is still useful for old records; the user-facing env switch is
  probably not.
- `OCTOCLAW_LEGACY_CLI_DELIVERY` keeps an OpenClaw CLI Slack delivery rollback
  beside the Slack API delivery path. This may be removable after Slack API
  smoke coverage is accepted.
- `OCTOCLAW_NATIVE_ACP_FALLBACK_MODE` keeps an OctoClaw-side enforcement switch
  for native ACP fallback. P5 direction says OpenClaw owns backend failover;
  OctoClaw should mostly record native fallback facts.
- `runtime-payloads.ts` still assembles direct/delegate payloads through helper
  packages that are now runtime-internal only.

These are not P5 blockers. They are P6 candidates that require conservative
slice-by-slice deletion.

## Scope

### P6-A: Delete dead legacy runtime-ledger config

Remove:

- `RuntimeLedgerLegacyMode`
- `resolveLegacyRuntimeLedgerMode()`
- `PlannerSpawnConfig.legacyRuntimeLedgerMode`
- `OCTOCLAW_LEGACY_RUNTIME_LEDGER` tests and docs, except archived history

Keep:

- runtime-ledger tables
- ticket enforcement
- WorkContract mirror/shadow metadata
- native spawn intent store

### P6-B: Remove legacy heuristic env switch, keep read-only old-record support

Remove:

- `OCTOCLAW_LEGACY_HEURISTIC_MODE`
- `resolveLegacyHeuristicMode()`
- tests that assert an `off` env mode

Keep:

- `legacyHeuristicVerdict()` as a read-only compatibility helper
- `legacy_heuristic_fallback_used` replay event
- old-record status display when native fields are absent

Do not delete the entire legacy heuristic module in this change unless tests
prove old-record display no longer needs it and docs explicitly accept that
migration.

### P6-C: Remove Slack CLI delivery rollback path

Remove only if Slack API delivery coverage is accepted:

- `OCTOCLAW_LEGACY_CLI_DELIVERY`
- `legacyCliDeliveryEnabled()`
- `executeLegacyCliSend()`
- tests that force legacy CLI delivery
- live docs that advertise CLI delivery rollback

Keep:

- Slack API `chat.postMessage`
- Slack API streaming for native child final when available
- delivery envelope/footer behavior
- `transport` display for existing records, if old persisted records can still
  contain `legacy_cli`

### P6-D: Collapse native ACP fallback mode to host-truth observation

Remove:

- `OCTOCLAW_NATIVE_ACP_FALLBACK_MODE`
- `NativeAcpFallbackMode`
- `resolveNativeAcpFallbackMode()`
- `delegate_backend_unavailable` branching in OctoClaw

Keep:

- reading OpenClaw `acp.fallbacks`
- replay/status metadata that reports native fallback availability
- classification between backend unavailability and task recovery

OctoClaw must not mutate `acp.fallbacks` and must not create self-managed
backend retry tasks.

### P6-E: Collapse runtime payload helper boundaries

Candidate only after A-D are stable:

- Inline or co-locate runtime-only `payloads/fast-reply/*` and
  `payloads/delegation/materialize/*` if they are still imported only by
  `runtime-payloads.ts` and their own tests.
- Keep public `buildTsRuntimeDispatchPayload()` and
  `buildTsRuntimeSpawnPayload()` behavior stable.
- Do not rewrite policy resolver, dispatch, or native helper contracts just to
  chase LOC.

## Non-Goals

- Do not delete runtime-ledger schema or ticket enforcement.
- Do not delete WorkContract.
- Do not remove native spawn intent planner/confirm flow.
- Do not remove Slack API delivery.
- Do not remove old-record display unless there is an explicit archive migration
  decision.
- Do not remove router-lite shadow/fallback suggestion logic in this change.
- Do not introduce Hermes live runtime support.
- Do not add new dependencies.
- Do not refactor large files merely because they are large.

## Acceptance Gate

This change is complete when:

- [ ] Each deleted flag has a grep guard proving it is absent from live runtime
      code and non-archive docs.
- [ ] `pnpm check` passes.
- [ ] `pnpm test` passes, or any pre-existing failure is documented with
      targeted green tests.
- [ ] Targeted BDD tests in `bdd.md` pass.
- [ ] Before/after LOC for `extensions/octoclaw-runtime/src` is recorded.
- [ ] Remaining large modules have a reason and a next possible cleanup note.
- [ ] No deleted branch is replaced by a new abstraction with equal or greater
      complexity.

## Expected Deletion Order

1. P6-A first. It is low risk and validates the process.
2. P6-B second. Remove only the env switch, not the read-only helper.
3. P6-C third. Do it only with Slack API tests and smoke confidence.
4. P6-D fourth. Keep host fallback metadata, remove OctoClaw enforcement mode.
5. P6-E last. It is active code consolidation, not dead-code deletion.

