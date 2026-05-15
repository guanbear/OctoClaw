# Change: Discord 适配器

Date: 2026-05-13
Target release: v0.6.0

## Purpose

Discord 是开发者社区的主要聚集地，开源项目天然适合。加 Discord 适配器让 OctoClaw 能在 Discord 服务器里运行。

## Scope

1. **`DiscordAdapter`**：实现 `IMAdapter` 接口，L2 级别
2. **支持**：slash command 触发 / thread 回复 / 长消息分段（Discord 单条 2000 字符限制）
3. **不支持**：streaming（Discord API 不支持消息流式更新，只能 edit）
4. **sessionKey 格式**：`discord:guild:<guildId>:channel:<channelId>:user:<userId>[:thread:<threadId>]`
5. **配置**：`~/.openclaw/openclaw.json` 的 `channels.discord.token` + `channels.discord.applicationId`
6. **注册到 `im/index.ts`**

## Non-Goals

- 不做 Discord slash command 注册（用户手动注册，文档说明）
- 不做 Discord voice channel
- 不做 Discord 消息 embed（V2）

## Acceptance Gate

- [ ] `DiscordAdapter.canHandle("discord:guild:123:channel:456:user:789")` 返回 `true`
- [ ] `send()` 超过 2000 字符时自动分段
- [ ] `react()` 支持 emoji reaction
- [ ] `capabilityLevel = "L2"`
- [ ] 注册到 `im/index.ts`
- [ ] `pnpm check && pnpm test` 全绿
