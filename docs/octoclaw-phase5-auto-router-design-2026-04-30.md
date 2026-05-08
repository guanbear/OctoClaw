# OctoClaw Phase 5：Auto Router 加固 — 详细设计

> 文档路径：`docs/octoclaw-phase5-auto-router-design-2026-04-30.md`  
> 代码基线：`refactor/0.4.0-stable`（Phase 0-4 全部完成）  
> 前置参考：[`octoclaw-auto-router-design.md`](octoclaw-auto-router-design.md)（战略底稿，保留不删）  
> 日期：2026-04-30
> N0 更新：`packages/octoclaw-runtime-core` 已并入 runtime extension；长期 router core 的建议落点曾为 `packages/octoclaw-policy/src/router/*`。2026-05-08 后 Phase 5 Lite 的建议落点改为 `packages/octoclaw-policy/src/router-lite/*`，本文中的 `direct / runner / spawn_single / spawn_multi` 仅保留为长期 execution contract / lane 术语，不是 live route authority；live route 仍为 `reply | delegate`。
> 2026-05-08 更新：性能线不再是近期主阻塞；warm pool / resident runner 不进入 Phase 5 前置条件。Auto Router 下一步只做 shadow-first 推荐和评估，不直接改 live route。
> 简化执行稿：[`octoclaw-auto-router-lite-cost-model-design-2026-05-08.md`](./octoclaw-auto-router-lite-cost-model-design-2026-05-08.md)

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

长期形态里，Auto Router 的第一职责曾被定义为决定 execution contract，不是只选模型。2026-05-08 收窄后，Phase 5 Lite **不再接管 execution contract**：live route authority 仍是 `reply | delegate`，Lite 只在现有 route 之后推荐模型、预算和配置缺口。

2026-05-08 后的近期定位更窄：

- **要做**：把当前 runtime/judge/rule 已经做出的决策，转成可解释、可 replay、可对比的 shadow recommendation。
- **先不做**：直接覆盖 live route、引入 resident runner、做 learned router hot path、扩大 judge 输出字段。
- **第一收益**：减少路由策略继续散落在 runtime 分支里的复杂度，让 false delegate / false reply / cost / latency 能被 nightly 稳定度量。
- **不是第一收益**：继续追求子 agent 启动减少几十秒；这条性能线现在降级为观测和上游跟踪。

---

## 二、设计目标与永不做的边界

### 2.1 目标

1. **可解释性优先**：每个 route 决策必须有 `reasonCodes`，人工 review 可追踪
2. **shadow 先行**：上线前先 shadow 模式记录 `old vs recommended`，不直接接管 live path
3. **只优化 delegated 模型选择**：近期不接管 `runner / spawn_single / spawn_multi` execution contract，只在 `liveRoute=delegate` 后推荐模型和预算；`direct` 主 agent 默认稳定
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

这张五层图保留为长期方向。Phase 5 Lite 只实现其中的 Model-Intel、Budget Planner 和 shadow feedback 子集，不实现新的 execution contract router。

---

## 三点五、Auto Router Lite：模型智能与按需选模（2026-05-08）

这一节替代早期“完整 router / warm pool / learned policy”设想，专门回答近期要不要做 Auto Router、怎么做才不重的问题。

结论：

> **保留现有 judge 做 `route + confidence + complexity + complexity_confidence`，Auto Router Lite 只在 judge 之后做模型/预算推荐。它不重判任务、不扩张 judge schema、不自动改 OpenClaw 配置，先 shadow 记录，等 replay 证明省钱且不降质后再局部启用。**

### 3.5.1 Judge 与 Auto Router 的分工

当前 judge 已经足够承担语义判断，不能再退回旧设计里让它输出 `role / workType / scope / tool_need_hint / duration_hint / reason_codes` 这类胖字段。

分工如下：

| 层 | 输入 | 输出 | 不做 |
|----|------|------|------|
| judge | 用户请求 + compact runtime context | `route`、`confidence`、`complexity`、`complexity_confidence` | 不猜模型价格，不决定 provider，不输出 role/hint 胖字段 |
| Auto Router Lite | judge 四字段 + runtime signals + model-intel snapshot | `recommendedModel`、`outputBudget`、`fallbackChain`、`reasonCodes` | 不覆盖 live route，不启动 worker，不改配置 |
| OpenClaw runtime | 最终配置、provider 状态、原生 fallback | 实际调用模型和执行结果 | 不承担 OctoClaw 的业务 replay 解释 |

所以 Auto Router 不是 judge 的替代品，而是 judge 后面的**模型选择器和成本约束器**。

### 3.5.2 先回答几个边界问题

1. **OpenClaw 有没有价格能力？**
   有。OpenClaw 5.4 已有 `models.providers.*.models[].cost`、Gateway pricing cache、OpenRouter/LiteLLM 价格抓取、`resolveModelCostConfig()` 和 `estimateUsageCost()`。OctoClaw 不需要再造市场价格抓取。

2. **OpenClaw 有没有完整套餐/剩余额度能力？**
   没有统一事实面。OpenClaw 有 provider usage、auth profile usage/cooldown、部分 provider usage probe，但跨 provider 的套餐剩余额度并不稳定。OctoClaw 只能把它当 `quotaPressure` 信号，不能假设“套餐内一定免费”。

3. **模型能力怎么知道？靠榜单吗？**
   不靠榜单。能力来源优先级是：OpenClaw/provider catalog metadata、本地 replay/eval 成功率、operator override、models.dev/OpenRouter 等外部 registry。榜单最多只做 cold-start 参考。

4. **能不能启动后自动把 mini/便宜模型加进 OpenClaw 配置？**
   不建议静默修改。可以生成 config proposal，让用户显式确认；默认只进入 shadow allowlist。原因是 auth、baseUrl、地域、隐私和计费方式都可能不同。

5. **OmniRoute 能借什么？**
   OmniRoute 最新 `main@08e1886` 是完整网关，不能照搬。可借三点：外部 pricing/capability sync 是 opt-in 且不覆盖用户配置；quota unknown 不阻塞但会降权；先 capability filter，再按 cost/health 排序。

### 3.5.3 最小数据模型

不要先建大 facts plane。第一版只需要一个可落盘、可 replay 的 `model-intel-snapshot`：

| 字段 | 说明 |
|------|------|
| `provider` / `model` | 标识候选模型 |
| `configured` | 是否已经在 OpenClaw live config 中可用 |
| `marketPrice` | 输入/输出/cache 价格，来源优先用 OpenClaw pricing cache/config |
| `capability` | `contextWindow`、`toolUse`、`structuredOutput`、`reasoning`、`vision`、`codingTier` |
| `health` | cooldown、近期失败、p50/p95 延迟 |
| `quotaPressure` | `low / medium / high / unknown`，只表达压力，不假装精确额度 |
| `source` | `openclaw_config / pricing_cache / provider_catalog / models_dev / operator_override / runtime_observation` |

这不是 live state authority，只是推荐时的事实快照。每条 shadow recommendation 记录 `snapshotId`，后面才能解释“当时为什么推荐这个模型”。

### 3.5.4 决策算法

第一版算法保持可解释，不做 learned router：

```text
judge result + runtime signals
  -> derive task requirement
     - qualityFloor: mini | standard | strong | frontier
     - needsTools / needsReasoning / minContext / latencyClass
  -> candidate set
     - default: only configured models
     - optional: shadow-only proposed models
  -> hard filter
     - capability below floor
     - context too small
     - known unavailable / cooldown / quota high
  -> ranking
     - prefer plan/quota-low models if capability passes
     - otherwise choose cheapest healthy model above quality floor
     - tie-break by local replay success and latency
  -> output
     - recommendation only, with reasonCodes
```

保守规则：

- `confidence` 低或 `complexity_confidence` 低时，默认维持当前模型，只记录 shadow diff。
- `quotaPressure=unknown` 不能当作免费，只能轻微加权。
- `configured=false` 的模型不能进入 live，只能出现在 proposal 或 shadow。
- 主 agent 模型默认不自动切。近期收益主要来自 delegated lane 和预算控制。

### 3.5.5 配置分析，而不是静默补配置

如果用户只配置了强模型，例如 `gpt-5.5`，OctoClaw 可以给出 proposal：

```text
configured:
  openai/gpt-5.5

missing low-cost lanes:
  - same-provider mini/standard coding model
  - subscription-backed coding model
  - cheap long-context summarizer

proposal:
  add candidates to shadow allowlist
  run smoke/eval
  only then enable live for selected delegated lanes
```

落地命令可以很少：

- `octoclawctl router model-intel refresh`：生成事实快照。
- `octoclawctl router model-config analyze`：生成候选模型与配置提案。
- `octoclawctl router shadow-report`：展示推荐模型、实际模型、估算成本差、质量 gate。

不需要第一版就做 `apply`。配置写入可以等 proposal 和 shadow 都稳定后再做。

### 3.5.6 套餐/额度处理

套餐和市场价格必须分开：

- `marketPrice`：公开 token 价格，OpenClaw 已能提供大部分。
- `effectiveCostBand`：本地真实边际成本，只能在有 plan 配置、usage probe 或可靠 runtime observation 时给出。
- `quotaPressure`：额度压力，未知就是 `unknown`。

最小策略：

- 有可靠套餐/usage 信号且 `quotaPressure=low|medium`：同等能力下优先套餐模型。
- 只有手动 plan 标记但没有余额数据：轻微优先，不强制。
- 只有 429/rate limit/cooldown：标记 `high` 或 unavailable，短期避开。
- 没有任何额度信息：按 market price 和健康度排序。

OmniRoute 的 quota fetcher 可以作为 provider adapter 写法参考，但 OctoClaw 不应把 provider-specific quota API 变成 Phase 5 前置条件。

### 3.5.7 实施顺序

1. **P5-Lite-A：model-intel snapshot**
   - 读 OpenClaw config、pricing cache、provider catalog、auth profile usage/cooldown。
   - 产出 snapshot，不接 live router。
2. **P5-Lite-B：config analyze proposal**
   - 找出“只配强模型、缺低成本候选”的配置缺口。
   - 输出 proposal，不自动修改配置。
3. **P5-Lite-C：shadow recommendation**
   - 在 replay/Slack turn 中记录 `actualModel` vs `recommendedModel`。
   - 记录成本差、能力 gate、忽略原因。
4. **P5-Lite-D：小范围 live**
   - 只在连续 nightly 证明质量不降、成本下降后启用。
   - 首批只覆盖低风险 delegated lane，不碰主 agent 自动切模。

这条路线的目标不是做一个新的 OmniRoute，而是让 OctoClaw 用现有 judge 和 OpenClaw 原生 pricing/fallback 能力，补上“按能力、成本、额度选模型”的最小闭环。

---

## 四、TypeScript 合同规范（Lite 版）

早期草案里的 `executionContract / agentScope / workerPool / skillBundle / handoffContract` 等字段过重，容易把 Auto Router 重新做成完整调度器。Phase 5 Lite 只保留模型推荐所需合同。

### 4.1 核心类型定义

文件路径：`packages/octoclaw-policy/src/router-lite/contracts.ts`

```typescript
export interface RouterLiteRequest {
  sessionKey: string;
  turnId: string;
  liveRoute: "reply" | "delegate";
  liveModel?: string;
  judge: {
    route: "reply" | "delegate";
    confidence: number;
    complexity: "simple" | "normal" | "complex" | "deep";
    complexityConfidence: number;
  };
  runtime: {
    channel?: "slack" | "feishu" | "wechat" | "cli" | "unknown";
    contextTokens?: number;
    needsTools?: boolean;
    needsReasoning?: boolean;
    minContextTokens?: number;
    statusOrProvenanceRequest?: boolean;
    sessionControlRequest?: boolean;
  };
  snapshotId: string;
}

export interface ModelIntelLite {
  provider: string;
  model: string;
  configured: boolean;
  marketPrice?: {
    inputUsdPerMTok?: number;
    outputUsdPerMTok?: number;
    cacheReadUsdPerMTok?: number;
    cacheWriteUsdPerMTok?: number;
  };
  capability: {
    contextWindow?: number;
    toolUse?: boolean;
    structuredOutput?: boolean;
    reasoning?: boolean;
    vision?: boolean;
    codingTier?: "mini" | "standard" | "strong" | "frontier" | "unknown";
  };
  health: {
    available: "yes" | "no" | "unknown";
    cooldown: boolean;
    quotaPressure: "low" | "medium" | "high" | "unknown";
    p95LatencyMs?: number;
  };
  source: string[];
}

export interface RouterLiteRecommendation {
  recommendedModel?: string;
  outputBudget: "short" | "medium" | "long" | "deep";
  qualityFloor: "mini" | "standard" | "strong" | "frontier";
  eligibleModels: string[];
  rejectedModels: Array<{ model: string; reason: string }>;
  reasonCodes: string[];
  mode: "shadow" | "live";
  ignoredReason?: "low_confidence" | "no_eligible_model" | "live_route_not_supported" | "not_configured";
}

export interface RouterLiteShadowEvent {
  turnId: string;
  snapshotId: string;
  liveRoute: "reply" | "delegate";
  actualModel?: string;
  recommendation: RouterLiteRecommendation;
  estimatedCostDeltaUsd?: number;
  qualityGate: "unknown" | "pass" | "fail";
}
```

### 4.2 公共接口

文件路径：`packages/octoclaw-policy/src/router-lite/index.ts`

```typescript
export interface RouterLite {
  recommend(
    request: RouterLiteRequest,
    models: ModelIntelLite[],
  ): RouterLiteRecommendation;
}
```

实现要求：

- `RouterLiteRequest` 不读取完整 transcript，只消费 judge 四字段和 runtime compact signals。
- `recommend()` 是纯函数，不调用 OpenClaw runtime、不写 state、不发消息。
- `configured=false` 模型默认只能产生 shadow/proposal，不能进入 live recommendation。
- protected lane 只读结构化信号，例如 `statusOrProvenanceRequest` 和 `sessionControlRequest`；不要新增关键词墙。

### 4.3 Snapshot 与 Shadow Event

文件路径建议：

| artifact | 说明 |
|----------|------|
| `router-lite/model-intel-snapshot.json` | 当前可选模型、价格、能力、健康、quota pressure |
| `router-lite/config-proposal.json` | 未配置低成本候选的建议，不自动 apply |
| `router-lite/shadow-events.jsonl` | 每次推荐和实际模型的差异 |

`shadow-events.jsonl` 是 Phase 5 Lite 的核心交付物。没有连续 replay/nightly 证明，不允许把推荐接进 live。

---

## 五、实现切片（Lite）

### P5-Lite-A：Model-Intel Snapshot

目标：先把 OpenClaw 已有事实收出来，不做路由接管。

| 动作 | 文件/模块 | 说明 |
|------|-----------|------|
| NEW | `packages/octoclaw-policy/src/router-lite/model-intel.ts` | 汇总 OpenClaw config、pricing cache、provider catalog、auth profile usage/cooldown |
| NEW | `packages/octoclaw-policy/src/router-lite/contracts.ts` | 使用 §4 Lite 合同 |
| NEW | `packages/octoclaw-policy/src/router-lite/__tests__/model-intel.test.ts` | 覆盖 configured / price / capability / quotaPressure |
| NEW/MODIFY | `tools/octoclawctl` | 增加 `router model-intel refresh` 或等价内部命令 |

完成标准：

- 能生成 `model-intel-snapshot.json`。
- snapshot 中每个价格/能力/健康字段都有 `source`。
- 无法确认的套餐额度必须是 `quotaPressure=unknown`，不能写成 free。

### P5-Lite-B：Config Analyze Proposal

目标：发现“只配强模型、缺低成本候选”的配置缺口，但不自动修改 live config。

| 动作 | 文件/模块 | 说明 |
|------|-----------|------|
| NEW | `packages/octoclaw-policy/src/router-lite/config-analyze.ts` | 基于 snapshot 生成 proposal |
| NEW | `packages/octoclaw-policy/src/router-lite/__tests__/config-analyze.test.ts` | 覆盖只配强模型、缺同 provider mini、缺订阅候选 |
| NEW/MODIFY | `tools/octoclawctl` | 增加 `router model-config analyze` |

完成标准：

- 只输出 proposal，不写 OpenClaw config。
- `configured=false` 候选只能标记 shadow/proposal。
- proposal 解释为什么建议加、需要什么 auth/profile、风险是什么。

### P5-Lite-C：Shadow Recommendation

目标：让 Auto Router Lite 推荐模型和预算，但默认只记录，不改变实际模型。

| 动作 | 文件/模块 | 说明 |
|------|-----------|------|
| NEW | `packages/octoclaw-policy/src/router-lite/recommend.ts` | 纯函数推荐器 |
| NEW | `extensions/octoclaw-runtime/src/router-lite/shadow-bridge.ts` | 组装 Lite request，写 shadow event |
| MODIFY | runtime replay/telemetry 模块 | 记录 `router_lite_recommendation` |
| NEW/MODIFY | `tools/octoclawctl` | 增加 `router shadow-report` |

Shadow event 最小字段：

```json
{
  "event": "router_lite_recommendation",
  "turnId": "...",
  "snapshotId": "...",
  "liveRoute": "delegate",
  "actualModel": "openai/gpt-5.5",
  "recommendedModel": "openai/gpt-5.x-mini",
  "outputBudget": "medium",
  "mode": "shadow",
  "reasonCodes": ["quality_floor:standard", "cheaper_same_provider"],
  "ignoredReason": "not_configured"
}
```

完成标准：

- Shadow mode 默认开，不覆盖 live model。
- 每条推荐都能解释 eligible/rejected 模型。
- `confidence` 或 `complexity_confidence` 低时只记录 `ignoredReason=low_confidence`。

### P5-Lite-D：Gated Live

目标：只在有证据后，小范围启用模型/预算推荐。

首批 live 范围：

- 只覆盖 `liveRoute=delegate`。
- 只允许 `configured=true` 模型。
- 不自动切主 agent 模型。
- 不处理 `status/provenance/session_control` 请求。

推广门槛：

| 条件 | 门槛 |
|------|------|
| shadow 样本数 | ≥ 100 或至少 7 天数据 |
| quality gate | pass 或人工抽查无明显降质 |
| cost delta | 推荐方案估算成本下降或持平 |
| fallback/error | 不高于当前 live baseline |
| rollback | 一个 config flag 可立即回 shadow |

## 六、数据流全图（Lite）

```text
OpenClaw config / pricing cache / provider catalog / auth usage
  -> model-intel snapshot

user turn
  -> existing judge: route/confidence/complexity/complexity_confidence
  -> runtime compact signals
  -> RouterLiteRequest + snapshot
  -> recommend()
  -> shadow event: actualModel vs recommendedModel
  -> nightly/replay report
  -> gated live only after evidence
```

## 七、与 Phase 2 反馈链路的集成点

Auto Router Lite 不自建评估体系，只给现有 replay/nightly 增加一个轻量 lane：

| 指标 | 用途 |
|------|------|
| `recommendation_coverage` | 有多少 turn 能给出推荐 |
| `ignored_reason_count` | 为什么没有推荐或没有启用 |
| `estimated_cost_delta` | 推荐模型相对实际模型的估算成本差 |
| `quality_gate` | replay/eval/人工抽查是否降质 |
| `configured_gap_count` | 有多少推荐卡在未配置候选 |
| `quota_unknown_count` | 有多少推荐受额度未知影响 |

## 八、受保护请求规则

受保护请求不进入模型省钱优化：

- status/provenance：问进度、来源、是否派发、哪个模型跑的。
- session control：切模型、改配置、改变当前会话行为。
- low-confidence judge：judge 置信度不足时，不做 live 推荐。

实现要求：

- 优先消费结构化信号：`statusOrProvenanceRequest`、`sessionControlRequest`、recent execution coverage。
- 不新增中文/英文关键词墙。自然语言样本只用于 fixture 和回归。
- 这些请求可以记录 shadow event，但 `ignoredReason` 必须明确，不允许静默改模型。

## 九、Golden Fixture 要求

第一批只需要覆盖模型推荐，不覆盖完整执行合同：

| 类别 | 样本数 | 断言 |
|------|--------|------|
| simple reply | ≥ 5 | 低复杂度，不推荐强制切 delegated 模型 |
| normal delegate coding | ≥ 5 | 能推荐 standard/strong coding 候选 |
| deep delegate | ≥ 3 | qualityFloor 至少 strong |
| status/provenance | ≥ 5 | ignoredReason 明确，不 live 推荐 |
| session control | ≥ 3 | ignoredReason 明确，不 live 推荐 |
| quota high/cooldown | ≥ 3 | 候选被拒绝并解释原因 |

## 十、不该做的事（Lite 专项）

1. 不要恢复胖 judge schema。
2. 不要启动时静默改 OpenClaw config。
3. 不要把 `configured=false` 模型放进 live。
4. 不要把未知套餐额度当免费额度。
5. 不要做新 learned router 或 tiny judge；现有 judge 已经够用。
6. 不要为了 protected lane 增加关键词 guard。
7. 不要把 OmniRoute 当上游依赖；只借鉴它的 opt-in sync、quota stale handling 和 cost-first strategy。

---

## 附：实现检查清单

### P5-0 当前切入点（2026-05-08）

- [ ] 新增 `openspec/changes/auto-router-lite-0.5.x/` 或等价 implementation packet，明确 P5-Lite-A/B/C 的 acceptance gate。
- [ ] 从现有 replay/fixtures 中抽取最小 golden 集：simple reply、normal delegate coding、deep delegate、status_or_provenance、session_control、quota/cooldown。
- [ ] 明确 `RouterLiteRequest` 不读取原始 transcript 全量，只读取 judge 四字段和 runtime compact signals。
- [ ] 明确 judge 简化后的四字段只作为 signal 来源之一；router 不要求 judge 输出 role/workType/scope/tool hints。
- [ ] 明确 protected lane 规则不能靠新增中文/英文关键词堆叠解决，必须由 execution coverage / request_kind / session control 等结构化信号优先。

### P5-Lite-A 完成标准

- [ ] `packages/octoclaw-policy/src/router-lite/` 目录创建，包含 `contracts.ts`、`model-intel.ts`、`index.ts`
- [ ] 能生成 `model-intel-snapshot.json`
- [ ] snapshot 每个价格/能力/健康字段都有 source
- [ ] TypeScript 编译 0 错误，pnpm test 无新失败
- [ ] 未知套餐额度保持 `quotaPressure=unknown`

### P5-Lite-B 完成标准

- [ ] `config-analyze.ts` 能生成配置缺口 proposal
- [ ] proposal 不自动写 OpenClaw config
- [ ] `configured=false` 候选只能进入 shadow/proposal
- [ ] proposal 解释 auth/profile/risk

### P5-Lite-C 完成标准

- [ ] `recommend()` 是纯函数，不调用 runtime、不写 state、不发消息
- [ ] `router_lite_recommendation` shadow event 在 replay log 中可见
- [ ] shadow event 能同时记录 actualModel、recommendedModel、eligible/rejected、ignoredReason
- [ ] `octoclawctl router shadow-report` 或 nightly report 能展示 cost delta / quality gate / configured gap

### P5-Lite-D 完成标准

- [ ] 只对 `liveRoute=delegate` 且 `configured=true` 候选开放 live
- [ ] 不自动切主 agent 模型
- [ ] 至少 7 天或 ≥ 100 条 shadow 样本通过 quality/cost gate
- [ ] 有一键回 shadow 的配置开关

---

*文档路径：`docs/octoclaw-phase5-auto-router-design-2026-04-30.md`*  
*代码基线：`refactor/0.4.0-stable`，日期：2026-04-30*
