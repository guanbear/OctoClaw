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

1. OpenClaw provider catalog：context、tool、structured output、vision、reasoning。
2. OpenClaw config：用户显式配置的模型、profile、baseUrl、cost。
3. 本地 replay/eval：成功率、返工率、工具调用失败、超时。
4. 外部 registry：OpenRouter、LiteLLM、models.dev，只做补充。
5. 人工 override：用户明确声明某模型适合/不适合某类任务。

不要用榜单直接决定 live。榜单只适合 cold-start 标注 `codingTier`。

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

