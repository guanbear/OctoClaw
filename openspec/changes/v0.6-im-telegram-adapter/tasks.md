# Tasks: Telegram 适配器

## Phase A — 适配器实现（1 天）

### A1. 文件骨架
- [ ] 新建 `extensions/octoclaw-runtime/src/im/telegram/telegram-adapter.ts`
- [ ] 新建 `extensions/octoclaw-runtime/src/im/telegram/index.ts`
- [ ] 定义 `TelegramAdapterConfig` 接口
- [ ] 定义 `TELEGRAM_CAPABILITIES`（maxMessageLength: 4096，canReplyInThread: true，canStreamNative: false）
- [ ] `pnpm build` 通过

### A2. sessionKey 解析
- [ ] 实现 `parseTelegramSessionKey()`
- [ ] 格式：`telegram:chat:<chatId>` 或 `telegram:chat:<chatId>:user:<userId>`
- [ ] `canHandle()` 检测 `telegram:` 前缀

### A3. send() 实现
- [ ] 实现 `splitMessage(text, 4096)` 分段函数（复用 Discord 的，或提取到 `im/utils.ts`）
- [ ] 超过 4096 字符时分段发送
- [ ] 支持 `replyToMessageId`（`reply_to_message_id` 参数）
- [ ] 调用 `openclaw message send --channel telegram --target <chatId> --json`
- [ ] 解析 JSON 输出

### A4. react() — 不支持
- [ ] 返回 `{ ok: false, error: "not_supported" }`

### A5. renderProjectionFooter()
- [ ] 纯文本 footer（和 Discord 类似）

---

## Phase B — 注册 + 配置（< 0.5 天）

### B1. 注册到 im/index.ts
- [ ] import `TelegramAdapter`
- [ ] `adapterRegistry.push(new TelegramAdapter(buildTelegramAdapterConfig()))`
- [ ] 导出 `TelegramAdapter` 和 `TelegramAdapterConfig`

---

## Phase C — 测试（< 0.5 天）

### C1. 单元测试
- [ ] 新建 `telegram-adapter.test.ts`
- [ ] 测试 `canHandle()` 正确识别 telegram sessionKey
- [ ] 测试 5000 字符消息分 2 段
- [ ] 测试 send 成功路径（mock `runCommand`）
- [ ] 测试 send 失败路径

---

## Acceptance

- [ ] `canHandle("telegram:chat:123456789")` 返回 `true`
- [ ] 5000 字符消息分 2 段
- [ ] `capabilityLevel = "L1"`
- [ ] 注册到 `im/index.ts`
- [ ] `pnpm check && pnpm test` 全绿
