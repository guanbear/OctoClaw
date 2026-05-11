# OctoClaw Runtime Gate Convergence Design

Date: 2026-05-12

## 目标

这次不是继续给单个失败 case 打补丁，而是把 OctoClaw runtime gate 收成一条可解释、可测试、不会互相打架的路径。

目标只有三个：

1. 降低复杂度：减少 live path 上的硬拦截点，删除重复的 route seal / WorkContract / workflow enforcement 判定。
2. 提升稳定性：不再出现 “dispatch 被 WorkContract 禁止、direct spawn 又被 intent gate 禁止” 这种死区。
3. 保留必要安全：不能绕过 OctoClaw 直接 `sessions_spawn`，不能无证据声称已派发或已启动，不能把 execution/status follow-up 误派成新任务。

非目标：

- 不新增 keyword gate。
- 不新增 resident runner / warm pool。
- 不重写 judge。
- 不新增长期兼容开关。
- 不让 WorkContract 或 route seal 伪装成执行事实。

## 当前问题

最近 Slack 里反复出现的失败，本质不是某一个 if 少放行，而是 live path 同时存在多个硬权威：

```text
resolver / judge
  -> route seal
  -> WorkContract forbiddenTools
  -> before_tool_call budgeted-main guard
  -> before_tool_call route-hint / workflow enforcement
  -> before_tool_call WorkContract forbidden check
  -> octoclaw_dispatch 内部 sealed_decision_required
  -> native sessions_spawn pending intent gate
  -> runtime ledger / task projection 状态推断
```

这些层都可能独立说 “不许”。因此系统会形成死区：

```text
主 agent 发现需要委派
  -> 调 octoclaw_dispatch
  -> before_tool_call 说 WorkContract forbids octoclaw_dispatch
  -> 直接 sessions_spawn
  -> native intent gate 说 no pending native spawn intent
  -> 主 agent 只能继续在主线程摸索或输出失败
```

典型坏味道：

- stale `reply` seal 影响新 turn 的显式委派。
- `WorkContract.forbiddenTools=["octoclaw_dispatch"]` 既被当成 reply 合约，又被当成 runtime 硬门禁。
- budgeted-main guard 拦了普通工具后，提示去 dispatch，但 dispatch 又可能被另一层拦。
- `workflowEnforcementRule()` 和 `before_tool_call` 里的 WorkContract forbidden check 做了重复判断。
- `octoclaw_dispatch` 内部再做一套 route seal mismatch 判断，和外层 gate 不共享 admission 结果。
- read-only 查询被工具 guard 升级后，没有稳定的 objection / fallback 通道。
- 用户可见文案会说 “任务还没派发成功”，但实际上主 agent 又继续执行了几分钟。

## 收敛原则

### 原则 1: live path 只能有一个委派准入权威

`octoclaw_dispatch` 是唯一的委派准入 arbiter。

它负责决定：

- 这是不是新 delegated work。
- 是否允许从 reply / budgeted-main 转 delegate。
- 是否需要生成新的 WorkContract / route seal。
- 是否复用已有 WorkContract。
- 是否创建 NativeSpawnIntent。
- 是否因为 status/provenance follow-up 拒绝新 spawn。

其他层不能再提前硬拦 `octoclaw_dispatch`。最多可以记录 advisory、追加 metadata、或者把 state 带给 arbiter。

### 原则 2: native spawn gate 只防绕过

`sessions_spawn` / `sessions_send` gate 只做一件事：

```text
必须匹配 pending NativeSpawnIntent，否则 block
```

它不负责重新判断 route，不负责解释 WorkContract，不负责处理 stale seal，不负责 deciding delegate。

### 原则 3: route seal 是审计事实，不是永远的手铐

route seal 的意义是 “某个 turn 某次 policy decision 已经被记录”。它不应该被主模型静默覆盖，但它也不能让后续结构化委派永远死锁。

允许 supersede 的场景必须结构化、可审计：

- `octoclaw_dispatch({ forceRoute: "delegate" })`
- `octoclaw_dispatch({ model: "gpt-5.5" })`
- metadata 里有 `conversation_control.explicit_delegate_request=true`
- budgeted-main 已经记录 escalation evidence
- 明确 `is_new_work + expected_deliverable`
- accepted objection 记录了 requested route

不允许 supersede 的场景：

- 只有自然语言关键词。
- status/provenance follow-up。
- 已经有 accepted native run / confirmed spawn 的 WorkContract。
- 显式传入 `workContractId` 但合约 route/status 不允许 dispatch。

### 原则 4: WorkContract 禁止项不能直接禁止 arbiter

`WorkContract.forbiddenTools` 可以继续表达 reply 合约，例如 “自动流程不应 spawn”。但它不能在 `before_tool_call` 里直接拦 `octoclaw_dispatch`。

正确语义：

- 自动普通工具流程看到 reply contract，可以提示 main fast path。
- `octoclaw_dispatch` 进来后，由 dispatch admission 统一判断：
  - reject: status follow-up / explicit WorkContract mismatch / 已执行不可重派。
  - allow: budget escalation / explicit delegate / accepted objection / new work。

这样可以消除：

```text
WorkContract forbids octoclaw_dispatch
```

和：

```text
no current pending native spawn intent
```

同时出现的死区。

### 原则 5: budgeted-main 只负责预算，不负责最终委派授权

budgeted-main 应该是 `reply` 和 `delegate` 之间的软预算层。

目标行为：

```text
reply/main fast path
  -> 允许少量低风险只读工具
  -> 超过 30s / 多工具 / 写操作 / 长命令风险
  -> 写入 budget escalation evidence
  -> 提示调用 octoclaw_dispatch
  -> octoclaw_dispatch 必须能消费该 evidence
```

禁止行为：

- guard 让主模型 “Call octoclaw_dispatch”，但另一层 gate 禁止 dispatch。
- 预算超时后让主 agent继续执行 5 分钟才解释。
- 把 read-only 查询粗暴归成 write 后直接强制委派。

### 原则 6: 工具风险判断不能靠用户文本关键词

用户文本里的 “子 agent / 查一下 / 安装 / 分析 / 再试下” 不能作为 runtime hard gate。

允许的结构化信号：

- tool name。
- tool schema metadata。
- tool call params。
- parsed command argv / shell parse result。
- WorkContract fields。
- accepted route objection。
- budgeted-main evidence。
- native intent evidence。

对 `exec` 这类大工具，命令风险分类可以存在，但它只能是风险信号，不应单独把系统带进死区。无法确信时，应优先给 dispatch admission 一个统一入口，而不是在多个地方分别 block。

## 目标架构

目标 live path 只保留两个硬门禁家族：

```text
1. DispatchAdmission
   Location: octoclaw_dispatch execute path
   Authority: delegate/reply transition, WorkContract selection, stale seal supersede, native spawn intent creation

2. NativeIntentGate
   Location: before_tool_call for sessions_spawn / sessions_send
   Authority: prevent direct native spawn/send without matching pending intent
```

其他现有机制降级：

| 机制 | 当前问题 | 目标角色 |
| --- | --- | --- |
| judge route | 会被当成硬约束 | semantic suggestion / initial decision |
| route seal | stale reply 会卡新委派 | audit + replay source，可被结构化 admission supersede |
| WorkContract forbiddenTools | 直接拦 dispatch | contract hint，dispatch 内统一解释 |
| route hint required | 容易形成前置硬门 | advisory / objection source |
| workflowEnforcementRule | 重复拦截普通工具和 dispatch | helper for prompt/advisory，不能拦 dispatch |
| budgeted-main guard | 拦工具后 dispatch 不一定能进 | budget evidence producer |
| runtime ledger | 可能被当成 gate | metadata/audit truth，不参与 hot-path veto |
| task-state projection | 历史垃圾污染状态 | generated projection only |

## 新的请求状态机

### 1. 普通 reply

```text
judge/resolver -> route=reply
main agent replies
```

允许：

- 不调用 OctoClaw 工具。
- 少量直接只读工具，按 budgeted-main 记录。

禁止：

- 无 NativeSpawnIntent 直接 `sessions_spawn`。
- 无证据说 “已派发/已启动”。

### 2. budgeted-main 转委派

```text
route=reply
  -> main uses tools
  -> budget evidence recorded
  -> main calls octoclaw_dispatch
  -> DispatchAdmission sees budget escalation
  -> creates delegate WorkContract + NativeSpawnIntent
  -> sessions_spawn must match intent
  -> dispatch_confirm records accepted native refs
```

关键验收：

- budget guard 一旦提示 dispatch，dispatch admission 必须可进入。
- 如果 admission 最终拒绝，必须返回可解释 terminal reason，不得再被外层 gate 拦成 generic forbidden。

### 3. 用户显式委派或指定模型

```text
user asks: use gpt-5.5 subagent / 派子 agent
  -> main calls octoclaw_dispatch with model or forceRoute
  -> DispatchAdmission treats as structured explicit delegate
  -> old reply seal can be superseded if no execution has started
```

关键验收：

- 旧 reply seal 不得影响新 turn 或结构化 explicit delegate。
- footer/model 必须来自 actual spawn model 或 dispatch selected model，不得沿用 policy default。

### 4. status/provenance follow-up

```text
user asks: 刚才派发成功了吗 / 为啥失败 / 当前状态
  -> route=reply/control
  -> status/details read projection/ledger/native refs
  -> no new dispatch
```

关键验收：

- 这类 follow-up 不应新建 WorkContract。
- native spawn gate 仍然阻止 direct spawn。
- 返回必须区分 “没有执行证据” 和 “执行失败”。

### 5. native announce / completion delivery

```text
native child completion announce
  -> delivery projection
  -> main posts final/status
```

关键验收：

- delivery 期间不能生成新的 delegated work。
- 这个约束应作为 execution follow-up context 进入 DispatchAdmission，而不是另一个散落的 hard block。

## 代码收敛方案

### WP1: 建一个统一 admission API

新增或扩展：

```text
extensions/octoclaw-runtime/src/dispatch-admission.ts
```

目标 API：

```ts
type RuntimeAction =
  | { kind: "dispatch"; params: UnknownRecord }
  | { kind: "native_spawn"; params: UnknownRecord }
  | { kind: "native_send"; params: UnknownRecord }
  | { kind: "ordinary_tool"; toolName: string; params: UnknownRecord };

type AdmissionDecision =
  | {
      allowed: true;
      mode: "pass_through" | "dispatch_allowed" | "spawn_intent_required" | "ordinary_tool_allowed";
      route?: "reply" | "delegate";
      auditReason: string;
      statePatch?: UnknownRecord;
    }
  | {
      allowed: false;
      hardBlock: true;
      reason: string;
      userAction?: "call_octoclaw_dispatch" | "call_sessions_spawn_with_args" | "reply_with_status" | "stop";
      retryable: boolean;
      terminal: boolean;
      auditReason: string;
    };
```

第一阶段可以只把 `dispatch` admission 做实，`ordinary_tool` 仍由现有 budget helper 处理，但必须保证不会拦 `octoclaw_dispatch`。

### WP2: 缩小 `before_tool_call`

`extension-entry.ts` 的 `before_tool_call` 目标只保留：

1. `sessions_spawn` / `sessions_send` 调 `NativeIntentGate`。
2. 普通工具的 budgeted-main 观察和 soft/hard escalation evidence 写入。
3. execution follow-up / native announce context 标记。
4. 状态工具和 OctoClaw control 工具的轻量 bookkeeping。

必须删除或降级：

- `octoclaw_dispatch` 的 WorkContract forbidden hard block。
- `octoclaw_dispatch` 的 route hint precondition block。
- `workflowEnforcementRule()` 对 `octoclaw_dispatch` 的 block。
- reply contract 对 `octoclaw_dispatch` 的直接 block。

保留的 hard block：

- direct `sessions_spawn` / `sessions_send` without pending intent。
- direct `sessions_spawn` / `sessions_send` args mismatch。
- execution/status follow-up 直接 spawn。

### WP3: `octoclaw_dispatch` 内部成为唯一委派 arbiter

`tools/registration.ts` 的 dispatch execute path 目标：

1. 读取 current state / cached decision / WorkContract / route seal。
2. 调统一 `evaluateDispatchAdmission()`。
3. admission 输出三类结果：
   - `allow_new_delegate`: 新建或替换 WorkContract/route seal。
   - `allow_existing_delegate`: 复用 explicit valid WorkContract。
   - `reject_terminal`: 明确拒绝并给 reason。
4. 只有 admission allow 后才创建 NativeSpawnIntent。
5. 所有拒绝从 `octoclaw_dispatch` 返回结构化 failure，不再被 `before_tool_call` 提前打断。

### WP4: route seal supersede 规则收口

把现有 `replySealDelegateDispatchAdmission()` 扩展成唯一 supersede 判断：

允许条件：

- target route 是 delegate。
- 当前 reply seal 尚未产生执行事实。
- 有结构化 evidence：
  - budgeted-main escalation。
  - forceRoute delegate。
  - model override。
  - conversation control explicit delegate。
  - accepted objection。
  - explicit new work + expected deliverable。

输出必须包含：

- `previousRouteSealId`
- `newRouteSealId`
- `supersedeReason`
- `source: "dispatch_admission"`

拒绝条件：

- status/provenance follow-up。
- explicit WorkContract id 校验失败。
- 已有 accepted native run，不允许重写。
- 缺 expected deliverable 的 ambiguous dispatch。

### WP5: 删除重复 workflow hard gate

`workflowEnforcementRule()` 目标用途改成：

- prompt/advisory。
- test helper。
- optional audit。

不再作为 `octoclaw_dispatch` 的硬 block 来源。

如果 delegated route 下主 agent 调普通工具：

- 记录 `manual_tool_under_delegate_route`。
- 如果是高风险写操作，返回一个明确 block，且必须保证下一步 `octoclaw_dispatch` 可进入。
- 如果是低风险只读查询，允许一次 main fast path 或按 budget 策略处理。

### WP6: 用户可见文案收口

必须禁止这些假状态：

- “任务已启动” 但没有 `sessions_spawn accepted + dispatch_confirm`。
- “派发成功” 但只有 route seal / WorkContract。
- “还没派发成功” 之后主 agent 又继续主线程跑 5 分钟不说明 fallback。

新的文案状态：

| 状态 | 用户可见表述 |
| --- | --- |
| admission rejected | 不能派发，原因是 X；本轮未启动子 agent |
| spawn intent created | 已生成派发计划，等待 native sessions_spawn |
| native spawn accepted + confirm | 任务已交给子 agent，runId=... |
| main fallback | 未派发，已在主会话执行只读/轻量 fallback |
| main blocked | 需要委派，但当前 admission 拒绝；不继续主线程执行 |

## 必须删除或降级的代码点

目标不是立刻删完所有文件，而是先从 live path 删除硬权威：

| 位置 | 处理 |
| --- | --- |
| `extension-entry.ts` WorkContract forbidden check | 不再 block `octoclaw_dispatch` |
| `extension-entry.ts` route hint required block | 不再 block `octoclaw_dispatch` |
| `extension-entry.ts` workflow enforcement | 不再 block `octoclaw_dispatch`; 普通工具只产生 advisory/budget |
| `policy-utils.ts workflowEnforcementRule()` | 从 hard gate helper 降级为 advisory helper |
| `dispatch-admission.ts replyDecisionForbidsDispatch()` | 改名/改语义，不再表达 “forbid dispatch”，只表达 “reply contract auto-spawn disabled” |
| `registration.ts sealed_decision_required` | 只在 dispatch admission 内返回 terminal reject，不由外层 gate 触发 |
| WorkContract `forbiddenTools` | 保留兼容字段，但 live gate 不直接消费为 arbiter block |

## 不可破坏的安全边界

这些必须保留：

1. `sessions_spawn` 不能绕过 pending NativeSpawnIntent。
2. `sessions_spawn` args hash mismatch 必须 block。
3. status/provenance follow-up 不能创建新 delegated work。
4. explicit `workContractId` 校验失败必须 fail closed。
5. 没有 native accepted run 不得标记 `spawnExecuted=true`。
6. 没有 dispatch_confirm 不得说 “已交给子 agent”。
7. delivery/projection 失败必须 degraded，不得假 completed。

## 设计复盘：潜在问题和修正

这个方案的方向是正确的，但如果执行得太粗，会有四类风险。实现时必须按下面的修正口径收敛。

### 风险 1: 把多个 gate 合成一个巨型 gate

坏实现：

```text
删除 before_tool_call 的 if
  -> 把所有 if 原样搬进 evaluateDispatchAdmission()
  -> DispatchAdmission 变成新的大泥球
```

这不会降低复杂度，只是换位置。

修正：

- `DispatchAdmission` 只回答 “能不能创建/复用 delegated work 和 NativeSpawnIntent”。
- 普通工具预算、状态投影、footer、ledger degraded 只能提供 input/evidence。
- admission 输出必须是少数枚举 reason，不能继续堆自然语言 error。
- admission 内部按阶段组织：
  1. normalize request；
  2. classify follow-up/new-work；
  3. validate explicit WorkContract；
  4. evaluate seal supersede；
  5. allow/reject spawn intent。

### 风险 2: before_tool_call 缩太狠，主 agent 直接乱用工具

坏实现：

```text
为了不死区，before_tool_call 几乎不拦普通工具
```

这样可能让主 agent 在应该委派的场景里继续跑长命令、写文件、跑测试，反而污染上下文并降低稳定性。

修正：

- 普通工具 guard 可以继续拦高风险动作，但它只能拦普通工具，不能拦 `octoclaw_dispatch`。
- 如果普通工具被拦，必须同时写入可被 dispatch admission 消费的 escalation evidence。
- block reason 必须明确下一步只能是 `octoclaw_dispatch`，且该 dispatch 必须能进入 admission。
- read-only 工具不应轻易被判成写风险；命令风险分类要基于 tool/argv/params，不基于用户文本关键词。

### 风险 3: stale reply seal supersede 太宽，导致误委派

坏实现：

```text
只要主模型调用 octoclaw_dispatch，就允许覆盖 reply seal
```

这会削弱 route seal 的价值，可能把本来该 reply 的 status/provenance follow-up 误派出去。

修正：

- supersede 必须有结构化 evidence，不接受自然语言关键词。
- status/provenance/execution follow-up 一律不能 supersede 成新 spawn。
- explicit `workContractId` 必须 strict；不能因为有 model/forceRoute 就绕过明确传入的无效合约。
- 已经有 accepted native run 的 WorkContract 不能被同一 turn 重写成新任务。

### 风险 4: 功能满足了 dispatch，但用户可见状态仍误导

坏实现：

```text
admission allow 后就说“已启动”
```

这会重现之前 “任务已启动但 materialized=false / ack_sent=false” 的问题。

修正：

- admission allow 只能说 “派发计划已生成”。
- NativeSpawnIntent 只能说 “等待 native spawn”。
- `sessions_spawn accepted + dispatch_confirm` 后才说 “已交给子 agent / 已启动”。
- footer 的 model 必须优先取 actual spawn model / selected dispatch model；拿不到时显示 `model=unknown` 或 `model=pending`，不能用 policy default 冒充。

## 功能覆盖性检查

按修正后的设计，核心需求可以覆盖：

| 需求 | 是否满足 | 关键机制 |
| --- | --- | --- |
| 显式要求 gpt-5.5 子 agent | 满足 | structured model override -> DispatchAdmission supersede |
| stale reply seal 不再卡新委派 | 满足 | seal supersede 只在结构化 evidence 下允许 |
| graphify/gitnexus 这类多步安装分析 | 满足 | 普通工具高风险可拦，但 dispatch 必须可进入 admission |
| 只读查询不应委派 | 满足 | main fast path + read-only budget |
| status/刚才是否派发成功不应新建任务 | 满足 | execution follow-up reject in DispatchAdmission |
| 不能绕过 OctoClaw 直接 spawn | 满足 | NativeIntentGate 保留 hard block |
| 不能假称已启动 | 满足 | 用户可见状态绑定 native accepted + confirm evidence |
| 不能靠关键词修问题 | 满足 | 只认结构化 tool/params/metadata/evidence |

主要不足：

- 这个方案不能保证 judge 永远判对；它保证的是判错后有稳定的 structured objection / budget escalation 修正路径。
- 这个方案不能让 OpenClaw native registry 不可用时也完美回收结果；它只能保证 projection degraded 不会假成功。
- 这个方案不能解决所有模型选择问题；AutoRouter Lite 是另一条模型策略线。

## 稳定性判断

如果按上面的修正执行，稳定性应该提升，不是下降。

原因：

- 直接 spawn 防绕过仍然 fail-closed。
- status/provenance follow-up 仍然 fail-closed。
- explicit WorkContract 仍然 strict。
- 只有 `octoclaw_dispatch` 可以决定委派，避免多层 gate 互相否决。
- 普通工具风险仍可拦，但拦完不会造成 dispatch 死区。

真正需要防的是实现走偏：不能把 `DispatchAdmission` 写成更大的 if 森林，也不能为了少出错把所有普通工具都放开。

## 测试矩阵

新增或改造以下测试，先覆盖失败复现，再改实现。

### T1: explicit delegate after stale reply seal

场景：

- 当前 state 有 route=reply seal。
- 用户新 turn 明确要求 `gpt-5.5` 子 agent。
- 主模型调用 `octoclaw_dispatch({ model:"gpt-5.5", forceRoute:"delegate" })`。

期望：

- before_tool_call 不 block。
- dispatch admission supersede old reply seal。
- 返回 NativeSpawnIntent。
- footer model 使用 selected/spawn model。

### T2: budgeted-main escalation cannot deadlock

场景：

- reply route。
- 普通工具超过预算或触发 write risk。
- guard 返回 “call octoclaw_dispatch”。
- 随后调用 `octoclaw_dispatch`。

期望：

- dispatch 被允许进入 arbiter。
- admission reason 是 `budgeted_main_escalation`。
- 不出现 `WorkContract forbids octoclaw_dispatch`。

### T3: graphify / gitnexus multi-step install analysis

场景：

- 用户要求安装/分析项目。
- 这属于 delegated work 或 structured explicit delegate。

期望：

- 不出现 `WorkContract forbids octoclaw_dispatch for this turn`。
- 不出现 direct spawn `no pending native spawn intent` 后无法恢复。
- 如果 admission 拒绝，返回明确 terminal reason，主 agent 不继续无界摸索。

### T4: read-only lookup stays main fast path

场景：

- 查 GitHub release / npm latest / 本机版本。
- 一次只读查询。

期望：

- main fast path 允许。
- 不因普通 `exec` 误判为 write 而强制委派。
- 如超过预算，转入 T2 路径。

### T5: status/provenance follow-up never spawns

场景：

- 用户问 “刚才派发成功了吗 / 为啥失败”。

期望：

- 读 SQLite/native projection。
- `octoclaw_dispatch` 如果被调用，admission terminal reject。
- direct `sessions_spawn` 被 intent gate block。
- 用户可见文案说明没有启动新任务。

### T6: direct native spawn bypass still blocked

场景：

- 主 agent 未调用 `octoclaw_dispatch`，直接 `sessions_spawn`。

期望：

- block: missing pending intent。
- 这是保留的硬安全边界。

### T7: explicit invalid WorkContract remains fail closed

场景：

- `octoclaw_dispatch({ workContractId:"..." })` 指向 reply/closed/mismatched contract。

期望：

- terminal reject。
- 不生成新 spawn intent。
- 不被 stale fallback 自动绕过。

## 验收标准

功能验收：

- Slack 中 “再试下 / 用 gpt-5.5 子 agent / 安装 graphify 分析项目” 不再出现 gate dead zone。
- 如果不能派发，必须一次性说明真实原因，并停止无界主线程执行。
- read-only 查询不再无故 delegate。
- status/provenance follow-up 不再创建新任务。

复杂度验收：

- live path 的委派 hard authority 只有 `evaluateDispatchAdmission()`。
- `before_tool_call` 不再有第二套 `octoclaw_dispatch` route seal / WorkContract forbidden 判断。
- `workflowEnforcementRule()` 不再能 block `octoclaw_dispatch`。
- `WorkContract.forbiddenTools` 不再作为 dispatch arbiter 之前的 hard block。
- gate 相关测试从 “补 case” 改成 “不变量矩阵”。

代码搜索验收：

```bash
rg -n "WorkContract forbids octoclaw_dispatch|tool_blocked_work_contract_forbidden|sealed_decision_required|workflowEnforcementRule" extensions/octoclaw-runtime/src
```

允许：

- 测试断言旧错误不再出现。
- dispatch admission 内部的 terminal reject 事件。

不允许：

- `before_tool_call` 返回 `WorkContract forbids octoclaw_dispatch`。
- `workflowEnforcementRule()` 作为 dispatch 的硬拦截。

测试命令：

```bash
pnpm vitest run \
  extensions/octoclaw-runtime/src/__tests__/extension-entry-policy-route-hint.test.ts \
  extensions/octoclaw-runtime/src/tools/registration-dispatch-honesty.test.ts \
  extensions/octoclaw-runtime/src/replay/work-contract-tool-guard.test.ts

pnpm --filter @octoclaw/runtime run check
```

如果改动扩散到 projection/status：

```bash
pnpm vitest run \
  extensions/octoclaw-runtime/src/runtime-ledger/__tests__/projection-rebuild.test.ts \
  extensions/octoclaw-runtime/src/state/native-status-projector.test.ts \
  extensions/octoclaw-runtime/src/conversation-grounding.test.ts
```

## 分阶段落地

### Phase 0: 文档和失败复现测试

只加测试，不改行为。

交付：

- 本设计文档。
- OpenSpec change。
- T1/T2/T3/T5/T6 的 failing 或 target tests。

### Phase 1: DispatchAdmission 成为唯一委派入口

改动：

- 扩展 `dispatch-admission.ts`。
- `registration.ts` 只调用统一 admission。
- stale reply seal supersede 逻辑集中到 admission。

风险：

- 中等。影响委派入口，但可用 focused tests 控制。

### Phase 2: 缩小 before_tool_call

改动：

- 删除或降级 dispatch 前置 block。
- 保留 native intent gate。
- budgeted-main 只产生 evidence。

风险：

- 中高。需要重点看 Slack live smoke。

### Phase 3: workflow / WorkContract hard gate 降级

改动：

- `workflowEnforcementRule()` 不再对 dispatch 生效。
- WorkContract forbiddenTools 不再在 hot path 直接禁止 dispatch。
- 更新测试和文档措辞。

风险：

- 中。必须确认 status/provenance follow-up 仍不会 spawn。

### Phase 4: 用户可见状态和 footer 清理

改动：

- spawn model/footer 使用 actual selected/spawn model。
- 未 confirm 前文案不说已启动。
- main fallback 必须显式记录。

风险：

- 低到中。主要是显示和审计。

### Phase 5: 删除旧测试语义

改动：

- 删除要求 `WorkContract forbids octoclaw_dispatch` 的旧测试。
- 改成 assert “dispatch reaches admission and returns structured result”。

风险：

- 低。防止未来把旧行为加回来。

## 给实现者的边界

必须做：

- 先写不变量测试。
- 每个 hard block 都要归属到 `DispatchAdmission` 或 `NativeIntentGate`。
- 每个拒绝都要结构化 reason。
- 每个用户可见 “已启动/已派发” 都要有 native evidence。

禁止做：

- 加关键词表。
- 在 `before_tool_call` 里继续新增 `if task contains ... then block`。
- 新增第三个 hard gate。
- 用 route seal / WorkContract 替代 spawn evidence。
- 用环境变量长期保留旧 gate。
- 为单个 Slack 文案写特例。

## 最终判断

这套收敛后，复杂度会下降，因为 live path 从 “多层各自 veto” 变成：

```text
ordinary tool -> budget/advisory
octoclaw_dispatch -> DispatchAdmission
sessions_spawn/send -> NativeIntentGate
status/projection -> read truth, no spawn
```

稳定性会提升，因为任何让主模型去 dispatch 的路径，都不会再被另一个外层 gate 禁止 dispatch；任何直接 spawn 的路径，仍然会被 intent gate 防绕过。

这不是完全没有 gate，而是让 gate 有唯一归属，避免多个保护机制互相冲突。
