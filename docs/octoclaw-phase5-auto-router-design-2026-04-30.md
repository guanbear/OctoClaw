# OctoClaw Phase 5：Auto Router 加固 — 详细设计

> 文档路径：`docs/octoclaw-phase5-auto-router-design-2026-04-30.md`  
> 代码基线：`refactor/0.4.0-stable`（Phase 0-4 全部完成）  
> 前置参考：[`octoclaw-auto-router-design.md`](octoclaw-auto-router-design.md)（战略底稿，保留不删）  
> 日期：2026-04-30
> N0 更新：`packages/octoclaw-runtime-core` 已并入 runtime extension；Phase 5 router core 的建议落点改为 `packages/octoclaw-policy/src/router/*`。本文中的 `direct / runner / spawn_single / spawn_multi` 均表示 execution contract / lane，不是 live route authority；live route 仍为 `reply | delegate`。

---

## 零、前提检查

本阶段**严格要求** Phase 0-4 全部完成。核查结果：

| 前置条件 | 状态 | 说明 |
|----------|------|------|
| Phase 0：P0 高危修复 | ✅ | ACK thread anchor、delivery retry、ackNoTarget 全修 |
| Phase 1：真相收敛 + 术语统一 | ✅ | octoclaw_status 纯读磁盘；Observer/Patrol/Runner/Ctl 边界有文档、有测试 |
| Phase 2：反馈链路统一 | ✅ | nightly-eval + calibration gate + baseline promote 全链路接通 |
| Phase 3：IM 能力矩阵 | ✅ | FeishuAdapter (L1)、WeChatAdapter (L0)、sendWithDegradation 降级封装 |
| Phase 4：基底收敛 | ✅ | mirror 模式标记 @deprecated；managedDisposition 标记废弃；字段映射有注释 |
| cost/latency baseline | ✅ 可用 | Phase 2 的 nightly-eval 已接通 cost/latency/correctness 三维指标 |

只有以上全部为 ✅，Phase 5 才能开始实现。**Auto Router 不能在没有 baseline 的情况下推进决策优化。**

---

## 一、一句话定义（沿用战略底稿）

> **OctoClaw Auto Router 是一个放在 runtime policy 面之前的推荐与约束子系统，联合决定**
> `execution contract → agent scope → route class → model candidate → output budget → fallback policy`。

Auto Router 的**第一职责**是决定 execution contract，不是选模型。选模型在 execution contract 确定后，由 lane-local policy 负责。

---

## 二、设计目标与永不做的边界

### 2.1 目标

1. **可解释性优先**：每个 route 决策必须有 `reasonCodes`，人工 review 可追踪
2. **shadow 先行**：上线前先 shadow 模式记录 `old vs recommended`，不直接接管 live path
3. **只优化 delegated lanes**：`runner / spawn_single / spawn_multi` 是主优化对象；`direct` 主 agent 默认稳定
4. **与 Phase 2 反馈链路共生**：Auto Router 的 outcome 通过 replay → nightly-eval → calibration gate 验证，不自己建一套评估系统
5. **contract 独立可抽离**：`router-core` 是纯 TypeScript 库，不绑定 OpenClaw runtime 细节

### 2.2 永不做

- Online bandit / RL 训练（Phase 5 以后才考虑）
- Learned router 作为 live hot path（先 shadow 推荐，再 gated 推广）
- 替代 OpenClaw substrate / TaskFlow orchestration
- 绕过 nightly-eval gate 直接推 live
- 把 `control_observer` / `session_control` 样本混进业务 route 训练集
- 把静态 tier map 当成最终形态（tier → route class 是垫脚石，不是终点）

---

## 三、五层架构（明确各层边界）

```
┌─────────────────────────────────────────────────────┐
│ 1. Signal Layer                                      │
│   task_type · complexity · reasoning_need            │
│   tool_need · context_tokens · latency_sensitivity  │
│   cost_sensitivity · language · surface/channel     │
│   session_continuity · is_follow_up                 │
└─────────────────┬───────────────────────────────────┘
                  ▼
┌─────────────────────────────────────────────────────┐
│ 2. Router Core                                       │
│   ① execution contract routing                      │
│      direct / runner / spawn_single / spawn_multi   │
│   ② route class classification                      │
│      fast_chat / coding / research / reasoning /    │
│      long_context / control_observer / session_ctrl │
│   ③ protected lane hard guards (bypass judge)       │
│   ④ optional: tiny judge for ambiguous samples      │
└─────────────────┬───────────────────────────────────┘
                  ▼
┌─────────────────────────────────────────────────────┐
│ 3. Budget Planner                                    │
│   联合选择 (model_candidate, output_budget)          │
│   short / medium / long / deep                       │
│   reasoning_mode: normal / extended / minimal        │
│   "强模型短答" 与 "弱模型长答" 进同一目标函数         │
└─────────────────┬───────────────────────────────────┘
                  ▼
┌─────────────────────────────────────────────────────┐
│ 4. Policy / Gateway Adapter                          │
│   provider allowlist · health/cooldown               │
│   runner/queue health · quota/plan pressure          │
│   fallback chain · privacy/deployment policy        │
│   → final provider/model 落点                       │
└─────────────────┬───────────────────────────────────┘
                  ▼
┌─────────────────────────────────────────────────────┐
│ 5. Model-Intel / Feedback Loop                       │
│   price · capability profile · health/cooldown       │
│   openrouter_catalog 目录与价格主源                  │
│   replay outcome → nightly-eval → calibration gate  │
│   → route learning / policy update                  │
└─────────────────────────────────────────────────────┘
```

---

## 四、TypeScript 合同规范

### 4.1 核心类型定义

文件路径：`packages/octoclaw-policy/src/router/contracts.ts`

```typescript
/** 路由器输入信号 */
export interface RouterRequest {
  sessionKey: string;
  turnId: string;                          // 与 replay 中 turnId 对应
  message: string;
  contextTokens: number;                   // 当前上下文 token 估算
  channel: "slack" | "feishu" | "wechat" | "cli" | "unknown";
  surface: "dm" | "channel" | "group" | "cli" | "unknown";
  executionHints?: {
    isFollowUp?: boolean;                  // 是否是上一个 delegated task 的跟进
    stickyLane?: string;                   // 上一轮确定的 sticky lane
    language?: string;                     // 会话语言（影响 budget 和 handoff）
    hasAttachment?: boolean;               // 是否带附件/文件
    hasCodeBlock?: boolean;                // message 里是否含代码块
  };
}

/** 路由器推荐输出 */
export interface RouteRecommendation {
  // ── 执行合同（第一优先级）──
  executionContract: "direct" | "runner" | "spawn_single" | "spawn_multi";
  agentScope: "main_stable" | "delegated" | "explicit_override";

  // ── 语义分类 ──
  routeClass:
    | "fast_chat"        // 简单聊天/问答
    | "coding"           // 代码修改/生成/调试
    | "research"         // 研究型任务
    | "reasoning"        // 复杂推理/分析
    | "long_context"     // 长上下文摘要/处理
    | "control_observer" // status/details/timeline 类 observer query
    | "session_control"; // 修改主会话模型/配置

  // ── Lane-local 决策 ──
  workerPool?: string;          // 如 "octoclaw-code", "octoclaw-research"
  phase?: string;               // 如 "implement", "review", "research"
  protocol?: string;            // 如 "normal", "careful", "fast"
  profile?: string;             // 如 "code", "researcher", "analyst"
  skillBundle?: string[];       // 如 ["repo", "test"], ["web", "analyze"]

  // ── 模型与预算 ──
  candidateModels?: string[];   // 候选模型（按优先级排列）
  recommendedModel?: string;    // 推荐落点（可覆盖）
  outputBudget: "short" | "medium" | "long" | "deep";
  reasoningMode: "normal" | "extended" | "minimal";

  // ── 交付合同 ──
  reviewRequired: boolean;
  artifactFirst: boolean;
  handoffContract:
    | "direct_answer"
    | "runner_report"
    | "deliverable_handoff"
    | "team_evidence_handoff";

  // ── 可解释性 ──
  reasonCodes: string[];        // 如 ["task_type:coding", "tool_need:high"]
  judge: {
    kind: "rules" | "rules+tiny-judge" | "learned";
    confidence: number;          // 0-1，低于 0.6 时走 fallback
    ruleMatched?: string;        // 规则命中时记录规则名
  };
}

/** 路由结果（用于 replay / nightly-eval） */
export interface RouterOutcome {
  turnId: string;
  decisionId: string;
  at: string;                              // ISO 8601
  recommendation: RouteRecommendation;
  actualExecutionContract: string;         // live path 实际执行的 contract
  actualModel: string;
  costUsd?: number;
  latencyMs?: number;
  retries?: number;
  validationScore?: number;
  userCorrected?: boolean;
  shadowMode: boolean;                     // true 时表示 recommendation 未生效
}

/** 路由器公共接口 */
export interface RouterCore {
  /**
   * 提取信号并输出推荐。
   * 在 shadow mode 下只记录，不改变 live path。
   */
  recommend(request: RouterRequest): RouteRecommendation;

  /**
   * 记录 recommendation 的最终执行结果，用于 replay。
   * 必须在每次执行后调用，支持 feedback loop。
   */
  recordOutcome(outcome: RouterOutcome): void;
}
```

### 4.2 Signal 提取接口

文件路径：`packages/octoclaw-policy/src/router/signal.ts`

```typescript
import type { RouterRequest } from "./contracts.js";

/**
 * 从原始 message 和会话上下文中提取 RouterRequest 信号。
 * 只做信号提取，不做路由决策。
 */
export interface SignalExtractor {
  extract(raw: {
    sessionKey: string;
    turnId: string;
    message: string;
    contextTokens?: number;
    channel?: string;
    surface?: string;
    previousRoute?: string;
  }): RouterRequest;
}

/** 内置启发式提取器（V1 可解释规则版本） */
export function extractSignals(raw: Parameters<SignalExtractor["extract"]>[0]): RouterRequest;

/**
 * 估算 context token 数（简化版，不需要真实 tokenizer）。
 * 用于 budget 决策，允许误差 ±20%。
 */
export function estimateContextTokens(text: string): number;
```

### 4.3 执行合同路由器接口

文件路径：`packages/octoclaw-policy/src/router/contract-router.ts`

```typescript
import type { RouterRequest, RouteRecommendation } from "./contracts.js";

/**
 * Protected lane 硬规则。命中时直接返回，不走 judge。
 *
 * Protected lanes：
 *   control_observer  — status/details/timeline/provenance 查询
 *   session_control   — 修改当前主会话模型/配置
 *
 * 这两类样本不进 delegated optimization，也不混入业务训练集。
 */
export function matchProtectedLane(
  request: RouterRequest,
): Pick<RouteRecommendation, "executionContract" | "agentScope" | "routeClass"> | null;

/**
 * 执行合同路由（规则 first）。
 *
 * 决策顺序：
 *   1. Protected lanes（硬 bypass）
 *   2. 规则命中（短问答 → direct, 代码 → spawn_single, ...）
 *   3. 默认 → spawn_single
 */
export function routeExecutionContract(
  request: RouterRequest,
): Pick<RouteRecommendation, "executionContract" | "agentScope" | "routeClass" | "reasonCodes">;
```

---

## 五、实现切片（P5-A → P5-D）

### P5-A：recommendation contract 抽离（约 2 周）

**目标**：把现有 decision 逻辑收进独立 contract，建立可测试边界。还不改 live path。

**文件变更**：

| 动作 | 文件 | 说明 |
|------|------|------|
| NEW | `packages/octoclaw-policy/src/router/contracts.ts` | 上方 §4.1 合同定义 |
| NEW | `packages/octoclaw-policy/src/router/signal.ts` | 信号提取 §4.2 |
| NEW | `packages/octoclaw-policy/src/router/contract-router.ts` | 执行合同路由 §4.3 |
| NEW | `packages/octoclaw-policy/src/router/budget.ts` | Budget planner |
| NEW | `packages/octoclaw-policy/src/router/index.ts` | 公共 API re-export |
| NEW | `packages/octoclaw-policy/src/router/__tests__/` | 合同测试 + goldens |
| MODIFY | `packages/octoclaw-policy/package.json` | 添加 router 目录到 exports |

**完成标准**：
- `recommend(request)` 在已有 replay fixture 上与当前 decision 结果一致（≥ 90%）
- 所有 protected lanes 有 golden fixture，测试中 bypass 可验证
- TypeScript 编译 0 错误

---

### P5-B：Shadow mode 接线（约 2 周）

**目标**：在 `before_model_resolve` hook 接入 router，但默认只 log，不改 live path。

**文件变更**：

| 动作 | 文件 | 说明 |
|------|------|------|
| MODIFY | `extensions/octoclaw-runtime/src/extension-entry.ts` | 在 `before_model_resolve` 中调用 `recommend()`，写 replay event，不改返回值 |
| MODIFY | `extensions/octoclaw-runtime/src/replay/replay.ts` | 新增 `router_recommendation` 事件类型，含 `shadowMode: true` |
| MODIFY | `extensions/octoclaw-runtime/src/replay/replay-events.ts`（若存在）| 添加 event schema |
| NEW | `extensions/octoclaw-runtime/src/router/shadow-bridge.ts` | Shadow mode 桥接：request 组装 → recommend → replay 写入 |
| MODIFY | `tools/octoclawctl/src/nightly/` | nightly classifier 新增 `Router Quality` lane 统计 shadow vs actual 差异 |

**Shadow mode 开关**（在 `openclaw.json` 配置）：
```json
{
  "plugins": {
    "entries": {
      "octoclaw-runtime": {
        "config": {
          "autoRouter": {
            "shadowMode": true,       // 默认 true：只记录，不改 live path
            "enabled": true
          }
        }
      }
    }
  }
}
```

**Replay 事件格式**：
```jsonl
{
  "schema_version": "octoclaw.runtime_policy.replay_event/v1",
  "event": "router_recommendation",
  "at": "...",
  "turnId": "...",
  "decisionId": "...",
  "shadowMode": true,
  "recommendation": {
    "executionContract": "spawn_single",
    "routeClass": "coding",
    "outputBudget": "medium",
    "reasonCodes": ["has_code_block", "tool_need:high"],
    "judge": { "kind": "rules", "confidence": 0.91 }
  },
  "actualExecutionContract": "spawn_single",
  "diff": false
}
```

**完成标准**：
- Shadow mode 下 `octoclawctl nightly` 输出包含 `Router Quality` lane
- `router_recommendation` 事件在 replay log 中可追踪
- `diff: true` 率（推荐 ≠ 实际）有基线记录

---

### P5-C：Tiny Judge + Budget Planner（约 2 周）

**目标**：对规则不能覆盖的模糊样本，用 tiny judge 输出 route class + budget hint。

**设计约束**：
- Protected lanes 和规则已命中的 case **不走 judge**
- Judge 只输出 `routeClass + outputBudget + confidence`，不直接绑定 provider
- Judge 模型通过 `judge-fast.json` 配置（复用现有机制）
- Judge 超时（默认 2000ms）时回退到规则 fallback

**文件变更**：

| 动作 | 文件 | 说明 |
|------|------|------|
| NEW | `packages/octoclaw-policy/src/router/judge.ts` | Tiny judge 接口 + 调用封装 |
| MODIFY | `packages/octoclaw-policy/src/router/contract-router.ts` | 接入 judge（仅模糊样本） |
| MODIFY | `packages/octoclaw-policy/src/router/budget.ts` | 基于 judge 结果的 budget 决策 |
| MODIFY | `extensions/octoclaw-runtime/src/router/shadow-bridge.ts` | 接入 judge 并记录 judge 结果到 replay |

**Tiny judge 接口**：
```typescript
export interface TinyJudge {
  /**
   * 对模糊样本给出 route class 和 budget 推荐。
   * 超时（timeoutMs）时 resolve({ routeClass: null, confidence: 0 })。
   */
  classify(request: RouterRequest, timeoutMs?: number): Promise<{
    routeClass: RouteRecommendation["routeClass"] | null;
    outputBudget: RouteRecommendation["outputBudget"] | null;
    confidence: number;
    raw?: string;
  }>;
}

/** 工厂函数：从 judge-fast.json 配置构建 TinyJudge */
export function createTinyJudge(configPath?: string): TinyJudge;
```

**完成标准**：
- Judge 调用在 replay 中可见（`judge.kind: "rules+tiny-judge"`）
- Judge 超时不影响 live path（有 fallback）
- Budget planner 在 nightly 里输出 `cost/budget accuracy` 指标

---

### P5-D：Outcome 回流 + 推广（约 2 周）

**目标**：把 router recommendation 的结果接入 nightly-eval，建立质量 gate。

**文件变更**：

| 动作 | 文件 | 说明 |
|------|------|------|
| MODIFY | `extensions/octoclaw-runtime/src/router/shadow-bridge.ts` | 记录 `router_outcome` 事件（含 cost/latency 实测值） |
| MODIFY | `tools/octoclawctl/src/nightly/classifier.ts` | Router Quality lane：precision/recall/cost_delta/latency_delta |
| MODIFY | `tools/octoclawctl/src/nightly-eval/runner.ts` | 新增 `routerQuality` eval step |
| NEW | `tools/octoclawctl/src/calibration/router-gate.ts` | Router quality calibration gate |
| MODIFY | `tools/octoclawctl/src/cli.ts` | 新增 `router shadow-report` 命令 |

**Router Quality nightly lane 指标**：
```
Router Quality:
  precision        — 推荐 == 实际 的比例
  false_delegate   — 实际走 spawn_single 但推荐 direct 的案例
  false_direct     — 实际走 direct 但推荐 delegate 的案例
  cost_delta_usd   — 推荐 vs 实际 cost 差（负数 = 省钱）
  latency_delta_ms — 推荐 vs 实际 latency 差
  coverage         — 有 judge 输出的比例（太低说明规则覆盖太广）
```

**推广门槛（gated promotion）**：

| 条件 | 值 | 说明 |
|------|-----|------|
| precision | ≥ 0.85 | 推荐与实际一致率 |
| false_delegate rate | ≤ 0.05 | 误判 delegate 率 |
| cost_delta_usd | ≤ 0 | 推荐比实际省钱（或持平） |
| calibration gate | pass | 与上一个 baseline 对比不回退 |

满足上述条件后，可将 `shadowMode: false` 推送到 macmini，正式接管 delegated lanes。

---

## 六、数据流全图

```
request (message + session)
  ↓
shadow-bridge.ts
  ↓ extractSignals()
RouterRequest
  ↓ matchProtectedLane()
  ├──► protected: direct + control_observer/session_control → replay event → skip judge
  ↓ routeExecutionContract() [rules first]
  ├──► rule matched: confidence ≥ 0.9 → skip judge
  ↓ tinyJudge.classify() [only ambiguous]
  ↓ budgetPlanner()
RouteRecommendation
  ↓
  ├── shadowMode=true:  replay "router_recommendation" (diff vs live)
  └── shadowMode=false: override before_model_resolve response + replay "router_outcome"
  ↓
execution (live path unchanged in shadow mode)
  ↓
replay "router_outcome" { actualModel, costUsd, latencyMs }
  ↓
nightly-eval (Router Quality lane)
  ↓
calibration gate → promote → baseline 更新
```

---

## 七、与 Phase 2 反馈链路的集成点

Auto Router 不自建评估体系，完全复用 Phase 2 已有的七步链路：

| 步骤 | Phase 2 工具 | Phase 5 新增 |
|------|-------------|-------------|
| observe | `replay.ts` | 新增 `router_recommendation` / `router_outcome` 两类事件 |
| summarize | `octoclawctl nightly` | 新增 Router Quality 第 6 条 lane |
| review | `octoclawctl review` | shadow diff=true 的 case 作为 review 样本 |
| curate | `octoclawctl curate` | router misclassification 作为重要 fixture 来源 |
| validate | `octoclawctl nightly-eval run` | 新增 `routerQuality` eval step |
| promote | `octoclawctl nightly-eval promote` | Router quality gate pass 才允许 promote |
| learn | 内置于 promote | router outcome 版本演进即学习记录 |

---

## 八、受保护 Lane 清单与规则

以下 lane 必须 bypass delegated optimization，**不能**混入业务训练集：

```typescript
// packages/octoclaw-policy/src/router/protected-lanes.ts

/**
 * 触发 control_observer 的关键词模式（不区分大小写）。
 * 命中时：executionContract = "direct", agentScope = "main_stable"
 */
export const CONTROL_OBSERVER_PATTERNS = [
  /\b(status|状态|进度|state)\b/i,
  /\b(details|详情|detail|详细)\b/i,
  /\b(timeline|时间线|历史)\b/i,
  /\b(当前.*模型|用的什么模型|什么模型在跑)\b/i,
  /\b(provenance|来源|是谁做的|子任务|dispatch了吗)\b/i,
  /\b(octoclaw_status|octoclaw_details)\b/i,
];

/**
 * 触发 session_control 的关键词模式。
 * 命中时：executionContract = "direct", agentScope = "main_stable"
 */
export const SESSION_CONTROL_PATTERNS = [
  /\b(切换.*模型|换成|switch.*model|use.*model)\b/i,
  /\b(session.*control|会话.*配置)\b/i,
];
```

---

## 九、Golden Fixture 要求

在 P5-A 完成时，必须建立以下 golden 集：

| 类别 | 样本数 | 来源 |
|------|--------|------|
| control_observer bypass | ≥ 5 | 从 nightly replay 中用 `octoclawctl curate` 导出 |
| session_control bypass | ≥ 3 | 手工构造 |
| coding → spawn_single | ≥ 5 | 从 replay 导出 |
| research → spawn_single | ≥ 5 | 从 replay 导出 |
| fast_chat → direct | ≥ 5 | 从 replay 导出 |
| ambiguous → tiny judge | ≥ 3 | 从 review 失败样本构造 |

Golden 文件位置：`extensions/octoclaw-runtime/src/router/__fixtures__/`

格式与 `octoclawctl curate` 输出的 JSONL 格式完全兼容，每条加 `"fixture": true` 标记。

---

## 十、不该做的事（补充 Phase 5 专项）

1. **不要在 shadow 期未满 7 天就推 live**（至少跑完 1 个完整 nightly 周期）
2. **不要把 control_observer 样本混进 route 训练**（会让模型学出"status 查询也要 spawn"的错误路径）
3. **不要让 judge 超时影响 live path**（always fallback to rules，不 block）
4. **不要把 recommendation 和 resolution 混在同一函数**（`recommend()` 不感知 gateway 细节）
5. **不要跳过 calibration gate 直接改 live config**（每次修改都要有 baseline 对比）

---

## 附：实现检查清单

### P5-A 完成标准

- [ ] `packages/octoclaw-policy/src/router/` 目录创建，包含 contracts/signal/contract-router/budget/index
- [ ] `recommend()` 函数在已有 replay fixture 上与当前 decision 一致率 ≥ 90%
- [ ] Protected lanes golden fixtures 可通过测试
- [ ] TypeScript 编译 0 错误，pnpm test 无新失败

### P5-B 完成标准

- [ ] `shadow-bridge.ts` 接线 `before_model_resolve`（shadow mode 默认开）
- [ ] `router_recommendation` 事件在 replay log 中可见
- [ ] `octoclawctl nightly` 输出包含 `Router Quality` lane（precision/coverage/diff_rate）
- [ ] macmini 7 天 shadow 数据可查，diff_rate < 20%（太高说明规则有问题）

### P5-C 完成标准

- [ ] TinyJudge 接口实现，超时 fallback 测试通过
- [ ] judge 调用在 replay 中有 `judge.kind: "rules+tiny-judge"` 标记
- [ ] budget_delta 指标在 nightly 中可查

### P5-D 完成标准

- [ ] `router_outcome` 事件带 cost/latency 实测值
- [ ] nightly-eval 包含 `routerQuality` step（pass/fail/unknown）
- [ ] precision ≥ 0.85、false_delegate ≤ 0.05 连续 7 天 pass
- [ ] `shadowMode: false` 在满足门槛后才推送，通过 `octoclawctl nightly-eval promote`

---

*文档路径：`docs/octoclaw-phase5-auto-router-design-2026-04-30.md`*  
*代码基线：`refactor/0.4.0-stable`，日期：2026-04-30*
