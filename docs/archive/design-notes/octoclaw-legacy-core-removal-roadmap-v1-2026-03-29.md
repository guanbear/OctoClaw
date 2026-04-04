# OctoClaw 旧内核拆除路线图 v1 (2026-03-29)

## 1. 文档目的

这份文档专门回答一个问题：

> 在 OctoClaw 重构过程中，哪些仍然属于“旧内核”，应该按什么顺序拆掉？

它不是产品总设计文档，也不是一次性大重写提案。

它的作用是：

- 识别当前仍在影响运行时行为的旧内核
- 给出拆除优先级
- 说明每一项的风险与验收标准
- 避免重构过程中继续出现 split-brain

主设计文档见：

- [octoclaw-product-design-v2-2026-03-27.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus/octoclaw-product-design-v2-2026-03-27.md)

---

## 2. 先讲结论

当前 OctoClaw 的外层能力已经明显进入新架构：

- runtime policy
- route hint merge
- rollout/plugin/hook
- replay/review/automation
- unified runtime surface
- worker taxonomy 消费层迁移

但仍有 3 个核心区域带着明显旧八爪鱼内核：

1. **选模内核**
2. **角色/标签推断内核**
3. **task truth model 与运行时记录内核**

所以接下来的拆除原则不是“全仓库 rename”，而是：

> **先拆影响真实行为的旧内核，再拆命名和文档残留。**

---

## 3. 拆除原则

### 3.1 先拆运行时真相源，再拆兼容层

凡是会直接影响：

- route
- model
- worker selection
- task metadata
- replay truth

的旧逻辑，都应优先拆。

兼容字段和展示别名可以后拆。

### 3.2 先收单一真相源，再清理命名

不要先忙着把所有 `octopus-*` 改名；
先保证：

- `worker_pool`
- `work_type`
- `phase`
- `profile`
- `route`

真的成为主路径真相源。

### 3.3 不做停机式推倒重来

拆除方式应当是：

- 新字段优先
- legacy fallback 保留一段时间
- 有 replay/eval/fixture 再删兼容

而不是：

- 一次性删掉所有旧字段
- 让线上行为直接失真

---

## 4. 旧内核清单

### P0-1. `resolve-model.py`

文件：

- [lib/resolve-model.py](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus/lib/resolve-model.py)

问题：

- 同时吃 `octopus-mode.json`
- 同时吃 `octopus-model-aliases.json`
- 同时吃 `model-policy.json`
- 同时维护 `/tmp/octopus-model-cache.json`
- 仍然保留 `legacy label / legacy tier`
- 容易出现 mode、policy、cache 三方不一致

典型症状：

- `model_auto.enabled=true`，但运行时仍主要按 `balanced mode` 走
- 缓存可能把 tier/selector 差异抹平
- policy decision 与 raw resolver 输出不一致

拆除目标：

- `worker_pool / profile / phase / route` 成为主输入
- `model-policy.json` 成为主真相源
- `mode / aliases` 降为 fallback
- 缓存按 selector 维度严格分桶

验收标准：

- 同一 tier 在不同 `worker_pool/profile` 下可以稳定得到不同模型
- raw resolver 输出与 runtime policy 的 model 选择一致
- `mode` 不再压过 policy 主路径

风险：

- 这是当前最敏感的行为层
- 一次改太多会直接影响 VM 实际选模

### P0-2. `dispatch_task.py`

文件：

- [lib/dispatch_task.py](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus/lib/dispatch_task.py)

问题：

- 仍保留本地 `infer_label(...)`
- 仍保留本地 `infer_tier(...)`
- planner/worker/review spec 仍大量写入 legacy label
- decision object 虽然已经接入，但还不是唯一真相源

拆除目标：

- dispatch 主路径只消费 decision object
- `legacy_label / legacy_tier` 降为 fallback/compat
- planner/worker/review spec 主字段统一为：
  - `worker_pool`
  - `work_type`
  - `phase`
  - `profile`

验收标准：

- 没有 decision 时才会触发 legacy fallback
- multi-spawn plan 中不再依赖 `octopus-fix / octopus-analyze` 判角色
- dispatch 输出给 runtime record 的主字段是新 taxonomy

风险：

- 会直接碰到 Phase 2 已经稳定的 unified runtime surface
- 必须配合 fixtures 和 lineage 测试

### P0-3. `octoclaw_route.py`

文件：

- [lib/octoclaw_route.py](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus/lib/octoclaw_route.py)

问题：

- 仍然产出 `role_hint`
- 仍然产出 `tier_hint`
- 仍然把 `octopus-*` 当作 route 兼容语义的一部分

拆除目标：

- route 层只负责：
  - `system_preferred_route`
  - `task_class`
  - `features`
  - `route_language_packs`
- `role_hint / tier_hint` 降成 compat 字段，后续可删

验收标准：

- policy 不再依赖 route 里的 `octopus-* role hint` 才能做 worker/model 决策
- route replay 仍保持可解释

风险：

- route 是许多后续模块的上游
- 需要先保证 dispatch/model 侧已经不再强依赖 `role_hint / tier_hint`

---

## 5. 第二批旧内核

### P1-1. `model-intel.py`

文件：

- [lib/model-intel.py](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus/lib/model-intel.py)

问题：

- 仍然围绕旧角色：
  - `runner`
  - `router`
  - `fix`
  - `test`
  - `scout`
  - `writer`
  - `analyze`
  - `power`
  - `main`
- labels/tier 仍主要映射到 `octopus-*`

拆除目标：

- 转为围绕：
  - `worker_pool`
  - `profile`
  - `phase`
  - `route`
- `labels` 从主输出降为 compat
- `tiers` 保留，但不再等同于旧角色选择器

验收标准：

- 新生成的 `model-policy.json` 主键优先是：
  - `profiles`
  - `worker_pool_phases`
  - `worker_pools`
- `labels` 只保留兼容镜像

### P1-2. `task-state-update.py`

文件：

- [lib/task-state-update.py](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus/lib/task-state-update.py)

问题：

- 仍双写：
  - `label`
  - `legacy_label`
- task truth model 尚未完全切到新 taxonomy

拆除目标：

- 任务主字段优先：
  - `worker_pool`
  - `work_type`
  - `phase`
  - `profile`
  - `route`
- `label / legacy_label` 只做兼容镜像

验收标准：

- status / patrol / replay / runtime lineage 都能不依赖 legacy label 正常工作

### P1-3. `octoclaw_spawn.py`

文件：

- [lib/octoclaw_spawn.py](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus/lib/octoclaw_spawn.py)

问题：

- 仍保留旧 `infer_label / infer_tier`
- 一些 result contract 逻辑仍以旧 label 作为语义依据

拆除目标：

- spawn spec 改为新 taxonomy-first
- result/report contract 以 `worker_pool / work_type / phase` 为依据
- legacy label 仅作兼容输出

验收标准：

- 没有 label 时也能稳定生成可用 spawn spec

---

## 6. 第三批旧残留

### P2-1. `patrol.py`

文件：

- [lib/patrol.py](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus/lib/patrol.py)

问题：

- 仍直接读旧 alias / mode 文件
- 仍保留较多 `octopus-*` 语义和旧输出文案

拆除目标：

- patrol 读新 runtime truth model
- 旧 alias/mode 相关 drift 检查重写为 selector-aware 检查

### P2-2. `SKILL.md`

文件：

- [SKILL.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus/SKILL.md)

问题：

- 还在给主 agent 灌输旧角色宇宙

拆除目标：

- 改为：
  - `octoclaw-runner`
  - `octoclaw-research`
  - `octoclaw-code`
  - `octoclaw-review`
  - `profile=writer`
- 明确 route/runtime policy 优先

### P2-3. 主 README 与历史文档

问题：

- 新旧概念并存
- `octopus-*` 旧术语仍在核心说明中出现

拆除目标：

- 主文档只保留新口径
- 历史文档明确标记为 `historical / superseded`

---

## 7. 最后再做的命名迁移

### P3-1. skill 路径与目录名

例如：

- `/workspace/openclaw/skills/octopus`

问题：

- 仍是旧目录名
- 容易造成“产品已经重构完了吗”的认知错觉

说明：

- 这一步最后做
- 不要和 runtime 核心重构绑在一起

### P3-2. `/tmp/octopus-*` 与历史路径

问题：

- 旧路径遍布 rollout / cron / patrol / docs

说明：

- 需要专门做路径兼容迁移
- 不能抢在 P0/P1 前面做

---

## 8. 推荐拆除顺序

### 第 1 波

1. [lib/resolve-model.py](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus/lib/resolve-model.py)
2. [lib/dispatch_task.py](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus/lib/dispatch_task.py)
3. [lib/octoclaw_route.py](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus/lib/octoclaw_route.py)

### 第 2 波

4. [lib/model-intel.py](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus/lib/model-intel.py)
5. [lib/task-state-update.py](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus/lib/task-state-update.py)
6. [lib/octoclaw_spawn.py](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus/lib/octoclaw_spawn.py)

### 第 3 波

7. [lib/patrol.py](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus/lib/patrol.py)
8. [SKILL.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus/SKILL.md)
9. [README.md](/Users/guanzhicheng/Documents/Playground/openclaw-projects/openclaw-octopus/README.md) 与主设计文档

### 第 4 波

10. skill 路径和 `/tmp/octopus-*` 命名迁移

---

## 9. 路线判断

当前最不该做的是：

- 先 rename 一堆 `octopus-*`
- 但真实行为还是旧选模和旧角色推断在控制

当前最该做的是：

> **先拆选模、角色推断、task truth model 这三个旧内核，再做命名收官。**

---

## 10. 后续建议

建议下一步单独再写一份执行版文档：

- `旧内核拆除路线图 v2（执行版）`

里面把每一项继续拆成：

- 改动范围
- 前置条件
- 回归测试
- rollout 风险
- 回滚方式

这样就可以直接进入逐项拆除，而不是继续停留在概念层。
