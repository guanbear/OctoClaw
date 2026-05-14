# BDD: npm 发包 + `npx octoclaw init`

Date: 2026-05-13
Related: `openspec/changes/v0.6-npm-cli-distribution/`

## 命名约定

- `CLI-I-*` CLI / Init 向导
- `CLI-P-*` CLI / 发包 + 可执行性
- `CLI-D-*` CLI / Doctor 集成

---

## CLI-P: 发包 + 可执行性

### CLI-P-001: npx 可执行

**Given** 一台全新机器，只安装了 Node.js 22 和 npm
**When** 运行 `npx @octoclaw/cli --version`
**Then** 输出版本号（格式 `x.y.z`）
**And** 退出码为 0

### CLI-P-002: 短别名可用

**Given** `@octoclaw/cli` 已全局安装
**When** 运行 `octoclaw --version`
**Then** 输出与 `octoclawctl --version` 相同的版本号

### CLI-P-003: 包不依赖 monorepo 路径

**Given** `@octoclaw/cli` 被 `npm pack` 打包后在独立目录解压
**When** 运行 `node dist/cli.js --help`
**Then** 不报 `Cannot find module` 错误
**And** 输出帮助文本

### CLI-P-004: ESM 兼容

**Given** Node.js 22（ESM 模式）
**When** `import('@octoclaw/cli')` 或 `node dist/cli.js`
**Then** 不报 `require is not defined` 或 `ERR_REQUIRE_ESM`

---

## CLI-I: Init 向导

### CLI-I-001: OpenClaw 未安装时硬退出

**Given** 系统上没有 `openclaw` 命令
**When** 运行 `npx @octoclaw/cli init`
**Then** 输出包含中文错误消息（含"OpenClaw"字样）
**And** 输出包含安装链接（`https://github.com/openclaw`）
**And** 退出码为 1
**And** 不继续执行后续步骤

### CLI-I-002: OpenClaw 已安装时继续

**Given** `openclaw --version` 返回退出码 0
**When** 运行 `npx @octoclaw/cli init --non-interactive`
**Then** 退出码为 0
**And** 不 crash

### CLI-I-003: 非交互模式跳过 IM 配置

**Given** OpenClaw 已安装
**When** 运行 `npx @octoclaw/cli init --non-interactive`
**Then** 不提示任何交互输入
**And** 退出码为 0
**And** 不修改已有的 IM token 配置

### CLI-I-004: 非交互模式 judge 默认跳过

**Given** OpenClaw 已安装
**When** 运行 `npx @octoclaw/cli init --non-interactive`
**Then** `~/.openclaw/openclaw.json` 的 `judge.model` 为 `null` 或保持原值（不覆盖已有配置）

### CLI-I-005: Slack token 写入配置

**Given** 用户在 Step 4 输入 Slack Bot Token `xoxb-test-token`
**When** 向导完成
**Then** `~/.openclaw/openclaw.json` 的 `channels.slack.token` 为 `xoxb-test-token`

### CLI-I-006: 无效 token 格式给出提示

**Given** 用户在 Slack token 输入框输入 `not-a-token`（不以 `xoxb-` 开头）
**When** 按回车确认
**Then** 输出格式警告（"Slack Bot Token 通常以 xoxb- 开头"）
**And** 允许用户继续（不强制退出，只是警告）

### CLI-I-007: Step 5 调用 doctor

**Given** 向导 Step 1-4 完成
**When** 进入 Step 5
**Then** 调用 `octoclawctl doctor`（或内部等价逻辑）
**And** 输出每项检测的 pass / warn / fail 状态
**And** 向导结束时输出 "运行 octoclawctl deploy 部署到 OpenClaw"

### CLI-I-008: Ollama 未安装时给出提示

**Given** 用户在 Step 2 选择 "本地 Ollama — Qwen3 0.6B"
**And** 系统上没有 `ollama` 命令
**When** 步骤执行
**Then** 输出提示（"未检测到 Ollama，请先安装：https://ollama.com"）
**And** 继续向导（不退出，Ollama 可以稍后安装）

### CLI-I-009: 已有配置不被覆盖

**Given** `~/.openclaw/openclaw.json` 已有 `channels.slack.token = "xoxb-existing"`
**And** 用户在 Step 3 跳过 Slack
**When** 向导完成
**Then** `channels.slack.token` 仍为 `"xoxb-existing"`（未被清空）

### CLI-I-010: `--lang en` 输出英文

**Given** 运行 `npx @octoclaw/cli init --non-interactive --lang en`
**When** 输出任何消息
**Then** 消息为英文（不含中文字符）

---

## CLI-D: Doctor 集成

### CLI-D-001: doctor 不 throw

**Given** 任意配置状态（包括完全未配置）
**When** 运行 `octoclawctl doctor`
**Then** 命令不 throw / crash
**And** 输出每项检测结果
**And** 退出码：全部 pass → 0，有 warn → 0，有 fail → 1

### CLI-D-002: doctor 检测 5 项

**Given** 运行 `octoclawctl doctor`
**Then** 输出至少包含以下 5 项检测：
  - Node.js 版本
  - OpenClaw 是否安装
  - Judge 模型是否可达（如已配置）
  - IM token 是否有效（如已配置）
  - 配置文件是否可写

---

## Test 文件位置

```
tools/octoclawctl/src/
  __tests__/
    init/
      step-openclaw-check.test.ts    # CLI-I-001, CLI-I-002
      step-judge-model.test.ts       # CLI-I-003, CLI-I-004, CLI-I-008
      step-im-token.test.ts          # CLI-I-005, CLI-I-006, CLI-I-009
      step-doctor-verify.test.ts     # CLI-I-007
      wizard-lang.test.ts            # CLI-I-010
    publish/
      package-integrity.test.ts      # CLI-P-001, CLI-P-003, CLI-P-004
    doctor/
      doctor.test.ts                 # CLI-D-001, CLI-D-002
```

## 运行测试

```bash
pnpm --filter @octoclaw/cli test
```

所有场景必须通过才能发布 v0.6.0。
