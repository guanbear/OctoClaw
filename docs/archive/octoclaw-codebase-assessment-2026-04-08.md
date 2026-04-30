# OctoClaw 代码库评估报告（2026-04-08）

> 状态：基于 `codex/release-v0.1.0` 的 `P2.5 closeout` 后续状态更新（2026-04-08）
> 评估范围：设计意图 vs 实现完成度、当前主线进展、代码质量问题、后续优先级
> 关联文档：[`octoclaw-execution-plan.md`](./octoclaw-execution-plan.md)、[`octoclaw-design-foundation.md`](./octoclaw-design-foundation.md)、[`octoclaw-auto-router-implementation-checklist.md`](./octoclaw-auto-router-implementation-checklist.md)

---

## 1. 总体判断

**骨架完整，核心理念与设计文档高度对齐，P2.5 Auto Router baseline 已完成收口。**

- Phase 0–5 的核心建设已经完成，不存在地基缺失的问题
- 架构方向（policy-first / workflow-first / work_contract routing / artifact-first）与 Anthropic 工程方法论一致
- 当前主线不再是“补齐 P2.5 baseline”，而是进入 post-P2.5 的 hardening / calibration / extractable prep

---

## 2. 已完成 Baseline（不需要重做）

以下能力已进入 baseline，评估时不应被误判为"待办"：

### 2.1 Substrate / Continuity / Observer

| 能力 | 状态 |
|------|------|
| 统一 runtime task record + decision schema | ✅ |
| policy-first 选模 + worker_pool-first taxonomy | ✅ |
| runtime policy（hard_runner_only, route_hint, sticky lane, replay, language packs） | ✅ |
| unified runtime surface（lineage, parent/child aggregation, runner/shared workbench） | ✅ |
| ownership lock + dead-agent recovery（CAS lock, mark_task_for_reassignment） | ✅ |
| worker session resume store（`lib/session_resume.py`） | ✅ |
| runtime observer / patrol / octoclawctl | ✅ |
| taskflow-bound runner jobs + native taskflow control metadata | ✅ |
| on-demand runner fallback / patrol observation pass 收口 | ✅ |

### 2.2 Artifact / Context / Checklist

| 能力 | 状态 |
|------|------|
| brief / result / artifact 协议 | ✅ |
| artifact index + retrieval（`lib/context_pack.py` + artifact explorer） | ✅ |
| checklist/todo persistence（`lib/checklist_history.py`, `lib/checklist_middleware.py`） | ✅ |
| delegated event stream（task-events.jsonl） | ✅ |

### 2.3 IM / Display

| 能力 | 状态 |
|------|------|
| IM thread/topic binding（session-thread-map.json, anchor reuse） | ✅ |
| task anchor rendering + updates | ✅ |
| Slack / Feishu / Telegram / Discord / WhatsApp 基础适配 | ✅ |
| details / timeline / graph / retrieve / explorer / queue surfaces | ✅ |

### 2.4 Feedback Loop

| 能力 | 状态 |
|------|------|
| replay log / replay summary / replay review / replay curate | ✅ |
| nightly replay automation / reply review / local replay validation | ✅ |
| eval fixture export | ✅ |
| learning / error promotion helpers | ✅ |
| eval state machine（`lib/eval_state_machine.py`） | ✅ |

### 2.5 Auto Router（P2.5 第一拍）

| 能力 | 状态 |
|------|------|
| JS 热路径 policy（`decide.js / route.js / recommendation.js`） | ✅ |
| Python parity（`auto_router.py`） | ✅ |
| protected lanes（control_observer / session_control）baseline | ✅ |
| model-intel source adapters（OpenRouter catalog/rankings, models.dev, freshness/cache） | ✅ |
| calibration evidence format（`classify_case_drift`, `build_tuning_inputs`） | ✅ |
| recommendation payload 关键字段（route_class / agent_scope / candidate_models / reasoning_mode） | ✅ |

---

## 3. P2.5 Auto Router Slice 状态（当前主线）

| Slice | 内容 | 状态 | 说明 |
|-------|------|------|------|
| **A** | route / budget / outcome recommendation schemas | ✅ 已完成 | 三个 schema 已落地，decision/replay contract 已补齐 |
| **B** | delegated-lane 消费 recommendation | ✅ 已完成 | `runner / spawn_single / spawn_multi` 已接入 lane-local recommendation |
| **C** | route outcome + shadow rollout | ✅ baseline 完成 | replay / review / curate / summary 已可见；更深 validation/rollout 进入 RM3 |
| **D** | policy adapter 收口（health/quota/capacity） | ✅ baseline 完成 | final resolution 已记录 health/quota/queue pressure/capacity；更彻底 read-model 统一进入 RM 深化 |
| **E** | model-intel source adapters | ✅ 基本完成 | auto refresh 调度占位仍属后续 hardening |
| **F** | tiny judge adapter | ⬜ 有意延后 | 设计有意不做前置，optional |
| **G** | offline calibration / learned-router 训练面 | 🟡 部分完成 | calibration evidence format + tuning inputs 已落地，后续进入更深 RM3 |

**结论：P2.5 baseline blocker 已关闭；剩余工作统一转入 RM 深化。**

---

## 4. 代码质量问题

### 4.1 中等风险

**① `index.js` — `findPolicyStateByPrompt` 精确字符串匹配**

```js
if (String(state.prompt || "").trim() !== task) continue;
```

follow-up 消息一字之差即无法命中缓存，重复触发 `octoclaw_policy.py`。用户说"继续"、"再做一次"时尤其容易出问题。建议改为 session_id-first 查找，prompt 只作辅助 hint。

**② `policyStateBySession` 纯内存 Map，不持久化**

extension reload 或 OpenClaw 重启后所有 session 状态丢失，patrol 和 sticky lane 短暂失效。`session-resume-contexts.json` 已经存在，可以直接复用作持久化后端。

**③ `dispatch_task.py` — `--wait-timeout-seconds 12` 硬编码**

12 秒对 runner 够用，但 `spawn_single` 触发时往往来不及拿到结果，dispatch 返回 `planned` 而非 `executed`，主 agent 后续可能重复派单。应按 route 类型分档（runner: 12s，spawn_single: 45s）。

### 4.2 低风险但有意义

**④ `runner_queue.py` 并发写入无文件锁**

多个快任务同时触发时，`runner-queue.json` 存在写入竞争（低概率，但 runner 并发高时会出现）。

**⑤ `model_health_backfill.py` 混用时间戳**

部分地方混用 `datetime.now()` 与 `datetime.utcnow()`，跨时区环境下 cooldown 计算会产生偏差。

---

## 5. 设计意图 vs 实现差距

基于 `octoclaw-review-and-action-plan-v1-2026-04-02.md` 和 Anthropic 工程笔记（`§5.2 / 5.3 / 5.4`）的差距分析：

### 5.1 tool result 没有为模型塑形（Anthropic 笔记 §5.3）

`octoclaw_dispatch` 返回的 `details` 字段包含完整 `policy_decision` JSON，token 重但模型无法直接利用。模型需要自己从 `details` 里挖 `handoff.summary` 或 `report_path`，极易出错。

**建议**：`summary` 直接给出下一步指令；`details` 只保留 `route / task_id / report_path / status`。

### 5.2 delegated task 缺中间进度信号（Anthropic 笔记 §5.4）

任务从 `running` 直接到 `done`，patrol 无法区分"稳步推进"和"悄悄卡住"。

**建议**：在 `spawn-template.md` 的 prompt contract 里加入：

```markdown
When you complete a major step, emit:
CHECKPOINT: <one-line description>
ARTIFACTS_READY: <list files if any>
```

### 5.3 route 判定语义仍有旧惯性（review doc §2.2）

`octoclaw_route.py` 评分体系中仍有大量"任务像什么"的语义特征打分，未完全收成 `work_contract_hint + risk / parallel_gain / needs_durable_runtime` 的判定路线。这是 P2.5 Slice A/B 要根本解决的问题。

### 5.4 runner result 可能膨胀主链（Anthropic 笔记 §5.2）

`dispatch_task.py` runner 路径在命令输出较长时，完整 stdout 直接进入 `handoff.reply_text`，可能膨胀主链上下文。

**建议**：加 `MAX_INLINE_CHARS = 1200` 截断，超出阈值写 report file，只返回摘要 + path。

---

## 6. 后续优先级

### P0 已关闭（原 blocker 已处理）

| 行动 | 文件 |
|------|------|
| 补 3 个缺失 schema（Slice A 直接阻塞） | ✅ 已完成 |
| `dispatch` / `spawn` tool result 对模型友好化 | ✅ 已完成 |
| runner result 加 `MAX_INLINE_CHARS` 截断 | ✅ 已完成 |

### P1 下一轮迭代（post-P2.5 hardening）

| 行动 | 文件 |
|------|------|
| dispatch timeout 按 route 分档（runner: 12s，spawn_single: 45s） | 仍值得继续硬化 |
| `spawn-template.md` 加 `CHECKPOINT` / `ARTIFACTS_READY` 中间信号约定 | 继续作为 reliability 配套 |
| validation / rollout 更深消费 route outcome | `lib/replay_validation.py`, `lib/runtime_policy_rollout.py` |
| route outcome / replay artifacts 与 feedback manifest 更紧密关联 | `lib/feedback_loop.py` |

### P2 中期目标（RM 深化）

| 行动 | 文件 |
|------|------|
| 更彻底统一 `model_health / runtime_snapshot / route outcome` 的 read-model | `lib/model_health.py`, `lib/runtime_snapshot.py` |
| RM1：model-intel facts plane 硬化（source-attributed catalog, freshness/precedence contract） | `lib/model-intel.py` |
| RM2：router recommendation 硬化（route-budget 集成测试，regression tests） | `lib/router_eval.py` |
| RM3：replay/eval 校准接入（replay-driven router eval，drift diagnostics） | `lib/router_eval.py`, `lib/replay_validation.py` |

### P3 长期收口（RM4 + 后续）

| 行动 |
|------|
| RM4 extractable readiness：minimal package boundary, public surface, machine-readable manifest |
| `spawn_multi` 触发阈值收紧 |
| route kernel 从评分体系迁向 `work_contract` hard gate |
| `policyStateBySession` 持久化（复用 session-resume-contexts.json） |

---

## 7. 结论

OctoClaw 当前的实现状态与设计文档的意图基本对齐，没有方向性偏差。

当前主要工作已经从 **P2.5 Auto Router contract closeout** 切换到 **post-P2.5 hardening / calibration / extractable prep**。

下一步最短路径不再是补 baseline contract，而是：

1. 继续把 validation / rollout / feedback-manifest 接到 route outcome
2. 做更深的 route-budget calibration / drift diagnostics
3. 继续把 facts plane / recommendation plane 朝 extractable kernel 收紧
