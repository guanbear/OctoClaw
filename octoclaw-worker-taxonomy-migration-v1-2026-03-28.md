# OctoClaw Worker Taxonomy Migration v1 (2026-03-28)

## 1. 目的

这份文档是 Phase 3 的前置迁移说明。

它不负责直接切换 runtime truth model，而是先把下面几件事钉死：

- 新 taxonomy 到底是什么
- 旧 `octopus-*` label 如何映射
- 哪些层可以先迁
- 哪些层必须等 Phase 2 稳定后再迁

这份文档的目标是让 Phase 3 能并行推进，但不和 Phase 2 的统一运行面收敛打架。

---

## 2. 迁移原则

### 2.1 worker_pool-first

新世界里，系统应该优先读取：

- `worker_pool`
- `executor_type`
- `work_type`
- `phase`
- `protocol`
- `profile`

而不是优先读：

- `octopus-fix`
- `octopus-scout`
- `octopus-test`
- `octopus-power`

### 2.2 legacy label fallback

迁移初期不能硬删旧字段。

兼容顺序必须是：

1. 先读 `worker_pool` / `work_type` / `phase`
2. 读不到时再 fallback 到 legacy label
3. 只有展示或兼容层才继续直接使用旧 label

### 2.3 render/classify/display first

Phase 3 第一拍不应该一上来改 runtime 真相层。

应该先迁这些低风险面：

- status render
- patrol classify / display
- board / lineage render
- replay / summary 展示字段

等这些稳定后，再迁：

- dispatch / spawn 主写入路径
- task-state 真相字段
- bridge/runtime metadata 主消费路径

---

## 3. 新 taxonomy

### 3.1 executor_type

- `main`
- `runner`
- `subagent`
- `team`

### 3.2 worker_pool

- `octoclaw-main`
- `octoclaw-runner`
- `octoclaw-research`
- `octoclaw-code`
- `octoclaw-review`

### 3.3 work_type

- `ops`
- `research`
- `code`
- `review`

### 3.4 phase

- `inspect`
- `collect`
- `implement`
- `verify`
- `merge`
- `report`

### 3.5 protocol

- `normal`
- `heavy`

### 3.6 profile

对内继续把 `profile` 视作附加维度，不作为 taxonomy 主键。

例如：

- `profile=writer`
- `profile=research`
- `profile=code`
- `profile=review`

---

## 4. legacy label 映射表

| legacy label | executor_type | worker_pool | work_type | phase | 说明 |
| --- | --- | --- | --- | --- | --- |
| `octopus-runner` | `runner` | `octoclaw-runner` | `ops` | `inspect` | 特殊只读快路径 |
| `octopus-scout` | `subagent` | `octoclaw-research` | `research` | `collect` | 调研/收集 |
| `octopus-analyze` | `subagent` | `octoclaw-research` | `research` | `inspect` | 分析/根因，后续可视情况拆到 `review` |
| `octopus-writer` | `subagent` | `octoclaw-research` | `research` | `report` | 仍建议保留 `profile=writer` |
| `octopus-fix` | `subagent` | `octoclaw-code` | `code` | `implement` | 实现/修复/补脚本 |
| `octopus-test` | `subagent` | `octoclaw-review` | `review` | `verify` | 验证/回归/质量把关 |
| `octopus-power` | `team` | `octoclaw-research` | `research` | `collect` | 只作为 `spawn_multi` 兼容父节点，不再作为长期角色名 |

补充约定：

- `spawn_multi` 的父任务应该优先由 `executor_type=team` 和 `task_kind=team_parent` 表达
- 不再把 `octopus-power` 当作真正语义角色

---

## 5. Phase 3 分拍建议

### 5.1 第一拍：render/classify/display

目标：

- 不改 runtime truth
- 先让展示与巡逻逻辑理解新 taxonomy

建议落点：

- `status_render.py`
- `patrol.py`
- lineage / board summary

这一步要做到：

- 优先读 `worker_pool`
- 读不到再 fallback 到 legacy label
- 新旧任务混跑时展示稳定

### 5.2 第二拍：compat helper

目标：

- 提供统一 helper，给 status / patrol / board / bridge 共用

建议 helper 输出：

- `executor_type`
- `worker_pool`
- `work_type`
- `phase`
- `protocol`
- `profile`

但仍保留：

- `label`
- `legacy_label`

### 5.3 第三拍：runtime write-path 切换

目标：

- dispatch / spawn / task-state 主路径统一写入新 taxonomy 字段

这一步必须等：

- Phase 2 unified runtime surface 稳定
- Phase 3 第一拍观测通过

### 5.4 第四拍：legacy label 降级

目标：

- 旧 label 从主消费字段降为兼容字段

这一步不等于删除 label，而是：

- 新代码默认不依赖 label
- label 只留给兼容读写和历史任务展示

---

## 6. 风险点

### 6.1 `octopus-analyze`

它在旧世界里经常同时承担：

- research inspect
- review inspect

所以第一版建议继续把它保守映射到：

- `worker_pool=octoclaw-research`
- `work_type=research`
- `phase=inspect`

不要在第一拍里强行把它拆成两种不同解释。

### 6.2 `octopus-power`

它更像“团队父节点”而不是 worker 角色。

所以第一拍里：

- 展示层允许继续认 `octopus-power`
- 但内部分类应优先看 `executor_type=team`

### 6.3 `writer`

`writer` 应视为 profile，而不是基础 worker pool。

所以：

- taxonomy 里不新增 `octoclaw-writer`
- 展示层可根据 `profile=writer` 增强文案

### 6.4 mixed fleet

在迁移期内，一定会出现：

- 只有 label 的旧任务
- 同时有 label 和 worker_pool 的过渡任务
- 只有 worker_pool 的新任务

所以任何 render/classify 逻辑都必须先假设 mixed fleet 长期存在一段时间。

---

## 7. 当前建议

如果只做 Phase 3 第一拍，最合适的做法是：

1. 先补统一 taxonomy helper
2. 先让 status / patrol / board 变成 worker_pool-first
3. 保留 legacy label fallback
4. 暂不切 dispatch/spawn 主路径
5. 暂不删除旧 label

一句话：

> **先把“看见任务”和“解释任务”的层迁过来，再迁“生产任务”的层。**
