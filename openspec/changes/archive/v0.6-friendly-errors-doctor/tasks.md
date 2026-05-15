# Tasks: 友好错误体系 + `octoclawctl doctor`

> ## Archive note
>
> Archived 2026-05-15. All three phases shipped.
>
> **Shipped (verified):**
>
> - Phase A: `packages/octoclaw-errors/` with `codes.ts` (22 error codes
>   including `IM_*`, `JUDGE_*`, `OPENCLAW_*`, `DISPATCH_*`, `ROUTER_*`),
>   `factory.ts`, `error.ts`, `index.ts`, plus `factory.test.ts` and
>   `error.test.ts`.
> - Phase B: `tools/octoclawctl/src/commands/doctor.ts` registered in
>   `cli.ts:59` and shown in `--help` at `cli.ts:1467`. Five health checks
>   covering Node version, OpenClaw, judge model, IM token, config
>   writability, with `--json` output.
> - Phase C: `Errors.judgeTimeout()` wired in
>   `extensions/octoclaw-runtime/src/resolve/llm-judge.ts:382`. Top-level
>   `uncaughtException` handler in `tools/octoclawctl/src/cli.ts`. IM
>   adapters use error codes for send failures.
>
> **Deferred:** None.

## Phase A — `OctoClawError` 基础（< 1 天）

### A1. 创建错误类
- [ ] 新建 `packages/octoclaw-errors/` 或 `packages/octoclaw-policy/src/errors/`
- [ ] 实现 `OctoClawError` 类（见 design.md §1）
- [ ] 实现 `isOctoClawError()` 工具函数
- [ ] `pnpm build` 通过

### A2. 错误码注册表
- [ ] 新建 `codes.ts`，定义 ≥ 20 个错误码（见 design.md §2）
- [ ] 新建 `factory.ts`，实现工厂函数（见 design.md §3）
- [ ] 至少实现：`imUnresolvableTarget` / `judgeTimeout` / `judgeParseFailure` / `openclawNotFound`
- [ ] 导出 `Errors` 对象

---

## Phase B — `octoclawctl doctor`（1 天）

### B1. doctor 命令骨架
- [ ] 新建 `tools/octoclawctl/src/commands/doctor.ts`
- [ ] 在 `cli.ts` 注册 `doctor` 命令
- [ ] `octoclawctl doctor --help` 输出正确

### B2. 5 项检测实现
- [ ] Node.js 版本检测（>= 22 pass，否则 fail）
- [ ] OpenClaw 检测（`openclaw --version`，超时 3s）
- [ ] Judge 模型可达性（未配置 → warn；配置了 → ping，超时 2s）
- [ ] IM token 有效性（未配置 → warn；配置了 → 验证）
- [ ] 配置文件可写（`fs.access` W_OK）

### B3. 输出格式
- [ ] 每项输出 ✅ / ⚠️ / ❌ + 名称 + 详情
- [ ] 底部输出汇总（X 通过，Y 警告，Z 失败）
- [ ] 退出码：有 fail → 1，否则 → 0
- [ ] `--json` flag：输出 JSON 格式（方便 AI agent 解析）

---

## Phase C — 关键路径替换（1 天）

### C1. IM 适配器
- [ ] `feishu-adapter.ts`：`unresolvable_session_target` → `Errors.imUnresolvableTarget(sessionKey).code`
- [ ] `wechat-adapter.ts`：同上
- [ ] `slack-adapter.ts`：send 失败路径的 error 字段改用 error code

### C2. Judge 路径
- [ ] `resolve/llm-judge.ts`：timeout 路径抛 `Errors.judgeTimeout(modelId, timeoutMs)`
- [ ] `resolve/llm-judge.ts`：parse 失败路径抛 `Errors.judgeParseFailure(raw)`
- [ ] 确认 judge fallback 仍然正常工作（抛错后 policy-resolver 的 catch 要能处理 `OctoClawError`）

### C3. CLI 全局错误处理
- [ ] `tools/octoclawctl/src/cli.ts` 加顶层 `uncaughtException` handler（见 design.md §5）
- [ ] 测试：故意触发一个 `OctoClawError`，确认输出格式正确

---

## Acceptance

- [ ] `OctoClawError` 类有 4 个必填字段，`toUserString()` 输出中英文
- [ ] 错误码注册表有 ≥ 20 个码
- [ ] `octoclawctl doctor` 不 crash，5 项都有输出
- [ ] `octoclawctl doctor --json` 输出合法 JSON
- [ ] IM 适配器 send 失败时 `error` 字段是 error code（不是 stack trace）
- [ ] `pnpm check && pnpm test` 全绿
