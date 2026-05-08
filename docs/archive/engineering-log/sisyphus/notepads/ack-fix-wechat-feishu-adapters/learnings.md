## Learnings

## 2026-04-19 T0: CLI Channel Validation
- `openclaw message send --channel wechat` returns "Unknown channel: wechat" — NOT supported via CLI
- `openclaw message send --channel feishu` WORKS — target format: `<chatId|user:openId|chat:chatId>`
- `openclaw-weixin` plugin exists at `~/.openclaw/extensions/openclaw-weixin/` but is a separate extension, not a CLI channel
- WeChat adapter must call openclaw-weixin plugin API directly, not openclaw message send
- Feishu adapter CAN use openclaw message send --channel feishu with correct target format
- Feishu target format: chatId for DMs, user:openId for user messages, chat:chatId for groups

