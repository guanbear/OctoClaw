# OctoClaw × OpenClaw Task Flow Analysis v1 (2026-04-01)

## 1. 结论

OpenClaw 3.31 的 `tasks / flows` 很值得 OctoClaw 借鉴，但当前最稳的迁移方式不是直接把 OctoClaw 内核改成依赖上游 task ledger，而是：

1. `mirror-first`
2. `native-fact binding`
3. `native-preferred create`
4. 视情况再进入 `native-only`

也就是说：

> OctoClaw 继续保留自己的 runtime truth；OpenClaw task/flow 先作为 detached runtime substrate facts 接入。

## 2. 当前上游事实

公开 CLI 当前只有：

- `openclaw tasks list/show/cancel/notify/audit`
- `openclaw flows list/show/cancel`

当前没有公开的 `tasks create` / `flows create` CLI。

OpenClaw 内部 runtime 会自动创建 task/flow，但那走的是内部 API，而不是公开命令面。

## 3. 为什么先做 mirror

### 3.1 防止混淆上游原生 task

OpenClaw 原生 task registry 里会同时出现：

- ACP task
- cron task
- subagent task
- 后台 CLI task

这些不能自动等同于 OctoClaw task。

所以当前阶段必须坚持：

- OctoClaw 只把带自己 binding 的 task/flow 回流进：
  - status
  - patrol
  - replay
  - task inbox

### 3.2 先把 OctoClaw 运行面收成 task-flow aware

即使不直接写 OpenClaw registry，OctoClaw 也应该先统一暴露这些字段：

- `openclaw_taskflow`
- `openclaw_taskflow_backend`
- `openclaw_taskflow_state`
- `openclaw_task_id`
- `openclaw_flow_id`
- `openclaw_flow_kind`

这样后续从 mirror 切到 native-preferred create 时，不需要重做：

- runtime task record
- patrol
- status
- task display / task inbox

## 4. 当前落地状态

当前已经落下来的能力：

- `runner / spawn_single / spawn_multi` 都是 task-flow aware
- `spawn_single` 已开始做 native subagent task binding
- `task-state-update` 会在 upsert 时补 taskflow binding
- `patrol` 会刷新活动任务的 native facts
- `task display / status` 已能显示 substrate 摘要

当前仍然是：

> `mirror-first + native-fact binding`

而不是：

> `native create`

## 5. runner 怎么接 task flow

### 5.1 runner-as-task

这一步值得做，而且应该先做。

runner job 先成为 first-class task，会直接带来：

- 更统一的 queued/running/terminal 事实层
- 更统一的 audit/status/cancel 语义
- 更少 patrol 纯猜测式观察

### 5.2 runner-as-flow

可以做，但应该晚于 `runner-as-task`。

更适合的场景：

- bounded inspect/collect/summarize
- 需要 parent shell 的 runner workflow

### 5.3 runner-daemon 现在还不能直接删

OpenClaw tasks/flows 当前更像：

- detached ledger
- parent shell
- blocked/retry/reopen substrate

还不是 OctoClaw persistent runner queue 的完整替代品。

## 6. 稳定性收益

按 task flow 方向迁，OctoClaw 会更稳，主要体现在：

- detached work 的真相更统一
- parent/child lineage 更少 split-brain
- blocked/retry/reopen 更接近上游原生语义
- 回原 session / 原 thread 的收口更自然
- patrol 可以减少“猜状态”的职责

## 7. 和 Anthropic 方法论的关系

这条路线和 OctoClaw 当前坚持的方法论是对齐的：

- `workflow-first`
- `policy-first`
- `artifact-first / event-first / state-first`
- `light by default, heavy on demand`

更准确地说：

- OpenClaw tasks/flows 负责 workflow substrate
- OctoClaw 继续负责 route/model/review/budget policy
- ClawTeam 逐步退成 optional operator backend

## 8. 一句话收口

> OpenClaw tasks/flows 适合接 OctoClaw 的 detached runtime substrate，但不能直接取代 OctoClaw 的策略脑；ClawTeam 可以逐步从核心依赖降成可选协作后端。
