# Change: npm 发包 + `npx octoclaw init`

Date: 2026-05-13
Target release: v0.6.0
Design reference: `openspec/changes/v0.6-npm-cli-distribution/design.md`

## Purpose

让任何人（包括 AI agent）能用一行命令安装并初始化 OctoClaw，不需要 clone 仓库、不需要 pnpm、不需要手动配置。

```bash
npx @octoclaw/cli init
```

## Problem

现在的安装方式是开发者流程：

```bash
git clone ...
pnpm install
pnpm build
node tools/octoclawctl/dist/cli.js install
```

这对开源用户来说门槛太高。AI agent（Codex、Claude Code 等）也无法自动安装。

## Scope

**V1 交付**：

1. `tools/octoclawctl` 发布为 `@octoclaw/cli` npm 包（public，MIT）
2. `package.json` 的 `bin` 字段指向 `dist/cli.js`，支持 `npx @octoclaw/cli <cmd>`
3. `octoclawctl init` 交互向导（5 步）：
   - Step 1：检测 OpenClaw 是否已安装（必须，否则退出并给安装链接）
   - Step 2：选择 judge 模型（Ollama 本地 / 远端 endpoint）
   - Step 3：选择 IM 渠道（Slack / 飞书 / Discord / Telegram / 跳过）
   - Step 4：配置 IM token（按选择的渠道引导）
   - Step 5：运行 `octoclawctl doctor` 验证配置，输出 summary
4. `octoclawctl install` / `deploy` / `enable` 命令保持不变（已有）
5. CI 自动发布：push `v0.6.*` tag → GitHub Actions → `npm publish`
6. README 安装 section 改成 `npx` 流程

## Non-Goals

- Docker 镜像（不做）
- macOS / Linux install.sh（不做）
- Windows 支持（暂不测试，不阻塞）
- 向导 GUI（CLI 交互就够）

## Acceptance Gate

- [ ] `npx @octoclaw/cli --version` 在全新机器上输出版本号
- [ ] `npx @octoclaw/cli init` 5 步向导跑完不 crash
- [ ] 向导 Step 1 检测到 OpenClaw 未安装时，输出友好提示 + 链接，退出码 1
- [ ] 向导 Step 5 调用 `doctor` 并输出 pass/fail summary
- [ ] `pnpm check && pnpm test` 全绿
- [ ] GitHub Actions `publish.yml` 在 tag push 后成功发布到 npm

## Hard Invariants

1. `npx @octoclaw/cli` 不能依赖 monorepo 内部相对路径（必须能独立解压到 `node_modules` 跑）
2. 向导必须可以 `--non-interactive` 跳过（方便 AI agent 用 flag 传参）
3. 向导 Step 1 如果 OpenClaw 未安装，**必须退出**，不能继续（OctoClaw 没有 OpenClaw 就不成立）
4. 所有 CLI 输出必须中英双语（`--lang zh` / `--lang en`，默认跟系统 locale）
