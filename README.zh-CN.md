# OctoClaw

[English](./README.md) | 简体中文

[![CI](https://github.com/guanbear/OctoClaw/actions/workflows/test.yml/badge.svg)](https://github.com/guanbear/OctoClaw/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/@octoclaw/cli?label=%40octoclaw%2Fcli)](https://www.npmjs.com/package/@octoclaw/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

![OctoClaw 横幅](./banner.png)

> 你的 OpenClaw 主 agent 不该什么都自己干。
> 把重活、慢活、不确定的活自动丢给便宜的子 agent，在后台跑。

---

## 它解决什么问题

**主 agent 被一个大任务卡住。**
你让它写个脚本、做次研究、跑一轮测试 —— 然后它卡几分钟甚至十几分钟没动静，你又不敢中断，不知道它还在跑还是已经死了。

**每次都用最强最贵的模型。**
一个简单的 "帮我看下 xxx" 也在烧 frontier 模型的钱。小活大炮，账单月底爆炸。

**主 agent 的上下文被塞满。**
子任务的原始输出、中间思考、工具调用日志全堆进主对话，后面几十轮都带着这堆垃圾在跑。

**任务说"完成"了，结果没东西可看。**
你只知道它"跑完了"，但到底成了没成、产出在哪、失败了没失败，谁都说不清。

OctoClaw 就是解决这四件事的。

---

## 核心能力

- 🧠 **自动派子 agent** — `reply | delegate` 每轮决定主 agent 直接答，还是派一个子 agent 到后台跑
- 🪶 **轻量 judge 决策** — 用本地 Ollama 或便宜的远端小模型做路由判断，主模型不用花钱判断该不该派
- 💰 **按成本选模型** — shadow 模式先对比"如果用更便宜的模型会怎样"，数据够了再切，不降质不切
- 📚 **自动获取模型价格和能力** — 从 OpenRouter、models.dev、OpenClaw provider catalog 合并，多源冲突会显式标记；参考 PinchBench / Aider / SWE-bench / BFCL 做 cold-start 先验，但**本地真实 replay 数据永远压榜单**
- 🧹 **主 agent 不被子任务污染** — 子 agent 有自己的上下文，回来的只是精炼结果，主线对话永远干净
- 📊 **状态可信** — 生命周期信 OpenClaw 原生 TaskFlow，元数据落在 SQLite，`running_slow` / `stalled` / `timed_out` / `degraded_completed_without_result` 都有清晰含义
- 🔁 **任务可恢复** — 委派票据、retry attempt、amendment 协议（`steer_child` / `queue_after` / `cancel_and_respawn`）
- 💬 **IM 开箱即用** — Slack（流式 + 线程）、飞书（线程）、微信（纯文本），按能力明确降级
- 🔧 **一个 CLI 搞定运维** — `octoclawctl` 管安装、部署、状态、nightly 复盘、calibration gate

---

## 为什么是这样设计的

### 1. 基于 OpenClaw 原生 TaskFlow，不造轮子

生命周期事实（running / completed / failed / timeout）来自 OpenClaw 本身。OctoClaw 不维护自己的"第二套任务状态机"。老版本踩过这个坑：自己做 state engine 会跟 substrate 不一致，重启后状态对不上，用户看到 "completed" 但实际没产出。

现在分三层，各司其职：

| 层 | 谁是权威 | 作用 |
|---|---|---|
| OpenClaw 原生 TaskFlow | **执行生命周期** | 进程是不是还活着、run 有没有被接受、native announce 有没有送达 |
| SQLite runtime ledger | **元数据和审计** | WorkContract、route seal、spawn intent、事件流水 |
| `task-state.json` | **可重建的状态缓存** | 删掉也能从上面两层重建 |

没有常驻 daemon，没有 resident runner。

### 2. 先把"子 agent"做稳，不追"多 agent"热点

多 agent 听着性感，但只有在**并发能拿收益 / 能隔离上下文 / 能提升交付质量**三件事同时成立时才值得。否则就是成本放大 + 协调复杂度 + 状态混乱。

OctoClaw 当前坚持 `solo_worker` 模式：主 agent 是协调者，派一个子 agent 去干一件清晰的事。等 nightly 数据证明多 agent 确实比单 agent 便宜/更快/更准，再考虑开 `advisor_assisted` / `threaded_subagents`。不为了看起来像多 agent 就做多 agent。

### 3. Judge 用小模型判路由，不让主模型判

主模型自己判"该 reply 还是该 delegate"有三个问题：

- **慢**：主模型首轮推理通常 2-5 秒起跳。
- **贵**：一句 "帮我查下 xx" 也在烧 frontier 模型的 input token。
- **污染**：主模型花一轮思考"我要不要派"，这段思考会留在上下文里，后面每轮都带着。

OctoClaw 的 judge 是独立一层：

- **可以跑本地模型** — Ollama + **Qwen3 0.6B** 就能当 judge，延迟毫秒级，成本是 0
- **可以跑便宜远端** — Groq / 便宜的 OpenAI-compatible endpoint 都行
- **输出只有四个字段** — `route` / `confidence` / `complexity` / `complexityConfidence`，小模型完全够用
- **可以 shadow 模式** — 开着不接 live，先对照主模型判断的差异，观察一段时间再切

这一层让你的主模型只做它真正该做的事：干活和回答。

### 4. 主 agent 上下文永远保持干净

子 agent 执行完不会把原始 transcript、工具调用日志、内部思考塞回主对话。只回一个 compact packet：

```json
{
  "status": "success",
  "summary": "已修复 foo.ts 里的类型错误",
  "artifacts": ["src/foo.ts"],
  "keyFindings": [...]
}
```

主 agent 的上下文保持紧凑，后面几十轮对话仍然快、仍然便宜。

### 5. ACK 三段分离，不跟流式打架

- **ACK0（立即反馈）** — Slack 上 300ms 贴个 reaction emoji，或 2.5s 内发一条短文本
- **进度 tier（只在不支持流式的渠道）** — 12s / 30s / 90s 的节奏性"还在跑"
- **Final（最终交付）** — 由 OpenClaw native announce 送达，OctoClaw 不重新造一套投递

在 Slack 这种原生流式的渠道，progress tier 会自动跳过，因为用户已经看到字在往外流。

---

## 快速开始

```bash
pnpm install
pnpm build

# 装到已有的 OpenClaw 环境
node tools/octoclawctl/dist/cli.js install
node tools/octoclawctl/dist/cli.js deploy
node tools/octoclawctl/dist/cli.js enable
node tools/octoclawctl/dist/cli.js status
```

`octoclawctl` 进 PATH 后常用命令：

```bash
octoclawctl status                       # 当前状态
octoclawctl details --task-id <id>       # 单任务详情
octoclawctl queue                        # 跑着的 / 排队的
octoclawctl timeline --task-id <id>      # 执行时间线
octoclawctl patrol                       # 健康检查
octoclawctl repair                       # 有界恢复

# 成本路由
octoclawctl router model-intel refresh   # 刷新模型能力 / 价格快照
octoclawctl router model-config analyze  # 找便宜的同供应商候选模型
octoclawctl router shadow-report         # 看 shadow 模式对比结果
```

---

## 工作原理

```text
用户消息
  │
  ├─ intent grounding + execution coverage
  │
  ├─ judge（轻量模型，<1s）
  │     └─ 输出：route / confidence / complexity / complexityConfidence
  │
  ├─ WorkDecisionSeal → WorkContract → 委派票据
  │
  ├─ route commit ACK
  │
  ├─ reply 路径
  │     └─ 主 agent 基于证据直接答，不创建新执行单元
  │
  └─ delegate 路径
        ├─ octoclaw_dispatch → native sessions_spawn
        ├─ octoclaw_dispatch_confirm（绑定 accepted run 证据）
        ├─ 子 agent 在 native TaskFlow 下独立跑
        ├─ native announce 送达最终结果
        └─ 状态投影 + IM footer 反映 durable 事实
```

---

## Auto Router（成本导向的模型选择）

当前**只做推荐**，不接管实际路由。流程：

1. `octoclawctl router model-intel refresh` — 汇总你已配置的模型、公开价格、能力、额度压力成一个快照
   - 价格来源：OpenClaw pricing cache、OpenRouter、models.dev、LiteLLM mapping
   - 能力来源：OpenClaw provider catalog、OpenRouter `supported_parameters`、本地 smoke probe
   - 场景先验：PinchBench、Aider、SWE-bench、LiveCodeBench、BFCL、Artificial Analysis
   - 多源冲突（价格相差 >20%、能力不一致）会标 `conflict=true`，**不静默覆盖**
2. `octoclawctl router model-config analyze` — 找同供应商的便宜候选（不会自动改你的 OpenClaw 配置）
3. **Shadow 记录** — 每次委派旁路记一条"实际用了 X，如果用 Y 会怎样"，包括预估成本差
4. **Gate 才上线** — 连续 7 天以上样本、质量不降、成本不升、一键回滚，才允许上 live

证据优先级：**本地 replay > 你的 OpenClaw 配置 > 外部榜单和 catalog。**
榜单分再高也不能直接上线，只有你自己跑出来的数据才能。

硬规则：
- 额度未知永远不当免费
- 未配置的模型永远不上 live
- shadow 出错绝不影响实际路由

---

## 项目结构

```text
packages/octoclaw-contracts       稳定合同（WorkContract、events、results、delivery、projection）
packages/octoclaw-policy          策略（intent、judge schema、route、role、model、gate、router）
extensions/octoclaw-runtime       OpenClaw runtime 插件（hooks、dispatch、ACK、IM、delivery、replay）
extensions/octoclaw-status-surface
                                  status / details / queue / timeline 的读模型和渲染器
tools/octoclawctl                 安装、部署、状态、nightly、review、curate、calibration
schemas                           JSON Schema 合同
eval                              最小 eval fixtures
docs                              当前设计文档
docs/archive                      历史规划和证据
```

---

## 路线图

- **N1（进行中）** — runtime gate 收敛，timeout watchdog + canonical 状态，retry / amendment 协议
- **N2** — IM 能力矩阵产品化；Slack / 飞书 / 微信 验收 fixtures
- **N3** — Auto Router 从 shadow 到 gated live（只覆盖委派，主 agent 默认不动）
- **N4** — 发布和开源打磨：quickstart、release gate、operator runbook

完整架构基线见 [`docs/octoclaw-ts-rebuild-design-v2.md`](./docs/octoclaw-ts-rebuild-design-v2.md)，详细模块图见 [`docs/octoclaw-architecture-map-2026-05-09.md`](./docs/octoclaw-architecture-map-2026-05-09.md)。

---

## 开发校验

```bash
pnpm check   # 所有 workspace 包的 typecheck + build
pnpm test    # vitest
git diff --check
```

只改文档跑 `git diff --check` 就够。

---

## 贡献

- 第一次提 PR 前先看 [`CONTRIBUTING.md`](./CONTRIBUTING.md)
- 较大改动走 [`openspec/changes/`](./openspec/README.md) 流程：先写 `proposal.md` / `design.md` / `tasks.md` 再写代码
- 遵守 [`docs/octoclaw-ts-rebuild-design-v2.md`](./docs/octoclaw-ts-rebuild-design-v2.md) 里的硬不变量

---

## 设计哲学

> **不要再重写 OctoClaw；现在要把它从"重构完成的系统"打磨成"可发布、可验证、可恢复、可演进的系统"。**

—— 摘自当前的 v2 设计基线

项目还早期，会有糙边。踩到 bug 请提 issue，我们会看。

---

## 许可证

MIT，详见 [`LICENSE`](./LICENSE)。
