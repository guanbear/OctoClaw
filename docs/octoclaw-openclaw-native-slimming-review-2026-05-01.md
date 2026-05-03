# OctoClaw 基于 OpenClaw 原生能力的瘦身与稳定性审查

日期：2026-05-01

范围：OctoClaw refactor 0.4.0 stable、OpenClaw upstream v2026.4.21 到 v2026.4.29 的能力变化，以及当前 OctoClaw runtime、ACK、footer、judge、Slack/IM 适配实现。

配套落地文档：[`octoclaw-native-slimming-implementation-plan-2026-05-01.md`](./octoclaw-native-slimming-implementation-plan-2026-05-01.md)。本文件负责审查结论和方向判断；落地文档负责逐阶段改哪些文件、怎么接 OpenClaw 原生能力、预期目标和验收标准。

## 1. 总体结论

OctoClaw 的产品目标是成立的：

- 更早给用户反馈，降低“没反应”的等待感。
- 主 agent 遇到阻塞、长耗时、高上下文消耗任务时，把工作交给子 agent。
- 子 agent 按任务复杂度选便宜模型，降低成本。
- 子 agent 与主 agent 上下文隔离，减少主上下文污染。
- 对 Slack 等 IM 场景做更自然的 ACK、状态、结果投递体验。

当前实现的问题不是目标错，而是 OctoClaw 现在承担了太多 OpenClaw runtime 已经或正在原生承担的职责。它同时在做策略层、任务 runtime、状态存储、调度器、完成协议、投递 outbox、IM 发送、ACK 状态机和 judge。这样会导致实现重、恢复路径多、状态源不一致，也让很多边界 bug 难以消除。

建议的目标定位是：

> OctoClaw 保留为“策略 / 语义合同 / 成本模型 / IM 体验”层，把执行真相交回 OpenClaw 原生 runtime。

换句话说，OctoClaw 不需要变成另一个 OpenClaw runtime。它最有价值的部分应该是：

- 判断当前请求是直接回复、状态查询、还是可委派新工作。
- 为委派工作生成清晰的 WorkContract。
- 选择合适的子 agent role、model、thinking、context 策略。
- 给 IM 用户展示自然、准确、不过度打扰的状态。
- 记录 replay/eval，帮助持续调优 judge 和路由策略。

执行、任务状态、完成通知、投递重试、线程路由、反应 ACK，尽量使用 OpenClaw 原生能力。

0.5.0 的重大重构方向应明确为 **`sessions_spawn planner/confirm` 主线**：OctoClaw 仍负责 judge、admission、WorkContract、模型成本策略和 IM 体验，但不在 plugin 内自建完整执行 runtime。因为 OpenClaw v2026.4.29 的 plugin SDK 还没有暴露完整等价于 `sessions_spawn` 的 direct spawn API，0.5.0 不应把 `api.runtime.subagent.run()` 当主路径，也不应 import OpenClaw 内部 `spawnSubagentDirect()`。正确过渡方案是：`octoclaw_dispatch` 生成经过 admission 的 spawn plan，主 agent 调原生 `sessions_spawn`，再用 `octoclaw_dispatch_confirm` 把 `runId/childSessionKey` 写回 OctoClaw metadata。这样可以吃到 OpenClaw 原生 registry、TaskFlow/status projection、subagent announce/delivery，同时把上下文污染控制在极短的 planner/confirm 握手内。

这里的“原生替代”需要有清晰边界：OpenClaw 原生能力替代的是执行 runtime、run registry、child lifecycle、completion announce 和 delivery retry，不是替代 OctoClaw 全部产品数据。WorkContract、route seal、judge replay、model/cost policy、ACK 去重、IM turn anchor、spawn intent audit 仍然应由 OctoClaw 保存。这样重构后不会因为删掉自建 scheduler/finalizer 就失去 OctoClaw 的业务语义，也不会把未暴露的 plugin SDK 能力误写成已经可直接调用。

## 2. OpenClaw 原生能力可以吃掉的轮子

### 2.1 原生 sessions_spawn

OpenClaw v2026.4.29 的 `sessions_spawn` 已经具备 OctoClaw 需要的大部分委派基础能力：

- 非阻塞，接受后立即返回 run id。
- 支持单次 background run，也支持 session 模式。
- 支持 `model`、`thinking`、`runTimeoutSeconds`。
- 子 agent 使用新的 child session，与 requester transcript 分离；支持 `lightContext` 和 attachments 控制上下文负载。
- 支持 cleanup、sandbox、runtime/acp 等选项。
- 子 agent 作为 background task 被跟踪。
- 完成后由 OpenClaw 原生 announce 回 requester chat。

这意味着 OctoClaw 的委派执行路径应收敛成一个 planner/confirm 薄协议，而不是在 plugin 内直接重造 spawn runtime：

1. judge 决定候选 route。
2. WorkContract seal。
3. admission 校验 `is_new_work`、`expected_deliverable`、follow-up 禁止 spawn 等硬条件。
4. model/cost policy 选出子 agent 参数。
5. `octoclaw_dispatch` 返回 `NativeSpawnIntent` 和精简 `sessionsSpawnArgs`，不直接声称已委派。
6. `before_tool_call` 只允许与 intent hash 匹配的下一次 `sessions_spawn`。
7. 主 agent 调 OpenClaw 原生 `sessions_spawn`。
8. `octoclaw_dispatch_confirm` 校验 `runId`，写入 native refs，并在此后才发 delegate accepted ACK。

不应再自己维护完整的 ticket、lease、scheduler、completion file、finalizer 和 delivery outbox，除非作为 legacy fallback。0.5.0 期间这些 legacy 轮子保留回滚开关，但不再作为目标主路径继续加固。

### 2.2 原生 background task registry / TaskFlow

OpenClaw v2026.4.29 已有 background task registry 和 TaskFlow 状态能力，包含 queued/running/succeeded/failed/timed_out/cancelled/lost 等状态，以及 runs/flows 的读取和取消接口。

当前 OctoClaw 的 `runtime-ledger/index.ts` 自建了这些表：

- `work_contracts`
- `delegation_tickets`
- `task_attempts`
- `scheduler_queue`
- `completion_bindings`
- `runtime_events`

这里需要区分两件事：

1. **执行真相不应再由 OctoClaw 自建。** queued/running/succeeded/failed/timed_out/cancelled、run registry、child lifecycle、completion announce、retry/fallback 应以 OpenClaw native runs/flows/subagent registry 为准。
2. **OctoClaw 自己的产品元数据仍然需要可靠存储。** WorkContract、route seal、judge reason、expected deliverable、model profile、IM turn anchor、ACK dedupe receipt、native refs mapping 这些字段 OpenClaw 原生 registry 不一定有，不能随便散落到脆弱文件里。

所以建议不是“删除 SQLite”，而是把 `runtime-ledger SQLite` 降级为 `OctoClaw metadata store`：

- 可以继续用 SQLite 存 OctoClaw 自有 metadata；OpenClaw v2026.4.29 的 plugin runtime 暴露 `api.runtime.state.openKeyedStore<T>()`，但源码限制为 bundled plugin only，外部/workspace OctoClaw 不能把它当稳定替代。`resolveStateDir()` 仍可用于定位 plugin state 目录。
- 不再把 SQLite 当任务执行状态权威。
- `scheduler_queue`、`completion_bindings`、delivery retry/outbox 这类执行职责在 planner path 下停用；legacy path 只保留回滚。
- `work_contracts`、route/judge/replay/native refs 可以保留。
- `managedFlows` 只在真正需要 OctoClaw 管理多步 flow 时使用，不要为了单 worker spawn 重造 flow。

### 2.3 原生 subagent announce / delivery

OpenClaw 原生 subagent completion announce 是 push-based，支持 direct delivery、queue fallback 和 retry。这个能力可以被 OctoClaw 0.5.0 使用，但前提要说准：**可靠路径是主 agent 调 tool-level `sessions_spawn`**。`sessions_spawn` 会走 `spawnSubagentDirect()`、注册 subagent run、保存 requester origin，并由 registry 等待 run 完成后触发 announce/delivery。`api.runtime.subagent.run()` 只返回 `runId`，不等价于这条完整链路，因此不应作为 0.5.0 的 announce/delivery 主路径。

当前 OctoClaw 的 `delegate/child-finalizer.ts` 要求子 agent 写 `.completion.json`，然后父进程轮询并 finalizer。这条路径有天然脆弱性：

- 模型可能忘写文件。
- 文件可能写坏或写到错误路径。
- 父进程重启会引入 orphan scan 和恢复复杂度。
- 同一任务有 native 状态、ledger 状态、completion binding 多套真相。

建议 planner path 验收通过后，在该路径中完全停用 completion file 协议。结构化结果如果需要，可以让子 agent 在最终回复或 artifact 中输出，并由 OpenClaw announce/handoff 传回主会话。legacy path 可以继续保留 completion file/finalizer 回滚，但必须通过 `OCTOCLAW_LEGACY_COMPLETION_FILE=1` 之类开关显式启用。

### 2.4 原生 message queue / visible replies

OpenClaw v2026.4.29 的 `messages.queue` 默认能力已经适合 IM 场景：

- `mode: "steer"`
- `debounceMs: 500`
- `cap: 20`
- `drop: "summarize"`

这可以减少 OctoClaw 自己做消息合并、等待、打断、状态保护的复杂度。

OpenClaw 也支持：

- `messages.visibleReplies`
- `messages.groupChat.visibleReplies`
- group/channel 默认 `message_tool` 可见回复模式。

这很适合 OctoClaw 控制“什么内容应该在群里可见”。不要用 footer 或 outbound hook 去承担可见性控制。正常最终回复是否可见，应交给 OpenClaw source reply delivery mode。OctoClaw 只决定是否显式调用 message tool 发状态或结果。

### 2.5 原生 ackReaction / typingReaction / status reactions

Slack/OpenClaw 已有：

- `messages.ackReaction`
- `channels.slack.ackReaction`
- `channels.slack.typingReaction`
- `removeAckAfterReply`
- `messages.statusReactions.enabled`

OctoClaw 不应该优先自己发一条短文本 ACK。最早的 ACK 应尽量是 reaction 或 typing indicator，因为它低打扰、不会污染线程，也不会和快速正式回复竞争。

#### 2.5.1 Slack `ackReaction` 的真实能力和限制

OpenClaw v2026.4.29 的 Slack `ackReaction` 不是 Web UI 专用能力，它会调用 Slack `reactions.add`，在 Slack 入站消息上加 reaction。源码依据：

- `extensions/slack/src/actions.ts` 的 `reactSlackMessage()` 使用 `client.reactions.add({ channel, timestamp, name })`。
- `extensions/slack/src/monitor/message-handler/prepare.ts` 会解析 `messages.ackReaction` / `channels.slack.ackReaction`，并在允许时生成 `ackReactionPromise`。
- `extensions/slack/src/monitor/message-handler/dispatch.ts` 在 `statusReactions` 开启时用 queued/thinking/tool/done/error reaction controller 接管状态 reaction。
- `src/channels/ack-reactions.ts` 定义 `ackReactionScope` gate，默认 scope 是 `group-mentions`。

如果 Slack 里看不到，常见原因不是 OpenClaw 没有能力，而是下面这些 gate 抑制了它：

1. **群/频道默认 tool-only 可见回复模式。** v2026.4.29 的 `messages.groupChat.visibleReplies` 默认是 `message_tool`。Slack handler 会通过 `resolveChannelSourceReplyDeliveryMode()` 判定 `sourceRepliesAreToolOnly`，这种模式下 auto `ackReaction`、`statusReactions`、`typingReaction` 都会被压掉，避免普通 auto-reply 在 lurk/tool-only 场景制造可见噪声。
2. **默认 `ackReactionScope` 是 `group-mentions`。** DM 默认不会 ack，除非设置 `messages.ackReactionScope: "direct"` 或 `"all"`。群/频道默认需要可检测 mention 且满足 requireMention，除非设置 `"group-all"` 或 `"all"`。
3. **Slack app 需要 `reactions:write`。** 没有权限时 OpenClaw 会 best-effort 失败并记录 verbose log，用户侧看不到 reaction。
4. **`statusReactions` 默认接管。** `messages.statusReactions.enabled !== false` 时，初始 ACK 可能表现为状态 reaction 的 queued/thinking/tool/done/error 流程，而不是一次简单的固定 emoji。
5. **`removeAckAfterReply` 可能清理 reaction。** 如果配置为 true，正式回复后 reaction 可能被移除，肉眼观察时容易误以为从未出现。

因此 OctoClaw 的策略应该是：

- 在普通 DM 或允许自动可见回复的房间，优先复用 OpenClaw 原生 `ackReaction` / `typingReaction`。
- 在群/频道 `message_tool` 默认模式下，不要误判为“OpenClaw 没有 ACK”。这时如果 OctoClaw 仍需要一个明确可见的收到提示，应走 OctoClaw 自己的显式 reaction path，并且用 OpenClaw/Slack runtime 能提供的原始 `channel` + `message.ts` anchor，而不是 session key 反推。
- 不建议为了看到 auto `ackReaction` 就全局把 `messages.groupChat.visibleReplies` 改成 `automatic`。这会改变群聊最终回复可见性，风险比 ACK 本身大。更稳的做法是提供 `OCTOCLAW_NATIVE_ACK_REACTION_MODE=auto|explicit|off` 之类开关：`auto` 复用 OpenClaw，`explicit` 只在 OctoClaw 确认需要可见反馈时显式加 reaction，`off` 完全关闭。

用于验证原生 Slack ACK 的最小配置可以是：

```json5
{
  messages: {
    ackReaction: "eyes",
    ackReactionScope: "all",
    removeAckAfterReply: false,
    statusReactions: { enabled: false },
    groupChat: {
      visibleReplies: "automatic"
    }
  }
}
```

这个配置只用于确认原生能力。生产群/频道是否改 `visibleReplies`，应由“是否允许普通 final reply 自动可见”决定，不应只为 ACK 调整。

### 2.6 原生 plugin state / channel-route helper

OpenClaw v2026.4.29 的 plugin runtime 事实口径要收紧：`PluginRuntimeCore.state` 类型和 docs 已有 `openKeyedStore<T>()`，但 `src/plugins/registry.ts` 的 runtime proxy 只允许 bundled plugin 使用，外部/workspace plugin 调用会抛错。

这意味着 OctoClaw 有三种更稳的存储选择：

- 执行状态：使用 OpenClaw native subagent registry / `runtime.tasks.runs` / `runtime.tasks.flows`。
- OctoClaw 关系型 metadata：继续用 SQLite，保存 WorkContract、route seal、judge/replay、native refs、IM anchor、ACK receipts。
- 小型文件状态：通过 `api.runtime.state.resolveStateDir()` 放到宿主 state 目录下，但必须有 schema version、atomic write、corrupt quarantine；不要散落到 workspace 文件。

Slack/IM 目标解析也应优先使用 OpenClaw `deliveryContext`、`runtime.channel.routing`、`runtime.channel.reply` / `runtime.channel.outbound.loadAdapter` 等已有 channel helper，而不是手动解析 session key 或 shell out 到 CLI 后解析 stdout/stderr。

## 3. OctoClaw 应保留的核心价值

### 3.1 judge/router

OctoClaw 可以保留 judge，但 judge 应该是轻量、结构化、可回放的分类器，而不是执行授权器。

推荐 judge 的职责：

- 区分 `reply`、`delegate`、`execution_followup`、`status`。
- 判断是否是新工作。
- 提取 expected deliverable。
- 给出 role/complexity/duration/quality/cost hint。
- 给 model policy 和 WorkContract 提供输入。

不推荐 judge 的职责：

- 直接授权 dispatch。
- 生成用户可见 ACK 文案。
- 维护任务状态。
- 决定实际是否 spawn 成功。

### 3.2 WorkContract

WorkContract 是 OctoClaw 最应该保留的设计之一。它让“为什么委派、委派什么、期望交付什么”变成结构化合同。

但 WorkContract 应从“执行系统”降级为“语义合同”：

```ts
interface WorkContractNativeRefs {
  openclawRunId?: string;
  openclawTaskId?: string;
  openclawFlowId?: string;
  childSessionKey?: string;
  requesterSessionKey?: string;
}
```

WorkContract 应保存：

- route。
- intent class。
- expected deliverable。
- judge/source/reason codes。
- model/role/profile 选择。
- native refs。
- 面向用户的 compact projection。

WorkContract 不应保存：

- 自己的 scheduler queue 真相。
- 自己的 retry 执行真相。
- 自己的 completion binding 真相。
- 与 OpenClaw task registry 冲突的状态机。

### 3.3 model/cost policy

OctoClaw 的另一个价值是把子 agent 模型选择策略产品化：

- `simple` 任务用便宜 fast model。
- `normal` 任务用中档模型。
- `deep` 或高风险任务用更强模型。
- observer/status 查询用低成本模型或主 agent 直接回答。
- code/review/research role 对应不同模型池。

这些策略最后应映射成原生 `sessions_spawn` 的 `model`、`thinking`、`runTimeoutSeconds`、`lightContext`、attachments / workspace refs。

### 3.4 IM 体验层

OctoClaw 应保留“怎么跟用户说”的能力，但不要重造“怎么送达”的能力。

保留：

- Slack 文案风格。
- 何时用 reaction，何时用短文本。
- 委派确认文案。
- 状态查询摘要。
- 失败/超时/恢复文案。

交给 OpenClaw：

- 目标解析。
- thread/replyTo 选择。
- message delivery。
- retry/fallback。
- visible reply mode。

## 4. 当前实现最重的部分

### 4.1 多套状态源

当前状态源过多：

| 状态源 | 当前用途 | 问题 | 建议 |
| --- | --- | --- | --- |
| `policyState` | judge/route/ACK 临时状态 | 容易和真实任务状态分叉 | 只保留短期 policy/turn 状态 |
| `task-state.json` | task projection/cache | 读失败时可能像“没有任务” | 降级为 projection cache 或移除 |
| runtime-ledger SQLite | 任务真相和 OctoClaw 元数据混在一起 | 与 OpenClaw native registry 重叠，但部分 OctoClaw 字段原生没有 | 降级为 metadata store；执行状态权威交给 native |
| WorkContract store | 语义合同和执行状态混合 | 职责偏重 | 只保存合同和 native refs |
| OpenClaw task registry | 原生任务真相 | 目前没有成为唯一事实源 | 设为执行状态权威 |
| completion files | 子 agent 完成协议 | 模型写文件不可靠 | planner path 移除，legacy 显式开关保留 |
| delivery outbox | 自建投递恢复 | 与 native announce delivery 重叠 | planner path 移除，legacy 显式开关保留 |

需要保留的是“产品元数据存储”，不是“第二套 runtime”。建议把保留字段明确命名为 `OctoClawMetadataStore` 或 `WorkContractStore`，避免继续把 scheduler、completion、delivery retry 都塞回 ledger。

这个问题比单个 bug 更重要。只要多套状态并存，就会出现：

- 用户看到“已启动”，实际 native run 不存在。
- native run 已完成，但 OctoClaw completion binding 没看到。
- retry 显示 queued，但 scheduler 没真正执行。
- task-state parse 失败导致状态面板显示空。
- Slack ACK 或 finalizer 产生重复消息。

### 4.2 `tools/registration.ts` 职责过多

`extensions/octoclaw-runtime/src/tools/registration.ts` 现在承担：

- tool 注册。
- route/WorkContract 校验。
- delegation ticket。
- scheduler lease。
- native TaskFlow materialization。
- spawn。
- task state 更新。
- completion binding。
- notification。
- retry。
- finalizer 调度。

建议拆成：

- `dispatch-tool.ts`：只处理输入、校验、返回。
- `native-spawn-adapter.ts`：调用 OpenClaw 原生 spawn。
- `work-contract-adapter.ts`：WorkContract 保存 native refs。
- `status-projector.ts`：从 native runs/flows 生成 OctoClaw projection。
- legacy scheduler/completion/finalizer 放到 `legacy/`，默认关闭；SQLite/KeyedStore 只保留 metadata store。

### 4.3 `extension-entry.ts` 职责过多

`extension-entry.ts` 同时注册 hooks、ACK timers、route commit ACK、footer、policy state、compaction、outbox、watchdog、retention。建议入口只做组合：

- 初始化 config。
- 注册 hooks。
- 连接 native APIs。
- 启动少量必要 interval。

ACK、footer、judge、delivery、watchdog 应各自成为独立模块，且 planner path 不应启动 legacy finalizer/outbox/watchdog。

## 5. ACK 设计建议

### 5.1 当前 ACK 问题

当前 ACK 有多套机制：

- latency ACK。
- route commit ACK。
- execution transition ACK。
- delegate without dispatch notice。
- ACK guard/tier timers。
- Slack reaction ACK。

问题是：

1. 有些 ACK 是基于“计划”而不是“事实”。例如 route 被判成 delegate 后说“准备派发”，但 spawn 可能还没成功。
2. ACK 的 target/thread 解析很多地方手写 session key，容易和 OpenClaw 原生 delivery route 不一致。
3. timer、dedupe、route commit、first token 的竞态很复杂。
4. ACK 文案、footer、正式回复可能互相竞争，造成重复或干扰。
5. tier ACK 在 IM 里价值有限，但增加很多状态。

### 5.2 目标 ACK 模型

建议 ACK 只保留四类：

| 层级 | 触发 | 展示 | 事实要求 |
| --- | --- | --- | --- |
| ACK0 reaction | 收到 inbound 后立即 | reaction/typing | 只表示“收到并开始处理” |
| Slow reply text ACK | 主 agent 超过阈值仍无 first token | “收到，处理中” | 只能表示主 agent 还在处理 |
| Delegate accepted ACK | `sessions_spawn` accepted 且 `octoclaw_dispatch_confirm` 成功后 | “已交给子 agent，完成后回到此线程” | 必须有 native run id |
| Terminal/progress notice | native task status/announce | 完成/失败/超时 | 必须来自 native status |

不要在 judge 刚返回 `delegate` 时说“已委派”。judge 只是候选。正确时机是原生 `sessions_spawn` accepted 且 `octoclaw_dispatch_confirm` 校验 runId 成功。

### 5.3 推荐流程：reply route

```text
inbound
  -> OpenClaw native ackReaction / typingReaction
  -> OctoClaw judge
  -> route=reply
  -> main agent starts streaming or final reply
  -> cancel text ACK timer
  -> optional removeAckAfterReply
```

文本 ACK 只在没有 first token、没有 visible reply、没有 delivery pending 的情况下发。阈值建议：

- reaction/typing：OpenClaw 原生 auto path 可做到低延迟；Slack tool-only 群若走 OctoClaw explicit neutral ACK，验收按 1-5s。
- text ACK：2500-3500ms。
- 不建议 12s/30s/90s tier 文本，除非用户明确开启 verbose status。

### 5.4 推荐流程：delegate route

```text
inbound
  -> native ackReaction / typingReaction
  -> judge returns delegate candidate
  -> WorkContract sealed
  -> OpenClaw `sessions_spawn` accepted
  -> octoclaw_dispatch_confirm records run id
  -> send one delegate accepted ACK with run id/task label
  -> OpenClaw subagent announce sends final result
```

delegate accepted ACK 文案建议：

- 中文：`已交给子 agent 处理，完成后会回到这个线程。`
- 英文：`I handed this to a sub-agent and will return the result here.`

如需状态可加短 id，但默认不要展示完整 WorkContract/model/debug 信息。

### 5.5 ACK 去重 key 的 bug

`extensions/octoclaw-runtime/src/ack/ack-dedupe.ts` 的 `buildAckKey` 接收 `ackStage`，但实际 key 没包含 stage：

```ts
return `ack:${parts.threadId}:${parts.anchorId ?? "none"}:${parts.routePhase}:${parts.messageTurnId}`;
```

如果 tier1/tier2 要发，它们会被 ACK0 的 key 去重掉。建议二选一：

1. 删除 tier ACK，只保留 ACK0 和 delegate accepted/progress notice。
2. 或把 `ackStage` 加入 key：

```ts
ack:<surface>:<target>:<thread>:<messageId>:<turnId>:<kind>:<stage>
```

### 5.6 ACK timer 的结构问题

`startAckGuard` 现在会在 judge 前用空 decision 启动，route phase 是 `pre_route`。但 `pre_route` 不调度 tier timer。judge 后 `updateAckGuardDecision` 只会取消 delegate/observe timer，不会为 reply route 重新建 timer。

建议改成：

- native reaction/typing 立即发，不依赖 OctoClaw timer。
- judge 完成后，如果 route=reply，再创建 slow text ACK timer。
- route=delegate 不创建 reply-style timer，只等待 `sessions_spawn` accepted + `octoclaw_dispatch_confirm`。

### 5.7 ACK target 来源

ACK 目标应从 OpenClaw delivery context/channel route helper 获取，不应多处解析 session key。

建议每个可见消息都有一个统一结构：

```ts
interface DeliveryIntent {
  surface: "slack" | "discord" | "telegram" | "direct" | string;
  accountId?: string;
  target: string;
  threadId?: string;
  replyToMessageId?: string;
  visibility: "reaction" | "status" | "visible_message" | "private";
  idempotencyKey: string;
}
```

OctoClaw 构造 intent，OpenClaw 负责发送。

## 6. Footer 设计建议

### 6.1 当前问题

当前 `appendReplyProjectionFooter` 默认开启，会把类似下面的信息追加到用户可见消息：

```text
route=reply | model=zhipu/GLM-5.1 · thread | via=judge
```

这对调试有价值，但对普通 Slack 用户不是好的产品体验：

- 泄露内部路由和模型细节。
- 每条消息都变长，降低可读性。
- route/model/debug 信息会被用户当成正式内容。
- 用 regex 判断是否已追加 footer 容易误伤或漏判。

### 6.2 推荐 footer 模式

建议把 footer 改成显式模式：

```ts
type ProjectionFooterMode = "off" | "compact" | "debug";
```

默认：`off`。

| 模式 | 用户可见内容 | 适用场景 |
| --- | --- | --- |
| `off` | 不追加 footer | 默认生产体验 |
| `compact` | `via=subagent` 或 `via=direct` | owner/debug channel 可选 |
| `debug` | route/model/workContractId/judge source | 本地调试、验收、eval |

建议配置：

```json5
{
  octoclaw: {
    im: {
      projectionFooter: {
        mode: "off",
        debugAllowlist: ["U_OWNER", "C_DEBUG"]
      }
    }
  }
}
```

### 6.3 footer 不应承担的职责

footer 不应承担：

- 告诉用户是否已委派。
- 控制消息是否可见。
- 作为执行凭证。
- 作为 ACK 的替代品。

这些应该分别由：

- delegate accepted ACK。
- OpenClaw `visibleReplies` / `message_tool`。
- native task refs / WorkContract / replay log。
- native reaction/text ACK。

来承担。

### 6.4 面向用户的替代展示

如果用户需要知道“是不是子 agent 做的”，建议在状态查询或最终结果里自然表达，而不是每条回复 footer：

- `这次是我直接处理的。`
- `这次由子 agent 完成，我整理了结果如下。`
- `子 agent 还在跑，当前状态是 running。`

如果是 debug/owner 查询，可以返回结构化状态表。

## 7. Judge 设计建议

### 7.1 当前 judge 的问题

当前 judge 方向是对的，已经有结构化 schema、context packet、execution coverage、validator fallback。但实现上仍有几个问题：

1. judge 输出字段偏多，且部分字段直接进入 ACK/dispatch 逻辑。
2. `ackText` 由 judge 输出，容易产生不稳定用户文案。
3. 缺失 confidence 时默认成 `0.7`，可能让不完整输出直接 actionable。
4. `isActionableJudgeResult` 注释说要排除 abstain，但代码只检查 confidence。
5. judge timeout/fallback/validator/route seal 逻辑太多集中在 `policy-resolver.ts`。

### 7.2 推荐 judge schema

judge 输出建议收敛成：

```ts
interface OctoClawJudgeOutput {
  route: "reply" | "delegate";
  confidence: number;
  abstainReason?: string | null;

  intentClass:
    | "plain_chat"
    | "execution_followup"
    | "status_lookup"
    | "fresh_live_lookup"
    | "delegated_work";

  isNewWork: boolean;
  expectedDeliverable?: string;

  role?: "observer_probe" | "worker_research" | "worker_code" | "worker_review";
  complexityBand?: "simple" | "normal" | "deep";
  expectedDurationBand?: "instant" | "short" | "medium" | "long";
  qualityBar?: "standard" | "high" | "critical";
  toolNeedHint?: "none" | "maybe" | "required";
  reasonCodes: string[];
}
```

删除或降级：

- `ackText`：不要由 judge 生成可见 ACK。
- 过多兼容字段：放到 adapter/normalizer，不进入核心决策。
- route alias：可以在 normalizer 处理，但 alias 输出应计入 degraded。

### 7.3 judge 热路径：确定性 precheck + 可选 cheap LLM

这里说的“两阶段”不是 local judge 和 remote judge 两个 LLM 串行。热路径应只有一个可选 LLM：先做确定性 precheck，能确定就不调用 LLM；不确定才调用 cheap LLM judge。remote judge 只适合 shadow/eval/offline calibration，不应阻塞 ACK 或主模型启动。

推荐流程：

```text
deterministic precheck
  -> 明确 execution_followup/status/plain_chat/explicit delegate/fresh lookup
  -> 如果明确，直接生成 route candidate
  -> 如果不明确，调用 cheap LLM judge
  -> validator/admission
  -> WorkContract seal
  -> native spawn or reply
```

deterministic precheck 应优先处理：

- 用户问“刚才那个任务怎么样了”：execution/status followup，走 reply/status，不 spawn。
- 用户只是闲聊或确认：reply。
- 用户明确“开个子 agent 查一下”：delegate candidate。
- 单步、目标明确的 fresh live lookup：先走 main fast path，超过预算再转 delegate。
- long running、代码修改/测试/构建、多步工具链或 required write/tool work：delegate candidate。
- 已有 sealed WorkContract 的 follow-up：复用 route seal，不重新判新任务。

LLM judge 只处理灰区，不应每轮都成为关键路径。主模型纠正可以保留：judge 判 reply 但主模型发现需要长工具/执行时，可以提交 route hint 或调用 OctoClaw 委派入口；judge 判 delegate 但主模型能直接答时，可以直接答，前提是还没 spawn。任何“已委派”的用户可见表述都必须等 `sessions_spawn` accepted 且 `octoclaw_dispatch_confirm` 校验 runId。

### 7.4 委派规则：主线程快路径预算

OctoClaw 最初目标是把长时间、工具密集、上下文污染高的工作交给子 agent。建议把规则写成一个可解释的预算，而不是靠越来越多关键词 gate：

默认主 agent 处理：

- 当前上下文能直接回答。
- 简单解释、总结、翻译、改写。
- 状态/来源/“刚才发生了什么”能从 native state 或 replay 回答。
- 需要澄清 scope、目标、验收标准。
- 预计 20-30 秒内能完成，且最多需要 1-2 次轻量只读查证。
- 单步 fresh live lookup，目标明确、结果短、主 agent 可以直接给用户一个完整答案。

默认委派子 agent：

- 预计超过 90-120 秒，或用户明确接受后台等待。
- 需要命令执行、文件读写、代码修改、测试、构建、日志排查、环境探测。
- 需要多步工具链，或者真实工具调用超过 1-2 次轻量只读查证预算。
- 需要大量上下文阅读，容易污染主 agent 上下文。
- 可以并行处理。
- 用户明确要求后台、子 agent、并行、不要阻塞。

中间地带用 `budgeted_main_then_delegate` 预算：先让主 agent 做一次快路径尝试，超过时间、工具或上下文预算再转 delegate。`fresh_live_lookup`、`conversation_control.route_hint=delegate`、`fast_first_response` 只能作为 reason code，不能单独成为 hard delegate signal。

```text
budgeted_main_then_delegate:
  maxWallMs: 20000-30000
  maxReadOnlyToolCalls: 1-2
  allowReadOnlyNativeStatus: true
  allowWorkspaceProbe: bounded_read_only
  escalateWhen: write_needed | long_command | multi_step_tool_chain | context_budget_exceeded
```

rule、local judge、cheap LLM judge、route hint 和 AGENTS/system prompt 必须同步这套三段式语义：`must_reply/main_fast_path`、`must_delegate`、`budgeted_main_then_delegate`。只改其中一层会重新引入路由抖动。

### 7.5 judge 不等于 dispatch 授权

这是当前 docs 中已经写对的原则，需要在代码中继续强化：

> `route=delegate` 只是候选，不等于允许 dispatch。

允许 dispatch 至少需要：

- WorkContract route 是 delegate。
- `isNewWork=true`。
- `expectedDeliverable` 非空且可验收。
- 没有 execution followup/status coverage override。
- 没有 sealed reply contract 冲突。
- planner backend 可用，且当前会话允许调用原生 `sessions_spawn`。

最终授权应在 WorkContract admission、spawn intent gate 和 `octoclaw_dispatch_confirm` 中完成。

### 7.6 judge timeout 策略

timeout 不应简单默认 reply 或 delegate。建议：

- `execution_followup`、status surface：reply/status。
- plain chat：reply。
- 明确 long duration、required write/tool work、代码/测试/构建、多步工具链、explicit delegate：delegate candidate；单步 fresh lookup 走 budgeted main-fast-path。
- 其他灰区：reply，并允许主 agent后续显式 route hint。

timeout 结果应该带清晰 reason code，例如：

- `judge_timeout_reply_safe_default`
- `judge_timeout_delegate_hard_boundary`
- `execution_coverage_override_reply`

### 7.7 明确 judge bug

两个应优先修的点：

1. `llm-judge.ts` 在缺失 confidence 时默认 `0.7`。建议缺失 confidence 视为 degraded/non-actionable，或最多 `0.5`。
2. `judge-schema.ts` 的 `isActionableJudgeResult` 应检查 `abstainReason`。如果 `abstainReason` 非空，不应 actionable。

## 8. 明显 bug 和高风险点

### 8.1 WorkContract ID 碰撞

`work-contract/builders.ts` 使用 `sessionKey + userAsk` 生成稳定 ID。同一会话中用户重复一句话、IM 重放、retry，会复用同一个 contract。

建议：

- 加入 turn id / message id / route seal id。
- 或直接使用 UUID，再把 stable hash 作为 secondary fingerprint。

### 8.2 plugin session binding key 不可靠

`plugin.ts` 用 `requestId || taskId || flowId` 作为 binding key。这不一定等于 OpenClaw 真实 session/delivery identity。

建议：

- 使用 OpenClaw tool/runtime context 提供的 session/delivery context。
- 不要自己猜 session key。
- native runs/flows ownership 以 OpenClaw identity 为准。

### 8.3 fake detached runtime

`adapter/detached-task-runtime-host.ts` 返回随机 task id，progress/complete/fail/cancel 多数 no-op。如果被注册为真实 runtime，会让 capability check 看似成功，实际没有执行真相。

建议：

- planner path 直接禁用。
- 只有接入真实 OpenClaw detached runtime API 时才注册。
- capability probe 必须能证明 read/cancel/status 生命周期闭环存在。

### 8.4 spawn evidence 过宽

当前一些逻辑在只有 `childSessionKey`、没有明确 run id / task id / child run id 时，也可能认为 spawn confirmed。

建议：

- spawn confirmed 必须来自原生 `sessions_spawn` accepted response，并经过 `octoclaw_dispatch_confirm` 写入。
- 至少需要 `runId` 或 native task id。
- `childSessionKey` 只能作为 session ref，不能单独证明 spawn 已执行。

### 8.5 retry 可能只入队不执行

retry 路径创建 attempt/ticket/scheduler queue 后返回 queued，但没有看到足够清晰的 async scheduler worker 闭环。

建议：

- planner path 不使用自建 retry queue。
- retry = 重新调用 native `sessions_spawn`，并保存新的 native refs。
- legacy retry 必须有启动 worker、lease、crash recovery 的端到端测试。

### 8.6 ACK key 没包含 stage

见第 5.5 节。这个会影响 tier ACK 去重。

### 8.7 route commit ACK 时机

route commit ACK 目前可能在 delegate route 判定后就发送“正在准备派发”。这比“已委派”诚实一些，但仍可能让用户以为任务一定会进入后台。

建议：

- route commit 阶段最多内部记录，不发用户文本。
- 用户可见 delegate ACK 等 `sessions_spawn` accepted + `octoclaw_dispatch_confirm`。

### 8.8 footer 默认泄露内部信息

footer 应默认关闭，见第 6 节。

### 8.9 task-state 读失败返回空状态

`task-state-store.ts` 读 parse/schema/io 错误时返回空 doc。调用方如果不检查 status，可能把“状态损坏/读取失败”当成“没有任务”。

建议：

- read result 必须区分 `ok`、`missing`、`corrupt`、`io_error`。
- UI/status 对 corrupt 显示诊断，不显示空任务。
- planner path 尽量不依赖 task-state.json 作为真相。

### 8.10 Slack adapter 通过 CLI/stdout 发送

Slack adapter 现在 shell out 到 `openclaw message send` 并解析 stdout/stderr 中的 JSON。这对插件内 runtime 来说太脆。

建议：

- 用 OpenClaw runtime/message API。
- 用 channel route helper 解析 target/thread。
- CLI 只保留为手动调试 fallback。

## 9. 推荐目标架构

### 9.1 模块边界

```text
OctoClaw
  policy/
    deterministic-precheck
    llm-judge-normalizer
    validator-admission
    model-cost-policy

  contract/
    WorkContract semantic store
    native refs annotations

  native/
    spawn-planner
    dispatch-confirm
    sessions-spawn-gate
    task-status-reader
    channel-delivery-intent

  im/
    wording templates
    status renderer
    debug footer renderer

  eval/
    replay
    judge evaluation
    acceptance harness

OpenClaw native runtime
  sessions_spawn
  task registry / flows
  subagent announce
  message delivery
  queue / visible replies
  ackReaction / typingReaction
```

### 9.2 单一执行真相

执行真相统一为 OpenClaw native task registry。

OctoClaw 只保存：

- WorkContract。
- Native refs。
- User-facing projection。
- Replay/eval 事件。

不要再让 `task-state.json`、runtime-ledger、completion file、delivery outbox 同时参与判断任务是否真的执行。SQLite 可以保留为 metadata store，但不能继续和 OpenClaw native registry 竞争执行状态权威。

### 9.3 0.5.0 planner/confirm 草图

0.5.0 不把 direct spawn adapter 作为主路径，而是做一个硬协议：OctoClaw 规划，OpenClaw 原生 `sessions_spawn` 执行，OctoClaw 再确认 native refs。

```ts
interface NativeSpawnIntent {
  spawnIntentId: string;
  workContractId: string;
  sessionKey: string;
  planHash: string;
  status: "planned" | "spawn_call_started" | "accepted" | "failed" | "expired";
  sessionsSpawnArgs: {
    task: string;
    label?: string;
    runtime?: "subagent" | "acp";
    agentId?: string;
    model?: string;
    thinking?: "low" | "medium" | "high";
    runTimeoutSeconds?: number;
    mode?: "run" | "session";
    cleanup?: "keep" | "delete";
    sandbox?: "inherit" | "require";
    lightContext?: boolean;
  };
  createdAt: number;
  expiresAt: number;
}

interface NativeSpawnConfirmation {
  spawnIntentId: string;
  workContractId: string;
  sessionsSpawnStatus: "accepted" | "error";
  runId?: string;
  childSessionKey?: string;
  error?: string;
}
```

`octoclaw_dispatch` 只生成 `NativeSpawnIntent`，不维护自己的 scheduler，也不发“已委派”。`before_tool_call` 校验下一次 `sessions_spawn` 的 canonical args hash 必须匹配 intent。`octoclaw_dispatch_confirm` 校验 `runId` 后才写 WorkContract native refs、更新 metadata、发 delegate accepted ACK。

状态迁移规则要写死，避免 planner 退化成另一套隐式 runtime：

- `planned`：`octoclaw_dispatch` 创建 intent，只表示“允许下一步尝试原生 spawn”，不表示已委派。
- `spawn_call_started`：`before_tool_call` 匹配 intent/hash/TTL 后设置，表示主 agent 正在调用原生 `sessions_spawn`。
- `accepted`：`octoclaw_dispatch_confirm` 收到 `sessions_spawn` accepted 且有 `runId` 后设置，此时才允许用户可见 delegate ACK。
- `failed`：原生 spawn 返回 error，或 confirm 发现缺 `runId` / workContract 不匹配 / hash 不匹配。
- `expired`：TTL 内没有匹配的 `sessions_spawn`，后续调用必须重新 `octoclaw_dispatch`。

这些状态只描述 planner 握手，不描述子 agent 是否 running/succeeded/failed。真正执行状态仍从 OpenClaw native runs/flows/subagent registry 投影。

### 9.4 WorkContract projection 草图

```ts
interface WorkContractProjection {
  workContractId: string;
  route: "reply" | "delegate";
  title: string;
  expectedDeliverable?: string;
  modelProfile?: string;
  native: WorkContractNativeRefs;
  status: "sealed" | "accepted" | "running" | "succeeded" | "failed" | "timed_out";
  userStatusText: string;
}
```

其中 `status` 是从 native task registry 派生，不是 OctoClaw 自己推进。

## 10. 分阶段迁移方案

### Phase 0：止血和 guardrail

优先修不需要大改架构的点：

- WorkContract ID 加 turn/message/route seal。
- `buildAckKey` 加 stage，或删除 tier ACK。
- judge 缺失 confidence 不 actionable。
- `isActionableJudgeResult` 检查 abstain。
- fake detached runtime 默认禁用。
- footer 默认关闭。
- route commit ACK 不再说“已委派”，用户可见委派 ACK 等 `sessions_spawn` accepted + confirm。

验收：不引入 planner path，也能减少误报和用户可见噪声。

### Phase 1：0.5.0 planner/confirm path

加 feature flag：

```text
OCTOCLAW_SPAWN_BACKEND=planner|legacy|off
OCTOCLAW_PLANNER_ALLOWLIST=workspace/session/user allowlist
OCTOCLAW_SPAWN_INTENT_TTL_MS=60000
```

planner path 行为：

1. judge 得出 delegate candidate。
2. WorkContract seal。
3. admission 通过。
4. `octoclaw_dispatch` 生成 `NativeSpawnIntent`，返回极短 spawn plan 和 `sessionsSpawnArgs`。
5. `before_tool_call` 只允许与 pending intent 匹配的 `sessions_spawn`。
6. 主 agent 调原生 `sessions_spawn`。
7. `octoclaw_dispatch_confirm` 校验 `runId` / `childSessionKey`，保存 native refs。
8. confirm 成功后发送 delegate accepted ACK。

planner path 禁用：

- completion file。
- child-finalizer。
- scheduler queue。
- delivery outbox。
- fake detached runtime。
- 禁止把 `api.runtime.subagent.run()` 作为主路径。

legacy path 保留 fallback，但 planner allowlist 验收通过后不再继续加固 legacy runtime 轮子。

### Phase 2：状态读取切到 native

状态查询和 status panel 从 OpenClaw native runs/flows 读取：

- running/queued/succeeded/failed/timed_out 以 native 为准。
- WorkContract 只补充 title、expected deliverable、judge reason、model profile。
- `task-state.json` 只作为 projection cache 或兼容层。

验收：重启后不依赖 completion file，也能看到任务状态。

### Phase 3：投递切到 native

Slack/IM 发送切到 OpenClaw `runtime.channel.reply` / `runtime.channel.outbound.loadAdapter` 或 channel plugin 提供的稳定 port：

- 不 shell out `openclaw message send`。
- 不解析 stdout/stderr JSON。
- route/thread/replyTo 走 channel route helper。
- group/channel 可见性走 `visibleReplies` / `message_tool`。

验收：Slack thread preserved，失败有 native retry，OctoClaw 不维护 delivery outbox。

### Phase 4：删除 legacy runtime 轮子

在 planner path 稳定后移除或归档：

- runtime scheduler。
- completion binding。
- child finalizer。
- delivery outbox。
- fake detached runtime。
- 大量 task-state 写入逻辑。

保留 replay/eval 事件，但不再作为执行恢复机制。

## 11. 验收标准

### 11.1 用户体验

- 收到消息后 1-5s 内有中性 reaction/typing 或短文本 ACK；只表达“收到/正在判断”，不表达“已委派”。
- 主 agent 快速回复时不额外发文本 ACK。
- 超过 2.5-3.5s 没有输出时，最多一条短文本 ACK。
- 子 agent 只有在 `sessions_spawn` accepted 且 confirm 成功后才通知用户已委派。
- 子 agent 完成后由 native announce 回到正确线程。
- 默认不显示 route/model/footer。

### 11.2 稳定性

- 进程重启后能从 native task registry 恢复状态。
- 不需要子 agent 写 `.completion.json` 才能完成。
- retry 不会只显示 queued 而不执行。
- spawn confirmed 必须有 `sessions_spawn` accepted + `octoclaw_dispatch_confirm` 写入的 native run evidence。
- Slack 发送失败由 native delivery retry/fallback 处理。
- subagent completion 验收必须走 tool-level `sessions_spawn` 链路；`api.runtime.subagent.run()` 只能算过渡能力，不能证明 native announce/delivery 全链路可用。

### 11.3 成本和上下文

- delegate task 使用 model policy 选择子 agent 模型。
- simple/normal/deep 能映射到不同模型和 thinking。
- 默认使用 `sessions_spawn` 的 `context=isolated` + `lightContext=true` 隔离主上下文；OpenClaw v2026.4.29 已支持 `context=fork`，但只在 child 确实需要 requester transcript 时使用。额外上下文优先用 compact task、attachments 或 workspace refs。
- 子 agent final handoff 是 compact summary，不把完整 transcript 塞回主上下文。

### 11.4 judge 准确性

- execution followup 不误 spawn。
- plain chat 不误 delegate。
- explicit background/subagent/parallel request、long task、code/test/build、多步工具链能 delegate candidate；单步 fresh lookup 默认先走 budgeted main fast path。
- judge timeout 有 deterministic fallback。
- low confidence/abstain 不 actionable。

## 12. 测试建议

### 12.1 单元测试

- judge normalizer：alias、missing confidence、abstain、degraded delegate。
- WorkContract ID：同 session 同文案不同 turn 不碰撞。
- ACK key：ACK0/tier/delegate accepted 不互相误去重。
- footer mode：默认 off，debug allowlist 才显示。
- admission：`route=delegate` 但缺 expectedDeliverable 必须拒绝 dispatch。

### 12.2 集成测试

- reply route：快速回复不发文本 ACK。
- reply route：慢工具调用后只发一条文本 ACK。
- delegate route：`sessions_spawn` accepted 且 confirm 成功后发 delegate ACK。
- delegate route：spawn failed 不说已委派，返回恢复/失败文案。
- execution followup：读取 native status，不 spawn。
- Slack thread：replyTo/threadTs 保持正确。

### 12.3 故障注入

- `sessions_spawn` accepted / confirm 前后进程重启。
- native task running 时进程重启。
- Slack delivery 第一次失败。
- judge timeout。
- malformed judge JSON。
- task-state.json corrupt。

### 12.4 回放/eval

继续保留 OctoClaw 的 replay 价值，但 replay 只用于诊断和评估，不作为 runtime 真相。

建议 eval 指标：

- ACK latency p50/p95。
- duplicate ACK count。
- delegate false positive。
- execution followup false spawn。
- `sessions_spawn` accepted 到 confirm/user ACK latency。
- native completion announce success rate。
- average subagent model cost。

## 13. 优先级清单（按 0.5.0 口径更新）

### P0：0.5.0 Must ship

1. `sessions_spawn planner/confirm` 主链跑通：`octoclaw_dispatch -> sessions_spawn -> octoclaw_dispatch_confirm`。
2. NativeSpawnIntent gate 严格校验 session、TTL、canonical args hash；没有 matching intent 不允许把 spawn 当成 OctoClaw 委派事实。
3. confirm 必须有 native accepted run evidence 和非空 `runId`，成功后才写 WorkContract native refs。
4. delegate accepted ACK 只在 confirm 成功后发；失败、expired、mismatch 不说“已委派”。
5. 真实 Slack planner smoke 证明无 `invalid_status:planned`、无 premature delegate ACK，且 final 能回到正确线程。

### P1：0.5.0 Should ship

1. 恢复中性首 ACK：Slack inbound 后 1-5s 内给 reaction/typing 或短文本，只表达“收到/正在判断”。
2. 启动成本感知路由：短任务、状态/来源追问、单步 fresh lookup 默认 main fast path；硬委派仅用于明确后台/子 agent/并行、代码修改/测试/构建、多步工具链、review/validation、预计 90-120s 以上。
3. judge 只做 router/admission signal；missing confidence、abstain、degraded、缺 `is_new_work` 或 `expected_deliverable` 都不可 actionable。
4. runtime-ledger SQLite 降级为 metadata/audit store，保留 OctoClaw 自有字段；执行状态以 OpenClaw native runs/flows/subagent registry 为准。
5. NativeSpawnIntent/WorkContract/native refs 的 SQLite transition 要可观测，关键状态迁移要有原子性或 race test；`SQLITE_BUSY` 不能被误判为 no task/no spawn。
6. footer 默认 off；debug footer 对 native child final 优先使用 accepted native refs / child announce provenance，不能被 parent delivery turn 误标成 `route=reply`。
7. planner/native path 默认不依赖 completion file、child-finalizer、delivery outbox；legacy backend 保留显式 rollback。

### P2：0.5.x immediate / 可并行但不阻塞 0.5.0

1. Slack delivery port：只把 Slack 热路径从 `openclaw message send` CLI/stdout 解析迁到 OpenClaw channel reply/outbound 或 Slack plugin 稳定 port；非 Slack IM 继续 fallback。
2. legacy scheduler/finalizer/outbox 从默认 planner/native path 完整下线，真实 Slack smoke 不再出现 native announce 后的 legacy timeout。
3. 夜间回归 harness 补齐 main fast path、false delegate、planner native spawn、native announce final、footer provenance、completion timeout、legacy CLI delivery 指标。

### Deferred：不进入 0.5.0/0.5.x immediate 验收

1. 非 Slack IM delivery port 迁移。
2. managed flow 编排增强。
3. direct SDK spawn backend；只有 OpenClaw plugin SDK 暴露完整等价能力后再做。
4. warm worker pool / A2A 常驻 worker；当前只作为研究项，不承诺 child start p95 <= 10s。已有独立设计文档 [`octoclaw-dispatch-latency-preload-design-2026-05-03.md`](./octoclaw-dispatch-latency-preload-design-2026-05-03.md)，包含方案 B（投机并行 spawn）、方案 A（预热 session pool）及从 B 进化到 A 的路径；OpenClaw v2026.4.29 源码层面已确认 `isContinuationTurn` 跳 bootstrap、`mode: "session"` 持久 session、`sessions_send` 续 turn 三个底层机制均存在，进入 roadmap 的前置条件是 0.5.0 Must ship 稳定且完成文档中四项可行性验证。
5. OpenClaw 未暴露的 tool allowlist/private hook。

## 14. 最终目标状态

理想状态下，一次委派请求应是这样：

```text
用户请求
  -> OpenClaw native reaction/typing ACK
  -> OctoClaw deterministic precheck + cheap judge
  -> WorkContract sealed
  -> OctoClaw model/cost policy
  -> OctoClaw emits NativeSpawnIntent
  -> main agent calls OpenClaw sessions_spawn
  -> OctoClaw dispatch_confirm records runId
  -> OctoClaw sends one delegate accepted status
  -> OpenClaw tracks native task
  -> OpenClaw subagent announce final result
  -> OctoClaw replay/eval records policy quality
```

这时 OctoClaw 的代码会明显变轻：

- 不再需要自己追踪每个 task attempt 的真实生命周期。
- 不再需要 completion file 协议。
- 不再需要自建 delivery outbox。
- 不再需要 fake detached runtime。
- 不再需要在每条用户消息上追加 debug footer。

OctoClaw 留下的是更高价值的部分：判断、合同、模型成本、IM 体验和评估闭环。

## 15. 二次通读代码后的补充结论

这一节是再次通读 `extensions/octoclaw-runtime/src` 后补充的结论，重点看架构边界、冗余实现和原生能力替代。整体判断比前面更明确：当前最该先做的不是继续补 ledger/scheduler/finalizer，而是把执行路径收回到 OpenClaw native，OctoClaw 只留下策略、合同、模型成本和 IM 投影。

### 15.1 当前最大架构问题：入口和工具注册文件变成编排中枢

源码依据：

- `extensions/octoclaw-runtime/src/extension-entry.ts` 同时注册 `message_sending`、`before_compaction`、`before_model_resolve`、`before_prompt_build`、`before_tool_call`、`agent_end`、`before_message_write`，还启动 watchdog、task-state retention、delivery outbox、child-finalizer recovery。
- `extensions/octoclaw-runtime/src/tools/registration.ts` 同时承担 tool 注册、route seal 校验、delegation ticket、scheduler lease、TaskFlow materialization、subagent spawn、task-state 更新、completion binding、通知和 finalizer 调度。
- `extensions/octoclaw-runtime/src/resolve/policy-resolver.ts` 同时做 deterministic policy、LLM judge、runtime truth、WorkContract attach、route seal、policy state 持久化。

问题不是“文件太长”本身，而是同一个调用栈里混合了策略判断、用户可见 ACK、执行副作用、状态持久化和恢复逻辑。一旦某一步失败，很难判断应该回滚哪个状态源。

建议目标边界：

- `extension-entry.ts` 只做 hook wiring 和生命周期启动。
- `policy/` 只输出 route candidate、judge packet、admission reason，不做 spawn。
- `work-contract/` 只 seal 语义合同和 native refs。
- `delegate/native-spawn-adapter.ts` 是唯一 native spawn 入口。
- `state/native-status-projector.ts` 从 OpenClaw native runs/flows 投影状态。
- `legacy/` 下保留 scheduler、completion file、outbox fallback，并默认关闭。

### 15.2 WorkContract seal 有重复副作用

`resolveStatelessPolicyDecision()` 在有 `stateKey` 时已经调用 `attachWorkContractToPolicyDecision()`；随后 `resolvePolicyDecisionForContext()` 又对同一 decision 调 `attachRuntimeTruthMetadata()`、stamp route seal、`policyState.set()`，最后再次调用 `attachWorkContractToPolicyDecision()`。

这个重复 attach 不一定生成两条不同合同，因为当前 WorkContract id 是稳定 hash，但它仍可能重复写 store、发 shadow/ledger 事件、推进 revision 或 ticket。建议改成单一 seal 点：

- `resolveStatelessPolicyDecision()` 只返回纯 decision，不写 WorkContract。
- `resolvePolicyDecisionForContext()` 在 route seal 确定后唯一调用 `attachWorkContractToPolicyDecision()`。
- `octoclaw_dispatch` 只读取 sealed contract，不再补建合同。

### 15.3 WorkContract id 会在同一 session 重复问题中碰撞

`extensions/octoclaw-runtime/src/work-contract/builders.ts` 当前是：

```ts
const workContractId = stableId("wc", [sessionKey, userAsk]);
const turnId = options.turnId || stableId("turn", [sessionKey, String(Date.now())]);
```

同一 session 内用户重复同一句、Slack retry、或者同一 prompt 被重放，会复用同一个 `workContractId`。这会污染 ticket、native refs、status projection 和 replay。

建议：先生成 turn/message identity，再把它放进合同 id：

```ts
const turnId = options.turnId || stableId("turn", [sessionKey, anchorMessageId, String(Date.now())]);
const workContractId = stableId("wc", [sessionKey, turnId, decisionSeal.route, userAsk]);
```

如果没有稳定 message anchor，宁可用 `randomUUID()` 做主 id，把 `stableId(sessionKey,userAsk)` 降级为 fingerprint。

### 15.4 `ackStage` 入参没有进入 ACK key

`extensions/octoclaw-runtime/src/ack/ack-dedupe.ts` 的 `AckKeyParts` 有 `ackStage`，但 `buildAckKey()` 返回：

```ts
return `ack:${parts.threadId}:${parts.anchorId ?? "none"}:${parts.routePhase}:${parts.messageTurnId}`;
```

这会让 ACK0、tier、delegate accepted 或 progress ACK 在同一 turn 内互相误去重。推荐直接删除 tier ACK；如果保留，key 至少包含 `surface/target/thread/messageId/turnId/routePhase/ackStage`。

### 15.5 judge degraded 结果仍可能被当成 actionable

`extensions/octoclaw-runtime/src/resolve/llm-judge.ts` 的 `coerceJudgeOutput()` 在缺 confidence 时默认 `0.7`。`packages/octoclaw-policy/src/judge/judge-schema.ts` 的 `isActionableJudgeResult()` 只检查 `confidence >= minConfidence`，不检查 `abstainReason`、schema degraded、`is_new_work`、`expected_deliverable`。

这会把不完整 LLM 输出升级成可执行 delegate。建议：

- 缺 confidence 默认 `0` 或最多 `0.5`，并标记 degraded。
- `abstainReason` 非空不可 actionable。
- route=delegate 且 schema degraded 不可 dispatch。
- route=delegate 必须 `is_new_work === true` 且 `expected_deliverable` 非空。
- `ackText` 只进入 replay，不进入用户可见 ACK。

### 15.6 `buildSubagentSpawnMessage()` 仍强制 completion file

`extensions/octoclaw-runtime/src/tools/registration.ts` 的 `buildSubagentSpawnMessage()` 要求 worker 最后写 `octoclaw.worker_completion/v1` JSON 到 `{workContractId}.completion.json`，并且“Writing this file is your LAST action”。这和 OpenClaw 原生 subagent 的 “Results auto-announce to your requester” 模型冲突。

OpenClaw 源码依据：

- `src/agents/subagent-spawn.ts` 构造 child task message 时明确写入 `Results auto-announce to your requester`。
- `src/agents/subagent-spawn.ts` 注册 `registerSubagentRun({ runId, childSessionKey, requesterSessionKey, requesterOrigin, expectsCompletionMessage, ... })`。
- `src/agents/subagent-announce-delivery.ts` 提供 direct delivery、queue fallback、retry。

建议：planner path 下彻底移除 completion file requirement。需要结构化结果时，让子 agent final answer 输出 compact result 或 artifact，由 native announce/handoff 回传。

### 15.7 `runtime.subagent.run` 不等价于 `sessions_spawn`

OpenClaw v2026.4.29 里有两个容易混淆的入口：

- `sessions_spawn` 工具路径会经过 `spawnSubagentDirect()`，创建 child session、处理 maxDepth/maxChildren、model/thinking、lightContext、registry、completion announce。
- plugin runtime 的 `api.runtime.subagent.run()` 类型只返回 `{ runId }`，`src/gateway/server-plugins.ts` 实现上是直接调 gateway `agent` 方法，参数只有 `sessionKey/message/deliver/provider/model/extraSystemPrompt/lane/idempotencyKey`，没有 `childSessionKey` 返回、没有 `expectsCompletionMessage` 参数，也不等同于 tool-level native registry 注册。

所以 OctoClaw 如果继续用 `pi.runtime?.subagent.run`，它只能算过渡 backend。0.5.0 的真正瘦身目标应定为 planner-first：`octoclaw_dispatch` 退化为 spawn planner，让主 agent 调原生 `sessions_spawn`，再由 `octoclaw_dispatch_confirm` 写回 native refs。未来如果 OpenClaw 补出稳定的 plugin runtime spawn API，再把 backend 从 planner 替换成 direct。

### 15.8 `dispatchSpawnEvidence()` 证据过宽

`dispatchSpawnEvidence()` 从 native binding、delegate attempt、runtime truth evidence 中找 `runId/childRunId/childSessionKey`。如果没有强制 run id，后续逻辑容易把 `childSessionKey` 当作“spawn 已执行”的证据。

建议：

- `spawnExecuted=true` 必须来自原生 `sessions_spawn` accepted response，并经过 `octoclaw_dispatch_confirm` 写入。
- 必须有 `runId`、`childRunId` 或 OpenClaw native task id。
- `childSessionKey` 只能作为 session ref，不能单独证明后台任务存在。

### 15.9 `octoclaw_spawn` 和 `octoclaw_dispatch` 的模型映射不一致

`octoclaw_dispatch` 已使用 `getModelMap()`，但 `octoclaw_spawn` 里仍硬编码：

```ts
simple -> minimax-portal/MiniMax-M2.7-highspeed
normal -> zhipu/GLM-5.1
deep -> omniroute/cx/gpt-5.4
```

这会让同一 complexity 在两个入口选择不同模型，也绕开后续配置中心。建议：删除 `octoclaw_spawn` 作为独立执行入口，或让它只调用同一 `model-policy` 模块。

### 15.10 admission 不能依赖运行后 handoff summary

`tools/registration.ts` 的 `handoffText()` 会用 `handoff.reply_text` / `handoff.summary` 作为 fallback。这个函数用于展示可以，但 dispatch admission 不应依赖运行后或 payload materialization 生成的 handoff summary 来补 `expected_deliverable`。

委派授权必须依赖 pre-dispatch 的 WorkContract / judge / deterministic metadata。否则会出现“先决定执行，再用执行 payload 补充为什么能执行”的循环证明。

### 15.11 task-state、ledger、native registry 是三套真相

当前 `state/task-state-store.ts`、`runtime-ledger SQLite`、OpenClaw native task registry 都能表达 running/succeeded/failed。`delegate/child-finalizer.ts` 还会根据 completion file 推进状态并投递 IM。

目标状态应是：

- native registry 是唯一执行真相。
- SQLite/WorkContract store 只保存 OctoClaw metadata 和 native refs。
- `task-state.json` 只做 projection cache，且损坏时显示 degraded/corrupt，不当作“没有任务”。
- completion file/finalizer/outbox 只在 legacy flag 下启用。

### 15.12 Slack adapter 需要降级为 fallback port

`extensions/octoclaw-runtime/src/im/slack/slack-adapter.ts` 现在一方面直接调用 Slack Web API 发 reaction，另一方面发消息时 shell out `openclaw message send` 并解析 stdout/stderr。reaction 直接调 Slack 是 explicit ACK fallback 可以接受；但 message send 热路径应该走 OpenClaw channel delivery port。

OpenClaw v2026.4.29 的稳定事实：`PluginRuntimeChannel` 暴露 `reply.dispatchReplyFromConfig`、`reply.withReplyDispatcher`、`outbound.loadAdapter`、`routing.resolveAgentRoute`、`reactions.shouldAckReaction` 等 helper。文档中不应再泛泛写一个并不存在的 `runtime.message.send`，应明确接这些已有 port 或新增 OctoClaw 自己的 `MessageDeliveryPort` 适配它们。

## 16. 文档事实校正

本次校正后，文档里的 OpenClaw 原生能力口径按源码收敛为：

- Slack `ackReaction` 是真实 Slack reaction，不是 Web UI only；但会被 `ackReactionScope`、`sourceRepliesAreToolOnly`、`statusReactions`、`removeAckAfterReply`、Slack `reactions:write` 权限影响。
- plugin runtime 有 `openKeyedStore<T>()`，但 4.29 只对 bundled plugin 开放；外部 OctoClaw 需要关系查询和审计时，SQLite 仍应保留为 metadata store。
- `runtime.tasks.runs/flows` 是 read/status/cancel projection API；执行创建应走 planner 调用原生 `sessions_spawn`，不是让 OctoClaw 自建 queue。
- `api.runtime.subagent.run()` 是 gateway agent run 过渡能力，不等价于 tool-level `sessions_spawn` 的 registry/announce 全链路。
- `runtime.channel` 暴露的是 reply/outbound/routing/reaction helper，不应写成未验证的通用 `runtime.message` API。
