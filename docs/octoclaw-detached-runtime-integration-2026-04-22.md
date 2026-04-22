# OctoClaw Detached Runtime Integration

Date: 2026-04-22

## What changed

OctoClaw now hooks its runtime plugin into OpenClaw's detached task runtime registration seam.

That seam lets a plugin become the lifecycle owner for detached task operations without reaching into
core task internals from patrol scripts or helper sidecars.

The first landing is intentionally narrow:

- detached task create/start/progress/complete/fail/delivery mutations still delegate to OpenClaw's
  core task-executor implementation
- flow-backed task cancellation now prefers the managed TaskFlow owner path
- lost-task maintenance now gets a flow-aware recovery check before a task is marked `lost`

## Why this helps

This improves two weak spots we have seen in OctoClaw's current integration:

- native task binding stability
  OctoClaw already binds managed TaskFlows through the runtime bridge, but detached task lifecycle
  ownership was still effectively split between core ledger behavior and sidecar compensation
- subagent state maintenance
  when a task is still alive in TaskFlow truth but a backing session check looks stale, patrol-style
  compensation can race with native truth and produce avoidable `lost` or cancel drift

With the detached runtime wrapper in place, TaskFlow-backed tasks get one coherent owner path for:

- cancel intent
- pre-`lost` recovery
- final cancellation ledger update

## What this does not solve yet

This is not a full replacement for the rest of OctoClaw's runtime compensation layer.

It does not add:

- durable retry queues
- crash-safe executor resurrection
- richer stuck-task diagnosis
- elimination of existing Python patrol/task-state projections

Those are still separate follow-up tracks.

## Current implementation shape

The integration uses a deliberately thin wrapper runtime:

- core task lifecycle mutations are forwarded to OpenClaw's built task-executor module
- flow-aware cancel/recovery calls are routed through the existing taskflow bridge
- OpenClaw bundle resolution is shared with the existing runtime bridge path instead of introducing
  a second host-loading strategy
- if a task does not carry usable flow ownership metadata, the wrapper returns `found: false` so
  OpenClaw core falls back to its normal cancel path

That keeps the integration aligned with the design docs:

- plugin/runtime-first
- TaskFlow ownership as truth
- CLI/operator paths as fallback
- no parallel detached-task subsystem inside OctoClaw

So yes, a detached runtime wrapper would add unnecessary complexity if it became a second abstraction
layer. In the current shape it should stay acceptable because it is only a thin ownership seam over
existing runtime and TaskFlow primitives.
