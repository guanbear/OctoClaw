# Design: Discord 适配器

## 1. 文件结构

```
extensions/octoclaw-runtime/src/im/discord/
  index.ts
  discord-adapter.ts
  discord-adapter.test.ts
```

## 2. Capability Profile

```typescript
export const DISCORD_CAPABILITIES = {
  canUpdateMessage: false,   // 可以 edit，但 OctoClaw 不用
  canStreamNative: false,    // Discord 不支持流式
  canReplyInThread: true,    // 支持 thread
  canTypingIndicator: false, // 不做
  messageIdFormat: "snowflake",
  userIdCaseSensitive: false,
  maxMessageLength: 2000,    // Discord 硬限制
} as const;
```

## 3. sessionKey 格式

```
discord:guild:<guildId>:channel:<channelId>:user:<userId>
discord:guild:<guildId>:channel:<channelId>:user:<userId>:thread:<threadId>
```

解析函数：

```typescript
function parseDiscordSessionKey(sessionKey: string): {
  guildId: string;
  channelId: string;
  userId: string;
  threadId?: string;
}
```

## 4. 发送实现

通过 `openclaw message send --channel discord` 调用（和 Slack / 飞书 / 微信一致）：

```typescript
async send(params: IMSendParams): Promise<IMSendResult> {
  const target = this.resolveTarget(params.sessionKey);
  const segments = splitMessage(params.message, DISCORD_CAPABILITIES.maxMessageLength);

  for (const [i, segment] of segments.entries()) {
    const args = [
      "message", "send",
      "--channel", "discord",
      "--target", target.target,
      "--json",
      "--message", segment,
    ];
    if (target.threadId) args.push("--thread", target.threadId);
    if (params.replyToMessageId && i === 0) args.push("--reply-to", params.replyToMessageId);

    const result = await runCommand("openclaw", args, { timeoutMs: params.timeoutMs ?? 5000 });
    // ... parse result
  }
}
```

## 5. Reaction 支持

Discord 支持 emoji reaction（和 Slack 类似）：

```typescript
async react(params: IMReactParams): Promise<IMReactResult> {
  const args = [
    "message", "react",
    "--channel", "discord",
    "--message-id", params.messageId,
    "--emoji", params.emoji,
    "--json",
  ];
  // ...
}
```

## 6. Footer 渲染

Discord 不支持 Block Kit，用纯文本 footer：

```typescript
renderProjectionFooter(message: string, projection: IMProjectionFooter): string {
  const footer = `\n\`[${projection.route === "delegate" ? "🤖 " : ""}${projection.model}]\``;
  return message + footer;
}
```

## 7. 注册到 im/index.ts

```typescript
// im/index.ts 新增
import { DiscordAdapter } from "./discord/index.js";
// ...
adapterRegistry.push(new DiscordAdapter(buildDiscordAdapterConfig()));
// 导出
export { DiscordAdapter } from "./discord/index.js";
```

## 8. 配置读取

```typescript
function buildDiscordAdapterConfig(): Partial<DiscordAdapterConfig> {
  const config = readChannelConfig("discord");
  return {
    replyToMode: readReplyToMode("discord"),
  };
}
```
