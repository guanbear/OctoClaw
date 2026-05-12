# Design

## Overview

This change turns timeout and completion visibility into a deterministic runtime responsibility.

Implementation is staged. Phase 1 lands the pure reducer, status-query projection, conservative watchdog use of reducer/native evidence, optional tmux evidence capture, and compact packet shape. Ledger transition persistence for every reducer state and runtime-startup reconcile remain follow-up work.

Target path:

```text
dispatch_confirm
  -> persist native refs, deadlines, expected deliverable, optional tmux mapping
  -> native announce / watchdog tick / status query / startup triggers reconcile
  -> TaskLifecycleReconciler reads ledger + native + receipt + artifact + optional tmux/process evidence
  -> reducer emits canonical status and compact parent packet
  -> ledger event records the transition
  -> notification is best-effort and deduped
```

The main agent does not inspect raw tmux output or child transcripts by default. It reads a compact status packet and explains the state to the user.

## Authority Boundaries

### Native Runtime

OpenClaw native run/flow/subagent registry remains the execution lifecycle authority for accepted/running/completed/failed/timed-out child runs.

Native `completed` means the child run ended. It does not by itself prove OctoClaw has a usable result.

### OctoClaw Metadata Ledger

OctoClaw owns WorkContract metadata, native refs, deadlines, compact receipts, tmux evidence snapshots, transition events, and status projection materialization.

### Projection And Context

`task-state.json`, Slack status panels, footer, dashboard, and main-agent context are projections. They must not invent success from a stale projection or a native completed flag without result evidence.

## Canonical Reducer

Add a small reducer that maps evidence into one canonical status:

```ts
type CanonicalLifecycleStatus =
  | "queued"
  | "running"
  | "running_slow"
  | "stalled"
  | "timed_out"
  | "failed"
  | "degraded"
  | "completed";
```

Required reason examples:

- `completed_with_result`
- `completed_without_result`
- `expected_deadline_passed_live_output`
- `expected_deadline_passed_no_progress`
- `hard_timeout_no_live_evidence`
- `native_failed`
- `native_registry_unavailable`

Rules:

- native completed + receipt/artifact/report/result summary -> `completed`
- native completed + no result evidence -> `degraded` reason `completed_without_result`
- native failed/timed_out -> `failed` or `timed_out`
- expected deadline passed + live output/heartbeat -> `running_slow`
- expected deadline passed + alive but no progress -> `stalled`
- hard timeout passed + no live evidence -> `timed_out`
- otherwise preserve `running` or `queued`

## Deadlines

Persist both deadlines per attempt:

- `expected_at`: soft deadline, used for slow/stalled status only.
- `hard_timeout_at`: hard deadline, used for timeout after live-evidence checks.

If `expectedSeconds` is absent, derive a conservative default from dispatch metadata. If `timeoutSeconds` is absent, use native `runTimeoutSeconds` or the current planner floor.

## Completion Receipt

Use a compact receipt shape derived from native announce/final answer/artifacts:

```ts
interface CompletionReceipt {
  schemaVersion: "octoclaw.completion_receipt/v1";
  workContractId: string;
  attemptId?: string;
  childSessionKey?: string;
  childRunId?: string;
  outcome: "success" | "partial" | "failed" | "timed_out";
  summary: string;
  artifacts: string[];
  reportPath?: string;
  errorCode?: string;
  errorMessage?: string;
  expectedDeliverableMatched?: boolean;
  completedAt: string;
}
```

This borrows the useful 0.4.0 structured-result fields and avoids the old completion-file/finalizer mechanism.

## Tmux Evidence

Tmux is an optional evidence provider. In this local environment it may be enabled by:

```text
OCTOCLAW_TMUX_EVIDENCE=1
```

Evidence shape:

```ts
interface TmuxEvidenceSnapshot {
  enabled: boolean;
  available: boolean;
  session?: string;
  window?: string;
  pane?: string;
  alive: boolean;
  command?: string;
  cwd?: string;
  lastOutputHash?: string;
  outputChangedSinceLastCheck?: boolean;
  lastOutputAt?: string;
  recentOutputExcerpt?: string;
  capturedAt: string;
  error?: string;
}
```

Tmux can support `running_slow` or `stalled`. It cannot prove success. It must not be a hard runtime dependency.

The main agent must not control tmux panes by default. Future controls such as stop/retry/status-request must be separate audited runtime actions.

## Compact Parent Packet

Normal main-agent context should receive only:

- work contract / attempt ids
- canonical status and reason
- short summary
- result location / artifact ids
- native status
- compact evidence classifications
- suggested action

It must not include raw child transcript, raw pane dump, or long logs. A short redacted excerpt is allowed only for abnormal states and should be capped.

Target default packet budget: about 800 tokens.

## Triggers

1. Dispatch confirm records native refs and deadlines.
2. Native announce/failure reconciles that attempt immediately.
3. Periodic watchdog scans active attempts.
4. Status query reconciles active/recent tasks before rendering.
5. Runtime startup reconciles unfinished attempts without retrying them.

## Notification Semantics

Notifications are derived from reducer status transitions:

- `deadline_passed`
- `running_slow_observed`
- `stalled_observed`
- `task_timed_out`
- `completed_without_result`
- `result_ready`
- `failed`

Use idempotency keys:

```text
exec_transition:{workContractId}:{attemptId}:{status}:{reason}
```

Notification failure does not affect truth. Next status query must still show the canonical state from ledger/reconcile.

## Risks

Risk: false timeout while child is still doing useful work.

Mitigation: expected deadline produces slow/stalled, hard timeout checks native/tmux/process evidence before `timed_out`.

Risk: context pollution.

Mitigation: compact packet only by default; raw evidence stays in detail/debug surfaces.

Risk: tmux becomes a hidden execution dependency.

Mitigation: tmux provider is optional; native/ledger evidence remains primary.
