# Tasks: Discord 适配器

## Phase A — 适配器实现（1-2 天）

### A1. 文件骨架
- [ ] 新建 `extensions/octoclaw-runtime/src/im/discord/discord-adapter.ts`
- [ ] 新建 `extensions/octoclaw-runtime/src/im/discord/index.ts`
- [ ] 定义 `DiscordAdapterConfig` 接口
- [ ] 定义 `DISCORD_CAPABILITIES` 常量
- [ ] `pnpm build` 通过

### A2. sessionKey 解析
- [ ] 实现 `parseDiscordSessionKey()`（见 design.md §3）
- [ ] 支持带 thread 和不带 thread 两种格式
- [ ] `canHandle()` 检测 `discord:` 前缀

### A3. send() 实现
- [ ] 实现 `splitMessage(text, 2000)` 分段函数
- [ ] 超过 2000 字符时分段发送
- [ ] 支持 `replyToMessageId`（第一段带，后续段不带）
- [ ] 支持 `threadId`（从 sessionKey 解析）
- [ ] 解析 `openclaw message send` 的 JSON 输出

### A4. react() 实现
- [ ] 实现 `react()`，调用 `openclaw message react --channel discord`
- [ ] 不支持时返回 `{ ok: false, error: "not_supported" }`（暂时，等 OpenClaw 支持）

### A5. renderProjectionFooter()
- [ ] 实现纯文本 footer（见 design.md §6）
- [ ] delegate 时加 🤖 emoji

---

## Phase B — 注册 + 配置（< 0.5 天）

### B1. 注册到 im/index.ts
- [ ] import `DiscordAdapter`
- [ ] `adapterRegistry.push(new DiscordAdapter(buildDiscordAdapterConfig()))`
- [ ] 导出 `DiscordAdapter` 和 `DiscordAdapterConfig`
- [ ] `buildDiscordAdapterConfig()` 从 `~/.openclaw/openclaw.json` 读配置

---

## Phase C — 测试（< 1 天）

### C1. 单元测试
- [ ] 新建 `discord-adapter.test.ts`
- [ ] 测试 `canHandle()` 正确识别 discord sessionKey
- [ ] 测试 `resolveTarget()` 解析 guildId / channelId / userId / threadId
- [ ] 测试 2500 字符消息分 2 段
- [ ] 测试 send 成功路径（mock `runCommand`）
- [ ] 测试 send 失败路径（mock 返回 `ok: false`）

---

## Acceptance

- [ ] `canHandle("discord:guild:123:channel:456:user:789")` 返回 `true`
- [ ] 2500 字符消息分 2 段，两段都发送
- [ ] `capabilityLevel = "L2"`
- [ ] 注册到 `im/index.ts`，`getAdapterForChannel("discord")` 返回实例
- [ ] `pnpm check && pnpm test` 全绿
