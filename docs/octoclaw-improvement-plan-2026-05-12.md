# OctoClaw 改进计划 2026-05-12

日期：2026-05-12
分支：`v0.5.0`
状态：落地计划（与 `octoclaw-ts-rebuild-design-v2.md` 配套，作为下一轮执行的具体任务拆分）

> **2026-05-15 更新**：W-1（router-lite 接线）和 W-2（流式 ACK skip）已完成并归档。
> 对应 openspec change 已移至 `openspec/changes/archive/`。
> 当前 active 工作：W-3（拆 extension-entry）、W-4（删 placeholder）、W-5/W-6（见 roadmap）。

本文只描述**未完成**的改进项。已经在 2026-05-12 作为"性价比快改"落地的三件事见本文最后的附录。

关联的 OpenSpec change 包：

- `openspec/changes/archive/autorouter-lite-wiring-0.5.x/`（W-1，**已完成**）
- `openspec/changes/archive/runtime-streaming-ack-skip-0.5.x/`（W-2，**已完成**）
- `openspec/changes/runtime-extension-entry-slim-0.5.x/`（W-3，本文 §3）
- `openspec/changes/runtime-dead-placeholder-removal-0.5.x/`（W-4，本文 §4）

---

## 0. 一句话

TS 重构完成后，OctoClaw 剩下的事不是再重写，是做三件事：

1. **接线**：`router-lite` 只差一座桥就能跑起来。
2. **卸重**：`extension-entry.ts` 5200 行，`tools/registration.ts` 3000 行，这两块是新人无法快速上手的主因。
3. **去幻影**：TS 重构初期埋的 placeholder / no-op 还在，让人误以为系统比实际功能更复杂。

下面按优先级排 W-1 到 W-6。W-1、W-2 是本月可以做完的。W-3、W-4 可以穿插进行。W-5、W-6 依赖前面几步，所以排在最后。

---

## 1. W-1：Auto Router Lite 接线（shadow bridge）

**优先级**：P1（最高）
**预估**：2-4 天实现 + 3-7 天 shadow 观测
**落点**：`extensions/octoclaw-runtime/src/router-lite/shadow-bridge.ts`（新建）、`resolve/policy-resolver.ts`（接线点）
**OpenSpec**：`autorouter-lite-wiring-0.5.x`

### 1.1 现状

`packages/octoclaw-policy/src/router-lite/` 下 `selectShadowRecommendation`、`writeShadowEvent`、`buildModelIntelSnapshot`、`analyzeModelConfig` 四件套齐全，有单元测试。但整个 `extensions/octoclaw-runtime/` 里**一次都没 import**，实际 runtime 完全不知道 router-lite 的存在。

也就是说 A（snapshot）和 B（proposal）可以通过 `octoclawctl router model-intel refresh` / `octoclawctl router model-config analyze` 手动跑，C（shadow recommendation）完全没接。

### 1.2 目标

让每次委派决策都在 **shadow lane** 同步写一条推荐事件到 `~/.openclaw/workspace/tmp/octopus/router-lite/shadow.jsonl`，包括：

- `actualModel`：实际被路由/配置的模型。
- `recommendedModel`：如果有推荐。
- `eligibleModels` / `rejectedModels` / `ignoredReason`。
- 预估 `estimatedCostDeltaUsd`（基于 snapshot 的 market price）。
- `judge` 的 4 字段（route / confidence / complexity / complexityConfidence）。

**硬约束**：

- shadow 失败（snapshot missing、IO error、JSON parse error）**绝不能**影响 live route、dispatch、ACK、footer。必须 `try/catch` 包死。
- shadow **只读** snapshot 文件。不在 user message 热路径发起远端价格/catalog 请求。snapshot 刷新是独立 CLI 任务。
- 不修改 judge 的 schema，不恢复 `role / workType / scope / tool_need_hint / duration_hint` 胖字段。

### 1.3 实现切片

#### 1.3.1 `SnapshotLoader`

新文件：`extensions/octoclaw-runtime/src/router-lite/snapshot-loader.ts`

```ts
import fsSync from "node:fs";
import path from "node:path";
import type { ModelIntelSnapshot } from "@octoclaw/policy/router-lite";
import { resolveWorkspaceRoot } from "../resolve/env.js";

interface CachedSnapshot {
  snapshot: ModelIntelSnapshot | null;
  loadedAt: number;
  mtimeMs: number;
  path: string;
}

const CACHE_TTL_MS = 60_000;  // 1 分钟内复用
let cached: CachedSnapshot | null = null;

export function resolveSnapshotPath(): string {
  // 默认 ~/.openclaw/workspace/tmp/octopus/router-lite/model-intel-snapshot.json
  // 可被 OCTOCLAW_ROUTER_SNAPSHOT_PATH 覆盖。
  ...
}

export function loadRouterLiteSnapshot(): ModelIntelSnapshot | null {
  // 无文件：返回 null（不报错，shadow 只是没东西可比）。
  // 文件损坏：返回 null（记录一次 debug 日志，不抛）。
  // mtime 未变：用 cached。
  ...
}
```

为什么要 cache：policy-resolver 可能一次 turn 被调多次，不能每次都读盘。

#### 1.3.2 `buildRouterLiteRequest`

新文件：`extensions/octoclaw-runtime/src/router-lite/request-builder.ts`

从现有的 `PolicyDecision` + `ManagedContext` + `JudgeResult` 抽出 `RouterLiteRequest`。不访问原始 transcript，只用结构化字段：

```ts
export function buildRouterLiteRequest(input: {
  sessionKey: string;
  turnId: string;
  decision: PolicyDecision;
  judgeResult: LLMJudgeResult | null;
  runtimeSignals: {
    channel?: string;
    contextTokens?: number;
    statusOrProvenanceRequest?: boolean;
    sessionControlRequest?: boolean;
  };
  snapshotId: string;
}): RouterLiteRequest | null {
  // judgeResult 为 null 或缺必需字段时返回 null，shadow 跳过。
  ...
}
```

#### 1.3.3 `shadow-bridge.ts`

新文件：`extensions/octoclaw-runtime/src/router-lite/shadow-bridge.ts`

```ts
import { selectShadowRecommendation, writeShadowEvent } from "@octoclaw/policy/router-lite";
import { buildRouterLiteRequest } from "./request-builder.js";
import { loadRouterLiteSnapshot, resolveShadowEventPath } from "./snapshot-loader.js";

export function emitRouterLiteShadowEvent(input: {
  sessionKey: string;
  turnId: string;
  decision: PolicyDecision;
  judgeResult: LLMJudgeResult | null;
  actualModel: string | undefined;
  runtimeSignals: RouterLiteRuntimeSignals;
  logger?: LoggerLike;
}): void {
  try {
    const snapshot = loadRouterLiteSnapshot();
    if (!snapshot) return;  // no snapshot, nothing to compare
    const request = buildRouterLiteRequest({
      ...input,
      snapshotId: snapshot.snapshotId,
    });
    if (!request) return;
    const recommendation = selectShadowRecommendation(request, snapshot);
    const event = {
      event: "router_lite_recommendation" as const,
      turnId: input.turnId,
      snapshotId: snapshot.snapshotId,
      liveRoute: request.liveRoute,
      actualModel: input.actualModel,
      recommendation,
      judge: request.judge,
      scenario: recommendation.scenario,
      qualityGate: "unknown" as const,
      estimatedCostDeltaUsd: computeCostDelta(snapshot, input.actualModel, recommendation.recommendedModel),
    };
    writeShadowEvent(event, resolveShadowEventPath(), {
      onError: (err) => input.logger?.warn?.(`[router-lite] shadow event write failed: ${err}`),
    });
  } catch (error) {
    // 绝对不能冒泡。
    input.logger?.warn?.(`[router-lite] shadow bridge error: ${String(error)}`);
  }
}
```

#### 1.3.4 挂接点

挂在 `extensions/octoclaw-runtime/src/resolve/policy-resolver.ts` 里 `resolvePolicyDecisionForContext()` 返回决策后，在 `recordPolicyReplay()` 之前：

```ts
// 只在 decision 产生了新 WorkContract 的新 turn 走一次
if (decisionProducedNewRoute) {
  emitRouterLiteShadowEvent({
    sessionKey,
    turnId,
    decision,
    judgeResult: latestJudgeResult,
    actualModel: resolveActualModel(decision),
    runtimeSignals: buildRuntimeSignals(context, decision),
    logger: pi.logger,
  });
}
```

#### 1.3.5 成本差计算

简单版：

```ts
function computeCostDelta(snapshot, actualModel, recommendedModel): number | undefined {
  if (!actualModel || !recommendedModel || actualModel === recommendedModel) return 0;
  const actual = snapshot.models.find(m => m.modelKey === actualModel);
  const rec = snapshot.models.find(m => m.modelKey === recommendedModel);
  if (!actual?.marketPrice.blendedUsdPerMTok || !rec?.marketPrice.blendedUsdPerMTok) return undefined;
  // 假设一次任务约 10k input + 3k output，这只是 order-of-magnitude
  const assumedMTokens = 0.013;
  return (rec.marketPrice.blendedUsdPerMTok - actual.marketPrice.blendedUsdPerMTok) * assumedMTokens;
}
```

后面可以接 runtime 实际 token 统计。第一版不需要精确。

### 1.4 测试

1. `shadow-bridge.test.ts`：
   - snapshot 缺失 → 不抛，返回 void，无 event 写出。
   - snapshot 损坏 → 不抛，logger.warn 一次。
   - 正常 → 写一行 jsonl，字段完整。
   - `judge.confidence < 0.65` → `ignoredReason=low_confidence`。
   - `statusOrProvenanceRequest=true` → `ignoredReason=status_or_provenance_request`。

2. `policy-resolver.shadow.test.ts`：
   - live route = reply，路由未改 → shadow 仍写入（要有数据做基线）。
   - live route = delegate，有 recommendation → 正常。
   - shadow throw → policy-resolver 正常返回，不报错。

3. CLI：给 `octoclawctl router shadow-report` 增加一个聚合 summary 命令，展示 `totalEvents`、`uniqueModelsRecommended`、`ignoredReasonCounts`、`estimatedCostDeltaTotalUsd`。

### 1.5 验收

- shadow jsonl 每天自然累积，重启后仍稳定。
- 3-7 天样本后 `octoclawctl router shadow-report` 能输出有意义的数据。
- `pnpm test` 没有新增失败。
- 手动 toggle `OCTOCLAW_ROUTER_SNAPSHOT_PATH=/tmp/nonexistent` 后，runtime 不受影响。

### 1.6 禁止项

- 不改 judge schema。
- 不在热路径 fetch 远端 catalog。
- 不自动写 OpenClaw 配置。
- 不让 `configured=false` 进入 live。
- 不在 shadow 失败时降级整个 policy-resolver。

---

## 2. W-2：流式 channel 跳过 tier timer

**优先级**：P2
**预估**：半天
**落点**：`extensions/octoclaw-runtime/src/ack/ack-timing.ts`、`ack/ack-guard.ts`
**OpenSpec**：`runtime-streaming-ack-skip-0.5.x`

### 2.1 现状

`ack-decision.ts` 已经正确地把 `finalResponseStreaming` 作为 HIGHEST PRIORITY suppress 所有 ACK。这条逻辑是对的。

但是 tier1/tier2/tier3 的 `setTimeout` 是在 `createAckTimers()` 里提前调度的，流式开始后才会被 `cancelAckTimers()` 取消。

两个副作用：

1. **浪费**：Slack 默认流式（`streamingMode=partial` + `nativeTransport=true`），tier timer 从一开始就没机会 fire，但还是占了 timer 槽、state map、dedupe key。
2. **测试噪声**：不少 tier timer 相关测试需要 mock `finalResponseStreaming` 才能避免干扰。

### 2.2 目标

`createAckTimers()` 在调度前检查 channel 的 streaming 能力。如果 `canStreamNative=true` 且 `streamingMode !== "off"`，直接不调度任何 tier timer。Slack L2 默认行为。Feishu L1 / WeChat L0 保留原行为。

### 2.3 实现切片

#### 2.3.1 给 `createAckTimers` 加参数

```ts
export interface CreateAckTimersParams {
  stateKey: string;
  sessionKey: string;
  routePhase: AckRoutePhase;
  inboundTs?: number;
  onTierFire: (result: AckTimerResult) => void;
  config?: Partial<AckTimingConfig>;
  channelStreaming?: "native" | "partial" | "off";  // 新增
}
```

#### 2.3.2 skip 条件

```ts
export function createAckTimers(params: CreateAckTimersParams): AckTimerState {
  // ... 现有代码
  const streamingSkipsTiers = params.channelStreaming === "native";
  for (let tier = 0; tier <= 3; tier++) {
    if (streamingSkipsTiers) continue;   // <— 新增
    const delayMs = tierDelays[tier] ?? config.tierDelaysMs[tier];
    if (!delayMs || !shouldScheduleTier(state.routePhase, tier)) continue;
    // ...
  }
  return state;
}
```

#### 2.3.3 上游传值

`ack-guard.ts` 里调用 `createAckTimers` 的地方，从 IMAdapter capability 读：

```ts
const adapter = getAdapterForSession(sessionKey);
const streaming = adapter?.capabilities?.canStreamNative
  ? "native"
  : adapter?.capabilities?.supportsStreaming === true
    ? "partial"
    : "off";

createAckTimers({
  ...,
  channelStreaming: streaming,
});
```

（如果 adapter.capabilities 现在没有 `canStreamNative` / `supportsStreaming` 字段，先加。）

### 2.4 测试

1. Slack adapter（`canStreamNative=true`）的 turn：
   - 模拟 30 秒、60 秒、120 秒内不发生 firstToken。
   - 断言：无 tier1/tier2/tier3 ACK 发出。
   - 断言：timer state map 里不存在 tier1/2/3 entry。

2. Feishu adapter（`canStreamNative=false`）的 turn：
   - 断言：tier1（12s）、tier2（30s）正常 fire。

3. 回归：`ack-timing.test.ts` 已有的用例不带 `channelStreaming` 时，行为应与当前一致。

### 2.5 验收

- `pnpm vitest run extensions/octoclaw-runtime/src/ack/` 全绿。
- Slack 实测：长任务不再出现 "task_still_working" tier 文案（之前因为流式 suppress 只是看不到，但 timer 还在跑）。

### 2.6 禁止项

- 不改 `decideAckAction()` 的 suppress 优先级（那是对的）。
- 不删 Feishu/WeChat 的 tier timer 路径。

---

## 3. W-3：拆 `extension-entry.ts`

**优先级**：P2
**预估**：3-5 天（分 3 个 slice）
**落点**：`extensions/octoclaw-runtime/src/extension-entry.ts`（5234 行）
**OpenSpec**：`runtime-extension-entry-slim-0.5.x`

### 3.1 现状

这个文件现在承担：

- 4 个 OpenClaw hook 的编排（`before_prompt_build` / `before_tool_call` / `before_model_resolve` / `agent_end` / `after_tool_call`）。
- `LATENCY_ACK_DELAY_MS` 常量、4 个 pending-timer `Map`、2 个 neutral ACK fallback timer Map。
- IM footer 渲染选择、`OCTOCLAW_FOOTER_DEBUG` 等遗留开关。
- Dispatch result 解析、用户可见文案生成。
- Speculative preload 状态解析。
- Budgeted main 状态解析 + escalation 触发。
- `OCTOCLAW_DELEGATION_SYSTEM_CONTEXT` 两个大字符串常量。
- Grounded prompt 记忆（`lastGroundedPromptByStateKey` Map）。

5234 行里至少有 5 套独立职责在共用 module state。这是后续改动最大的风险面。

### 3.2 目标

不改变行为，按职责拆成 5-6 个文件。`extension-entry.ts` 最终只剩 hook 注册表和薄编排，应该 < 1000 行。

### 3.3 切片顺序

**Slice 3.A：抽 ACK 子系统全局状态到 `ack/ack-scheduler.ts`**

搬家的目标：

- `LATENCY_ACK_DELAY_MS`
- `pendingLatencyAckTimers`
- `pendingNeutralInboundAckTimers`
- `pendingNeutralInboundAckTextFallbackTimers`
- `pendingBudgetedMainTimers`
- `configuredNeutralAckDelayMs` / `configuredNeutralAckTextFallbackDelayMs`
- `neutralAckTimerKey` / `neutralAckTextFallbackTimerKey` / `parseNeutralAckTimerKey`

导出一个 `AckScheduler` 对象，`extension-entry` 用 `AckScheduler.schedule(...)` / `AckScheduler.cancel(...)` 调用。

验收：`pnpm test` 全绿；ACK 相关测试行数下降但断言不变。

**Slice 3.B：抽 footer 渲染 / IM 发送选择到 `im/footer-mode.ts`**

搬家：

- `OCTOCLAW_FOOTER_DEBUG` / `OCTOCLAW_REPLY_PROJECTION_FOOTER` 两个 legacy 开关的解析
- footer mode 选择
- `buildIMProjectionFooter` 相关 stub 调用

验收：`im-status-renderer.test.ts` 全绿。

**Slice 3.C：抽 delegation system context 注入到 `delegate/system-context.ts`**

搬家：

- `OCTOCLAW_DELEGATION_SYSTEM_CONTEXT` 两个大常量
- `OCTOCLAW_DELEGATION_SLIM_SYSTEM_CONTEXT`
- `resolveSlimMainContextEnabled`

`extension-entry` 只剩 `appendSystemContext(...)` 调用。

**Slice 3.D：抽 speculative preload hook 处理到 `delegate/speculative-preload-handler.ts`**

把 `before_tool_call` 里约 400 行的 speculative preload 分支搬出去。

**Slice 3.E：hook 编排按 hook 名拆文件**

- `hooks/before-prompt-build.ts`
- `hooks/before-tool-call.ts`
- `hooks/before-model-resolve.ts`
- `hooks/agent-end.ts`
- `hooks/after-tool-call.ts`

`extension-entry.ts` 只剩 `register(pi)` 的 hook 映射：

```ts
export function register(pi: PluginInterface): void {
  pi.registerHook("before_prompt_build", makeBeforePromptBuildHook(pi));
  pi.registerHook("before_tool_call", makeBeforeToolCallHook(pi));
  ...
}
```

### 3.4 硬约束

- 每个 slice 单独 commit，`pnpm check && pnpm test` 必须通过后再下一个。
- 不引入新行为。如果发现 bug，先记一个 issue，不顺手修（避免 slice 变大）。
- module-level 全局 `Map` 必须继续在 module scope，不能变 class 字段（会改变测试的 reset 方式）。

### 3.5 验收

- `extension-entry.ts` < 1000 行。
- 新拆的每个文件 < 400 行。
- 所有测试绿。
- 没有新增 `any`。
- Slack smoke 通过。

### 3.6 禁止项

- 不改 hook 语义，不改 ACK timing。
- 不顺手重构 `conversation-grounding.ts`（那是另一个 P3 事项）。

---

## 4. W-4：删除死 placeholder 和 no-op

**优先级**：P3
**预估**：1 天
**OpenSpec**：`runtime-dead-placeholder-removal-0.5.x`

### 4.1 清单

状态更新（2026-05-18）：`native-truth-acp-fallback-relay-slimming-0.6.x`
删除 closeout 后，`core/workflow/*`、`core/requests/*` 以及相关 no-op
re-export 已不存在；下表是历史清理计划，不代表当前 live path。

| 目标 | 文件 | 状态 |
|------|------|------|
| `buildCompoundPolicyPlaceholder` | `packages/octoclaw-policy/src/compound/index.ts` | 返回 `availableInLivePath: false`；被 `judgeFast()` 输出引用 |
| `buildCompoundDelegationPlaceholder` | `extensions/octoclaw-runtime/src/payloads/delegation/compound/index.ts` | 被 `runtime-payloads.ts` 引用作为 `compound:` 字段 |
| `createNoOpThreadAggregator` | `extensions/octoclaw-runtime/src/core/workflow/thread-aggregation.ts` | 无 consumer |
| `createNoOpSurfaceBindingStore` | `extensions/octoclaw-runtime/src/core/requests/surface-binding.ts` | 无 consumer |

### 4.2 实施

#### 4.2.1 Thread aggregator / surface binding（最快）

两个 no-op 都没 consumer（`grep_search` 确认）。直接：

- 删 `thread-aggregation.ts` 和 `surface-binding.ts`。
- 从 `core/workflow/index.ts` 和 `core/requests/index.ts` 的 re-export 里去掉。

#### 4.2.2 Compound placeholder（有引用，需更小心）

`judgeFast()` 的 return type 里带了 `compound: CompoundPolicyPlaceholder`。`runtime-payloads.ts` 的返回 object 里带了 `compound: compoundPlaceholder`。但没有任何 downstream 代码**读**这个字段。

策略：

1. 第一个 PR：从 `runtime-payloads.ts` 的返回 object 里删 `compound:` 字段，从 `runtime-payloads.test.ts` 相关断言里删。
2. 第二个 PR：从 `judgeFast()` 的 return type 里删 `compound`，删 `packages/octoclaw-policy/src/compound/` 整个目录。
3. 第三个 PR：同样删 `extensions/octoclaw-runtime/src/payloads/delegation/compound/`。

分 3 个 PR 是因为 `compound` 占位的消费链跨了 contract/policy/runtime 三个包。

### 4.3 验收

- `rg "compound" packages/ extensions/ | grep -v ".md"` 基本清零（只剩 `CoordinationMode` 里的 `compound` enum 值和对应测试）。
- `pnpm check` 通过。
- `pnpm test` 通过（可能需要更新 `runtime-payloads.test.ts` 和 `judge/index.test.ts` 的 snapshot）。

---

## 5. W-5：运行时 gate 收敛（已有 spec）

**优先级**：P1（但已有 openspec 在推进）
**状态**：`openspec/changes/runtime-gate-convergence-0.5.x/` 已经存在，`tasks.md` 的 WP-A / WP-B / WP-C / WP-D 已标 [x]，WP-E 和 WP-F 的一部分还是 [ ]。

### 5.1 需要收尾的 task（来自 `tasks.md`）

- `WP-E`：user-visible footer/started 文案
  - [ ] `model` footer 使用 actual selected / spawn model
  - [ ] "started/delegated" 文案需要 native accepted + confirm 双证据
  - [ ] 增加 "main fallback" 状态标签
  - [ ] 删掉 "还没派发成功" 这种会误导的兜底文案
- `WP-F`：验证和部署
  - [ ] `npx gitnexus detect-changes --scope staged`
  - [ ] Slack smoke 5 个 case

### 5.2 建议

这块不重写，只是排进 N1 结尾。建议把 `WP-E` 拆成 3 个 500 行以内的 PR（footer 真实模型 / started 文案 / main-fallback 状态），避免一个大 PR 改 registration.ts + im-status-renderer.ts + extension-entry.ts 三处。

---

## 6. W-6：timeout watchdog 和 canonical status（已有 spec）

**优先级**：P2
**状态**：`openspec/changes/runtime-timeout-watchdog-evidence-0.5.x/` 已经存在，`specs/` 下已经有 spec。对应设计文档：`docs/octoclaw-timeout-watchdog-evidence-design-2026-05-12.md` Phase 1 已实现。

### 6.1 剩余工作（建议）

Phase 1 已落地基本的 `running / running_slow / stalled / timed_out` 判定。Phase 2 主要是：

- `degraded(completed_without_result)`：native completed 但没 result receipt 的明确降级标签
- `delivered`：status 投影里明确区分 "completion event 到" 和 "final relay 真的送达"
- operator surface（`octoclawctl status` / `octoclawctl details`）展示 compact verdict 而不是 raw native state

### 6.2 建议

打包进一个 `WP-Watchdog-Phase2` 补丁，单独在 change 包里加一份 `tasks.md`。不要扩大现有 spec 的范围。

---

## 优先级和顺序

```text
本月可做完：
  W-1  router-lite 接线          P1
  W-2  流式 channel 跳 tier timer P2
  W-5  gate convergence 收尾      P1
  CI 修复                         P1（已完成 2026-05-12）
  archive bloated active docs     P2（已完成 2026-05-12）

下月：
  W-3  extension-entry 拆分       P2
  W-4  删 placeholder             P3

之后：
  W-6  timeout watchdog Phase 2   P2
```

W-1 和 W-5 同时做，因为都是 P1 但落点完全不重叠（W-1 在 policy-resolver 之后旁路，W-5 在 dispatch admission 内部）。

W-3 不要和 W-1 并行，因为 W-1 要在 `policy-resolver.ts` 接线，W-3 的 Slice 3.E 会改 hook 注册。冲突小，但建议先 W-1 上线跑 shadow，再开 W-3。

---

## 附录 A：2026-05-12 已落地的快改

| 改动 | 文件 |
|------|------|
| README 中英文按场景化痛点重写 | `README.md` / `README.zh-CN.md` |
| CI 从废弃的 Python/`tests/` 改成 `pnpm check && pnpm test` | `.github/workflows/test.yml` |
| 删除 `${WORKSPACE}/` 误展开目录，`.gitignore` 加防护 | `.gitignore` |
| 归档 8 份已完成设计快照（保留 19 份活跃，从 27 降下来）| `docs/archive/*` |
| 本改进计划 | `docs/octoclaw-improvement-plan-2026-05-12.md` |

归档的 8 份：

- `octoclaw-dispatch-latency-preload-design-2026-05-03.md`
- `octoclaw-fast-delegate-before-dispatch-design-2026-05-02.md`
- `octoclaw-judge-dispatch-complexity-improvement-2026-05-01.md`
- `octoclaw-n1-runtime-ledger-repair-packet-2026-05-01.md`
- `octoclaw-native-slimming-implementation-plan-2026-05-01.md`
- `octoclaw-nightly-eval-scheduler-2026-04-26.md`
- `octoclaw-openclaw-native-slimming-review-2026-05-01.md`
- `openclaw-prep-performance-upstream-design-2026-05-06.md`

---

## 附录 B：已发现的 pre-existing 失败

`pnpm test` 在当前 HEAD（`v0.5.0` 分支）有 6 个 failing，与本改进计划无关。建议在 W-5 收尾时顺带 triage：

- `extensions/octoclaw-runtime/src/fast-delegate/no-double-judge.test.ts > ... > reuses the cached policy decision across before-dispatch and later lifecycle hooks`
- `extensions/octoclaw-runtime/src/tools/registration-dispatch-honesty.test.ts > ... > status panel projects stale running tasks with elapsed/model/backend fields`
- `extensions/octoclaw-runtime/src/tools/registration-dispatch-honesty.test.ts > ... > does not project explicit spawnExecuted=false plus continuity key as running`
- `extensions/octoclaw-runtime/src/tools/registration-planner.test.ts > ... > returns a native sessions_spawn plan with ledger admission and without legacy materialization side effects`
- `extensions/octoclaw-runtime/src/tools/registration-planner.test.ts > ... > filters broad planner context_refs before deciding explicit child context`
- `extensions/octoclaw-runtime/src/tools/registration-planner.test.ts > ... > rejects planner dispatch when admission dry-run does not issue a new-work ticket`

---

## 附录 C：不要做的事

1. 不要重写 judge。现有 4 字段（route / confidence / complexity / complexityConfidence）够用。
2. 不要引入新 router 作为 live authority。Auto Router Lite 只做推荐。
3. 不要加 keyword-based routing 或 blocking。所有判定必须来自结构化信号。
4. 不要把未配置模型放进 live。
5. 不要把 `quotaPressure=unknown` 当免费。
6. 不要在用户消息热路径发起外网 pricing/catalog 请求。
7. 不要为了性能重新造 warm pool / resident runner。
8. 不要把 `task-state.json` 当 durable truth。
