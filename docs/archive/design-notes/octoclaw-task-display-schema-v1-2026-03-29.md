# OctoClaw Task Display Schema v1

Date: 2026-03-29

This document defines the first shared rendering contract for OctoClaw task presentation across:

- text channels
- IM-native interactive renderers
- WebChat / Control UI
- later Web UI

It is a product and interface document, not a UI implementation spec.

Related documents:

- [octoclaw-display-layer-productization-plan-v1-2026-03-29.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus/octoclaw-display-layer-productization-plan-v1-2026-03-29.md)
- [octoclaw-product-design-v2-2026-03-27.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus/octoclaw-product-design-v2-2026-03-27.md)

## 1. Why this schema exists

Phase 5 should not start by designing channel-specific cards directly.

OctoClaw needs one shared task display contract so that:

- runtime produces one canonical task view
- channel adapters render from the same source
- WebChat and later Web UI can reuse the exact same information
- replay and status tooling can verify display completeness

Without this layer, Slack, Feishu, Telegram, Discord, WhatsApp, and WebChat will drift into separate display dialects.

## 2. Scope

This schema is for **display state**, not runtime truth ownership.

Runtime truth still comes from:

- task records
- runtime policy decision objects
- lineage / board / artifacts
- patrol / replay / status sources

The display schema only packages those signals into a renderer-friendly view.

## 3. Render model overview

Each renderable task surface should be built from three nested objects:

1. `task_anchor`
2. `task_detail`
3. `task_actions`

Optional fourth object:

4. `task_queue_view`

## 4. `task_anchor`

This is the minimum visible object that appears in an IM channel for a non-trivial task.

### 4.1 Required fields

- `task_id`
- `title`
- `state`
- `route`
- `worker_pool`
- `progress`
- `summary`

### 4.2 Recommended fields

- `phase`
- `profile`
- `eta`
- `queue_position`
- `cost_estimate`
- `model_summary`
- `started_at`
- `updated_at`

### 4.3 Field semantics

#### `title`

Short human-readable label.

Examples:

- `Research OpenClaw recent news`
- `Fix login 401 and add tests`
- `Review deploy checklist`

#### `state`

Allowed values:

- `queued`
- `running`
- `blocked`
- `needs_approval`
- `completed`
- `failed`
- `cancelled`

#### `route`

Display value only. Derived from runtime.

Allowed values:

- `direct`
- `runner`
- `spawn_single`
- `spawn_multi`

#### `worker_pool`

Primary worker identity:

- `octoclaw-runner`
- `octoclaw-research`
- `octoclaw-code`
- `octoclaw-review`
- `octoclaw-main`

#### `progress`

Normalized 0-100 integer or `null`.

If true percentage is unavailable, renderers may derive coarse progress buckets:

- `queued`
- `starting`
- `working`
- `finalizing`

#### `summary`

A short, channel-safe explanation of what is happening now.

Examples:

- `Reviewing 3 sources and writing a short brief`
- `Checking nginx logs and port state`
- `Waiting for approval before retrying deploy`

## 5. `task_detail`

This object supports expanded views in IM or full views in WebChat/UI.

### 5.1 Required fields

- `task_id`
- `summary`
- `state`
- `lineage`
- `models`
- `artifacts`
- `events`

### 5.2 `lineage`

Structure:

- `parent_task_id`
- `child_task_ids`
- `active_child_count`
- `completed_child_count`

### 5.3 `models`

Structure:

- `main_model`
- `active_models[]`
- `model_health_summary`

`model_health_summary` should allow display of:

- healthy
- degraded
- cooldown
- quota_high
- quota_critical

### 5.4 `artifacts`

Each artifact entry:

- `artifact_id`
- `kind`
- `title`
- `path`
- `preview`
- `ready`

Suggested `kind` values:

- `report`
- `summary`
- `patch`
- `log`
- `trace`
- `attachment`

### 5.5 `events`

Each event entry:

- `time`
- `kind`
- `message`
- `importance`

Suggested `kind` values:

- `route_selected`
- `worker_started`
- `worker_completed`
- `review_requested`
- `approval_required`
- `retry`
- `fallback`
- `cooldown_applied`
- `artifact_ready`

## 6. `task_actions`

This is the normalized action model. Channels can render all, some, or none of these.

### 6.1 Allowed actions

- `view`
- `stop`
- `approve`
- `reject`
- `retry`
- `show_queue`
- `open_artifacts`
- `show_details`

### 6.2 Action metadata

Each action entry should contain:

- `id`
- `kind`
- `label`
- `enabled`
- `danger`
- `requires_confirmation`
- `fallback_command`

Example:

```json
{
  "id": "stop",
  "kind": "stop",
  "label": "Stop",
  "enabled": true,
  "danger": true,
  "requires_confirmation": true,
  "fallback_command": "stop"
}
```

### 6.3 Fallback rule

Every action must have a text fallback even if buttons/cards are available.

Examples:

- `View` -> `details`
- `Stop` -> `stop`
- `Approve` -> `approve`
- `Reject` -> `reject`
- `Show queue` -> `queue`

## 7. `task_queue_view`

This is not required in every IM update, but should exist for renderers that can show queue state.

### 7.1 Fields

- `running[]`
- `queued[]`
- `blocked[]`
- `recently_completed[]`

Each item can reuse a compact `task_anchor`.

### 7.2 When to show queue view

Show queue view only when:

- more than one active task exists
- the user explicitly asks for queue/progress
- the current task is blocked behind others

## 8. Surface-specific rendering rules

### 8.1 Plain-text renderer

Must render:

- title
- state
- route
- worker_pool
- summary
- at least one available text action

Should not render:

- full event timeline
- full child tree
- raw paths unless explicitly requested

### 8.2 Slack renderer

Should render:

- task anchor message
- thread updates
- compact button row
- optional queue section in thread

May render:

- pin/unpin state
- cost/model line

### 8.3 Feishu renderer

Should render:

- task card
- streaming card updates for long tasks
- compact actions

May render:

- pin state
- artifact section

### 8.4 Telegram renderer

Should render:

- topic/thread anchor
- inline keyboard actions
- compact progress updates

### 8.5 Discord renderer

Should render:

- anchor message or thread post
- component buttons/selects
- optional modal for approval details

### 8.6 WhatsApp / WeChat renderer

Should render:

- concise text anchor
- text action hints
- short progress updates

Should not assume:

- cards
- button actions
- pin support

## 9. Auto-surface rules

Renderers should only auto-create a task anchor when one of these is true:

- `route` is `runner`, `spawn_single`, or `spawn_multi`
- task is queued
- task runtime exceeds threshold
- task has pending approval
- task has visible child work
- task generated artifacts

Suggested default threshold:

- `auto_surface_after_seconds = 8`

## 10. Update rules

### 10.1 Create

Create a new task anchor when:

- task first becomes visible
- no existing anchor exists for that `task_id`

### 10.2 Update

Update existing anchor when:

- state changes
- progress changes materially
- queue position changes materially
- approval is required
- completion/failure happens

### 10.3 Expand

Switch to detail view when:

- user clicks `View`
- user types `details`
- task becomes blocked
- task fans out into multiple children

## 11. Minimum implementation slice

This document is detailed enough to start implementation.

The smallest useful build is:

### Phase 5A-MVP

- shared `task_anchor` schema
- plain-text renderer
- Slack task anchor renderer
- text fallback commands
- task anchor creation/update rules

This is enough to start development without waiting for full Web UI work.

## 12. Development readiness

### 12.1 Ready now

Yes, development can start now for:

- shared display schema implementation
- plain-text renderer
- Slack task anchor prototype
- status-to-display adapter

### 12.2 Not required before starting

You do not need to finish:

- full Web UI
- Feishu card renderer
- Discord components
- Telegram topic renderer

before starting the first Phase 5 slice.

### 12.3 Recommended first coding order

1. add shared task display adapter
2. add plain-text renderer
3. add Slack renderer MVP
4. wire auto-surface rules
5. add stop/details/queue fallback commands

## 13. Open questions

These are not blockers for starting:

- exact ETA calculation quality
- exact cost estimation formatting
- whether queue view is top-level or detail-only in each channel
- whether task anchors should auto-pin in Slack/Feishu

## 14. References

- [octoclaw-display-layer-productization-plan-v1-2026-03-29.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus/octoclaw-display-layer-productization-plan-v1-2026-03-29.md)
- [octoclaw-product-design-v2-2026-03-27.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus/octoclaw-product-design-v2-2026-03-27.md)
