# OctoClaw 本机部署指南

## 项目结构

- **代码/部署仓库（canonical）**: `/Users/guanbear/workspace/OctoClaw`
- **兼容旧路径**: `/Users/guanbear/OctoClaw`、`/Users/guanbear/octoclaw_stable`、`/Users/guanbear/repos/octoclaw`、`/Users/guanbear/.openclaw/workspace/openclaw/repos/octoclaw` 均应为指向 canonical 仓库的 symlink
- **OpenClaw Home**: `/Users/guanbear/.openclaw`
- **Extension 部署目录**: `/Users/guanbear/.openclaw/extensions/octoclaw-runtime/`
- **octoclawctl**: `/Users/guanbear/workspace/OctoClaw/tools/octoclawctl/dist/cli.js`

## 架构

OctoClaw 是 OpenClaw 的 extension plugin：
- `packages/octoclaw-contracts` — 共享类型和接口
- `packages/octoclaw-policy` — policy/judge 相关逻辑
- `extensions/octoclaw-runtime` — 核心运行时 (dispatch, status, retry, scheduler, ledger)
- `extensions/octoclaw-status-surface` — Status Surface UI
- `tools/octoclawctl` — CLI 管理工具

monorepo，用 pnpm workspace，TypeScript，vitest 测试，node:sqlite (不用 better-sqlite3)。

## 部署流程

```bash
# 1. 在 canonical 仓库 commit & push
cd /Users/guanbear/workspace/OctoClaw
git add -A && git commit -m "..." && git push

# 2. 更新 canonical 仓库
cd /Users/guanbear/workspace/OctoClaw
git stash  # 如果有本地修改
git pull --ff-only origin v0.6.0

# 3. Install + Build
pnpm install
pnpm -r run build

# 4. Deploy
node tools/octoclawctl/dist/cli.js deploy --skip-build --restart \
  --octoclaw-root /Users/guanbear/workspace/OctoClaw \
  --openclaw-home /Users/guanbear/.openclaw
```

或者用一键脚本（需指定分支）：
```bash
bash bin/update-openclaw-macmini.sh \
  --repo-root /Users/guanbear/workspace/OctoClaw \
  --openclaw-home /Users/guanbear/.openclaw \
  --branch v0.6.0
```

## 关键环境变量

| 变量 | 值 | 用途 |
|------|-----|------|
| `OCTOCLAW_RUNTIME_LEDGER` | `off` / `shadow` / `enforce` | Runtime ledger 模式 |
| `OCTOCLAW_SCHEDULER_ENABLED` | `true` / `false` | 调度器开关 |

## 验证

```bash
# TypeScript 检查
npx tsc --noEmit --project extensions/octoclaw-runtime/tsconfig.json

# 全量测试
npx vitest run extensions/octoclaw-runtime/src/

# Repair packet 验证命令集
npx vitest run \
  extensions/octoclaw-runtime/src/conversation-grounding.test.ts \
  extensions/octoclaw-runtime/src/resolve/policy-resolver-judge-fallback.test.ts \
  extensions/octoclaw-runtime/src/runtime-ledger/__tests__/ticket-dry-run.test.ts \
  extensions/octoclaw-runtime/src/runtime-ledger/__tests__/ticket-enforcement.test.ts \
  extensions/octoclaw-runtime/src/runtime-ledger/__tests__/scheduler.test.ts \
  extensions/octoclaw-runtime/src/tools/registration-dispatch-honesty.test.ts

# Ledger 模块测试
npx vitest run extensions/octoclaw-runtime/src/runtime-ledger/__tests__/

# 部署后稳定性报告复查
node tools/octoclawctl/dist/cli.js stability review-latest \
  --output-dir /Users/guanbear/.openclaw/reports

# 有 Slack acceptance 凭据时，跑真实 post-deploy smoke
set -a
source /Users/guanbear/.openclaw/octoclaw-slack-acceptance.env
set +a
node tools/octoclawctl/dist/cli.js stability post-deploy \
  --config /Users/guanbear/.openclaw/octoclaw-slack-acceptance-config.json \
  --output-dir /Users/guanbear/.openclaw/reports \
  --format json
```

## 当前分支

`v0.6.0`

## 关键文件

| 文件 | 用途 |
|------|------|
| `extensions/octoclaw-runtime/src/tools/registration.ts` | 工具注册入口 (dispatch/status/task_action) |
| `extensions/octoclaw-runtime/src/conversation-grounding.ts` | 意图分类 + 执行上下文 |
| `extensions/octoclaw-runtime/src/state/task-state-store.ts` | task-state.json 读写 + 损坏隔离 |
| `extensions/octoclaw-runtime/src/work-contract/store.ts` | WorkContract 存储 (SQLite metadata ledger + projection write) |
| `extensions/octoclaw-runtime/src/runtime-ledger/` | SQLite metadata ledger (WorkContract, native spawn intents, scheduler, tickets, runtime events) |
| `extensions/octoclaw-runtime/src/delegate/native-spawn-confirm.ts` | native spawn accepted evidence 绑定 |
| `extensions/octoclaw-runtime/src/state/native-status-projector.ts` | native lifecycle 到状态投影 |
| `docs/octoclaw-n1-runtime-ledger-repair-packet-2026-05-01.md` | N1 修复包 (P1/P2 清单) |
