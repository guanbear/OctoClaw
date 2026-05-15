# OctoClaw 历史设计归档索引

> 本目录保存历史设计文档。**不再是当前 source of truth**；当前真相源请看：
>
> - [`../../octoclaw-ts-rebuild-design-v2.md`](../../octoclaw-ts-rebuild-design-v2.md)
> - [`../../octoclaw-design-foundation.md`](../../octoclaw-design-foundation.md)
> - [`../../octoclaw-improvement-plan-2026-05-12.md`](../../octoclaw-improvement-plan-2026-05-12.md)

## 2026-05-15 归档批次（Cut 2）

以下文档从 `docs/` 移入，对应 v0.6.0 瘦身。

| 文档 | 状态 | 被取代原因 |
|------|------|-----------|
| `octoclaw-auto-router-v3-design-2026-05-13.md` | Historical reference | v3 已实现，设计文档变历史记录 |
| `octoclaw-auto-router-v3-algorithms.md` | Historical reference | v3 配套，随主文档归档 |
| `octoclaw-auto-router-v3-bdd.md` | Historical reference | v3 配套，随主文档归档 |
| `octoclaw-auto-router-v3-handoff.md` | Historical reference | v3 配套，随主文档归档 |
| `octoclaw-auto-router-lite-cost-model-design-2026-05-08.md` | Historical reference | 被 v3 design 取代 |
| `octoclaw-phase5-auto-router-design-2026-04-30.md` | Historical reference | 被 v3 design 取代 |
| `octoclaw-auto-router-design.md` | Historical reference | 早期战略底稿，被 v3 取代 |
| `octoclaw-n1-runtime-ledger-implementation-plan-2026-05-01.md` | Historical reference | N1 已完成 |
| `octoclaw-runtime-convergence-cleanup-plan-2026-05-07.md` | Historical reference | 对应 openspec change 已归档 |
| `octoclaw-state-convergence-4-4-design.md` | Historical reference | `refactor/0.4.0-stable` 时代 |
| `octoclaw-work-contract-centered-delegation-design-2026-04-25.md` | Historical reference | 被 v2 baseline 吸收 |
| `octoclaw-feedback-loop-contracts.md` | Historical reference | `refactor/0.4.0-stable` 时代 |
| `octoclaw-repo-debt-cleanup-plan-2026-05-09.md` | Historical reference | 已完成的 hygiene plan |
| `octoclaw-v0.6.0-handoff.md` | Historical reference | v3 handoff 配套，随 v3 归档 |

---

## 2026-03 到 2026-04 归档批次（原有）



这些旧文档仍然有三类价值：

1. 看清设计是如何演化过来的
2. 在做某个局部切片时，回看当时的专题判断
3. 理解为什么某些早期方案后来被收口、降级或放弃

但请注意：

- 部分文档包含**本机绝对路径**、旧 workspace 假设或当时的命名习惯
- 部分文档默认 `ClawTeam` 是核心运行面，这已经被后续方向收口
- 2026-04-03 的较新提交已经进一步强化了 unified runtime observer、taskflow-bound substrate、on-demand runner fallback 等方向

校准当前判断时，重点参考过这些较新的提交方向：

- `aedaffc` Promote runner jobs to taskflow-bound tasks
- `17abf08` Add unified octoclawctl runtime control entrypoint
- `ec335e8` Extract runtime observer and add on-demand runner fallback
- `e9bf47b` Unify patrol observation pass and ondemand runner mode
- `8b9510b` add native taskflow control metadata
- `d963dfa` persist session resume contexts

## 分级规则

- **Supporting reference**：局部仍有用，但只适合支撑专题判断，不再作为总设计依据
- **Partially outdated**：部分核心判断仍可复用，但已被后续提交或更晚文档明显修正
- **Historical reference**：主要保留演化背景，不建议再直接拿来指导当前实现

## 文档分级表

| 文档 | 状态 | 判断依据 | 后续使用方式 |
|---|---|---|---|
| `octoclaw-review-and-action-plan-v1-2026-04-02.md` | Supporting reference | 复盘质量高，尤其是 route/tool/result shaping 与中期反馈闭环思路仍有效；但“哪些事项尚未落地”的判断已被 2026-04-03 后续提交部分改写 | 作为问题清单、反馈闭环与中期整理参考 |
| `octoclaw-product-design-v2-2026-03-27.md` | Supporting reference | 三脑定位、feedback loop、IM/display、artifact/retrieve、substrate/lane/control 分层都仍重要；问题在于文档内“已做/未做/下一步”状态已与当前实现不同步 | 作为主设计底稿的高价值来源，而非当前总纲 |
| `octoclaw-openclaw-task-flow-analysis-v1-2026-04-01.md` | Supporting reference | 对 taskflow substrate 的分析仍有价值 | 作为 substrate 绑定专题参考 |
| `octoclaw-openclaw-task-flow-migration-plan-v1-2026-04-01.md` | Partially outdated | 迁移方向正确，但 phase 状态与 2026-04-03 后续落地不再完全同步 | 作为 taskflow 迁移背景参考 |
| `octoclaw-anthropic-agent-engineering-notes-v1-2026-03-30.md` | Supporting reference | 外部工程方法论输入，且 2026-04-02 有补充更新 | 作为方法论依据参考 |
| `octoclaw-anthropic-agent-engineering-notes-v1-2026-03-30.zh-CN.md` | Supporting reference | 上条中文对应版本，2026-04-03 新增翻译 | 同上 |
| `octoclaw-state-machine-remediation-v1-2026-03-29.md` | Supporting reference | handoff-aware state machine 仍是局部真问题 | 作为状态机局部设计参考 |
| `octoclaw-runtime-borrowings-execution-v1-2026-03-30.md` | Partially outdated | 承接当时的 borrowings 落地切片，但后续 observer/taskflow 收口改变了整体语境 | 作为 slice 实施记录参考 |
| `octoclaw-grayzone-routing-design-v1-2026-03-27.md` | Supporting reference | 灰区路由依然是有效问题，但需放回 contract-selection 心智下重读 | 作为 route 专题参考 |
| `octoclaw-worker-taxonomy-migration-v1-2026-03-28.md` | Supporting reference | taxonomy 仍相关，但不应脱离新的 control/runtime 边界单独驱动路线 | 作为 worker pool 参考 |
| `octoclaw-legacy-core-removal-roadmap-v1-2026-03-29.md` | Supporting reference | 旧内核拆除仍有工程价值 | 作为技术债清单参考 |
| `octoclaw-model-health-cooldown-design-v1-2026-03-29.md` | Supporting reference | 是局部 model policy 方案，不影响总架构定义 | 作为选模健康度专题参考 |
| `octoclaw-display-layer-productization-plan-v1-2026-03-29.md` | Supporting reference | IM capability matrix 与 display 分层思路仍高价值；部分能力现在已有 baseline，不应再按纯未来方案理解 | 作为 IM/display 产品化参考 |
| `octoclaw-task-display-schema-v1-2026-03-29.md` | Supporting reference | schema 本身仍有专题价值 | 作为显示层 schema 参考 |
| `octoclaw-clawteam-deerflow-source-notes-v1-2026-03-29.md` | Historical reference | 更偏 source borrowing 记录；当前不应再由它决定系统边界 | 作为借鉴背景材料 |
| `octoclaw-clawteam-unified-runtime-v1-2026-03-25.md` | Historical reference | 明显建立在 ClawTeam 核心运行面的假设上，已被后续 optional-backend 方向修正 | 仅保留历史语境 |
| `clawteam-integration-analysis-2026-03-25.md` | Historical reference | 价值主要在解释为什么当时重视 ClawTeam | 仅保留演化背景 |
| `deerflow-clawteam-open-source-analysis-2026-03-26.md` | Historical reference | 是更早期的外部项目比较研究，不适合作当前执行依据 | 仅保留调研背景 |
| `octoclaw-direction-analysis-2026-03-19.md` | Historical reference | 早期方向判断，核心问题意识仍对，但系统边界已明显演进 | 仅保留源头背景 |
| `octoclaw-roadmap-multi-agent-cost-speed-2026-03-20.md` | Historical reference | 路线图过早，且后续 runtime substrate / observer 方向变化较大 | 仅保留历史路线参考 |
| `octoclaw-strategy-summary-2026-03-26.md` | Historical reference | 核心判断高度依赖 ClawTeam 作为主运行面，这一点已不再成立 | 仅保留策略演化背景 |

## 使用建议

- 想判断“现在应该怎么设计” → 先看 canonical docs
- 想判断“某个局部问题之前怎么想过” → 再回 archive
- 如果 archive 与 canonical docs 冲突，以 canonical docs 为准
