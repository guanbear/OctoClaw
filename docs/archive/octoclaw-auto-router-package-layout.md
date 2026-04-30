# OctoClaw Auto Router Package Layout

> 状态：RM4 packaging-prep baseline（2026-04-08）  
> 用途：把 `Auto Router` 后续如果真的抽成子包时，哪些入口、哪些所有权分组、哪些运行时耦合应保留在主仓，写成比 boundary map 更接近工程落地的 package layout。  
> 关联文档：[`octoclaw-auto-router-boundary-map.md`](./octoclaw-auto-router-boundary-map.md)、[`octoclaw-router-model-intel-deepening-design.md`](./octoclaw-router-model-intel-deepening-design.md)、[`octoclaw-auto-router-implementation-checklist.md`](./octoclaw-auto-router-implementation-checklist.md)

---

## 1. 一句话判断

> **现在已经可以把 Auto Router 视为“可抽离 recommendation kernel + facts plane + eval shell”的组合，但 runtime adapter 仍必须留在 OctoClaw 主仓。**

所以这一轮做的不是：

- 立刻拆仓
- 立刻建独立服务
- 立刻把 policy / patrol / observer 迁出去

而是先明确：

- 未来候选包的公开入口
- 每组入口由谁拥有
- 哪些文件已经适合迁移
- 哪些文件现在还不该迁

---

## 2. 候选包的正确边界

如果后续真的抽离，目标更像：

- `packages/octoclaw-auto-router`

它应包含：

1. recommendation kernel
2. model-intel facts plane
3. source adapters / sync shell
4. replay-driven router eval baseline
5. 薄的 public surface shell

它不应包含：

1. runtime policy adapter
2. delegated lane execution adapter
3. observer / patrol / task display
4. TaskFlow substrate orchestration
5. IM / anchor / task action surfaces

---

## 3. 当前建议的 public entries

### 3.1 `manifest`

- command:
  - `node lib/auto-router-surface.mjs manifest`
- 责任：
  - 输出 extractable boundary manifest

### 3.2 `layout`

- command:
  - `node lib/auto-router-surface.mjs layout`
- 责任：
  - 输出 package layout manifest

### 3.3 `facts`

- command:
  - `node lib/auto-router-surface.mjs facts`
- 责任：
  - 输出 model-intel facts plane 的统一读面

### 3.4 `recommend`

- command:
  - `node lib/auto-router-surface.mjs recommend --task ...`
- 责任：
  - 输出 recommendation payload

### 3.5 `eval`

- command:
  - `node lib/auto-router-surface.mjs eval --events ...`
- 责任：
  - 输出 replay-driven router eval baseline

### 3.6 `sync`

- command:
  - `node lib/model-intel-sync.mjs refresh`
- 责任：
  - 刷新在线 model-intel source adapters

---

## 4. 所有权分组

### 4.1 `python_router_core`

- 当前文件：
  - `lib/auto_router.py`
- 负责：
  - signal extraction
  - route recommendation
  - budget recommendation
  - model-intel recommendation payload

### 4.2 `python_router_eval`

- 当前文件：
  - `lib/router_eval.py`
  - `lib/replay_review.py`
  - `lib/replay_curate.py`
- 负责：
  - replay-driven router evidence
  - route/budget drift summary

### 4.3 `node_source_adapters`

- 当前文件：
  - `lib/model-intel-sync.mjs`
- 负责：
  - `models.dev`
  - `OpenRouter catalog`
  - `OpenRouter rankings`
  这些外部源的抓取、映射与 last-good fallback

### 4.4 `node_runtime_shell`

- 当前文件：
  - `lib/auto-router-boundary.mjs`
  - `lib/auto-router-package-layout.mjs`
  - `lib/auto-router-surface.mjs`
- 负责：
  - boundary manifest
  - package layout manifest
  - public surface shell

---

## 5. 当前明确不迁移的运行时耦合

以下文件目前仍应保留在 OctoClaw 主仓：

- `lib/octoclaw_policy.py`
- `extensions/octoclaw-runtime/policy/decide.js`
- `lib/dispatch_task.py`
- `lib/octoclaw_spawn.py`
- `lib/runtime_observer.py`
- `lib/patrol.py`
- `lib/task_display.py`

原因不是“永远不能抽”，而是：

- 它们的主要职责仍是当前 runtime / TaskFlow / operator surfaces
- 不属于 recommendation kernel 本身

---

## 6. 建议的未来目录

如果后续抽成子包，建议先按下面这个 layout 组织，而不是先建 HTTP service：

```text
packages/octoclaw-auto-router/
  src/
    python/
      auto_router.py
      router_eval.py
    node/
      model-intel-sync.mjs
      auto-router-boundary.mjs
      auto-router-package-layout.mjs
      auto-router-surface.mjs
  docs/
  tests/
```

这代表的是：

- 先按所有权和入口分层
- 再讨论 repo/package 抽离
- 而不是先讨论部署形态

---

## 7. 推荐迁移顺序

1. 冻结 schema 与 public entry command
2. 维持 runtime adapter internal-only
3. 优先迁 `source adapters + router eval + public shell`
4. 再讨论 recommendation kernel 是否独立目录
5. 最后才讨论独立包、独立服务或 OpenAI-compatible proxy

---

## 8. 完成标准

当以下判断成立时，packaging-prep baseline 就算完成：

1. 有 canonical package layout 文档
2. 有 machine-readable package layout manifest
3. `auto-router-surface` 能统一暴露 `manifest / layout / facts / recommend / eval`
4. 可以明确指出哪些文件未来候选迁移、哪些仍必须留在主仓
5. 后续讨论“怎么抽”时，不再需要重新争论目录所有权
