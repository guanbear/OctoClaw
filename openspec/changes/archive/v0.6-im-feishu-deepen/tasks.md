# Tasks: 飞书适配器深化

## Phase A — 长消息分段（< 1 天）

### A1. 分段逻辑
- [x] 在 `feishu-adapter.ts` 使用共享 `splitIMText(text, 4000, { markers: config.segmentMarkers })` — see `im/text-split.ts`
- [x] 按段落（`\n\n`）优先分割，不够再按行（`\n`），最后按字符
- [x] 每段 <= 4000 字符 (`FEISHU_CAPABILITIES.maxMessageLength = 4000`)
- [x] 分段时在末尾加 `(1/N)` 标记（可通过 `config.segmentMarkers: false` 关闭）

### A2. 分段发送
- [x] `send()` 里检测消息长度，超过 4000 时调用 `splitIMText` (line 234)
- [x] 逐段发送，每段都用 `replyToMessageId`（保持线程）(replyToMode !== "off")
- [x] 返回最后一段的 `messageId` (`return lastResult`)
- [x] 任意一段失败 → 返回 `sent: false, error: "IM_SEND_FAILED"`

### A3. 测试
- [x] `feishu-adapter.test.ts`：5000 字符消息分成 2 段 (test at lines 117-137)
- [x] 测试：分段失败时返回 error (test at lines 139-152)

Shipped in prior commits. Uses shared `splitIMText()` from `im/text-split.ts`. Pattern matches Discord (2000) and Telegram (4096) adapters.

---

## Phase B — 图片 Attachment（< 1 天）

### B1. 解析 interactiveBlocks
- [x] 在 `send()` 里检测 `interactiveBlocks` 是否包含 image/file type — `extractFeishuCards()` + `extractFeishuAttachments()` (lines 236-241)
- [x] 有图片时，先发文本，再发图片消息（两次 API 调用）— Phase 1 cards, Phase 2 text, Phase 3 attachments
- [x] 图片消息用飞书 image 消息类型（`--type image --url <url>`）

### B2. 文件 Attachment
- [x] 检测 `{ type: "file", url: "..." }` — `extractFeishuAttachments()` handles file blocks
- [x] 发文件消息（`--type file`）

### B3. capabilityLevel 升级
- [x] `FEISHU_CAPABILITIES.capabilityLevel` 改为 `"L2"` (line 27)
- [x] `FeishuAdapter.capabilityLevel` uses local `FEISHU_CAPABILITIES`

### B4. 测试
- [x] 测试：图片 block 触发图片消息发送 — covered by attachment tests
- [x] 测试：文件 block 触发文件消息发送 — covered by attachment tests

Shipped in prior commits. `send()` flow: Phase 1 cards → Phase 2 text (skipped if cards) → Phase 3 attachments (images + files).

---

## Acceptance

- [x] 5000 字符消息分 2 段发送，两段都 `delivered: true`
- [x] 图片 block 转成飞书 image 消息
- [x] `capabilityLevel = "L2"`
- [x] `pnpm check && pnpm test` 全绿
