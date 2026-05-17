# Agent Prompts: Runtime Native Slimming

Use these prompts to hand bounded slices to other AI agents. Replace only the
angle-bracket placeholders. Do not ask an AI to "do the whole change".

## Universal Prefix

```text
You are working in /Users/guanbear/workspace/OctoClaw.

Read this OpenSpec package before editing code:
openspec/changes/native-truth-acp-fallback-relay-slimming-0.6.x/handoff.md
openspec/changes/native-truth-acp-fallback-relay-slimming-0.6.x/proposal.md
openspec/changes/native-truth-acp-fallback-relay-slimming-0.6.x/design.md
openspec/changes/native-truth-acp-fallback-relay-slimming-0.6.x/specs/runtime-native-slimming/spec.md
openspec/changes/native-truth-acp-fallback-relay-slimming-0.6.x/bdd.md
openspec/changes/native-truth-acp-fallback-relay-slimming-0.6.x/tasks.md

You must implement only <TASK-ID>, not the whole change.

Hard rules:
- Preserve unrelated dirty worktree changes.
- Before editing any function/class/method, run GitNexus impact analysis and report blast radius.
- Write or update tests for <BDD-IDS> before/with implementation.
- Do not use assistant text, transcript text, task title, or session label substring as runtime truth.
- Do not auto-write OpenClaw acp.fallbacks.
- Do not create a live Hermes runtime.
- Do not add a new scheduler, task engine, or generic runtime framework.
- Prefer deletion over wrapping when behavior is already replaced and tested.

Final report must include changed files, BDD scenarios covered, commands run,
deletions made, remaining risks, and any flags still in observe/dry-run mode.
```

## P1-B Prompt: Legacy Heuristic Isolation

```text
<UNIVERSAL PREFIX>

Task: P1-B Legacy heuristic isolation.
BDD: NTR-P1-005, NTR-P1-006, NTR-P1-007, NTR-P1-008.

Goal:
Find runtime/session/spawn heuristics that infer facts from session key
substrings, task labels, assistant text, transcript text, or stale cache. Move
them behind a read-only legacy boundary and emit
legacy_heuristic_fallback_used when used.

Do not delete branches yet. Do not touch ACP fallback or delivery relay.
For new tasks, legacy fallback must not affect dispatch, sessions_spawn
admission, dispatch confirm, ACK, or final delivery.
```

## P1-C Prompt: Unsafe Heuristic Deletion

```text
<UNIVERSAL PREFIX>

Task: P1-C Delete first unsafe heuristics.
BDD: NTR-P1-009, NTR-P1-010.

Precondition:
P1-B tests must pass.

Goal:
Delete or disable child/delivery/result inference from assistant text,
transcript text, and session-label substrings for new tasks. Keep old-record
display only if tests require it and mark it legacy_read_only.

Do not change ACP fallback, delivery relay, or RuntimeAdapter work in this patch.
```

## P2 Prompt: ACP Fallback Native Integration

```text
<UNIVERSAL PREFIX>

Task: <P2-A | P2-B | P2-C>.
BDD: <NTR-P2-001..003 | NTR-P2-004..006 | NTR-P2-007..009>.

Goal:
Move only backend_unavailable_before_output toward native OpenClaw ACP fallback.
Do not treat task_timeout, bad_result, backend_unavailable_after_output, or
policy_violation as clean ACP failover.

P2-A must be observe-only and must not change dispatch behavior.
P2-C may enforce only behind nativeAcpFallbackMode and only after observe
evidence shows no duplicate dispatch/final.
```

## P3 Prompt: Delivery Relay Slimming

```text
<UNIVERSAL PREFIX>

Task: <P3-A | P3-B | P3-C>.
BDD: <NTR-P3-001..003 | NTR-P3-004..007 | NTR-P3-008..009>.

Goal:
Make native delivery success authoritative. OctoClaw relay becomes audit plus
fallback for native missing/failed/degraded only.

P3-A records verdict without behavior change.
P3-B bypasses compensation on proven native success behind deliveryRelayMode.
P3-C deletes redundant relay branches only after Slack/Feishu smoke proves the
reply kinds covered by BDD.
```

## P4 Prompt: RuntimeAdapter And Hermes Foundation

```text
<UNIVERSAL PREFIX>

Task: <P4-A | P4-B | P4-C>.
BDD: <NTR-P4-001..002 | NTR-P4-003..005 | NTR-P4-006..008>.

Goal:
Extract a minimal host runtime adapter boundary. OpenClaw remains the only live
host. Hermes is dry-run/capability-matrix only.

Do not add live Hermes process launching, config migration, credentials,
delivery, or spawn. Do not add adapter methods unless current call sites and BDD
require them.
```

## P5 Prompt: Deletion Closeout

```text
<UNIVERSAL PREFIX>

Task: <P5-A | P5-B | P5-C>.
BDD: <NTR-P5-001 | NTR-P5-002..004 | NTR-P5-005..006>.

Goal:
Delete historical debt now replaced by native truth, native ACP fallback, native
delivery, or RuntimeAdapter extraction.

Before deleting, record runtime production LOC. After deleting, record runtime
production LOC again and write a deletion ledger. Do not replace dead code with
another wrapper. Do not delete old-record readers unless archive/replay tests
prove safe removal.
```

