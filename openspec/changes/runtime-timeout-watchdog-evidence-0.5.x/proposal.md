# Change: Runtime Timeout Watchdog And Evidence Reconcile

## Purpose

Make delegated task timeout, stall, and completion state visible and auditable without adding another agent or another runtime.

This change targets the failure mode where a long-running child task is marked `completed` without a result, or remains slow/stalled while the main agent and Slack thread have no compact evidence about whether work is still happening.

## Scope

The implementation may add or refine:

- A deterministic task lifecycle reducer/reconciler.
- Runtime ledger deadline and lifecycle evidence fields/events.
- Watchdog reconcile that reads ledger/native/receipt/artifact evidence instead of treating task-state cache as truth.
- Optional tmux/process evidence provider, enabled locally by config.
- Compact parent status packets for main-agent context.
- Startup and status-query reconcile for unfinished tasks.
- Focused tests for completed-without-result, running-slow, stalled, timed-out, compact context, and notification dedupe.

## Non-Goals

- No new LLM agent for timeout checks.
- No OS-level backup daemon in this slice.
- No restoration of 0.4.0 completion-file/finalizer/outbox.
- No tmux core dependency.
- No default main-agent control over tmux panes.
- No raw child transcript, raw tmux pane dump, or long logs in main-agent context.
- No broad judge/routing/dispatch gate rewrite.
- No automatic retry/restart of unfinished tasks during startup reconcile.

## Acceptance Gate

The change is acceptable when:

- A task past expected deadline with live native/tmux/process evidence becomes `running_slow` or `stalled`, not failed.
- A task past hard timeout without live evidence becomes `timed_out`.
- Native completed without receipt/artifact/report/result summary becomes `degraded(completed_without_result)`, not `completed`.
- Native completed with compact receipt or result evidence becomes `completed`.
- Watchdog and status panel use the same reducer semantics.
- Status query reconciles active/recent tasks before rendering.
- Startup reconcile repairs unfinished task state without retrying tasks.
- Main-agent injected context uses a compact status packet under a bounded token budget.
- Tmux evidence can be enabled with `OCTOCLAW_TMUX_EVIDENCE=1` but remains optional and diagnostic-only.

## Rollout

Default rollout is conservative:

- The reducer may be enabled immediately for status projection and watchdog tests.
- Tmux evidence is optional and enabled in the local macmini environment first.
- Notifications are best effort and deduped by transition key.
- If native/tmux evidence is unavailable, status should become degraded/unknown with reason, not fake completed/running.
