# AI Handoff: Native Truth, ACP Fallback, and Relay Slimming

This file is the execution entrypoint for future AI agents. Read it before
editing code.

## Start Here

Read these files in order:

1. `proposal.md`
2. `design.md`
3. `specs/runtime-native-slimming/spec.md`
4. `bdd.md`
5. `tasks.md`
6. `agent-prompts.md`

Do not start implementation after reading only one file. The proposal defines
scope, the design defines architecture, the spec defines non-negotiable
requirements, BDD defines behavior, tasks define the safe order of edits, and
agent-prompts gives copy-paste handoff prompts for bounded AI work.

## One-Sentence Mission

Make OctoClaw trust OpenClaw 2026.5.12 native runtime facts first, delegate
backend-unavailable ACP failover to native OpenClaw only after observe-mode
evidence, slim delivery relay into audit plus last-resort fallback, and create
a minimal host runtime adapter seam so a later Hermes migration does not require
rewriting OctoClaw policy.

## Absolute Boundaries

You must preserve these boundaries:

- OpenClaw native run/session/delivery facts are execution truth.
- WorkContract remains semantic, policy, and continuity truth.
- OctoClaw decides whether a task is valid and what policy applies.
- OpenClaw owns runtime backend failover only for clean
  `backend_unavailable_before_output` cases.
- OctoClaw still owns task timeout, bad result, policy violation, and recovery.
- Delivery relay is not deleted; it is demoted only when native delivery success
  is proven.
- The only new long-lived abstraction allowed by this change is the minimal
  host runtime adapter seam. Do not add a second scheduler, task engine, or
  generic plugin framework.
- Hermes support in this change is foundation only: capability mapping and a
  disabled/stub adapter shape. Do not turn Hermes on as a live runtime.

## Required Execution Order

Implement phases in this order:

1. Phase 1: Native session truth first.
2. Phase 2: ACP fallback observe, then enforce behind flag.
3. Phase 3: Delivery relay verdict, audit-only mode, then branch removal.
4. Phase 4: Introduce a minimal RuntimeAdapter boundary for host runtime facts.
5. Phase 5: Delete legacy code and retire transitional flags after smoke.

Do not combine Phase 2, Phase 3, Phase 4, or Phase 5 in the same patch. They
affect different failure domains and must remain reviewable.

## Required Preflight

Before editing code:

```bash
openclaw --version
npx gitnexus analyze
git status --short --branch
```

Before editing any function, class, or method, run GitNexus impact analysis for
that symbol and record the blast radius in your implementation notes.

## Required Flags

Use feature flags for behavior changes:

```typescript
nativeTruthMode: "observe" | "enforce";
legacyHeuristicMode: "read_only" | "disabled";
nativeAcpFallbackMode: "observe" | "delegate_backend_unavailable";
deliveryRelayMode: "compensate" | "native_success_audit_only";
runtimeHostMode: "openclaw" | "hermes_dry_run";
```

Initial behavior must be conservative:

```typescript
nativeTruthMode = "observe";
legacyHeuristicMode = "read_only";
nativeAcpFallbackMode = "observe";
deliveryRelayMode = "compensate";
runtimeHostMode = "openclaw";
```

## What Counts as Evidence

Accepted runtime evidence:

- native `kind`, especially `kind="spawn-child"`;
- native `agentRuntime.id`;
- native `runId`;
- native `flowId`;
- native `childSessionKey`;
- native delivery success/failure/degraded status;
- explicit OctoClaw fallback delivery success.
- host runtime adapter facts derived from native runtime records.

Rejected runtime evidence:

- assistant text;
- transcript text;
- task title;
- session label substring;
- old cache value without degraded/lost marker;
- "the reply looks right" manual impression.
- host adapter stubs that are not backed by a live runtime receipt.

## Non-Negotiable BDD Gate

Every changed behavior must map to at least one `NTR-*` scenario in `bdd.md`.

If a BDD scenario cannot be automated because it requires real Slack or Feishu,
add both:

1. a mock/unit test that proves the decision logic;
2. a manual smoke note with channel, timestamp, command, and observed result.

Do not mark a task complete without either automated evidence or explicit manual
smoke evidence.

## Patch Size Rules

Keep patches narrow:

- P1-A patch: native truth verdict and propagation only.
- P1-B patch: legacy heuristic isolation and telemetry only.
- P1-C patch: removal/disablement of unsafe new-task heuristics only.
- P2-A patch: ACP fallback snapshot observe-only only.
- P2-B patch: fallback reason classification only.
- P2-C patch: native ACP fallback enforcement behind flag only.
- P3-A patch: delivery relay verdict while preserving behavior.
- P3-B patch: native success audit-only mode behind flag.
- P3-C patch: redundant relay branch removal after smoke.
- P4-A patch: runtime adapter types and OpenClaw wrapper only.
- P4-B patch: move call sites from OpenClaw concrete helpers to adapter seam.
- P4-C patch: Hermes capability matrix and disabled dry-run adapter only.
- P5-A patch: deletion ledger and dead-code removal only.
- P5-B patch: flag retirement and docs/status cleanup only.

If you need to touch files outside the listed candidate areas, explain why in
the implementation notes before editing them.

## Common Wrong Turns

Avoid these mistakes:

- Do not rewrite the task engine.
- Do not introduce a second scheduler.
- Do not auto-edit user OpenClaw `acp.fallbacks`.
- Do not treat native ACP fallback as a replacement for bad-output retry.
- Do not remove WorkContract.
- Do not remove delivery relay before native delivery smoke passes.
- Do not infer child identity from text when native kind is present.
- Do not mark native registry loss as success.
- Do not hide legacy fallback usage; emit observable reason codes.
- Do not claim broad check success if failures are unrelated but undocumented.
- Do not keep dead compatibility code "just in case" after BDD and smoke prove
  native behavior.
- Do not make Hermes a live backend in this change.
- Do not add an adapter method unless at least one BDD scenario needs it.

## Suggested Implementation Prompt

Use this prompt when handing one slice to another AI:

```text
You are implementing one bounded slice of
openspec/changes/native-truth-acp-fallback-relay-slimming-0.6.x.

Read proposal.md, design.md, bdd.md, and tasks.md first.
Implement only <PHASE/SUBTASK>, not the whole change.

Before editing symbols, run GitNexus impact analysis and record the blast
radius. Preserve unrelated dirty worktree changes.

Write or update tests for these BDD scenarios: <NTR-IDS>.
Do not use assistant text, transcript text, task labels, or session substring
matching as runtime truth.

Keep behavior changes behind the required feature flag.
If implementing Phase 4, create only the minimal RuntimeAdapter shape required
by the current OpenClaw path. Hermes must remain dry-run/foundation-only.
If implementing Phase 5, delete code instead of adding another wrapper around it.
After implementation, run targeted Vitest tests plus the broad checks listed in
tasks.md where feasible. If a broad check fails for a pre-existing unrelated
reason, document the exact file/error and the targeted tests that passed.

Final response must include changed files, BDD scenarios covered, commands run,
remaining risks, and any flags left in observe mode.
```

## Completion Definition

The whole change is done only when:

- all `tasks.md` checkboxes are complete;
- all `bdd.md` `NTR-*` scenarios have evidence;
- no legacy heuristic affects new-task dispatch, ACK, confirm, or delivery;
- ACP backend-unavailable fallback is native-owned behind flag;
- delivery relay compensates only for native missing/failed/degraded cases;
- OpenClaw-specific runtime facts flow through the RuntimeAdapter seam, not
  scattered call sites;
- Hermes migration has a documented capability matrix and disabled dry-run
  adapter shape, without changing live OpenClaw behavior;
- legacy branches, transitional flags, and stale docs are removed after smoke;
- runtime production LOC is materially lower than the baseline or every
  remaining large module has a documented owner and reason;
- Slack and Feishu smoke pass for plain text, rich/card/button-only,
  delegated final, and message-tool-only replies;
- broad checks pass or unrelated failures are documented precisely.
