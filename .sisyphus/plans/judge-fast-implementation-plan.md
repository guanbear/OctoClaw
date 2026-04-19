# judge_fast 实现计划

> 状态：实现计划 v2（2026-04-19，经 Oracle + Momus 审核修订）
> 关联设计：`octoclaw-ts-rebuild-design-v1.md` §9.2.0, `octoclaw-router-policy-refactor-2026-04-10.md` §2.3, §3.2
> 目标：在 OctoClaw TS rebuild 中实现 LLM-based semantic judge，替换纯规则路由

---

## 1. 问题

当前 `decideRoute()` 是纯规则判断，只看 `requestedRoute`、`hardBoundaryControl`、`requiresDelegation` 等结构化信号。由于 hook context 不携带这些字段，所有请求都落入默认 "reply"（direct）。

设计文档明确要求：

> **不是 rule-first，而是 judge-first；规则只保留在硬边界处。**

当前缺少 `small judge model` 这一层。

---

## 2. 设计稿 Spec 对齐

### 2.1 judge_fast 输入（≤1-2k tokens）

| 字段 | 来源 | 说明 |
|------|------|------|
| `user_message` | prompt text | 用户原始消息，**严格 size cap 500 chars**，防止 prompt injection 放大 |
| `session_binding` | ctx metadata | session key、thread id、channel |
| `recent_ledger_summary` | policy state | 最近 execution facts（有/无 active task、上次 route），**cap 200 chars** |
| `available_targets` | 硬编码 | `current_session`、`local_probe`、`spawn_work` |
| `available_actions` | 硬编码 | `answer_direct`、`local_probe`、`spawn_work` |

### 2.2 judge_fast 输出（JSON schema only）

与设计稿 `octoclaw-router-policy-refactor-2026-04-10.md` §2.3 完全对齐：

```json
{
  "route": "reply | delegate.single | observe | undetermined",
  "request_kind": "surface_query | direct_answer | delegated_task | control_action | observation_probe | undetermined",
  "scope": "current_session | local_probe | spawn_work",
  "target": "string",
  "confidence": 0.0-1.0,
  "abstain_reason": "string | null",
  "reason_codes": ["string"],
  "evidence_required": false,
  "ack_required": true,
  "budget_band": "low | medium | high"
}
```

**与设计稿对齐的关键点：**
- `target` 字段：设计稿 §2.3 明确要求，表示路由目标（如 `current_session`、`macmini`）
- `budget_band` 字段：设计稿 §2.3 明确要求，影响后续 model profile 选择
- `undetermined` route：设计稿 §2.4 允许低置信时输出 `undetermined`，而非强制三选一
- **热路径只消费 `route` + `confidence` + `abstain_reason`**（Oracle 建议：最小化热路径依赖字段）
- 其余字段（`request_kind`、`scope`、`target`、`budget_band`、`reason_codes`）写入 replay log 供离线分析，不直接参与 live path 决策

### 2.3 约束

- **无工具** — 纯 JSON-in/JSON-out，不调工具
- **短上下文** — ≤1-2k tokens input，`user_message` cap 500 chars，`recent_ledger_summary` cap 200 chars
- **schema strict** — 输出必须符合 schema，否则 fallback
- **超时兜底** — judge 超时或 schema invalid → planner fallback（当前 `decideRoute()`）
- **低置信弃权** — confidence < 阈值 或 route=`undetermined` → abstain → **fallback 到规则决策（不一定是 direct）**
- **结果记录** — 写入 execution ledger / replay log
- **prompt injection 防护** — user_message 作为 data field 传入，不嵌入 system prompt 模板；judge 无特权操作能力
- **递归防护** — judge 的 HTTP 请求带 `x-octoclaw-internal: judge` header，OpenClaw 侧如果识别到该 header 应跳过 hook 处理

### 2.4 级联策略

```
hard-boundary gate（结构化信号，无 LLM，只看 session state / task_id / permissions）
  → judge_fast（独立 HTTP LLM call，timeout ≤1500ms，race against 规则基线）
    → planner fallback（当前 decideRoute 纯规则）
```

**关键设计决策（Oracle 审核）：先算规则决策，再 race judge**

```typescript
// 并行计算规则基线和 LLM judge
const ruleDecision = buildDecision(prompt, { metadata });  // 立即，同步
const judgeResult = await callLlmJudge(input, config);     // 异步，bounded

// judge 成功且高置信 → 覆盖 route；否则用规则基线
if (judgeResult && judgeResult.confidence >= minConfidence && judgeResult.route !== "undetermined") {
  return mergeJudgeIntoDecision(ruleDecision, judgeResult, metadata);
} else {
  return ruleDecision;  // fallback 到规则决策（可能是 reply/observe/delegate 中的任一种）
}
```

Phase 1 只做一层 judge + fallback，不做 multi-tier cascade。

### 2.5 模型

v1 设计指定 `judge_fast → minimax-portal/MiniMax-M2.7`，但当前 omniroute 不可用。
实际可用选项：
- `cliproxyapi/gpt-5.4`（localhost:8317）— 当前 direct_main 也在用
- 或配置为任何 OpenAI-compatible endpoint

模型通过 `~/.openclaw/openclaw.json` plugin config 可配置（见 §3.5）。

---

## 3. 实现方案

### 3.1 文件结构

```
packages/octoclaw-policy/src/
  judge/
    index.ts          — 已有，当前是纯规则 decideRoute
    llm-judge.ts      — 新增：LLM judge adapter（独立 HTTP，不走 OpenClaw hook）
    judge-prompt.ts   — 新增：system prompt + few-shot examples
    judge-schema.ts   — 新增：output JSON schema 定义 + validation
extensions/octoclaw-runtime/src/
  resolve/
    policy-resolver.ts — 修改：集成 llm-judge 到 resolveStatelessPolicyDecision
```

### 3.2 新增：`llm-judge.ts`

```typescript
// 核心 interface
interface JudgeInput {
  userMessage: string;       // cap 500 chars
  sessionBinding?: string;
  recentLedgerSummary?: string;  // cap 200 chars
  availableTargets: string[];
  availableActions: string[];
}

// 热路径只消费这 3 个字段
interface JudgeOutput {
  route: "reply" | "delegate.single" | "observe" | "undetermined";
  confidence: number;
  abstainReason: string | null;
  // 以下字段写入 replay log，不直接参与 live path
  requestKind?: string;
  scope?: string;
  target?: string;
  budgetBand?: "low" | "medium" | "high";
  reasonCodes?: string[];
  evidenceRequired?: boolean;
  ackRequired?: boolean;
}

interface JudgeConfig {
  enabled: boolean;
  modelId: string;
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;        // 默认 1500（Oracle 建议：比 2s 更紧）
  minConfidence: number;    // 默认 0.6
  shadowMode: boolean;      // 默认 true，只记录不使用
}

// 核心函数：返回 null 表示 judge 不可用（超时/schema invalid/低置信）
async function callLlmJudge(input: JudgeInput, config: JudgeConfig): Promise<JudgeOutput | null>
```

实现方式：
1. 构造 system prompt（固定，含 schema 定义 + few-shot）
2. 构造 user prompt（JudgeInput 字段序列化为 JSON，user_message 作为 data field）
3. 调 OpenAI-compatible `/chat/completions`（`response_format: { type: "json_object" }`）
   - **独立 HTTP 调用**，不走 OpenClaw hook 栈（避免递归）
   - 请求带 `x-octoclaw-internal: judge` header
4. 解析 + validate JSON output（宽松 parse，严格 validate）
   - 先尝试直接 JSON.parse
   - 如果模型返回了非 JSON 文本，用 regex 提取第一个 JSON object
   - validate 只检查热路径必需字段（`route` + `confidence`）
5. 超时 / parse 失败 / schema invalid / confidence < min / route=`undetermined` → return null

### 3.3 新增：`judge-prompt.ts`

System prompt 核心内容：
- 你是 OctoClaw 路由判定器
- 只允许输出指定 JSON schema
- route 有四种：`reply`（主agent直接答）、`delegate.single`（派子agent）、`observe`（只读探测）、`undetermined`（不确定时弃权）
- 判定依据：任务复杂度、是否需要多步执行、是否涉及代码修改、是否只是简单问答
- 低置信时 abstain（输出 `undetermined`），不要硬判
- **不做 model 的 tool/agent**：你是一个无状态分类器

Few-shot examples（5个，覆盖各种 route）：
- "你好" → `{"route":"reply","confidence":0.95,"reason_codes":["greeting"]}`
- "帮我重构这个文件" → `{"route":"delegate.single","confidence":0.85,"reason_codes":["code_modification","multi_step"]}`
- "看下8080端口" → `{"route":"observe","confidence":0.9,"reason_codes":["read_only_probe"]}`
- "分析下这个系统的架构" → `{"route":"delegate.single","confidence":0.8,"reason_codes":["complex_research"]}`
- "刚才那个任务完成了吗" → `{"route":"reply","confidence":0.7,"reason_codes":["follow_up"]}`
- "我想让你帮我…" → `{"route":"undetermined","confidence":0.3,"abstain_reason":"ambiguous_intent"}`

### 3.4 修改：`policy-resolver.ts`

在 `resolveStatelessPolicyDecision` 里：

```typescript
// 当前流程（纯规则）保留为基线
const ruleDecision = buildDecision(prompt, { metadata });

// 如果 judge 未启用，直接返回规则决策
if (!judgeConfig.enabled) {
  // 现有 applyPhaseTwoLivePathPolicy 流程不变
}

// 并行：先算规则基线（同步），再调 LLM judge（异步 bounded）
const judgeResult = await callLlmJudge(buildJudgeInput(prompt, metadata), judgeConfig);

if (judgeConfig.shadowMode) {
  // Shadow mode：只记录到 replay log，不使用 judge 结果
  recordJudgeShadowLog(judgeResult, ruleDecision, metadata);
  // 继续用 ruleDecision
} else if (judgeResult && judgeResult.confidence >= minConfidence && judgeResult.route !== "undetermined") {
  // Active mode：judge 覆盖 route（merge 而非替换整个 decision）
  // judge 只改 route 字段，保留 role/backend/workspace/model_profile 的规则计算
  return mergeJudgeRouteIntoDecision(ruleDecision, judgeResult, metadata);
}

// fallback：用规则基线（可能是 reply/observe/delegate 中的任一种）
// 继续现有的 applyPhaseTwoLivePathPolicy 流程
```

**merge 策略（Oracle 建议）：judge 只影响 route，不改其他决策**
- `route` → 从 judge 结果
- `role` → 从规则计算（route 变了 role 会跟着变）
- `backend`/`workspace_mode`/`model_profile` → 从规则计算
- `admission`/`caps` → 从规则计算
- hard-boundary constraints（`requiresDelegation`、`hardBoundaryControl`）→ 始终优先于 judge

### 3.5 配置

配置存储在 `~/.openclaw/openclaw.json`（不在仓库里，是运行时配置文件）。

读取路径：`pi.pluginConfig.judgeFast`（在 `register(pi)` 里读取，和 `ackTimerFirstTierMs` 同一方式）

```json
{
  "plugins": {
    "entries": {
      "octoclaw-runtime": {
        "config": {
          "judgeFast": {
            "enabled": true,
            "shadowMode": false,
            "modelId": "cliproxyapi/gpt-5.4",
            "baseUrl": "http://localhost:8317/v1",
            "apiKey": "sk-local-cliproxyapi",
            "timeoutMs": 1500,
            "minConfidence": 0.6
          }
        }
      }
    }
  }
}
```

- `enabled: true`（默认）— judge 作为模块化能力默认开启，提供语义路由
- `enabled: false` — 关闭 judge，所有请求走 direct（当前纯规则行为）
- `enabled: true, shadowMode: true` — 调 judge 但不使用结果，只写 replay log（观测期使用）
- `enabled: true, shadowMode: false`（默认）— judge 结果参与路由决策

**模块化设计**：judge 是 `packages/octoclaw-policy` 内的独立模块（`judge/` 目录），通过配置开关控制。关闭时零开销——不调 HTTP、不读配置、不走任何 judge 代码路径。插件入口 `extension-entry.ts` 在 `register()` 时读取配置，决定是否传入 judge config。

### 3.6 可观测性（Oracle 建议）

在 replay log 里记录每次 judge 调用：
- `judge_latency_ms` — judge 调用耗时
- `judge_timeout` — 是否超时
- `judge_parse_failure` — JSON 解析是否失败
- `judge_route` — judge 输出的 route
- `judge_confidence` — judge 输出的 confidence
- `judge_abstain` — 是否弃权
- `rule_route` — 规则基线的 route
- `final_route` — 最终使用的 route
- `judge_override` — judge 是否覆盖了规则基线
- `mode` — shadow / active

---

## 4. 实现步骤

### Step 1: judge schema + prompt（纯数据，无副作用）
- `packages/octoclaw-policy/src/judge/judge-schema.ts`
- `packages/octoclaw-policy/src/judge/judge-prompt.ts`
- **验证**：`pnpm build` 通过；schema validation 函数的单元测试通过

### Step 2: LLM judge adapter（纯函数，无 hook 集成）
- `packages/octoclaw-policy/src/judge/llm-judge.ts`
- 包含 HTTP 调用、JSON parse（宽松）+ schema validate（严格）、timeout、fallback
- **验证**：
  - 单元测试：mock HTTP → 返回合法 JSON → `JudgeOutput.route === "delegate.single"`
  - 单元测试：mock HTTP → 返回非法文本 → `null`（fallback）
  - 单元测试：mock HTTP → timeout → `null`（fallback）
  - 单元测试：mock HTTP → 返回 `confidence: 0.3` → `null`（低置信 fallback）
  - 单元测试：mock HTTP → 返回 `route: "undetermined"` → `null`（弃权 fallback）

### Step 3: 集成到 policy-resolver
- 修改 `resolveStatelessPolicyDecision`
- 从 `pi.pluginConfig` 读 judge 配置（`ackTimerFirstTierMs` 同一读取模式）
- judge 成功 → merge route into decision
- judge 失败/超时/低置信/undetermined → fallback 到 rule decision
- **验证**：
  - `enabled: false` → 行为与当前完全一致（对比 replay log 无差异）
  - `shadowMode: true` → replay log 出现 judge 字段但 final_route 不变
  - `shadowMode: false` + mock judge 返回 `delegate.single` → decision 的 route 变为 `spawn_single`
  - mock judge timeout → fallback 到 rule decision（默认 reply）

### Step 4: 渐进上线
- Phase A：`enabled: true, shadowMode: true` — 收集 replay log 1-2 天
- Phase B：分析 shadow log：
  - judge 与规则的 disagreement rate
  - judge 的 timeout/failure/abstain rate
  - judge latency p50/p95/p99
- Phase C：如果指标健康 → `shadowMode: false` 先在低风险消息上 active
- Phase D：全面 active

---

## 5. 风险 & 缓解

| 风险 | 缓解 |
|------|------|
| judge 慢拖慢首响 | timeout 1500ms + fallback 到规则基线（不是默认 direct）；pre-route ACK 兜底 |
| judge 输出 schema 不合规 | 宽松 JSON parse + 严格 schema validate → null → fallback |
| judge 误判（该 delegate 判成 reply） | v1 不追求完美；sticky lane 减少 lane 抖动；shadow mode 先观测 |
| 额外 LLM 调用成本 | 短上下文（≤1-2k tokens）；同 session memoization（已有 policyState） |
| judge 不可用（模型挂了） | fallback 到规则决策（当前行为），无退化 |
| 递归（judge 触发 hook → hook 又调 judge） | 独立 HTTP 调用 + `x-octoclaw-internal` header 防递归 |
| prompt injection 通过 user_message 操控 route | user_message 作为 data field 传入，不嵌入 system prompt；judge 无特权操作 |
| 规则基线和 judge 决策不一致时的 merge 逻辑复杂 | judge 只影响 `route` 字段，其余全部走规则计算 |
| false positive（简单问答被误判为 delegate） | shadow mode 先观测 false positive rate；minConfidence 可调 |

---

## 6. 验收标准

### 6.1 功能验收

| # | 标准 | 验证方式 |
|---|------|----------|
| 1 | LLM judge 可独立调用，输入输出符合 schema | 单元测试：`callLlmJudge(mockInput, config)` → `JudgeOutput` with valid `route` |
| 2 | `enabled: false` 时行为与当前完全一致 | 对比 replay log：无 judge 字段，route 与当前一致 |
| 3 | judge 超时时正确 fallback | mock HTTP timeout → `null` → rule decision |
| 4 | judge schema invalid 时正确 fallback | mock 返回 `{invalid}` → parse fail → rule decision |
| 5 | judge 低置信时正确 fallback | mock 返回 `confidence: 0.3` → rule decision |
| 6 | judge undetermined 时正确 fallback | mock 返回 `route: "undetermined"` → rule decision |
| 7 | shadow mode 只记录不决策 | `shadowMode: true` → replay log 有 judge 字段，final_route = rule_route |
| 8 | active mode judge 覆盖 route | `shadowMode: false` + mock `delegate.single` → final route = `spawn_single` |

### 6.2 回归验收

| # | 标准 | 验证方式 |
|---|------|----------|
| 9 | 所有现有测试通过 | `pnpm test` — 170 tests pass |
| 10 | ACK 机制不受影响 | 发 Slack 消息 → ACK 在 thread 里，无重复 |
| 11 | model provider 切换正常 | cliproxyapi/gpt-5.4 正常回复 |

### 6.3 可观测验收

| # | 标准 | 验证方式 |
|---|------|----------|
| 12 | replay log 包含 judge 字段 | `grep judge_ replay.log` → 出现 `judge_latency_ms`、`judge_route`、`judge_override` 等 |
| 13 | judge latency 可追踪 | replay log 中 `judge_latency_ms` 有实际数值 |
