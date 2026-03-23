---
title: 八爪鱼多 Agent 降本提效落地路线图（2026-03-20）
tags:
  - octopus
  - roadmap
  - multi-agent
  - cost-optimization
  - performance
  - openclaw
created: 2026-03-20
---

# 八爪鱼多 Agent 降本提效落地路线图

## 一、目标重述

八爪鱼后续演进的核心目标，不是“做更多 agent”，而是：

1. **降本**
   - 让高价模型只出现在高价值节点
   - 把低价值任务尽量分流给更便宜模型或更轻执行面

2. **提效**
   - 降低用户感知等待时间
   - 提高并行执行效率
   - 减少无意义重派与冷启动

3. **增强可用性**
   - 更充分利用 OpenClaw 官方子 agent / session 能力
   - 在不依赖特定 IM 的前提下保持可靠

---

## 二、总体判断

最推荐的架构不是：

- 纯模型路由器
- 固定 8 个长期子 agent
- 完全依赖官方 thread-bound sessions

而是：

> **主调度常驻 + 快腿 runner 常驻 + 其他子 agent 临时 spawn + 官方 session 能力逐步接入。**

一句话理解：

- **多 agent 是主线**
- **模型路由是内部能力**
- **持久子 agent 只保留最值得持久的**

---

## 三、目标架构

```text
用户消息
  -> 主调度 Agent（稳定主模型）
    -> 直接回答（无需 spawn）
    -> 派临时 worker（fix / test / scout / writer / analyze / power）
    -> 派常驻 runner 执行轻任务

运行时状态层
  -> task-state.json
  -> sessions_list / sessions_history
  -> model-policy.json
  -> model-speed.json
  -> model-pricing.json

恢复与纠偏层
  -> patrol
  -> sessions_send / subagents send
  -> retry / escalate / re-dispatch

通知层
  -> feishu / none / 未来其他 backend
```

再补一层：

```text
路由决策层
  -> octoclaw_route
    -> direct
    -> runner
    -> spawn_single
    -> spawn_multi
```

---

## 四、模块化落地方案

## 4.0 `octoclaw_route` 路由决策层

### 目标

把“什么时候主 agent 自己做、什么时候交给 runner、什么时候交给单/多子 agent”从 prompt 判断迁到显式 runtime 决策器。

### 推荐输出

`octoclaw_route(task, metadata) ->`

- `route`
- `task_class`
- `role_hint`
- `tier_hint`
- `reason`
- `reason_codes`
- `confidence`
- `scores`
- `expected_latency_ms`
- `expected_cost_band`
- `context_growth_band`
- `execution_owner`
- `dispatch_required`
- `should_wait`
- `wait_timeout_seconds`

### 推荐 route

- `direct`
- `runner`
- `spawn_single`
- `spawn_multi`

### 推荐实现

1. **Hard gates**
2. **Weighted scoring**
3. **Outcome learning**

第一版不需要训练模型。更适合先做成：

- 规则
- 打分
- 反馈学习

更准确地说，`octoclaw_route` 不该只是“关键词分类器”，而应该是一个**调度决策器**。它要先回答：

1. 这次主 agent 自己做，还是切走？
2. 如果切走，是给常驻 `runner`，还是给临时子 agent？
3. 如果给子 agent，是一个还是多个？

这里的总原则应该固定下来：

- `direct` 是白名单，不是默认值
- 任何需要本机工具、会显著拉长主上下文、或更适合隔离执行的任务，都应先 route / dispatch

推荐的决策顺序：

1. **硬门禁**
   - 明显 `direct / runner / spawn` 的请求先直接切掉
2. **灰区打分**
   - 只对边界任务计算 `direct_score / runner_score / spawn_single_score / spawn_multi_score`
3. **保守回退**
   - `direct` 和 `spawn_single` 接近时，优先 `spawn_single`
   - `runner` 和 `direct` 接近但明显要本机状态时，优先 `runner`
4. **反馈学习**
   - 用 replay/eval 和线上执行结果调权重

推荐输入特征不要只看文本关键词，而要同时看：

- `tool_need`
- `task_shape`
- `context_growth`
- `risk`
- `latency_sensitivity`
- `parallel_gain`
- `budget_pressure`
- `runtime_health`

这样 OctoClaw 优化的就不是“单次请求选哪个模型”，而是“整条任务链该怎么走”。

### 4.0.1 runner playbook 层

为了避免“route 判成 runner，但主 agent 还得自己拼 shell 命令”，需要一层通用 playbook：

- `system_summary`
- `service_health`
- `local_file_probe`

这样像“检查 python 版本、磁盘、内存”“检查 redis/openclaw 的端口、状态、日志”这类自然语言本机任务，也可以直接下沉到常驻 runner。

### 4.0.2 借鉴 `ClawRouter` 的方式

OctoClaw 值得借 `ClawRouter` 的部分主要是：

- 本地低延迟决策
- profile 化
- tier 作为中间层
- 插件化入口

但不应该照搬成：

- 纯 proxy router
- 纯单请求模型路由

更合理的吸收方式是：

- `task -> route -> role/tier -> model`
- `route` 由本地脚本决策器负责
- `model` 再由 `model-intel.py` 和套餐经济学决定

也就是说，借的是“本地加权决策器 + profile + plugin 化”，不是“把 OctoClaw 降成模型代理”。

### 4.0.3 `octoclaw_dispatch` 返回必须 user-safe

交互式 tool 返回不能只返回机器细节。否则主 agent 很容易：

- 只看见 “executed/done”
- 没拿到可直接收口的正文
- 自己在聊天里重新推理
- 甚至把内部犹豫文本暴露给用户

后续统一成：

- `handoff.summary`
- `handoff.reply_text`
- `handoff.report_path`
- `handoff.user_safe`

规则：

- 短结果：直接放 `reply_text`
- 长结果：写共享文件，只把 `report_path` 和短摘要带回
- `handoff.user_safe=true` 时，主 agent 应优先直接收口，而不是重新发挥

当前仓库已经有最小 runtime extension 骨架：

- `extensions/octoclaw-runtime/package.json`
- `extensions/octoclaw-runtime/index.js`

这层先把 `octoclaw_route / octoclaw_dispatch / octoclaw_status` 暴露成 OpenClaw 可直接调用的工具入口，减少“只靠 AGENTS.md 提示主 agent 自由判断”的不稳定性。

## 4.0.0 飞书 3.22 能力接入

OpenClaw 3.22 在飞书侧新增的能力里，OctoClaw 最值得吸收的是：

- `structured interactive approval / quick-action launcher cards`
- `current-conversation ACP + subagent session binding`
- `callback user / conversation context preservation`

但要分清两层：

### 当前可以直接利用的

- 统一卡片头尾
  - `八爪鱼（OctoClaw）`
- 面板卡 / 任务卡里增加结构化快捷动作提示
- 保持状态面板、事件卡、文本通知的双语一致性

### 需要后续重构才能真正吃满的

- 当前会话 ACP
- 子 agent session 绑定到原飞书 DM / topic 会话
- 复杂任务完成结果自动回投到原会话
- 真正的 callback action 路由

原因是：

- OctoClaw 当前飞书发送仍主要走 `feishu-card.py` + 直接 Feishu API
- 它已经能发卡、更新卡、发 DM
- 但还没有完整接到 OpenClaw 3.22 的 shared outbound identity / ACP 回路

所以飞书 3.22 的正确接法应该是：

1. 保留当前卡片面板能力
2. 逐步把飞书发送与动作入口迁到 OpenClaw shared outbound / ACP
3. 让 `spawn_single / spawn_multi` 的结果自然回到原飞书会话

一句话：

> 飞书 3.22 对 OctoClaw 的价值，不只是“更好看地发卡”，而是让飞书从通知后端逐步升级成真正的会话绑定执行入口。

## 4.0.1 benchmark 输入收敛

自动选模后续应优先维护这三类外部信号：

- `PinchBench`
- `Artificial Analysis`
- `OpenClaw live compatibility`

这比继续依赖时效性更弱、与 OpenClaw 场景更远的来源更稳。当前建议的 benchmark 结构是：

- `PinchBench`
- `Artificial Analysis`
- `Claw-Eval`
- `OpenClaw live compatibility`

另外可以补一个低权重的 `OpenRouter rankings` 生态信号，用来帮助 provider/路由可获得性判断，但不要把它当主能力榜。

后面应该把来源职责显式固化为：

- `OpenRouter`
  - 模型目录
  - 价格
  - provider / 参数 / context
  - 榜单只做低权重生态信号
- `Artificial Analysis`
  - 通用 coding / reasoning / latency 主榜
- `PinchBench`
  - OpenClaw / agent 实战主榜
- `Claw-Eval`
  - agent workflow 辅助榜
- `本地实测`
  - `model-speed.json`
  - `openclaw_live_compat`
  - `model-plan-state.json`

不要再把多个榜单“混进去一起打”，而应该额外维护：

- `model-sources.json`

这个文件应该明确：

- 哪个字段来自哪个来源
- 每个来源的默认 `confidence`
- 每个来源的 `decay_days`
- 每个来源的 `min_factor`
- 哪些来源允许 family 推断

也就是说，后续不是只有 benchmark 分数，还要有：

- `freshness_factor`
- `confidence_factor`
- `family_penalty`

同一层里还应补齐“预算型套餐”支持：

- token 计费模型支持 `monthly_budget_cny`
- 支持 `current_month_spent_cny`
- 支持 `soft_limit_ratio` / `hard_limit_ratio`
- 在接近预算上限时自动降权或 fallback

`NadirClaw` 最值得借的部分主要是预算防护：

- 预算紧张时优先降级便宜模型
- 对 agentic / tool-heavy 任务保留更强模型
- 用策略 profile，而不是单一 hardcode

但 OctoClaw 不应该照搬成 proxy router；更合理的是把预算防护接进：

- `model-plan-state.json`
- `model-intel.py`
- `octoclaw_route`

这样预算影响的不只是“换模型”，还会影响 `direct / runner / spawn` 的结构化分流。

## 4.1 官方通用 session / subagent 能力接入

### 目标

在不切换主通道、不依赖 Discord thread binding 的前提下，先把 OpenClaw 官方已有的通用能力接进八爪鱼。

### 为什么优先做

这是当前最划算的一层增强：

- 不会推翻现有架构
- 能提升观测性
- 能减少误判
- 能减少整任务重派

### 要接的能力

1. `sessions_list`
2. `sessions_history`
3. `/subagents send` / `sessions_send`
4. 共享 skills：`~/.openclaw/skills`、`skills.load.extraDirs`

### 落地方式

#### A. `sessions_list`

作用：

- 巡逻时查看真实 session 是否存在、是否已结束、最近是否活跃

落地：

- 在 `task-state.json` 里新增：
  - `session_id`
  - `run_id`
  - `last_observed_at`
  - `session_status`
- patrol 每轮先读 `task-state.json`
- 再调 `sessions_list`
- 做 session 和 task 的交叉校验

建议判断规则：

- task 是 `running`，但 session 不存在
  - 标记 `needs_reconcile`
- task 是 `dispatched`，session 已结束
  - 进入 `failed` 或 `needs_recover`
- task 是 `running`，session 存在但长时间无活动
  - 标记 `suspected_stuck`

#### B. `sessions_history`

作用：

- 判断子 agent 最后到底做了什么

落地：

- 对疑似异常任务追加读取最近 N 条 history
- 根据 history 分类：
  - 正常完成但未写 RESULT
  - 主动报错退出
  - 长时间重复空转
  - 被工具错误卡住

输出用途：

- patrol 摘要更准确
- 后续是否 `send` 纠偏更准确
- 是否需要升级模型更准确

#### C. `/subagents send` / `sessions_send`

作用：

- 对还活着的子任务补发一条纠偏或约束，不必完整重派

适用场景：

- 输出太长
- 读文件太多
- 偏题
- 只差最后一步
- 漏了某个检查点

建议策略：

- 第一次异常：先 `send` 纠偏
- 第二次异常：同模型重试
- 第三次异常：升级模型或换角色

#### D. 共享 skills

作用：

- 多 agent 共享同一套规则，不依赖每个 workspace 各自拷贝

落地：

- 八爪鱼主体继续是 skill
- 通用角色规范放到共享 skill 目录
- 子 agent 加载时统一引用共享 skill

建议拆分：

- `octopus-core`
  - 调度规则
  - task-state 协议
  - patrol 协议
- `octopus-runner`
  - 轻任务执行规范
- `octopus-review`
  - fix/test/review 约束

### 需要改的模块

- `lib/patrol.py`
- `lib/task-state-update.py`
- `install.sh`
- `SKILL.md`
- 新增 session 适配辅助模块，例如 `lib/session_ops.py`

### 补充：权限与能力探测

这里不能假设“有 OpenClaw 就一定能随便派子 agent”。

实际会受两层限制：

#### A. 工具权限

- 主 agent 是否允许 `sessions_spawn`
- 当前 session 是否允许 `sessions_history`
- 当前 session 是否允许 `sessions_send`
- 子 agent 默认通常不带 session tools

#### B. channel / delivery 权限

- 能不能 announce
- 能不能继续往某个会话发消息
- 某些 thread / session 绑定能力是否仅特定 channel 支持

因此，八爪鱼后面应加入**能力探测与降级机制**：

- 有 `sessions_spawn` 权限 → 走官方 session 工具链
- 没有 → 自动退回 `isolated spawn + task-state + patrol`
- 有 `sessions_send` 权限 → 先 steer
- 没有 → 标记 `needs_steer`，后续再重派

这一步很重要，因为它决定了八爪鱼能不能在不同安装环境里保持稳定。

### 验收标准

- patrol 不再只靠文件状态判断任务命运
- 可以对活着的子任务做一次 `send` 纠偏
- 共享 skills 可以在多 workspace / 多 agent 下复用

---

## 4.2 调度内核增强

### 目标

把八爪鱼从“规则型 skill”升级成“任务编排器”。

### 当前问题

现在很多关键逻辑还依赖：

- AGENTS 规则
- spawn prompt
- patrol 补锅

这能工作，但不够硬。

### 要增强的核心

#### A. 状态机

建议 task 状态扩展为：

- `queued`
- `dispatched`
- `running`
- `needs_steer`
- `retrying`
- `waiting_dep`
- `failed`
- `done`
- `needs_confirm`

#### B. 任务元数据

建议统一字段：

- `id`
- `label`
- `tier`
- `model`
- `session_id`
- `deps`
- `retry_count`
- `escalation_level`
- `expected_done`
- `spawned_at`
- `last_observed_at`
- `recovery_action`
- `result_file`
- `source`

#### C. 升级规则

建议固定 3 层恢复链：

1. `steer`
   - 任务还活着，先纠偏
2. `retry`
   - 同模型重试
3. `escalate`
   - 更强模型或更合适角色

#### D. 并行和串行规则

建议明确写死：

- 默认并行
- 同文件写入必串行
- 有显式依赖必串行
- runner 可与绝大多数任务并行

### 需要改的模块

- `lib/task-state-update.py`
- `lib/patrol.py`
- `lib/spawn-template.md`

### 验收标准

- 任一任务都能说清当前状态和下一步动作
- 重试和升级不再依赖人工脑补
- queued / deps / recover 行为一致可预测

---

## 4.3 常驻 runner

### 目标

解决轻任务冷启动，把“提效”做出明显体感。

### 为什么最值

用户感知的慢，经常不是模型慢，而是：

- 一个轻任务
- 被放进完整 spawn 生命周期
- 冷启动浪费了绝大部分时间

### runner 只做什么

- `grep`
- `rg`
- `tail`
- `head`
- `curl`
- 健康检查
- 轻 shell 脚本
- 状态查询

### runner 不做什么

- 长推理
- 大量多文件改写
- 深度调研
- 长文本总结

### 落地方式

#### A. 队列协议

建议运行时文件：

- `runner-cmd.json`
- `runner-result.json`
- `runner-heartbeat.json`

命令结构建议：

```json
{
  "id": "runner-20260320-001",
  "type": "shell",
  "command": "tail -n 50 /var/log/app.log",
  "timeout_sec": 15,
  "created_at": "2026-03-20T10:00:00Z"
}
```

结果结构建议：

```json
{
  "id": "runner-20260320-001",
  "status": "done",
  "stdout": "...",
  "stderr": "",
  "exit_code": 0,
  "finished_at": "2026-03-20T10:00:03Z"
}
```

#### B. runner 保活

- patrol 每轮检查 heartbeat
- runner 死掉时自动重启
- runner 执行超时自动清理

#### C. 常驻 agent 轮换与过期

常驻 agent 不能等于永久 agent。

后面不管是 runner 还是未来可能增加的半常驻执行面，都应带明确轮换机制：

- `max_turns`
  - 例如 > 30 轮强制轮换
- `max_age`
  - 例如 > 2 小时轮换
- `max_context_tokens`
  - 例如累计输入 > 50k
- `idle_timeout`
  - 空闲超过阈值自动退出
- `error_streak`
  - 连续失败达到阈值自动换新实例

推荐方式：

- 由 patrol 监控常驻 worker
- 满足任一条件时：
  - 拉起新实例
  - 旧实例进入退出流程

也就是：

> **常驻子 agent 是“短生命周期可复用”，不是“永不重建”。**

### 4.3.1 交互式 runner 体验要求

快任务的核心目标不是“让用户看到调度过程”，而是**尽快拿到结果**。因此后续交互规范应明确：

- 命中 `runner` 的任务，优先短等待结果，不先输出长前奏
- 若 2-3 秒内能拿到结果，直接返回结果
- 若短时间内拿不到结果，再补一句极短状态说明
- 若等待超时，也必须回复后台提示，不能沉默

推荐交互节奏：

- `0-2s`：静默等待
- `2-8s`：若仍无结果，回一句“正在检查本机状态…”
- `>8s`：回“已转后台执行，可用 /octostatus 查看”

### 4.3.2 Route 归因必须基于 runtime 证据

后续不要让主 agent 自己口头判断“这是主 agent 查的”还是“子 agent 查的”。  
归因必须基于运行时事实：

- 若写入 `task-state.json` 且 `label=octopus-runner`
- 或写入 `runner-queue.json`
- 或存在 `runner-results/<job_id>.json`

则该任务应视为：

- 执行动作：`runner`
- 回复组织：`main agent`

也就是说，最终文案应更接近：

- “已通过常驻 runner 检查本机状态。”
- “这次由当前会话直接处理。”

而不要靠主 agent 自己猜“是不是我亲自查的”。

#### D. runner 选模

runner 的模型策略与其他角色完全不同：

- 优先 `TTFT`
- 其次稳定性
- 再次价格
- 不开重 thinking

### 需要改的模块

- 新增 `lib/runner-loop.sh`
- 新增 `lib/runner-dispatch.py`
- `lib/patrol.py`
- `lib/model-intel.py`

### 验收标准

- 常见轻任务无需临时 spawn
- 从用户视角看，响应明显快于现有模式
- runner 死掉能自动恢复
- runner 轮换后不会长期上下文膨胀

---

## 4.4 自动选模继续做，但收敛到子 agent 层

### 目标

让“降本”主要发生在子任务层，而不是让主 agent 每轮切模型。

### 原则

1. 主 agent 尽量稳定
2. 子 agent 角色化选模
3. 价格、速度、稳定性一起算
4. 不同角色用不同权重

### 角色级路由建议

#### 主 agent

- 尽量固定主模型
- 优先稳定性、综合能力、缓存复用
- 不建议每轮切换

#### runner

- 优先 `TTFT`
- 其次 `error_rate`
- 再看成本

#### fix / test

- 优先 coding 成功率
- 再看稳定性和成本

#### scout / writer

- 优先成本和长输出稳定性
- 其次持续输出速度

#### analyze / power

- 优先综合能力
- 其次成本

### 需要补的真实数据

建议每个模型都积累：

- `ttft_ms`
- `output_tps`
- `error_rate`
- `success_rate_by_role`
- `cache_hit_impact`（如果后续能拿到）

### 需要改的模块

- `lib/model-intel.py`
- `lib/resolve-model.py`
- `lib/model_pricing.py`
- `lib/sync-speed-metrics.py`

### 验收标准

- 能解释“为什么 runner 选 M2.7，不选 GLM4.7”
- 能解释“为什么 fix 选 GLM4.7，而主脑仍是 GPT-5.4”
- 成本判断不再只靠人工经验

---

## 4.5 去飞书强耦合

### 目标

让八爪鱼的核心价值独立于通知后端。

### 原则

- 调度和状态层不依赖 Feishu
- Feishu 只是一个 backend
- 默认应支持 `none`

### 落地方式

#### A. 通知抽象继续收敛

保留统一接口：

- `send_panel`
- `send_event`
- `send_text`

所有核心流程只调统一接口，不直连 Feishu。

#### B. 主 session 抽象

- 主 session 定位逻辑独立
- 不要只认 `feishu:dm:*`

#### C. 最小运行模式

默认支持：

- 无 Feishu
- 无私有模型
- 仅本地或通用 OpenClaw 环境

#### D. 通用状态渲染层

不要把八爪鱼状态展示绑定到 Feishu 卡片。

建议抽象统一渲染接口：

- `render_status_text_compact()`
- `render_status_table()`
- `render_status_lane_view()`
- `render_status_card_payload()`

不同后端选择不同渲染形式。

##### 1. 纯文本紧凑版

适合：

- 普通 IM 文本消息
- 不支持卡片的 channel
- 低成本状态查询

示例：

```text
🐙 Octopus
运行中 3 | 排队 1 | 待确认 1 | 异常 1

RUNNING
- 🔧 fix-login-bug      Sonnet   6m
- 🔍 jwt-research       Kimi     3m
- 🏃 check-redis        M2.5     1m
```

##### 2. ASCII 表格版

适合：

- CLI
- markdown code block
- 本地 `octopus status`

示例：

```text
+----------------------+----------+--------+--------+------------------+
| Task                 | Role     | Model  | Status | Note             |
+----------------------+----------+--------+--------+------------------+
| fix-login-bug        | fix      | Sonnet | run    | 6m               |
| auth-regression      | test     | GLM-5  | queued | wait fix-login   |
+----------------------+----------+--------+--------+------------------+
```

##### 3. 字符泳道 / lane 视图

适合：

- 展示多 agent 协作感
- 八爪鱼状态面板
- 不依赖卡片的可视化文本输出

示例：

```text
🐙 OCTOPUS

Main
  └─ planning request...

Runner lane
  ├─ check-redis          [running  ] 1m

Build lane
  ├─ fix-login-bug        [running  ] 6m
  └─ refactor-auth        [queued   ]

Recovery
  └─ redis-rootcause      [needs steer]
```

建议实现方式：

- 状态数据统一来自 `task-state.json + session observation`
- 渲染层只负责视图，不负责状态判断
- Feishu 只是其中一个渲染后端

### 需要改的模块

- `lib/notifier.py`
- `lib/octopus_config.py`
- `lib/patrol.py`
- `install.sh`
- 后续可新增 `lib/status_render.py`

### 验收标准

- 不接飞书也能完整跑核心功能
- Feishu 只是增强项，不是基础前提
- 文本 / 表格 / lane 三种状态展示都可输出

---

## 4.6 Discord thread-bound session 实验线

### 目标

验证官方持久子会话是否值得作为后续增强模式。

### 注意

这不是当前主线。

### 为什么不应立刻重构

- 你当前主战场不是 Discord
- 现有 `task-state + patrol` 已经是可靠基本盘
- 直接切会引入较大重构成本

### 正确做法

单独开实验模式，只试 1 到 2 类任务：

- 长调研
- 长修复

观察指标：

- 冷启动是否明显下降
- follow-up 是否更顺
- 缓存命中是否更高
- patrol 复杂度是否下降

### 验收标准

- 能明确回答“Discord 持久子会话值不值得”
- 而不是基于想象全面切换

---

## 五、版本路线图

## v1.3

### 目标

把八爪鱼从“只看 task-state”升级成“task-state + session 观测”。

### 必做

- 接 `sessions_list`
- 接 `sessions_history`
- `task-state.json` 扩展 session 字段
- patrol 增加 reconcile 逻辑

### 产出

- 更准确的 orphan / stuck / failed 判定
- 更少误重派

## v1.4

### 目标

把“发现异常就重派”升级成“先纠偏，再重试，再升级”。

### 必做

- 接 `/subagents send` / `sessions_send`
- 增加 `needs_steer`
- 定义 retry / escalate policy

### 产出

- 减少整任务重派
- 降低重复上下文成本

## v1.5

### 目标

解决快任务冷启动。

### 必做

- 常驻 runner
- runner 队列协议
- runner heartbeat
- runner 选模独立权重

### 产出

- 轻任务明显更快
- 用户体感提升最明显

## v1.6

### 目标

让八爪鱼更通用、更贴官方生态。

### 必做

- 共享 skills 规范化
- 通知解耦收尾
- 最小运行模式完善
- Discord thread-bound session 小范围试验

### 产出

- 更像通用开源软件
- 更容易继续演进

---

## 六、优先级排序

如果只看“最值得先做”，建议顺序如下：

1. `sessions_list` / `sessions_history`
2. `sessions_send`
3. 常驻 runner
4. 子 agent 层自动选模继续做实
5. 去飞书强耦合
6. Discord 持久子会话实验

---

## 七、外部项目最值得借鉴的 7 件事

这一节是跳出前面已有分析后，再额外吸收别的 agent 项目和生态里已经被证明有价值的思路。

### 7.1 `planner -> builder -> review`

这不是每个任务都要走的固定流水线，而是一种**高风险任务的默认处理方式**。

建议理解成：

- `planner`
  - 只负责拆任务、定方案、定依赖、定验收标准
- `builder`
  - 只负责执行和改动
- `review`
  - 只负责验证、回归、补漏

适合走三段式的任务：

- 多文件重构
- 高风险修复
- 调研 + 实现组合任务
- 需要高可靠验收的任务

不适合走三段式的任务：

- 轻 runner 任务
- 简单问答
- 单文件小改
- 明显低风险任务

建议任务分层：

1. `fast`
   - 直接答或 runner
2. `simple build`
   - `builder only`
3. `standard dev`
   - `planner -> builder`
4. `high risk`
   - `planner -> builder -> review`

### 7.2 轻量 micro-skill / 场景触发规则

不要把所有规则都常驻在主 skill 和 AGENTS 中。

建议拆成可按场景加载的小规则：

- `octopus-runner`
- `octopus-review`
- `octopus-feishu`
- `octopus-cost-guard`
- `octopus-large-refactor`

收益：

- 上下文更短
- 缓存更容易命中
- 子 agent 只加载自己需要的能力

### 7.3 上下文投影 / 最小任务包

不要让每个子 agent 都吃到完整历史。

建议每次 spawn 前生成一个最小上下文包，只包含：

- 当前目标
- 依赖结果摘要
- 必要文件指针
- 验收标准

收益：

- 降低 token 成本
- 提高 spawn 速度
- 降低模型跑偏概率

### 7.4 缓存感知选模

模型路由不要只看单价，还要看缓存友好度。

建议为不同角色增加 `cache_affinity` 概念：

- 主脑：高
- runner：中
- 临时 worker：低到中

策略上：

- 主脑尽量固定模型
- 同类连续任务尽量复用同一模型
- 差价不够大时，优先保缓存

### 7.5 高频任务模板库

不要让主脑每次都从零设计流程。

建议抽模板：

- 代码修复模板
- 调研 + 实现模板
- 实现 + 测试模板
- 日志排障模板
- 配置排查模板

模板内定义：

- 默认角色组合
- 默认依赖关系
- 默认模型策略
- 默认验收标准

### 7.6 `replay / eval`

这里的意思是：

- `replay`
  - 用固定任务集重新跑一遍
- `eval`
  - 对结果做评估

它的作用不是线上执行，而是验证版本改动到底有没有让系统：

- 更快
- 更省
- 更稳

建议维护固定任务集：

- 轻 runner 任务
- fix 任务
- analyze/scout 任务
- 并行任务

每次版本变更后对比：

- TTFT
- 总耗时
- 估算成本
- 重派次数
- 是否成功

### 7.7 分层接入官方能力

不要一步到位重构成 Discord-first。

更好的顺序是：

1. `sessions_list`
2. `sessions_history`
3. `sessions_send`
4. 共享 skills
5. 最后再试 Discord thread-bound session

这样能先拿到：

- 更准的观测
- 更好的纠偏
- 更低的重派成本

---

## 八、主体形态：skill、plugin，还是混合

### 8.1 最终结论

**最推荐的是混合形态。**

更准确地说：

- **主体是 skill**
- **运行时增强做成 plugin**

也就是：

- `octopus-skill`
  - 角色定义
  - 编排规则
  - task-state 协议
  - spawn 规范
  - 调度提示与工作流
- `octopus-runtime plugin`
  - 通知后端
  - session 观测
  - session send 封装
  - model intel / pricing / speed refresh
  - runner 后台服务
  - 配置校验

### 8.2 为什么不建议纯 skill

纯 skill 的问题是：

- 能表达规则，但不擅长承载后台能力
- 通知、测速、队列、session 观测这类运行时逻辑不好放
- 越做越容易变成安装脚本 + 大量补丁

### 8.3 为什么也不建议纯 plugin

纯 plugin 的问题是：

- 八爪鱼最核心的价值仍然是工作流和编排规则
- role / prompt / handoff / task-state 这些更像 skill 领域
- 如果完全插件化，会损失“可理解、可修改、可复用”的优势

### 8.4 混合形态的落地方式

建议分阶段：

#### 现在

- 保持主体为 skill
- 继续压缩 AGENTS 为“铁律”
- 规则和角色逻辑继续放 skill

#### 下一步

- 新增轻量 runtime plugin
- 把后台能力逐步迁过去

#### 最终

- 用户安装 skill 即获得基本功能
- 装 runtime plugin 后获得：
  - 更强通知
  - 更强 session 能力
  - 更强 runner
  - 更强自动选模

这也是最适合做成长期有用开源软件的形态。

### 8.5 规则归属清单

这一节的目标是回答一个很实际的问题：

> 八爪鱼的哪些规则应该继续放在 `AGENTS.md`，哪些放 `SKILL.md`，哪些应该逐步迁到 runtime/plugin？

#### A. 必须留在 `AGENTS.md` 的

这些是主 agent 每轮都必须看到的“宪法级铁律”：

- 先回复文字，再决定是否 spawn
- 30 秒内能高质量直答就直答，否则派子任务
- 默认并行；同文件写入必须串行
- turn 末尾统一触发 patrol
- 子任务必须写状态并输出 RESULT
- 异常优先 steer，再考虑重派

这些规则的特点是：

- 短
- 硬
- 高频
- 必须常驻

#### B. 应放在 `SKILL.md` / 共享 skills 的

这些更像“操作手册”和“工作流规则”：

- 角色定义
- spawn 模板
- task-state 字段说明
- RESULT 格式说明
- 不同模式的用法
- 任务模板库
- fix / review / runner / writer 等角色规范

这些规则的特点是：

- 需要解释
- 需要示例
- 会持续演进
- 不必每轮全部塞给主 agent

#### C. 应逐步迁到 runtime/plugin 的

这些不应该长期依赖 prompt 规则，而应该由系统直接保证：

- task-state 状态机
- queued / deps 解锁
- retry / escalate policy
- steer 优先逻辑
- session 观测
- session 能力探测与降级
- 常驻 runner 保活与轮换
- 自动选模候选池和打分
- 通知 backend 抽象
- 状态渲染

这些规则的特点是：

- 必须真实生效
- 不应依赖模型“记得做”
- 更适合写成代码和后台行为

#### D. 判断原则

如果一条规则属于下面任一类，就应优先迁到 runtime/plugin：

- 忘了做会直接出错
- 需要一致执行
- 需要跨 turn 保持
- 需要和 session / tool / backend 权限联动
- 需要强制约束，而不是建议

如果一条规则主要是：

- 解释工作方式
- 帮助主 agent 理解团队协作
- 定义角色边界
- 提供输出格式规范

那它更适合留在 `AGENTS.md` / `SKILL.md`。

#### E. 八爪鱼后面的迁移方向

建议按这个方向持续收敛：

1. `AGENTS.md`
   - 只保留铁律
2. `SKILL.md`
   - 保留完整工作流和角色语义
3. runtime/plugin
   - 接管真正必须生效的调度与恢复规则

最终理想状态是：

> **主 agent 靠 `AGENTS.md` 和 skill 理解“应该怎么做”，系统靠 runtime/plugin 保证“关键行为真的会发生”。**

---

## 九、最关键的 3 个成功指标

后续每一版都建议围绕这 3 个指标看效果：

1. **成本**
   - 每类任务平均成本是否下降

2. **用户体感速度**
   - 首次回复是否更快
   - 快任务完成是否更快

3. **恢复质量**
   - 卡住任务是否更少
   - 重派次数是否下降

---

## 十、系统化路线建议

如果把前面所有内容收束成更系统的做法，我会建议后面按下面这条总路线走：

### 阶段 1：把八爪鱼做成更可靠的调度层

先把：

- `sessions_list`
- `sessions_history`
- 更强状态机
- `sessions_send`

接进来。

目标是：

- 更会观察
- 更会纠偏
- 更少盲目重派

### 阶段 2：把八爪鱼做成真正能提速的系统

重点做：

- 常驻 runner
- 最小任务包
- 高频任务模板

目标是：

- 快任务明显提速
- spawn 成本下降
- 主脑决策更轻

### 阶段 3：把八爪鱼做成更聪明的成本控制层

重点做：

- 子 agent 角色化选模
- 缓存感知路由
- replay/eval 验证

目标是：

- 不是“感觉更省”
- 而是“数据证明更省”

### 阶段 4：把八爪鱼做成可长期演进的混合产品

重点做：

- skill 保持主体
- plugin 承担运行时
- 共享 skills 规范化
- Discord thread-bound session 仅作增强试验线

目标是：

- 架构清晰
- 可维护
- 既贴官方生态，又不被单一通道绑死

---

## 十一、最终结论

八爪鱼后面的主线应该非常明确：

> **把它做成一个能充分利用 OpenClaw 官方能力的成本敏感多 agent 调度层，并采用 skill 为主体、plugin 为增强的混合形态。**

它的关键不是“agent 更多”，而是：

- 更会分工
- 更会选模型
- 更会复用 session 能力
- 更会处理异常
- 更会把快任务从冷启动里解放出来

如果只保留一句路线建议：

> **先补 session 能力，再做 runner，再把自动选模压到子 agent 层，最后把运行时能力逐步插件化。**

---

## 十二、围绕模型分流的后续优化

从当前实现和外部方案对比来看，八爪鱼后面的模型分流更适合继续走“编排感知”路线，而不是做成纯代理层 router。

### 当前做法的优点

当前八爪鱼已经具备 3 个正确方向：

- **角色感知**
  - `runner / fix / test / scout / writer / analyze / power / main` 分别打分
- **本地指标感知**
  - 已经在纳入 `price / ttft / tps / reliability`
- **启发式升级**
  - 对明显复杂任务允许从低 tier 升级

这三点组合在一起，比单纯关键字路由更稳定，也比“所有请求都先过一个小模型 judge”更可控。

### 后面最值得补的两层

#### 1. Hard gates

建议尽快把下面这些变成硬过滤条件：

- 是否属于 runner 快任务
- 是否必须私有模型
- 是否处于预算保护状态
- 是否属于高风险任务
- 是否要求长上下文

也就是先过滤候选池，再做打分，而不是所有模型直接一起比。

#### 2. Outcome learning

建议后面正式记录：

- 每个角色的成功率
- 平均重派次数
- 平均总耗时
- 平均成本

让 `model-intel.py` 不只看静态基线和速度，还看八爪鱼自己的真实历史表现。

#### 3. Model Availability & Health Probing

这层我建议后面单独做成一个 feature：

> **模型可用性与健康探测**

它不是纯代理层的 health check，而是面向调度器的模型健康层。

它要回答的不是“这个模型 API 能不能通”，而是：

- 这个模型现在是否可用
- 是否适合当 `runner`
- 是否适合当 `fix / test`
- 是否适合当 `main / analyze`
- 是否应该临时降权、熔断或移出候选池

建议记录的字段：

- `available`
- `last_ok_at`
- `last_error_at`
- `error_rate_5m`
- `ttft_ms_p50`
- `output_tps_p50`
- `role_fit`
- `degraded`
- `disabled_reason`

建议接入点：

- `model-speed.json`
- `model-catalog.json`
- `model-policy.json`
- `patrol`
- `runner`

建议策略：

- 不可用：直接排除
- 明显变慢：降权
- 某个角色错误率高：只对该角色降权
- 连续恢复失败：短时熔断

这会让八爪鱼更像“调度器自己的模型健康层”，而不是单纯模仿 OmniRoute 一类代理。

### 同家族分层降本

OctoClaw 后面应该支持“同一家族 API 内先降本、再跨家族 fallback”：

- `family`
  - `gpt-5.4`
  - `glm`
  - `minimax`
- `size_class`
  - `nano`
  - `mini`
  - `base`
  - `strong`
- `preferred_use`
  - `nano / mini` 更适合 direct、轻问答、低风险写作
  - `base` 更适合 runner、fix/test、普通调研
  - `strong` 更适合 main、analyze、power
- `upgrade_path`
  - 同家族内升级链，例如 `nano -> mini -> full`
- `fallback_path`
  - 同家族内降级链，例如 `full -> mini -> nano`

这层价值不是“多几个模型名”，而是：

- 同 API 兼容性更好
- prompt / tool 行为更接近
- 比跨厂商乱跳更稳
- 更利于缓存命中和上下文手感一致性

实现上，前提仍然是这些模型已经在 OpenClaw 的可用模型列表里；OctoClaw 再基于 family 图谱做选模和 fallback。

### 是否要上本地小模型 judge

我的建议是：

- **短期不必**
- **中期可以做成可选增强**

如果后面真的要加，本地小模型只负责：

- 任务家族分类
- 风险判断
- runner 候选识别

不要直接让它决定最终模型。

---

## 十三、围绕子 Agent 形态的后续优化

### 目标结构

后面最推荐继续收敛成：

- **长期**
  - 主调度
  - runner
- **临时**
  - `fix / test / scout / writer / analyze / power`

这条路的优点是：

- 省钱
- 易恢复
- 上下文更干净
- 更适合当前 OpenClaw 会话边界

### 对长期 worker 的工程要求

长期 worker 一定要带轮换机制：

- `max_age`
- `max_jobs`
- `idle_timeout`
- `error_streak`

否则长期 worker 很容易从“提速”变成“污染上下文 + 越跑越慢”。

### 哪些功能最适合继续常驻化

后面如果要继续增加“长期执行面”，优先级建议是：

1. `runner`
2. 持久 coding harness / ACP worker（如果以后需要）

不要过早做一整组常驻子 agent 团队。

---

## 十四、为什么当前方向没有跑偏

当前方向最正确的一点，是你没有把八爪鱼做成：

- 纯 provider router
- 纯 persona 模板库

而是在做：

> **一个会分工、会选模、会恢复、会把快任务从冷启动中解放出来的调度层。**

后面最该继续强化的就是这 4 件事：

1. `hard gates + scoring + learning` 的模型分流 pipeline
2. `runner` 成为默认快任务执行面
3. `session-aware + steer before redispatch`
4. 长期 worker 的轮换和保活
