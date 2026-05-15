# OctoClaw 反馈链路合同规范

> 适用分支：`refactor/0.4.0-stable`  
> 完成日期：2026-04-30

Phase 2 交付物：`observe → summarize → review → curate → validate → promote → learn` 七步链路的工具、输入/输出合同和触发方式。

---

## 链路全图

```
replay.jsonl  ──observe──▶  NightlyReport  ──summarize──▶  5 lanes
                                                 │
                         ┌───────────────────────┘
                         ▼
                     review / curate
                    (人工核查/样本选取)
                         │
                         ▼
              nightly-eval run ──validate──▶ gate=pass|fail|unknown
                                                 │
                         ┌───────────────────────┘
                         ▼
              nightly-eval promote ──promote──▶  baseline 更新
                         │
                         ▼
                      learn (baseline 版本演进记录)
```

---

## 每步合同

### 1. observe — replay 事件写入

**工具**：`extensions/octoclaw-runtime/src/replay/replay.ts`  
**触发**：每次 route 决策、委派、ACK、执行转换时自动写入（live path 全部 `void` fire-and-forget）  
**输入**：runtime 生命周期事件  
**输出格式**：  
```jsonl
{"schema_version":"octoclaw.runtime_policy.replay_event/v1","event":"policy_resolved","at":"...","turnId":"...","decisionId":"...","taskId":"...","route":"reply","taskClass":"main_direct",...}
```
**关键字段**：`turnId`（可追踪每次 route 决策）、`decisionId`、`taskId`、`flowId`、`workContractId`  
**存储位置**：`~/.openclaw/workspace/tmp/octopus/runtime-policy-replay.jsonl`

---

### 2. summarize — nightly classifier

**工具**：`octoclawctl nightly [--replay <path>] [--format markdown|json]`  
**触发**：手动或由 `nightly-eval run` 自动调用  
**输入**：`runtime-policy-replay.jsonl`（过滤 24h 内，去除 synthetic events）  
**输出**：`NightlyReport`（schema: `octoclaw.nightly_eval.report/v1`）  
**5 条评估 lanes**：  
- Route Quality：pass / false_delegate / false_reply / unclear / unknown  
- Route Commit ACK：sent / missing / late / duplicate  
- Execution Transition：dispatch / spawn / stale / timeout / delivery  
- Delegation Health：no_spawn / spawn_failed / context_pollution  
- Delivery：pass / failed / compensated  
**3 维指标**：cost（USD/request）、latency（ACK p50/p95/p99 ms）、correctness（通过率）  
**Gate 字段**：`overallGate: "pass" | "fail" | "unknown"`

---

### 3. review — 人工核查

**工具**：`octoclawctl review [--output-dir <dir>] [--input <report.json>] [--format text|json]`  
**触发**：手动，在 nightly-eval 产出报告后  
**输入**：最新 `*-nightly-eval.json`（或指定路径）  
**输出**：列出 `verdict=fail|unknown|false_delegate|false_reply` 的样本（最多 20 条），含 event 类型和 reason  
**格式**：纯文本（默认）或 JSON（`--format json`）  
**目的**：人工决定哪些失败是真正问题、哪些可以忽略或需要 curate

---

### 4. curate — 样本选取为 fixture

**工具**：`octoclawctl curate --task-id <turnId> [--input <replay.jsonl>]`  
**触发**：手动，在 review 后选定某个 turn  
**输入**：replay.jsonl + turnId（或 taskId）  
**输出**：`~/.openclaw/workspace/tmp/octopus/fixtures/fixture-{id}-{ts}.jsonl`  
  - 包含该 turn 的所有相关事件，每条加 `"fixture": true` 标记  
**格式**：JSONL，与 replay 格式完全兼容  
**用途**：后续在 nightly 中作为 synthetic 测试样本验证行为不回退

---

### 5. validate — nightly-eval

**工具**：`octoclawctl nightly-eval run --config <eval-config.json> --output-dir <dir>`  
**触发**：手动或 LaunchAgent（每日定时）  
**输入**：`NightlyEvalConfig`  
```json
{
  "replayPath": "/path/to/runtime-policy-replay.jsonl",
  "lookbackHours": 24,
  "excludeSynthetic": true,
  "slackAcceptanceConfig": "/path/to/slack-acceptance.json"
}
```
**注意**：不需要显式提供 `baseline`/`candidate` — 若存在已 promote 的 baseline，自动运行 calibration gate  
**输出**：`NightlyEvalAggregateReport`（schema: `octoclaw.nightly_eval.report/v1`）  
  - `steps.nightly.status` — 5 lanes 结果  
  - `steps.slackAcceptance.status` — acceptance 测试结果  
  - `steps.calibration.status` — 与 baseline 对比结果（有 baseline 时）  
  - `overallGate: "pass" | "fail" | "unknown"`  
  - `recommendationStatus: "recommend_only" | "blocked" | "unknown"`  
**产出文件**：  
  - `{prefix}-nightly.json/md`  
  - `{prefix}-calibration.json/md`（有 baseline 时）  
  - `{prefix}-nightly-eval.json/md`

---

### 6. promote — 提升基线

**工具**：`octoclawctl nightly-eval promote [--input <report.json>] [--output-dir <dir>]`  
**触发**：手动，在 validate 通过（gate=pass 或 unknown）后  
**输入**：最新 nightly-eval 报告路径  
**保护**：`gate=fail` 时拒绝 promote（需先修复回归）  
**输出**：更新 `~/.openclaw/workspace/tmp/octopus/nightly-eval-baseline.json`  
```json
{ "reportPath": "/abs/path/to/report.json", "promotedAt": "2026-04-30T...", "overallGate": "pass" }
```
**效果**：下次 `nightly-eval run` 自动以此报告为 baseline 运行 calibration gate  
**查看当前 baseline**：`octoclawctl nightly-eval show-baseline`  
**清除**：`octoclawctl nightly-eval clear-baseline`

---

### 7. learn — 演进记录

**工具**：内置于 promote 流程（当前版本）  
**触发**：每次成功 promote  
**记录内容**：`nightly-eval-baseline.json` 的版本演进 = 学习记录  
- `promotedAt` 字段记录 promote 时间  
- `overallGate` 字段记录当时的质量水位  
**查看历史**：比较不同时间点的 nightly-eval 报告文件（按 `generatedAt` 排序）  
**未来扩展**：可添加 `octoclawctl learn` 命令，从重复出现的 failures 中自动提炼 fixture 或更新 routing policy

---

## 完整工作流示例

```bash
# 1. 每日自动运行（LaunchAgent 触发，或手动）
octoclawctl nightly-eval run \
  --config ~/.openclaw/nightly-eval-config.json \
  --output-dir ~/.openclaw/workspace/tmp/octopus/nightly-eval

# 2. 查看失败样本
octoclawctl review

# 3. 选取某个 turn 为 fixture（如果发现有价值的 case）
octoclawctl curate --task-id turn-abc123

# 4. 若 gate=pass，提升为新 baseline
octoclawctl nightly-eval promote \
  --output-dir ~/.openclaw/workspace/tmp/octopus/nightly-eval

# 5. 下次 nightly-eval run 会自动对比新 baseline（calibration 自动运行）
```

---

## nightly-eval-config.json 最小配置

```json
{
  "replayPath": "/Users/guanbear/.openclaw/workspace/tmp/octopus/runtime-policy-replay.jsonl",
  "lookbackHours": 24,
  "excludeSynthetic": true
}
```

加入 Slack acceptance：

```json
{
  "replayPath": "...",
  "lookbackHours": 24,
  "excludeSynthetic": true,
  "slackAcceptanceConfig": "/path/to/slack-acceptance.json"
}
```

---

*文档路径：`docs/octoclaw-feedback-loop-contracts.md`*  
*代码核查分支：`refactor/0.4.0-stable`，日期：2026-04-30*
