# BDD: 友好错误体系 + `octoclawctl doctor`

Date: 2026-05-13

## 命名约定

- `ERR-C-*` Error / Class
- `ERR-D-*` Error / Doctor
- `ERR-P-*` Error / Path replacement

---

## ERR-C: OctoClawError 类

### ERR-C-001: 4 个必填字段

**Given** `new OctoClawError({ code, userMessageZh, userMessageEn, actionableHint })`
**Then** 实例有 `code` / `userMessageZh` / `userMessageEn` / `actionableHint` 字段
**And** `isOctoClawError(instance)` 返回 `true`

### ERR-C-002: toUserString zh

**Given** 一个 `OctoClawError`，`userMessageZh = "未检测到 OpenClaw"`，`actionableHint = "安装链接"`
**When** `err.toUserString("zh")`
**Then** 返回包含 `[OPENCLAW_NOT_FOUND]` 和 `未检测到 OpenClaw` 和 `安装链接` 的字符串

### ERR-C-003: toUserString en

**Given** 同上
**When** `err.toUserString("en")`
**Then** 返回包含 `[OPENCLAW_NOT_FOUND]` 和 `OpenClaw not found` 的字符串（不含中文）

### ERR-C-004: toJSON 可序列化

**Given** 一个 `OctoClawError`
**When** `JSON.stringify(err.toJSON())`
**Then** 不 throw，输出合法 JSON，包含 `code` / `messageZh` / `messageEn` 字段

### ERR-C-005: isOctoClawError 区分普通 Error

**Given** `new Error("plain error")`
**When** `isOctoClawError(err)`
**Then** 返回 `false`

---

## ERR-D: Doctor 命令

### ERR-D-001: 不 crash

**Given** 任意配置状态（包括完全未配置）
**When** `octoclawctl doctor`
**Then** 不 throw / crash
**And** 输出 5 项检测结果

### ERR-D-002: Node.js 版本 pass

**Given** Node.js >= 22
**When** `octoclawctl doctor`
**Then** Node.js 检测项输出 ✅

### ERR-D-003: Node.js 版本 fail

**Given** Node.js < 22（mock）
**When** `octoclawctl doctor`
**Then** Node.js 检测项输出 ❌
**And** 退出码为 1

### ERR-D-004: OpenClaw 未安装 fail

**Given** `openclaw` 命令不存在（mock）
**When** `octoclawctl doctor`
**Then** OpenClaw 检测项输出 ❌
**And** 输出包含安装链接

### ERR-D-005: Judge 未配置 warn

**Given** `~/.openclaw/openclaw.json` 中 `judge.model` 为 null 或不存在
**When** `octoclawctl doctor`
**Then** Judge 检测项输出 ⚠️
**And** 退出码为 0（warn 不算 fail）

### ERR-D-006: IM 未配置 warn

**Given** 没有配置任何 IM 渠道
**When** `octoclawctl doctor`
**Then** IM 检测项输出 ⚠️
**And** 退出码为 0

### ERR-D-007: 全部 pass 退出码 0

**Given** 所有检测项都 pass
**When** `octoclawctl doctor`
**Then** 退出码为 0
**And** 底部输出 "X 通过，0 警告，0 失败"

### ERR-D-008: 有 fail 退出码 1

**Given** 至少一项检测 fail
**When** `octoclawctl doctor`
**Then** 退出码为 1

### ERR-D-009: --json 输出合法 JSON

**Given** 运行 `octoclawctl doctor --json`
**When** 解析 stdout
**Then** 是合法 JSON，包含 `checks` 数组，每项有 `name` / `status` / `detail`

---

## ERR-P: 关键路径替换

### ERR-P-001: IM send 失败返回 error code

**Given** `FeishuAdapter.send()` 因 `unresolvable_session_target` 失败
**When** 检查返回值的 `error` 字段
**Then** 值为 `"IM_UNRESOLVABLE_TARGET"`（不是 stack trace，不是原始 Error 消息）

### ERR-P-002: Judge timeout 抛 OctoClawError

**Given** judge endpoint 超时
**When** `llm-judge.ts` 的 timeout 路径触发
**Then** 抛出 `OctoClawError`，`code = "JUDGE_TIMEOUT"`
**And** policy-resolver 的 catch 能处理，fallback 正常工作

### ERR-P-003: Judge parse failure 抛 OctoClawError

**Given** judge 返回非 JSON 字符串
**When** parse 失败
**Then** 抛出 `OctoClawError`，`code = "JUDGE_PARSE_FAILED"`
**And** fallback 规则被使用，`router_judge_fallback` 事件被 emit

---

## Test 文件位置

```
packages/octoclaw-errors/src/
  __tests__/
    error.test.ts          # ERR-C-001..005
    factory.test.ts        # 工厂函数单测

tools/octoclawctl/src/
  __tests__/
    doctor.test.ts         # ERR-D-001..009

extensions/octoclaw-runtime/src/
  im/feishu/
    feishu-adapter.test.ts # ERR-P-001（已有，补 error code 断言）
  resolve/
    llm-judge.test.ts      # ERR-P-002, ERR-P-003
```
