# Auto Router v3 — 交给其他 AI 的协作手册

Date: 2026-05-13
Audience: 准备把 Auto Router v3 实施工作交给另一个 AI agent（Codex、Claude Code、其他 IDE agent）的人

## 目的

这份文档解决一个具体问题：**把 Auto Router v3 的设计稳定地交给另一个 AI 完成，不让它偏方向、不让它自造风格、不让它跑偏成关键词匹配**。

Auto Router v3 的设计本身已经切成三份文档（见"文档栈"）。这份文档只告诉你：**交接时说什么话，贴哪些文件，怎么验收**。

---

## 文档栈（交给 AI 看什么）

按照"从高到低"的顺序，四份文档分工清楚：

| 文档 | 用途 | 稳定度 |
|------|------|-------|
| `openspec/changes/router-v3-0.6.x/proposal.md` | Why + 目标 + 非目标 | 高 |
| `openspec/changes/router-v3-0.6.x/design.md` | 架构 / 数据流 / 接口形状 | 高 |
| `openspec/changes/router-v3-0.6.x/tasks.md` | 可勾的任务清单，按 Phase 切 | 高 |
| `docs/octoclaw-auto-router-v3-design-2026-05-13.md` | 完整设计文档（含访谈决策、硬不变量 14 条） | 高 |
| `docs/octoclaw-auto-router-v3-bdd.md` | 70+ BDD 场景，每个场景 = 一个必过测试 | 高（验收） |
| `docs/octoclaw-auto-router-v3-algorithms.md` | 算法伪代码（缓存 key / 评分权重 / 晋升条件 / 健康探针） | 高（一字不差） |

AI 阅读顺序建议：`proposal → design（设计文档）→ tasks → algorithms → bdd`。

---

## 14 条硬不变量（贴在每次 prompt 里）

任何时候违反，都要停下来问用户：

1. **子 agent 可以自动切模型；主 agent 只能建议，不能静默切。**
2. **没有关键词匹配。** 任何分支不能走 `if prompt.includes("复杂")` 这类规则；必须走 judge + 结构化信号（capability / health / cost / config gate）。
3. **Judge 输出只有 3 字段：`route` / `confidence` / `complexity`。** 不加 `scenario`、不加 `complexity_confidence`、不加任何 reasoning 字段。
4. **数据以外部为主，本地 replay 只是可选。** 因为项目要给别人用，不能假设用户有高质量本地数据。
5. **V1 只有一种模式：balanced。** cost-priority / quality-priority 推到 V2。
6. **V1 不做 Tier 0/1/2 分层 judge。** 历史证明会变成关键词补丁。
7. **所有用户数据（cost / shadow / decisions）V1 只存本地。** 任何共享都要 opt-in，V1 不做。
8. **所有输出必须是稳定 JSON，且中文友好。** Judge 响应出现非 JSON / 超时 / 解析失败 → 走 fallback，不让它传染全链路。
9. **每次 router 决策都要写 `shadow event`。** 哪怕 promotionState=live，也要有完整 reasonCodes。
10. **健康探针失败 → 冷却 30 分钟，不要立刻重试。** 避免雪崩到用户配额。
11. **任何模型切换必须落到 footer 可见。** 用户不翻 log 就应该看到"本次子 agent 用了 X 模型"。
12. **成本预测 vs 实际误差 > 20% 就告警。** 预测失效比没有预测更危险。
13. **用户 override 永远赢。** `score override` / `dispreferred` / `ban` 三种颗粒度都不允许被自动推广覆盖。
14. **失败保守：fail-open 到现状。** 如果 router 坏了、snapshot 坏了、judge 挂了，退回"用当前配置的 primary model"，不要让路由故障阻塞 dispatch。

---

## 交接 prompt 模板（整段复制粘贴）

下面这段可以直接粘到 Codex、Claude Code 或任何其他 agent 的对话框里。替换 `{Phase X}` 和 `{任务编号}` 两个占位符即可。

```
你要帮我实施 Auto Router v3 的 {Phase X}。这是一个 OpenClaw 插件的子模块（OctoClaw），
会被抽成独立包 @octoclaw/router，未来可能独立开源。

先读以下文档，按顺序：

1. openspec/changes/router-v3-0.6.x/proposal.md   (Why + 非目标)
2. openspec/changes/router-v3-0.6.x/design.md     (架构 + 接口)
3. openspec/changes/router-v3-0.6.x/tasks.md      (完整任务清单)
4. docs/octoclaw-auto-router-v3-design-2026-05-13.md  (含 14 条硬不变量，§14)
5. docs/octoclaw-auto-router-v3-algorithms.md     (算法伪代码 — 一字不差实现)
6. docs/octoclaw-auto-router-v3-bdd.md            (70+ BDD 场景 — 验收用)

重要约束（违反任何一条请停下来找我确认）：
- 不做关键词匹配，所有分支走 judge + 结构化信号
- 子 agent 可自动切，主 agent 只能建议
- Judge 输出严格 3 字段：route / confidence / complexity
- 外部数据为主，本地 replay 只是可选
- V1 单一 balanced 模式，不做 Tier 0/1/2 分层
- 数据只存本地，不做共享
- 失败保守：fail-open 到 primary model
- 所有改动要有对应 BDD 场景的测试通过

你的任务：
- 打开 openspec/changes/router-v3-0.6.x/tasks.md
- 做完 {Phase X} 的 {任务编号} 这几项
- 每个任务做完后：
  1. 把对应 BDD 场景（RT-X-NNN）转成 Vitest 测试
  2. 跑 pnpm --filter @octoclaw/router test（如果包还没抽就跑根 pnpm test）
  3. 跑 pnpm check 确保无 ts/lint 错误
  4. commit 时 message 格式：
     router(<scope>): <one-liner>
     
     - 关联 BDD: RT-X-NNN, RT-X-NNM
     - 关联任务: Phase X / 任务编号
- 不要跨 Phase，做完本 Phase 交回给我

如果任何地方 BDD 场景不够清楚 / algorithms 伪代码有歧义：
STOP，把不清楚的地方列出来给我，不要猜。

当前 git 状态：v0.5.0 分支，已有前序工作（Auto Router v1 shadow-bridge、
extension-entry 瘦身、死代码清理、CI 修复）。你只负责 Phase X。
```

---

## 怎么切分给不同 AI

Tasks 切成了 5 个 Phase，每个 Phase 可以独立交给一个 AI / 一次 session：

| Phase | 难度 | 交给谁合适 | 关键风险 |
|-------|------|-----------|---------|
| A. Package extraction | 低 | 任意 AI | 循环引用；判断哪些东西留在 runtime |
| B. Capability snapshot + scoring | 中 | 有 data wrangling 经验的 AI | 榜单数据格式漂移 |
| C. Promotion + shadow→live | 中 | 任意 AI | 晋升阈值要和 BDD 完全一致 |
| D. Wizard + override | 低 | 任意 AI | CLI UX 要和 design.md 截图一致 |
| E. Cost reporting | 低 | 任意 AI | 预测误差告警阈值不要改 |

**建议做法**：
- A 你自己或者主 AI 做（因为涉及 workspace 架构调整）
- B、C 串行做，因为 C 依赖 B 的 capability snapshot
- D、E 可以并行（分别是 CLI 和 reporting，几乎不互相影响）

---

## 每次交接后的验收清单

不管交给哪个 AI，收到 PR / commit 后这 6 件事必须都过：

- [ ] `pnpm check` 0 error 0 new warning
- [ ] `pnpm test` 全绿（对应 Phase 的 BDD 场景必须有新增测试）
- [ ] 新代码没有出现 `if (prompt.includes(...))` 或类似关键词匹配
- [ ] Judge 调用点没有要求额外字段（scenario / complexity_confidence 仍然没有）
- [ ] Shadow event schema 和 algorithms §8.4 完全一致
- [ ] 文档和代码没有冲突 —— 如果 AI 发现文档有坑，应该在 PR 里单独提 issue 而不是默默改文档

---

## 如果 AI 偏了，怎么把它拉回来

常见偏差 + 处理话术：

**偏差 1：AI 加了 `if (prompt.match(/code|代码/))` 走快路径**
→ 回复："这是关键词匹配，违反硬不变量 #2。请用 judge 的 complexity 字段判断，如果 judge 挂了走 fallback。"

**偏差 2：AI 让主 agent 也自动切模型**
→ 回复："这违反硬不变量 #1。主 agent 只能 emit suggestion，不能替换 model。看 design.md §6。"

**偏差 3：AI 给 Judge 加了 scenario 或 reasoning 字段**
→ 回复："违反硬不变量 #3。V1 只能 3 字段。scenario 推到 V2。"

**偏差 4：AI 开始设计 Tier 0/1/2 多层 judge**
→ 回复："历史上我们试过，会变成关键词补丁。违反硬不变量 #6。V1 只有一层 judge + fallback。"

**偏差 5：AI 开始设计"用户数据上传到云端"**
→ 回复："违反硬不变量 #7。V1 只存本地。"

**偏差 6：AI 说"为了稳定性我加了 N 层 fallback"**
→ 回复："fallback 只允许在 algorithms.md §1.3 定义的那一种。多余的 fallback 会让失败模式不可观测。"

---

## 什么时候回到我（用户）

AI 遇到以下情况必须停下来找你：

1. BDD 场景和 algorithms 有冲突 → 你来裁决
2. 发现 design.md 缺失某个决策 → 你来补
3. 要改 14 条硬不变量中的任何一条 → 必须你同意
4. 要引入新的 npm 依赖 → 尤其是运行时依赖
5. 要改 OpenClaw 底层 API / task-flow 协议 → 这是跨系统变更
6. 榜单数据源想换（比如去掉 PinchBench 或加新榜单）→ 涉及质量基线

---

## 附：给 AI 的"冷启动 5 分钟"版本

如果 AI 的 context 很紧，下面这个浓缩版足够它开始：

```
OctoClaw 是 OpenClaw 的 TypeScript 插件，解决：主 agent 自动委派子 agent、
按需选模型、IM 适配。Auto Router v3 是下一代路由，把 judge（语义层）
和 router-lite（决策层）合并成独立包 @octoclaw/router。

读：
- openspec/changes/router-v3-0.6.x/{proposal,design,tasks}.md
- docs/octoclaw-auto-router-v3-{design-2026-05-13,algorithms,bdd}.md

14 条硬不变量（§14 of design doc）不可违反。
Judge 只能 3 字段。没有关键词匹配。数据只存本地。
子 agent 自动切，主 agent 建议不切。

任务：Phase {X}, 子任务 {编号}。
验收：对应 BDD 场景（RT-X-NNN）有测试通过 + pnpm check 0 warning。
有疑问 STOP，不要猜。
```
