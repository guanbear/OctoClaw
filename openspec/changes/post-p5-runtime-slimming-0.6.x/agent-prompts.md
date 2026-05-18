# Agent Prompts: Post-P5 Runtime Slimming

## Supervisor Prompt

Use this when assigning the whole change to another AI:

```text
You are implementing OpenSpec change `post-p5-runtime-slimming-0.6.x`.

Read these files first:
- openspec/changes/post-p5-runtime-slimming-0.6.x/proposal.md
- openspec/changes/post-p5-runtime-slimming-0.6.x/design.md
- openspec/changes/post-p5-runtime-slimming-0.6.x/tasks.md
- openspec/changes/post-p5-runtime-slimming-0.6.x/bdd.md

Goal: remove post-P5 legacy switches and small compatibility tails without
changing current user-visible behavior. Prefer deletion over abstraction.

Execute phases in order:
P6-A remove OCTOCLAW_LEGACY_RUNTIME_LEDGER config;
P6-B remove OCTOCLAW_LEGACY_HEURISTIC_MODE env switch but keep read-only old-record helper;
P6-C remove OCTOCLAW_LEGACY_CLI_DELIVERY only after Slack API tests are green;
P6-D collapse OCTOCLAW_NATIVE_ACP_FALLBACK_MODE to host-owned fallback observation;
P6-E consolidate runtime-payload helper boundaries only if behavior is locked.

Do not delete runtime-ledger ticket enforcement, WorkContract, native spawn
intent flow, Slack API delivery, router-lite, or old-record display.

For every phase:
1. Search current references first.
2. Add/update a test that fails before deletion when practical.
3. Delete code, do not hide it under a new flag.
4. Run the targeted command listed in tasks.md.
5. Record before/after LOC and deleted symbols.

Stop and report if a phase would require weakening tests or deleting active
runtime truth.
```

## Packet A Prompt

```text
Implement only P6-A from `post-p5-runtime-slimming-0.6.x`.

Delete dead legacy runtime-ledger config:
- RuntimeLedgerLegacyMode
- resolveLegacyRuntimeLedgerMode()
- PlannerSpawnConfig.legacyRuntimeLedgerMode
- OCTOCLAW_LEGACY_RUNTIME_LEDGER tests/docs outside archive/history

Do not touch runtime-ledger schema, ticket enforcement, WorkContract,
native-spawn-intent store, dispatch, or Slack.

Verify:
pnpm vitest run extensions/octoclaw-runtime/src/config/index.test.ts
pnpm check
```

## Packet B Prompt

```text
Implement only P6-B from `post-p5-runtime-slimming-0.6.x`.

Remove the OCTOCLAW_LEGACY_HEURISTIC_MODE env switch.
Keep legacyHeuristicVerdict() as read-only compatibility for old records.
Keep legacy_heuristic_fallback_used replay telemetry.
Do not delete legacy-heuristics.ts unless the OpenSpec is updated first.

Verify the tests listed in tasks.md P6-B.
```

## Packet C Prompt

```text
Implement only P6-C from `post-p5-runtime-slimming-0.6.x`.

Remove Slack CLI delivery rollback:
- OCTOCLAW_LEGACY_CLI_DELIVERY
- legacyCliDeliveryEnabled()
- executeLegacyCliSend()

Rewrite tests to use Slack API mocks, not the legacy CLI env.
Do not weaken Slack delivery coverage.
Keep Slack API chat.postMessage and stream paths.

Verify the tests listed in tasks.md P6-C.
```

## Packet D Prompt

```text
Implement only P6-D from `post-p5-runtime-slimming-0.6.x`.

Remove OctoClaw-side native ACP fallback enforcement mode:
- OCTOCLAW_NATIVE_ACP_FALLBACK_MODE
- delegate_backend_unavailable
- resolveNativeAcpFallbackMode()
- buildEnforceFallbackReplayMetadata() if no longer needed

Keep reading OpenClaw acp.fallbacks and keep replay/status metadata. Do not
auto-write OpenClaw acp.fallbacks. Do not create self-managed retry tasks.

Verify the tests listed in tasks.md P6-D.
```

## Packet E Prompt

```text
Implement only P6-E from `post-p5-runtime-slimming-0.6.x`.

Consolidate runtime-payload helper boundaries only if consumer search proves
the helpers are runtime-local. Preserve buildTsRuntimeDispatchPayload() and
buildTsRuntimeSpawnPayload() behavior and payload shape.

Do not rewrite policy resolver or dispatch for style reasons.
Verify the tests listed in tasks.md P6-E.
```

