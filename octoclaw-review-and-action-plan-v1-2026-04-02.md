# OctoClaw 整体复盘与行动计划 v1（2026-04-02）

## 1. 文档目的

本文是一次系统性复盘，涵盖：

- 整体方向是否有偏差
- 代码层面存在的问题
- 基于 Anthropic 官方工程笔记的差距分析
- OpenClaw 3.31/4.1 原生 flow task 对架构的影响
- ClawTeam 依赖重定位
- Router 演进路线
- Python vs Node/TS 语言选型与迁移路径
- 优先级行动计划

参考来源：

- [`octoclaw-anthropic-agent-engineering-notes-v1-2026-03-30.md`](./octoclaw-anthropic-agent-engineering-notes-v1-2026-03-30.md)
- [`octoclaw-product-design-v2-2026-03-27.md`](./octoclaw-product-design-v2-2026-03-27.md)
- [`octoclaw-roadmap-multi-agent-cost-speed-2026-03-20.md`](./octoclaw-roadmap-multi-agent-cost-speed-2026-03-20.md)
- [`octoclaw-clawteam-unified-runtime-v1-2026-03-25.md`](./octoclaw-clawteam-unified-runtime-v1-2026-03-25.md)

---

## 2. 整体方向评估

### 2.1 正确的部分，不需要改

- **三脑定位**（调度脑 / 成本脑 / 展示脑）清晰，没有跑偏成通用 agent SDK 或 LangGraph-like 框架
- **policy-first + workflow-first** 与 Anthropic 官方方法论高度一致
- **4 条 route**（direct / runner / spawn_single / spawn_multi）结构合理，不需要再拆
- **work_contract 概念**比纯"任务语义分类"更稳，演进方向正确
- **worker_pool-first 的 taxonomy** 已落地，是后续的正确地基

### 2.2 需要收紧的地方

**问题一：route 判定语义仍有旧惯性**

文档里已经写明要从"任务分类"转向"执行合同选择"，但 `octoclaw_route.py` 的评分体系中仍然有大量"任务像什么"的语义特征打分，与 `work_contract_hint + risk/parallel_gain/needs_durable_runtime` 的判定路线没有完全对齐。这不是致命问题，但会让灰区误判率偏高。

**问题二：ClawTeam 依赖过重**（见第 5 节专门分析）

---

## 3. 代码层面存在的问题

### 3.1 中等风险

**`index.js` 中 `findPolicyStateByPrompt` 做精确字符串匹配**

```js
if (String(state.prompt || "").trim() !== task) continue;
```

follow-up 消息只要有一字之差就无法命中缓存，导致重复调用 `octoclaw_policy.py`。在用户说"继续"、"再做一次"这类短跟进时尤其容易出问题。

**`policyStateBySession` 纯内存 Map，不持久化**

extension reload 或 OpenClaw 重启后所有 session 状态丢失，patrol 和 sticky lane 会短暂失效。

**`dispatch_task.py` 中 `--wait-timeout-seconds 12` 硬编码**

12 秒对 runner 够用，但 spawn_single 触发时往往来不及拿到结果，dispatch 返回 `planned` 而非 `executed`，主 agent 后续可能重复派单。

### 3.2 低风险但需要注意

**ClawTeam bridge 的 `hybrid/cli` 模式失败静默**

`clawteam_bridge.py` 在 ClawTeam 未安装时静默 fallback，错误信息不足，运维时难以定位。

**`runner_queue.py` 并发写入无文件锁**

多个快任务同时触发时，`runner-queue.json` 存在写入竞争（低概率，但 runner 并发高时会出现）。

**`model_health_backfill.py` 时间戳混用**

部分地方混用 `datetime.now()` 与 `datetime.utcnow()`，跨时区环境下 cooldown 计算会产生偏差。

---

## 4. 基于 Anthropic 工程笔记的差距分析

Anthropic 笔记（`octoclaw-anthropic-agent-engineering-notes-v1-2026-03-30.md`）识别出 4 个优先方向：context engineering、tool ergonomics、long-running harness durability、eval discipline。以下逐一对照当前代码的实际差距。

### 4.1 工具结果没有为模型塑形（对应笔记 5.3）

**笔记原文**：tool results should be shaped for model use, not only for humans

**当前问题**：

`octoclaw_dispatch` 的返回格式：

```
summary: "OctoClaw dispatch: spawn_single (planned)"
details: { route, executed, handoff, policy_decision, job, ... }
```

模型需要自己从 `details` 里挖 `handoff.summary` 或 `report_path`，极易犯错。`details` 直接包含完整 `policy_decision` JSON，token 很重但对模型决策无直接帮助。

**建议改法**：

`summary` 里直接给出模型下一步要做的事：

- 如果 `handoff.user_safe` 且有 `reply_text`，summary 直接用 `reply_text`
- 如果有 `report_path`，summary 明确写"结果已写入 `{path}`，用 `octoclaw_task_action artifacts` 读取"
- `details` 只保留 `route / task_id / report_path / status` 这几个字段，其余裁掉

同样的问题存在于 `octoclaw_spawn` 和 `octoclaw_route_hint` 的返回里。

### 4.2 缺少 pre-delegation think 暂停（对应笔记 5.3）

**笔记原文**：think/checkpoint style pauses are more useful than blindly increasing autonomy

**当前问题**：没有任何"在重大委派前停下来确认"的机制。主脑拿到 `spawn_single` route decision 后直接进入 dispatch，没有中间验证步骤。

**建议改法**：

在 `before_prompt_build` hook 里，当 route 是 `spawn_single`/`spawn_multi` 且 `risk` 字段不为空时，向 system context 注入：

```
Before dispatching, briefly confirm:
- What is the core deliverable?
- What are the key constraints?
- Is the task boundary clear enough for a subagent to execute independently?
```

不需要接真正的 think tool，只是 system context 里加一小段提示，让模型在派单前做一次 inline checklist。成本极低，效果直接。

### 4.3 delegated task 缺少中间进度信号（对应笔记 5.4）

**笔记原文**：delegated tasks should emit progress and readiness signals before final completion

**当前问题**：`task-events.jsonl` 有 `delegated_started` / `dead_agent_recovered` 等事件，但没有 `checkpoint_emitted` 或 `deliverable_ready` 中间信号。任务从 `running` 直接到 `done`，patrol 无法区分"稳步推进"和"悄悄卡住"。

**建议改法**：

在 `spawn-template.md` 的 prompt contract 里加入明确约定：

```markdown
When you complete a major step or reach a clear checkpoint, emit:

CHECKPOINT: <one-line description of what is done>
ARTIFACTS_READY: <list files if any>

Only after all steps are complete, emit the final RESULT block.
```

同时在 `octoclaw_spawn.py` 的 `build_task_prompt()` 里把这条规则写进生成的 prompt，确保每个 spawn 都带上这个约定。

### 4.4 runner result 可能膨胀主链（对应笔记 5.2）

**笔记原文**：follow-up handling should be based on compact context packs, not raw transcript replay

**当前问题**：`dispatch_task.py` 的 runner 路径在命令输出较长时，会把完整 stdout 直接放入 `handoff.reply_text`，可能直接膨胀主链上下文。

**建议改法**：

在 `dispatch_task.py` 的 runner result 处理里加 `max_inline_chars` 截断（建议 1200 字符），超出阈值的内容写到 report file，只返回摘要 + path：

```python
MAX_INLINE_CHARS = 1200

if len(stdout) > MAX_INLINE_CHARS:
    report_path = write_runner_report(job_id, stdout)
    reply_text = stdout[:MAX_INLINE_CHARS] + f"\n\n[输出已截断，完整内容：{report_path}]"
else:
    reply_text = stdout
```

### 4.5 runtime events 没有喂给 eval fixtures（对应笔记 5.6）

**笔记原文**：delegated runtime events should feed eval fixtures

**当前问题**：`task-events.jsonl` 每次任务都在写事件，但 `eval_suite.py` 和 `eval/tasks-minimal.json` 是完全静态的手写任务集，两者没有任何连接。

**建议改法**：

新增 `lib/eval_fixture_export.py`，从 `task-events.jsonl` 抽取成功任务 pattern：

- 哪类任务走了什么 route
- 路由决策、执行结果、耗时估算
- 自动导出成 eval fixture 格式

先做到"线上跑的真实成功案例能自动变成回归测试"就够了，不需要复杂。

---

## 5. OpenClaw 3.31/4.1 flow task 对架构的影响

### 5.1 变化的核心

OpenClaw 3.31/4.1 的原生 flow task 能力提供了：

- 任务创建 + 状态跟踪
- 子任务生命周期管理
- 可能的依赖/DAG 支持

这直接覆盖了 OctoClaw 之前从 ClawTeam 借用的大部分"执行运行面"能力。

### 5.2 架构调整

**原来**：
```
OpenClaw → OctoClaw policy → ClawTeam runtime (task/inbox/board/tmux) → workers
```

**新方向**：
```
OpenClaw → OctoClaw policy → OpenClaw native flow_task → workers
                                     ↓（可选）
                              ClawTeam tmux workbench（仅作 operator 观测面）
```

### 5.3 ClawTeam 的重新定位

**从**：必选执行运行时

**到**：可选 tmux 工作台

具体来说：

| 当前角色 | 调整后 |
|----------|--------|
| `clawteam_bridge.py` 的 `hybrid/cli` 模式 | 降级为明确 opt-in，不再是默认尝试 |
| `mirror` 模式（本地文件镜像） | 保留，不依赖 ClawTeam 安装，有独立价值 |
| ClawTeam task/inbox/board | 由原生 flow task 替代 |
| ClawTeam tmux workbench | 保留，纯 operator 体验层，与 flow task 不冲突 |

### 5.4 task-state.json 的角色变化

有了原生 flow task 后，`task-state.json` 不再是执行真相源，而应该成为 **OctoClaw 自己的策略元数据存储**：

- model choice（选了哪个模型，为什么）
- cost record（预算消耗）
- policy decision（route 决策的完整 decision object）
- patrol metadata（上次巡逻时间、恢复次数）

执行状态（running/done/failed）直接从原生 flow task API 读取，patrol 变成监控层而不是真相源。

### 5.5 六条 ClawTeam/DeerFlow 借鉴的实现路径分叉

Anthropic 笔记第 6 节里的六条借鉴仍然有效，但实现路径因 flow task 而改变：

| 借鉴 | flow task 前 | flow task 后 |
|------|-------------|-------------|
| 1. 事件流 | 自建 `task-events.jsonl` | 优先消费原生 flow task events，OctoClaw 做适配层 |
| 2. IM thread binding | 从 ClawTeam 借 | 仍然 OctoClaw 自己做，flow task 不感知 IM 层 |
| 3. artifact index | 从 ClawTeam inbox 借 | OctoClaw 在原生 artifact 之上维护检索层 |
| 4. ownership lock + 恢复 | ClawTeam task lifecycle | 优先用原生 flow task 状态，patrol 变监控层 |
| 5. session resume | ClawTeam session store | 原生 flow task 可能自带，OctoClaw 做 fallback |
| 6. checklist persistence | DeerFlow todo_middleware | 仍然 OctoClaw 自己做 |

---

## 6. Router 演进方向

### 6.1 当前 `hard_runner_only` 决策是对的

原因：

- 估计 70%+ 的任务用规则层就能正确分诊
- 灰区用主脑的 `route_hint` 回填已经足够
- 引入额外模型调用会增加延迟和成本

**不要急着换。**

### 6.2 小模型 router（llama.cpp）的时机

可以做，但现在不是时候。等以下条件成熟再考虑：

1. 有足够 replay 数据（建议 1000+ 真实样本带标注）
2. 灰区失败模式已经被充分记录和分析
3. 规则层已经尽量优化，剩余误判是真正的语义歧义

llama.cpp 部署本身有运维成本，在系统还不稳定时加这一层只会让 debug 更难。

### 6.3 短期更有效的 router 优化

与其上小模型，不如把规则层做得更精准：

- 把 `work_contract_hint` 字段落地到 route 判定的主路径（现在还在评分旁路）
- 加 `parallel_gain` 和 `needs_durable_runtime` 两个特征的明确 hard gate
- `spawn_multi` 的触发阈值收得更保守（文档里反复强调 spawn_multi 要 conservative）

---

## 7. 优先级行动计划

### P0：立即可做，改动量小，收益直接

| 行动 | 对应来源 | 文件 |
|------|----------|------|
| dispatch/spawn 工具 summary 对模型友好化 | Anthropic 笔记 5.3 | `extensions/octoclaw-runtime/index.js` |
| runner result 加 `max_inline_chars` 截断 | Anthropic 笔记 5.2 | `lib/dispatch_task.py` |
| 更新本文档：ClawTeam 角色重新定位 | flow task 变化 | `octoclaw-anthropic-agent-engineering-notes-v1-2026-03-30.md` |

### P1：下一轮迭代，改动量中等，对稳定性提升明显

| 行动 | 对应来源 | 文件 |
|------|----------|------|
| spawn-template 加 CHECKPOINT 中间信号约定 | Anthropic 笔记 5.4 | `lib/spawn-template.md`, `lib/octoclaw_spawn.py` |
| before_prompt_build 加 pre-delegation confirm | Anthropic 笔记 5.3 | `extensions/octoclaw-runtime/index.js` |
| ClawTeam bridge `hybrid/cli` 模式降级为 opt-in | flow task 变化 | `lib/clawteam_bridge.py`, `lib/octopus_config.py` |
| dispatch timeout 按 route 类型分档 | 代码问题 3.1 | `lib/dispatch_task.py` |
| **policy/route 核心逻辑迁移至 TS**（消除热路径 subprocess） | 语言选型 §10 | 新增 `extensions/octoclaw-runtime/policy/` |

### P2：中期目标，建立反馈闭环

| 行动 | 对应来源 | 文件 |
|------|----------|------|
| `eval_fixture_export.py`：task-events → eval fixtures | Anthropic 笔记 5.6 | 新增 `lib/eval_fixture_export.py` |
| task-state.json 重定义为策略元数据存储 | flow task 变化 | `lib/task-state-update.py`, schema |
| patrol 改为消费原生 flow task 状态 | flow task 变化 | `lib/patrol.py` |
| **taskflow adapter 迁移至原生 TS binding**（flow task API 稳定后） | 语言选型 §10 | 替换 `lib/openclaw_taskflow_adapter.py` |

### P3：长期收口，不急

| 行动 | 对应来源 |
|------|----------|
| `spawn_multi` 触发阈值收紧 | Anthropic 笔记 5.1/5.5 |
| route kernel 从评分体系迁向 `work_contract` hard gate | 产品设计 v2 第 12.2 节 |
| 灰区 router 数据积累（为未来小模型 router 备料） | roadmap |
| dispatch spawn 路径 TS 化（runner daemon 保留 Python） | 语言选型 §10 |

---

## 8. 整体目标可达性

**"更快、更节约成本"是可以实现的**，但有一个前提。

理论收益：

- runner 快路径对轻任务可砍掉 80%+ 冷启动时间
- 子任务按角色选便宜模型，理论上可将平均 cost 降 40–60%
- brief/artifact 协议减少上下文膨胀，长任务续档成本大幅下降

前提：选模决策必须有真实数据支撑。没有 role-level 成功率的历史积累，选了便宜模型但重试率高，最终反而更贵。`eval_fixture_export` 和 nightly model speed 更新是这个前提的基础。

**具有普遍使用价值吗？**

- 对频繁使用多 agent、任务量大、成本敏感的用户：价值明确，是刚需
- 对偶发性任务、单用户轻量使用：价值有限，overhead 可能大于收益

所以 OctoClaw 是一个**专业工具**，不是零成本的普惠工具。这个定位是合理的，不需要强求"人人都能用"。

---

## 9. 需要同步更新的文档

| 文档 | 需要更新的内容 |
|------|---------------|
| `octoclaw-anthropic-agent-engineering-notes-v1-2026-03-30.md` | 第 3 节结论补充 flow task 影响；第 6 节六条借鉴加"flow task 后实现路径"列 |
| `octoclaw-product-design-v2-2026-03-27.md` | 第 10 节 ClawTeam 依赖边界更新；第 12.1 节第一段的实现路径更新 |
| `octoclaw-clawteam-unified-runtime-v1-2026-03-25.md` | 整体架构图和结论补充 flow task 替代路径说明 |

---

## 10. Python vs Node/TS 语言选型与迁移路径

### 10.1 总体判断

**Python 代码质量本身没问题，不需要全面重写。** 问题在架构边界：`index.js`（OpenClaw extension）和 Python 之间的通信方式是 subprocess + JSON stdout，导致热路径上有严重的冷启动开销。

### 10.2 核心瓶颈：每次工具调用都要 fork 一个 Python 进程

```
OpenClaw 调用工具 (Node.js event loop)
    → index.js spawn("python3", ["octoclaw_policy.py", ...])
        → Python 进程冷启动 + import 所有模块 (~150-300ms)
        → 读磁盘配置文件
        → 计算结果，print JSON
    → index.js 解析 stdout
```

`octoclaw_policy.py` 和 `octoclaw_route.py` 通过 `before_model_resolve` + `before_prompt_build` hook **每次请求都触发**，意味着每个用户请求至少有 2 次 Python 冷启动。对于"runner 快路径"这个核心目标来说，这个开销是反效果的。

### 10.3 应该迁移到 Node/TS 的部分

#### 必须迁移（P1，高价值）

**`octoclaw_route.py` + `octoclaw_policy.py` 核心逻辑 → TS**

迁移后的目录结构：

```
extensions/octoclaw-runtime/
  index.js                   ← 现有，基本不动
  policy/
    route.ts                 ← octoclaw_route.py 的 infer_route() 逻辑
    decide.ts                ← octoclaw_policy.py 的 build_decision() 逻辑
    taxonomy.ts              ← worker_taxonomy.py 的数据和映射规则
    stickiness.ts            ← route stickiness 逻辑（从 octoclaw_policy.py 拆出）
```

`index.js` 里的 `resolvePolicyDecisionForContext` 直接调 `decide.ts`，不再 fork Python。

Python `octoclaw_policy.py` 保留 `main()` CLI 入口，供 `/octopolicy` 命令行调试使用，但不再是请求热路径。

**迁移难度**：中等。`octoclaw_policy.py` 约 990 行，核心逻辑主要是 dict 操作、正则匹配、评分计算，没有 Python 特有的重型依赖，翻译成 TS 约 500-600 行。`worker_taxonomy.py` 的数据部分直接变 TS const 对象。

**预期收益**：

| 指标 | 迁移前 | 迁移后 |
|------|--------|--------|
| `before_model_resolve` hook 耗时 | ~200ms（Python fork） | ~2ms（in-process） |
| `before_prompt_build` hook 耗时 | ~200ms（Python fork） | ~2ms（in-process） |
| 每次请求 policy overhead 合计 | 400–600ms | 4–10ms |

#### 迁移但优先级低（P2）

**`openclaw_taskflow_adapter.py` → native TS binding**

当前文件里有：

```python
subprocess.run(["openclaw", "tasks", "list", "--json"], ...)
```

这是"用 shell 调自己"的典型反模式。等 OpenClaw flow task JS API 稳定后，应该直接调原生 API，消除这个 subprocess 往返。

### 10.4 应该保留 Python 的部分

| 模块 | 理由 |
|------|------|
| `runner_dispatch.py` / `runner_queue.py` / `runner-daemon.sh` | 长驻进程 + shell 子进程管理，Python+bash 天然合适；每个 job 仅调用一次，无冷启动压力 |
| `patrol.py` | 周期性后台任务，不在请求热路径 |
| `dispatch_task.py` | 调用频率低（每次真实 dispatch 才触发），短期可留；policy/route 迁完后进一步简化 |
| `model_health.py` / nightly scripts | 维护脚本，Python 完全胜任 |
| `task-state-update.py` / `task_events.py` | 文件 I/O 工具，非热路径 |
| IM 集成 / feishu / notifier | 非核心路径 |

### 10.5 不建议做的

- **全量重写**：Python 代码有完整测试覆盖，重写会引入回归风险，且收益和迁移热路径相比不成比例。
- **共享进程模型**（如用 `python-bridge` 之类的库维持一个常驻 Python 进程）：增加运维复杂度，不如直接把热路径逻辑迁到 TS 干净。
- **先迁 `dispatch_task.py`**：它不在热路径上（每次真实 dispatch 才调），优先级低于 policy/route。

### 10.6 迁移顺序

```
Phase 1（P1）：policy/route → TS
  - 新建 extensions/octoclaw-runtime/policy/
  - 实现 route.ts + decide.ts + taxonomy.ts
  - index.js 内部调用切换，Python CLI wrapper 保留
  - 补 TS 单元测试，对照 Python 测试用例

Phase 2（P2）：taskflow adapter → native TS
  - 等 OpenClaw flow task JS API 文档稳定
  - 替换 openclaw_taskflow_adapter.py 的 subprocess 调用

Phase 3（P3，可选）：dispatch spawn 路径 TS 化
  - runner daemon 永远留在 Python
  - spawn spec 构建可以迁，但不急
