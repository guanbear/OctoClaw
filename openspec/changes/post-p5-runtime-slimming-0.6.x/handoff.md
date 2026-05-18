# Handoff: Post-P5 Runtime Slimming

## One-Sentence Goal

Remove post-P5 legacy switches and small compatibility tails without deleting
active runtime truth, WorkContract, runtime-ledger ticket enforcement, or Slack
API delivery.

## Start Here

1. Read `proposal.md`.
2. Read `design.md`.
3. Execute `tasks.md` in order.
4. Use `bdd.md` as the behavioral contract.

## Do First

Run:

```bash
git status --short
pnpm vitest run extensions/octoclaw-runtime/src/runtime-host/p5-slimming-guard.test.ts
```

Record production LOC:

```bash
find extensions/octoclaw-runtime/src -type f \( -name '*.ts' -o -name '*.tsx' \) \
  ! -name '*.test.ts' ! -path '*/__tests__/*' -print0 | xargs -0 wc -l | tail -n 1
```

## Recommended Delegation Packets

### Packet A: Low-Risk Config Deletion

Scope:

- `extensions/octoclaw-runtime/src/config/index.ts`
- `extensions/octoclaw-runtime/src/config/index.test.ts`

Task:

Delete `OCTOCLAW_LEGACY_RUNTIME_LEDGER` config and tests. Do not touch
runtime-ledger schema or ticket enforcement.

Verify:

```bash
pnpm vitest run extensions/octoclaw-runtime/src/config/index.test.ts
pnpm check
```

### Packet B: Legacy Heuristic Switch Removal

Scope:

- `extensions/octoclaw-runtime/src/state/legacy-heuristics.ts`
- `extensions/octoclaw-runtime/src/state/legacy-heuristics.test.ts`
- only touched call-site tests if needed

Task:

Remove the env switch. Keep read-only legacy old-record behavior and replay
event. Do not delete the module.

Verify:

```bash
pnpm vitest run \
  extensions/octoclaw-runtime/src/state/legacy-heuristics.test.ts \
  extensions/octoclaw-runtime/src/tools/runtime-status.test.ts \
  extensions/octoclaw-runtime/src/runtime-host/p5-slimming-guard.test.ts
```

### Packet C: Slack CLI Rollback Removal

Scope:

- `extensions/octoclaw-runtime/src/im/slack/slack-adapter.ts`
- Slack/ACK tests that set `OCTOCLAW_LEGACY_CLI_DELIVERY`

Task:

Remove CLI delivery branch only if tests can prove Slack API behavior. Rewrite
tests to mock Slack API instead of preserving the legacy env path.

Verify:

```bash
pnpm vitest run \
  extensions/octoclaw-runtime/src/im/slack/slack-adapter.test.ts \
  extensions/octoclaw-runtime/src/im/slack/slack-smoke.test.ts \
  extensions/octoclaw-runtime/src/ack/__tests__/route-commit-ack.test.ts \
  extensions/octoclaw-runtime/src/ack/__tests__/delegate-without-dispatch.test.ts
```

### Packet D: ACP Mode Collapse

Scope:

- `extensions/octoclaw-runtime/src/delegate/native-acp-fallback.ts`
- `extensions/octoclaw-runtime/src/tools/handlers/dispatch.ts`
- native ACP fallback tests

Task:

Remove OctoClaw-side `delegate_backend_unavailable` switch. Keep OpenClaw
fallback snapshot reading and replay/status metadata.

Verify:

```bash
pnpm vitest run \
  extensions/octoclaw-runtime/src/delegate/native-acp-fallback.test.ts \
  extensions/octoclaw-runtime/src/tools/registration-planner.test.ts \
  extensions/octoclaw-runtime/src/tools/registration-dispatch-honesty.test.ts
```

### Packet E: Payload Consolidation

Scope:

- `extensions/octoclaw-runtime/src/runtime-payloads.ts`
- `extensions/octoclaw-runtime/src/runtime-payloads.test.ts`
- runtime-only `payloads/*` helper files if consumer search proves safe

Task:

Inline or co-locate runtime-only helper code without changing payload shape.

Verify:

```bash
pnpm vitest run \
  extensions/octoclaw-runtime/src/runtime-payloads.test.ts \
  extensions/octoclaw-runtime/src/resolve/policy-resolver-judge-fallback.test.ts \
  extensions/octoclaw-runtime/src/tools/registration-dispatch-honesty.test.ts
```

## Hard Stops

Stop and report instead of continuing if:

- Removing Slack CLI branch requires weakening Slack API tests.
- Removing legacy heuristics breaks old-record status display.
- Removing ACP fallback mode causes dispatch to lose fallback metadata entirely.
- Any change tries to delete runtime-ledger tickets/attempts/events.
- Any change creates a new wrapper layer just to hide old code.

## Final Report Shape

The final report must include:

- deleted flags/functions/files;
- before/after production LOC;
- targeted tests;
- `pnpm check` result;
- `pnpm test` result or documented reason it was not run;
- remaining cleanup candidates with risk level.

