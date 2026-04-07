# OctoClaw Transition Cleanup 设计稿

> 状态：focused design note（2026-04-07）
> 前置：P4/P5/P6 baseline 已完成，macmini 实机验收已通过
> 约束：基于 OpenClaw 2026.4.5 substrate/runtime 语义；runtime hot path 优先 Node.js / JS；不在本阶段重开 router / IM / backend 新专题

---

## 1. 这阶段到底要解决什么

现在 OctoClaw 的主问题已经不再是：

- 路由能不能跑
- substrate-aware surfaces 有没有
- runtime observer / on-demand runner 能不能成立

这些 baseline 已经成立。

当前更值钱的问题是：

> **系统还存在 transition state。**

也就是：

- legacy mirror 仍和 managed/native truth 并存
- 部分 policy state 仍停在进程内 Map，不算 durable
- observer / review / retrieve 虽然已经 substrate-aware，但还有边角仍带过渡层语义
- optional backend 虽已降级成增强层，但还不算真可拔插

这一阶段的目标不是加 feature，而是把这些过渡层继续压缩掉。

---

## 2. 设计结论

Transition cleanup 应分成四条线，但要按顺序收：

1. **TC1: durable policy state**
2. **TC2: substrate-only read path tightening**
3. **TC3: legacy mirror / fallback shrink**
4. **TC4: optional backend true detach**

顺序不能反。

原因：

- 没有 durable policy state，observer/control 再干净也会在恢复/续接时漂
- 没有 substrate-only read path，mirror 就永远删不动
- mirror/fallback 没缩掉，optional backend 就会继续被过渡逻辑暗绑住

---

## 3. 非目标

这阶段明确不做：

- 不重开 router / model-intel 深化
- 不重开 P3 channel capability 大题
- 不大规模 Python -> TS 迁移
- 不立刻把所有 legacy mirror 全删光
- 不把 ClawTeam / tmux / runner-daemon 支持整体删除

一句话：

> **这一阶段是做 transition reduction，不是做 system rewrite。**

---

## 4. 当前热点与判断

### 4.1 policy state 还不够 durable

当前 runtime extension 里仍有：

- `extensions/octoclaw-runtime/index.js`
- `const policyStateBySession = new Map()`

这说明：

- route decision / delegated sticky context / tool-policy context 仍有一部分只活在进程内
- 虽然已经有 prompt-equivalent fallback 和 recent delegated lookup
- 但它还不是 durable state

当前判断：

- **这是 transition cleanup 的第一刀**
- 它比 mirror cleanup 更基础

### 4.2 observer/read path 仍有 mixed seams

现状已经比以前好多了：

- `display/retrieve` 已 substrate-first
- `observer/review` 已 substrate-aware

但还存在：

- raw task `status` 与 substrate-preferred surface state 之间的混合
- observer/counts/text surface 需要继续明确“表面状态优先”还是“原始状态优先”
- review / retrieve 对 artifacts/context/report 的优先级仍带少量过渡味

当前判断：

- **需要把 surface-state hierarchy 明文化**
- 并把 observer/retrieve/review 默认读顺序写成一套 contract

### 4.3 legacy mirror 仍有恢复价值，但不该再是默认解释层

当前代码里，`legacy mirror only` 仍清晰可见：

- `lib/task_display.py`
- `lib/openclaw_taskflow_adapter.py`

这说明：

- mirror 还没退场
- 但它现在应被理解为 compatibility / recovery substrate，而不是主 truth

当前判断：

- **mirror 不该“一刀切全删”**
- 应按 retained value 分类清理

### 4.4 optional backend 还不算真可拔插

现在文档和 surfaces 已把 heavy backend 降成 optional enhancement。
但严格来说，仍有这些残余：

- spawn/backend hints 仍可见于部分 config / runtime seams
- install/runtime 脚本仍存在 backend-oriented assumptions
- bridge/workbench 还没有完全退成 capability plugin 心智

当前判断：

- **P6 baseline 已成立**
- 但 transition cleanup 还要把 optional backend 从“概念 optional”推进到“行为 optional”

---

## 5. 目标架构

Transition cleanup 后，希望形成这套更干净的层次：

```text
OpenClaw substrate
  -> native task / TaskFlow truth

OctoClaw durable policy state
  -> route / delegated sticky / observer-control intent
  -> persisted session-scoped lightweight ledger

OctoClaw read model
  -> runtime observer
  -> task detail / retrieve / review / queue
  -> substrate-first, mirror-as-compatibility

OctoClaw compatibility layer
  -> legacy mirror
  -> fallback bindings
  -> recovery-only usage

Optional execution enhancements
  -> tmux / ClawTeam / resident runner / workbench
  -> capability plugins, not truth sources
```

---

## 6. 具体工作包

### TC1: Durable Policy State

#### 目标

把 runtime extension 里当前仅存在于 `Map` 的会话 policy state，降成：

- session-scoped
- TTL-bound
- persisted lightweight ledger

#### 建议形态

新增一个 workspace-local persisted state：

- `WORKSPACE/tmp/octopus/runtime-policy-state.json`

结构只保留最小字段：

- `session_key`
- `prompt_fingerprint`
- `route`
- `work_contract`
- `tool_policy`
- `pre_dispatch_ack_sent`
- `created_at`
- `updated_at`
- `expires_at`

#### 原则

- persisted policy state 是 **continuity hint**
- 不是新的 truth source
- source of truth 仍然是:
  - runtime events
  - task-state / substrate facts
  - observer snapshot

#### 不该做的

- 不把整份 decision 大对象长期持久化
- 不把 policy state 做成另一套数据库

#### 涉及代码

- `extensions/octoclaw-runtime/index.js`
- `lib/runtime_policy.py` / replay-related schema if needed

#### 完成标准

- 进程重启后，delegated sticky / control-observer tool policy 不再完全丢失
- prompt fallback 不再主要依赖“最近几分钟内 Map 还在”

---

### TC2: Substrate-Only Read Path Tightening

#### 目标

把 `observer / review / retrieve / queue / detail` 的读顺序收成统一 contract：

1. native / managed substrate facts
2. bound mirror facts
3. task artifacts / report / context
4. compatibility-only fallback text

#### 要补的不是大功能，而是 hierarchy

需要把下面几件事明确：

- `surface state` 永远优先于 raw task `status`
- `TaskFlow target` / `create path` / `review surface` 是 primary evidence
- report/context 是 secondary evidence
- summary fallback 只在 substrate facts 不足时补

#### 涉及代码

- `lib/runtime_observer.py`
- `lib/task_display.py`
- `lib/task_display_cli.py`
- `lib/status_render.py`

#### 完成标准

- observer / queue / detail / retrieve 对同一任务不再出现状态口径分裂
- review / retrieve 默认先露 substrate target，而不是先露 report path

---

### TC3: Legacy Mirror / Fallback Shrink

#### 目标

对 current mirror/fallback 做 retained-value 分类，而不是笼统保留。

#### 分类建议

1. **must keep for recovery**
   - native create unavailable but artifact/report already exists
   - historical task needs operator inspection
   - old queued legacy tasks awaiting cleanup

2. **keep as temporary compatibility**
   - upstream public native create surface still absent
   - some spawn paths still need mirror registration for display continuity

3. **eligible to demote**
   - display-only mirror fields duplicated by managed/native bindings
   - fallback summaries that no longer contribute recovery value

4. **eligible to remove**
   - dead compatibility fields no longer read by any surface

#### 需要产物

- mirror field inventory
- who still reads it
- why it still exists
- cleanup order

#### 涉及代码

- `lib/openclaw_taskflow_adapter.py`
- `lib/task_display.py`
- `lib/status_render.py`
- `lib/patrol.py`

#### 完成标准

- `legacy mirror only` 只在确有恢复价值的老任务上继续出现
- 新任务默认不再依赖 mirror-first 才能被正确观察

---

### TC4: Optional Backend True Detach

#### 目标

把 optional backend 从“文档上 optional”推进到“行为上可拔插”。

#### 具体含义

- 不启用 tmux / ClawTeam / resident runner 时
- 默认主链仍完整、自然、不会表现成 degraded mode

#### 需要检查的点

- config default wording
- install / ctl / status / observer 是否仍暗示某 backend 是 primary
- bridge/workbench hint 是否都退成 secondary operator note

#### 涉及代码

- `lib/octopus_config.py`
- `lib/clawteam_bridge.py`
- `bin/octoclawctl.sh`
- `lib/status.sh`
- `lib/runtime_snapshot.py`

#### 完成标准

- backend 关闭不影响 default truth surfaces
- backend 信息只在 operator diagnostics 中作为 capability note 出现

---

## 7. 推荐实施顺序

### Slice A

- TC1 durable policy state
- TC2 read-path contract first pass

原因：

- 这是后续一切 cleanup 的基础

### Slice B

- TC3 mirror inventory + demotion pass

原因：

- 先知道哪些 mirror 还有 recovery value，再删

### Slice C

- TC4 optional-backend true detach

原因：

- 这一步应该建立在前两步已经减少 transition coupling 的基础上

---

## 8. 验收标准

Transition cleanup 第一轮关单前，至少满足：

1. runtime extension 重启后，delegated sticky / control policy continuity 仍存在
2. observer / queue / detail / retrieve 对同一任务不再出现状态冲突
3. 新任务默认不依赖 `legacy mirror only`
4. optional backend 关闭时，默认主链不表现成 degraded
5. macmini 上至少一轮：
   - runner task
   - spawn_single task
   - observe-once / detail / retrieve
   - patrol-once
   都能在新 contract 下通过

---

## 9. 实现前的额外约束

- 先做 inventory / contract，再做删除
- 不在同一拍里同时重写 policy durability、mirror cleanup、backend detach 全部逻辑
- 每一刀都要带 targeted tests
- runtime hot path 优先 Node.js / JS；Python 继续承担 compatibility / offline / analysis glue

一句话：

> **transition cleanup 不是“继续打补丁”，而是把 current baseline 从过渡架构收成低维护架构。**
