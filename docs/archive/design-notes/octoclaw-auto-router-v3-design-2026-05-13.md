# OctoClaw Auto Router v3 Design

Date: 2026-05-13
Supersedes: `octoclaw-phase5-auto-router-design-2026-04-30.md` (legacy), `octoclaw-auto-router-lite-cost-model-design-2026-05-08.md` (Lite scope, folded in)
Status: design baseline for V1 implementation

## 0. TL;DR

Auto Router V1 是一个**独立可抽离的 `@octoclaw/router` 包**，整合了原本散落在两处的能力：

1. **Semantic Layer**（原 judge）：轻量小模型把用户请求翻译成结构化路由信号
2. **Decision Layer**（原 router-lite）：根据能力快照 + 成本 + 稳定性选出最合适的模型

核心约束：

- 子 agent 模型自动切，无需用户确认；主 agent 模型不静默切，只建议
- Judge 输出**极简 3 字段**（`route / confidence / complexity`），保证小模型输出稳定性
- 能力数据**以外部公开数据为主**（榜单 + Provider Catalog），本地 replay 只是个性化加分项
- 首次运行向导一次问清偏好，之后自动运转
- **不做多层判断、不做多模式、不做关键词匹配**——V1 极简

## 1. 访谈结论（设计原始输入）

这一节是设计访谈的结构化总结，按原始分类保留，供后续回溯决策动因。

### 1.1 用户场景痛点

- 默认主 agent 配置单一模型，简单问题也用最强模型，浪费成本
- 复杂代码和浏览器操作用便宜模型可能搞不定，需要返工
- 某个模型因算力或网络不稳定时希望自动切走
- 应该识别 coding plan 场景，同等能力下优先用 plan 模型

### 1.2 决策权威和风险边界

- **子 agent 自动切**，不经过用户确认；委派时必须告诉用户用了哪个模型（通过 footer）
- 主 agent 模型不静默切，可以建议
- 识别任务特性由 judge + 主 agent 做语义判断，**不靠关键词**
- 稳定性判断优先级：provider 错误码 + 失败率 + 延迟 + 队列健康，**都要但优先级不同**
- 稳定性下降时优先切**同等能力的其他 provider**

### 1.3 数据和信任

- Plan 探测：只询问 OpenClaw 已配置的模型是不是 plan；用户可在首次运行向导回答
- Plan 快用完时自动切，需要**轻量提示**
- **外部数据为主**（榜单 + Provider Catalog），本地 replay 作为 optional 个性化
- 新配置 provider / model 时需要**主动触发**能力列表刷新
- Shadow → Live 推广：**让系统自己决定，但要能看到决策过程**
- 委派推荐错误时：自动扣分 + 累积后降权 + 用户可随时手动 override
- 成本报告：全粒度（模型 / 场景 / 趋势 / 预测）

### 1.4 产品边界

- V1 交付完整端到端（向导 + shadow + 自动推广 + 成本报告）
- 定位：核心功能之一，**插件化设计**，未来可独立开源
- **Judge 合并进 Auto Router**，作为 Semantic Layer

### 1.5 Judge 优化决策

- Judge 模型判断标准：快（p95 < 1s）、能关 thinking、JSON parse 成功率 > 99%、成本 < $0.0001/call
- 实测可用：Qwen3 0.6B（本地）、GPT-5.4-mini（远端）
- **不做 Tier 0/1/2 分层**：边缘场景多，容易变成关键词补丁
- **不加 scenario 字段**：V1 只用 complexity 分层模型，scenario 等有真实数据后 V2 再加
- **不加 complexity_confidence**：字段越多小模型越不稳

## 2. 核心设计原则

### 2.1 Judge + 规范限定 > 主 agent 自判 + agents.md

项目最根本的架构判断：

| 维度 | Judge + runtime 规范 | 主 agent 自判 + agents.md |
|---|---|---|
| 成本 | 毫秒级 judge + ~$0 | 主 agent 首轮 2-5s + $ |
| 一致性 | Stateless，判断稳定 | 受 context 影响，判断漂移 |
| 可观测性 | 每次 route 决策可 replay | 混在 CoT 里，无法 evaluate |
| 可测试性 | 40+ 单元测试保护行为 | 只能 prompt 调整，不能断言 |
| 模型无关 | 换主 agent 模型不受影响 | 换模型行为大变 |
| 用户 override 保护 | 代码硬约束 | 一句"忽略之前规则"就破防 |
| 上下文污染 | 主 agent 不需要思考"要不要派" | 主 agent 花 context 讨论路由 |

**结论**：Judge 做默认判断、主 agent 可以通过结构化信号纠偏、runtime 代码层做硬约束——三层配合，不依赖 agents.md。

### 2.2 V1 极简原则

- 只做 **一次 judge 调用、3 字段输出**
- 只做 **默认 balanced 偏好**（cost_first / reliable_fast 留给 V2）
- 只做 **complexity 分层**（不做 scenario）
- 只做 **shadow 到 live 的自动推广**（不做 nightly LLM review）

V2+ 的增强在文末有 future considerations 列表，但 V1 不做。

### 2.3 插件化设计

`@octoclaw/router` 是独立 npm 包，公开接口允许注入：

- `capabilityProvider`：能力数据源
- `costProvider`：成本数据源
- `leaderboardLoader`：榜单快照加载器
- `shadowStorage`：shadow 事件存储
- `telemetryEmitter`：外部观测埋点

OctoClaw 作为它的一个 integration，未来可独立开源成通用 `policy-router` 或 `agent-router`。

## 3. 架构

### 3.1 分层

```
┌──────────────────────────────────────────────────────┐
│ @octoclaw/router (独立 package)                       │
│                                                      │
│  Semantic Layer (Judge)                              │
│  ├─ Input: prompt + compact runtime signals          │
│  ├─ Model: Qwen3 0.6B local OR cheap remote          │
│  └─ Output: { route, confidence, complexity }        │
│                                                      │
│                    ↓                                 │
│                                                      │
│  Decision Layer                                      │
│  ├─ Capability Snapshot (leaderboard + catalog)     │
│  ├─ Cost / Plan / Quota                              │
│  ├─ Stability / Health (realtime)                    │
│  ├─ Scoring Engine                                   │
│  ├─ Shadow Evaluator                                 │
│  └─ Auto-promotion Gate                              │
│                                                      │
│                    ↓                                 │
│                                                      │
│  Output                                              │
│  └─ { recommendedModel, outputBudget, reasonCodes }  │
└──────────────────────────────────────────────────────┘
```

### 3.2 数据流

```
User turn
  │
  ├─ runtime compact signals (session, recent execution, coverage)
  │
  ├─ Judge (Semantic Layer)
  │    ├─ cache check (key: prompt_hash + session + recent_exec + model_id + snapshot_id)
  │    ├─ if cache miss: call judge model
  │    ├─ on timeout/parse fail: fallback rules
  │    └─ output: { route, confidence, complexity }
  │
  ├─ Auto Router Decision Layer
  │    ├─ load capability snapshot (leaderboard + catalog)
  │    ├─ load cost / plan / health
  │    ├─ score candidates (cost_first mode in V1 = balanced)
  │    ├─ select recommendedModel
  │    └─ emit shadow event
  │
  ├─ Runtime applies:
  │    ├─ route = reply → main agent answers
  │    └─ route = delegate → dispatch with recommendedModel
  │
  └─ On completion:
       ├─ update stability (success / failure / latency)
       ├─ update cost log
       └─ shadow evaluator periodically promotes candidates
```

## 4. Semantic Layer (Judge)

### 4.1 输出 Schema（V1 最终版）

```ts
interface JudgeOutput {
  route: "reply" | "delegate";
  confidence: number;              // 0.0 - 1.0
  complexity: "simple" | "normal" | "complex" | "deep";
}
```

**3 个字段**。V1 不加 `scenario`、不加 `complexity_confidence`。

### 4.2 字段含义

| 字段 | 含义 | 用途 |
|---|---|---|
| `route` | `reply`：主 agent 直接答；`delegate`：派子 agent | 选择执行路径 |
| `confidence` | 对 route 的置信度 | 低于 0.65 走 fallback；shadow 打分时作为证据强度 |
| `complexity` | 任务复杂度分层 | 决定选模型的质量门槛：simple→mini, normal→standard, complex→strong, deep→frontier |

### 4.3 Judge 模型选型

**硬标准**：

| 指标 | 要求 |
|---|---|
| 首 token 延迟 p95 | < 1s |
| 能关闭 thinking / reasoning | 必须 |
| JSON parse 成功率 | > 99% |
| 单次成本 | < $0.0001 per call |
| ctx 窗口 | > 8k 即可 |
| 中英文稳定 | 必须 |

**推荐配置**：

| 位置 | 模型 | 备注 |
|---|---|---|
| Local（默认、免费） | **Qwen3 0.6B** via Ollama | 毫秒级，零成本，中文好 |
| Local（更强判断） | Qwen3 4B | 准确率高一些，延迟 200-500ms |
| Remote cheap | **GPT-5.4-mini / GPT-5-mini** | 已实测稳定 |
| Remote free-tier | Groq + Llama-3.3-70b | 免费额度够日常 |

**明确不推荐**：
- 带强制 thinking 的模型（o1、Claude thinking）
- 中文弱的小模型

### 4.4 缓存

**目的**：同一 session 连续相近问题不重复 judge。

**缓存 Key 构成**（任一不同即 miss）：

```ts
cacheKey = sha256([
  normalizedPromptHash,      // 去标点、空格、大小写后 hash
  sessionKey,
  recentExecutionFingerprint, // last task_id + status
  judgeModelId,
  snapshotId,
].join(":"));
```

**TTL**：120 秒。

**负缓存也要**：confidence < 0.65 的结果照样缓存（不值得重新 judge 一个低置信问题）。

**可关**：`octoclawctl config set router.judge.cacheEnabled false`。

### 4.5 异常保护（Fallback Rules）

4 种情况 judge 不可用，走保守规则：

1. Judge 超时（> 2s）
2. Judge 返回 JSON parse 失败
3. Judge 模型连续失败（10 次 5 失败）→ 30 分钟 cooldown
4. Judge 未配置

**保守规则**（hardcoded 在代码里）：

```ts
function fallbackRoute(context): JudgeOutput {
  // 结构化信号优先（已在现有 runtime 实现）
  if (context.statusOrProvenanceRequest) {
    return { route: "reply", confidence: 0.9, complexity: "simple" };
  }
  if (context.sessionControlRequest) {
    return { route: "reply", confidence: 0.9, complexity: "simple" };
  }
  if (context.explicitDelegate) {
    return { route: "delegate", confidence: 0.9, complexity: "normal" };
  }
  // 默认保守：reply
  return { route: "reply", confidence: 0.5, complexity: "normal" };
}
```

**原则**：
- 宁可 reply 也不 delegate（delegate 失败代价 > reply 保守代价）
- 不用关键词
- confidence 低（runtime 不轻信）

### 4.6 纠偏机制（Three-tier correction）

**Tier 1：置信度门槛**
- `confidence < 0.65` → runtime 应用时降级或走 fallback

**Tier 2：主 agent 异议**
- 主 agent 可通过 `octoclaw_route_hint` 工具提结构化异议
- 结构化的 hint（不是自然语言关键词）可以 override judge

**Tier 3：用户反馈信号**
- 用户 retry 同一任务 / 显式纠正 → 本次 (judge_model, scenario) 临时扣分
- 不立即降权，累积后才改变判断

### 4.7 CLI 调试

```bash
octoclawctl router judge status          # 健康检查
octoclawctl router judge test "<prompt>" # 手动触发一次 judge，看输出
octoclawctl router judge config          # 查看 / 修改 judge 配置
```

## 5. Decision Layer

### 5.1 能力数据来源（总览）

能力数据分三层，**三层都是必需的**：

| 层 | 作用 | 存放位置 | 新鲜度 |
|---|---|---|---|
| **Packaged seed**（发版时打包的快照） | 用户装完立刻可用，不依赖任何远端 | `packages/octoclaw-router/src/data/leaderboard-snapshot.json` | 发版时刻 |
| **Background refresh**（后台定期刷新） | 保持在用版本的数据不过期 | `~/.octoclaw/router/leaderboard-snapshot.json` | 每周一次 |
| **Event-driven refresh**（事件触发） | 配置变化 / 新 provider / unknown model 时立刻补 | 同上 | 实时 |

**发版时打包的快照** ≠ **唯一获取途径**。发版打包是"默认值"——保证用户装完即可用、离线也能跑。正常使用中，后台 worker 每周 pull 一次最新快照到本地缓存（通过 GitHub Release artifact，独立于 OctoClaw 版本号），本地缓存优先级高于打包的 seed。

用户可随时：

```bash
octoclawctl router capability refresh           # 立即刷新，不等周计划
octoclawctl router capability snapshot show     # 查看当前用的是打包 seed 还是缓存 + 版本时间
```

**借鉴的开源项目（不是抄代码，是学设计）**：

| 项目 | 借鉴点 | 不借鉴 |
|------|--------|--------|
| [LiteLLM `model_prices_and_context_window.json`](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window_backup.json) | 单 JSON + 社区 PR 维护的 registry 思路；可直接作为 fallback source 拉 | 运行时代理层（不需要） |
| [models.dev](https://models.dev) | provider/model ID 标准化、静态 registry 的形态 | 网页 UI |
| [OpenRouter `/api/v1/models`](https://openrouter.ai/api/v1/models) | 免费元数据 API（实时 price + context + tool use） | 代理转发（我们直连 provider） |
| [RouteLLM (lm-sys)](https://github.com/lm-sys/RouteLLM) | "quality 分 + cost 的双目标优化" + preferred/fallback pool 结构 | 训练分类器部分（依赖大量本地 preference data，V1 不现实） |
| [Continue.dev model catalog](https://github.com/continuedev/continue) | dev-time model catalog 的目录结构 | IDE 集成层 |

核心思路是：**合成质量分 + 多源兜底**。不引入任何训练依赖，也不复用它们的运行时组件。

### 5.2 数据源清单（V1 使用）

**榜单（quality signals）**：

| 数据源 | 覆盖 scenario | 获取方式 | 上游更新频率 | 授权 |
|---|---|---|---|---|
| **Artificial Analysis** | 通用 + 价格 + 速度 | 公开 API `/api/v2/data/llms/models`（可选），兜底爬结构化页 | 每周 | 免费商用 |
| **Aider Leaderboard** | coding_worker | `Aider-AI/aider` 仓库 `aider/website/_data/*.yml` | 每 2-4 周 | Apache-2.0 |
| **LiveCodeBench** | coding_worker | `LiveCodeBench/LiveCodeBench` 仓库 leaderboard.json | 每周 | MIT |
| **BFCL**（Berkeley Function Calling Leaderboard） | agentic / tool use | `ShishirPatil/gorilla` 仓库 `berkeley-function-call-leaderboard/result/` | 每月 | Apache-2.0 |
| **SWE-bench Verified** | coding_worker（深度） | `princeton-nlp/SWE-bench` 仓库 leaderboard JSON | 不定期 | MIT |
| **LMArena Leaderboard** | research / 综合 | `lmsys/chatbot-arena-leaderboard` HF Space JSON | 近实时 | 公开 |

**元数据（capability metadata）**：

| 数据源 | 覆盖 | 获取方式 | 为什么用 |
|---|---|---|---|
| **OpenRouter `/api/v1/models`** | 300+ 模型的 price / context / tool use / cache | HTTPS REST，免 API key 即可拉 catalog | 实时、覆盖最广、稳定 |
| **LiteLLM `model_prices_and_context_window.json`** | 社区维护的 price + context 注册表 | GitHub raw JSON | 更新比 OpenRouter 快几天，作为交叉核验 |
| **models.dev** | provider/model ID 标准化 registry | GitHub raw JSON | 统一别名解析（例如 `gpt-5.5` 在不同 provider 的正式名） |
| **Provider 官方 catalog** | 权威 price / quota / plan | OpenClaw 已配置的 provider SDK | 作为 source-of-truth，覆盖前三者 |

**V1 不用**：
- Hugging Face Model Card（解析成本高，V2 再看）
- 单厂商自述 benchmark（偏向性太强）
- 第三方付费 API（会引入依赖 + 成本）
- 用户本地 replay（V1 只作为个性化加分；开源项目不能依赖用户有好数据）

### 5.3 刷新机制（什么时候拉 + 怎么不靠发新版）

**刷新不依赖发版**。发版只是 "seed"，保证装完立刻可用。刷新有三条独立路径：

**1. 启动时（immediate）**：
- 读 `~/.octoclaw/router/leaderboard-snapshot.json`（用户本地缓存，后台 worker 维护）
- 不存在 / schemaVersion 不对 → fallback 到 `packages/octoclaw-router/src/data/leaderboard-snapshot.json`（打包 seed）
- 两者都挂 → emit degraded warning，仍可运行（用 tier 默认值 + quality_floor + user override）

**2. 后台 worker（scheduled）**：
- 每周一 02:00 本地时间拉 **榜单 snapshot**
  - 从 `github.com/<org>/octoclaw` GitHub Release 的 `leaderboard-snapshot.json` artifact 拉
  - 这个 artifact 由仓库的 weekly CI job 自动生成（见 §5.6），**不需要发新版**
- 每 12 小时拉 **元数据**（OpenRouter catalog + models.dev + LiteLLM 单 JSON）
- 任何一步失败 → 保留上次成功的缓存，写 warning log，不阻塞用户

**3. 事件驱动（on-change）**：
- OpenClaw config `~/.openclaw/openclaw.json` mtime 变化 → 触发**部分刷新**（只拉变化的 provider / model 元数据）
- 路由时发现 unknown model → 尝试补查 OpenRouter / models.dev；补不到 → 标 `tier=unknown` 进 dispreferred 池
- 用户手动 `octoclawctl router capability refresh` → 全量刷

**不在热路径拉远端**。所有热路径（judge + decision）只读本地缓存，保证毫秒级。

### 5.4 权重与合成（score fusion）

一个模型在一个 scenario 下的 score 由多个 source 合成：

```
score(model, scenario) =
  Σ (source_weight × normalized_source_score)
  / Σ source_weight

source_weight = base_weight
              × freshness_factor
              × source_health
```

**base_weight**（各 source 在该 scenario 下的权威度，总和归一化为 1.0）：

| scenario | Aider | LiveCodeBench | SWE-bench | BFCL | AA | LMArena |
|----------|-------|---------------|-----------|------|------|---------|
| coding_worker | 0.35 | 0.30 | 0.20 | — | 0.15 | — |
| research | — | — | — | — | 0.40 | 0.60 |
| agentic | 0.20 | — | — | 0.50 | 0.30 | — |

这些数不是拍脑袋——是按"这个 source 在这个 scenario 下是不是 gold standard"给的。值写在 `packages/octoclaw-router/src/data/source-weights.json`，可以 hotfix 改而不用动代码。

**freshness_factor**：

| 上次抓取到现在 | factor |
|----------------|--------|
| < 30 天 | 1.0 |
| 30-90 天 | 0.7 |
| 90-180 天 | 0.4 |
| > 180 天 | 0.15（几乎无视，但仍参与合成以防所有 source 都过期） |

**source_health**：

- 最近 4 次 worker 抓取的成功率（0.0-1.0）
- 连续 4 次失败 → 0.0，标红通知
- 恢复后重新累积，不会永久拉黑

**confidence 字段的来源**：

```
confidence = if   Σ (base_weight × freshness_factor) >= 0.7  →  "high"
             elif >= 0.4                                      →  "medium"
             else                                             →  "low"
```

这个机制天然解决"数据源挂了怎么办"：挂了的 source `source_health = 0`，自动从合成里剔除，confidence 降级，用户看得到。

### 5.5 Snapshot 数据格式

本地缓存和打包 seed 用同一套 schema：

```json
{
  "snapshotVersion": "2026-05-13",
  "schemaVersion": 1,
  "generatedAt": "2026-05-13T10:00:00Z",
  "sources": [
    { "name": "artificial_analysis",    "fetchedAt": "2026-05-13T01:02:00Z", "ok": true },
    { "name": "aider",                  "fetchedAt": "2026-05-13T01:02:10Z", "ok": true },
    { "name": "livecodebench",          "fetchedAt": "2026-05-13T01:02:20Z", "ok": true },
    { "name": "bfcl",                   "fetchedAt": "2026-05-13T01:02:30Z", "ok": true },
    { "name": "swebench_verified",      "fetchedAt": "2026-05-12T03:00:00Z", "ok": true, "stale": true },
    { "name": "lmarena",                "fetchedAt": "2026-05-13T01:02:40Z", "ok": false, "error": "http_503" }
  ],
  "models": {
    "openai/gpt-5.5": {
      "tier": "frontier",
      "scores": {
        "coding_worker": { "score": 87, "confidence": "high",   "basis": ["aider","livecodebench"] },
        "research":      { "score": 91, "confidence": "high",   "basis": ["artificial_analysis","lmarena"] },
        "agentic":       { "score": 89, "confidence": "medium", "basis": ["bfcl"] }
      },
      "last_verified": "2026-05-12"
    }
  }
}
```

**每条 score 记录它是从哪些 source 合成的**。这样某个数据源挂了的时候，可以降级对应 score 的 confidence，而不是整条记录都失效。

V1 内部使用时：`complexity=deep` → 看各 frontier 模型 → 再按 cost / plan / health 排序。scenario 分数**内部备用，V1 不通过 judge 决定**。

### 5.6 数据源本身变化 / 上游挂了 / 格式漂移

**三类上游变化的处理**：

1. **上游临时不可用**（HTTP 5xx / 超时）
   - 当次 worker 跑失败，保留当前缓存
   - 连续失败 3 周 → 在 `octoclawctl router capability snapshot show` 里标红，但不阻塞路由
   - 决策继续跑，用上次成功的数据；该 source 的 `source_health` 降为 0，合成时被自动剔除

2. **上游数据格式变化**（JSON schema 漂移）
   - 每个 source 有独立的 `parseLeaderboard()` 函数，用 Zod schema 校验
   - 校验失败 → 标该 source 为 `ok: false, error: "schema_mismatch"`
   - 其他 source 合成的 score 继续用，不受影响（这就是多 source 合成的价值）
   - 仓库维护者收到 CI 告警 → 修 parser → merge 后，下一次 worker 周期自动恢复；**用户无需升级**

3. **上游 URL / API 改了**（整个数据源搬家）
   - worker 连不上 → 标 `error: "connection_refused"`，触发 1 次警告通知
   - 配置里预留 `sourceOverrides`，用户可以临时 override 单个 source 的 URL：
     ```json
     { "router": { "sourceOverrides": { "aider": { "url": "https://new.url/data.json" } } } }
     ```
   - 长期解决由维护者改 GitHub Release artifact 里的默认 URL；用户端下一次周更自动生效

**兜底链**（当所有榜单都挂）：

```
best-effort leaderboard  →  packaged seed  →  tier 默认值
                                              + quality_floor
                                              + user override
```

最差情况下路由仍能跑，只是 capability_score 退化成 "frontier / strong / mid 三档默认值"。用户如果配了 override，override 永远生效。

### 5.7 谁维护这些数据源（CI 周更 + 不靠发版）

刷新**不靠发版**。两个机制分开：

**发版时的 seed**：`packages/octoclaw-router/src/data/leaderboard-snapshot.json`
- 装完立刻可用，离线也能跑
- 发版时 freeze，发版后不再改
- 只是保底，正常使用中会被 worker 覆盖

**CI 周更 artifact**（真正的刷新通道）：
- 仓库 `.github/workflows/refresh-leaderboard.yml` 每周一 01:00 UTC 跑
- 跑 `scripts/refresh-leaderboard-snapshot.mjs`，拉各 source → 合成 → 输出 `leaderboard-snapshot.json`
- 以 `leaderboard-snapshot` tag 的 GitHub Release artifact 形式发布（和 OctoClaw 版本独立）
- 用户端 worker 每周一 02:00 本地时间拉这个 artifact，直接写到 `~/.octoclaw/router/`
- **用户不用升级 OctoClaw，榜单就自动更新**

**维护者负担**：
- 监控 CI 告警邮件（parser 挂了 / 某 source 挂了）
- 合 parser 的修复 PR
- 审查数据 diff（防止上游出脏数据传染用户），正常情况是点 approve 就行

**用户负担**：零。最多偶尔 `octoclawctl router capability refresh` 主动拉一次。

**本地 replay**（用户自己的数据）**V1 不进合成**，只作为单用户的个性化加分项，保证开源后不同用户的行为可预测。

### 5.8 Cost / Plan / Quota

**硬能力数据**（从 catalog / OpenRouter 读）：
- `inputUsdPerMTok`, `outputUsdPerMTok`, `cacheReadUsdPerMTok`, `cacheWriteUsdPerMTok`
- `contextWindow`, `toolUse`, `structuredOutput`, `reasoning`, `promptCache`

**Plan 信息**（向导 + provider API）：

```ts
interface PlanInfo {
  type: "subscription" | "pay_as_you_go" | "free_quota" | "unknown";
  monthlyQuota?: number;         // 如果已知
  quotaUsed?: number;            // 如果 API 支持
  quotaPressure: "low" | "medium" | "high" | "unknown";
  effectiveCostBand: "free_or_sunk" | "cheap" | "normal" | "expensive";
  resetAt?: string;
}
```

**硬规则**：
- `quotaPressure = unknown` **永远不当免费**
- `configured = false` 的模型**永远不进 live**
- Plan 余额 < 10% → 自动切走 + 发轻量提示

### 5.9 稳定性 / 健康（Realtime）

**实时更新**（不缓存）：

```ts
interface HealthSignals {
  available: "yes" | "no" | "unknown";
  cooldown: boolean;
  recentFailureRate: number;       // last 50 calls or 30 min window
  p50FirstTokenMs: number;
  p95FirstTokenMs: number;
  toolCallFailureRate: number;
  timeoutRate: number;
  errorCodes: Record<string, number>; // 4xx / 5xx / rate_limit / etc
}
```

**自愈规则**：
- 连续失败率 > 20% → 自动标 `cooldown: true`，30 分钟内不选
- p95 延迟 > 历史基线 2x → 标 `slow`，降权但不禁用
- 429 / rate_limit → 立即切同等能力其他 provider
- 5xx 连续 3 次 → cooldown 10 分钟

**切走目标**（你的明确要求）：**同等能力的其他 provider 优先**，其次降级到便宜模型。

### 5.10 打分算法（Scoring Engine）

V1 只有一种模式（balanced，默认）：

```
model_score(task, model) =
    capability_score    × 35%
  + quality_floor_pass  × 20%   (必须过门槛，否则 -∞)
  + cost_score          × 20%
  + stability_score     × 15%
  + speed_score         × 10%
```

**各分项计算**：

**capability_score**（0-100）：
- 按 complexity → tier 映射
- complex/deep 看 coding_worker 榜单分（V1 默认 coding 为主）
- simple/normal 可以考虑混合分

**quality_floor_pass**（硬门槛）：
- `complexity=deep` → 必须 tier=frontier
- `complexity=complex` → 必须 tier >= strong
- `complexity=normal` → 必须 tier >= standard
- `complexity=simple` → 必须 tier >= mini

**cost_score**（0-100）：
- plan 内模型且 quotaPressure=low → 100
- 同 tier 最便宜 → 80
- 同 tier 最贵 → 20

**stability_score**（0-100）：
- 100 = 失败率 < 2%
- 50 = 失败率 10%
- 0 = cooldown 中或失败率 > 20%

**speed_score**（0-100）：
- 基于 p95 first token，相对同 tier 其他模型

**用户 override 优先于所有打分**。

### 5.11 Shadow 和自动推广

**Shadow 流程**（所有候选模型从这里开始）：

1. 新模型加入 → `shadow` 状态
2. 每次委派时记 shadow event：实际用的模型 vs 推荐的模型
3. 累积 `actualModel / recommendedModel / quality / cost / latency / outcome`

**自动推广规则**（每日一次 scheduled evaluation）：

```
for each (model, complexity_tier) candidate in shadow:
  if samples < 30:
    → 继续观察
  if quality_regression > 5%:
    → 永久标记 failed，退出候选
  if cost_delta >= 0 (更贵或持平):
    → 退出候选
  if success_rate_delta >= -2% AND cost_delta < -10%:
    → auto-promote to live
  if success_rate_delta in [-5%, -2%]:
    → hold, 继续观察到 sample >= 100 再决定
  else:
    → hold, 报警给 operator review
```

**可观察性**：

- `octoclawctl router decisions` → 列出所有自动推广决策、evidence 和当时数据
- 每个 live model 标注 `since / reason / baseline_shadow_days`
- 每日 nightly report 里带上当日 promotion / rejection 摘要

**硬保护**：
- 自动推广只发生在 `configured=true` 模型之间
- 最大一天只推广 1 个（model, complexity_tier）组合
- 推广失败后 30 天内不能再尝试同组合

### 5.12 推荐错误的处理

委派失败或用户返工信号：

```
短期（sliding window 7 days）：
  该 (model, tier) 分数临时 -5 到 -15 分（按严重度）

中期（连续 3 次失败累积）：
  标记 dispreferred_for_this_tier，30 天内同分情况下优先避开

长期（failure rate > 20% 持续 2 周）：
  自动退出该 tier 的 live list，退回 shadow
```

**不互动询问**（Q11 否决了 D 选项）。用户随时通过 CLI override（Q9）。

### 5.13 Nightly Review（可选）

**V1 只提供轻量模式**（零 LLM 消耗）：
- 统计：失败率、成本对比、延迟分布、ignored_reason 计数
- 规则：连续失败自动降权、成本异常报警
- **所有用户默认开**

V2+ 才有深度模式（LLM review）。

## 6. 首次运行向导

### 6.1 流程

命令：`octoclawctl router wizard`（安装后自动提示）

```
OctoClaw Auto Router Setup
===========================

Step 1/7: 扫描已配置模型
发现 OpenClaw 配置的模型：
  ✓ openai/gpt-5.5 (configured)
  ✓ zhipu/glm-5.1 (configured)
  ✓ anthropic/claude-opus-4 (configured)

Step 2/7: 订阅套餐确认
以下模型是按 plan/subscription 订阅的吗？（y/n）
  - openai/gpt-5.5: _
  - zhipu/glm-5.1: _
  - anthropic/claude-opus-4: _

Step 3/7: 预算和成本敏感度
  1) 有月度预算 —— 请输入美元数: _
  2) 没有预算
  [2]: _

Step 4/7: 隐私边界
子任务能否用云端模型？
  1) 都可以
  2) 只能用本地或 on-prem
  3) 我来挑选
  [1]: _

Step 5/7: 语言偏好
主要任务语言：
  1) 中文
  2) 英文
  3) 混合（默认）
  [3]: _

Step 6/7: 受限模型
有没有必须禁用的 model 或 provider？(公司合规场景)
  (留空跳过): _

Step 7/7: 发现同供应商便宜候选
检测到 OpenAI 下还有：gpt-5-mini, gpt-5-nano
自动加入 live allowlist 参与 Auto Router 选模（推荐，你已经有 API key）
  [Y/n]: _

同检测到 Anthropic 下还有：claude-haiku-3, claude-sonnet-4
自动加入 live allowlist？
  [Y/n]: _

---
Saved to: ~/.openclaw/octoclaw/router-wizard.json
Run `octoclawctl router wizard` again to re-run.
Run `octoclawctl router model mark <model> --disabled` to disable specific models later.
```

### 6.2 Plan 类型推测

向导可以从模型名自动推测 plan：

```
openai/codex-* → OpenAI Codex plan
anthropic/claude-*-max → Claude Max plan
openrouter/* → OpenRouter credits
ollama/* → Local, no cost
```

推测结果仅作为默认值，用户可修改。

### 6.3 Wizard 结果文件

```json
// ~/.openclaw/octoclaw/router-wizard.json
{
  "schemaVersion": "octoclaw.router.wizard/v1",
  "completedAt": "2026-05-13T...",
  "plans": {
    "openai/gpt-5.5": { "isPlan": true, "type": "subscription" },
    "zhipu/glm-5.1": { "isPlan": false, "type": "pay_as_you_go" }
  },
  "budget": { "monthly": 100, "currency": "USD" },
  "privacy": "any_cloud",
  "language": "mixed",
  "restrictedModels": ["some/banned-model"],
  "autoAddDiscovered": true,
  "overrides": {}
}
```

### 6.4 配置变化触发增量更新

检测到 OpenClaw 配置变化时：

```
$ octoclaw 检测到配置变化
发现新模型：deepseek/deepseek-v4
自动添加到 allowlist，能力从 snapshot 加载。
若需要调整 plan 类型或 override，运行 `octoclawctl router wizard --incremental`.
```

不重问用户已经回答的问题，只问新模型相关的。

## 7. 成本报告

### 7.1 数据记录

每次 API 调用写入本地 SQLite（`~/.openclaw/octoclaw/cost.sqlite`）：

```sql
CREATE TABLE cost_events (
  ts TEXT NOT NULL,
  session_key TEXT,
  turn_id TEXT,
  model TEXT NOT NULL,
  provider TEXT,
  complexity TEXT,       -- simple / normal / complex / deep
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  cost_usd REAL,
  route TEXT,            -- reply / delegate
  outcome TEXT,          -- success / failure / timeout
  is_plan_call INTEGER,  -- 0/1, 是否 plan 内
  latency_ms INTEGER
);
CREATE INDEX idx_cost_ts ON cost_events(ts);
CREATE INDEX idx_cost_model ON cost_events(model);
```

### 7.2 报告格式（Q12 全粒度）

```
$ octoclawctl router cost report --period 7d

OctoClaw Auto Router — Cost Report (last 7 days)
=================================================

💰 Total spend: $34.50
   ▲ 本月至今: $47.20 / 预测月末: $98.30 (基于最近 7 天趋势)
   ⚠ 超出上月同期 $12.40 (+35%)

📊 按模型:
   openai/gpt-5.5           : $22.10 (64%)  ▼ -12% vs 上周
   zhipu/glm-5.1             : $8.80  (26%)  ▲ +40% (Auto Router 分配更多任务)
   openai/gpt-5-mini         : $2.40  (7%)
   其他                      : $1.20  (3%)

📊 按复杂度:
   simple    : $1.20  (3%)   主力: gpt-5-mini
   normal    : $10.20 (29%)  主力: glm-5.1
   complex   : $18.50 (54%)  主力: gpt-5.5
   deep      : $4.60  (13%)  主力: gpt-5.5

📊 按路径:
   reply (主 agent)   : $1.20  (4%)
   delegate (子 agent): $33.30 (96%)

💡 节省建议（已通过 shadow 验证）:
   → complex 切到 glm-5.1 可省 $14/月，质量 -2%（建议接受）
   → deep 保持 gpt-5.5，已最优
   → normal 已自动切换，本周节省 $6

⚠ 异常:
   - 5/11 complex 单日 $8（正常 ~$3），原因: 大量 retry（可能提示不清晰）
```

### 7.3 可用的时间范围

```bash
octoclawctl router cost report --period 1d    # 当天
octoclawctl router cost report --period 7d    # 最近 7 天（默认）
octoclawctl router cost report --period 30d   # 最近 30 天
octoclawctl router cost report --period month # 本月
octoclawctl router cost report --format json  # 可供脚本消费
```

### 7.4 预算警告

每次任务完成后检查：
- 本月已用 > 80% budget → 发轻量警告
- 本月已用 > 100% budget → 自动切换到 `cost_first` 模式（V1 降级到只用 plan 模型）

## 8. CLI 接口

### 8.1 配置和状态

```bash
octoclawctl router status               # 整体健康状态
octoclawctl router wizard               # 完整向导
octoclawctl router wizard --incremental # 增量向导（只问新模型）
octoclawctl router judge status         # Judge 状态
octoclawctl router judge test "<prompt>" # 测试 judge 输出
octoclawctl router judge config         # 查看/改配置
```

### 8.2 能力和快照

```bash
octoclawctl router capability refresh        # 拉最新榜单 + catalog
octoclawctl router capability list           # 列出所有已知模型
octoclawctl router capability show <model>   # 查看某模型详细能力
octoclawctl router capability probe <model>  # 跑 smoke probe 测试
```

### 8.3 Shadow 和推广

```bash
octoclawctl router shadow report             # Shadow 对比报告
octoclawctl router shadow list               # 列出 shadow 中的候选
octoclawctl router decisions                 # 所有自动推广决策
octoclawctl router decisions --since 7d      # 最近 7 天的决策
```

### 8.4 用户 override（Q9 三种颗粒度）

```bash
# 直接改分
octoclawctl router score override <model> <tier>=<score>
octoclawctl router score override openai/gpt-5.5 complex=75

# 软标记
octoclawctl router model mark <model> --dispreferred-for <tier> --reason "<text>"
octoclawctl router model mark openai/gpt-5.5 --dispreferred-for complex --reason "我用起来不稳定"

# 硬禁用
octoclawctl router model ban <model> --for <tier>
octoclawctl router model ban openai/gpt-5.5 --for research

# 清除
octoclawctl router score reset <model>
octoclawctl router model unban <model>
```

### 8.5 成本

```bash
octoclawctl router cost report [--period 7d] [--format text|json]
octoclawctl router cost budget show
octoclawctl router cost budget set --monthly 100
```

## 9. 插件化

### 9.1 包结构

```
packages/octoclaw-router/
├── src/
│   ├── index.ts                 # public API
│   ├── semantic/                # Judge
│   │   ├── judge.ts
│   │   ├── cache.ts
│   │   └── fallback.ts
│   ├── decision/                # Decision Layer
│   │   ├── scoring.ts
│   │   ├── capability-snapshot.ts
│   │   ├── shadow.ts
│   │   └── promotion.ts
│   ├── providers/               # 可替换 providers
│   │   ├── capability-provider.ts
│   │   ├── cost-provider.ts
│   │   └── leaderboard-loader.ts
│   ├── data/                    # 打包的榜单快照
│   │   └── leaderboard-snapshot.json
│   └── cli/                     # CLI handlers（integration 层用）
└── package.json
```

### 9.2 公开 API

```ts
// packages/octoclaw-router/src/index.ts

export function createRouter(options: RouterOptions): Router;

export interface RouterOptions {
  judgeConfig: JudgeConfig;
  capabilityProvider?: CapabilityProvider;     // 默认使用打包 snapshot
  costProvider?: CostProvider;                 // 默认使用本地 SQLite
  leaderboardLoader?: LeaderboardLoader;       // 默认加载打包 JSON
  shadowStorage?: ShadowStorage;               // 默认 JSONL 文件
  telemetryEmitter?: TelemetryEmitter;         // 默认 no-op
  userOverrides?: UserOverrides;               // 默认空
}

export interface Router {
  // Semantic Layer
  judge(input: JudgeInput): Promise<JudgeOutput>;

  // Decision Layer
  recommend(input: RecommendInput): Promise<Recommendation>;

  // Management
  refreshCapability(): Promise<void>;
  promoteCandidate(model: string, tier: string): Promise<void>;
  getCostReport(period: Period): Promise<CostReport>;
}
```

### 9.3 未来独立开源

`@octoclaw/router` 从现在设计就保持独立可抽：

- 不依赖 OpenClaw 特定类型
- 不依赖 OctoClaw 的 runtime state
- 所有 OctoClaw 集成通过 provider 注入

独立开源时：
- 仓库名建议 `policy-router` 或 `agent-router`（中性名）
- OctoClaw 作为 integration example 在 README 展示
- 榜单数据独立版本管理
- 对其他项目（Continue、Aider、Cursor、AutoGen）都能用

## 10. 目录和文件布局

```
packages/octoclaw-router/              # 独立 package（新）
  src/
    index.ts
    semantic/
    decision/
    providers/
    data/leaderboard-snapshot.json
    cli/

extensions/octoclaw-runtime/src/
  router-lite/                         # 现有，V1 会迁移到 @octoclaw/router
    → 逐步移除，保留 shadow-bridge 作为 integration 层
  resolve/llm-judge.ts                 # 现有 judge 移到 @octoclaw/router/semantic
    → 移除，保留适配层

tools/octoclawctl/src/
  router/                              # CLI commands（新）
    wizard.ts
    capability.ts
    shadow.ts
    decisions.ts
    score.ts
    cost.ts

~/.openclaw/octoclaw/                  # 运行时数据
  router-wizard.json
  cost.sqlite
  router-lite/
    model-intel-snapshot.json
    shadow.jsonl
    decisions.log
```

## 11. V1 范围（必做）

按优先级（P0 = blocker，P1 = 重要，P2 = 锦上添花但 V1 范围内）：

| # | 功能 | 优先级 |
|---|---|---|
| 1 | 抽 `@octoclaw/router` 独立包 | P0 |
| 2 | Judge V1 schema（3 字段）+ 缓存 + fallback | P0 |
| 3 | Capability Snapshot + Leaderboard 打包 | P0 |
| 4 | Cost / Plan / Health 数据模型 + SQLite | P0 |
| 5 | Scoring Engine（单模式 balanced） | P0 |
| 6 | Shadow Event + Auto-promotion（数据驱动） | P0 |
| 7 | 首次运行向导（7 步） | P1 |
| 8 | CLI 命令集（status / wizard / capability / decisions / score / cost） | P1 |
| 9 | 成本报告（全粒度 + 预测） | P1 |
| 10 | 用户 override（3 种颗粒度） | P1 |
| 11 | 配置变化自动触发能力刷新 | P1 |
| 12 | Plan 快用完时自动切 + 轻量提示 | P2 |
| 13 | Nightly 轻量 review（统计 + 规则） | P2 |

**V1 明确不做**（Future Considerations）：
- Scenario 分层（V2）
- Nightly LLM review / 深度模式（V2）
- 多偏好模式 cost_first / reliable_fast（V2）
- 分层 judge Tier 0/1/2（不做，历史证明不靠谱）
- 社区数据共享（V3）
- Self-calibrating judge（V3）
- 路由规则编辑模式（V3）
- 独立 npm 包发布（V2，V1 内部使用）

## 12. 交付路径

### Phase A：拆包 + Judge 整合（1-2 周）

- 新建 `packages/octoclaw-router`
- 把 `policy/router-lite` 搬进去
- 把 `resolve/llm-judge` 搬进 `semantic/judge.ts`
- Runtime 通过 integration 层调用（保持现有 API 兼容）
- 测试全部通过

### Phase B：能力快照 + Scoring（2-3 周）

- 榜单 snapshot 打包机制
- Capability / Cost / Health 数据模型
- Scoring Engine 实现
- OpenClaw 配置变化 watcher

### Phase C：Shadow + Promotion（1-2 周）

- Shadow event 接线（已部分完成）
- Auto-promotion 评估器
- `octoclawctl router decisions` CLI
- Nightly 轻量 review

### Phase D：向导 + Override（1-2 周）

- `octoclawctl router wizard` 7 步交互
- 用户 override CLI（3 种颗粒度）
- 成本报告 + 预测

### Phase E：打磨（1 周）

- 端到端 smoke
- 文档
- 发布 v0.6.0

**预计总时长**：5-10 周（取决于外部数据接入的复杂度）。

## 13. Future Considerations（V2+）

以下都**不在 V1 做**，列出来供以后参考：

**V2**：
- **Scenario 字段**：judge 输出增加 `scenario: "coding_style" | "research" | "agentic"`，能力分按场景匹配
- **多偏好模式**：`cost_first` / `reliable_fast` / `balanced` 可切换
- **Nightly LLM review（深度模式）**：用便宜模型分析 shadow events 给结构化建议
- **独立 npm 包**：`@octoclaw/router` 发布到 npm，支持其他项目集成

**V3**：
- **社区数据共享**：用户 opt-in 上传匿名 outcome 聚合
- **Self-calibrating judge**：基于社区数据持续 fine-tune
- **路由规则编辑模式**：用户可写 YAML 规则 override judge
- **高级预算控制**：按项目 / 按人员分 budget
- **API 兼容层**：兼容 OpenAI chat completions 协议，变成一个独立的 gateway

## 14. 硬约束（V1 不能违反）

1. Judge 输出永远 3 字段，不扩张
2. 不做关键词匹配，只用结构化信号 + judge 判断
3. 未配置模型永远不进 live（不论推荐多好）
4. `quotaPressure=unknown` 永远不当免费
5. 子 agent 自动切换模型，主 agent 模型永远不静默切换
6. Shadow 失败绝不影响 live route
7. Judge 失败绝不阻塞主流程（必须有 fallback）
8. 所有用户数据（cost、shadow、decisions）只存本地，V1 不上传任何地方
9. 委派时必须在 footer 展示实际用的模型
10. 自动推广只发生在已 configured 模型之间

## 15. 相关文档

- 现有运行路径：`docs/octoclaw-ts-rebuild-design-v2.md`
- Runtime 模块图：`docs/octoclaw-architecture-map-2026-05-09.md`
- Gate convergence：`docs/octoclaw-runtime-gate-convergence-design-2026-05-12.md`
- Timeout watchdog：`docs/octoclaw-timeout-watchdog-evidence-design-2026-05-12.md`
- Archive（老版本）：
  - `docs/octoclaw-phase5-auto-router-design-2026-04-30.md`（legacy，保留不删）
  - `docs/octoclaw-auto-router-lite-cost-model-design-2026-05-08.md`（Lite scope，已折叠进 v3）

## 16. 开放问题（留给实现时回答）

这些 V1 实现时要处理，设计层面不强制答：

- Judge fallback 触发时是否也写 shadow event？（建议写，标 `mode=fallback`）
- 用户如果不跑向导，默认行为是什么？（建议：走保守规则 + 用 snapshot 默认值）
- 成本 SQLite 损坏时怎么办？（建议：重建空库，不影响路由）
- 榜单 snapshot 过期很严重（比如 > 3 个月未更新）怎么报警？

---

*End of design document.*
