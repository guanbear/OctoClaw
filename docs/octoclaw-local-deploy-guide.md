# OctoClaw 本机部署指南

## 项目结构

- **代码仓库**: `/Users/guanbear/OctoClaw` (开发目录)
- **部署仓库**: `/Users/guanbear/.openclaw/workspace/openclaw/repos/octoclaw` (git clone)
- **OpenClaw Home**: `/Users/guanbear/.openclaw`
- **Extension 部署目录**: `/Users/guanbear/.openclaw/extensions/octoclaw-runtime/`
- **octoclawctl**: `/Users/guanbear/.openclaw/workspace/openclaw/repos/octoclaw/tools/octoclawctl/dist/cli.js`

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
# 1. 在开发仓库 commit & push
cd /Users/guanbear/OctoClaw
git add -A && git commit -m "..." && git push

# 2. 在部署仓库 pull
cd /Users/guanbear/.openclaw/workspace/openclaw/repos/octoclaw
git stash  # 如果有本地修改
git pull --ff-only origin refactor/0.4.0-stable

# 3. Install + Build
pnpm install
pnpm -r run build

# 4. Deploy
node tools/octoclawctl/dist/cli.js deploy --skip-build --restart \
  --octoclaw-root /Users/guanbear/.openclaw/workspace/openclaw/repos/octoclaw \
  --openclaw-home /Users/guanbear/.openclaw
```

或者用一键脚本（需指定分支）：
```bash
bash bin/update-openclaw-macmini.sh \
  --repo-root /Users/guanbear/.openclaw/workspace/openclaw/repos/octoclaw \
  --openclaw-home /Users/guanbear/.openclaw \
  --branch refactor/0.4.0-stable
```

## 关键环境变量

| 变量 | 值 | 用途 |
|------|-----|------|
| `OCTOCLAW_RUNTIME_LEDGER` | `off` / `shadow` / `enforce` | Runtime ledger 模式 |
| `OCTOCLAW_SCHEDULER_ENABLED` | `true` / `false` | 调度器开关 |
| `OCTOCLAW_TASK_STATE_REBUILD` | `1` | 启用投影重建 |

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
  extensions/octoclaw-runtime/src/runtime-ledger/__tests__/operator-diagnostics.test.ts \
  extensions/octoclaw-runtime/src/tools/registration-dispatch-honesty.test.ts

# Ledger 模块测试
npx vitest run extensions/octoclaw-runtime/src/runtime-ledger/__tests__/
```

## 当前分支

`v0.5.0`

## 关键文件

| 文件 | 用途 |
|------|------|
| `extensions/octoclaw-runtime/src/tools/registration.ts` | 工具注册入口 (dispatch/status/task_action/crash_recovery) |
| `extensions/octoclaw-runtime/src/conversation-grounding.ts` | 意图分类 + 执行上下文 |
| `extensions/octoclaw-runtime/src/state/task-state-store.ts` | task-state.json 读写 + 损坏隔离 |
| `extensions/octoclaw-runtime/src/work-contract/store.ts` | WorkContract 存储 (SQLite metadata ledger + projection write) |
| `extensions/octoclaw-runtime/src/runtime-ledger/` | SQLite metadata ledger (WorkContract, native spawn intents, scheduler, tickets, runtime events) |
| `extensions/octoclaw-runtime/src/delegate/native-spawn-confirm.ts` | native spawn accepted evidence 绑定 |
| `extensions/octoclaw-runtime/src/state/native-status-projector.ts` | native lifecycle 到状态投影 |
| `docs/octoclaw-n1-runtime-ledger-repair-packet-2026-05-01.md` | N1 修复包 (P1/P2 清单) |
