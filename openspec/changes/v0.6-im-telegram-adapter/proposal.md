# Change: Telegram 适配器

Date: 2026-05-13
Target release: v0.6.0

## Purpose

Telegram Bot API 是最简单的 bot 接入方式之一，gateway 简单，适合个人用户和小团队。

## Scope

1. **`TelegramAdapter`**：实现 `IMAdapter` 接口，L1 级别
2. **支持**：文本消息 / 长消息分段（Telegram 单条 4096 字符限制）/ reply（`reply_to_message_id`）
3. **不支持**：streaming / typing indicator（V2）
4. **sessionKey 格式**：`telegram:chat:<chatId>[:user:<userId>]`
5. **配置**：`~/.openclaw/openclaw.json` 的 `channels.telegram.token`（Bot Token）
6. **注册到 `im/index.ts`**

## Non-Goals

- 不做 Telegram inline keyboard（V2）
- 不做 Telegram 文件/图片发送（V2）
- 不做 Telegram webhook server（用 OpenClaw 的 bot 层）

## Acceptance Gate

- [ ] `TelegramAdapter.canHandle("telegram:chat:123456789")` 返回 `true`
- [ ] `send()` 超过 4096 字符时自动分段
- [ ] `capabilityLevel = "L1"`
- [ ] 注册到 `im/index.ts`
- [ ] `pnpm check && pnpm test` 全绿
