# OctoClaw Display Layer Productization Plan v1

Date: 2026-03-29

This document refines the display-layer productization stage in the main design doc and focuses on IM-native task presentation, queue visibility, progress controls, and on-demand task surfaces.

It covers:

- on-demand task panel behavior
- task queue / running / pending-approval presentation
- IM capability matrix
- channel priority order
- common render schema and channel-specific adapters

This document is implementation-planning only. It does not change runtime behavior by itself.

## 1. Product goal

OctoClaw should not only decide how work runs. It should also make that work visible and operable.

The display layer should answer four user questions clearly:

1. What is OctoClaw doing now?
2. What is queued next?
3. What is blocked on me?
4. How do I stop, inspect, or steer the current task?

The target experience is:

- simple tasks stay quiet
- long or delegated tasks automatically surface a task anchor
- the user can actively expand details, stop work, or approve/reject pending items
- IM channels get the best UX they can support
- WebChat / UI later becomes the full cockpit, while IM stays lightweight and useful

## 2. Design principles

### 2.1 On-demand, not always-on

Do not flood chat with a full board for every request.

Auto-surface only when one of these is true:

- `route != direct`
- task enters queue
- task duration exceeds a short threshold
- task fans out into multiple workers
- task needs approval or user input
- task emits artifacts worth tracking
- user explicitly asks for progress, queue, details, or stop

### 2.2 One task anchor per active task

Each non-trivial task should have one canonical visible anchor in the channel:

- text summary
- current state
- ETA
- cost/model snapshot
- pending action buttons or text commands

Follow-up updates should edit or thread under that anchor when the channel allows it.

### 2.3 Common data model, channel-specific rendering

OctoClaw should not directly author Slack cards, Feishu cards, Telegram buttons, and Discord components separately in task logic.

Instead:

- runtime emits one canonical task view model
- channel adapters render it to:
  - plain text
  - message + thread
  - buttons/selects
  - interactive card
  - topic/thread pin

### 2.4 IM is lightweight ops, UI is full cockpit

IM channels should support:

- queue visibility
- progress visibility
- stop / inspect / approve / retry
- artifact links or summaries

WebChat / Control UI / later Web UI should support:

- full task graph
- child task tree
- artifact browser
- event timeline
- route/model/review reasoning

## 3. Core display objects

The display layer should standardize these objects.

### 3.1 Task summary card

Minimum fields:

- `task_id`
- `title`
- `route`
- `worker_pool`
- `state`
- `progress`
- `queue_position`
- `eta`
- `cost_estimate`
- `active_models`
- `short_reason`

### 3.2 Pending action block

Optional user actions:

- `view`
- `stop`
- `approve`
- `reject`
- `retry`
- `open_artifacts`
- `show_queue`

### 3.3 Detail view

Expanded detail can include:

- parent / child task lineage
- current worker statuses
- artifacts produced so far
- route/model/review explanation
- recent patrol or retry events

### 3.4 Queue view

When multiple tasks are active or queued, show:

- running now
- waiting
- blocked on user
- recently finished

## 4. Task surface modes

OctoClaw should support four rendering modes.

### 4.1 L0: Plain text fallback

Use when the channel only supports basic messages or when advanced rendering is disabled.

Format:

- one concise status line
- optional short queue summary
- optional text commands

Example:

```text
OctoClaw task running: research OpenClaw news
State: running | Route: spawn_single | Model: GPT-5.4 | ETA: ~2m
Reply with: progress / stop / details
```

### 4.2 L1: Text anchor + thread

Use when the channel supports replies/threads but not rich cards well.

Behavior:

- one top-level anchor message
- updates threaded below
- queue and detail commands available in text

### 4.3 L2: Anchor + lightweight actions

Use when the channel supports buttons, selects, or inline interactions.

Behavior:

- anchor message
- lightweight actions like `View`, `Stop`, `Approve`
- thread/topic continues to hold incremental updates

### 4.4 L3: Rich task panel

Use for WebChat / Control UI and later Web UI.

Behavior:

- full queue
- child tasks
- artifacts
- event timeline
- route/model health
- pending approvals

## 5. IM capability matrix

This matrix is the planning baseline for OctoClaw renderer priorities.

| Channel | Text | Thread / Topic | Buttons / Selects | Card / Rich panel | Pin | Streaming updates | Best OctoClaw role |
| --- | --- | --- | --- | --- | --- | --- | --- |
| WebChat / Control UI | Yes | Session-native | App-native | Full UI candidate | N/A | Yes | Full cockpit |
| Slack | Yes | Yes | Yes | Block Kit interactive replies | Yes | Partial via edits/thread updates | First-batch task anchor |
| Discord | Yes | Yes | Yes | Strong components/forms | Yes | Good via component/message updates | Rich ops channel |
| Telegram | Yes | Yes (topics) | Yes | Inline keyboards, lighter than cards | Yes | Moderate | Threaded task anchor |
| Feishu | Yes | Yes (topic/thread) | Card-driven | Interactive cards + streaming cards | Yes | Yes | Card-first task anchor |
| WhatsApp | Yes | Reply context only | No native task UI in current docs | No | No documented pin surface | No rich stream surface | Text-first task anchor |
| WeChat (official ClawBot plugin) | Yes | Private-chat only | Unknown / not assumed | Do not assume rich cards | Unknown | Do not assume | Lightweight text status |

Notes:

- Slack official docs show interactive replies, buttons/selects, pins, and thread behavior.
- Discord official docs show reusable components, forms, thread/forum behavior, and approvals.
- Telegram official docs show inline buttons, forum topics, pins, and ACP topic binding.
- Feishu official docs show interactive cards, streaming card output, pin/list-pins/unpin, and topic/thread replies.
- WhatsApp official docs show production-ready chat support, reply context, ack reactions, and group/DM routing, but not a rich card/button task surface.
- WeChat in current OpenClaw docs refers to Tencent’s official `@tencent-weixin/openclaw-weixin` plugin and is private-chat only. It should be treated as a constrained text-first surface until richer interaction capability is verified.

## 6. Priority order

Two orderings matter here.

### 6.1 User-facing delivery priority

Based on your actual usage and current implementation value:

1. WebChat / Control UI
2. Slack
3. Feishu
4. Telegram
5. Discord
6. WhatsApp
7. WeChat

### 6.2 Platform capability priority

Based on raw interaction richness:

1. WebChat / Control UI
2. Discord
3. Slack
4. Feishu
5. Telegram
6. WhatsApp
7. WeChat

The roadmap should follow the first list, not the second one.

## 7. Recommended channel strategy

### 7.1 WebChat / Control UI

Role:

- full task cockpit
- best place for queue, multi-task, stop, inspect, and lineage

Phase 5 recommendation:

- make WebChat the canonical full-detail surface
- IM messages can link or route users into the detailed view later

### 7.2 Slack

Role:

- first-batch operator-facing task anchor

Recommended UX:

- one task anchor message
- thread for incremental updates
- buttons for `View`, `Stop`, `Approve`, `Retry`
- optional pin for long-running tasks
- queue summary in thread, not in repeated top-level spam

### 7.3 Feishu

Role:

- second-batch card-first task surface

Recommended UX:

- task card as anchor
- streaming card updates for long tasks
- pin important task cards when user asks or task exceeds a threshold
- text commands remain available for fallback

### 7.4 Telegram

Role:

- topic-oriented lightweight operations channel

Recommended UX:

- topic thread as task lane
- inline buttons for `View`, `Stop`, `Approve`
- pin active task anchor in-topic

### 7.5 Discord

Role:

- rich ops surface for communities and power users

Recommended UX:

- task thread or forum post
- component panel for actions
- modal/forms for approvals or extra input

### 7.6 WhatsApp

Role:

- text-first notification and control surface

Recommended UX:

- concise status anchors
- reply-based follow-up
- lightweight command words: `progress`, `details`, `stop`
- no assumption of cards/buttons/pins

This should be supported because WhatsApp is important in OpenClaw’s ecosystem, but it should not define the common interaction model.

### 7.7 WeChat (official ClawBot plugin)

Role:

- private-chat lightweight control surface

Recommended UX:

- text-first status
- explicit commands for `progress`, `queue`, `stop`
- do not assume advanced card/action support until verified in plugin behavior

## 8. On-demand task panel behavior

The task panel concept should be split by surface.

### 8.1 In IM

Use a task anchor, not a true floating panel.

Capabilities:

- visible progress anchor
- queue summary
- stop / approve / inspect
- update in thread/card/topic when possible

### 8.2 In WebChat / UI

This is where the CodeX-style bottom task panel idea should live.

Desired behavior:

- automatically appears for queued or long tasks
- stays docked while work continues
- can be minimized, reopened, or stopped
- supports lightweight steering during execution
- shows queued vs running vs blocked tasks clearly

## 9. Information architecture

The same underlying task state should be reusable across all renderers.

### 9.1 Required shared fields

- task identity
- parent/child lineage
- route
- worker pool
- phase
- profile
- model list
- progress
- queue state
- pending approvals
- artifact list
- patrol/retry summary

### 9.2 Renderer-specific additions

- Slack: thread links, pin state, button actions
- Feishu: card payload, streaming card mode, pin actions
- Telegram: topic/thread identifiers, inline keyboard payloads
- Discord: component blocks, modal forms, reusable component metadata
- WhatsApp/WeChat: text command hints and compact state summaries

## 10. Phase 5 implementation order

### Phase 5A: task view model and renderer boundary

Deliver:

- canonical display schema
- renderer interfaces
- plain-text fallback renderer

### Phase 5B: Slack first

Deliver:

- task anchor
- thread updates
- button actions
- optional pin behavior

### Phase 5C: Feishu

Deliver:

- task card renderer
- streaming card updates
- pin/list-pins integration

### Phase 5D: WebChat full task panel

Deliver:

- docked task panel
- queue view
- stop / inspect / artifacts

### Phase 5E: Telegram / Discord

Deliver:

- Telegram topic-anchor UX
- Discord component-panel UX

### Phase 5F: WhatsApp / WeChat

Deliver:

- stable text-first task anchors
- compact command-driven interaction

## 11. What not to do

- Do not make every IM emulate the same UI literally.
- Do not put the full task graph in every chat by default.
- Do not rely on one channel’s card format as the canonical model.
- Do not let the display layer become the source of truth; it should render runtime state, not invent it.

## 12. Immediate next document after this one

After this plan is accepted, the next useful document should be:

- `OctoClaw Task Display Schema v1`

That schema should define:

- shared task view model
- pending action model
- renderer contract
- text fallback rules

## References

- [OpenClaw Channels](https://docs.openclaw.ai/channels)
- [OpenClaw Slack](https://docs.openclaw.ai/channels/slack)
- [OpenClaw Discord](https://docs.openclaw.ai/channels/discord)
- [OpenClaw Telegram](https://docs.openclaw.ai/channels/telegram)
- [OpenClaw Feishu](https://docs.openclaw.ai/channels/feishu)
- [OpenClaw WhatsApp](https://docs.openclaw.ai/channels/whatsapp)
- [OpenClaw WebChat](https://docs.openclaw.ai/web/webchat)
- [OpenClaw README](/Users/guanzhicheng/Documents/Playground/openclaw-upstream/README.md)
