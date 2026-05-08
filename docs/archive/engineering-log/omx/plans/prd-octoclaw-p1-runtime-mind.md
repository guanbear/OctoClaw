# PRD — OctoClaw P1: 统一 observer / patrol / runner / ctl 运行时心智

- Date: 2026-04-04
- Repo: `/Users/guanbear/workspace/OctoClaw`
- Scope type: brownfield, planning only
- Canonical context: `docs/octoclaw-design-foundation.md`, `docs/octoclaw-execution-plan.md`

## 1. Problem statement

OctoClaw 在 2026-04-02 ~ 2026-04-03 已经落地了 runtime observer、on-demand runner fallback、taskflow-bound runner jobs、session resume、统一 `octoclawctl` 等基础能力，但运行时心智仍然分散在多个面：

- `patrol.py` 既承担观察、恢复、通知、部分控制逻辑
- `runtime_observer.py` 是新的统一观察入口，但目前只是对 patrol 读模型做轻包装
- `runner-daemon.sh` / `runner_loop.sh` / `runner_dispatch.py` / `runner_queue.py` 同时包含“执行 lane”“后台进程”“队列状态机”“健康信号”四种角色
- `bin/octoclawctl.sh` 已经出现，但与 `status.sh`、`patrol.py`、runner shell loop 的职责边界还不够清楚

结果是：系统已经能跑，但维护者仍需要靠历史记忆来解释“谁才是运行时权威入口”。P1 的目标不是从零补功能，而是把这些已存在的 baseline 收成一套一致的运行时模型，让后续 P2/P3/P4 能在清晰边界上推进。

## 2. Desired outcome

在不推翻已有 baseline 的前提下，形成一套统一解释：

- **observer**：统一“观察 / 汇总 / 健康判断 / substrate-aware read model”的入口
- **patrol**：observer 下的恢复与通知执行器，而不是独立世界观
- **runner**：轻任务 execution lane；可 daemon，也可 on-demand；其状态必须统一进入同一 read model
- **ctl**：统一运维 / operator 控制入口，负责启动、停止、观察、单次巡逻、单次观察，不重复实现业务判断

并将代码结构、CLI 表面、文档与测试一起对齐到这套解释上。

## 3. Non-goals

- 不在 P1 内重写 feedback loop（那是 P2）
- 不在 P1 内重做 IM / display capability matrix（那是 P3）
- 不在 P1 内完成 Python→Node/TS 大迁移
- 不在 P1 内移除所有 legacy mirror/fallback，只要求把职责和默认真相源说清楚
- 不做“大爆炸式” runtime rewrite

## 4. Landed baseline vs gaps to close

### 已有 baseline（不要重做）
- `lib/runtime_observer.py` 已存在，且复用 `patrol.observe_runtime_state_once`
- `resolve_runner_mode()` 已支持 `daemon|ondemand`
- `runner_dispatch.py`、`runner_queue.py`、`runner_loop.sh`、`runner-daemon.sh` 已形成 runner lane 基本链路
- `bin/octoclawctl.sh` 已提供 `status|ps|up|down|restart|reload|patrol-once|observe-once|runner-status`
- `status.sh` 已读 runner health / replay summary / workbench state
- `patrol.py` 已承担 substrate-aware hydration、恢复、通知、runner 健康、部分控制协调

### 需要关闭的 gap
- 术语不统一：runtime / lane / daemon / observer / patrol / ctl 混用
- `runtime_observer` 仍是薄封装，未成为明确的只读汇聚层
- `patrol` 的“观察”和“恢复/通知”职责仍耦合很深
- runner 的“执行 lane”与“常驻进程形态”在文档和代码上容易被混淆
- `status.sh` 与 `octoclawctl` 的读模型边界尚未正式定义
- shell loop 与 Python control-plane 的责任分界不够显式

## 5. RALPLAN-DR summary

### Principles
1. **Do not re-plan landed baseline as missing work.**
2. **Separate read-model responsibility from write/recovery responsibility.**
3. **Treat runner as an execution lane first, daemon mode second.**
4. **Make ctl the operator entrypoint, not another hidden policy surface.**
5. **Prefer gradual convergence with compatibility shims over big-bang rewrites.**

### Decision Drivers
1. 降低维护者理解成本：任何人都能一句话解释 observer / patrol / runner / ctl 的关系。
2. 为后续 P2/P3/P4 提供稳定边界：反馈闭环、IM/display、substrate convergence 必须建立在清楚的 runtime 语义上。
3. 控制改动风险：尽量复用现有测试和入口，不用大规模重写已有运行链路。

### Viable Options
#### Option A — 文档优先 + 最小别名收口
- 做法：补文档、加少量注释/命名别名，保留现状结构。
- Pros：风险最低，推进最快。
- Cons：代码职责仍分散；后续 P2/P3 会继续踩边界混乱。

#### Option B — **读模型收口 + 运行职责分层**（推荐）
- 做法：定义 observer 为统一只读汇聚层；patrol 保留恢复/通知执行；runner 明确定义为 lane，并让 daemon/on-demand 成为 mode；ctl 收口 operator 命令入口；status 与 ctl 复用同一观察语义。
- Pros：与当前代码最贴合，能渐进演进，最能释放后续路线价值。
- Cons：需要跨 Python + shell + docs + tests 多点收口，短期协调成本较高。

#### Option C — 大一统 supervisor 重写
- 做法：重写 patrol/runner/ctl/status，统一成一个新的 runtime service。
- Pros：理论上最干净。
- Cons：高风险、回归面大、会重做已完成 baseline；不符合当前迭代节奏。

### Chosen direction
选择 **Option B**。

### Why not the others
- 不选 A：只修文档无法消除代码层职责漂移。
- 不选 C：当前不是缺功能，而是缺统一解释；重写会放大风险。

## 6. ADR

### Decision
采用“**observer 统一读模型、patrol 负责恢复/通知、runner 是 lane 且 mode 可切换、ctl 是 operator 控制入口**”的分层模型推进 P1。

### Drivers
- 当前 baseline 已足够支持渐进收口
- 需要兼顾现有 shell runtime 与 Python control-plane
- 需要为 P2/P3/P4 提供清晰边界

### Alternatives considered
- 仅补文档与命名别名：不足以支撑后续路线
- 重写统一 runtime：风险过高，不必要

### Why chosen
它既承认当前代码现实，又能把后续变化限制在“收口边界”而非“重建系统”。

### Consequences
- P1 会以“职责收口 + 读模型统一 + operator surface 一致化”为中心
- 一些现有文件仍保留，但角色会更明确
- 需要同步文档、测试和 CLI 语义，不能只改一个面

### Follow-ups
- P2 才正式统一反馈闭环
- P3 才系统化 IM / display capability matrix
- P4 才继续推动 substrate-first 清理

## 7. Detailed phased plan for P1 only

### Phase 1 — 建立 runtime role map（先定术语和责任表）
**Goal**
- 用一份明确的角色表固定 observer / patrol / runner / ctl / status 的关系。

**Outputs**
- `docs/` 内新增或补一份 runtime role map（可放到 canonical docs 或独立 supporting doc）
- 统一术语：
  - observer = 只读汇聚层
  - patrol = 恢复/通知执行器
  - runner = 轻任务 lane
  - daemon/on-demand = runner execution mode
  - ctl = operator control entrypoint
  - status = observer 的文本视图，不是独立世界观

**Touchpoints**
- `docs/octoclaw-design-foundation.md`
- `docs/octoclaw-execution-plan.md`
- `README.md`

**Exit criteria**
- 文档内不再把 patrol/runner/observer/ctl 互相混写
- 新旧入口都能映射到同一术语表

### Phase 2 — 收口 observer 的只读职责
**Goal**
- 让 `runtime_observer.py` 成为正式的只读聚合入口，而不是“patrol 的一个薄包装脚本”。

**Key work**
- 把 `observe_runtime_state_once` 相关读取、计数、runner health 汇总、恢复统计、substrate-aware read model 边界明确化
- 明确哪些逻辑允许留在 patrol 里，哪些必须迁/包到 observer read path
- 保证 `status.sh` 和 `octoclawctl observe-once` 的语义一致

**Touchpoints**
- `lib/runtime_observer.py`
- `lib/patrol.py`
- `lib/status.sh`
- `tests/test_runtime_observer.py`
- `tests/test_runner_runtime.py`

**Exit criteria**
- observer 的输入输出 schema 清晰
- status 与 ctl 的观察结果围绕同一 payload 工作

### Phase 3 — 把 patrol 限定为恢复/通知执行器
**Goal**
- patrol 不再承担“系统是什么”的定义，而只负责“发现问题后做什么”。

**Key work**
- 列出 patrol 中的逻辑分区：read/hydrate、recovery、notification、control hooks
- 将纯 read-model 汇总逻辑向 observer 收拢
- 保留 patrol 的：
  - stale ownership recovery
  - progress/result hydration trigger
  - task anchor retries / notifications
  - runner health recovery / restarts

**Touchpoints**
- `lib/patrol.py`
- `lib/patrol-loop.sh`
- `tests/test_patrol_notifications.py`
- `tests/test_runtime_coordination.py`

**Exit criteria**
- patrol 的责任能被一句话定义：基于 observer/read model 做恢复和通知
- 不再把 patrol 当成“唯一状态解释器”

### Phase 4 — 统一 runner lane 与 runner mode 语义
**Goal**
- runner 在文档、配置、CLI、代码里统一解释为“lane first, mode second”。

**Key work**
- 明确 `route=runner` 与 `RUNNER_MODE=daemon|ondemand` 的关系
- 明确 `runner_dispatch.py` / `runner_queue.py` / `runner_loop.sh` / `runner-daemon.sh` 各自责任
- 统一术语：
  - runner lane
  - runner queue
  - runner worker process
  - runner daemon mode
  - runner on-demand mode

**Touchpoints**
- `lib/runner_dispatch.py`
- `lib/runner_queue.py`
- `lib/runner_loop.sh`
- `lib/runner-daemon.sh`
- `lib/octopus_config.py`
- `README.md`
- `tests/test_runner_runtime.py`
- `tests/test_runtime_task_record.py`

**Exit criteria**
- 不再把“runner = 常驻后台进程”当作默认定义
- queue/runtime/daemon/mode 的边界在代码注释与文档里一致

### Phase 5 — 把 ctl 定义成 operator 控制入口
**Goal**
- `bin/octoclawctl.sh` 成为统一 operator 入口，而不是又一层隐性逻辑。

**Key work**
- 明确 ctl 的职责边界：status、ps、up/down/restart/reload、observe-once、patrol-once、runner-status
- 避免 ctl 自己重新定义业务状态；它应调用 observer/patrol/runner surfaces
- 让 README / 文档把 ctl 作为推荐控制入口讲清楚

**Touchpoints**
- `bin/octoclawctl.sh`
- `lib/status.sh`
- `README.md`

**Exit criteria**
- operator 不再需要在多个 shell 脚本之间猜哪个才是标准入口
- ctl 子命令说明和实际调用路径可对齐

### Phase 6 — 测试与兼容性收口
**Goal**
- 用测试和兼容规则锁住新心智，避免回退。

**Key work**
- 新增/更新：
  - observer payload contract tests
  - runner mode semantics tests
  - ctl command smoke tests（如适合）
  - patrol responsibility regression tests
- 保留兼容层，但给出废弃说明：
  - `status.sh` 仍保留文本查询
  - patrol loop / runner daemon 仍保留
  - 但文档上统一由 ctl + observer 解释

**Touchpoints**
- `tests/test_runtime_observer.py`
- `tests/test_runner_runtime.py`
- `tests/test_patrol_notifications.py`
- `tests/test_status_render.py`

**Exit criteria**
- 运行时角色解释被测试覆盖
- 兼容保留项明确，不再靠默会知识维护

## 8. Risks
1. **Patrol is too large**: 从 patrol 中抽离纯观察职责时容易牵出恢复逻辑的隐式依赖。
2. **Shell/Python split**: runner / ctl / status 横跨 shell 与 Python，容易只修一半语义。
3. **Operator confusion during transition**: 如果文档、CLI 帮助、status 输出不同步，反而会短期更混乱。
4. **Over-cleanup risk**: 过早删 legacy 入口会影响现网工作流；P1 应先统一解释，再决定删除。

## 9. Acceptance criteria
- 文档明确区分 observer / patrol / runner / ctl 的职责，不再互相替代描述。
- `runtime_observer` 的 payload 成为 status/ctl 使用的统一观察语义。
- `patrol` 被定义为恢复/通知执行器，而不是总状态解释器。
- runner 在代码与文档中被明确为 lane；daemon/on-demand 被明确为 mode。
- `octoclawctl` 被明确为 operator 控制入口，README 与帮助文案同步。
- 关键测试覆盖新的角色边界，避免未来回到旧混合解释。

## 10. Verification plan
- 文档/CLI 对齐检查：
  - `README.md`
  - `bin/octoclawctl.sh`
  - `lib/status.sh --format ...`
  - `python3 lib/runtime_observer.py --format text/json`
- 测试建议：
  - `pytest tests/test_runtime_observer.py`
  - `pytest tests/test_runner_runtime.py`
  - `pytest tests/test_patrol_notifications.py`
  - `pytest tests/test_status_render.py`
  - `pytest tests/test_runtime_task_record.py`
- 运行时 smoke：
  - daemon mode / on-demand mode 各一次
  - `octoclawctl observe-once`
  - `octoclawctl patrol-once`
  - `status.sh` 与 observer 输出字段对照

## 11. Available agent types roster
- `architect` — runtime boundary design / tradeoffs
- `executor` — Python/shell implementation lanes
- `debugger` — patrol/runner behavior regressions
- `build-fixer` — shell/test/tooling breakages
- `test-engineer` — acceptance criteria to test mapping
- `verifier` — plan completion evidence / regression proof
- `writer` — docs / help text / migration notes

## 12. Suggested execution staffing

### If using `ralph`
Use a single-owner sequential lane if you want conservative convergence:
1. doc/role-map alignment
2. observer read-model refactor
3. patrol boundary cleanup
4. runner mode terminology cleanup
5. ctl/help/status convergence
6. tests + verification

**Suggested reasoning**: high for the owner; medium for straightforward doc/help updates.

### If using `$team`
Use 4 execution lanes with a verifier lane:
- Lane A (`architect`/`executor`): observer + patrol boundary
- Lane B (`executor`): runner lane vs runner mode cleanup
- Lane C (`executor` + `writer`): ctl/status/help/docs convergence
- Lane D (`test-engineer`/`verifier`): test plan, regression suite, acceptance evidence

**Suggested reasoning by lane**
- A: high
- B: high
- C: medium
- D: medium/high

## 13. Team launch hints
- Conservative parallel path:
  - `$team "P1 runtime mind: observer/patrol/runner/ctl convergence"`
- If using OMX CLI directly, split by the 4 lanes above and give each lane explicit file ownership.

## 14. Team verification path
1. verify role-map docs and help text first
2. verify observer payload contract
3. verify patrol/recovery behavior did not regress
4. verify runner daemon vs on-demand semantics
5. verify ctl commands map cleanly onto observer/patrol/runtime surfaces
6. only then mark P1 complete
