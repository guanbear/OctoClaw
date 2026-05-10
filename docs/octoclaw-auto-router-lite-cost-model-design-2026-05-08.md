# OctoClaw Auto Router Lite：成本导向选模执行稿

> 日期：2026-05-08
> 关联长文档：[`octoclaw-phase5-auto-router-design-2026-04-30.md`](./octoclaw-phase5-auto-router-design-2026-04-30.md)
> 目标：用最少实现解决模型能力、价格、套餐额度、同供应商候选发现、自动分析任务、是否委派、委派后选模。

---

## 1. 结论

Auto Router Lite 第一版只做“成本导向的委派和选模建议”，不做新的总控 router。

保留现有 judge 四字段：

```text
route, confidence, complexity, complexity_confidence
```

Auto Router Lite 接在 judge 后面：

```text
judge result
  -> model intel snapshot
  -> delegate cost decision
  -> model selector
  -> shadow event
  -> gated live
```

第一版不做：

- 不恢复 `role / workType / scope / tool_need_hint / duration_hint`。
- 不靠关键词拦截。
- 不自动改 OpenClaw 配置。
- 不把未配置模型放进 live。
- 不在用户请求热路径拉远端价格或 catalog。

---

## 2. 最小交付物

| 交付物 | 文件/命令 | 作用 |
|--------|-----------|------|
| 模型事实快照 | `model-intel-snapshot.json` | 记录能力、价格、套餐、速度、稳定性 |
| 配置建议 | `model-config-proposal.json` | 发现同供应商便宜候选，但不自动写配置 |
| shadow 事件 | `router-lite-shadow.jsonl` | 记录实际模型 vs 推荐模型、成本差、忽略原因 |
| 选模模式 | `cost_first / balanced / reliable_fast` | 不同成本/稳定/速度取舍 |
| live gate | 配置开关 + nightly 指标 | 有证据后才小范围启用 |

---

## 3. Model Intel Schema

第一版只需要这些字段：

```typescript
interface ModelIntelEntry {
  provider: string;
  model: string;
  configured: boolean;
  discovered: boolean;
  sameProviderAs?: string;

  capability: {
    contextWindow?: number;
    toolUse: "yes" | "no" | "unknown";
    structuredOutput: "yes" | "no" | "unknown";
    reasoning: "yes" | "no" | "unknown";
    vision: "yes" | "no" | "unknown";
    codingTier: "mini" | "standard" | "strong" | "frontier" | "unknown";
    source: string[];
  };

  price: {
    inputUsdPerMTok?: number;
    outputUsdPerMTok?: number;
    cacheReadUsdPerMTok?: number;
    cacheWriteUsdPerMTok?: number;
    confidence: "high" | "medium" | "low" | "unknown";
    source: string[];
  };

  plan: {
    type: "pay_as_you_go" | "subscription" | "free_quota" | "unknown";
    quotaPressure: "low" | "medium" | "high" | "unknown";
    effectiveCostBand: "free_or_sunk" | "cheap" | "normal" | "expensive" | "unknown";
    source: string[];
  };

  runtime: {
    available: "yes" | "no" | "unknown";
    cooldown: boolean;
    recentFailureRate?: number;
    p50LatencyMs?: number;
    p95LatencyMs?: number;
    lastSeenAt?: string;
  };
}
```

硬规则：

- `configured=false` 只能用于 proposal/shadow，不能 live。
- `quotaPressure=unknown` 不能当免费。
- `source=[]` 的价格/能力/套餐字段不能作为 hard decision。
- `cooldown=true` 或 `available=no` 默认剔除。

---

## 4. 模型能力来源

按优先级合并：

1. OpenClaw provider catalog：context、tool、structured output、vision、reasoning 等硬能力。
2. OpenClaw config：用户显式配置的模型、profile、baseUrl、cost。
3. 外部榜单/API：PinchBench、Artificial Analysis、Aider、LiveCodeBench、SWE-bench、BFCL、LMArena/LiveBench、中文榜单，提供场景能力先验。
4. 本地 replay/nightly：成功率、返工率、工具调用失败、超时、速度、用户纠正。
5. 外部 registry：OpenRouter、LiteLLM、models.dev，补价格、上下文、supported parameters 和同供应商候选。
6. 人工 override：用户明确声明某模型适合/不适合某类任务。

不要用单个榜单直接决定 live。榜单只适合 cold-start 场景分和 shadow/proposal；live 仍要看本地 replay/nightly 和配置。

能力必须分场景，但场景不能过细。固定一个“综合模型分”只能作为兜底，不适合作为主要选模依据。OctoClaw 的任务分布不是通用聊天榜单，也不是纯算法题榜单，至少要区分：

| OctoClaw 场景分 | 代表任务 | 主要证据 |
|-----------------|----------|----------|
| `coding_worker` | 改代码、修测试、生成脚本、repo 内多文件修改 | PinchBench coding、Aider、SWE-bench、LiveCodeBench、本地 coding replay |
| `agentic_tool_task` | 多工具、多步骤、文件/集成/记忆/状态操作 | PinchBench overall、skills、integrations、memory、BFCL、本地 tool failure |
| `research_lookup` | 查资料、读网页、整理事实、轻量研究 | PinchBench research、Artificial Analysis general、LiveBench、本地 web/tool 成功率 |
| `data_log_analysis` | CSV、日志、表格、报表、异常分析 | PinchBench csv/log/analysis、本地数据任务 replay |
| `main_reasoning` | 主 agent 设计判断、复杂权衡、失败兜底 | Artificial Analysis reasoning、LiveBench/LMArena、PinchBench analysis、本地纠错率 |

选模型时先由 judge/runtime signals 把任务映射到场景，再用对应场景分排序。没有明确场景时使用 `default_delegate_score`，它也必须由上面几个场景分加权得来，而不是一个外部榜单总分。

---

## 4.1 OpenRouter / 榜单 / OmniRoute 怎么借鉴

结论：要借鉴，但只做“先验”和“候选发现”，不能直接做 live hard decision。

### OpenRouter

可用信息：

- `/api/v1/models`：模型列表、`context_length`、`pricing`、`top_provider`、`supported_parameters`。
- rankings / programming collection：基于 OpenRouter 使用数据的热度/使用排名。

怎么用：

| OpenRouter 信息 | 写入字段 | 用法 |
|-----------------|----------|------|
| `context_length` | `capability.contextWindow` | 作为能力先验，后续用本地运行修正 |
| `supported_parameters` | `toolUse / structuredOutput / reasoning` 的候选证据 | 只做正向线索，不做唯一证据 |
| `pricing` | `price.marketPrice` | 可直接参与成本估算，但要记录 source |
| `top_provider` | `runtime/provider hint` | 作为 provider 可用性线索 |
| rankings / collection | `codingTier` 初始值、候选排序 | 只用于 cold-start，不能直接 live |

限制：

- OpenRouter ranking 更像“使用热度 + 生态反馈”，不是 OctoClaw 自己任务的成功率。
- 同一个模型在不同 provider endpoint 上可能价格、上下文、参数支持、稳定性不同。
- OpenRouter 的 `supported_parameters` 可能是聚合信息，不能替代真实 smoke/eval。

因此 OpenRouter 可以帮我们“发现候选”和“填初始 metadata”，但最终 live 选模仍要看本地 replay/eval、速度、失败率和 quota pressure。

### 外部榜单

可以借鉴：

- PinchBench：OpenClaw agent 实战，适合 `agentic_tool_task` 和 OctoClaw delegated worker 先验。
- Aider / SWE-bench：更贴近 repo edit、debug、patch review，适合 `coding_worker`。
- LiveCodeBench / SciCode / CritPt：更偏代码生成和算法，不能单独代表 repo 修改能力。
- BFCL：function/tool calling，适合 `agentic_tool_task` 的 hard/soft evidence。
- Artificial Analysis：通用 intelligence/coding/speed/price 索引，适合能力和价格的跨源参考。
- LMArena / LiveBench：偏通用偏好和复杂任务，适合 `main_reasoning` 辅助。
- OpenCompass / SuperCLUE / C-Eval / CMMLU：中文能力辅助，不直接替代 coding/agent 能力。

使用方式：

```text
external leaderboard
  -> cold-start quality prior
  -> codingTier 初始值
  -> proposal 排序
  -> shadow allowlist
```

不能这样用：

```text
leaderboard rank high
  -> 直接 live
```

原因：榜单任务和 OctoClaw 的真实任务分布不同；榜单不反映你的 provider 额度、延迟、失败率、工具调用稳定性。PinchBench 虽然和 OpenClaw 相关，但仍混有 runtime、provider、benchmark version、timeout、judge scaffold 等因素，所以也不能单源拍板。

### OmniRoute

OmniRoute 值得借鉴的是工程做法，不是整套搬过来。

可借鉴：

- pricing sync：外部价格同步是 opt-in，不覆盖用户 override。
- models.dev sync：把价格、能力、context、modalities、tool/structured output 统一成 metadata。
- quota cache / preflight：unknown 不阻塞；429、rate limit、usage API 更新 quota pressure。
- cost strategy：先过滤能力和健康，再选便宜模型。
- budget / cost accounting：把 token 成本和预算窗口分开记录。

不建议借鉴：

- 完整 gateway/combo router。
- 大量 provider-specific dashboard/control plane。
- 复杂 taskFitness 表。
- 自动把发现的模型写进 live routing。

OctoClaw 的最小吸收方式：

```text
OpenRouter / models.dev / OpenClaw catalog
  -> model intel snapshot
  -> same-provider proposal
  -> shadow recommendation
  -> local replay/eval 校准
  -> gated live
```

---

## 4.2 旧设计里只保留这些原则

旧的 Auto Router / model-intel 文档里有不少大方案，Lite 版只吸收下面几条，不恢复复杂 router。

| 旧设计原则 | Lite 版怎么落地 | 不做什么 |
|------------|-----------------|----------|
| 编排感知，不做纯 proxy router | 只服务 OctoClaw 的委派/子 agent 选模 | 不接管所有 OpenClaw 请求 |
| `model-intel` 是事实快照 | 生成带 source/freshness 的 snapshot | 不在热路径即时拼 provider 事实 |
| 先 hard gates，再评分 | 先过滤未配置、冷却、不可用、能力不够、额度高压 | 不让便宜模型绕过能力门槛 |
| 本地 truth 高于外部榜单 | replay/eval、失败率、延迟、quota pressure 优先 | 不因榜单高就直接 live |
| 同供应商先降本 | 同 provider/family 找 mini/standard 候选，生成 proposal | 不自动写 OpenClaw 配置 |
| 选 `(model, output_budget)` | 复杂度决定模型和输出预算一起收紧 | 不只换模型、不控输出 |
| 主线程快路径优先 | 状态查询、解释、简单 fresh lookup 仍主 agent 直接答 | 不为了省模型钱强行委派 |

执行顺序保持简单：

```text
configured + available + capability gates
  -> quota / health / latency gates
  -> mode scoring(cost_first | balanced | reliable_fast)
  -> shadow evidence
  -> gated live
```

这几个点足够支撑第一版。旧文档里的 recommendation API、独立 gateway、dashboard、完整 facts plane、复杂 taskFitness、combo router 都不进入 Lite 范围。

---

## 5. 模型价格来源

按优先级合并：

1. OpenClaw config 的 `models.providers.*.models[].cost`
2. OpenClaw Gateway pricing cache
3. OpenRouter / LiteLLM pricing
4. provider catalog
5. 人工 override

价格分两层：

| 字段 | 说明 |
|------|------|
| `marketPrice` | 公开 token 价格，可跨模型比较 |
| `effectiveCostBand` | 本地边际成本，受套餐、额度、缓存影响 |

注意：

- `0` 价格必须有来源，否则当 unknown。
- cache read/write 单独算，长上下文任务会受影响。
- 套餐模型只有在 `quotaPressure=low|medium` 时才可以看作低边际成本。

---

## 6. 套餐和剩余额度

OpenClaw 现在没有统一的跨供应商套餐余额事实面，所以第一版只做 pressure，不做精确余额。

| 输入信号 | 映射 |
|----------|------|
| provider usage API 返回低占用 | `quotaPressure=low` |
| provider usage API 返回接近上限 | `quotaPressure=medium/high` |
| 429 / rate limit / cooldown | `quotaPressure=high` 或 `available=no` |
| 用户手动配置套餐 | `type=subscription`，`quotaPressure=unknown` |
| 无任何信息 | `type=unknown`，`quotaPressure=unknown` |

套餐配置只表达偏好：

```yaml
router:
  plans:
    - provider: openai-codex
      type: subscription
      preferWhenQuotaPressure: low
    - provider: qwen
      type: subscription
      preferWhenQuotaPressure: low
```

不能因为 `type=subscription` 就强行当免费。必须同时看 quota pressure、稳定性和能力。

---

## 7. 同供应商候选发现

目标：用户只配强模型时，发现同供应商更便宜模型，但只输出 proposal。

候选来源：

1. 当前 provider config：同 provider、同 baseUrl、同 auth/profile。
2. provider catalog：同 provider 的模型列表。
3. pricing cache：同 provider 或同 family 的低价模型。
4. 模型名 family 推断：只能作为 proposal reason。

输出示例：

```json
{
  "baseModel": "openai/gpt-5.5",
  "candidates": [
    {
      "model": "openai/gpt-5.x-mini",
      "configured": false,
      "reason": "same_provider_cheaper_candidate",
      "action": "add_to_shadow_allowlist"
    }
  ]
}
```

规则：

- 可以自动发现。
- 可以自动加入 shadow allowlist。
- 不自动写 OpenClaw live config。
- live 前必须 smoke/eval 或人工确认。

---

## 8. 自动任务

需要自动任务，但只读、低频、非热路径。

### 8.1 启动后分析

OpenClaw 启动 30-60 秒后跑一次：

```text
read config
read pricing cache
read provider catalog
read auth profile usage/cooldown
write model-intel-snapshot.json
write model-config-proposal.json
```

不改配置，不切模型。

### 8.2 定时刷新

每 12 小时或每天一次：

- 更新价格。
- 更新能力 metadata。
- 更新失败率、延迟、cooldown。
- 更新 quota pressure。

禁止在用户消息热路径里拉远端 catalog/pricing。

---

## 9. 是否值得委派

委派前先估算成本和收益。

```text
mainCost = main_model_tokens * main_model_price

delegateCost =
  dispatchOverhead
  + childPromptCost
  + childOutputCost
  + resultMergeCost
  + retryRiskCost

delegateLatency =
  dispatchLatency
  + childLatency
  + resultMergeLatency
```

决策表：

| 请求类型 | 建议 |
|----------|------|
| 状态、进度、是否派发、哪个模型在跑 | 不委派 |
| 简单问答，主 agent 几句话能答 | 不委派 |
| 小修改但无需跑测试 | 默认不委派，除非主上下文太大 |
| 代码修改、测试、调试、长任务 | 倾向委派 |
| 复杂研究、可并行、需隔离上下文 | 倾向委派 |
| 委派成本更高且无质量/并行收益 | 不委派 |
| 委派可用套餐/便宜模型且能力过线 | 倾向委派 |

委派不是为了“看起来多 agent”，而是为了成本、隔离、并行或质量收益。

---

## 10. 委派后选模型

第一步：硬过滤。

```text
configured=true
available=yes
cooldown=false
quotaPressure != high
contextWindow >= minContext
toolUse 满足任务需要
codingTier >= qualityFloor
```

第二步：模式打分。

```text
score =
  qualityWeight * qualityScore
  + costWeight * costScore
  + speedWeight * speedScore
  + stabilityWeight * stabilityScore
  + planWeight * planScore
```

分数含义：

- `qualityScore`：tier + 本地 eval 成功率。
- `costScore`：越便宜越高，cache 价格也纳入。
- `speedScore`：p50/p95 越低越高。
- `stabilityScore`：失败率、cooldown、fallback 越低越高。
- `planScore`：套餐可用且 quota pressure 低时加分。

---

## 11. 三种模式

### cost_first

用于低风险、可重试、批量任务。

```text
cost 45%
stability 25%
quality 20%
speed 10%
```

规则：

- 选刚好过质量线的最低成本模型。
- 套餐内且 quota low 的模型优先。
- 不能低于 quality floor。

### balanced

默认模式。

```text
quality 35%
stability 25%
cost 25%
speed 15%
```

规则：

- 常规 coding delegate 用这个。
- 避免近期失败率高或 p95 很慢的模型。
- 同等质量下优先套餐/便宜模型。

### reliable_fast

用于失败代价高或用户正在等结果。

```text
stability 35%
quality 35%
speed 20%
cost 10%
```

规则：

- 不选 unknown capability。
- 不选近期失败率高的模型。
- 可以更贵，只要减少失败和重试。

---

## 12. Shadow Event

每次 shadow 至少记录：

```json
{
  "event": "router_lite_shadow",
  "mode": "balanced",
  "judge": {
    "route": "delegate",
    "confidence": 0.86,
    "complexity": "normal",
    "complexity_confidence": 0.81
  },
  "delegateDecision": "delegate_worth_it",
  "actualModel": "openai/gpt-5.5",
  "recommendedModel": "openai/gpt-5.x-mini",
  "estimatedCostDeltaUsd": -0.012,
  "qualityFloor": "standard",
  "reasonCodes": [
    "same_provider_cheaper",
    "quality_floor:standard",
    "stability:pass",
    "quota_pressure:low"
  ],
  "ignoredReason": "not_configured"
}
```

`ignoredReason` 常见值：

- `low_judge_confidence`
- `no_eligible_model`
- `not_configured`
- `quota_pressure_high`
- `capability_below_floor`
- `status_or_provenance_request`

---

## 13. Live Gate

第一批 live 只允许：

- `route=delegate`
- `configured=true`
- 非 status/provenance/session-control 请求
- `mode=cost_first` 或 `balanced`

进入 live 的条件：

| 条件 | 门槛 |
|------|------|
| shadow 数据 | 7 天或 100 条以上 |
| 质量 | 人工抽查或 eval 不降质 |
| 成本 | 估算成本下降或持平 |
| 失败率 | 不高于 baseline |
| 延迟 | 不明显变差 |
| 回滚 | 一个 flag 可回 shadow |

---

## 14. 实施顺序

1. `model-intel snapshot`
   - 收集能力、价格、套餐、速度、稳定性。
2. `same-provider proposal`
   - 找同供应商低成本候选，不写 live config。
3. `delegate cost decision`
   - shadow 判断是否值得委派。
4. `mode-based model selector`
   - 实现 `cost_first / balanced / reliable_fast`。
5. `shadow report`
   - 展示实际模型、推荐模型、成本差、忽略原因。
6. `gated live`
   - 只对 configured delegate 模型启用。

---

## 15. 验收标准

- 能生成 `model-intel-snapshot.json`。
- 能生成同供应商候选 proposal。
- unknown quota 不会被当免费。
- `configured=false` 不会进入 live。
- status/provenance 请求不会触发委派省钱逻辑。
- shadow report 能回答：
  - 为什么建议委派或不委派？
  - 为什么推荐这个模型？
  - 成本预计省多少？
  - 为什么没有启用推荐？
  - 是能力不够、未配置、额度压力高，还是稳定性差？

---

## 16. 2026-05-10 实施细化：能力、价格、健康、套餐怎么持续更新

Auto Router Lite 不能靠手写模型表，因为新模型几乎每天出现。第一版也不应该追求“全网最强模型榜单”，而是只回答 OctoClaw 真实需要的四个问题：

1. 这个模型当前能不能在本机 OpenClaw 配置里调用？
2. 它是否满足本次任务的最低能力门槛？
3. 它的边际成本、套餐压力、速度和失败率是否优于当前模型？
4. 推荐它是否有足够证据，还是只能 shadow/proposal？

### 16.1 source 优先级

`model-intel-snapshot` 按来源分层合并，不在热路径拉远端 catalog。

| 来源 | 用途 | 可信度 |
|------|------|--------|
| OpenClaw `models list --json` | configured、available、contextWindow、local、tags | 高，代表本机可见事实 |
| OpenClaw config / plugin manifest / provider catalog | native context、input modality、reasoning、static cost | 中高，取决于 freshness |
| OpenClaw pricing cache / `resolveModelCostConfig()` | market price、cache read/write price、tiered pricing | 高，价格主源 |
| `openclaw status --usage --json` / Gateway `usage.status` | provider usage window、reset、quota pressure | 中高，仅覆盖支持 usage 的 provider |
| local replay/nightly | p50/p95 latency、failure rate、tool-call failure、timeout、fallback、user correction | 最高，代表本机真实效果 |
| OpenRouter / models.dev / provider catalog sync | 新模型发现、context、公开价格、supported parameters | 中，不能直接 live |
| operator override | 套餐、模型偏好、禁用/降权 | 高，但必须带 owner/freshness |
| external leaderboard | codingTier cold-start 先验 | 低，只能 proposal/shadow |

每个字段都必须带 `source[]`、`freshness`、`confidence`。缺 source 的字段不能进入 hard decision。

### 16.2 能力不是一个总分

第一版不要给模型打一个“综合智商分”。能力拆成两层：

1. 硬能力：上下文、工具、结构化输出、reasoning、prompt cache。
2. 场景能力：coding worker、agentic tool task、research lookup、data/log analysis、main reasoning。

硬能力是 gate；场景能力是排序依据。硬能力不过线时，场景分再高也不能进 live。

```typescript
type CapabilityEvidence =
  | "declared"        // catalog/config 说支持
  | "probed"          // 本机 smoke probe 通过
  | "observed"        // 真实任务 replay 证明稳定
  | "operator_override"
  | "heuristic";      // 名称/榜单推断，只能低置信

interface CapabilityLite {
  contextWindow?: number;
  input: Array<"text" | "image" | "audio" | "video">;
  toolUse: "yes" | "no" | "unknown";
  structuredOutput: "yes" | "no" | "unknown";
  reasoning: "yes" | "no" | "unknown";
  promptCache: "yes" | "no" | "unknown";
  codingTier: "mini" | "standard" | "strong" | "frontier" | "unknown";
  confidence: "high" | "medium" | "low" | "unknown";
  evidence: CapabilityEvidence[];
}
```

`codingTier` 的含义也收窄：它只表示 OctoClaw delegated coding/workspace tasks 的最低质量层，不表示通用排行榜排名。

场景能力的最小结构：

```typescript
interface ScenarioAbilityScore {
  score?: number;       // 0-100
  tier: "S" | "A" | "B" | "C" | "unknown";
  confidence: "high" | "medium" | "low" | "unknown";
  sources: Array<{
    source: "pinchbench" | "aider" | "swe_bench" | "bfcl" | "artificial_analysis" | "local_replay" | "operator_override";
    score?: number;
    version?: string;
    sampleCount?: number;
    fetchedAt: string;
  }>;
}

interface ScenarioAbilityLite {
  codingWorker: ScenarioAbilityScore;
  agenticToolTask: ScenarioAbilityScore;
  researchLookup: ScenarioAbilityScore;
  dataLogAnalysis: ScenarioAbilityScore;
  mainReasoning: ScenarioAbilityScore;
  defaultDelegate: ScenarioAbilityScore;
}
```

`defaultDelegate` 只在任务分类不清时使用，权重保守：

```text
defaultDelegate =
  35% codingWorker
  30% agenticToolTask
  15% dataLogAnalysis
  10% researchLookup
  10% mainReasoning
```

PinchBench 的原始 category 不能直接等同 OctoClaw 场景。它应该作为证据映射：

| PinchBench 原始分类 | OctoClaw 场景 |
|---------------------|---------------|
| `coding` | `codingWorker` |
| `skills` / `integrations` / `memory` / `productivity` | `agenticToolTask` |
| `research` | `researchLookup` |
| `csv_analysis` / `log_analysis` / `analysis` | `dataLogAnalysis` |
| `analysis` / `meeting_analysis` / `writing` | `mainReasoning` |

这也是为什么报告里可以展示 raw categories，但 router 只消费 OctoClaw 场景分。

### 16.3 新模型如何进系统

新模型进入 live 的状态机：

```text
external/catalog discovered
  -> proposal only, confidence=low
  -> metadata normalized, still not live
  -> cheap probes pass: tool / structured / tiny coding / latency
  -> shadow eligible, confidence=medium
  -> local replay/nightly 样本足够且不降质
  -> configured=true 后才允许 gated live
```

硬规则：

- `configured=false` 永远不能 live。
- `heuristic` 或榜单来源不能 live。
- `toolUse=unknown` 不能承接需要工具的 delegated task。
- `quotaPressure=unknown` 不能当免费。
- catalog 超过 TTL 未刷新时，能力降为 stale，不参与 live 升级。

### 16.4 probe 设计

probe 必须便宜、少量、可限流，默认只对 proposal 候选或用户指定 provider 跑。

| Probe | 目的 | 成功标准 |
|-------|------|----------|
| tool smoke | 验证能否稳定调用工具 | 调用 noop/tool echo，参数可解析 |
| structured smoke | 验证 JSON/schema 输出 | 输出可 parse 且字段完整 |
| tiny coding smoke | 粗测 coding lane | 通过 2-3 个 deterministic fixture，不用 LLM judge |
| context smoke | 验证大上下文声明不过分虚 | 仅对 long-context 候选运行 |
| latency smoke | 得到粗略 p50 初值 | 记录，不作为唯一淘汰依据 |

probe 结果只把模型从 proposal 推到 shadow，不直接推 live。真正 live gate 看本地真实任务 outcome。

### 16.5 价格

价格不由 OctoClaw 自己维护一张表。优先使用 OpenClaw 已有能力：

```text
OpenClaw config / models.providers.*.models[].cost
  -> models.json cost index
  -> Gateway pricing cache
  -> OpenRouter / LiteLLM mapping
  -> estimateUsageCost()
```

Snapshot 里同时保存：

- `marketPrice`：公开 token 价格。
- `estimatedCostForTask`：按当前任务预算估算。
- `costConfidence`：config/cache 高，external 中，missing unknown。
- `missingCostReason`：没有价格时必须显式说明，不能按 0 处理。

### 16.6 套餐和额度

套餐不是市场价格，必须分开建模：

```typescript
interface PlanLite {
  type: "pay_as_you_go" | "subscription" | "free_quota" | "unknown";
  quotaPressure: "low" | "medium" | "high" | "unknown";
  effectiveCostBand: "free_or_sunk" | "cheap" | "normal" | "expensive" | "unknown";
  resetAt?: string;
  source: string[];
}
```

规则：

- 有 provider usage window 且剩余额度充足，才可以把套餐模型轻微升权。
- usage API 不支持时保持 `quotaPressure=unknown`。
- rate limit / 429 / cooldown 直接进入 health 降权。
- 套餐“理论上免费”不等于可无限使用；高压 quota 仍要避开。

### 16.7 健康

健康优先来自本地真实运行，不来自 catalog：

| 字段 | 来源 |
|------|------|
| `available` | OpenClaw auth/model list/provider probe |
| `cooldown` | usage status、429/rate limit、runtime failure |
| `recentFailureRate` | replay/nightly |
| `p50LatencyMs / p95LatencyMs` | replay/nightly + probe 初值 |
| `p50FirstTokenMs / p95FirstTokenMs` | 定时 probe + 真实请求 telemetry |
| `p50OutputTokensPerSecond` | 定时 probe + 真实请求 telemetry |
| `toolCallFailureRate` | replay/nightly |
| `timeoutRate` | replay/nightly |

健康 gate 在价格之前。便宜但近期失败率高的模型不能进入推荐。

响应速度、生成速度和稳定性由 OctoClaw 自己定时维护，不从榜单推断。建议每 6-12 小时对 configured 模型跑低成本 probe，并从真实 delegated work 聚合：

```text
configured models
  -> short response probe: first_token_ms, output_tps
  -> tool smoke probe: tool_call_success
  -> structured smoke probe: json_parse_success
  -> nightly replay sample: task_success, timeout, user_correction
  -> health rollup
```

定时健康结果只更新 `health` 和 `scenarioAbility.sources += local_replay`；不自动改 live 配置。

### 16.8 A/B/C 具体落地

#### A：model-intel snapshot

目标：生成只读事实快照，不改 runtime 行为。

输入：

- `openclaw models list --json`
- OpenClaw config / plugin manifest / provider catalog
- Gateway pricing cache / usage-cost
- `openclaw status --usage --json`
- replay/nightly health rollup
- optional external catalog sync
- operator overrides

输出：

- `router-lite/model-intel-snapshot.json`
- 每个字段带 source、freshness、confidence
- 新模型默认 proposal-only

#### B：config analyze proposal

目标：发现配置缺口，不自动写 OpenClaw config。

典型提示：

- 只配了 frontier/strong，没有 cheap delegated lane。
- 有同 provider mini/standard 候选，但未配置。
- 有套餐低压模型，但当前 fallback 未利用。
- 当前 configured 模型缺 tool-use/structured-output 证据。

输出：

- `router-lite/model-config-proposal.json`
- 每条建议包含 expected use、risk、required auth、why_not_live。

#### C：shadow recommendation

目标：每次实际 route/model 决策旁路写推荐事件。

```text
judge四字段 + runtime compact signals + snapshot
  -> hard gates
  -> mode scoring(cost_first | balanced | reliable_fast)
  -> actual vs recommended
  -> replay shadow event
```

Shadow event 必须回答：

- 推荐了哪个模型和 output budget？
- 当前实际模型是什么？
- 为什么没有推荐更便宜模型？
- 预计成本差是多少？
- 是能力不够、未配置、额度高压、健康差，还是证据不足？

Live gate 仍按原文：连续 7 天或至少 100 条 shadow 样本，质量不降、成本不升、失败率不升，且一键回 shadow。

### 16.9 2026-05-10 落地状态

A/B 已落成只读骨架，未接入 live route/model selection：

- `packages/octoclaw-policy/src/router-lite/contracts.ts`：定义 `ModelIntelSnapshot`、`ModelIntelLite`、price/capability/health/plan、proposal、shadow event 合同。
- `packages/octoclaw-policy/src/router-lite/model-intel.ts`：合并 `openclaw models list --json`、`~/.openclaw/openclaw.json`、旧 `model-catalog.json`、usage/status/cost 信号。
- `packages/octoclaw-policy/src/router-lite/config-analyze.ts`：生成 proposal-only 建议，不写 OpenClaw config。
- `octoclawctl router model-intel refresh [--output-dir <dir>] [--openclaw-home <dir>] [--format json]`
- `octoclawctl router model-config analyze [--input <snapshot.json>] [--output-dir <dir>] [--format json]`

默认输出目录：

```text
~/.openclaw/workspace/tmp/octopus/router-lite/
  model-intel-snapshot.json
  model-config-proposal.json
```

当前本机轻量验证：

```text
router model-intel refresh:
  models=14 configured=4 proposalOnly=10
  sources=openclaw_models_list/openclaw_config/legacy_model_catalog/openclaw_usage_status/openclaw_usage_cost all ok

router model-config analyze:
  proposals=12
  actions=add_compatibility_probe:4, add_plan_override:4, refresh_catalog:4
```

注意：

- 这一步不会自动给 OpenClaw 增加模型，也不会替换主 agent/子 agent 模型。
- `configured=false` 候选只进 proposal。
- `quotaPressure=unknown` 不当免费。
- 缺 `toolUse` / `structuredOutput` 证据时，只建议 probe，不用于 delegated task live gate。
- C 阶段才会把实际模型和推荐模型写 shadow event；D 阶段才考虑 gated live。

### 16.10 2026-05-10 外部数据源试跑结论

新增只读原型脚本：

```text
pnpm router:model-intel:prototype
node scripts/router-lite-model-intel-prototype.mjs --format json
```

脚本只拉外部公开源，不读取本地 secret，不接入 live route：

- OpenRouter `/api/v1/models`：价格、context、supported parameters。
- PinchBench official leaderboard：OpenClaw agent 实战 best/average、成本、耗时、提交数。
- PinchBench best submission：按 task category 生成 OctoClaw 场景分。

价格倍率基准使用 `z-ai/glm-5.1 = 1.00x`，混合价格口径为 `3 input : 1 output`。这比用 GPT-5.5 当 1.00x 更适合成本优化，因为 GLM 5.1 是当前可用中高能力 worker 的中间价位参考。

当前试跑样例显示：

| 模型 | API in/out $/M | 成本倍率，GLM 5.1=1 | 场景信号，PinchBench best submission | 结论 |
|------|----------------|----------------------|----------------------------------------|------|
| `deepseek/deepseek-v4-flash` | 0.14 / 0.28 | 约 0.105x | best 85；codingWorker 89；样本低 | 高性价比 worker 候选 |
| `deepseek/deepseek-v4-pro` | 0.435 / 0.87 | 约 0.327x | best 59；codingWorker 76；样本低且异常 | 不能因 Pro 名称直接优先 |
| `z-ai/glm-5.1` | 1.05 / 3.5 | 1.00x | best 77；codingWorker 88；样本低 | 基准模型 |
| `z-ai/glm-5-turbo` | 1.2 / 4.0 | 约 1.143x | best 86；codingWorker 89；dataLog 92 | 值得优先评估 |
| `openai/gpt-5.5` | 5 / 30 | 约 6.767x | best 89；mainReasoning 91；dataLog 94 | 高难兜底，不默认 worker |
| `openai/gpt-5.4-mini` | 0.75 / 4.5 | 约 1.015x | best 82；codingWorker 86；dataLog 91 | 平衡 worker 候选 |
| `openai/gpt-5.4-nano` | 0.2 / 1.25 | 约 0.278x | best 77；codingWorker 77 | 简单/低风险任务候选 |
| `minimax/minimax-m2.7` | 0.299 / 1.2 | 约 0.315x | best 72；codingWorker 80 | 便宜但需更多本地验证 |
| `xiaomi/mimo-v2.5` | 0.4 / 2.0 | 约 0.481x | best/avg 约 89/89；codingWorker 91；样本低 | 自动候选发现很重要 |

价格源也暴露了一个硬要求：同一模型在 OpenRouter live API、models.dev、官方/供应商 catalog 之间可能冲突。`model-intel` 必须记录 `price.conflict=true` 和来源列表，不能静默覆盖。

能力源的结论：

- PinchBench 对 OctoClaw 很相关，但它是 OpenClaw agent 实战榜，不是通用模型智力榜。
- Aider/SWE-bench/LiveCodeBench/BFCL 仍要作为 `codingWorker` 和 `agenticToolTask` 的补充证据。
- 本地 nightly/replay 是最终 live gate，特别是 first-token latency、output TPS、失败率、timeout、工具调用失败。
- 没有场景证据的新模型只能进 proposal/shadow，不能进默认 live。
