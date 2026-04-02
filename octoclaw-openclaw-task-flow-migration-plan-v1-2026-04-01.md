# OctoClaw × OpenClaw Task Flow Migration Plan v1 (2026-04-01)

## 1. 迁移原则

1. OctoClaw 保留自己的 runtime truth。
2. OpenClaw `tasks / flows` 先作为 substrate facts 接入。
3. ClawTeam 逐步从核心依赖降成 optional operator backend。
4. 不把 ACP / cron / unrelated subagent task 混进 OctoClaw 视图。
5. 运行时解释器要收口：当前 control-plane Python 脚本默认以 3.10+ 为基线，部署面需要优先提供稳定解释器；长期再评估哪些脚本值得继续保留，哪些应迁到 Node/TS。

## 2. 边界

### 2.1 OctoClaw 继续拥有

- route decision
- worker pool / work type / phase / profile
- model selection policy
- review / budget / delivery policy
- runtime task record

### 2.2 OpenClaw tasks/flows 负责

- detached task ledger
- one-task / linear flow parent shell
- blocked / retry / reopen substrate
- return-to-session baseline

### 2.3 ClawTeam 保留为可选 backend

- tmux/team operator runtime
- heavier board / inbox / multi-owner collaboration

## 3. 分阶段计划

### TF1：mirror-first

目标：

- 先让 OctoClaw task record 全部变成 task-flow aware
- 先写本地 mirror，不假设上游有公开 create CLI

状态：

- 已完成

### TF2：native-fact binding

目标：

- 不直接写 OpenClaw registry
- 先把 OctoClaw task 绑定到已经存在的 OpenClaw native task facts

范围：

- 优先 `spawn_single`
- 后续 runner/simple multi 再加

状态：

- 第一拍已完成

### TF2.5：runner-as-task

目标：

- runner 至少成为 first-class task substrate
- 统一 status/audit/display 事实层

状态：

- 目前是 mirror-first task aware
- 后续可继续增强 native binding

### TF3：native-preferred create

目标：

- 对最适合的路径优先走 OpenClaw 原生 detached runtime create

建议顺序：

1. `spawn_single`
2. simple `spawn_multi`
3. `runner` 的更原生 task create

说明：

- 当前没有公开 `tasks create` CLI
- 所以这一步需要走更原生的 runtime path，而不是伪造 registry

### TF4：patrol/status/display 读 substrate facts

目标：

- patrol 少做 detached lifecycle 猜测
- status / task inbox 展示 native task/flow substrate 信息

状态：

- 已开始落地

### TF5：simple spawn_multi -> linear flow

目标：

- 把 simple linear multi-stage workflow 接到 OpenClaw linear flow

### TF6：ClawTeam optional backend

目标：

- 默认 detached substrate 改为 OpenClaw tasks/flows
- ClawTeam 只在需要 operator runtime / tmux swarm 时启用

## 4. 防混淆规则

只有满足 OctoClaw binding 信号的 task/flow，才允许回流到 OctoClaw 视图。

推荐信号：

- `managed_by_octoclaw = true`
- `agent_namespace = octoclaw`
- `worker_pool` 以 `octoclaw-` 开头
- `route in {runner, spawn_single, spawn_multi}`

原则：

- 绝不把 cron / ACP / unrelated CLI task 自动当成 OctoClaw task

## 5. 当前完成定义

本轮完成后，判断为“task flow 第一阶段完成”的标准是：

- `runner / spawn_single / spawn_multi` 都已 task-flow aware
- `spawn_single` 能绑定 native subagent task facts
- patrol/status/display 已能消费 substrate info
- 仍未依赖公开 create CLI

## 6. 下一拍

最直接的下一拍是：

- 继续推进 `spawn_single` 的 native-preferred create
- 然后再把 simple `spawn_multi` 接成 linear flow
