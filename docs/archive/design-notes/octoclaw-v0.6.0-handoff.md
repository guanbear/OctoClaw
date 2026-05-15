# OctoClaw v0.6.0 — 交给其他 AI 的协作手册

Date: 2026-05-13
Audience: 把 v0.6.0 某个工作包交给另一个 AI agent（Codex、Claude Code 等）的人

---

## 文档栈（先读什么）

| 文档 | 用途 |
|------|------|
| `docs/octoclaw-v0.6.0-roadmap-2026-05-13.md` | 总览：7 个包的优先级、依赖、acceptance |
| `openspec/changes/<pack>/proposal.md` | Why + Scope + Acceptance Gate |
| `openspec/changes/<pack>/design.md` | 架构 + 接口 + 实现细节 |
| `openspec/changes/<pack>/tasks.md` | 可勾任务清单（每个 < 4h） |
| `openspec/changes/<pack>/bdd.md` | 验收场景（每个 = 一个 Vitest 测试） |

阅读顺序：`roadmap → proposal → design → tasks → bdd`

---

## 7 个工作包一览

| 包名 | 目录 | 优先级 | 预估 | 有 BDD？ |
|------|------|--------|------|---------|
| S1 npm 发包 + init 向导 | `v0.6-npm-cli-distribution` | P0 | 3-5 天 | ✅ |
| S3 友好错误 + doctor | `v0.6-friendly-errors-doctor` | P1 | 3-4 天 | ✅ |
| A1 GitHub 主页 | `v0.6-github-presence` | P1 | 2-3 天 | ❌（静态文件，不需要） |
| A2 稳定性收尾 | `v0.6-stability-hardening` | P0 | 4-6 天 | ✅ |
| A3 飞书深化 | `v0.6-im-feishu-deepen` | P2 | 1-2 天 | ❌（补在 feishu-adapter.test.ts） |
| A3 Discord 适配器 | `v0.6-im-discord-adapter` | P2 | 2-3 天 | ❌（补在 discord-adapter.test.ts） |
| A3 Telegram 适配器 | `v0.6-im-telegram-adapter` | P2 | 1-2 天 | ❌（补在 telegram-adapter.test.ts） |

---

## 硬约束（每个包都要遵守，违反请停下来问）

1. **不破坏 `IMAdapter` 接口**。`adapter.ts` 里的接口是 contract，新适配器只能实现，不能改接口。
2. **错误码必须中英双语**。任何面向用户的错误消息都要有 `userMessageZh` + `userMessageEn`。
3. **新 IM 适配器必须标注 `capabilityLevel`**（L0 / L1 / L2）。
4. **`octoclawctl doctor` 不能 throw**。任何检测项失败也要继续跑完，输出汇总。
5. **`@octoclaw/cli` 不能依赖 monorepo 内部相对路径**。发布后 `workspace:*` 不存在。
6. **Cooldown / 健康策略必须可关闭**。`OCTOCLAW_DISABLE_HEALTH_GATES=1` 时跳过。
7. **shadow lane 失败绝不能影响 live dispatch**。所有 shadow 调用必须 `try/catch` 包死。
8. **所有 CLI 输出中英双语**。`--lang zh`（默认）/ `--lang en`。
9. **不改 judge 的 3 字段 schema**（`route / confidence / complexity`）。
10. **不在热路径发起远端请求**。所有网络调用必须在后台 worker 或 CLI 命令里，不在用户消息处理路径。

---

## 可以并行的包

```
A2（稳定性）  ──────────────────────────────────────────→ 先做
S3（错误体系）────────────────────────────────────────→ 和 A2 并行
S1（npm 发包）────────────────────────────────────────→ 和 A2 并行（S3 完成后 S1 的 doctor step 才完整）
A1（GitHub）  ──────────────────────────────────────→ 随时可做，纯静态
A3-飞书       ──────────────────────────────────────→ 随时可做
A3-Discord    ──────────────────────────────────────→ 随时可做
A3-Telegram   ──────────────────────────────────────→ 随时可做
```

A3 三个适配器完全独立，可以三个 AI 同时做。

---

## 交接 prompt 模板（整段复制粘贴）

替换 `{包名}` 和 `{Phase X / 任务编号}` 两个占位符：

```
你要帮我实施 OctoClaw v0.6.0 的 {包名}。

OctoClaw 是 OpenClaw 的 TypeScript 插件，解决：主 agent 自动委派子 agent、
按需选模型、IM 适配。项目是 pnpm monorepo，TypeScript ESM，Node 22。

先读以下文档，按顺序：
1. docs/octoclaw-v0.6.0-roadmap-2026-05-13.md   （总览 + 硬约束）
2. openspec/changes/{包目录}/proposal.md         （Why + Scope）
3. openspec/changes/{包目录}/design.md           （架构 + 接口，如有）
4. openspec/changes/{包目录}/tasks.md            （任务清单）
5. openspec/changes/{包目录}/bdd.md              （验收场景，如有）

重要约束（违反任何一条请停下来找我确认）：
- 不破坏 IMAdapter 接口（extensions/octoclaw-runtime/src/im/adapter.ts）
- 错误消息必须中英双语（userMessageZh + userMessageEn）
- 新 IM 适配器必须标注 capabilityLevel（L0/L1/L2）
- @octoclaw/cli 不能依赖 monorepo 内部相对路径
- shadow lane 失败绝不能影响 live dispatch（try/catch 包死）
- 不改 judge 的 3 字段 schema（route / confidence / complexity）

你的任务：
- 打开 openspec/changes/{包目录}/tasks.md
- 做完 {Phase X} 的 {任务编号} 这几项
- 每个任务做完后：
  1. 如果有对应 BDD 场景（见 bdd.md），把它转成 Vitest 测试
  2. 跑 pnpm check（0 error 0 new warning）
  3. 跑 pnpm test（全绿）
  4. commit，message 格式：
     feat(<scope>): <one-liner>
     
     - 关联任务: {包名} / Phase X / 任务编号
     - 关联 BDD: <场景 ID>（如有）
- 不要跨包，做完本包交回给我

如果遇到以下情况，STOP 找我：
- 需要改 IMAdapter 接口
- 需要改 judge schema
- 需要引入新的 npm 运行时依赖
- 需要改 OpenClaw 底层 API
- BDD 场景有歧义

当前 git 状态：v0.5.0 分支，已有前序工作（Auto Router shadow-bridge、
extension-entry 瘦身、死代码清理、CI 修复、router-v3 设计文档）。
你只负责 {包名}。
```

---

## 各包专用补充说明

### S1（npm 发包）

额外要读：
- `tools/octoclawctl/package.json`（当前包结构）
- `tools/octoclawctl/src/cli.ts`（CLI 入口，注册新命令的地方）

关键风险：
- `@octoclaw/policy` 等内部包如果被 CLI import，必须也发布到 npm 或 bundle 进 dist
- 向导用 `@inquirer/prompts`（ESM），不用 `inquirer` v8（CommonJS）
- `npm pack` 后在独立目录验证可运行

### S3（友好错误）

额外要读：
- `extensions/octoclaw-runtime/src/im/feishu/feishu-adapter.ts`（错误返回模式参考）
- `extensions/octoclaw-runtime/src/resolve/llm-judge.ts`（judge 调用路径）

关键风险：
- IM 适配器的 `send()` 返回 `IMSendResult`（不 throw），所以是改 `error` 字段的值，不是改成 throw
- judge 路径是 throw，policy-resolver 的 catch 要能处理 `OctoClawError`

### A2（稳定性）

额外要读：
- `extensions/octoclaw-runtime/src/im/slack/slack-adapter.ts`（Slack mock 模式）
- `extensions/octoclaw-runtime/src/router-lite/shadow-bridge.ts`（shadow 写入路径）
- `openspec/changes/runtime-timeout-watchdog-evidence-0.5.x/`（Phase 1 已做的内容）

关键风险：
- judge cooldown 只存内存（V1），进程重启后重置，这是预期行为
- `OCTOCLAW_DISABLE_HEALTH_GATES=1` 必须完全跳过 cooldown，方便 e2e 测试

### A3-Discord / A3-Telegram

额外要读：
- `extensions/octoclaw-runtime/src/im/wechat/wechat-adapter.ts`（最简单的适配器，作为模板）
- `extensions/octoclaw-runtime/src/im/index.ts`（注册方式）

关键风险：
- 新适配器通过 `openclaw message send --channel <channel>` 调用，不直接调 Discord/Telegram API
- `splitMessage()` 函数可以提取到 `im/utils.ts` 复用（Discord 2000 / Telegram 4096 / 飞书 4000）

---

## 验收清单（收到 PR 后必须全过）

- [ ] `pnpm check` 0 error 0 new warning
- [ ] `pnpm test` 全绿（对应 BDD 场景有新增测试）
- [ ] 没有出现 `throw new Error("...")` 在用户可见路径（应该用 `OctoClawError` 或 error code）
- [ ] 没有出现 `if (prompt.includes(...))` 关键词匹配
- [ ] 新 IM 适配器有 `capabilityLevel` 字段
- [ ] `@octoclaw/cli` 的 `dist/` 可以在独立目录运行（`npm pack` 验证）

---

## 什么时候回到我（用户）

1. 需要改 `IMAdapter` 接口 → 你来裁决
2. 需要引入新的 npm 运行时依赖 → 你来审批
3. BDD 场景有歧义 → 你来补充
4. 需要改 OpenClaw 底层 API → 跨系统变更，你来决定
5. 发现 tasks.md 有遗漏 → 列出来给你，不要默默补
6. 需要改 10 条硬约束中的任何一条 → 必须你同意
