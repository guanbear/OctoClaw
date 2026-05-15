# Change: 友好错误体系 + `octoclawctl doctor`

Date: 2026-05-13
Target release: v0.6.0
Design reference: `openspec/changes/v0.6-friendly-errors-doctor/design.md`

## Purpose

让用户（包括 AI agent）在遇到错误时能立刻知道：出了什么问题、为什么、怎么修。

## Problem

现在的错误输出是开发者英文 `throw new Error("...")`，用户看到会懵：

```
Error: unresolvable_session_target
    at FeishuAdapter.send (feishu-adapter.ts:142)
```

没有中文、没有 actionable hint、没有错误码。AI agent 也无法解析。

## Scope

1. **`OctoClawError` 统一错误类**：`code` / `userMessageZh` / `userMessageEn` / `actionableHint` / `cause`
2. **错误码注册表**：`packages/octoclaw-errors/src/codes.ts`，所有错误码集中管理
3. **`octoclawctl doctor` 命令**：检测 5 项，输出 pass/warn/fail，退出码 0/1
4. **关键路径替换**：IM 适配器、judge 调用、dispatch 入口的 `throw new Error` 改成 `OctoClawError`
5. **CLI 全局错误处理**：`cli.ts` 顶层 catch，格式化输出 `OctoClawError`

## Non-Goals

- 不替换所有 `throw new Error`（只替换用户可见的关键路径）
- 不做 Sentry / 远端错误上报（V1 只本地）
- 不做 i18n 框架（只需要 zh/en 两个字段）

## Acceptance Gate

- [ ] `OctoClawError` 类存在，有 4 个必填字段
- [ ] 错误码注册表有 ≥ 20 个常见错误码
- [ ] `octoclawctl doctor` 检测 5 项，不 crash，退出码正确
- [ ] IM 适配器（Slack / 飞书 / 微信）的 `send` 失败路径返回 `OctoClawError`
- [ ] judge 超时 / parse 失败路径抛 `OctoClawError`
- [ ] `pnpm check && pnpm test` 全绿
