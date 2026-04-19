# judge_fast 实现计划

> 状态：实现计划（2026-04-19）
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
| `user_message` | prompt text | 用户原始消息 |
| `session_binding` | ctx metadata | session key、thread id、channel |
| `recent_ledger_summary` | policy state | 最近 execution facts（有/无 active task、上次 route） |
| `available_targets` | 硬编码 | `current_session`、`local_probe`、`spawn_work` |
| `available_actions` | 硬编码 | `answer_direct`、`local_probe`、`spawn_work` |

### 2.2 judge_fast 输出（JSON schema only）

```json
{
  "route": "reply | delegate.single | observe",
  "request_kind": "surface_query | direct_answer | delegated_task | control_action | observation_probe",
  "scope": "current_session | local_probe | spawn_work",
  "confidence": 0.0-1.0,
  "abstain_reason": "string | null",
  "reason_codes": ["string"],
  "evidence_required": false,
  "ack_required": true
}
```

### 2.3 约束

- **无工具** — 纯 JSON-in/JSON-out，不调工具
- **短上下文** — ≤1-2k tokens input
- **schema strict** — 输出必须符合 schema，否则 fallback
- **超时兜底** — judge 超时或 schema invalid → planner fallback（当前 `decideRoute()`）
- **低置信弃权** — confidence < 阈值 → abstain → fallback to direct
- **结果记录** — 写入 execution ledger / replay log

### 2.4 级联策略

```
hard-boundary gate（结构化信号，无 LLM）
  → judge_fast（LLM call，timeout 2s）
    → planner fallback（当前 decideRoute 纯规则）
```

Phase 1 只做一层 judge + fallback，不做 multi-tier cascade。

### 2.5 模型

v1 设计指定 `judge_fast → minimax-portal/MiniMax-M2.7`，但当前 omniroute 不可用。
实际可用选项：
- `cliproxyapi/gpt-5.4`（localhost:8317）— 当前 direct_main 也在用
- 或配置为任何 OpenAI-compatible endpoint

模型通过 `openclaw.json` plugin config 可配置。

---

## 3. 实现方案

### 3.1 文件结构

```
packages/octoclaw-policy/src/
  judge/
    index.ts          — 已有，当前是纯规则 decideRoute
    llm-judge.ts      — 新增：LLM judge adapter
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
  userMessage: string;
  sessionBinding?: string;
  recentLedgerSummary?: string;
  availableTargets: string[];
  availableActions: string[];
}

interface JudgeOutput {
  route: "reply" | "delegate.single" | "observe";
  requestKind: string;
  scope: string;
  confidence: number;
  abstainReason: string | null;
  reasonCodes: string[];
  evidenceRequired: boolean;
  ackRequired: boolean;
}

interface JudgeConfig {
  modelId: string;
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;        // 默认 2000
  minConfidence: number;    // 默认 0.6
}

// 核心函数
async function callLlmJudge(input: JudgeInput, config: JudgeConfig): Promise<JudgeOutput | null>
```

实现方式：
1. 构造 system prompt（固定，含 schema 定义 + few-shot）
2. 构造 user prompt（JudgeInput 字段序列化）
3. 调 OpenAI-compatible `/chat/completions`（`response_format: { type: "json_object" }`）
4. 解析 + validate JSON output
5. 超时 / schema invalid / confidence < min → return null（触发 fallback）

### 3.3 新增：`judge-prompt.ts`

System prompt 核心内容：
- 你是 OctoClaw 路由判定器
- 只允许输出指定 JSON schema
- route 只有三种：`reply`（主agent直接答）、`delegate.single`（派子agent）、`observe`（只读探测）
- 判定依据：任务复杂度、是否需要多步执行、是否涉及代码修改、是否只是简单问答
- 低置信时 abstain，不要硬判

Few-shot examples（3-5个）：
- "你好" → reply, confidence=0.95
- "帮我重构这个文件" → delegate.single, confidence=0.85
- "看下8080端口" → observe, confidence=0.9
- "分析下这个系统的架构" → delegate.single, confidence=0.8
- "刚才那个任务完成了吗" → reply (follow-up), confidence=0.7

### 3.4 修改：`policy-resolver.ts`

在 `resolveStatelessPolicyDecision` 里：

```typescript
// 当前流程（纯规则）
const decision = buildDecision(prompt, { metadata }); // → judgePolicy → decideRoute

// 改为
const judgeResult = await callLlmJudge(buildJudgeInput(prompt, metadata), judgeConfig);

if (judgeResult && judgeResult.confidence >= minConfidence) {
  // LLM judge 成功 → 用 judge 结果构建 decision
  decision = buildDecisionFromJudgeResult(judgeResult, metadata);
} else {
  // fallback → 当前纯规则
  decision = buildDecision(prompt, { metadata });
}
```

### 3.5 配置

`openclaw.json`:
```json
{
  "plugins": {
    "entries": {
      "octoclaw-runtime": {
        "config": {
          "judgeFast": {
            "enabled": true,
            "modelId": "cliproxyapi/gpt-5.4",
            "baseUrl": "http://localhost:8317/v1",
            "apiKey": "sk-local-cliproxyapi",
            "timeoutMs": 2000,
            "minConfidence": 0.6
          }
        }
      }
    }
  }
}
```

`enabled: false` 时完全跳过 LLM judge，走纯规则（当前行为）。

---

## 4. 实现步骤

### Step 1: judge schema + prompt（纯数据，无副作用）
- `packages/octoclaw-policy/src/judge/judge-schema.ts`
- `packages/octoclaw-policy/src/judge/judge-prompt.ts`

### Step 2: LLM judge adapter（纯函数，无 hook 集成）
- `packages/octoclaw-policy/src/judge/llm-judge.ts`
- 包含 HTTP 调用、JSON parse、schema validate、timeout、fallback

### Step 3: 集成到 policy-resolver
- 修改 `resolveStatelessPolicyDecision`
- 从 pluginConfig 读 judge 配置
- judge 成功 → 用 judge route
- judge 失败/超时/低置信 → fallback 到 `buildDecision`

### Step 4: 测试
- 单元测试：schema validation、JSON parse、timeout fallback
- 集成测试：mock LLM → verify route decision
- replay 测试：用已有 replay log 跑 judge，对比结果

### Step 5: 渐进上线
- 默认 `enabled: false`
- 先 shadow mode：调 judge 但不使用结果，只记录 replay
- 确认准确率后 `enabled: true`

---

## 5. 风险 & 缓解

| 风险 | 缓解 |
|------|------|
| judge 慢（>2s）拖慢首响 | timeout 2s + fallback；pre-route ACK 兜底 |
| judge 输出 schema 不合规 | JSON schema validation → fallback |
| judge 误判（该 delegate 判成 reply） | v1 不追求完美；sticky lane 减少 lane 抖动 |
| 额外 LLM 调用成本 | judge 用便宜模型；短上下文；结果短 TTL cache |
| judge 不可用（模型挂了） | fallback 到纯规则（当前行为），无退化 |

---

## 6. 验收标准

1. LLM judge 可独立调用，输入输出符合设计 spec
2. `enabled: false` 时行为与当前完全一致（无退化）
3. judge 超时/失败时正确 fallback 到 `decideRoute`
4. judge 结果写入 replay log（可观测）
5. 部分用户消息（如"帮我重构"）能被正确判为 `delegate.single`
6. 简单问答（如"你好"）被正确判为 `reply`
