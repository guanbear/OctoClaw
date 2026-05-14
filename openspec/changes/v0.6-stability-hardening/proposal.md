# Change: 稳定性收尾（A2）

Date: 2026-05-13
Target release: v0.6.0
Design reference: `openspec/changes/v0.6-stability-hardening/design.md`

## Purpose

在开源发布前，把已知的稳定性缺口补上，避免用户第一次用就撞到 bug。

## Problem

四个已知缺口：

1. **W-5 WP-F**：Slack smoke 5 case 还没跑（已有 spec，只差执行）
2. **W-6 Phase 2**：timeout watchdog 的 `degraded` / `delivered` 状态和 operator surface 没做
3. **Judge cooldown**：设计里有"连续失败 30 分钟 cooldown"，但没实现
4. **Shadow lane 隔离**：shadow 失败不污染 live lane 的 invariant 测试没有，容易回归

## Scope

1. **Slack smoke 5 case**：补 5 个端到端 smoke 测试（mock Slack server）
2. **Watchdog Phase 2**：`degraded(completed_without_result)` / `delivered` 状态 + `octoclawctl status` / `octoclawctl details` 展示
3. **Judge cooldown**：连续失败 5/10 → 30 分钟 cooldown，可通过 `OCTOCLAW_DISABLE_HEALTH_GATES=1` 关闭
4. **Shadow lane invariant 测试**：3 个回归点（IO error / snapshot missing / JSON parse error）

## Non-Goals

- 不重写 watchdog（Phase 1 已落地，只补 Phase 2）
- 不改 judge 的 schema
- 不做端到端测试框架（只用现有 Vitest + mock）

## Acceptance Gate

- [ ] Slack smoke 5 case 全绿
- [ ] `octoclawctl status` 能展示 `degraded` / `delivered` 状态
- [ ] judge 连续失败 5/10 后，下一次调用直接走 fallback（不调 judge endpoint）
- [ ] `OCTOCLAW_DISABLE_HEALTH_GATES=1` 时 cooldown 不生效
- [ ] shadow IO error 不影响 live dispatch（invariant 测试通过）
- [ ] `pnpm check && pnpm test` 全绿
