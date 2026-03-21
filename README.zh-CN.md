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

| 任务等级 | 典型任务 | 平衡模式用模型 | 费用 |
|---------|---------|--------------|------|
| trivial | 改配置、加文字 | GLM | 低 |
| simple | 写脚本、改单文件 | GLM | 低 |
| normal | 写代码、调 API | GLM | 低 |
| hard | 复杂逻辑、多文件 | Sonnet | 中 |
| deep | 复杂架构、深度分析 | Sonnet | 中 |

### 调度模式

| 模式 | 适用场景 | trivial~normal | hard~deep |
|------|---------|---------------|-----------|
| `balanced` | 日常使用 | GLM | Sonnet |
| `quality` | 重要任务 | Sonnet | Opus |
| `cost` | 批量任务 | GLM | Sonnet |
| `private` | 敏感数据 | GLM | GLM |
| `auto` | 自动分配 | 按本地模型、速度与能力动态选择 | 按本地模型、速度与能力动态选择 |

## 关键能力

- 统一派发入口：[dispatch_task.py](./lib/dispatch_task.py)
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
4. 用 `status.sh --format table` 看状态
5. 用 `eval_suite.py` 跑一次最小基线

## 常用命令

```bash
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
