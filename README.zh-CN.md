# 🐙 OctoClaw / 八爪鱼 v1.5.0

[English](./README.md) | 简体中文

![OctoClaw 横幅](./banner.png)

> 面向 OpenClaw 的成本敏感多 Agent 调度层。

OctoClaw 重点解决三件事：

- 通过角色化选模降低成本
- 通过常驻 runner 和异步 worker 提升速度
- 通过 patrol、session 感知和自愈机制提升稳定性

---

## 当前文档真相源

- [docs/octoclaw-design-foundation.md](./docs/octoclaw-design-foundation.md)：新的主设计底稿
- [docs/octoclaw-execution-plan.md](./docs/octoclaw-execution-plan.md)：新的执行计划
- [docs/archive/design-notes/README.md](./docs/archive/design-notes/README.md)：历史设计归档索引与分级说明

这三份文档替代根目录里分散的旧设计笔记，作为后续开发时优先查看的入口。

## 为什么是 OctoClaw

OctoClaw 不是单纯的模型路由器，也不是单纯的 agent 模板。

它处在主 Agent 和子 Agent 之间，负责：

- 任务拆解与角色分配
- 角色感知的模型分流
- 轻量 shell / API / 状态任务的 runner 快路径
- 基于 patrol 的恢复与重派
- 面向纯文本环境的状态渲染

## 自动选模

OctoClaw 现在默认采用 `auto` 的 `policy-first` 选模方式：

- 主输入维度是 `worker_pool / phase / profile / route`
- `model-policy.json` 可用时就是运行时真相源
- `octoclaw-mode.json` 只保留 `auto` 和 `custom`
- 不再把 `balanced / quality / cost / private` 视为新的默认运行模式

## 关键能力

- 路由决策入口：[octoclaw_route.py](./lib/octoclaw_route.py)
- 统一派发入口：[dispatch_task.py](./lib/dispatch_task.py)
- 通用 runner playbook：[runner_playbooks.py](./lib/runner_playbooks.py)
- Runtime extension 工具：
  - `octoclaw_route`
  - `octoclaw_dispatch`
  - `octoclaw_status`
- 常驻飞鱼腿：
  - [runner-daemon.sh](./lib/runner-daemon.sh)
  - [runner_dispatch.py](./lib/runner_dispatch.py)
  - [runner_queue.py](./lib/runner_queue.py)
- 巡逻与恢复：[patrol.py](./lib/patrol.py)
- 状态查看：[status.sh](./lib/status.sh)
- 最小 replay/eval：[eval_suite.py](./lib/eval_suite.py)

## 快速开始

```bash
bash /workspace/openclaw/skills/octopus/install.sh
```

推荐的最小可用路径：

1. 安装 skill
2. 通知后端使用 `auto` 或 `none`
3. 让 `runner-daemon` 常驻
4. 启用 `extensions/octoclaw-runtime` 里的 runtime extension
5. 把 `direct` 当成白名单：模糊任务先用 `octoclaw_route`，再按需 `octoclaw_dispatch`
6. 用 `status.sh --format table` 看状态
7. 用 `eval_suite.py` 跑一次最小基线

## 常用命令

```bash
# Runtime extension 安装目标
ls ~/.openclaw/extensions/octoclaw-runtime

# 在 OpenClaw 里优先使用工具：
# octoclaw_route
# octoclaw_dispatch
# octoclaw_status

# 先做路由决策
python3 /workspace/openclaw/skills/octopus/lib/octoclaw_route.py --task '帮我分析这个报错并给修复建议'

# 统一派发入口
python3 /workspace/openclaw/skills/octopus/lib/dispatch_task.py --task '查一下 redis 日志和端口状态' --command 'ss -lntp | grep 6379'

# 自然语言本机检查也可以直接派发
python3 /workspace/openclaw/skills/octopus/lib/dispatch_task.py --task '检查当前机器 python 版本、磁盘使用率和内存情况，最后给我三行总结'

# 轻任务直接派发给 runner
python3 /workspace/openclaw/skills/octopus/lib/runner_dispatch.py --command 'pwd' --summary '检查当前目录'

# 状态面板
bash /workspace/openclaw/skills/octopus/lib/status.sh --format table

# 最小 replay / eval
python3 /workspace/openclaw/skills/octopus/lib/eval_suite.py

# 强制巡逻
python3 /workspace/openclaw/skills/octopus/lib/patrol.py --force

# 立即同步 OmniRoute/Codex 套餐状态
cd /workspace/openclaw/skills/octopus
WORKSPACE=/workspace PYTHONPATH=/workspace/openclaw/skills/octopus/lib python3 ./lib/sync-omniroute-plan.py sync
```

## 自动选模输入层

现在 `auto` 模式会同时考虑 4 层输入：

- 本地测速：`/workspace/tmp/octopus/model-speed.json`
- 第三方 benchmark 快照：`/workspace/tmp/octopus/model-benchmarks.json`
- 套餐状态：`/workspace/tmp/octopus/model-plan-state.json`
- 价格模型：`/workspace/tmp/octopus/model-pricing.json`

当前更推荐的 benchmark 来源是：

- `PinchBench`：更贴 OpenClaw agent 场景
- `Artificial Analysis`：更适合 coding / reasoning 能力对比
- `Claw-Eval`：更适合补真实 agent workflow 表现
- `OpenClaw live compatibility`：更适合作为你自己的本地验证层
- `OpenRouter rankings`：更适合作低权重生态/可用性信号

推荐的使用方式是：

- `PinchBench`、`Artificial Analysis`、`Claw-Eval` 作为主 benchmark 输入
- `OpenClaw live compatibility` 作为本地反馈层
- `OpenRouter rankings` 只做低权重辅助，不作为核心能力榜

能自动推断或自动同步的：

- `openclaw models list --json` 里的可用模型
- 本地 TTFT / TPS / error-rate（前提是本地 latency 文件存在）
- 已知模型模式对应的计费类型，例如：
  - `subscription_request_plan`
  - `subscription_prompt_plan`
  - `subscription_seat_plan`
  - `token_pack`
- 已知模型模式对应的计费周期，例如：
  - `monthly`
  - `yearly`
  - `one_time`

通常仍需要你维护或后续接 provider API 的：

- 包月 / 包年的续费时间
- 当前剩余额度比例
- 是否希望“临近到期优先消耗”
- 额度过低时 fallback 到哪个模型
- token 计费模型的月预算
- 当前月已花费金额（如果你希望按预算自动降权）

也就是说：

- **套餐类型** 可以一次建模后长期复用
- **包月/包年周期** 通常也可以一次建模后长期复用
- **实时剩余额度** 通常不能稳定自动获取，后面更适合接 provider API；在那之前先维护 `model-plan-state.json`
- **token 计费模型** 也可以通过 `monthly_budget_cny`、`current_month_spent_cny`、`soft_limit_ratio`、`hard_limit_ratio` 做预算型 fallback
- 如果 `FEATURE_OMNIROUTE_PLAN_SYNC=true` 且本机有 `omniroute`，OctoClaw 还可以定时从 OmniRoute SQLite 同步 Codex/GPT-5.4 的估算剩余额度，再刷新自动选模策略

## 开源发布材料

- [CHANGELOG.md](./CHANGELOG.md)
- [RELEASE_NOTES_v0.1.0.md](./RELEASE_NOTES_v0.1.0.md)
- [LICENSE](./LICENSE)

## 历史设计归档

- [归档索引](./docs/archive/design-notes/README.md)
- 所有旧设计文档现已迁移到 [`docs/archive/design-notes/`](./docs/archive/design-notes/)
