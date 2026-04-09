# OctoClaw 主设计底稿

> 状态：当前 canonical 设计底稿（2026-04-08，router/model-intel 深化已纳入）
> 用途：给维护者自己后续开发、重构与取舍判断使用，而不是面向外部协作者的市场化介绍文档。  
> 相关文档：[`octoclaw-execution-plan.md`](./octoclaw-execution-plan.md)、[`octoclaw-transition-cleanup-design.md`](./octoclaw-transition-cleanup-design.md)、[`archive/design-notes/README.md`](./archive/design-notes/README.md)

---

## 1. 这份文档现在要解决什么问题

OctoClaw 的问题已经不再是“方向是否成立”，而是：

1. **设计真相源分散**：产品设计、复盘、taskflow 迁移、展示层、状态机、借鉴笔记都各自有价值，但没有一份文档把“哪些已经落地、哪些仍是缺口、哪些只保留历史价值”说清楚。
2. **近期实现推进很快，文档容易落后**：尤其是 2026-04-02 到 2026-04-03 的提交已经把 runtime observer、taskflow substrate、reply review、replay validation、IM thread truth、task anchors、resume persistence 推进到了“基础可用”阶段。
3. **旧文档里的一些主题仍然有效，但不能再按原来的优先级理解**：比如反馈闭环、IM 适配、展示层、artifact retrieval 不是“未来才开始做”，而是“已经落地第一拍，下一步应该做深、做统一”。

这份文档的目标，是把当前代码与旧设计重新对齐，给后续开发提供一个基于**现状**而不是基于**旧路线假设**的判断底稿。

---

## 2. 当前一句话定义

> **OctoClaw 是 OpenClaw 之上的执行面调度层、成本控制层、反馈闭环层和可观察控制层。**

这里特意把“反馈闭环层”补回来，因为当前代码已经不只是 route/dispatch/status：

- 有 replay log、summary、review、curate、automation
- 有 nightly reply review / replay validation / learning log
- 有 route diff / policy diff / promotion hints / eval fixture export

也就是说，OctoClaw 已经开始具备“观察 → 复盘 → 提炼 → 调整”的基础闭环，而不是只有静态策略。

---

## 3. 它不是什么

OctoClaw **不是**：

- 一个独立于 OpenClaw 的通用多 Agent 平台
- 一个只做模型打分的 router
- 一个完全依赖长期常驻 swarm 才能运行的 runtime
- 一个只在终端里可见、没有 IM 与多表面适配能力的内部脚本集合

换句话说，它不能被缩减成“只剩 observer + taskflow substrate”，因为这会丢掉已经落地的：

- replay/review/eval feedback loop
- IM/session/thread/task-anchor 适配层
- notification / channel rendering / task action surface

---

## 4. 当前架构边界

### 4.1 OpenClaw 负责 substrate facts

OpenClaw 继续是 runtime substrate，负责：

- detached task / flow 事实层
- 任务基础生命周期与回到 session 的基线能力
- node / gateway / extension / tool 接入面

### 4.2 OctoClaw 负责四类增量能力

OctoClaw 当前真正负责的是四层增量：

1. **Policy layer**
   - route decision
   - worker_pool / work_type / phase / profile / model policy
   - review / budget / delivery policy

2. **Control / observer layer**
   - status / details / timeline / graph / retrieve / queue / ctl
   - runtime observer
   - patrol-based recovery and visibility

3. **Feedback loop layer**
   - replay logging / replay summary / replay review / replay curate
   - nightly replay automation
   - nightly reply review / validation
   - eval fixture export / learning log / promotion hints

4. **IM / display adaptation layer**
   - session-thread truth
   - task anchors
   - channel-specific notification rendering
   - task action fallback commands
   - text/rich dual rendering surface

这四层合在一起，才是当前代码里的 OctoClaw，而不只是其中某一层。

### 4.2.1 Router core 应设计成可抽离子系统

虽然 OctoClaw 不是“一个只做模型打分的 router”，但这不代表 router 核心不应该被设计成可拆出。

当前更合理的方向是：

- **OctoClaw 继续是完整系统**
  - policy / control / observer / feedback / IM-display adaptation
- **其中 router core 则刻意收成可抽离子系统**
  - 未来可以独立为一个更通用的 Auto Router 项目
  - 目标形态可以接近 OpenRouter Auto 模式的开源实现

这个可抽离 router 的边界，建议明确分成 5 层：

1. **Signal layer**
   - task_type
   - complexity
   - language
   - tool_need
   - risk_level
   - context_size

2. **Router core（V2-style）**
   - rules
   - semantic route
   - optional tiny judge
   - 不直接绑死某个 provider 或某个 runtime

3. **Budget planner（R2-style）**
   - 选择 `(model, output_budget)`，而不是只选模型
   - 预算与质量/成本一起进入目标函数

4. **Policy / gateway adapter**
   - provider 偏好
   - latency / cost / privacy policy
   - fallback chain
   - OpenAI-compatible response surface

5. **Model-intel / auto-update**
   - price refresh
   - capability profile refresh
   - health / cooldown refresh
   - telemetry-fed policy updates

这里最重要的不是“现在就把它拆仓”，而是：

> **先把接口边界做对，让 OctoClaw 内部的 router 核心未来可以被单独开源。**

这条判断也符合外部参考的现实：

- NVIDIA 的 LLM Router v2 更接近“intent-based + auto-routing”的推荐器，返回推荐模型名，而不是替代整套执行系统
- R2-Router 的研究重点则是联合选择 `(LLM, token budget)`，非常适合作为 budget planner 的设计参考

所以对 OctoClaw 来说，正确吸收方式不是“把整个系统做成一个神奇黑盒 router”，而是：

- **把 router core 设计成可拆**
- **把完整 runtime / observer / IM / feedback 继续保留在 OctoClaw 内部**

当前 internal-first baseline 已落地到：

- `lib/auto_router.py`
- `octoclaw_policy.build_decision().auto_router`
- route recommendation seam
- delegated pre-dispatch ack baseline

`2026-04-08` 的 P2.5 closeout 之后，这条线已经进一步收成：

- `route recommendation` / `budget recommendation` / `route outcome` 三个正式 contract
- delegated lanes 对 recommendation 的实际消费
- replay / review / curate / summary 的 route outcome 可见性
- final resolution baseline 对 `health / quota / queue pressure / runner capacity` 的结构化记录
- extractable readiness baseline + packaging prep baseline

因此现在更准确的表述是：

> **P2.5 baseline 已完成；后续 router 线进入 RM 深化，而不再是“补齐第一拍”。**

P2.5 的正式设计与执行清单见：

- [`octoclaw-auto-router-design.md`](./octoclaw-auto-router-design.md)
- [`octoclaw-auto-router-implementation-checklist.md`](./octoclaw-auto-router-implementation-checklist.md)
- [`octoclaw-auto-router-boundary-map.md`](./octoclaw-auto-router-boundary-map.md)

### 4.3 Operator backend 是增强层，不是默认运行面

ClawTeam、tmux workbench、programmatic tool execution 都属于增强层。当前代码方向已经很明确：

- ClawTeam 仍有参考价值
- tmux 仍可作为 operator workbench
- 但默认真相源越来越偏向 OpenClaw substrate + OctoClaw 自己的 control/feedback/display surface

这意味着：

> **OctoClaw 现在的核心竞争力，不是“能不能借一个重 runtime”，而是“能不能把 policy、feedback、IM、observer 这些系统层做成一套可持续演进的产品心智”。**

### 4.4 当前稳定性 operating mode

近期稳定性问题说明，OctoClaw 不能继续让多条运行路径都像“半主链路”一样并存。当前更合理的 operating mode 应明确为：

1. **OpenClaw managed TaskFlow 是主状态源**
   - `running / done / failed / cancel` 这类 substrate facts 优先相信 native task / TaskFlow
   - 本地 mirror / task-state 主要承担 cache、binding、display adaptation，不应继续和 substrate 并列争抢真相

2. **runtime event / handoff 是主回推链路**
   - delegated task 正常完成后，应优先通过 runtime event / handoff 回到当前会话
   - 但产品语义必须是“异步 SLA”，不是“强实时保证”
   - 如果 anchor / announce 未成功，应清楚回退到 `details <task_id>` / `queue` / status surface，而不是假装马上会回来

3. **patrol 是补偿与告警层，不是主生命周期引擎**
   - patrol 可以做 detect / notify / reconcile / observer 视角补偿
   - patrol 不应继续默认承担 auto-redispatch、强行收口、暗中修复这类主流程职责
   - 特别是在 detect-only mode 下，patrol 应避免把“后台补救”伪装成“稳定主链路”

4. **tmux / ClawTeam / runner 属于执行层，不是状态真相源**
   - 它们可以继续作为 operator backend 与执行面
   - 但任务状态、完成感知、父子关联仍应收敛到 native TaskFlow + runtime event

5. **入口约束要以 runtime mode 为主，而不是堆低层开关**
   - 对维护者而言，首要心智应是 `conservative / guided / enforced`
   - `before_tool_call`、`delegation_enforcement`、`route_hint_required` 这类低层 switches / hooks 更适合作为 override，而不是让操作者逐个记忆
   - 当前默认 operating mode 更适合落在 `guided`：非 direct 请求默认走 dispatch，但保留必要的降级和观察面

---

## 4.4 运行时角色图（P1 约束）

P1 之后，运行时角色应固定成下面这张表：

| 角色 | 定义 | 是否只读 | 是否主动干预 |
|---|---|---:|---:|
| `observer` | 统一 runtime snapshot producer | 是 | 否 |
| `status` | observer 的文本/表格/anchor 视图 | 是 | 否 |
| `patrol` | scheduled supervisor / reconciler / notifier | 否 | 是 |
| `runner` | 轻任务执行 lane | 否 | 是 |
| `daemon/ondemand` | runner 的 execution mode，而不是新的 lane | n/a | n/a |
| `ctl` | operator control entrypoint | 否 | 是 |

这张角色图必须在 docs / code / CLI 中保持一致。

---

## 5. 当前已经落地到什么程度

这部分是对旧设计文档最重要的校准。

### 5.1 substrate / observer / continuity：已到基础可用

以下方向不是空白，而是已经落地了第一拍：

- `aedaffc` — runner jobs 进入 taskflow-bound tasks
- `8b9510b` — native taskflow control metadata
- `d963dfa` — session resume context persistence
- `ec335e8` — runtime observer + on-demand runner fallback
- `e9bf47b` — patrol observation pass 与 on-demand runner mode 收口
- `17abf08` — unified `octoclawctl` control entrypoint

配套代码/测试包括：

- `lib/openclaw_taskflow_adapter.py`
- `lib/runtime_observer.py`
- `lib/session_resume.py`
- `tests/test_openclaw_taskflow_adapter.py`
- `tests/test_runtime_observer.py`
- `tests/test_session_resume.py`

所以现在不能再把“taskflow substrate 接入”“observer 基础层”“resume continuity”写成纯未来事项。

### 5.2 反馈闭环：已不是概念，已经有 baseline

你提到的“反馈闭环”我之前写轻了，这次需要纠正。

当前代码里已经有完整的 baseline：

- replay 事件：`runtime-policy-replay.jsonl`
- 汇总：`lib/replay_summary.py`
- review：`lib/replay_review.py`
- curate：`lib/replay_curate.py`
- automation：`lib/replay_automation.py`
- reply/delegation review packet：`lib/reply_review_packet.py`
- replay validation：`lib/replay_validation.py`
- eval fixture export：`lib/eval_fixture_export.py`
- learn/error promotion：`lib/learning_log.py`、`lib/nightly_error_review.py`
- rollout promotion hints：`lib/runtime_policy_rollout.py`

配套测试也已经存在：

- `tests/test_replay_review.py`
- `tests/test_replay_automation.py`
- `tests/test_replay_summary.py`
- `tests/test_replay_curate.py`
- `tests/test_runtime_policy_replay_schema.py`
- `tests/test_reply_review_packet.py`

这说明当前更准确的说法应该是：

> **反馈闭环已经从“要不要做”进入“怎么把各条闭环统一成一个更稳的学习系统”。**

也就是说，问题不是从 0 开始补 feedback loop，而是：

- 现在 replay / review / nightly review / validation / learning promotion 已经有了
- 但还没完全收成一个清晰的“观察 → 判断 → 提升 → 回归验证”的统一产品面

### 5.3 IM 适配：也已经落地第一拍，而不是还没开始

你指出“IM 的适配”被我写没了，这个判断是对的。

当前代码里已落地的 IM / channel / anchor 基础包括：

- session-thread binding map
- anchor send / edit / fallback send
- task notification payload by backend
- Slack / Feishu / Telegram / Discord / WhatsApp 等适配分支
- task action fallback commands（details / queue / artifacts / retrieve / graph / timeline / explorer / stop / retry / approve / reject）
- text fallback + rich payload 并存

主要代码：

- `lib/im_thread.py`
- `lib/notifier.py`
- `lib/task_display.py`
- `lib/task_anchor_commands.py`
- `lib/session_ops.py`

主要测试：

- `tests/test_im_thread.py`
- `tests/test_notifier.py`
- `tests/test_task_display.py`
- `tests/test_task_anchor_commands.py`
- `tests/test_task_events.py`
- `tests/test_patrol_notifications.py`

当前 P3/P4 的正式交互与显示 contract 已收口到：

- [`octoclaw-im-display-contract.md`](./octoclaw-im-display-contract.md)
- [`octoclaw-p3-p4-post-signoff-handoff.md`](./octoclaw-p3-p4-post-signoff-handoff.md)

这意味着旧文档中关于：

- IM-native 展示层
- channel capability matrix
- thread/topic binding
- anchor-first task presentation

并不是“过时到可以忽略”，而是：

> **很多已经进入基础实现，但还没有完全收口成一份更稳定的产品化描述。**

2026-04-06 之后，这条线已经进一步进入：

- **P3 signoff 已完成**
- **P4 closeout 已完成**

但这里的 signoff 语义是：

- P3 的 surface ownership / interaction contract 已冻结
- P4 的 native-preferred posture / cleanup policy / substrate display contract 已冻结
- 并且这次 closeout 已把以下表面推进到新的稳定状态：
  - `display = substrate_first`
  - `retrieve = substrate_first`
  - `observer = evidenced_substrate_aware`
  - `review = evidenced_substrate_aware`

这次判断基于 **OpenClaw 2026.4.5** 已发布源码里的 TaskFlow/runtime 语义：

- operator first read = `flow/task target`
- 然后是 `taskSummary` / `wait` / `blocked` / linked child task health
- artifacts/report/context 是补充面，不应反向主导 substrate truth

### 5.4 artifact/retrieve/display surface：已不是未来设想

当前不是只有 task-state 和脚本：

- `details / timeline / graph / retrieve / explorer / queue`
- operator surface
- task anchor text/slack payload
- artifact index / related thread artifacts / context pack / resume snapshot

这些都已经是产品表面的一部分。

所以“展示层”现在的真实状态应定义为：

- **CLI / text-first operator surface：已基础可用**
- **IM anchor / thread / fallback interaction：已基础可用**
- **Web/UI cockpit / richer capability matrix parity：仍在后续主战场**

P3/P4 signoff 之后，后续主线不应再回头重写 capability matrix。

当前这些 surface 已完成本轮收口：

- `display` 已 substrate-first
- `retrieve` 已 substrate-first
- `observer` / `review` 已有明确 substrate-aware surface

后续不再把它们当作未完成例外面，而是把更深的 substrate-only hardening 放到 P5/P6。

---

## 6. 当前执行模型

### 6.1 四条 lane 仍然成立

仍然是：

- `direct`
- `runner`
- `spawn_single`
- `spawn_multi`

但 route 的意义应继续从“任务像什么”收敛到“执行合同选择”：

- 是否需要 durable runtime
- 是否需要 artifact-first 结果
- 是否需要 review / merge / handoff guardrail
- 是否值得 multi-worker 协同

### 6.2 runner 的当前定义要更精确

runner 不是单纯“长期常驻快腿”，而是：

> **轻任务执行 lane + 可以常驻也可以 on-demand 的执行器形态。**

这点必须和最近提交对齐，否则会误判很多已完成工作。

### 6.2.1 runtime role map（P1 收口后的统一定义）

为避免后续文档和代码继续混用，P1 统一采用下面这组定义：

- **`runner`**：轻任务执行 **lane**
- **`daemon|ondemand`**：runner 的 **execution mode**
- **`observer`**：只读 runtime snapshot producer
- **`patrol`**：scheduled supervisor / reconciler / notifier
- **`ctl`**：operator control entrypoint
- **`status`**：observer 的文本视图，而不是独立世界观

这组定义意味着：

- 不能再把 `runner` 直接等同于常驻进程
- 不能再把 `observer` 和 `patrol` 当同一个角色
- 不能再让 `status` 在展示层偷偷修改 runtime 事实
- 不能再让 `ctl` 维护自己的平行状态心智

### 6.3 observer 也不是唯一主线

我上次把 observer 线写得太重，导致挤掉了 feedback loop 和 IM adaptation。现在更准确的表达应该是：

- observer 是一条核心收口线
- 但它要和 feedback loop、IM/display、substrate binding 一起看
- 不能把系统缩减成“observer-only 架构”

---

## 7. 当前应坚持的设计原则

### 7.1 workflow-first，agent-second

默认先问 workflow 是否足够，只有必要时才上更重的 agent coordination。

这也意味着像“你现在是啥模型”“刚才是不是子任务做的”“这次有没有走 dispatch”这类 workflow/session provenance 元问题，
默认应留在主会话的稳定 `control_observer` / direct scope，而不是升格成新的 delegated run。

### 7.2 policy-first，而不是 prompt-first

委派、review、lane selection、budget choice 必须先是系统行为。

### 7.2.1 误判治理要先收系统边界，再谈小模型

当前误判高，优先不应该理解成“语义模型太弱”，而应该先检查三件事：

- protected lanes 是否定义清楚
- `contract -> lane` 的默认边界是否稳定
- Python / JS / 运行副本是否在同一代 contract 上

因此更合理的治理顺序是：

1. 先收 protected lanes
   - `control_observer`
   - `session_control`
   - workflow/session provenance
   - task action / queue / details / status
   - current-model / route / dispatch provenance
   - current-session model switch / current-session control mutation
   - model / fallback / workflow metadata query
2. 再补 goldens / parity / replay regression
   - 先把高频误判收成 durable cases
   - 让 Python / JS / macmini 运行副本对齐
3. 最后才给模糊样本接 tiny judge
   - 只做歧义裁决
   - 不做默认前置依赖

同时，protected lanes 不应继续以“想到一个坏例子就补一条 regex”的方式演化。
更稳定的做法是把它们当成一个小而硬的 taxonomy：

- `control_observer`
- `session_control`
- 后续如果新增，也必须满足：
  - 先在设计文档里说明 contract
  - 先补 golden case
  - 先进入 replay / nightly diff
  - 再允许进入运行时

这样新增 protected lane 就不是临时补丁，而是一次受约束的 contract 扩展。

换句话说：

> **误判治理首先是 contract-first / boundary-first 的系统工程，不是先上一个更聪明的小模型。**

### 7.2.2 路由应先看 contract / capability / scope，再看 lane

像最近这批 bad case，表面上看分别是：

- 测速
- 查版本
- 读代码
- 查状态 / 谁做的 / 有没有 dispatch
- 切当前 session 模型

但更高一层看，它们并不是五个需要各写规则的 case，而是同一个系统问题：

> **当前运行时仍然过于 route-first，而不是先明确 contract、capability 和 scope，再选择 lane。**

更稳定的抽象应是：

1. `contract`
   - 用户真正要的交付是什么
   - 例如：`answer_now`、`inspect_report`、`probe_measurement`、`session_control`、`implement`、`review`
2. `capability`
   - 当前系统是否真的具备完成这个 contract 的能力
   - 例如：只读 inspect、外部查询、artifact/report、精确计时、session-local mutation、multi-worker orchestration
3. `scope`
   - 这个动作作用在哪一层
   - 例如：`current-session-only`、`runtime-read-model`、`workflow-local`、`delegated-worker-doable`
4. `lane`
   - 在 contract / capability / scope 都明确后，才选择 `direct / runner / spawn_single / spawn_multi / session_control`

这意味着系统不应继续默认：

- 先给 `runner / spawn_single / spawn_multi`
- 再在执行阶段发现 lane 没能力完成
- 然后靠主 agent 口头解释、补救或绕路

更合理的原则应是：

- 先判断 contract
- 再检查当前可用 lane 的 capability feasibility
- 最后从可行 lane 里选延迟 / token / 交互成本最优的那个

若当前根本没有满足该 contract 的能力，系统应直接返回 capability-bound explanation，
而不是误派、误答、误解释。

测速只是这个框架下的一个例子：

- contract：`probe_measurement`
- scope：通常不是 `current-session-only`
- 关键 capability：精确计时、稳定 probe、统一结果格式

因此“测试 MiniMax 和 GLM-5.1 的首 token / 吞吐速度”这类请求，不该再被理解成一个单独特例，
而应被看作 `probe_measurement` contract 的一个实例。

当前更准确的产品语义应是：

- 默认先走 `runner + inspect_report`
- 读取本地 `model-speed / model-health / model-benchmarks`
- 若用户明确要求实测，再升级到专门 benchmark workflow
- 若 live benchmark workflow 尚不存在，系统应诚实说明“当前只有 snapshot，没有 live benchmark”，而不是把 generic subagent 说成天然做不到

同样，主会话 fallback 中真实发生过的 `timeout / auth / failover` 也不应只留在 OpenClaw 日志里。
它们应以受控、stale-gated 的方式回灌到 OctoClaw `model-health`，帮助后续 capability-aware lane selection 避开已知坏链路。

这条反馈线的约束也必须和现有设计保持一致：

- 允许回灌 `model-health`
- 不默认打开 `direct_model_override`
- 不因为这一拍就把主会话模型 silently 改掉

### 7.2.3 nightly 必须覆盖 direct path，而不只看任务失败

如果 nightly 只分析 delegated task failure，就会漏掉大量 casual bad case：

- direct path 慢回复
- protected lane 被错误解释成委派
- session-control / control-observer 的错误口径
- fallback / 漂移造成的用户困惑

因此 nightly 至少要覆盖两层：

- 结构层：replay / failure / protected-lane misroute
- 语义层：reply review，重点看 direct path、protected lane、session-control 的解释质量

这也意味着 nightly packet 不应只挑“长 prompt / 重任务”，还要显式优先：

- short protected-lane prompts
- direct path slow replies
- delegation explanation risk

### 7.2.4 当前主要风险不是“设计思想错了”，而是运行时偏离了既有设计

最近一批 bad case 暴露出来的核心问题，更像是运行时 drift，而不是设计方向本身错误：

- `hard_runner_only` / protected lanes 在持续加硬
- 但 `route_hint`、sticky lane、follow-up continuity 没有同样收稳
- `runner` 有时只是 route label，没有真正变成稳定 workflow
- entry-level ack 仍然没有完全独立于 dispatch hot path
- 主会话解释层有时会脱离真实 policy / snapshot，自行脑补 route 和状态

因此当前不应把问题简单归因为：

- `workflow-first` 错了
- `policy-first` 错了
- 应该回退到“主 agent 每轮完全自由裁决”

更准确的判断是：

> **设计方向是对的，但当前实现没有真正跑在“硬边界少而硬 + continuity 稳定 + 灰区 route hint / judge”这套设计上。**

这也解释了为什么早期只靠 `SKILL.md / AGENTS.md` 注入的体验，体感上可能更顺：

- 行为更简单
- 入口更一致
- 先应答再执行更容易做到

但那种顺滑主要来自“简单一致”，不是因为它更适合作为长期的 runtime truth / feedback / substrate 收口方案。

因此更系统的修法不是回退到“让主 agent 每轮自由判断”，而是把既有设计补完整：

1. 保持极窄的系统硬边界
   - `hard_runner_only`
   - protected lanes
2. 恢复 follow-up continuity
   - sticky lane / active workflow continuity
3. 把 `runner` 真正收成 workflow harness
   - 不再只是 route label
4. 保留灰区裁决
   - `route_hint`
   - 或后续 tiny judge
5. 让执行层、解释层、nightly review 围绕同一份 policy/snapshot truth

换句话说：

> **系统性修复的重点应是“恢复 continuity 与 workflow realization”，而不是继续堆更多零散规则。**

这里还需要明确一条执行边界：

- 主 agent **可以**纠偏 `system_preferred_route`
- 但纠偏方式应是提交结构化 `route_hint`
- 主 agent **不应**在执行阶段直接绕过 runtime enforcement，自己把 `runner / spawn_single / spawn_multi` 临时改成 `direct`

也就是说：

> **主 agent 应有“灰区纠偏权”，但不应有“执行层绕路权”。**

这条边界尤其适用于：

- `spawn_single / spawn_multi` 在灰区被误判
- 但主 agent 能基于 capability / continuity / session-local 约束判断 delegated path 并不合适

正确做法应是：

1. 系统先给出 `system_preferred_route`
2. 主 agent 仅在非 hard gate 灰区给出 `route_hint + reason`
3. runtime merge 后再执行最终 lane
4. replay / nightly 记录 route drift 与 override reason

而不是：

- 先判成 `runner` / `spawn_single`
- 再由主 agent 偷偷直接调用通用工具
- 事后再口头解释说“我觉得 direct 更好”

### 7.2.5 主 agent 的洞察应被提升成 capability-aware routing，而不是更大自由裁决

最近聊天里，主 agent 有几类观察其实方向是对的：

- 有些操作是 `current-session-only`
- 有些失败不是“router 错了”，而是 capability 缺失
- 不能把每一轮都重新交给主 agent 重判，否则会伤速度和 token

这些洞察值得保留，但不应继续停留在：

- “主 agent 能不能做”
- “子 agent 能不能做”
- “规则和自由谁更重要”

更稳的提升方式是把它们收进 `contract / capability / scope / lane`：

- 改当前 session 模型
  - `contract = session_control`
  - `scope = current-session-only`
  - 只有 session-control lane 可行
- 查状态 / 谁做的 / 有没有 dispatch
  - `contract = control_observer`
  - `scope = runtime-read-model`
  - 应走 protected lane，而不是 generic delegated lane
- 查版本 / 发布 / 新特性
  - `contract = inspect_report`
  - 关键 capability 是外部只读查询与快速收口
  - 更适合 `runner`
- 读代码并给结论
  - `contract = inspect_report`
  - 是否 direct / runner 取决于 bounded inspect capability、预估代码面和延迟预算
- 实测 TTFT / throughput
  - `contract = probe_measurement`
  - 需要 measurement capability；若该 capability 不存在，就不该硬派 generic subagent

因此后续不应再围绕“是否给主 agent 更多自由”讨论，而应围绕：

- 当前请求是什么 contract
- 哪些 capability 真正存在
- scope 是否允许 delegated worker 执行
- 在可行 lane 里哪个成本最低、体验最好

这样既能保留主 agent 在灰区的语义优势，又不会退回到“每轮都让主 agent 自由裁决”的旧路径。

### 7.3 substrate-first truth

执行事实尽量绑定 OpenClaw substrate，OctoClaw 在其上叠加策略语义、反馈语义和展示语义。

### 7.4 artifact-first，event-first，state-first

长结果、回放、review、任务恢复都不应继续依赖原始 transcript。

### 7.5 feedback-first operations

系统必须允许：

- replay 观察
- nightly review
- validation
- learning promotion
- rollout promotion heuristics

这些能力已经存在，后续设计应围绕“怎么统一和深化”而不是“有没有必要做”。

### 7.5.1 统一 feedback loop phase model

P2 收口后，反馈闭环默认采用这条主链：

```text
observe -> summarize -> review -> curate -> validate -> promote -> learn
```

其中：

- `replay_summary` 属于 summarize
- `replay_review` / `reply_review_packet` 属于 review
- `replay_curate` 属于 curate
- `replay_validation` / `eval_fixture_export` 属于 validate
- `runtime_policy_rollout` 属于 promote
- `learning_log` / `nightly_error_review` 属于 learn

关键约束：

- promotion 不能直接吃原始 replay 噪音
- validate 是进入 promote 的门槛
- learn 和 promote 分层，不变成自动改策略黑箱
- nightly 产物要能通过统一 manifest 串起来

### 7.6 IM-native but surface-adaptive

OctoClaw 不应该只做终端体验，也不该试图把所有 IM 强行做成同一种 UI。

更合理的原则是：

- 统一 common data model
- channel-specific rendering
- rich when possible, text fallback when necessary
- IM 做 lightweight ops，full cockpit 留给更强的 control/UI 面

### 7.7 Router extraction should be interface-first

如果后续真的要把 router 单独开源，必须坚持：

- 先抽接口，再抽仓库
- 先稳定 signal / route / budget / model-intel schema，再谈 provider 泛化
- 先做到 OpenAI-compatible recommendation API，再决定是否要兼做 proxy

换句话说：

> **“可抽离”是当前设计目标；“立刻拆出去”不是当前主线。**

### 7.7A Model-Intel should be a generated facts plane

`model-intel` 的正确形态，不是 runtime 热路径里顺手拼出来的 provider 事实，而是：

- source-attributed
- generated artifacts
- stale-tolerant
- last-good recoverable

这层最值得借鉴的是：

- `models.dev` 的 schema-first registry
- OmniRoute 的 external sync / stale-if-error / catalog builder 分层

同时必须坚持：

- `OpenRouter rankings` 只作为低权重生态信号
- 免费模型要过滤或显式降权，不能污染 paid auto-routing
- 本地 truth
  - `openclaw_live_compat`
  - runtime health / cooldown / quota
  仍高于外部目录与榜单

### 7.8 Harness should be layered, not monolithic

参考 OpenHarness、DeerFlow 这类项目，OctoClaw 确实值得把 `harness` 当成一级设计对象。

它们给 OctoClaw 最值得借的点是：

- harness 不是“若干脚本”，而是显式的产品层
- tool / skill / memory / artifact / eval 都应有清晰归属
- 长任务 durability、artifact-first、progress surface、eval discipline 应被视为基础设施

但 OctoClaw 不应直接照搬它们的默认重量：

- 不把所有请求都送进一个重型 super-agent harness
- 不把 LangGraph 风格重 orchestration 当成默认主路径
- 不为了“像 harness”而新增另一套并行 runtime

更具体地说，参考项目的借鉴边界应明确如下：

| Project | Borrow | Don't Borrow |
| --- | --- | --- |
| OpenHarness | 把 harness 当一级产品层；把 tool/skill/memory/artifact/eval 的 ownership 讲清楚 | 不把 OctoClaw 扩成另一套通用 agent infra；不引入新的并行 runtime |
| DeerFlow | durability、checkpoint、artifact/state/replay 作为基础设施的意识 | 不把 graph orchestration / planner-team-reporter 变成默认主路径 |
| OpenHands | dev-task runtime、ACI、评测基础设施的产品化表达 | 不把 OctoClaw 主线收成“软件工程 agent 产品” |
| PydanticAI | typed contract、output/tool validation、eval discipline | 不为 typed schema 做大规模框架迁移 |
| AutoGen | 多层 architecture 的表达方式；team/bench 的边界意识 | 不默认走重 orchestration、多 agent team 作为主姿势 |

借鉴的节奏也应保持克制：

- 先读公开设计/README，对齐方向和边界
- 真正落具体 contract 时，再定点读局部源码
- 不因为“参考项目做了”就先引入对应 runtime 形态

更适合 OctoClaw 的做法，是把当前已经存在的能力正式收成三层：

1. **runtime harness**
   - `route / policy / dispatch / brief / summary / artifact / review gate / substrate-aware state`
   - 目标是让 workflow-first 的轻量执行协议默认存在
2. **workflow harness**
   - 面向特定 workflow 的标准化执行骨架
   - 例如：runner playbook、model telemetry、benchmark/inspect workflow、future review workflow
3. **evaluation harness**
   - `eval_suite / replay_validation / reply_review_packet / nightly_reply_review / failure_summary`
   - 目标是让 replay、review、validation、nightly 成为统一反馈面

这个分层不是新 runtime，而是对现有实现的命名、归类和 contract 收口。
也就是说：

- 先明确哪些文件和流程属于哪一层
- 先统一 `brief / result / artifact / event / eval outcome` 这些 contract
- 再要求新功能必须落到三层之一

而不是先做一次大规模迁仓或重构。

如果这件事做对了，agent 的效率和 token 成本也会一起下降：

- brief 代替长 transcript
- summary + artifact 代替全量回灌
- protected lane 默认走 lightweight runtime harness
- 测速、日志、状态类问题优先走 workflow harness，而不是现场让 agent 现想流程
- replay/nightly 通过 evaluation harness 主动暴露坏例子，减少靠用户追问才发现问题

这也意味着，`protected lanes` 不应继续靠“想到一个坏例子就补一条 regex”前进。
更系统的做法是：

- 先明确它属于哪一层 harness
- 再明确它属于哪种 contract
- 再补 golden case / replay diff / nightly review
- 最后才考虑是否需要 cheap judge 或局部小模型裁决

P5F 的 canonical artifact 现在应以两份文档为准：

- `docs/octoclaw-harness-ownership-map.md`
- `docs/octoclaw-harness-contract-inventory.md`

### 7.9 Completion relay and observer snapshot should replace ad-hoc status guessing

P4/P5 进入当前阶段后，OctoClaw 不再适合继续把 `patrol` 或主 agent 的经验性判断当成任务状态入口。

更稳的职责边界应当是：

- OpenClaw native task / managed TaskFlow = execution truth
- `task-state` = OctoClaw projection / metadata store
- `task-events` = transition log and delivery hints
- `runtime_snapshot` + `observe_runtime_read_model` = unified read model
- completion relay = task 完成后立即把 projection / event / notifier 串起来
- `patrol` = detect / reconcile / retry，退出关键路径

这意味着：

- 不是再新造一套 snapshot 层，而是把现有 `runtime_snapshot.py` / `observe_runtime_read_model` 扶正成唯一读面
- 任务 `running / done / blocked / failed / handoff_ready` 的展示与解释，要优先相信 native/projection/event 合成后的 read-model
- 主 agent 在回答 “queued 了吗 / 跑了没 / 完成没 / 谁做的” 这类问题时，必须 grounding 到该 read-model，而不是沿用历史话术
- 这类 protected-lane 问题的最佳实现不是“提醒 agent 自己先查”，而是由 runtime 在 `before_prompt_build` 里自动预取最小 state grounding packet，再注入 prompt
- 若同一 turn 刚成功触发 delegated dispatch/spawn，runtime 应把该 `task_id` 写入当前 turn state，并在下一次 protected-lane grounding 中优先绑定这条 freshly-dispatched task，而不是退回“最近任务”猜测

非目标：

- 不把 `tmux` / runner / workbench 重新拉回状态真相源
- 不让 `patrol` 重新承担首次 completion 收口
- 不发明一套与现有 `runtime_snapshot` 平行的 observer 子系统

---

## 8. 当前仍存在的关键张力

### 8.1 实现上已经有多条闭环，但还没有一份统一的闭环产品叙事

replay、review、nightly automation、reply review、validation、learning promotion 都有了，但它们目前更像一组能力，而不是一个被文档明确命名的统一系统。

### 8.2 IM/display 已有 baseline，但 capability matrix 还没有产品级收口

anchor、thread binding、notification backend、task actions 已经存在；但：

- 不同 channel 的交互深度仍不完全对齐
- capability matrix 还主要存在于旧设计文档里
- Web/UI full cockpit 仍未形成统一后续路线

### 8.3 observer / runner / patrol / ctl 的职责虽然推进很快，但仍在收口中

这条线仍重要，但它应该被理解为“收口已落地 baseline 的系统层”，不是唯一未完成主题。

### 8.4 Python / Node/TS 的边界仍未最终收清

当前 Python 在 glue code、nightly review、taskflow/control-plane 里仍承担大量角色；要不要迁、迁哪些，必须建立在已经落地的真实行为之上，而不是抽象洁癖。

### 8.5 P5 的真正主题不是“加能力”，而是 runtime simplification

P4 收口之后，下一阶段不该再把主线理解成：

- 再补一个新 backend
- 再扩一套新的 operator workflow
- 再让 patrol / runner / status 各自长一套逻辑

P5 更准确的定义应是：

> **把已经能跑的 OctoClaw，收成更轻、更稳、更少历史包袱的正式 runtime。**

它的主目标不是能力扩张，而是四件事：

1. **observer 成为唯一 read-model truth producer**
   - `status / observe / detail / retrieve / review` 尽量围绕同一份 runtime snapshot / substrate-aware read model
2. **patrol 收成 recovery + notify coordinator**
   - patrol 负责 detect / reconcile / notify / bounded recovery
   - 不再暗中承担另一套主生命周期引擎
3. **runner 收成 lane，而不是常驻真相层**
   - `RUNNER_MODE=ondemand` 应成为默认心智
   - `daemon` 是 opt-in acceleration，不是系统成立前提
4. **ctl 成为统一 operator 入口**
   - 维护者默认通过 `octoclawctl` 观察、控制、诊断
   - 而不是记忆分散脚本和隐含守护进程关系

这条线和 P4 不同：

- **P4** 是 `substrate-first`
- **P5** 是 `runtime-first simplification`

这也意味着，P5 的实现原则应明确成：

- **基于 OpenClaw 2026.4.5 runtime / TaskFlow 语义继续收口**
- **runtime hot path 优先 Node.js / JS**
- **Python 更偏 offline analysis / nightly / calibration / compatibility glue**

如果 P5 做对，最终系统心智应变成：

```text
OpenClaw substrate
  -> native task / TaskFlow truth

OctoClaw runtime observer
  -> read-model / snapshot / text surfaces

OctoClaw patrol
  -> detect / reconcile / notify / bounded recovery

OctoClaw execution lanes
  -> direct / runner / spawn_single / spawn_multi
  -> runner defaults to ondemand, daemon is optional acceleration

OctoClaw operator control
  -> octoclawctl as the primary entrypoint

Optional heavy backends
  -> tmux / ClawTeam / workbench / resident runner
```

也就是说，P5 不该再创造一套新 runtime，而是要把当前 transition state 继续压缩掉。

### 8.6 P6 之后不再开新大题，而是进入 transition cleanup

截至 `2026-04-08`：

- `P4` baseline 已完成
- `P5` baseline 已完成
- `P6` baseline 已完成
- macmini 上的 `runner / spawn_single / observer / patrol` 实机验收已通过

所以后续主线不再是继续扩 P4/P5/P6，而是：

1. **先做 transition state 清理**
2. **再做 router / model-intel 深化**

这条深化线的 focused design 见：

- [`octoclaw-router-model-intel-deepening-design.md`](./octoclaw-router-model-intel-deepening-design.md)

这阶段的 focused design 见：

- [`octoclaw-transition-cleanup-design.md`](./octoclaw-transition-cleanup-design.md)

其中第一轮 transition cleanup 已在 `2026-04-08` 完成：

- durable policy state
- substrate-only read path tightening
- legacy mirror / fallback shrink
- optional backend true detach

所以当前更准确的下一步已经变成：

1. `router / model-intel` 深化
2. 仅在真实验收发现缺口时继续做更深的 substrate-only hardening

### 8.7 router / model-intel 深化的目标

这一段的目的不是“把 OctoClaw 变成另一个 OmniRoute”，而是把 `P2.5 internal-first seam` 做成真正可长期演进的子系统。

核心要收的不是 feature，而是三层：

1. **Model-Intel Facts Plane**
   - source-attributed catalog
   - pricing / capability / limit / freshness / status
   - health / cooldown / quota observation
2. **Router Recommendation Plane**
   - route + budget 联合 recommendation
   - lane-local consumption contract
   - regression / integration test
3. **Feedback Calibration Plane**
   - replay-driven eval
   - compatibility test
   - recommendation drift diagnostics

P2.5 closeout 完成后，router/model-intel 主线的下一步已经固定为：

1. `RM1/RM2`：facts plane / recommendation hardening
2. `RM3`：validation / rollout / calibration plane 深化
3. `RM4` 之后只继续做 extractable readiness / packaging，不提前拆 runtime adapter

后续继续深化时，外部参考的吸收边界也应固定：

- 借 `models.dev` 的 **schema-first / source-attributed / generated artifact**
- 借 OmniRoute 的 **外部 sync 分层、non-blocking sync、stale-if-error cache、统一 catalog builder**
- 不照搬 OmniRoute 的 combo/provider gateway 主心智

实施原则继续保持：

- runtime hot path 优先 Node.js / JS
- Python 继续偏 replay / eval / calibration / compatibility glue
- 不在这一步急着拆独立 router 仓库
- 不在这一步重做整个 runtime / cockpit

---

## 9. 文档分级结论（重新解释）

完整分级见 [`archive/design-notes/README.md`](./archive/design-notes/README.md)。

但这里需要强调一个关键修正：

- `octoclaw-product-design-v2-*` 和 `octoclaw-review-and-action-plan-*` 虽然不是当前 canonical docs，**但不是因为它们提到的很多事情没做，而是因为它们把“已落地 / 部分落地 / 未落地”混在同一条路线里，没有被最新代码状态重新切层。**
- 其中关于：
  - feedback loop
  - IM/display adaptation
  - task anchor / artifact / retrieve
  - replay / review / policy diff
  - economics / eval / learning loop

  这些主题并没有消失，而是需要被重新纳入当前 canonical 设计叙事。

---

## 10. 当前系统的更准确目标结构

```text
OpenClaw substrate
  -> tasks / flows / native control metadata / session return baseline

OctoClaw policy layer
  -> route / dispatch / model policy / budget / review / delivery policy

OctoClaw observer + control layer
  -> status / details / timeline / graph / retrieve / queue / ctl
  -> patrol / observer / runtime continuity

OctoClaw feedback loop layer
  -> replay / summary / review / curate / automation / validation / learning

OctoClaw IM / display adaptation layer
  -> session-thread truth
  -> task anchors
  -> channel renderers / notification adapters / fallback commands

Optional operator backend
  -> tmux workbench
  -> ClawTeam / heavier swarm runtime
  -> resident runner / programmatic execution helpers

---

## 10.1 P6 的设计意图

P6 不是“删除 tmux / ClawTeam / runner-daemon”，而是：

- 让默认路径的核心价值来自 substrate + policy + observer + feedback + display
- 让 heavy backend 只在显式启用时出现
- 让 operator surface 只把 backend 当 secondary hint，而不当 primary identity

P6 关单后，系统应默认呈现为：

- `runner lane`
- `spawn lane`
- `observer/control surfaces`

只有在显式启用 tmux / ClawTeam / resident runner 时，才暴露：

- optional workbench
- optional validation bridge
- optional acceleration backend
```

这比我上一次写的版本更接近当前代码现实。

---

## 11. 这份底稿的使用方式

以后如果你要判断一个改动是否值得做，优先问六个问题：

1. 它是在强化 substrate truth，还是又造了一套平行真相源？
2. 它是在收口 observer/control，还是又增加一条新的运行时心智分叉？
3. 它是在补强反馈闭环，还是让 replay/review/validation 更分散？
4. 它是在增强 IM/display 适配的一致性，还是让不同 channel 的行为继续各自漂移？
5. 它是在减少对重 backend 的刚性依赖，还是重新把系统绑回去？
6. 它对应的“当前状态”到底是未做、第一拍已做、还是应该进入收口/深化阶段？

如果答不上来，就先回到 [`octoclaw-execution-plan.md`](./octoclaw-execution-plan.md) 看新的阶段计划，而不是再按旧文档的相对优先级继续推进。
