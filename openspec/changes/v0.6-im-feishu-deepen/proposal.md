# Change: 飞书适配器深化

Date: 2026-05-13
Target release: v0.6.0

## Purpose

飞书适配器目前是 L1（文本 + 线程），但缺少长消息分段、图片/文件 attachment 支持。补齐这两块，让飞书体验和 Slack 对齐。

## Scope

1. **长消息分段**：超过 4000 字符时自动分段发送（飞书单条消息实际可用上限约 4000 字符，虽然 API 限制是 40000，但实际渲染会截断）
2. **图片 attachment**：支持 `interactiveBlocks` 里的图片类型，转成飞书 image 消息
3. **文件 attachment**：支持文件 URL，转成飞书 file 消息
4. **capabilityLevel 升级到 L2**（支持 attachment 后）

## Non-Goals

- 不做飞书 streaming（飞书 API 不支持）
- 不做飞书 typing indicator
- 不做飞书 interactive card（V2 再说）

## Acceptance Gate

- [ ] 超过 4000 字符的消息自动分段，每段都送达
- [ ] `interactiveBlocks` 里的图片 URL 转成飞书 image 消息
- [ ] `capabilityLevel` 改为 `"L2"`
- [ ] `pnpm check && pnpm test` 全绿
