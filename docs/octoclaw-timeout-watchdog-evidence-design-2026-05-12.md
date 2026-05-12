# OctoClaw timeout watchdog and evidence design

Date: 2026-05-12
Status: design, phase 1 implemented
Scope: OctoClaw runtime, delegated task status, watchdog reconcile, compact parent context

## Goal

This design fixes one operational failure class:

1. A delegated task runs for a long time, times out, stalls, or silently fails, but the main agent and Slack thread do not learn that in time.
2. A task is marked `completed` even though there is no verifiable result, artifact, report path, or completion receipt.
3. The main agent needs enough compact evidence to explain status and judge obvious success/failure, without reading raw child transcripts, tmux panes, or long logs into its conversation context.

The target behavior is:

- Timeout or stalled execution becomes a runtime fact within one watchdog interval or at the next status query.
- "Still doing work" is backed by native run, heartbeat, tmux, process, or artifact evidence.
- `completed` means result evidence exists.
- The main agent sees only a compact receipt/status packet by default.

## Non-goals

- Do not add a new LLM agent just to check timeouts.
- Do not restore the old 0.4.0 completion-file/finalizer/outbox path.
- Do not make tmux a required execution substrate.
- Do not let the main agent control child tmux panes by default.
- Do not inject raw tmux output, child transcripts, or long result bodies into the main agent context.

## Existing lesson from 0.4.0

OctoClaw 0.4.0 had a useful structured worker result shape:

```ts
status: "success" | "failure" | "partial";
summary: string;
artifacts?: string[];
errorCode?: string;
errorMessage?: string;
```

The useful part is the compact result contract. The part to avoid is requiring the child to write a `.completion.json` file and having a finalizer poll for it. The current native planner path should instead derive the same compact fields from native announce, final answer metadata, artifact/report paths, or runtime receipts.

## Architecture

Use a deterministic runtime reconciler, not an LLM agent:

```text
OpenClaw runtime process
  ├─ event-driven reconcile
  ├─ periodic watchdog tick
  ├─ status-query reconcile
  └─ startup reconcile

optional evidence providers
  ├─ native run registry
  ├─ runtime ledger
  ├─ artifact/report filesystem
  └─ tmux/process snapshot
```

There is no OS-level backup job in the initial design. If OpenClaw is down, active notification cannot happen. On restart, startup reconcile must scan unfinished ledger tasks and repair their visible state.

## Canonical statuses

The status reducer owns the user-visible status. Other code should not independently guess terminal state.

| Status | Meaning |
| --- | --- |
| `queued` | Dispatch exists but child run is not confirmed running. |
| `running` | Native/ledger evidence shows fresh progress before expected deadline. |
| `running_slow` | Expected deadline passed, but native/tmux/process evidence shows active work. |
| `stalled` | Expected deadline passed, process/pane appears alive, but no heartbeat or output changed recently. |
| `timed_out` | Hard timeout passed and there is no live/recoverable execution evidence, or native explicitly timed out. |
| `failed` | Native or receipt reports failure. |
| `degraded(completed_without_result)` | Native says completed, but no result receipt, artifact, report path, or result summary exists. |
| `completed` | Completion receipt or result evidence exists and is linked to this work contract/attempt. |

Important rule: native `completed` only means the child run ended. It does not by itself mean the delegated task produced a usable result.

## Deadlines

Each delegated attempt should persist:

```ts
expectedAt: string;       // startedAt + expectedSeconds
hardTimeoutAt: string;    // startedAt + timeoutSeconds or native runTimeoutSeconds
lastHeartbeatAt?: string;
lastProgressAt?: string;
```

`expectedAt` is a soft deadline. Passing it can produce `running_slow` or `stalled`, not failure.

`hardTimeoutAt` is the hard deadline. Passing it allows `timed_out`, but only after reconcile checks live evidence.

## Completion receipt

Add or normalize to a compact receipt shape:

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

This can be produced from native announce/final answer/artifacts. It should not require a child-written completion file in the planner/native path.

## Reconcile algorithm

For each active or recently terminal delegated attempt:

1. Load ledger attempt, WorkContract metadata, deadline fields, native refs, and last known receipt.
2. Query native run/flow status if native refs exist.
3. Check result evidence:
   - completion receipt
   - artifact refs
   - report path
   - result summary
   - delivery ack
4. If tmux evidence is enabled and a pane/session mapping exists, capture a small snapshot.
5. Run the reducer:
   - native completed + result evidence -> `completed`
   - native completed + no result evidence -> `degraded(completed_without_result)`
   - native failed/timed_out -> `failed` or `timed_out`
   - expectedAt passed + live evidence with output/heartbeat -> `running_slow`
   - expectedAt passed + alive but no progress -> `stalled`
   - hardTimeoutAt passed + no live evidence -> `timed_out`
   - otherwise keep `running`/`queued`
6. Write a ledger event whenever canonical status changes.
7. Best-effort send a compact transition notification. Notification failure must not change truth.

## Tmux evidence provider

Tmux is optional evidence, not runtime truth. In this macmini environment it can be enabled first because local delegated work often has a tmux/process surface.

Suggested config:

```text
OCTOCLAW_TMUX_EVIDENCE=1
OCTOCLAW_TMUX_EVIDENCE_MAX_LINES=80
OCTOCLAW_TMUX_EVIDENCE_MAX_CHARS=1200
```

Snapshot shape:

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

Default model-context packet must not include the full `recentOutputExcerpt`. Store full-ish snapshot in ledger/debug detail, and expose only a short excerpt when status is `running_slow`, `stalled`, or `timed_out`.

Tmux evidence rules:

- Alive pane with changing output can support `running_slow`.
- Alive pane with unchanged output can support `stalled`.
- Missing pane does not prove failure if native registry still says running.
- Tmux cannot prove success. Success still requires receipt/artifact/report evidence.
- Main agent must not send keys or commands to child tmux panes by default. Any future control action must be an explicit audited runtime action.

## Main agent context hygiene

The main agent should receive a compact parent packet, not raw logs:

```ts
interface CompactExecutionStatusPacket {
  workContractId: string;
  attemptId?: string;
  status: string;
  reason: string;
  summary?: string;
  resultLocation?: string;
  artifacts: string[];
  nativeStatus?: string;
  childRunId?: string;
  childSessionKey?: string;
  elapsedMs?: number;
  expectedAt?: string;
  hardTimeoutAt?: string;
  evidence: {
    native: "running" | "completed" | "failed" | "timed_out" | "missing" | "unavailable";
    receipt: "present" | "missing";
    artifact: "present" | "missing";
    tmux?: "alive_active" | "alive_idle" | "missing" | "unavailable" | "disabled";
  };
  suggestedAction: "wait" | "inspect" | "retry" | "stop" | "deliver" | "ask_user";
}
```

Hard limits:

- Keep default injected packet under about 800 tokens.
- Do not inject child transcript.
- Do not inject raw tmux pane output except a short, redacted excerpt for abnormal states.
- Store detailed evidence in ledger/status detail views and let the main agent request it only for debug.

This gives the main agent enough context to say "still running", "stalled", "timed out", or "completed without result" without wasting context or inducing log-style replies.

## Trigger points

1. `dispatch_confirm`
   - Record native refs, deadlines, expected deliverable, and optional tmux mapping.

2. Native announce/failure
   - Reconcile that attempt immediately.

3. Periodic watchdog tick
   - Low-frequency scan of active attempts.
   - Initial target: 30s to 60s, with lease/dedupe so multiple runtimes do not double-notify.

4. Status query
   - Before rendering `octoclaw_status` or task detail, reconcile active and recently terminal attempts.

5. Runtime startup
   - Scan unfinished attempts from ledger and reconcile once.
   - Do not restart or retry tasks automatically.
   - Notify only status changes to terminal/degraded/stalled states, with dedupe.

## Notification semantics

Notifications are derived from ledger state changes:

- `deadline_passed`
- `running_slow_observed`
- `stalled_observed`
- `task_timed_out`
- `completed_without_result`
- `result_ready`
- `failed`

Each notification uses an idempotency key:

```text
exec_transition:{workContractId}:{attemptId}:{status}:{reason}
```

If notification fails, the ledger still carries truth. The next status query must show the same canonical status.

## What the main agent judges

The main agent may judge:

- whether the compact summary appears to answer the user's request
- whether a report/artifact path is relevant
- whether a partial result needs user decision

The main agent must not judge from:

- raw child transcript
- full tmux logs
- debug footer text
- unverified native `completed` alone

For high-risk quality checks, a separate verifier agent can be used, but that is not part of the default timeout path.

## Implementation slices

Phase 1 in `v0.5.0` implements the reducer, status-query projection, conservative watchdog integration, optional tmux evidence capture, and compact packet builder. It intentionally does not yet persist every reducer transition to ledger events or run startup reconcile on runtime boot.

1. Introduce `TaskLifecycleReconciler` and reducer tests.
   - completed without result becomes `degraded(completed_without_result)`.
   - expected timeout with live evidence becomes `running_slow` or `stalled`.
   - hard timeout without live evidence becomes `timed_out`.

2. Move watchdog input from task-state cache toward ledger/native/receipt evidence.

3. Add tmux evidence provider behind `OCTOCLAW_TMUX_EVIDENCE=1`.

4. Make `octoclaw_status` run reconcile before rendering.

5. Add startup reconcile for unfinished attempts.

6. Add compact parent packet sanitization and token limits.

## Acceptance checks

- A long-running child past expectedAt but with active tmux/native evidence is shown as `running_slow`, not failed.
- A child past hardTimeoutAt with no native/tmux/process evidence is shown as `timed_out`.
- Native completed without receipt/artifact/report is shown as `degraded(completed_without_result)`, not `completed`.
- A completed task with receipt/artifact/report is shown as `completed`.
- Main agent context contains compact packet only; raw tmux output and child transcript stay out of normal model context.
- Runtime restart reconciles unfinished tasks without automatically retrying them.
- Slack receives at most one notification per state transition.
