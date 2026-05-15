# Design

## Truth Model

- **Native TaskFlow** owns execution lifecycle: flow/task revision, materialization, spawn/run evidence, heartbeat/progress, result readiness, delivery state.
- **WorkContract** owns semantic route intent, delegation contract, handoff, continuity keys, and allowed/forbidden tool boundaries.
- **RouteSeal** binds a route decision to a turn/thread/work contract and is the commit point for route-commit ACK.
- **TaskStatusProjection** and **MultiTaskStatusProjection** are read models only; they must not invent execution facts.
- **Replay/telemetry** records observability events, including skipped/deduped notifications.

## D1 Route Commit ACK

Route commit ACK runs after route decision and route seal, before dispatch/materialization. It projects route state, never execution state. Delegate wording may say preparing/dispatching, never running/completed unless spawn/result evidence exists.

## D2 Execution Transition Notification

Execution notifications are emitted from real lifecycle sites:

- Dispatch/materialization path: `dispatch_materialized`, `materialized_no_spawn`, `spawn_started`, `spawn_failed`.
- Watchdog/recovery path: `queued_stale`, `heartbeat_stale`, `timed_out`.
- Result/delivery path: `result_ready`, `delivery_failed`.

Notifications use `TaskStatusProjection` or a narrow projection adapter over NativeBinding/TaskRun evidence. They must produce compact parent packets and replay records. A skipped Slack send is not a silent success; parent-visible anomaly state or replay must still be written.

## D3-D5 Evaluation Loop

The harness reads replay logs and Slack acceptance transcripts to produce reports and recommendations. It may recommend rule/judge/model changes, but live promotion requires an explicit gate result of `pass`; `unknown` is never a pass.
