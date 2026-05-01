# OctoClaw Judge / Dispatch / Complexity 改进设计

日期：2026-05-01  
分支：`refactor/0.4.0-stable`  
状态：N1 设计补充，等待实现  
关联：`docs/octoclaw-ts-rebuild-design-v2.md`、`docs/octoclaw-judge-ack-policy-spec-2026-04-21.md`、`docs/octoclaw-work-contract-centered-delegation-design-2026-04-25.md`

---

## 1. 问题背景

最近线上 bad case 暴露出的核心问题不是“某几个关键词没覆盖”，而是三个职责没有完全收束：

1. **judge** 有时把状态追问、执行复盘、规则核验误判成新委派任务。
2. **main agent** 在同一 turn 内可能已经读文件、解释或开始回复，之后又按 route/policy 调用 dispatch。
3. **dispatch/spawn** 入口仍更像“agent 可调用工具”，而不是“runtime 授权后的副作用动作”。

如果继续补“为啥没派发 / 没 spawn / no_dispatch_evidence / 派发失败了吗”这类短语，短期能修几个 case，但长期会变成不可维护的关键词墙，并且仍不能证明同一 turn 只有一个执行 owner。

因此本设计把问题从“补分类词表”改成：

> **judge 负责语义建议，runtime 负责副作用授权和投递一致性。**

---

## 2. 设计目标

1. 保留 judge 的主要价值：语义判断、复杂度估计、是否需要 fresh state / side effect / 长耗时执行、预期交付物说明。
2. 不让 judge 直接拥有 dispatch 权限：`route=delegate` 只是候选决策，不能直接创建任务。
3. 不靠关键词覆盖所有追问：状态/失败/来源类问题优先靠 thread anchor、WorkContract、execution receipt、dispatch ledger、TaskFlow binding 和 task-state projection 判定。
4. 默认允许主 agent 干活：简单 reply、解释、轻量本地核验不应被一堆硬门禁锁住。
5. 严格保证同一 turn 执行 owner 单一：要么 main reply，要么 delegated worker，不能同时投递用户可见 final。
6. 把 complexity 收成 canonical 字段：judge 可初判，policy 可修正，WorkContract 固化，status 只展示最终值。

---

## 3. 非目标

1. 不新增一套 live route；live route 仍只有 `reply | delegate`。
2. 不把历史 `runner / direct / spawn_single` 恢复为顶层 route authority。
3. 不把所有工具调用都硬封死；只约束会产生新委派/新 worker 的副作用入口。
4. 不做 online self-tuning；纠偏通过 replay、nightly eval、curated bad cases 和 gated promotion。
5. 不让 AGENTS/rule injection 承担 judge 规则；注入规则只负责协作宪法和 objection 协议。

---

## 4. 合理运行流程

### 4.1 输入事实包

用户消息进入 runtime 后，先构造一个不依赖关键词的事实包：

| 事实 | 来源 | 用途 |
|------|------|------|
| `deliveryTarget` | IM adapter ingress | 固定 channel/thread/reply target，后续 ACK/final/delegate completion 不再 late resolve |
| `turnActionLedger` | runtime hook | 记录本 turn 是否已有 direct tool、visible reply、route seal、dispatch attempt |
| `recentWorkContext` | WorkContract + task-state + replay | 判断当前 thread/session 是否已有相关任务、失败投递、timeout、result ready |
| `executionReceipts` | dispatch/spawn/result/delivery ledger | 判断是否已有真实派发、spawn、native task、completion、delivery evidence |
| `coverage` | execution/memory coverage precheck | 判断是否可直接回答 provenance/status，或需要明确 no-verifiable-record |

这个事实包是 judge 的上下文，也是 runtime 授权的依据。它不是用户可见状态面板，也不应把 raw child transcript 注入主上下文。

### 4.2 Judge 输出结构

judge 仍然是主语义判断来源，但输出必须从“只给 route”升级为结构化建议：

```json
{
  "route": "reply | delegate",
  "is_new_work": true,
  "needs_side_effect": true,
  "needs_fresh_state": false,
  "expected_deliverable": "修复并验证 runtime dispatch 授权",
  "complexity": "simple | normal | deep",
  "duration_hint": "instant | short | long",
  "tool_need_hint": "none | read_only | write_or_exec | network_or_external",
  "confidence": 0.84,
  "reason_codes": ["requires_code_change", "needs_tests"]
}
```

关键点：

- `route=delegate` 不等于允许 dispatch。
- `is_new_work` 必须表示“需要创建新的执行单元”，不是“这句话提到了派发/状态/失败”。
- `expected_deliverable` 必须可验收；没有交付物的 delegate 倾向应降级为 reply。
- `complexity` 是 judge proposal，不是展示真相。

### 4.3 Runtime 薄授权

runtime 不做大词表语义分类，只做四个通用一致性校验：

1. **新工作校验**：`route=delegate` 但 `is_new_work=false`，降级为 `reply`。
2. **交付物校验**：`route=delegate` 但没有清晰 `expected_deliverable`，降级为 `reply`。
3. **单 owner 校验**：本 turn 已经发生用户可见 reply 或 direct action，撤销 delegation eligibility；后续 dispatch 只能返回状态/拒绝包。
4. **sealed delegate 校验**：dispatch 成功后，main agent 不能再 direct read/direct final 抢答；只能协调、查询状态或等待 completion relay。

这些规则不是关键词门禁，而是执行一致性边界。它们不会阻止主 agent 做普通 reply，也不会要求每个简单问题都先走 route_hint。

### 4.4 Delegation Ticket

`octoclaw_dispatch` / `octoclaw_spawn` 应改为只接受 runtime 铸造的一次性派发票据：

```json
{
  "ticket_id": "dt_...",
  "turn_id": "turn_...",
  "session_key": "...",
  "delivery_target_id": "...",
  "work_contract_id": "wc_...",
  "route": "delegate",
  "new_work_contract": true,
  "expected_deliverable": "...",
  "complexity_final": "normal",
  "expires_at": "2026-05-01T10:00:30.000Z",
  "single_use": true
}
```

授权规则：

- 没有 ticket：dispatch 不创建任务，只返回 `dispatch_not_authorized` 状态包。
- ticket 过期：不创建任务，返回 `ticket_expired`。
- ticket 已用：不创建任务，返回 `ticket_already_used`。
- ticket 被撤销：不创建任务，返回 `ticket_revoked`，并带撤销原因。
- ticket 与 turn/session/WorkContract 不匹配：不创建任务，返回 `ticket_scope_mismatch`。

这样即使 judge 或 main agent 偶尔误触发 dispatch，也不会产生新 WorkContract 或子任务。

### 4.5 状态/失败追问路径

状态、失败、来源、投递异常、规则注入核验这类问题的默认路径是：

```text
user follow-up
  -> resolve deliveryTarget/thread/session anchors
  -> read WorkContract/task-state/replay/dispatch ledger
  -> build control-observer fact packet
  -> main agent reply with facts or no-verifiable-record
```

这里可以有少量 deterministic hint，例如精确命令 `状态面板` / `八爪鱼状态` 直接展示面板；但自然语言追问不应靠包含词直接触发脚本，也不应创建新委派任务。

---

## 5. Complexity 判定与归一

### 5.1 职责分工

| 层 | 字段 | 职责 |
|----|------|------|
| judge | `complexity` | 语义初判：任务理解难度、执行步骤、风险 |
| policy resolver | `complexity_final` | 合并 judge、tool need、duration、side effect、freshness、scope 后给最终值 |
| WorkContract | `complexity_final` / `complexity_reason_codes` | canonical truth，后续 dispatch、worker brief、status 都读这里 |
| task-state / status | `complexity_final` | 只展示 WorkContract 投影，不从 replay/native task/judge metadata 混读 |
| replay/nightly | `complexity_proposed` vs `complexity_final` | 评估 judge 漂移和 policy override 是否合理 |

### 5.2 推荐标签

为避免标签太细导致不稳定，热路径只保留三档：

| 标签 | 含义 | 默认 owner |
|------|------|------------|
| `simple` | 可直接回复或轻量只读核验，通常不需要新 WorkContract | main reply |
| `normal` | 有明确交付物，可能需要工具/文件/网络/短测试 | 视 side effect / duration 决定 reply 或 delegate |
| `deep` | 多步骤、长耗时、写操作、测试/部署/可恢复交付 | delegate |

如果需要更细粒度成本控制，另设 `budget_class` 或 `duration_hint`，不要把复杂度标签膨胀成十几档。

### 5.3 Policy override 原则

policy 可以修正 judge complexity，但必须记录原因：

- judge 说 `simple`，但 `needs_side_effect=true` 或 `tool_need_hint=write_or_exec`：升为 `normal/deep`。
- judge 说 `deep`，但 `is_new_work=false` 且已有可回答 ledger：降为 `simple`，route 为 reply。
- judge 缺失 `complexity`：标 `unknown_proposed`，policy 根据 schema 兜底为 `normal` 或 `simple`，并写 degraded reason。
- status panel 只展示 `complexity_final`；debug/raw 才展示 proposed/final diff。

---

## 6. 纠偏机制

每次 route/dispatch 需要写 replay outcome：

```json
{
  "judge_route": "delegate",
  "final_route": "reply",
  "judge_is_new_work": false,
  "dispatch_ticket": "not_issued",
  "override_reason": "delegate_without_new_work",
  "complexity_proposed": "deep",
  "complexity_final": "simple",
  "user_visible_owner": "main_agent",
  "duplicate_delivery_prevented": true
}
```

nightly eval 重点看：

1. `false_delegate`：本应 reply 却生成 delegate ticket。
2. `false_reply`：本应 delegate 却没有 ticket，导致主 agent 低质量硬答。
3. `duplicate_owner`：同一 turn 同时出现 main final 和 delegate completion。
4. `ticket_denied_after_direct_action`：主 agent 抢跑后 dispatch 被拒的频率。
5. `complexity_drift`：judge complexity 与 final complexity 长期偏差。

纠偏顺序：

```text
bad case replay
  -> judge prompt/schema 调整
  -> validator assertion 调整
  -> focused test
  -> shadow/nightly baseline
  -> gated live promotion
```

不要把单个 bad case 直接固化成 live keyword rule。

---

## 7. 实现建议

### S1：只记录，不改变 live 行为

- 在 route decision 中记录 `is_new_work`、`expected_deliverable`、`complexity_proposed`。
- 在 WorkContract 中新增或规范 `complexity_final`、`complexity_reason_codes`。
- 在 replay 中记录 judge proposal 与 policy final 的 diff。

### S2：ticket dry-run

- policy 生成 `delegation_ticket_candidate`，但 dispatch 仍兼容旧调用。
- replay 记录“如果强制 ticket，这次 dispatch 是否会被允许”。
- nightly 统计 false deny / false allow。

### S3：ticket enforced for new dispatch

- `octoclaw_dispatch` / `octoclaw_spawn` 对新任务强制 ticket。
- 旧恢复/兼容路径必须显式标注 legacy，并有关闭计划。
- dispatch denial 返回可回复状态包，不 silent fail。

### S4：status 与复杂度收口

- status 默认只展示 delegate 摘要和 `complexity_final`。
- raw/debug 才展示 proposed/final、judge confidence、override reason。
- 不从 native task、policy cache、replay 自行拼复杂度展示。

---

## 8. 验收标准

1. “为什么刚才自己回复一次又派发一次”不创建新 WorkContract；主 agent 用 ledger 解释。
2. “AGENTS/rule 是否更新”如果只是核验当前规则注入，不创建 delegate；需要文件修改时才可能生成 ticket。
3. judge 误判 `delegate` 但 `is_new_work=false` 时，最终 route 为 reply，并记录 override。
4. main agent 已经 direct action 后再调用 dispatch，dispatch 返回 `ticket_revoked` 或 `dispatch_not_authorized`，不 spawn。
5. dispatch 成功后，main final 被静默或转为 coordinator/status，不与 delegate completion 双投递。
6. status panel 的复杂度来自 WorkContract canonical projection，不展示多个互相冲突的 complexity 来源。
7. nightly report 能看到 judge proposal、policy final、ticket allow/deny、复杂度漂移和 duplicate-owner 防护结果。

---

## 9. 与现有文档的关系

- 本文补充 `octoclaw-ts-rebuild-design-v2.md` 的 N1 委派稳定化设计。
- `octoclaw-judge-ack-policy-spec-2026-04-21.md` 仍是 judge label 和 ACK/policy spec 的基础；后续应把 `is_new_work`、`expected_deliverable`、`complexity_final` 纳入 schema。
- `octoclaw-work-contract-centered-delegation-design-2026-04-25.md` 仍是 WorkContract 委派合同基础；后续应把 delegation ticket 作为 WorkDecisionSeal 到 dispatch materialization 的桥。
- `octoclaw-state-convergence-4-4-design.md` 仍是状态真相边界；本文要求状态追问只读其 canonical projection，不再通过新委派解释旧任务。
