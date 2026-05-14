# Design: npm 发包 + `npx octoclaw init`

## 1. 包结构

`tools/octoclawctl/` 已经是独立 TypeScript 包，有自己的 `package.json`。需要做的改动：

```jsonc
// tools/octoclawctl/package.json 新增/修改
{
  "name": "@octoclaw/cli",
  "version": "0.6.0",
  "description": "OctoClaw CLI — install, configure, and operate OctoClaw",
  "bin": {
    "octoclawctl": "./dist/cli.js",
    "octoclaw": "./dist/cli.js"   // 短别名
  },
  "files": ["dist/", "README.md", "LICENSE"],
  "publishConfig": { "access": "public" }
}
```

`dist/` 由 `pnpm build` 生成（已有 tsconfig）。发布时只打包 `dist/` + README + LICENSE，不包含 `src/`。

## 2. `init` 向导架构

```
cli.ts
  └─ commands/
       └─ init.ts          ← 新文件，向导主流程
            ├─ steps/
            │    ├─ step-openclaw-check.ts   # Step 1
            │    ├─ step-judge-model.ts      # Step 2
            │    ├─ step-im-channel.ts       # Step 3
            │    ├─ step-im-token.ts         # Step 4
            │    └─ step-doctor-verify.ts    # Step 5
            └─ wizard-state.ts              # 向导状态类型
```

每个 step 是一个纯函数：

```typescript
interface WizardStep<T> {
  run(state: WizardState, opts: WizardOpts): Promise<T>;
  skip?(state: WizardState): boolean;  // 可选：条件跳过
}
```

`WizardOpts` 包含 `nonInteractive: boolean`（`--non-interactive` flag）和 `lang: "zh" | "en"`。

## 3. Step 1 — OpenClaw 检测

```typescript
// step-openclaw-check.ts
async function run(state, opts) {
  const result = await runCommand("openclaw", ["--version"], { timeoutMs: 3000 });
  if (result.code !== 0) {
    printError(opts.lang, {
      zh: "未检测到 OpenClaw。OctoClaw 需要 OpenClaw 才能运行。",
      en: "OpenClaw not found. OctoClaw requires OpenClaw to run.",
      hint: "https://github.com/openclaw/openclaw#installation",
      code: "OPENCLAW_NOT_FOUND",
    });
    process.exit(1);  // 硬退出，不继续
  }
  state.openclawVersion = parseVersion(result.stdout);
}
```

## 4. Step 2 — Judge 模型

交互式选择：

```
? Judge 模型（用于路由决策，不影响主 agent）
  ❯ 本地 Ollama — Qwen3 0.6B（免费，毫秒级，推荐）
    本地 Ollama — 自定义模型
    远端 endpoint — Groq（免费额度）
    远端 endpoint — 自定义 OpenAI-compatible URL
    跳过（稍后配置）
```

`--non-interactive` 时默认选"跳过"，写入 config 的 `judge.model = null`。

## 5. Step 3 — IM 渠道

多选（可选多个）：

```
? 选择 IM 渠道（空格多选，回车确认）
  ◯ Slack
  ◯ 飞书 (Feishu)
  ◯ Discord
  ◯ Telegram
  ◯ 微信 (WeChat)
  ◯ 跳过
```

## 6. Step 4 — IM Token 配置

按 Step 3 的选择，逐个引导：

**Slack**：
```
? Slack Bot Token (xoxb-...)
? Slack App Token (xapp-...) [可选，Socket Mode 用]
```

**飞书**：
```
? 飞书 App ID
? 飞书 App Secret
```

**Discord**：
```
? Discord Bot Token
? Discord Application ID
```

**Telegram**：
```
? Telegram Bot Token (从 @BotFather 获取)
```

每个 token 写入 `~/.openclaw/openclaw.json` 的 `channels.<channel>` 字段。

## 7. Step 5 — Doctor 验证

调用 `octoclawctl doctor`（见 `v0.6-friendly-errors-doctor`），输出 summary：

```
✅ OpenClaw v2026.4.29 — OK
✅ Node.js v22.14.0 — OK
✅ Judge: Ollama Qwen3 0.6B — 响应 42ms
✅ Slack token — 有效
⚠️  飞书 token — 未配置（可稍后配置）

初始化完成。运行 octoclawctl deploy 部署到 OpenClaw。
```

## 8. CI 发布流程

新文件 `.github/workflows/publish.yml`：

```yaml
on:
  push:
    tags: ['v0.6.*', 'v0.7.*']

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: '10.12.1' }
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          registry-url: 'https://registry.npmjs.org'
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm check
      - run: pnpm test
      - run: pnpm --filter @octoclaw/cli publish --no-git-checks
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

## 9. 关键约束

- `dist/cli.js` 必须是 ESM（`"type": "module"` 已有）
- 所有 `import` 必须用 `.js` 后缀（TypeScript ESM 规范）
- 不能 `require()` monorepo 内部包（发布后不存在）；所有依赖必须在 `dependencies` 里
- `@octoclaw/policy` 等内部包如果被 CLI 用到，必须也发布到 npm 或 bundle 进 dist
- 向导用 `@inquirer/prompts`（已是 ESM，轻量）；不用 `inquirer` v8（CommonJS）

## 10. 文件变更清单

| 文件 | 操作 |
|------|------|
| `tools/octoclawctl/package.json` | 改 name / 加 bin / 加 files / 加 publishConfig |
| `tools/octoclawctl/src/commands/init.ts` | 新建，向导主流程 |
| `tools/octoclawctl/src/commands/init/steps/*.ts` | 新建，5 个 step |
| `tools/octoclawctl/src/commands/init/wizard-state.ts` | 新建 |
| `.github/workflows/publish.yml` | 新建 |
| `README.md` / `README.zh-CN.md` | 更新安装 section |
