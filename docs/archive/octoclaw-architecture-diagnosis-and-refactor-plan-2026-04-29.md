# OctoClaw 架构诊断与重构方案

> 日期：2026-04-29（judge 部分更新于同日）  
> 分支：`release/0.3.0-ts-rebuild`  
> 方法：通读全部 TypeScript 源码（extensions/packages）+ 历史 SKILL.md + 所有 docs/  
> 立场：独立判断，不被项目自身的 agent 总结所左右

---

## 一、核心判断（先说结论）

**项目方向正确，但有六个结构性问题导致不稳定，必须彻底解决；另有五个代码质量问题，影响可维护性和扩展性：**

结构性问题（P0-P5）：
1. **Completion Protocol 缺失** — child agent 完成后没有显式结构化信号，父 session 靠猜
2. **DetachedTaskRuntime 用了 OpenClaw minified bundle aliases** — 反向工程闭源包，随时断
3. **Live path 的 `before_prompt_build` hook 太厚且缺乏容错** — judge 超时会阻塞整个链路
4. **Judge 架构过度设计** — local/remote 双 judge + 升级逻辑，实际 remote judge 默认 disabled，整层没有意义
5. **IM Adapter 硬编码 Slack** — 无注册机制，要支持其他 IM 必须改核心文件，阻碍开源扩展
6. **`PolicyStateEntry` 类型安全失效** — `[key: string]: unknown` 导致 TypeScript 无法检查，产生大量防御代码

代码质量问题（P7-P15）：
7. ACK 时间常量两份，潜在同步问题
8. `"lost"` 基底状态映射到 `"queued"`（应为 `"failed"`）
9. `delegate-packets.ts` 有 runtime throw，dispatch 路径上可能崩溃
10. Slack adapter 每条消息 spawn 子进程，有 overhead
11. `policy-state.ts` 的 `entries()` 通过 type cast 访问私有属性
12. **ACK/Progress 两套系统并行**，职责重叠，三处重复发送代码，模板池 ~100 条文案却是随机选择，`no_valid_thread_anchor` 导致进度通知静默消失
13. **`replay-logger.ts` 是 1715 行 God File**，5 种职责混在一起，51 个 export，名字具有误导性
14. **`fast-reply` 和 `delegation` 是幽灵包**，只被 runtime 内部使用，单独成包零价值，增加 2 个 build 步骤
15. **安装部署混乱**：两个重复工具、macOS 专属 launchctl、无插件开关、配置散落 5 处

**重构后仍然基于 OpenClaw 原生 Task，但使用方式要彻底改变：**
- 只用 OpenClaw 通过 plugin API 稳定暴露的接口（`pi.runtime.subagent`、hook 系统）
- 停止通过文件系统 hack 访问 OpenClaw 内部 minified bundle

---

## 二、问题清单（带代码定位）

### 问题 P0：Completion Protocol 缺失

**文件**：`extensions/octoclaw-runtime/src/delegate/child-finalizer.ts`

**现状**：

```typescript
// child-finalizer.ts:185-228
async function findRuntimeChildFinalResult(options) {
  // 路径1：用 runtime.waitForRun + getSessionMessages
  const wait = await runtime.waitForRun({ runId, timeoutMs: 1000 })
  const messages = await runtime.getSessionMessages({ sessionKey, limit: 8 })
  const text = selectLastAssistantResult(messages.messages)  // ← 找最后一条 assistant 消息
  return { text: text || "子任务已完成但没有返回可投影的安全结果包", source: "runtime_completion" }
}

// child-finalizer.ts:119-174
export function findChildFinalResult(options) {
  // 路径2（fallback）：扫描最近 80 个 .jsonl 文件
  // 找包含 "[OctoClaw Delegated Task]" 的文件
  // 然后找最后一条 isFinalAssistantCandidate 的消息
}
```

**根本原因**：
- `selectLastAssistantResult` 找"最后一条看起来像结果的 assistant 消息"，这是启发式，不是契约
- `findChildFinalResult` 扫描文件目录是 O(80) 次 IO，且依赖文件命名规律和内容特征
- 两条路径都没有结构化的完成信号，结果质量取决于 child agent 的输出格式

**影响**：
- 当 `waitForRun` 超时（默认 1000ms），直接 fallback 到文件扫描
- 当 child session 的最后消息不满足 `isFinalAssistantCandidate`（长度 < 20，包含 `[thinking]` 等），返回 fallback 文案
- IM 里用户看到"子任务已完成但没有返回可投影的安全结果包"

---

### 问题 P1：DetachedTaskRuntime 反向工程 OpenClaw 内部 Bundle

**文件**：`extensions/octoclaw-runtime/src/adapter/detached-task-runtime-host.ts`

**现状**：

```typescript
// detached-task-runtime-host.ts:9-17
const TASK_EXECUTOR_ALIASES: ExportAliasMap = {
  createQueuedTaskRun: ["a"],   // ← OpenClaw minified 后可能是 "a"
  createRunningTaskRun: ["o"],
  startTaskRunByRunId: ["f"],
  recordTaskRunProgressByRunId: ["l"],
  completeTaskRunByRunId: ["i"],
  failTaskRunByRunId: ["s"],
  setDetachedTaskDeliveryStatusByRunId: ["d"],
};

// taskflow-bridge.ts:219-237
// 搜索 dist/ 目录下包含 "createPluginRuntime" 的文件
// 通过 regex 找 export alias
```

**根本原因**：
OctoClaw 通过 `loadOpenClawDistModule("tasks/task-executor.js")` 加载 OpenClaw 的内部编译产物，然后用 `requireFunctionWithAliases` 尝试找函数（先找规范名，找不到就找 minified 别名）。

**影响**：
- OpenClaw 每次版本升级，如果 minifier 改变了变量名，立刻断掉
- 已经有 `["a", "o", "f", "l", "i", "s", "d"]` 这些 aliases，说明这不是偶然行为，是长期 workaround
- 这是整个项目最危险的依赖

---

### 问题 P2：`before_prompt_build` hook 过厚，容错性差

**文件**：`extensions/octoclaw-runtime/src/extension-entry.ts`（lines 770-985）

**现状**：在单个 `before_prompt_build` hook 内：

```
startLatencyAckTimer(3500ms)            // ACK timer 启动
↓
await resolvePolicyDecisionForContext() // judge 调用（可能几百ms）
  ↳ await callLlmJudge(judgeInput)      // LLM 调用（可能超时）
  ↳ await recordPolicyReplay(...)       // 写文件
↓
await sendRouteCommitAck(...)           // 发 IM ACK
↓
startAckGuard(...)                      // 启动 ACK 守门狗
↓
buildRecentExecutionFacts()             // 读 policyState
↓
buildConversationGrounding()            // 读 replay log 文件
↓
return buildPromptContextProjection()   // 组装 system prompt
```

**根本原因**：
ACK timer（3500ms）是在 judge 完成之前就启动的，这部分是对的。但 `startAckGuard` 和 `sendRouteCommitAck` 依赖 judge 完成后的 `effectiveDecision`，意味着如果 judge hang 住，这两步也 hang 住。

实际场景：judge LLM 调用在低流量时偶尔超时（1500ms），此时 ACK 能靠 timer 发出，但 `ack-guard` 没有启动，导致后续 watchdog 行为异常。

---

### 问题 P3：状态源散乱，没有权威顺序

**涉及文件**：
- `extensions/octoclaw-runtime/src/state/policy-state.ts`（内存状态）
- `extensions/octoclaw-runtime/src/tools/registration.ts`（task-state.json 写入）
- `extensions/octoclaw-runtime/src/work-contract/store.ts`（WorkContract 文件）
- `extensions/octoclaw-runtime/src/replay/replay-logger.ts`（replay log）
- `extensions/octoclaw-runtime/src/delegate/child-finalizer.ts`（session .jsonl 文件）
- OpenClaw native TaskFlow（通过 bridge 读写）

**现状**：当 child agent 完成时，需要从以下来源拼出"任务状态"：

| 来源 | 存储位置 | 持久化 | 权威范围 |
|------|---------|--------|--------|
| `policyState` | 内存 Map | 进程级 | per-turn 决策 |
| `task-state.json` | 文件 | ✓ | 任务运行状态 |
| WorkContract store | 文件（按 id） | ✓ | 语义决策 |
| replay log JSONL | 文件（追加） | ✓ | 事件流 |
| OpenClaw TaskFlow | OpenClaw runtime | ✓ | lifecycle 权威 |
| session .jsonl | OpenClaw session 目录 | ✓ | 对话记录 |

**根本问题**：这些状态源之间**没有单向依赖关系**。`projectRuntimeStatus()`（registration.ts:889）尝试综合它们，但使用了大量 `||` fallback，任何一个来源返回脏数据都会污染结果。

---

### 问题 P4：IM delivery 静默失败

**文件**：`extensions/octoclaw-runtime/src/delegate/child-finalizer.ts:304-324`

```typescript
async function sendFinalMessage(options, resultText) {
  if (options.sendFinalMessage) {
    return options.sendFinalMessage(...)  // 注入的发送函数
  }
  const adapter = getAdapterForSession(options.parentSessionKey)
  if (!adapter) return { sent: false, delivered: false, error: "no_adapter_for_parent_session" }
  return adapter.send(...)
}
```

当 `getAdapterForSession` 返回 null（因为 IM adapter 没有为这个 session key 注册），delivery 静默失败，返回 `{ sent: false, delivered: false }` 但不抛异常，不重试，用户 IM 里没有任何反馈。

---

### 问题 P5：Judge 架构过度设计——双 judge + 升级链路没有价值

**涉及文件**：
- `extensions/octoclaw-runtime/src/resolve/llm-judge.ts`
- `packages/octoclaw-policy/src/judge/judge-schema.ts`
- `extensions/octoclaw-runtime/src/resolve/policy-resolver.ts`（`resolveStatelessPolicyDecision` L1580-1880）

**现状**：

```
local judge → shouldEscalate（7个触发条件）→ callRemoteJudge → 主 agent（octoclaw_route_hint）
```

三层，实际运行只有两层有效：

```typescript
// llm-judge.ts:124-137
function resolveRemoteJudgeConfig(raw) {
  return {
    enabled: raw.enabled === true && ...,  // ← 默认 false
    shadowMode: Boolean(raw.shadowMode ?? REMOTE_JUDGE_DEFAULTS.shadowMode),  // ← 默认 shadow
  }
}
```

`remote judge` 默认 `enabled=false` + `shadowMode=true`，实际**从未生效**。

**`shouldEscalate` 的 7 个触发条件**：

```typescript
if (localResult.confidence < escalation.minConfidence) return "low_confidence";
if (riskFlags...) return "high_risk_write";
if (turnLength <= 6 && route === "delegate") return "short_turn_context_dependent";
if (activeIntents.length > 1 || bindingConflicts...) return "multiple_active_intents";
if (scope === "unknown") return "scope_unknown";       // ← 非常常见，频繁触发
if (role === "observer_probe" && complexityBand === "deep") return "unstable_classification";
if (routeHint !== localResult.route) return "main_agent_judge_disagreement";
```

这 7 个条件触发了也只是调用一个默认 disabled 的 remote judge，最终还是 fallback 给主 agent。整个升级链路是空转。

**问题**：
- `DualJudgeConfig`、`shouldEscalate`、`callRemoteJudge`、remote judge prompt builder 约 **300 行代码**完全是无效的
- `resolveStatelessPolicyDecision` 里双 judge 的逻辑（L1580-1880）有约 **100 行**是 remote judge 相关的
- 配置复杂：需要分别配 `_judgeFastConfig`（local）和 `_remoteJudgeConfig`（remote），用户困惑

**正确的两层设计**：

```
local/cheap judge（可配任意 OpenAI-compat endpoint，本地或远程都行）
  ↓ 成功 + confidence ≥ minConfidence
  → 使用 judge 结果（不需要主 agent 参与路由）
  
  ↓ 失败 / 超时 / 低置信度
  → routeHintRequired=true → 主 agent 调用 octoclaw_route_hint 自决策
```

local 和 remote 的区别只是 **endpoint 配置**，不需要两个独立的 judge 架构。

---

### 问题 P6：IM Adapter 硬编码 Slack，无扩展机制

**文件**：`extensions/octoclaw-runtime/src/im/index.ts`

```typescript
export function getAdapterForSession(sessionKey: string): SlackAdapter | null {
  const lower = sessionKey.toLowerCase();
  if (lower.startsWith("slack:") || lower.includes(":slack:")) {
    // 返回 SlackAdapter
  }
  return null;  // ← 其他任何 IM 都返回 null
}
```

只支持 Slack，且通过 `sessionKey` 前缀做硬编码判断。要支持飞书/微信/Discord，必须改这个核心文件。没有注册机制，没有适配器接口。

**影响**：
- 开源项目的核心 value prop 之一是 IM 透明度，但 IM 适配是封死的
- 非 Slack 用户无法使用任何状态通知功能

**改法**：提取 `IMAdapter` 接口，`getAdapterForSession` 改为从注册表查找，其他 IM 按需注入（见 3.2 R7）。

---

### 问题 P7：`PolicyStateEntry` 有 `[key: string]: unknown` 索引签名

**文件**：`extensions/octoclaw-runtime/src/state/policy-state.ts:34`

```typescript
export interface PolicyStateEntry {
  decision?: Record<string, unknown>;
  // ...其他字段...
  [key: string]: unknown;  // ← 这一行让 TypeScript 对这个类型几乎束手无策
}
```

这个索引签名是整个 codebase 防御性代码激增的根源。每次访问 `PolicyStateEntry` 的字段都必须用 `asRecord(state?.someField)` 防御，因为 TypeScript 无法保证任何属性的类型。

**影响**：
- 整个 `extension-entry.ts`（1480 行）里充满了 `asRecord(state?.xxx)` 和 `asString(state?.xxx)` 的防御代码
- 真正的类型错误（比如 `state.delegated` 被误赋非 boolean）在编译期无法发现
- 新增字段无法得到 TypeScript 的自动补全和检查

**改法**：枚举所有已知字段，删除 `[key: string]: unknown`。未知字段通过 `extraState?: Record<string, unknown>` 收容。

---

### 问题 P8：ACK 时间常量在两个文件里各定义一次

**文件**：
- `extensions/octoclaw-runtime/src/ack/ack-decision.ts:42-49`
- `extensions/octoclaw-runtime/src/ack/ack-timing.ts:7`

```typescript
// ack-decision.ts
export const ACK_TIMING = {
  tier1_ms: 18000,
  tier2_ms: 45000,
  tier3_ms: 120000,
}

// ack-timing.ts
export const DEFAULT_TIER_DELAYS_MS: [number, number, number, number] = [18_000, 45_000, 120_000, 0];
```

同一组常量分别定义在两个文件里。如果 `ack-decision.ts` 的 `tier1_ms` 改了，`ack-timing.ts` 的 `DEFAULT_TIER_DELAYS_MS` 不会自动跟着变，反之亦然。

**改法**：在 `ack-timing.ts` 里定义唯一权威的常量，`ack-decision.ts` 从那里 import。

---

### 问题 P9：`materializer.ts` 中 `"lost"` 状态映射到 `"queued"`

**文件**：`extensions/octoclaw-runtime/src/work-contract/materializer.ts:40-59`

```typescript
function mapSubstrateToContractStatus(substrate: string | undefined): WorkContractStatus {
  switch (substrate as SubstrateStatus) {
    case "queued":
    case "planned":   return "planned";
    case "running":   return "running";
    case "completed":
    case "succeeded": return "completed";
    case "failed":    return "failed";
    case "blocked":   return "blocked";
    case "cancelled": return "cancelled";
    default:          return "queued";  // ← "lost" 也走这里
  }
}
```

当 OpenClaw TaskFlow 的 substrate 状态为 `"lost"`（进程崩溃或任务失踪），WorkContract 会显示为 `"queued"`（排队中），用户看到的是任务还在等待，实际上任务已经丢失了。

**改法**：`"lost"` 加一个 case，映射到 `"failed"`。

---

### 问题 P10：`delegate-packets.ts` 第 70 行有个非预期的 runtime throw

**文件**：`extensions/octoclaw-runtime/src/context/delegate-packets.ts:70-72`

```typescript
export function buildDelegateHandoffPacket(input: BuildDelegateHandoffPacketInput): DelegateHandoffPacket {
  if (input.relevantExcerpts && input.relevantExcerpts.length > 0 && !input.contextEscalationReason) {
    throw new Error("context_escalation_reason_required");  // ← 运行时 throw
  }
  // ...
}
```

当 `relevantExcerpts` 有值但 `contextEscalationReason` 未提供时，直接抛异常。这在 dispatch 路径上可能造成 unhandled rejection，导致整个 dispatch 失败但没有明确的错误信息。

**改法**：把 `contextEscalationReason` 改为必填参数（TypeScript 编译期强制），或在缺失时 graceful fallback 而不是 throw。

---

### 问题 P11：Slack Adapter 每条消息都 spawn 一个 CLI 子进程

**文件**：`extensions/octoclaw-runtime/src/im/slack/slack-adapter.ts:300`

```typescript
const result = await runCommand("openclaw", args, {
  cwd: ...,
  timeoutMs,  // 默认 5000ms
});
```

每次发送 ACK 或结果消息都会 `spawn("openclaw", ["message", "send", ...])` 启动一个新的 OpenClaw CLI 子进程。

**影响**：
- Tier 1/2/3 ACK 连续发出时，会 spawn 3 个子进程
- 每个子进程有 5000ms 超时，如果 Slack 响应慢，会并发积压
- 子进程有启动开销（100-300ms），对 ACK 延迟有影响

这是已知权衡（不依赖 Slack SDK，只依赖 OpenClaw CLI），不算严重 bug，但要知道这个 overhead 存在。

---

### 问题 P12：ACK 与 Progress 两套系统并行，职责重叠，用户体验混乱

**涉及文件**：
- `extensions/octoclaw-runtime/src/ack/ack-guard.ts`（tier 计时器）
- `extensions/octoclaw-runtime/src/ack/ack-timing.ts`（tier 延迟配置）
- `extensions/octoclaw-runtime/src/ack/ack-templates.ts`（~100 条文案模板）
- `extensions/octoclaw-runtime/src/ack/ack-template-registry.ts`（第二套模板系统）
- `extensions/octoclaw-runtime/src/ack/execution-transition-notifier.ts`（execution transitions）

**现状**：两套并行的"发消息给用户"机制同时运行：

```
机制A（ack-guard.ts tier 系统）：
  tier0 (0ms)   → reaction ACK 或文字 ACK
  tier1 (18s)   → "还在跑，稍等"
  tier2 (45s)   → "处理比较久了"
  tier3 (120s)  → "超时了，要继续吗？"

机制B（execution-transition-notifier.ts）：
  dispatch_materialized → "任务已派发，排队中。"
  spawn_started         → "任务已启动。"
  heartbeat_stale       → "任务进度停滞，正在检查。"
  timed_out             → "任务超时。"
```

在 delegate 路径下，tier1/2/3 和 execution transitions **同时运行**，用户可能在 18 秒内收到两条进度消息："还在跑稍等" + "任务已启动"，内容重复且来源不一致。

**三个独立的"发消息"函数，实现完全重复**：

| 函数 | 位置 |
|------|------|
| `sendAckDirectDetailed` | `ack-guard.ts` |
| `sendExecutionTransitionDirect` | `execution-transition-notifier.ts` |
| `sendFinalMessage` | `child-finalizer.ts` |

三个函数做完全相同的事（调用 IM adapter 发消息），分别实现，分别维护。

**模板池过度设计**：

`ack-templates.ts` 有 11 个 stage，每个 stage 10-31 条文案，合计约 100 条。选择逻辑是**随机**的。这些文案变体并没有带来质量差异，只带来维护负担。同时还有两套模板系统：`ack-templates.ts`（legacy）和 `ack-template-registry.ts`（新），两套并存。

**`no_valid_thread_anchor` 静默跳过**（`execution-transition-notifier.ts:377-398`）：

```typescript
if (!hasValidTarget || !hasValidThreadAnchor) {
  // 直接 skip，不发任何消息
  return { sent: false, skipped: true, reason: "no_valid_thread_anchor" }
}
```

没有 thread anchor 时（inboundMessageTs 未记录），所有 execution transition 通知都被静默跳过。这是用户"任务在跑但 IM 里没有任何状态"的直接原因之一。

**影响**：
- delegate 任务运行时用户收到重复/冲突的消息
- 没有 thread anchor 时，所有进度通知消失
- 三处重复代码，维护困难
- ~100 条随机模板，等同于没有设计的随机输出

---

### 问题 P13：`replay-logger.ts` 是 1715 行的 God File，包含五种不同职责

**文件**：`extensions/octoclaw-runtime/src/replay/replay-logger.ts`  
**导出数**：51 个

名字叫 "replay-logger"，实际上包含：

| 职责 | 行数范围 | 应该在哪里 |
|------|---------|-----------|
| TurnExecutionReceipt 类型和构建 | L45-487 | `receipt.ts` |
| JSONL replay 写入 | L517-830 | `replay.ts` |
| Delivery relay（注册/协调/对账） | L830-1185 | 大部分可删除（被 completion protocol 取代） |
| 消息清洗/拦截 | L1187-1505 | `message-guard.ts` |
| Policy 工具函数 | L1507-1715 | `policy-utils.ts` |

9 个文件 import 这个模块，用到了其中约 30 个 export。

**影响**：任何改动都要在 1715 行里定位，关注点分散，名字具有误导性，5 个独立功能互相耦合。

---

### 问题 P14：两个"幽灵包"从未独立运行，只是被引用的内部库

**`octoclaw-fast-reply`**（245 行，3 个配置文件）  
→ 只有 `runtime-payloads.ts` 用了它的 3 个函数：`buildFastReplyAck`、`buildDirectReply`、`buildDirectReplyContext`

**`octoclaw-delegation`**（668 行，3 个配置文件）  
→ 只有 `runtime-payloads.ts` 用了它的 2 个函数：`buildCompoundDelegationPlaceholder`、`materializeDelegatedWork`

两个包没有自己的 `openclaw.plugin.json`，不是独立插件，只是 `octoclaw-runtime` 的内部依赖。单独成包增加了 2 个 `pnpm build` 步骤、2 套 `tsconfig`、2 个 `package.json`，但零额外价值。

---

### 问题 P15：安装部署混乱，无插件开关，特性配置散落 5 处

**文件**：`tools/install/src/index.ts`（1053 行）、`tools/manage/src/index.ts`（911 行）、`bin/update-openclaw-macmini.sh`

**问题一：两个工具做同一件事**

```
tools/install  → 开发者用（本地 build 后部署）
tools/manage   → 用户用（从 GitHub clone 后部署）
```

两个文件各自硬编码 `DEPLOY_PACKAGE_NAMES`，各自实现 symlink 建立、extension 验证、重启逻辑。

**问题二：macOS 专属代码写死在 install 里**

```typescript
// tools/install/src/index.ts:682 — 非 macOS 完全不工作
await runCommand("launchctl", ["setenv", "OCTOCLAW_JUDGE_FAST", json])
await runCommand("launchctl", ["setenv", "OCTOCLAW_DELEGATION_ENABLED", "true"])
```

**问题三：没有插件开关**

无法快速关掉 OctoClaw 而不卸载。`delegationEnabled` 只关委派路由，不关整个插件。

**问题四：特性配置散落 5 处**

| 配置项 | 位置 |
|--------|------|
| delegation on/off | pluginConfig（`openclaw.plugin.json`） |
| judge 配置 | `OCTOCLAW_JUDGE_FAST` 环境变量 |
| delegation enabled | `OCTOCLAW_DELEGATION_ENABLED` 环境变量 |
| judge config 文件 | `~/.openclaw/judge-fast.json` |
| 模型配置 | `~/.octoclaw/octoclaw-model-config.json` |
| 基础配置 | `~/.octoclaw/octoclaw-config.json` |

---

## 三、哪些保留，哪些重构，哪些删除

### 3.1 保留（基本不动）

| 组件 | 文件 | 理由 |
|------|------|------|
| Judge 单模型调用核心 | `packages/octoclaw-policy/src/judge/` 中的 `callLlmJudge`、`judge-schema`、`judge-prompt` | 本地 judge 逻辑本身稳定，只删 dual/remote 层 |
| WorkContract 类型定义 | `packages/octoclaw-contracts/src/work-contract.ts` | 语义合同的抽象是对的 |
| Route seal 机制 | `extensions/octoclaw-runtime/src/resolve/route-seal.ts` | 防止 turn 内路由漂移 |
| Execution coverage precheck | `extensions/octoclaw-runtime/src/resolve/execution-coverage-precheck.ts` | provenance follow-up 不 spawn 的关键 |
| ACK timing 系统 | `extensions/octoclaw-runtime/src/ack/ack-timing.ts` | 分层 ACK 发送时机设计合理 |
| TaskFlow bridge（稳定方法部分） | `extensions/octoclaw-runtime/src/adapter/taskflow-bridge.ts` | `createManagedFlow/runTask/readFlow` 等用了 plugin runtime 的稳定 API |
| OpenClaw DistTaskFlowPort | `extensions/octoclaw-runtime/src/ports/openclaw-dist-taskflow-port.ts` | 对 bridge 的包装，接口设计合理 |
| 两阶段 patrol 概念 | SKILL.md 里的 patrol 设计 | token 效率原则正确，但需迁移到 TS 实现 |
| Ollama native API 特殊处理 | `llm-judge.ts` 中 `isOllamaEndpoint` + `postOllamaNative` | Ollama 的 `/api/chat` 接口与标准 OpenAI-compat 有差异，需保留 |

### 3.2 必须重构

#### R1：`child-finalizer.ts` — 完全重写

**现有问题**：猜结果，扫描文件，530行复杂逻辑  
**重构目标**：从写死的结果文件路径读取，显式完成

详见第四节"完成协议重构"。

#### R2：`detached-task-runtime-host.ts` — 完全重写

**现有问题**：minified bundle aliases  
**重构目标**：用 OpenClaw 通过 `pi.registerDetachedTaskRuntime` 暴露的 runtime 对象，而不是动态加载内部模块

详见第四节"DetachedTaskRuntime 重构"。

#### R3：`extension-entry.ts` 的 `before_prompt_build` — 重构容错逻辑

**现有问题**：judge 超时导致 ack-guard 没有启动  
**重构目标**：ACK guard 在 judge 之前启动，judge 结果异步更新

详见第四节"Live Path 容错"。

#### R4：状态权威模型 — 明确层级

**现有问题**：6个状态源，没有单向依赖  
**重构目标**：3个来源，有明确的权威顺序

详见第四节"状态收敛"。

#### R5：IM delivery 保障

**现有问题**：`no_adapter_for_parent_session` 静默失败  
**重构目标**：失败时写入重试队列，watchdog 补发

#### R6：Judge 架构简化——双 judge 合并为单 judge

**现有问题**：`DualJudgeConfig` + `callRemoteJudge` + `shouldEscalate` 约 300 行无效代码，remote judge 从未真正启用  
**重构目标**：单一可配 judge，支持任意 OpenAI-compat endpoint（本地 Ollama 或远程廉价 API）

详见第四节"Judge 架构简化"。

#### R7：IM Adapter 提取接口，支持注册机制

**现有问题**：`im/index.ts` 硬编码 Slack，`getAdapterForSession` 只返回 `SlackAdapter | null`  
**重构目标**：抽取 `IMAdapter` 接口，改为注册表模式，Slack 作为内置实现

```typescript
// 新增 extensions/octoclaw-runtime/src/im/adapter.ts

export interface IMAdapter {
  readonly channel: string;
  send(params: {
    sessionKey: string;
    message: string;
    replyToMessageId?: string;
    timeoutMs?: number;
    cwd?: string;
  }): Promise<{ sent: boolean; delivered: boolean; messageId?: string; error?: string }>;
  canHandle(sessionKey: string): boolean;
}

// im/index.ts 改为
const adapterRegistry: IMAdapter[] = [];

export function registerIMAdapter(adapter: IMAdapter): void {
  adapterRegistry.push(adapter);
}

export function getAdapterForSession(sessionKey: string): IMAdapter | null {
  return adapterRegistry.find((adapter) => adapter.canHandle(sessionKey)) ?? null;
}

// 内置注册 Slack（在 plugin.ts register() 里）
registerIMAdapter(new SlackAdapter(buildSlackAdapterConfig()));
```

这样 Feishu/微信/Discord 等只需实现 `IMAdapter` 接口并调用 `registerIMAdapter` 即可，不需要修改核心代码。

#### R10：`replay-logger.ts` 拆分——按职责分文件

**现有问题**：1715 行、5 种职责、51 个 export，名字和内容不符，delivery relay 部分（约 350 行）在 completion protocol 实施后几乎是废代码  
**重构目标**：拆成 4 个小文件，删除 delivery relay

#### R11：合并幽灵包——`fast-reply` + `delegation` 并入 `runtime`

**现有问题**：两个包合计 913 行，只被 `runtime-payloads.ts` 的 5 个函数引用  
**重构目标**：代码内联到 `octoclaw-runtime/src/payloads/`，删除两个包的 package.json / tsconfig

#### R12：安装部署重设计——统一为 `octoclawctl` CLI

**现有问题**：两个重复工具、macOS 专属代码、无插件开关、配置散落  
**重构目标**：单一 `octoclawctl` CLI、插件 enabled 开关、统一配置文件

详见第四节"安装部署重设计"。

**现有问题**：两套并行系统（tier 计时器 + execution transitions），三处重复发送代码，模板 ~100 条随机选，`no_valid_thread_anchor` 静默 skip  
**重构目标**：三相模型（ACK / Progress / Final），单一发送路径，精简模板，修复 thread anchor 静默 skip

详见第四节"ACK/Progress 统一设计"。

**现有问题**：`[key: string]: unknown` 索引签名，TypeScript 类型检查形同虚设  
**重构目标**：枚举所有已知字段，删除索引签名

```typescript
// 改后
export interface PolicyStateEntry {
  decision?: Record<string, unknown>;
  routeSeal?: RouteSeal;
  routeHintSubmitted?: boolean;
  directToolsSeen?: string[];
  controlToolsSeen?: string[];
  blockedTools?: string[];
  delegated?: boolean;
  delegationTool?: string;
  latencyAckSent?: boolean;
  latencyAckText?: string;
  ackGuardKey?: string;
  formal_reply_visible?: boolean;
  pendingDeliveryId?: string;
  pendingDeliveryTaskId?: string;
  pendingDeliveryRunnerJobId?: string;
  deliveryObserved?: boolean;
  canonicalSessionKey?: string;
  sessionBoundary?: { status: string; reason: string };
  workContractId?: string;
  latestStatus?: WorkContractStatus;
  latestExecutionReceipt?: TurnExecutionReceipt;
  latestAnomalyNotice?: Record<string, unknown>;
  inboundMessageTs?: string;
  routeCommitAckSent?: boolean;
  routeCommitAckId?: string;
  delegate_without_dispatch?: boolean;
  dispatchExecuted?: boolean;
  spawnExecuted?: boolean;
  resultMaterialized?: boolean;
  prompt?: string;
  updatedAt?: number;
  createdAt?: number;
  // 未预期的字段收容（替代索引签名）
  extraState?: Record<string, unknown>;
}
```

这一步改动会让许多现有的 `asRecord(state?.xxx)` 调用可以被简化为直接访问，编译器也能发现真正的 bug。

### 3.3 删除（可 archive）

| 组件 | 文件 | 理由 |
|------|------|------|
| replay live path 写入 | `replay-logger.ts` 里的同步 `recordPolicyReplay` | replay 应该是 async 旁路，不在 live path 里 |
| task-state 复杂归档逻辑 | `task-state-retention.ts` | 先用简单 TTL，复杂归档是 P2+ 特性 |
| Remote judge 整体 | `llm-judge.ts`: `callRemoteJudge`、`shouldEscalate`、`resolveDualJudgeConfig` | 默认 disabled，从未真正运行，约 200 行空转代码 |
| Dual judge 配置类型 | `judge-schema.ts`: `DualJudgeConfig`、`RemoteJudgeConfig`、`EscalationReason`、`RemoteJudgeOutput` | 随 remote judge 一起删 |
| Remote judge prompt builder | `judge-prompt.ts`: `buildRemoteJudgeSystemPrompt`、`buildRemoteJudgeUserPrompt` | 随 remote judge 一起删 |
| 两套模板系统 | `ack-templates.ts` + `ack-template-registry.ts` | 合并保留一套，精简到每 stage 5-6 条 |
| `sendAckDirectDetailed` / `sendExecutionTransitionDirect` / `sendFinalMessage` 三个重复函数 | `ack-guard.ts` / `execution-transition-notifier.ts` / `child-finalizer.ts` | 统一为 `sendIMMessage()`，约 -100 行 |

### 3.4 小修（不需要重构，就地修复）

| 问题 | 文件 | 改法 |
|------|------|------|
| `"lost"` 映射到 `"queued"` | `materializer.ts:52`（default case） | 加 `case "lost": return "failed"` |
| ACK 时间常量两份 | `ack-decision.ts:42` + `ack-timing.ts:7` | `ack-decision.ts` 从 `ack-timing.ts` import，删除自己的定义 |
| `delegate-packets.ts` runtime throw | `delegate-packets.ts:70-72` | 把 `contextEscalationReason` 改为必填参数（TypeScript 强制），或 graceful fallback |
| `entries()` type cast hack | `policy-state.ts:494-496` | 在 `PolicyStateStore` 上添加 `public entries(): ...` 方法 |
| **ACK tier 时间偏长** | `ack-decision.ts:42` + `ack-timing.ts:7` | reaction 1000→800ms，text_ack0 3000→2500ms，tier1 18→12s，tier2 45→30s，tier3 120→90s |
| **Reaction emoji 与 judge 耦合** | `openclaw.plugin.json` + `extension-entry.ts` | 顶层新增 `ackReactionEmoji` 字段，与 `judgeFast` 解耦；`judgeFast.ackReactionEmoji` 保留作 fallback |

---

## 四、重构方案详细设计

### 4.1 Completion Protocol — 显式结构化结果文件

**核心思路**：约定 child worker 完成时必须写一个结构化结果文件，父 session 轮询这个文件。

#### 4.1.1 结果文件合同

```typescript
// packages/octoclaw-contracts/src/completion.ts (新文件)

export interface WorkerCompletionResult {
  schemaVersion: "octoclaw.worker_completion/v1";
  workContractId: string;          // 与 dispatch 时传入的一致
  childSessionKey: string;         // 子 session 的 key
  delegateTaskId: string;
  status: "success" | "failure" | "partial";
  summary: string;                 // 给父 agent 和用户看的摘要，纯文本，max 2000 chars
  artifacts?: string[];            // 产出物路径（文件、URL 等）
  errorCode?: string;              // 失败时的错误码
  errorMessage?: string;           // 失败时的错误描述
  completedAt: string;             // ISO timestamp
}
```

#### 4.1.2 结果文件路径约定

```
${OCTOCLAW_WORKSPACE}/.octoclaw/completions/${workContractId}.completion.json
```

路径是确定的，基于 `workContractId`，父 session 知道去哪里轮询，不需要扫描目录。

#### 4.1.3 Worker Prompt 注入

`buildSubagentSpawnMessage`（registration.ts:729）需要加入 completion 指令：

```typescript
// 现有（registration.ts:729-739）
function buildSubagentSpawnMessage(params) {
  return [
    "[OctoClaw Delegated Task]",
    `childSessionKey: ${params.childSessionKey}`,
    params.delegateTaskId ? `delegateTaskId: ${params.delegateTaskId}` : "",
    params.workContractId ? `workContractId: ${params.workContractId}` : "",
    "Return a concise result packet with findings, artifact refs if any, and final status.",
    "",
    params.task,
  ].filter(Boolean).join("\n");
}

// 改为
function buildSubagentSpawnMessage(params) {
  const completionPath = resolveWorkerCompletionPath(params.workContractId);
  return [
    "[OctoClaw Delegated Task]",
    `childSessionKey: ${params.childSessionKey}`,
    `delegateTaskId: ${params.delegateTaskId}`,
    `workContractId: ${params.workContractId}`,
    "",
    "## 完成要求",
    "任务完成后，必须将结果写入以下文件（使用 Write 工具）：",
    `文件路径：${completionPath}`,
    "文件内容格式：",
    '```json',
    JSON.stringify({
      schemaVersion: "octoclaw.worker_completion/v1",
      workContractId: params.workContractId,
      childSessionKey: params.childSessionKey,
      delegateTaskId: params.delegateTaskId,
      status: "success",       // 或 "failure" / "partial"
      summary: "任务结果摘要", // 填写实际结果
      artifacts: [],           // 如有产出物路径
      completedAt: new Date().toISOString(),
    } satisfies WorkerCompletionResult, null, 2),
    '```',
    "如果任务失败，status 填 \"failure\"，errorCode 填失败原因码，errorMessage 填详细说明。",
    "写入完成后任务自动结束，无需其他操作。",
    "",
    "## 任务内容",
    params.task,
  ].filter(Boolean).join("\n");
}
```

#### 4.1.4 Child Finalizer 重写

```typescript
// extensions/octoclaw-runtime/src/delegate/child-finalizer.ts (重写)

import fsSync from "node:fs";
import path from "node:path";
import { resolveWorkerCompletionPath } from "../resolve/env.js";
import type { WorkerCompletionResult } from "@octoclaw/contracts/completion";

export interface ChildFinalizerOptions {
  workContractId: string;
  delegateTaskId: string;
  parentSessionKey: string;
  replyToMessageId?: string;
  nativeTaskId?: string;
  nativeFlowId?: string;
  runId?: string;
  modelId?: string;
  cwd?: string;
  timeoutMs?: number;        // 默认 240000
  pollIntervalMs?: number;   // 默认 5000
  initialDelayMs?: number;   // 默认 3000
}

export interface ChildFinalizerResult {
  status: "completed" | "pending" | "missing_identity" | "delivery_failed";
  completion?: WorkerCompletionResult;
  error?: string;
}

// 读取结果文件
function readCompletionFile(workContractId: string): WorkerCompletionResult | null {
  const filePath = resolveWorkerCompletionPath(workContractId);
  try {
    const content = fsSync.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content) as WorkerCompletionResult;
    // 验证 schema
    if (
      parsed.schemaVersion !== "octoclaw.worker_completion/v1"
      || !parsed.workContractId
      || !parsed.status
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

// 新版 finalizeChildSessionOnce — 不再扫描文件，直接读结果文件
export async function finalizeChildSessionOnce(
  options: ChildFinalizerOptions,
): Promise<ChildFinalizerResult> {
  if (!options.workContractId || !options.parentSessionKey) {
    return { status: "missing_identity", error: "missing workContractId or parentSessionKey" };
  }

  const completion = readCompletionFile(options.workContractId);
  if (!completion) return { status: "pending" };

  // 发送结果到 IM
  const adapter = getAdapterForSession(options.parentSessionKey);
  if (!adapter) {
    // 写入重试队列（新增的 delivery-outbox）
    await appendToDeliveryOutbox({
      workContractId: options.workContractId,
      parentSessionKey: options.parentSessionKey,
      replyToMessageId: options.replyToMessageId,
      completion,
    });
    return { status: "delivery_failed", completion, error: "no_adapter_queued_for_retry" };
  }

  const message = formatCompletionMessage(completion, options);
  const result = await adapter.send({
    sessionKey: options.parentSessionKey,
    message,
    replyToMessageId: options.replyToMessageId,
    timeoutMs: 8000,
    cwd: options.cwd || resolveWorkspaceRoot(),
  });

  // 更新 task-state.json（单一来源）
  updateTaskState(options, completion, result.sent || result.delivered ? "delivered" : "failed");

  return {
    status: (result.sent || result.delivered) ? "completed" : "delivery_failed",
    completion,
    error: result.error,
  };
}

// scheduleChildCompletionFinalizer 保持相同接口，内部改为调用新版
// 轮询逻辑不变，但不再依赖文件扫描
```

**关键变化**：
- 从 530 行 → 约 150 行
- 从"猜最后一条消息"→ 读确定路径的 JSON 文件
- 从 O(80 次文件 IO)→ O(1) 次文件读取

#### 4.1.5 向后兼容

部署窗口期间可能有已经运行的 worker 没有写 completion 文件。保留一个降级路径：

```typescript
function readCompletionFile(workContractId: string): WorkerCompletionResult | null {
  // 先找新格式
  const newFormatResult = readNewFormatCompletion(workContractId);
  if (newFormatResult) return newFormatResult;
  
  // 降级：如果没有新格式文件，返回 null（让 finalizer 继续 pending）
  // 旧的 session file scan 作为 background fallback 仅在 legacyFallback=true 时启用
  // 默认 false，给用户 30 天窗口期迁移
  return null;
}
```

---

### 4.2 DetachedTaskRuntime — 停止反向工程，用正确的集成方式

**核心思路**：OpenClaw 通过 `pi.registerDetachedTaskRuntime(runtime)` 让插件注册 runtime，这意味着 OpenClaw 会从外部提供 `DetachedTaskLifecycleRuntime` 的实现。

但现在 OctoClaw 自己在 `detached-task-runtime-host.ts` 里手动加载 OpenClaw 内部模块来构建这个 runtime，这是反向工程。

**正确做法有两条路**：

#### 路径 A：依赖 OpenClaw 提供 DetachedTaskLifecycleRuntime（推荐）

OpenClaw 应该通过 `pi.registerDetachedTaskRuntime` 的回调让 OctoClaw 拿到 runtime，而不是让 OctoClaw 去找它。即：

```typescript
// plugin.ts（修改）
register(pi: PluginInterface): void {
  // 如果 OpenClaw 会主动调用 registerDetachedTaskRuntime 提供 runtime：
  // OctoClaw 只需要注册一个接收者
  if (typeof pi.registerDetachedTaskRuntime === "function") {
    // OpenClaw 会在合适时机提供 runtime
    // OctoClaw 只需要存起来用
    pi.registerDetachedTaskRuntime = (runtime: DetachedTaskLifecycleRuntime) => {
      detachedRuntimeInstance = runtime;
      logger?.debug?.("octoclaw detached task runtime received from host");
    };
  }
```

等等——这里有个认知误差。看 `pi.registerDetachedTaskRuntime` 的签名：

```typescript
registerDetachedTaskRuntime?(runtime: DetachedTaskLifecycleRuntime): void;
```

这是 **OctoClaw 向 OpenClaw 注册 runtime**，不是 OpenClaw 向 OctoClaw 提供 runtime。含义是：OctoClaw 提供自己的 `DetachedTaskLifecycleRuntime` 实现，让 OpenClaw 用来管理异步任务的生命周期。

这说明 `detached-task-runtime-host.ts` 的意图是：**OctoClaw 自己提供 task executor 实现，让 OpenClaw 调用**。但它又从 OpenClaw 的 bundle 里加载 task-executor.js 来实现这个 runtime，形成循环依赖。

#### 路径 B：完全绕过 DetachedTaskRuntime，用更简单的机制（推荐）

重新审视：OctoClaw 的 `registerDetachedTaskRuntime` 到底解决什么问题？

答案是：让 OpenClaw 在 task 完成/失败时回调 OctoClaw，从而触发 IM 推送。

但这个功能完全可以用更简单的方式实现：

**Option B1：在 `agent_end` hook 里触发 completion 检查**

```typescript
// extension-entry.ts
registerLifecycleHook("agent_end", async (_event, ctx) => {
  if (!isManagedAgentContext(ctx)) return;
  
  // 检查这个 session 是不是一个 child worker
  const sessionKey = asString(ctx.sessionKey);
  const workContractId = extractWorkContractIdFromSession(sessionKey, ctx);
  
  if (workContractId) {
    // 这是一个 child worker session 结束了
    // 直接触发父 session 的 finalizer
    await triggerParentDelivery(workContractId);
  }
  
  // ... 原有的 agent_end 逻辑
}, 50);
```

**Option B2：轮询机制保留，但用文件系统事件替代内存回调**

实际上，`scheduleChildCompletionFinalizer` 的轮询（5秒间隔）已经足够。关键是轮询的内容从"猜消息"改成"读结果文件"（见 4.1），不需要 DetachedTaskRuntime 的回调机制。

**结论：删除 `detached-task-runtime-host.ts` 的 minified alias 加载，改为：**

```typescript
// detached-task-runtime-host.ts (重写)

// 方案：不再使用 DetachedTaskRuntime，
// 依赖 completion file + agent_end hook 的组合来处理任务完成

export async function createHostDetachedTaskLifecycleRuntime(): Promise<DetachedTaskLifecycleRuntime> {
  // 返回一个 stub runtime，只实现必要的接口
  // 真正的 completion 通过 completion file protocol 处理
  return createStubDetachedTaskRuntime();
}

function createStubDetachedTaskRuntime(): DetachedTaskLifecycleRuntime {
  // createQueuedTaskRun / completeTaskRunByRunId 等只做状态记录
  // 不依赖 OpenClaw 内部模块
  return {
    createQueuedTaskRun: (params) => ({ taskId: randomUUID(), ...params }),
    createRunningTaskRun: (params) => ({ taskId: randomUUID(), ...params }),
    startTaskRunByRunId: (params) => [],
    recordTaskRunProgressByRunId: (params) => [],
    completeTaskRunByRunId: (params) => [],
    failTaskRunByRunId: (params) => [],
    setDetachedTaskDeliveryStatusByRunId: (params) => [],
    cancelDetachedTaskRunById: async () => ({ found: false, cancelled: false }),
  };
}
```

**TaskFlow bridge 部分保留**：`taskflow-bridge.ts` 里通过 `createPluginRuntime()` 访问 `taskFlow.bindSession()` 的部分是稳定的 plugin API，保留。

---

### 4.3 Live Path 容错 — ACK guard 在 judge 之前启动

**文件**：`extensions/octoclaw-runtime/src/extension-entry.ts`（lines 800-985）

**现状**：

```typescript
// 现在的顺序：
startLatencyAckTimer(stateKey)       // ① ACK timer 启动
const resolved = await resolvePolicyDecisionForContext(...)  // ② judge（可能超时）
await sendRouteCommitAck(...)        // ③ 发 ACK（依赖 judge 结果）
startAckGuard(...)                   // ④ 启动 guard（依赖 judge 结果）
```

**问题**：如果 judge 超时（比如 LLM API 慢），步骤 ③④ 不执行，ACK guard 不启动，watchdog 行为异常。

**改法**：

```typescript
// 新顺序：
// ① 立即启动 ACK guard（用初始空决策）
const preliminaryAckKey = preSessionKey;
if (preliminaryAckKey) {
  startAckGuard(preliminaryAckKey, cwd, { 
    stateKey: preStateKey, 
    decision: {},  // 空决策，guard 自己有 timeout
    replyToMessageId: inboundMessageTs 
  });
}

// ② 启动 ACK timer
startLatencyAckTimer(preStateKey);

// ③ 调用 judge（judge 超时也没关系，ACK guard 已经启动了）
const resolved = await resolvePolicyDecisionForContext(...)
  .catch((err) => {
    logger?.warn?.(`judge failed, proceeding with fallback: ${err.message}`);
    return null;  // 允许 judge 失败，用 rule-based fallback
  });

// ④ judge 完成后，用实际决策更新 ACK guard
if (resolved) {
  updateAckGuardDecision(preliminaryAckKey, effectiveDecision);
  sendRouteCommitAck(...);  // 可选，失败不阻塞
}
```

**关键变化**：ACK guard 必须在 judge 之前启动，因为它是"用户等待中"的保障。judge 可以失败，ACK 不能不发。

---

### 4.4 状态收敛 — 三个来源，单向依赖

**目标架构**：

```
OpenClaw Native TaskFlow          ← lifecycle 权威（queued/running/completed/failed）
      ↓ 只读
task-state.json                   ← OctoClaw 业务状态权威
  ├── taskId, flowId, workContractId  (从 TaskFlow 同步)
  ├── status (从 TaskFlow 映射)
  ├── dispatchExecuted, spawnExecuted, resultMaterialized
  ├── completion: WorkerCompletionResult | null (从 completion file 加载后写入)
  └── delivery: { status, messageId, deliveredAt }
      ↓ 只读
policyState (内存)                ← per-turn 决策缓存，TTL 5分钟，不跨进程
```

**具体改动**：

#### 合并 WorkContract 到 task-state.json

```typescript
// 现在：WorkContract 存在独立文件 ${workContractId}.wc.json
// 改为：WorkContract 的关键字段内联到 task-state.json 的任务记录里

interface TaskStateRecord {
  id: string;                    // = workContractId (作为主键)
  status: TaskProjectionStatus;
  route: "reply" | "delegate";
  sessionKey: string;
  flowId?: string;
  nativeTaskId?: string;
  
  // WorkContract 核心字段（内联）
  workContractId: string;
  intentClass: string;
  judgeRoute: string;
  judgeConfidence?: number;
  workerPool?: string;
  modelProfile?: string;
  
  // 执行证据
  dispatchExecuted: boolean;
  spawnExecuted: boolean;
  resultMaterialized: boolean;
  childSessionKey?: string;
  runId?: string;
  
  // 完成结果（从 completion file 读取后写入）
  completion?: WorkerCompletionResult;
  
  // IM 投递状态
  delivery?: { status: string; messageId?: string; deliveredAt?: string };
  
  // 时间戳
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  failedAt?: string;
}
```

**这样做的好处**：
- 状态查询从 2 次文件读取（task-state.json + workContractId.wc.json）变成 1 次
- 进程重启后状态完整恢复（不依赖内存 policyState）
- octoclaw_status 工具直接读 task-state.json 即可，不需要 policyState

---

### 4.5 IM Delivery 保障 — 重试队列

**文件**：新增 `extensions/octoclaw-runtime/src/delivery/delivery-outbox.ts`

```typescript
interface DeliveryOutboxEntry {
  workContractId: string;
  parentSessionKey: string;
  replyToMessageId?: string;
  message: string;
  createdAt: string;
  attempts: number;
  lastAttemptAt?: string;
  nextRetryAt: string;
}

// 写入重试队列（当 adapter 不可用时）
export async function appendToDeliveryOutbox(entry: Omit<DeliveryOutboxEntry, "createdAt" | "attempts" | "nextRetryAt">): Promise<void> {
  const outboxPath = resolveDeliveryOutboxPath();
  const record: DeliveryOutboxEntry = {
    ...entry,
    createdAt: new Date().toISOString(),
    attempts: 0,
    nextRetryAt: new Date(Date.now() + 30_000).toISOString(), // 30秒后重试
  };
  // 原子追加到 outbox 文件
}

// watchdog tick 里补发（每30秒）
export async function flushDeliveryOutbox(): Promise<void> {
  const entries = readPendingOutboxEntries();
  for (const entry of entries) {
    const adapter = getAdapterForSession(entry.parentSessionKey);
    if (!adapter) continue;
    const result = await adapter.send({ ... });
    if (result.sent || result.delivered) {
      removeOutboxEntry(entry.workContractId);
    } else {
      updateOutboxRetryTime(entry);
    }
  }
}
```

---

### 4.6 Judge 架构简化——单 judge，两级 fallback

**目标架构**：

```
用户消息
  ↓
单一 judge（任意 OpenAI-compat endpoint，本地或远程）
  ↓ 成功 + confidence ≥ minConfidence
  → 使用 judge 路由结果，主 agent 无需参与路由决策
  → ackText 由 judge 提供（可选）

  ↓ 失败 / 超时 / confidence < minConfidence
  → routeHintRequired=true 注入 system prompt
  → 主 agent 调用 octoclaw_route_hint 自决策
  → 继续执行
```

#### 4.6.1 新配置接口

```typescript
// packages/octoclaw-policy/src/judge/judge-schema.ts（简化后）

export interface JudgeFastConfig {
  enabled: boolean;
  modelId: string;          // 任意模型，如 "llama-3.1-8b-instant" / "qwen2.5:3b"
  baseUrl: string;          // 任意 OpenAI-compat endpoint
  apiKey: string;           // 本地 Ollama 可留空
  timeoutMs: number;        // 默认 1200ms，本地 Ollama 可设 800ms
  minConfidence: number;    // 默认 0.6，低于此值 fallback 给主 agent
  shadowMode: boolean;      // true = 只记录不生效，调试用
  judgeAckEnabled: boolean; // judge 是否提供 ACK 文案，默认 true
}

// 删除：DualJudgeConfig / RemoteJudgeConfig / EscalationReason / RemoteJudgeOutput
```

配置示例（`OCTOCLAW_JUDGE_FAST` 环境变量）：

```bash
# 用远程廉价 API（Groq，Llama-3.1-8B，免费 tier 够用）
OCTOCLAW_JUDGE_FAST='{"modelId":"llama-3.1-8b-instant","baseUrl":"https://api.groq.com/openai/v1","apiKey":"gsk_xxx","timeoutMs":1200}'

# 用本地 Ollama
OCTOCLAW_JUDGE_FAST='{"modelId":"qwen2.5:3b","baseUrl":"http://localhost:11434","timeoutMs":800}'

# 不配置 → judge 整体跳过 → 主 agent 每次自决策（routeHintRequired=true 常驻）
```

#### 4.6.2 `resolveStatelessPolicyDecision` 简化

**现状**（`policy-resolver.ts` L1580-1880，约 300 行 judge 相关逻辑）：

```typescript
// 现在：复杂的 dual judge 流程
let dualJudgeConfig = resolveDualJudgeConfig(...)
const judgeConfig = dualJudgeConfig?.local ?? resolveJudgeConfig(...)
let judgeResult = await callLlmJudge(judgeInput, judgeConfig)
// 升级检查
let remoteJudgeResult = null
if (judgeResult && dualJudgeConfig) {
  const escalationReason = shouldEscalate(judgeResult, dualJudgeConfig.escalation, metadata)
  if (escalationReason && dualJudgeConfig.remote.enabled) {
    remoteJudgeResult = await callRemoteJudge(...)  // ← 实际上从不执行
    if (remoteJudgeResult && !shadowMode && override === "override_local") {
      judgeResult = remoteJudgeResult
    }
  }
}
// 后续处理 remoteJudgeOverrideApplied / judgeShadowLog 等
```

**改后**（约 50 行）：

```typescript
// 简化后：单 judge
const judgeConfig = resolveJudgeConfig(asRecord(options.metadata._judgeFastConfig))
if (judgeConfig) {
  const judgeInput = buildJudgeInput(prompt, metadata, contextPacket)
  const judgeResult = await callLlmJudge(judgeInput, judgeConfig)

  if (isActionableJudgeResult(judgeResult, judgeConfig.minConfidence)) {
    // judge 成功且置信度足够
    judgeSucceeded = true
    judgeRouteOverride = judgeResultToRouteOverride(judgeResult)
    judgeAckText = judgeConfig.judgeAckEnabled ? (judgeResult?.ackText ?? null) : null
    judgeRole = coerceJudgeRole(judgeResult?.role)
    judgeComplexityBand = coerceComplexityBand(judgeResult?.complexityBand)
    judgeExpectedDurationBand = coerceExpectedDurationBand(judgeResult?.expectedDurationBand)
    // ... 其他 hint 字段
  }
  // 失败/低置信度：judgeSucceeded 保持 false → routeHintRequired=true → 主 agent 决策
}
```

#### 4.6.3 删除内容清单

**`packages/octoclaw-policy/src/judge/judge-schema.ts`**：
- 删除 `DualJudgeConfig`
- 删除 `RemoteJudgeConfig`
- 删除 `EscalationReason`
- 删除 `RemoteJudgeOutput`
- 删除 `REMOTE_JUDGE_DEFAULTS`
- 删除 `ESCALATION_DEFAULTS`

**`extensions/octoclaw-runtime/src/resolve/llm-judge.ts`**：
- 删除 `callRemoteJudge()` 整个函数（约 70 行）
- 删除 `shouldEscalate()` 整个函数（约 30 行）
- 删除 `resolveDualJudgeConfig()` 整个函数（约 40 行）
- 删除 `resolveDualJudgeConfigFromEnv()`

**`packages/octoclaw-policy/src/judge/judge-prompt.ts`**：
- 删除 `buildRemoteJudgeSystemPrompt()`
- 删除 `buildRemoteJudgeUserPrompt()`

**`packages/octoclaw-policy/src/spec/prompt-builder.ts`**：
- 删除 `buildRemoteJudgeSystemPrompt` / `buildRemoteJudgeUserPrompt` 相关函数

**`extensions/octoclaw-runtime/src/extension-entry.ts`**：
- 删除 `remoteJudgeRaw` / `remoteJudgeFromEnv` / `remoteJudgeFromPlugin` 相关约 15 行

**`extensions/octoclaw-runtime/src/resolve/policy-resolver.ts`**：
- `resolveStatelessPolicyDecision` 里删除 dual judge 相关约 100 行
- `checkActiveTaskRecovery` 保留不动

**合计：约 300 行代码被删除，零功能损失。**

#### 4.6.4 Ollama 特殊处理保留

`isOllamaEndpoint` + `postOllamaNative` 保留，因为 Ollama native API 与标准 OpenAI-compat 有两处差异：
- URL：`/api/chat` 而非 `/chat/completions`
- 参数：用 `format: "json"` 而非 `response_format: { type: "json_object" }`

这是纯内部实现细节，对外接口不变。

---

### 4.7 ACK/Progress 统一——三相模型

**目标架构**：把所有用户可见的 IM 通知统一为三个时刻，一条发送路径。

```
用户消息
  ↓ (<3s)
【Phase 1: ACK】
  "收到，开始处理" / "收到，想一下"
  来源：judge 的 ackText 或小型模板池（每 stage 5-6 条）

  ↓ delegate 路径，event-driven
【Phase 2: Progress transitions】
  "✓ 已派发，排队中"     ← dispatch_materialized
  "⚙️ 已启动"           ← spawn_started
  "⏳ 还在跑..."         ← watchdog heartbeat（仅在无其他进度时）
  "⏱️ 超时"             ← timed_out

  ↓ completion file 写入
【Phase 3: Final result】
  完整结果摘要（来自 WorkerCompletionResult.summary）
```

**reply 路径**不经过 Phase 2（没有 dispatch），直接：ACK → 主 agent 输出结果。

---

#### 4.7.1 单一发送路径

新建 `extensions/octoclaw-runtime/src/im/send.ts`：

```typescript
import { getAdapterForSession } from "./index.js";
import { resolveWorkspaceRoot, runCommand } from "../resolve/env.js";

export interface SendIMParams {
  sessionKey: string;
  message: string;
  replyToMessageId?: string;
  timeoutMs?: number;
  cwd?: string;
}

export interface SendIMResult {
  sent: boolean;
  messageId?: string;
  threadTs?: string;
  error?: string;
}

export async function sendIMMessage(params: SendIMParams): Promise<SendIMResult> {
  const adapter = getAdapterForSession(params.sessionKey);
  if (adapter) {
    const result = await adapter.send({
      sessionKey: params.sessionKey,
      message: params.message,
      replyToMessageId: params.replyToMessageId,
      timeoutMs: params.timeoutMs ?? 5000,
      cwd: params.cwd ?? resolveWorkspaceRoot(),
    });
    return {
      sent: result.sent || result.delivered,
      messageId: result.messageId,
      threadTs: result.threadTs,
      error: result.error,
    };
  }
  return { sent: false, error: "no_im_adapter" };
}
```

`sendAckDirectDetailed`（ack-guard.ts）、`sendExecutionTransitionDirect`（execution-transition-notifier.ts）、`sendFinalMessage`（child-finalizer.ts）全部改为调用 `sendIMMessage`，删除各自的内部实现（约 -150 行）。

---

#### 4.7.2 精简模板池

`ack-templates.ts` 从 ~100 条精简到 ~40 条：

```typescript
// 每个 stage 最多 6 条，覆盖语气变化即可
export const ACK_TEMPLATES = {
  pre_route:  ["收到，看下", "稍等", "收到", "在", "好", "马上看"],
  reply:      ["想一下", "稍等我回你", "在想", "马上", "收到，组织下", "让我想想"],
  delegate:   ["收到，开始处理", "好的，处理中", "在跑了", "开工", "这就安排", "着手处理中"],
  observe:    ["看下情况", "查一下", "在看了", "扫一眼", "检查中", "在查了"],
  queued:     ["排队中，稍等", "前面有任务在跑", "等一下马上到"],
  blocked:    ["卡了，需要点信息", "处理受阻：{reason}", "遇到点问题"],
  stale:      ["还在跑，稍等", "还没好，再等等", "处理中..."],
  timeout:    ["超时了，要继续吗？", "跑的时间有点长，要不要停掉？"],
} as const;

export type AckStageKey = keyof typeof ACK_TEMPLATES;

export function pickAckText(stage: AckStageKey, vars?: Record<string, string>): string {
  const pool = ACK_TEMPLATES[stage];
  const text = pool[Math.floor(Math.random() * pool.length)] as string;
  return vars ? text.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`) : text;
}
```

删除 `ack-template-registry.ts`（第二套模板系统，约 200 行），全部统一到上面这个简单实现。

---

#### 4.7.3 tier 计时器按路由差异化

**delegate 路径**：禁用 tier1/2/3（由 execution transitions 接管进度通知）

```typescript
// ack-timing.ts
export function getAckTierDelays(routePhase: AckRoutePhase): [number, number, number] {
  if (routePhase === "delegate" || routePhase === "observe") {
    return [0, 0, 0];  // 禁用，进度通知由 execution transitions 负责
  }
  // reply / pre_route：保留 tier1/2/3 提醒主 agent 在思考
  return [18_000, 45_000, 120_000];
}
```

**reply 路径**：保留 tier1(18s)/tier2(45s)/tier3(120s)，因为主 agent 直接回答时没有 execution transitions，用户需要这些"还在想"的提示。

---

#### 4.7.4 修复 `no_valid_thread_anchor` 静默 skip

`execution-transition-notifier.ts:377-398`，当 `replyToMessageId` 为空时直接 skip。改为：没有 anchor 时发 top-level 消息（不 reply）而不是 skip。

```typescript
// 改前（错的）：
if (!hasValidTarget || !hasValidThreadAnchor) {
  return { sent: false, skipped: true, reason: "no_valid_thread_anchor" };
}

// 改后（对的）：
if (!hasValidTarget) {
  return { sent: false, skipped: true, reason: "no_valid_target" };
}
// 无 thread anchor → 发 top-level 消息（不 reply），总比静默 skip 好
const result = await sendIMMessage({
  sessionKey: params.sessionKey,
  message: text,
  replyToMessageId: params.replyToMessageId || undefined,  // undefined = 发新消息
  cwd: params.cwd,
});
```

---

#### 4.7.5 改后的用户实际体验

以 delegate 任务为例：

```
用户: "帮我分析这个代码库的架构"

<1s:   "收到，开始处理"          ← Phase 1 ACK（judge ackText 或模板）
~2s:   "✓ 已派发，排队中"        ← Phase 2 dispatch_materialized transition
~3s:   "⚙️ 已启动"              ← Phase 2 spawn_started transition
~3min: "✅ 子任务完成
        代码库整体采用 MVC 分层...（2000字以内结果）
        [route=delegate | model=xxx | workContract=xxx]"
                                 ← Phase 3 Final（来自 completion file）
```

不再有 tier1/2/3 的"还在跑稍等"与 execution transitions 同时出现的情况。全部走同一个 thread，用户体验一致。

---

### 新增文件

```
packages/octoclaw-contracts/src/completion.ts              # WorkerCompletionResult 合同
extensions/octoclaw-runtime/src/delivery/delivery-outbox.ts  # IM delivery 重试队列
extensions/octoclaw-runtime/src/im/send.ts                 # 统一 IM 发送函数（替代3个重复实现）
```

### 重写（保持接口，内部完全重写）

```
extensions/octoclaw-runtime/src/delegate/child-finalizer.ts
  - 删除所有 session 文件扫描逻辑（约 400 行）
  - 改为读 completion file（约 150 行）

extensions/octoclaw-runtime/src/adapter/detached-task-runtime-host.ts
  - 删除所有 minified alias 逻辑
  - 改为 stub runtime（约 50 行）
```

### 修改（局部改动）

```
extensions/octoclaw-runtime/src/tools/registration.ts
  - buildSubagentSpawnMessage：注入 completion file 路径和格式要求

extensions/octoclaw-runtime/src/extension-entry.ts
  - before_prompt_build hook：ACK guard 在 judge 之前启动
  - agent_end hook：触发 deliveryOutbox flush
  - 删除 remoteJudgeRaw / remoteJudgeFromEnv 相关约 15 行

extensions/octoclaw-runtime/src/resolve/env.ts
  - 新增 resolveWorkerCompletionPath(workContractId)
  - 新增 resolveDeliveryOutboxPath()

extensions/octoclaw-runtime/src/ack/ack-timing.ts
  - 新增 getAckTierDelays(routePhase) 函数
  - delegate/observe 路由下 tier1/2/3 返回 [0,0,0]（禁用）

extensions/octoclaw-runtime/src/ack/ack-guard.ts
  - 新增 updateAckGuardDecision(key, decision)
  - sendAckDirectDetailed 改为调用 sendIMMessage

extensions/octoclaw-runtime/src/ack/execution-transition-notifier.ts
  - 修复 no_valid_thread_anchor 静默 skip：改为发 top-level 消息
  - sendExecutionTransitionDirect 改为调用 sendIMMessage

extensions/octoclaw-runtime/src/resolve/policy-resolver.ts
  - resolveStatelessPolicyDecision：删除 dual judge 流程，改为单 judge（约 -100 行）

extensions/octoclaw-runtime/src/im/index.ts
  - 抽取 IMAdapter 接口，改为注册表模式（约 +20 行，整体逻辑变简单）

extensions/octoclaw-runtime/src/state/policy-state.ts
  - PolicyStateEntry 删除 [key: string]: unknown，枚举所有已知字段
  - PolicyStateStore 添加 public entries() 方法，删除 type cast hack

extensions/octoclaw-runtime/src/ack/ack-decision.ts
  - 删除自己定义的 ACK_TIMING 常量，改为从 ack-timing.ts import

extensions/octoclaw-runtime/src/work-contract/materializer.ts
  - mapSubstrateToContractStatus：加 case "lost": return "failed"

extensions/octoclaw-runtime/src/context/delegate-packets.ts
  - buildDelegateHandoffPacket：contextEscalationReason 改为必填，删除 runtime throw
```

```
# ACK/Progress 统一（约 -350 行，零功能损失）

extensions/octoclaw-runtime/src/ack/ack-templates.ts
  - 精简：~100 条文案 → ~40 条（每 stage 保留 5-6 条）

extensions/octoclaw-runtime/src/ack/ack-template-registry.ts
  - 删除整个文件（第二套模板系统，约 200 行）
  - 所有调用方改为用精简后的 ack-templates.ts

extensions/octoclaw-runtime/src/ack/ack-guard.ts
  - 删除 sendAckDirectDetailed 内部 HTTP/CLI 实现（改调 sendIMMessage）
  - 约 -80 行

extensions/octoclaw-runtime/src/ack/execution-transition-notifier.ts
  - 删除 sendExecutionTransitionDirect 内部实现（改调 sendIMMessage）
  - 约 -50 行

extensions/octoclaw-runtime/src/delegate/child-finalizer.ts
  - sendFinalMessage 内部实现已在 P0-T1 重写时改为调用 sendIMMessage

# Judge 瘦身（约 300 行，零功能损失）
...（原有删除条目）
```

packages/octoclaw-policy/src/judge/judge-schema.ts
  - 删除：DualJudgeConfig / RemoteJudgeConfig / EscalationReason / RemoteJudgeOutput
  - 删除：REMOTE_JUDGE_DEFAULTS / ESCALATION_DEFAULTS

extensions/octoclaw-runtime/src/resolve/llm-judge.ts
  - 删除：callRemoteJudge()（约 70 行）
  - 删除：shouldEscalate()（约 30 行）
  - 删除：resolveDualJudgeConfig() / resolveDualJudgeConfigFromEnv()（约 40 行）

packages/octoclaw-policy/src/judge/judge-prompt.ts
  - 删除：buildRemoteJudgeSystemPrompt / buildRemoteJudgeUserPrompt

packages/octoclaw-policy/src/spec/prompt-builder.ts
  - 删除：remote judge 相关 prompt 函数

# 其他
extensions/octoclaw-runtime/src/work-contract/store.ts
  - 文件写入迁移到 task-state.json（接口保留）

extensions/octoclaw-runtime/src/replay/replay-logger.ts
  - recordPolicyReplay 改为 async fire-and-forget，退出 live path
```

---

### 4.8 replay-logger.ts 拆分

**目标**：把 5 种职责拆到 4 个文件，delivery relay 大部分删除。

拆分后结构：

```
extensions/octoclaw-runtime/src/
  receipt.ts              # TurnExecutionReceipt 类型 + buildTurnExecutionReceipt (~300 行)
  replay/
    replay.ts             # appendJsonl / recordPolicyReplay / recordAckReplay (~200 行)
    message-guard.ts      # guardAssistantMessageForPolicyState / sanitizers (~300 行)
    policy-utils.ts       # preHintAllowedTools / workflowEnforcementRule / isDelegatedRoute 等 (~200 行)
    # delivery-relay.ts   ← 不新建，delivery relay 功能由 delivery-outbox.ts 取代
```

**Delivery relay 删除判断**：

`replay-logger.ts` 中 L830-1185 的 delivery relay（`registerPendingDelivery`、`reconcilePendingDeliveriesForSession`、`recordDeliveryRelayEvent`）是一套 IM 投递对账机制。**P0-T1 实施后，delivery 状态写入 `task-state.json`，重试通过 `delivery-outbox.ts` 处理**，delivery relay 的功能被完全替代。

删除前确认：`grep -r "registerPendingDelivery\|reconcilePendingDeliveriesForSession" --include="*.ts"` 若只在 `replay-logger.ts` 和 `extension-entry.ts` 里出现，则可以整块删除。

**迁移 import**：9 个文件 import `replay-logger.ts`，拆分后各自改 import 路径（用 grep 定位每个 import 来自哪个函数）。

---

### 4.9 合并幽灵包

**目标**：把 `octoclaw-fast-reply` 和 `octoclaw-delegation` 的代码内联到 `octoclaw-runtime`，删除两个包。

**步骤**：

1. 在 `extensions/octoclaw-runtime/src/` 下新建 `payloads/` 目录
2. 把 `octoclaw-fast-reply/src/ack/`、`direct/`、`instrumentation/` 的代码移入 `payloads/fast-reply/`
3. 把 `octoclaw-delegation/src/brief/`、`materialize/`、`profiles/` 等移入 `payloads/delegation/`
4. 修改 `runtime-payloads.ts` 的 import 路径
5. 从 `pnpm-workspace.yaml` 删除这两个包，删除对应目录

**注意**：两个包里有测试文件，迁移时一起带过来，继续在 `octoclaw-runtime` 的 vitest 里跑。

---

### 4.10 安装部署重设计

**目标**：一个命令、一个配置文件、插件开关。

#### 4.10.1 统一配置文件

```json
// ~/.octoclaw/config.json  (由 octoclawctl 创建/管理)
{
  "_version": "1",
  "_updatedAt": "2026-04-29T...",

  "enabled": true,

  "features": {
    "delegation": true,
    "imNotifications": true,
    "statusPanel": true
  },

  "judge": {
    "enabled": false,
    "modelId": "",
    "baseUrl": "",
    "apiKey": "",
    "timeoutMs": 1200,
    "minConfidence": 0.6,
    "shadowMode": false,
    "judgeAckEnabled": true
  },

  "models": {
    "mode": "auto",
    "overrides": {}
  }
}
```

安装时由 `octoclawctl install` 引导生成，此后所有 `octoclawctl config set` 都改这一个文件。

#### 4.10.2 插件开关（方案 A）

在 `extension-entry.ts` 的 `register()` 开头加：

```typescript
register(pi: PluginInterface): void {
  if (pi.pluginConfig?.enabled === false) {
    pi.logger?.info?.("octoclaw-runtime: disabled via config");
    return;  // 不注册任何 hook，plugin 加载但不生效
  }
  // ... 正常注册
}
```

`octoclawctl disable` 实现：读取 OpenClaw 的 extension 配置，把 `octoclaw-runtime` 的 pluginConfig 里 `enabled` 改为 `false`，然后重启 OpenClaw。

`octoclawctl enable` 实现：把 `enabled` 改回 `true`，重启。

#### 4.10.3 `openclaw.plugin.json` 清理

删除废弃字段（`remoteJudge`、`timeoutLocalMs`、`local`），加入 `enabled`：

```json
{
  "configSchema": {
    "properties": {
      "enabled": {
        "type": "boolean",
        "default": true,
        "description": "Enable or disable OctoClaw without uninstalling."
      },
      "delegationEnabled": { "type": "boolean", "default": true },
      "judgeFast": {
        "properties": {
          "enabled": { "type": "boolean", "default": false },
          "modelId": { "type": "string" },
          "baseUrl": { "type": "string" },
          "apiKey": { "type": "string" },
          "timeoutMs": { "type": "number", "default": 1200 },
          "minConfidence": { "type": "number", "default": 0.6 },
          "shadowMode": { "type": "boolean", "default": false },
          "judgeAckEnabled": { "type": "boolean", "default": true }
        },
        "required": ["modelId", "baseUrl"]
      }
    }
  }
}
```

#### 4.10.4 `tools/octoclawctl` 合并

将 `tools/install` 和 `tools/manage` 合并为 `tools/octoclawctl`：

```
tools/octoclawctl/src/
  cli.ts          # 命令路由入口
  install.ts      # install/update/deploy 逻辑（合并两个工具）
  config.ts       # config get/set/show 逻辑
  manage.ts       # enable/disable/status/restart
  deploy.ts       # 部署核心（build + rsync + symlink + validate）
  platform.ts     # macOS launchctl / Linux systemd 抽象（替代硬编码 launchctl）
```

命令：
```bash
octoclawctl install          # 首次安装（clone + build + deploy + configure）
octoclawctl update           # 拉最新并重新部署
octoclawctl deploy           # 仅重新部署（开发者用）
octoclawctl status           # 显示版本/配置/健康状态
octoclawctl enable           # 启用插件
octoclawctl disable          # 禁用插件（保留安装）
octoclawctl config           # 交互式配置向导
octoclawctl config set judge.modelId "llama-3.1-8b-instant"
octoclawctl config set judge.baseUrl "https://api.groq.com/openai/v1"
octoclawctl restart          # 重启 OpenClaw 服务
octoclawctl uninstall        # 卸载
```

#### 4.10.5 删除 macOS launchctl 专属逻辑

现在的 `syncJudgeFastEnv`（通过 `launchctl setenv` 同步环境变量）只在 macOS 且 OpenClaw 用 launchd 管理时有效。

替代方案：judge 配置通过 `openclaw.plugin.json` 的 `pluginConfig.judgeFast` 传递（已经支持），完全不需要环境变量同步。删除 `syncJudgeFastEnv` 函数和所有 `launchctl setenv` 调用。

平台差异（重启服务）统一放到 `platform.ts`：

```typescript
export async function restartOpenClaw(openclawHome: string): Promise<void> {
  // 尝试 openclaw gateway restart / openclaw node restart
  // macOS fallback: launchctl kickstart
  // Linux fallback: systemctl restart openclaw 或 pm2 restart
}
```

---

**答案：是，但使用方式要改。**

当前 OctoClaw 通过两条路径使用 OpenClaw：

```
路径 A（稳定）：
Plugin hooks (before_prompt_build / before_tool_call / agent_end)
  + pi.runtime.subagent.run()       # spawn child
  + pi.runtime.subagent.waitForRun()  # wait for run
  + pi.registerTool/Command()
  + taskflow-bridge via createPluginRuntime()  # createManaged / runTask

路径 B（不稳定，必须停止）：
  loadOpenClawDistModule("tasks/task-executor.js")  # 加载内部 bundle
  requireFunctionWithAliases("createQueuedTaskRun", ["a"])  # minified aliases
```

**重构后只使用路径 A**。

OpenClaw 原生 Task 系统（TaskFlow）仍然是 lifecycle 权威，通过 `taskflow-bridge.ts` 的稳定 API 访问。子 agent spawn 通过 `pi.runtime.subagent.run()` 完成。结果收集通过 completion file protocol（而不是扫描 session 文件）。

---

## 七、演进路线与优先级总表

### 优先级总表

| 优先级 | 任务 | 目标 | 预计代码变化 |
|--------|------|------|-------------|
| **P0-T1** | Completion File Protocol | delegate 不再猜结果 | child-finalizer -350行 |
| **P0-T2** | 删除 minified alias | OpenClaw 升级不再断 | -70行 |
| **P0-T3** | ACK guard 先于 judge | judge 超时不影响 ACK | ~10行修改 |
| **P0-T4** | 删除 remote judge | 清除 300 行空转代码 | -300行 |
| **P1-T5** | IM adapter 注册表 | 可插拔其他 IM | +50行新增 |
| **P1-T6** | PolicyStateEntry 类型安全 | TypeScript 恢复检查 | 重写接口 |
| **P1-T7** | ACK/Progress 三相模型 | 消除重复，修复 skip | -350行 |
| **P1-T8** | replay-logger 拆分 | 从 God File 到 4 个职责文件 | 重组 1715行 |
| **P2-T9** | 合并幽灵包 | 减少 2 个 build 步骤 | -913行配置 |
| **P2-T10** | 插件开关 + config 清理 | enable/disable 不用卸载 | +20行，改 plugin.json |
| **P2-T11** | octoclawctl 统一 | 一个安装工具 | 重写 tools/ |
| **QF-1..4** | 4 个小修 | 行为 bug + 代码质量 | 各 <10行 |
| **QF-5** | ACK tier 时间收紧 | 用户体验 | 2 个常量改数字 |
| **QF-6** | Reaction emoji 与 judge 解耦 | 配置灵活性 | +1 configSchema 字段 |

**执行顺序约束**：
- P0 任务必须按 T1→T2→T3→T4 顺序，T1 完成后其他可并行
- P1 任务相互独立，可并行，但 T6 依赖 T5 完成后对类型的更好把握
- P2 任务相互独立，优先做 T10（影响用户开箱体验）
- QF 任务随时可做，5分钟内完成

---

### Phase 0：止血（1-2周）

目标：delegate completion 不再猜结果，IM 里能看到真实结果，ACK 不再受 judge 超时影响

**任务**：P0-T1, P0-T2, P0-T3, P0-T4

验收标准：
- dispatch 后，IM 里能看到子任务的实际结果
- 不再出现"子任务已完成但没有返回可投影的安全结果包"
- `child-finalizer.ts` 不再包含 `.jsonl` 扫描逻辑
- `detached-task-runtime-host.ts` 不再包含 minified alias
- `callRemoteJudge` / `shouldEscalate` 从 codebase 中消失

---

### Phase 1：稳定（2-4周）

目标：状态可信，delivery 有保障，代码质量明显提升

**任务**：P1-T5, P1-T6, P1-T7, P1-T8（可并行）

验收标准：
- `octoclaw_status` 显示的状态与 IM 里的状态一致
- 重启 OpenClaw 后，任务状态不丢失
- `replay-logger.ts` 拆成 4 个文件，无 delivery relay 残留
- delegate 路由下不再有 tier1/2/3 的 "还在跑稍等" 消息
- `no_valid_thread_anchor` 不再导致进度通知静默消失

---

### Phase 2：轻量化 + 开箱体验（1-2周）

目标：更少的包，更好的安装体验，更易扩展

**任务**：P2-T9, P2-T10, P2-T11（建议顺序：T10 → T11 → T9）

验收标准：
- `npx octoclawctl install` 可以完成端到端安装
- `octoclawctl disable` 关闭插件，`octoclawctl enable` 重新开启
- 所有特性配置在 `~/.octoclaw/config.json` 一处管理
- 7 个包/扩展 → 4 个（contracts, policy, runtime, status-surface）
- 无 macOS 专属 launchctl 硬编码

---

### Phase 3：特性扩展（按需）

1. 模型按需选择（judge 已有 `complexity_band` 输出，接上 model mapping）
2. 多任务状态面板（status-surface 读取 task-state.json）
3. Retry / Resume（WorkContract 里已有 `nextAction: "retry"` 字段）
4. 反哺 OpenClaw：completion file protocol 作为标准化 PR 提交上游

---

### 开源高星路径

完成 Phase 0 + Phase 2 后的 before/after：

**Before**：
> 在 Slack 里说"帮我分析一下这个代码库"，agent 说"好的我帮你看"，然后……就没有然后了。5分钟后也不知道在哪里卡住了。

**After**：
> `npx octoclawctl install` → 向导 3 步配置完成  
> 在 Slack 里说"帮我分析一下这个代码库"  
> agent 1秒内回复"收到，开始处理"  
> 3分钟后在同一 thread 回复完整分析结果

这个具体的 before/after，加上"一条命令安装，不需要修改你的任何 agent prompt"，才是开源项目能 star 的 pitch。

---

## 附录：关键代码位置索引

| 问题 | 文件 | 行数 |
|------|------|------|
| 子 agent spawn | `registration.ts` | L741-810 |
| 猜结果（路径1） | `child-finalizer.ts` | L185-228 |
| 猜结果（路径2，文件扫描） | `child-finalizer.ts` | L119-174 |
| Minified aliases | `detached-task-runtime-host.ts` | L9-17 |
| ACK guard 时序 | `extension-entry.ts` | L800-880 |
| 状态多源合并 | `registration.ts` | L611-711 |
| IM delivery 静默失败 | `child-finalizer.ts` | L304-324 |
| Worker prompt 注入点 | `registration.ts` | L729-739 |
| TaskFlow bridge（稳定部分） | `taskflow-bridge.ts` | L346-549 |
| 轮询循环 | `child-finalizer.ts` | L438-524 |
| Remote judge（待删）| `llm-judge.ts` | L516-589 |
| shouldEscalate（待删） | `llm-judge.ts` | L485-513 |
| resolveDualJudgeConfig（待删） | `llm-judge.ts` | L139-170 |
| dual judge 调用流程（待简化） | `policy-resolver.ts` | L1580-1880 |
| IM adapter 硬编码 | `im/index.ts` | L27-36 |
| PolicyStateEntry 索引签名 | `policy-state.ts` | L34 |
| ACK 常量重复定义 | `ack-decision.ts` | L42-49 |
| "lost" 映射 bug | `materializer.ts` | L52（default case） |
| delegate-packets runtime throw | `delegate-packets.ts` | L70-72 |
| ACK/Progress 两套系统重叠 | `ack-guard.ts` tier 系统 + `execution-transition-notifier.ts` | P12 |
| 三处重复发送函数 | `ack-guard.ts` L444 / `execution-transition-notifier.ts` L115 / `child-finalizer.ts` L304 | P12 |
| no_valid_thread_anchor skip | `execution-transition-notifier.ts` | L377-398 |
| 模板池 ~100 条随机 | `ack-templates.ts` | 全文 |
| 第二套模板系统（待删） | `ack-template-registry.ts` | 全文 |
