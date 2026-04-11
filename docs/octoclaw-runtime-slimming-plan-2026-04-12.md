# OctoClaw Runtime Slimming Plan（2026-04-12）

> 用途：把当前短期最高优先级的三项 runtime 收口工作写成可直接实施的计划。  
> 当前假设：只有一台 `macmini` 部署，不再为旧部署路径保留正式兼容层。  
> 关联文档：
> - [octoclaw-design-refresh-2026-04-12.md](./octoclaw-design-refresh-2026-04-12.md)
> - [octoclaw-design-foundation.md](./octoclaw-design-foundation.md)
> - [octoclaw-execution-plan.md](./octoclaw-execution-plan.md)
> - [octoclaw-router-policy-refactor-plan-2026-04-10.md](./octoclaw-router-policy-refactor-plan-2026-04-10.md)
> - [octoclaw-code-audit-2026-04-12.md](./octoclaw-code-audit-2026-04-12.md)

---

## 1. 目标

这轮不再继续扩 router 小功能，而是优先收掉默认运行面的复杂度。

本计划只做三件事：

1. `patrol` 角色收缩与依赖剥离
2. `install.sh` / `octoclawctl.sh` 默认路径收瘦
3. 删除 legacy loop / daemon / cron / systemd 路径，只保留单一推荐路径

目标不是“再做一轮抽象整理”，而是让系统默认运行方式更简单、更真、更容易维护。

---

## 2. 这三件事分别是什么意思

### 2.1 `patrol` 角色收缩与依赖剥离

意思不是继续给 patrol 加功能，也不是立刻重写整个 patrol。

意思是把 patrol 从：

- 默认运行面
- completion 真相源
- ACK/provenance/status 主链

收缩成：

- `observe-once`
- `reconcile-once`
- `repair-once`

也就是说，patrol 只保留按需对账和修复职责，不再承担默认生命周期引擎角色。

### 2.2 `install / octoclawctl 默认路径收瘦`

意思是让默认安装、默认启停、默认运维只围绕推荐主链：

- OpenClaw gateway
- Node runtime extension
- native task / runner pool
- one-shot observe/reconcile/repair

默认不再帮用户安装或启动：

- `patrol-loop`
- `runner-daemon`
- cron patrol
- systemd patrol/runner
- 老的 tmux 常驻托管链路

### 2.3 删除 legacy 路径，只保留单一推荐路径

这一步不再做“兼容路径保留但不推荐”。

当前目标是只保留一个正式支持的运行方式：

- gateway 常驻
- Node runtime hot path
- native task-bound runner/spawn
- optional runner pool
- `observe-once / reconcile-once / repair-once`

以下旧路径不再保留为正式运行面：

- `lib/patrol-loop.sh`
- `lib/runner-daemon.sh`
- `lib/runner_loop.sh`
- cron patrol / cron probe
- systemd patrol/runner service
- 以旧 loop 为核心的 tmux 托管链路

这一步的目的，是彻底消除双重心智，不再让维护者猜“到底应该走哪条路”。

---

## 3. 关于 patrol，这轮的明确决策

### 3.1 这轮不做的事

不做：

- 立刻把 patrol 全量删光
- 把 5000+ 行 Python patrol 原样翻译成一份 5000+ 行 Node
- 为了“拆文件”而先做一次大规模结构迁移

### 3.2 这轮要做的事

要做：

1. 让系统默认运行面不依赖 patrol 常驻
2. 让 patrol 只保留一次性工具职责
3. 让 install/ctl/documentation 完全不再把 patrol 当推荐主链
4. 让剩余 patrol 代码只服务于：
   - reconcile
   - repair
   - bounded notify coordination

### 3.3 后续是否可以彻底不要 patrol

可以，但前提是默认主链稳定后再判断。

如果后续发现：

- `observe-once`
- `reconcile-once`
- `repair-once`

这些残余职责都能被更小的 Node/runtime 工具替代，那么 patrol 可以继续缩到接近删除。

如果仍保留少量必要职责，再决定是否把那部分小范围 Node 化。

结论是：

> 当前最优策略不是“重写 patrol”，而是“先把 patrol 退出默认主链，再决定剩余 10%-20% 是否值得 Node 化”。  

---

## 4. 实施范围

### 4.1 主要涉及文件

- [lib/patrol/__init__.py](../lib/patrol/__init__.py)
- [bin/octoclawctl.sh](../bin/octoclawctl.sh)
- [install.sh](../install.sh)
- [lib/patrol-loop.sh](../lib/patrol-loop.sh)
- [lib/runner-daemon.sh](../lib/runner-daemon.sh)
- [lib/runner_loop.sh](../lib/runner_loop.sh)
- [lib/systemd/octoclaw-patrol.service](../lib/systemd/octoclaw-patrol.service)
- [lib/systemd/octoclaw-runner.service](../lib/systemd/octoclaw-runner.service)
- 相关 docs / tests / acceptance 文档

### 4.2 非范围

本轮不做：

- cheap/local judge shadow/live rollout
- Decision cache
- spawn_multi 深化
- advisor / consultant mode
- 全仓库 Python -> Node 迁移

---

## 5. 实施分三阶段

## Phase A：让 patrol 退出默认主链

### 目标

默认系统行为不再依赖 patrol 常驻。

### 任务

1. 明确 patrol 唯一支持的主入口：
   - `observe-once`
   - `reconcile-once`
   - `repair-once`
2. 把 patrol 相关“自动重启 / 自动补救 / 常驻 loop”从默认行为中移走
3. 清理默认文案、日志、帮助信息，避免继续暗示 patrol 是主引擎
4. 把 patrol 内部剩余逻辑按职责打标签：
   - observe
   - reconcile
   - repair
   - removable legacy leftovers

### 验收

1. 停掉 patrol loop 后：
   - ACK 仍正常
   - runner result 仍正常
   - completion relay 仍正常
   - follow-up grounding 仍正常
2. 默认文档和命令帮助不再要求开 patrol loop
3. patrol 只作为按需工具出现，不再作为推荐常驻路径

---

## Phase B：收瘦 install / octoclawctl 默认路径

### 目标

安装和运维默认只暴露推荐主链。

### 任务

1. `install.sh`
   - 删除 cron patrol / cron probe 的默认安装逻辑
   - 删除 systemd patrol/runner 的默认安装逻辑
   - 删除 runner-daemon / patrol-loop 的默认启动逻辑
   - 对旧入口直接提示已废弃或删除
2. `octoclawctl.sh`
   - 默认帮助和主要命令聚焦：
     - `status`
     - `observe-once`
     - `reconcile-once`
     - `repair-once`
     - `runner-pool-status`
   - 删除 patrol/daemon 作为常驻控制目标的默认入口
3. legacy 启动分支处理：
   - 能删则删
   - 暂时不能删则统一报废弃错误并指向唯一推荐路径

### 验收

1. 新安装不再默认创建 patrol/runner 常驻链路
2. `octoclawctl` 默认帮助只展示推荐主链
3. operator 不看旧文档也能理解当前推荐主链

---

## Phase C：删除 legacy 路径并收成单一路径

### 目标

让代码、命令、安装、文档、验收全都只围绕单一推荐路径。

### 任务

1. 文档统一
   - 只保留推荐路径说明
   - 删除“兼容怎么跑”的主文档叙事
2. 命令统一
   - 默认帮助只展示推荐命令
   - legacy 命令移除或改为明确报废弃
3. 安装统一
   - 默认只铺推荐路径
   - 删除 legacy 安装分支
4. 验收统一
   - production acceptance 只针对推荐路径
   - CI / acceptance 不再给 legacy 路径留同级门槛

### 验收

1. 文档里能清楚回答“现在推荐怎么跑”
2. 安装和命令帮助不会再暗示第二条正式路径
3. CI / acceptance 只围绕单一路径设门槛

---

## 6. 建议的具体落地顺序

1. 先改文档和命令帮助，把唯一推荐路径说清
2. 再改 `install.sh` 默认行为
3. 再改 `octoclawctl.sh` 默认帮助和 target 暴露
4. 最后删 legacy loop/daemon/cron/systemd 路径，并收 patrol 内部剩余职责

这样做的好处是：

- 不会先动最难的大文件
- 能先把维护者认知纠正过来
- 改造过程里即使还没删掉旧代码，系统默认行为也已经变小

---

## 7. 验收标准

这三项完成后，至少要满足：

1. 默认安装后，不会自动铺 patrol/runner legacy loop
2. 默认运维入口只围绕推荐主链
3. patrol 不再是默认运行依赖
4. legacy loop / daemon / cron / systemd 路径不再是正式支持路径
5. 维护者能用一句话说清：
   - 推荐怎么跑
   - patrol 现在负责什么

---

## 8. 给实现者的约束

1. 不要一上来重写 patrol 全文件
2. 不要引入新的并行 runtime
3. 优先做默认行为和默认文案的收口
4. 对 legacy 路径，能删就删；不能立刻删就先改成明确废弃
5. 不为“保留兼容”继续扩散复杂度

---

## 9. 一句话实现指令

> **目标不是“把 patrol 变得更强”，而是“让系统默认不需要 patrol，并把系统收成唯一推荐路径”。**
