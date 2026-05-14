# Tasks: npm 发包 + `npx octoclaw init`

每个任务 < 4h。按顺序做，Phase A 完成后才能做 Phase B。

## Phase A — 包配置（< 1 天）

### A1. 修改 `tools/octoclawctl/package.json`
- [ ] 改 `name` 为 `@octoclaw/cli`
- [ ] 加 `bin: { "octoclawctl": "./dist/cli.js", "octoclaw": "./dist/cli.js" }`
- [ ] 加 `files: ["dist/", "README.md", "LICENSE"]`
- [ ] 加 `publishConfig: { "access": "public" }`
- [ ] 确认 `dependencies` 里没有 monorepo 内部相对路径（`workspace:*` 的包要么发布要么 bundle）
- [ ] `pnpm build` 通过

### A2. 验证 `dist/cli.js` 可独立运行
- [ ] `node tools/octoclawctl/dist/cli.js --version` 输出版本号
- [ ] `node tools/octoclawctl/dist/cli.js --help` 输出帮助
- [ ] 在临时目录 `npm pack` + `npm install` 验证包可解压运行

---

## Phase B — `init` 向导（2-3 天）

### B1. 向导骨架
- [ ] 新建 `tools/octoclawctl/src/commands/init.ts`（主流程，串联 5 个 step）
- [ ] 新建 `tools/octoclawctl/src/commands/init/wizard-state.ts`（`WizardState` 类型）
- [ ] 新建 `tools/octoclawctl/src/commands/init/wizard-opts.ts`（`WizardOpts` 类型，含 `nonInteractive` / `lang`）
- [ ] 在 `cli.ts` 注册 `init` 命令
- [ ] `octoclawctl init --help` 输出正确

### B2. Step 1 — OpenClaw 检测
- [ ] 新建 `steps/step-openclaw-check.ts`
- [ ] 检测 `openclaw --version`，超时 3s
- [ ] 未检测到：输出中英双语错误 + 安装链接，`process.exit(1)`
- [ ] 检测到：输出版本号，继续
- [ ] `--non-interactive` 下行为一致（不需要交互，但检测逻辑相同）

### B3. Step 2 — Judge 模型选择
- [ ] 新建 `steps/step-judge-model.ts`
- [ ] 交互式：5 个选项（见 design.md §4）
- [ ] `--non-interactive`：默认跳过，写 `judge.model = null`
- [ ] 选 Ollama 时：检测 `ollama list` 是否有 qwen3:0.6b，没有则提示 `ollama pull qwen3:0.6b`
- [ ] 选远端 endpoint 时：提示输入 URL + API key（可选）
- [ ] 写入 `~/.openclaw/openclaw.json` 的 `judge` 字段

### B4. Step 3 + 4 — IM 渠道 + Token
- [ ] 新建 `steps/step-im-channel.ts`（多选）
- [ ] 新建 `steps/step-im-token.ts`（按选择逐个引导）
- [ ] Slack：引导输入 `xoxb-` token + 可选 `xapp-` token
- [ ] 飞书：引导输入 App ID + App Secret
- [ ] Discord：引导输入 Bot Token + Application ID
- [ ] Telegram：引导输入 Bot Token
- [ ] 微信：引导输入 App ID + App Secret
- [ ] 每个 token 写入 `~/.openclaw/openclaw.json` 的 `channels.<channel>` 字段
- [ ] `--non-interactive`：跳过所有 IM 配置

### B5. Step 5 — Doctor 验证
- [ ] 新建 `steps/step-doctor-verify.ts`
- [ ] 调用 `octoclawctl doctor`（见 `v0.6-friendly-errors-doctor`）
- [ ] 输出 pass/warn/fail summary（见 design.md §7）
- [ ] 如果 doctor 未实现，输出 "配置已保存，运行 octoclawctl doctor 验证"

---

## Phase C — CI 发布（< 1 天）

### C1. GitHub Actions publish workflow
- [ ] 新建 `.github/workflows/publish.yml`（见 design.md §8）
- [ ] 在 GitHub repo Settings → Secrets 添加 `NPM_TOKEN`（由用户手动操作，文档说明）
- [ ] 在 README 里说明如何获取 npm token 并配置

### C2. 版本管理
- [ ] 确认 `tools/octoclawctl/package.json` 的 `version` 和 `version.txt` 同步
- [ ] 在 `CHANGELOG.md` 里加 v0.6.0 条目

---

## Phase D — README 更新（< 0.5 天）

### D1. 更新安装 section
- [ ] `README.md` 安装 section 改成 `npx @octoclaw/cli init`
- [ ] `README.zh-CN.md` 同步
- [ ] 保留 "开发者安装" 折叠 section（`pnpm install` 流程）

---

## Acceptance

- [ ] `npx @octoclaw/cli --version` 在全新机器上输出版本号
- [ ] `npx @octoclaw/cli init` 5 步向导跑完不 crash
- [ ] `npx @octoclaw/cli init --non-interactive` 跑完不 crash，退出码 0（OpenClaw 已装时）
- [ ] Step 1 检测到 OpenClaw 未安装时，退出码 1，输出包含安装链接
- [ ] `pnpm check && pnpm test` 全绿
