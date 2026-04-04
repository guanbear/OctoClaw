# OctoClaw Model Health / Cooldown 设计 v1 (2026-03-29)

## 1. 目标

这份文档定义 OctoClaw 的 `model health / cooldown / fallback` 设计。

目标不是替代 OpenClaw 上游已有的 failover，而是在 **policy-first 选模层** 上补一层跨请求的健康状态感知：

- 限流模型不要继续被高频交互任务优先选中
- 慢模型不要默认落到主链路和延迟敏感任务
- 质量高但不稳定的模型，应该只在低峰或非急迫任务里再尝试
- OctoClaw 的“下次选谁”与 OpenClaw 的“这次别死”明确分层

## 2. 分层边界

### 2.1 OpenClaw 继续负责

- 单次运行内的 HTTP retry
- auth profile rotation
- profile cooldown / disabled backoff
- 单次运行内的 model fallback
- failover decision 观测日志
- provider usage / quota snapshot

这些能力已在 OpenClaw 上游存在，不应由 OctoClaw 重新实现。

### 2.2 OctoClaw 新增负责

- 跨请求的 model health 状态
- 对不同 route / worker_pool 的健康惩罚
- 交互型任务的慢模型降权
- rate limit / timeout / failover 的跨任务避让
- cooldown 结束后的保守恢复

一句话：

> **OpenClaw 负责“这次请求别死”，OctoClaw 负责“下次别再优先挑它”。**

## 3. 设计原则

### 3.1 不替代上游 failover

OctoClaw 只做 **selection-time bias**，不做 request-time retry loop。

### 3.2 先轻量，后增强

v1 只接 4 类核心信号：

- recent 429
- recent timeout
- recent failover count
- first-token / total latency

### 3.3 route sensitivity

不同执行面要承受不同的健康约束：

- `direct / octoclaw-main / ops-fast`：对速度和稳定性最敏感
- `code / review`：允许略慢，但不能频繁 failover
- `research / writer / report`：可接受慢一些、可在低峰复用质量更高但不稳定的模型

## 4. 数据模型

状态文件：

- `/workspace/tmp/octopus/model-health.json`

结构建议：

```json
{
  "generated_at": "2026-03-29T12:00:00Z",
  "models": {
    "zhipu/GLM-5.1": {
      "state": "degraded",
      "cooldown_until": "",
      "disabled_until": "",
      "reason_codes": ["rate_limit_recent", "ttft_slow"],
      "recent_429_count": 2,
      "recent_timeout_count": 0,
      "recent_failover_count": 2,
      "recent_success_count": 3,
      "first_token_p50_ms": 4200,
      "first_token_p95_ms": 6500,
      "total_latency_p50_ms": 14500,
      "quota_pressure": "high",
      "last_error_reason": "rate_limit",
      "last_degraded_at": "2026-03-29T11:45:00Z"
    }
  }
}
```

## 5. 健康状态

### 5.1 状态枚举

- `healthy`
- `degraded`
- `cooldown`

### 5.2 触发建议

- 最近 10-30 分钟内连续 2 次 `429/timeout/failover`
  - 进入 `degraded`
- 连续 3 次，或已有显式 `cooldown_until`
  - 进入 `cooldown`
- provider usage / quota pressure 很高
  - 至少进入 `degraded`

### 5.3 恢复策略

- `cooldown` 过期后自动降为 `degraded` 或 `healthy`
- 先允许低风险 probe，而不是立刻恢复默认首选

## 6. 与 policy-first 的集成

### 6.1 policy 生成阶段

`model-intel.py` 在生成 `model-policy.json` 时，应把 health penalty 编进各 role score：

- `runner / router / main`
  - 速度 penalty 更高
- `fix / test`
  - failover penalty 更高
- `scout / writer / analyze`
  - 允许轻度 `degraded`

输出到 `model-policy.json` 的字段建议增加：

- `health.generated_at`
- `health.models[model_id]`
- `health.selection_penalties[model_id]`

### 6.2 resolver 兜底阶段

`resolve-model.py` 不负责计算复杂 health score，但应读取 policy 中的 health 信息：

- 若当前选中的模型已 `cooldown`
- 先尝试 `family_routing[selected_model].fallback_path`
- 选择第一个未 cooldown 的 fallback
- 若无可用 fallback，再保留原模型，让 OpenClaw 上游 failover 接管

这一步是 **避免明显已知坏模型继续被选中**，不是替代上游 failover。

## 7. 对不同任务的影响

### 7.1 交互型任务

- `direct`
- `octoclaw-main`
- `ops-fast`

策略：

- 强避让 `cooldown`
- 明显降权 `degraded`
- 对慢模型施加 latency penalty

### 7.2 code / review

策略：

- 强避让 `cooldown`
- 对近期多次 failover 的模型降权
- 比 direct 更容忍较高 TTFT

### 7.3 research / report

策略：

- `degraded` 可继续候选
- `cooldown` 才强避让
- 允许在低峰/非交互任务中复用质量更高但速度一般的模型

## 8. 与上游可复用信息

### 8.1 直接复用

- OpenClaw `model_fallback_decision` 观测日志
- provider usage / quota snapshot
- auth profile cooldown / disabled 状态

### 8.2 OctoClaw 自己补

- route 维度成功率
- worker_pool/profile 维度 failover 频率
- first-token / total-latency 摘要
- “被选中后又被上游 failover 救火”的频次

## 9. v1 实施范围

v1 只做：

1. `model-health.json` 读取
2. policy 生成时 health penalty
3. policy 输出 health metadata
4. resolver 对 `cooldown` 的轻量 fallback 兜底

v1 不做：

- 自动写回生产规则
- 自动从上游日志持续学习
- 完整的 provider health dashboard
- session 级动态切主会话模型

## 10. 后续增强

- nightly replay / provider logs -> health state 更新
- `model_fallback_decision` 日志回灌 `model-health.json`
- route-aware latency windows
- 低峰/高峰时间段偏好
- session drift 检测与提醒
- 与 patrol 联动做模型漂移/异常告警

## 11. 日志回灌优先级

最值得先做的是：

1. 读取 OpenClaw 结构化 `model_fallback_decision` 日志
2. 回灌最近窗口内的 `recent_429_count / recent_timeout_count / recent_failover_count / recent_success_count`
3. 让 OctoClaw 下一次选模时避开近期明显不健康的模型

这样不会和 OpenClaw 上游冲突，因为：

- OpenClaw 负责“本次请求别死”
- OctoClaw 负责“下次别再优先选它”

后续两个增强项的优先级略低于日志回灌：

- provider usage / quota snapshot -> `quota_pressure`
- main session drift 检测与自动纠正

## 12. Quota Pressure 回灌

第二优先级是把 OpenClaw 的 provider usage / quota snapshot 转成 OctoClaw 的
`quota_pressure`。

第一版只做：

1. 读取标准 `UsageSummary` JSON，或 `status --json --usage` 中的 `usage` 块
2. 以 provider 的最高 `usedPercent` 窗口判定：
   - `>= 85%` -> `high`
   - `>= 95%` -> `critical`
3. 基于 policy/catalog 里的 provider 元信息，把压力映射到对应模型

这样能解决：

- 某 provider 当前额度很紧时，不必等到真实 429 才避让
- 交互型主链路能更早避开高压 provider

但它仍然是保守的：

- 只做跨请求 penalty
- 不替代 OpenClaw 单次请求内的 failover
- 不直接自动改主 session

## 13. Main Session Drift

第三优先级是主 session 漂移检测。

第一版建议：

1. 检测 `policy.main_model` / `customModels.main` 与当前主 session `modelOverride` 是否一致
2. 默认只提醒，不自动纠正
3. 通过 patrol 做带冷却时间的通知，避免反复刷屏

默认策略：

- `enabled = true`
- `auto_recover = false`
- `notify_cooldown_seconds = 3600`

这样能先把“策略主链”和“实际主会话”分叉这件事显式暴露出来，
但不会在还没完全验证前，自动改动线上主会话模型。
