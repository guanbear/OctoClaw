# OctoClaw IM / Display Contract

> 状态：P3+P4 contract baseline（2026-04-06）  
> 用途：定义 IM/display 的交互状态机、surface ownership、capability matrix，以及 display 对 substrate truth 的最小依赖契约。  
> 关联文件：`lib/im_display_contract.py`、`lib/im_thread.py`、`lib/notifier.py`、`lib/task_display.py`

---

## 1. Surface ownership

| Surface | Role | Control Mode | Canonical Observer |
|---|---|---|---|
| IM | lightweight ops + notifications | partial | no |
| CLI | canonical text operator surface | full | yes |
| tmux/workbench | optional live control/workbench | full | no |
| Web/UI | future full cockpit | future | future |

---

## 2. Interaction state machine

### `open`
- requires canonical anchor
- idempotent
- preferred path: send anchor
- fallback: send anchor
- thread state: `active`

### `update`
- requires canonical anchor
- idempotent
- preferred path: edit anchor
- fallback: thread reply
- thread state: `active`

### `close`
- requires canonical anchor
- idempotent
- preferred path: edit anchor
- fallback: thread reply
- thread state: `closed`

---

## 3. Action taxonomy

| Action | Class | Replay-safe |
|---|---|---:|
| `view` | observe | yes |
| `show_queue` | observe | yes |
| `retrieve` | navigate | yes |
| `timeline` | navigate | yes |
| `graph` | navigate | yes |
| `open_artifacts` | navigate | yes |
| `explorer` | navigate | yes |
| `stop` | destructive-control | no |
| `retry` | safe-control | no |
| `approve` | approval-mediated | no |
| `reject` | approval-mediated | no |

---

## 4. Capability matrix

| Surface | Level | Anchor | Thread/Topic | Edit/Update | Interactive Actions | Artifact Access | Fallback |
|---|---|---:|---:|---:|---:|---|---|
| Slack | L2 | yes | yes | yes | yes | summary+link | edit_or_thread_text |
| Discord | L2 | yes | yes | yes | yes | summary+link | edit_or_thread_text |
| Telegram | L1 | yes | yes | yes | yes | summary+link | edit_or_topic_reply |
| Feishu | L1 | yes | yes | no | no | summary+link | card_or_text_send |
| WhatsApp | L0 | yes | no | no | no | text_summary | text_reply_only |
| WeChat | L0 | yes | no | no | no | text_summary | text_reply_only |
| CLI | L2 | yes | no | yes | no | full | n/a |
| tmux | L2 | yes | no | yes | no | full | n/a |
| Web/UI | future | yes | future | future | future | future_full | future |

---

## 5. Minimum substrate display contract

### Required fields
- `task_id`
- `state`
- `route`
- `worker_pool`
- `substrate_summary`
- `action_availability`

### Optional fields
- `queue_position`
- `model_summary`
- `cost_estimate`
- `related_thread_artifacts`
- `create_preference`
- `create_status`

### Substrate cleanup policy
- mirror cleanup 只针对 `mirror_only` / `native_unavailable_fallback_mirror` 的 terminal task
- 默认 retention：`48h`
- cleanup 先 preview，再 apply
- cleanup 只删 taskflow mirror entry，不回写 runtime truth
- current operator surface:
  - `task_display_cli.py substrate`
  - `task_display_cli.py substrate --cleanup-preview`
  - `task_display_cli.py substrate --cleanup-apply`

### Forbidden inferred fields
- guessed task state
- renderer-authored truth
- unconfirmed delivery/completion inference

---

## 6. Current implementation note

P3+P4 当前已落到这些代码：

- `lib/im_display_contract.py`：shared contract source
- `lib/im_thread.py`：interaction contract / thread_state usage
- `lib/notifier.py`：surface capability metadata
- `lib/task_display.py`：action taxonomy + substrate display contract exposure
- `lib/openclaw_taskflow_adapter.py`：create preference / create status surfaced into taskflow bindings，mirror cleanup preview/apply

另外，simple `spawn_multi` 的 linear flow baseline 现在也进入了 graph/timeline：

- step-order / step-task-id 可以在没有 `parent_id` 的情况下形成 linear step edges
- timeline 会去重 child step events，避免同一步骤因多条 edge 重复刷屏

这意味着当前已不是纯规划，而是：

> **interaction contract first, substrate truth second** 的 baseline 已进入代码。

---

## 7. Signoff status（2026-04-06）

### P3 product-surface signoff: approved

本阶段冻结的 P3-owned clauses：

- surface ownership
- interaction state machine
- action taxonomy
- capability matrix
- accepted fallback / gap ledger

当前接受的产品面定位：

- **IM** = lightweight ops + notifications
- **CLI** = canonical text operator surface + canonical observer
- **tmux/workbench** = optional live control/workbench
- **Web/UI** = future full cockpit

当前接受的 fallback/gap：

- Feishu 仍是 **L1**：thread-capable，但无 edit/update、无 interactive actions
- WhatsApp / WeChat 仍是 **L0**：text-first fallback surface
- Web/UI 仍是 **future**，不算本阶段已实现 rich surface

### P4 native-preferred + cleanup closeout: approved with evidenced convergence

本阶段冻结的 P4-owned clauses：

- minimum substrate display contract
- `create_preference` / `create_status`
- native-preferred create posture
- cleanup policy
- legacy mirror / fallback transition inventory
- explicit read-order matrix

当前 closeout 结论：

- `spawn_single` / `spawn_multi` 的 create posture 已明确为 **native-preferred**
- `create_preference` / `create_status` 已进入 shared substrate display contract
- cleanup policy 维持 **preview/apply + retention + terminal-only + mirror-entry-only deletion**

### Read-order matrix

| Surface | Status | Interpretation |
|---|---|---|
| `display` | `substrate_first` | anchor/slack payload 先显式暴露 `TaskFlow target + substrate summary + create path`，再展示 report-oriented summary |
| `retrieve` | `substrate_first` | canonical read order 先读 `TaskFlow flow/task target + taskSummary + review surface`，再读 report/context |
| `observer` | `evidenced_substrate_aware` | runtime observer 已有显式 substrate/taskflow-aware read path，不再只有 runner/count snapshot |
| `review` | `evidenced_substrate_aware` | detail/retrieve 已有 review surface，能露出 review child task 与其 substrate 状态 |

### Read-order basis

本轮 closeout 以 **OpenClaw 2026.4.5** 的 TaskFlow/runtime 源码为准：

- operator first read = `flow/task target`
- then `taskSummary` / `wait` / `blocked` / linked child task health
- artifacts/report/context 是后续补充面，不应反向主导 substrate truth
