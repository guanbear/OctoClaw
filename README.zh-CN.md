# 🐙 OctoClaw / 八爪鱼 v1.5.0

[English](./README.md) | 简体中文

![八爪鱼 Octopus](./banner.png)

> 面向 OpenClaw 的成本敏感多 Agent 调度层。

OctoClaw 重点解决三件事：

- 通过角色化选模降低成本
- 通过常驻 runner 和异步 worker 提升速度
- 通过 patrol、session 感知和自愈机制提升稳定性

---

## 为什么是 OctoClaw

OctoClaw 不是单纯的模型路由器，也不是单纯的 agent 模板。

它处在主 Agent 和子 Agent 之间，负责：

- 任务拆解与角色分配
- 角色感知的模型分流
- 轻量 shell / API / 状态任务的 runner 快路径
- 基于 patrol 的恢复与重派
- 面向纯文本环境的状态渲染

## 成本优化

| 任务等级 | 典型任务 | 推荐能力档位 | 费用 |
|---------|---------|--------------|------|
| trivial | 改配置、加文字 | 低成本快模型 | 低 |
| simple | 写脚本、改单文件 | 低成本通用模型 | 低 |
| normal | 写代码、调 API | 中档执行模型 | 低到中 |
| hard | 复杂逻辑、多文件 | 强推理/强编码模型 | 中 |
| deep | 复杂架构、深度分析 | 顶级推理/审阅模型 | 中到高 |

### 调度模式

| 模式 | 适用场景 | 低阶任务 | 高阶任务 |
|------|---------|---------------|-----------|
| `balanced` | 日常使用 | 低成本通用模型 | 更强的推理/编码模型 |
| `quality` | 重要任务 | 强模型优先 | 顶级模型按需升级 |
| `cost` | 批量任务 | 尽量便宜 | 必要时才升级 |
| `private` | 敏感数据 | 私有/自部署模型 | 私有/自部署模型 |
| `auto` | 自动分配 | 按本地模型、速度与能力动态选择 | 按本地模型、速度与能力动态选择 |

## 关键能力

- 路由决策入口：[octoclaw_route.py](./lib/octoclaw_route.py)
- 统一派发入口：[dispatch_task.py](./lib/dispatch_task.py)
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
5. 模糊任务先用 `octoclaw_route`，再按需 `octoclaw_dispatch`
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

# 轻任务直接派发给 runner
python3 /workspace/openclaw/skills/octopus/lib/runner_dispatch.py --command 'pwd' --summary '检查当前目录'

# 状态面板
bash /workspace/openclaw/skills/octopus/lib/status.sh --format table

# 最小 replay / eval
python3 /workspace/openclaw/skills/octopus/lib/eval_suite.py

# 强制巡逻
python3 /workspace/openclaw/skills/octopus/lib/patrol.py --force
```

## 开源发布材料

- [CHANGELOG.md](./CHANGELOG.md)
- [RELEASE_NOTES_v0.1.0.md](./RELEASE_NOTES_v0.1.0.md)
- [LICENSE](./LICENSE)

## 相关文档

- [SKILL.md](./SKILL.md)
- [octopus-direction-analysis-2026-03-19.md](./octopus-direction-analysis-2026-03-19.md)
- [octopus-roadmap-multi-agent-cost-speed-2026-03-20.md](./octopus-roadmap-multi-agent-cost-speed-2026-03-20.md)
