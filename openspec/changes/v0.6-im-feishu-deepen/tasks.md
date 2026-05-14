# Tasks: 飞书适配器深化

## Phase A — 长消息分段（< 1 天）

### A1. 分段逻辑
- [ ] 在 `feishu-adapter.ts` 加 `splitMessage(text: string, maxLen: number): string[]`
- [ ] 按段落（`\n\n`）优先分割，不够再按行（`\n`），最后按字符
- [ ] 每段 <= 4000 字符
- [ ] 分段时在末尾加 `(1/N)` 标记（可通过 config 关闭）

### A2. 分段发送
- [ ] `send()` 里检测消息长度，超过 4000 时调用 `splitMessage`
- [ ] 逐段发送，每段都用 `replyToMessageId`（保持线程）
- [ ] 返回最后一段的 `messageId`
- [ ] 任意一段失败 → 返回 `sent: false, error: "IM_SEND_FAILED"`

### A3. 测试
- [ ] 补 `feishu-adapter.test.ts`：5000 字符消息分成 2 段
- [ ] 补测试：分段失败时返回 error

---

## Phase B — 图片 Attachment（< 1 天）

### B1. 解析 interactiveBlocks
- [ ] 在 `send()` 里检测 `interactiveBlocks` 是否包含 `{ type: "image", url: "..." }`
- [ ] 有图片时，先发文本，再发图片消息（两次 API 调用）
- [ ] 图片消息用飞书 `image` 消息类型（`openclaw message send --channel feishu --type image --url <url>`）

### B2. 文件 Attachment
- [ ] 检测 `{ type: "file", url: "...", name: "..." }`
- [ ] 发文件消息（`--type file`）

### B3. capabilityLevel 升级
- [ ] `FEISHU_CAPABILITIES.capabilityLevel` 改为 `"L2"`
- [ ] `FeishuAdapter.capabilityLevel` 改为 `"L2"`

### B4. 测试
- [ ] 补测试：图片 block 触发图片消息发送
- [ ] 补测试：文件 block 触发文件消息发送

---

## Acceptance

- [ ] 5000 字符消息分 2 段发送，两段都 `delivered: true`
- [ ] 图片 block 转成飞书 image 消息
- [ ] `capabilityLevel = "L2"`
- [ ] `pnpm check && pnpm test` 全绿
