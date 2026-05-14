# Design: 友好错误体系 + `octoclawctl doctor`

## 1. `OctoClawError` 类

新包 `packages/octoclaw-errors/`（或直接放 `packages/octoclaw-policy/src/errors/`，视包大小决定）：

```typescript
export class OctoClawError extends Error {
  readonly code: string;
  readonly userMessageZh: string;
  readonly userMessageEn: string;
  readonly actionableHint?: string;
  readonly cause?: unknown;

  constructor(opts: {
    code: string;
    userMessageZh: string;
    userMessageEn: string;
    actionableHint?: string;
    cause?: unknown;
  }) {
    super(opts.userMessageEn);
    this.name = "OctoClawError";
    this.code = opts.code;
    this.userMessageZh = opts.userMessageZh;
    this.userMessageEn = opts.userMessageEn;
    this.actionableHint = opts.actionableHint;
    this.cause = opts.cause;
  }

  toUserString(lang: "zh" | "en" = "zh"): string {
    const msg = lang === "zh" ? this.userMessageZh : this.userMessageEn;
    const hint = this.actionableHint ? `\n  → ${this.actionableHint}` : "";
    return `[${this.code}] ${msg}${hint}`;
  }

  toJSON() {
    return {
      code: this.code,
      messageZh: this.userMessageZh,
      messageEn: this.userMessageEn,
      hint: this.actionableHint,
    };
  }
}

export function isOctoClawError(e: unknown): e is OctoClawError {
  return e instanceof OctoClawError;
}
```

## 2. 错误码注册表

`packages/octoclaw-errors/src/codes.ts`：

```typescript
export const ERROR_CODES = {
  // IM 适配器
  IM_UNRESOLVABLE_TARGET:    "IM_UNRESOLVABLE_TARGET",
  IM_SEND_FAILED:            "IM_SEND_FAILED",
  IM_TOKEN_INVALID:          "IM_TOKEN_INVALID",
  IM_TOKEN_MISSING:          "IM_TOKEN_MISSING",
  IM_CHANNEL_NOT_CONFIGURED: "IM_CHANNEL_NOT_CONFIGURED",
  IM_MESSAGE_TOO_LONG:       "IM_MESSAGE_TOO_LONG",
  IM_RATE_LIMITED:           "IM_RATE_LIMITED",
  IM_TIMEOUT:                "IM_TIMEOUT",

  // Judge
  JUDGE_TIMEOUT:             "JUDGE_TIMEOUT",
  JUDGE_PARSE_FAILED:        "JUDGE_PARSE_FAILED",
  JUDGE_MODEL_NOT_CONFIGURED:"JUDGE_MODEL_NOT_CONFIGURED",
  JUDGE_COOLDOWN:            "JUDGE_COOLDOWN",
  JUDGE_ENDPOINT_UNREACHABLE:"JUDGE_ENDPOINT_UNREACHABLE",

  // OpenClaw
  OPENCLAW_NOT_FOUND:        "OPENCLAW_NOT_FOUND",
  OPENCLAW_CONFIG_UNREADABLE:"OPENCLAW_CONFIG_UNREADABLE",
  OPENCLAW_CONFIG_UNWRITABLE:"OPENCLAW_CONFIG_UNWRITABLE",

  // Dispatch
  DISPATCH_ADMISSION_DENIED: "DISPATCH_ADMISSION_DENIED",
  DISPATCH_NO_ELIGIBLE_MODEL:"DISPATCH_NO_ELIGIBLE_MODEL",
  DISPATCH_TIMEOUT:          "DISPATCH_TIMEOUT",

  // Router
  ROUTER_SNAPSHOT_MISSING:   "ROUTER_SNAPSHOT_MISSING",
  ROUTER_SNAPSHOT_STALE:     "ROUTER_SNAPSHOT_STALE",
} as const;

export type ErrorCode = typeof ERROR_CODES[keyof typeof ERROR_CODES];
```

## 3. 错误工厂函数

每个错误码对应一个工厂函数，避免每次都写 zh/en 两遍：

```typescript
// packages/octoclaw-errors/src/factory.ts
import { OctoClawError } from "./error.js";

export const Errors = {
  imUnresolvableTarget: (sessionKey: string) => new OctoClawError({
    code: "IM_UNRESOLVABLE_TARGET",
    userMessageZh: `无法解析会话目标：${sessionKey}`,
    userMessageEn: `Cannot resolve delivery target for session: ${sessionKey}`,
    actionableHint: "检查 sessionKey 格式是否正确，例如 slack:C123:U456:ts789",
  }),

  judgeTimeout: (modelId: string, timeoutMs: number) => new OctoClawError({
    code: "JUDGE_TIMEOUT",
    userMessageZh: `Judge 模型 ${modelId} 超时（${timeoutMs}ms）`,
    userMessageEn: `Judge model ${modelId} timed out after ${timeoutMs}ms`,
    actionableHint: "检查 Ollama 是否运行，或切换到远端 judge endpoint",
  }),

  judgeParseFailure: (raw: string) => new OctoClawError({
    code: "JUDGE_PARSE_FAILED",
    userMessageZh: "Judge 返回了非 JSON 格式，已使用 fallback 规则",
    userMessageEn: "Judge returned non-JSON output, using fallback rules",
    actionableHint: `原始输出：${raw.slice(0, 100)}`,
  }),

  openclawNotFound: () => new OctoClawError({
    code: "OPENCLAW_NOT_FOUND",
    userMessageZh: "未检测到 OpenClaw。OctoClaw 需要 OpenClaw 才能运行。",
    userMessageEn: "OpenClaw not found. OctoClaw requires OpenClaw to run.",
    actionableHint: "安装 OpenClaw：https://github.com/openclaw/openclaw#installation",
  }),

  // ... 其余工厂函数
};
```

## 4. `octoclawctl doctor` 命令

```typescript
// tools/octoclawctl/src/commands/doctor.ts

interface DoctorCheck {
  name: string;
  nameZh: string;
  run(): Promise<DoctorResult>;
}

interface DoctorResult {
  status: "pass" | "warn" | "fail";
  detail?: string;
  hint?: string;
}

const CHECKS: DoctorCheck[] = [
  {
    name: "Node.js version",
    nameZh: "Node.js 版本",
    async run() {
      const v = process.version;  // e.g. "v22.14.0"
      const major = parseInt(v.slice(1));
      if (major >= 22) return { status: "pass", detail: v };
      return { status: "fail", detail: v, hint: "需要 Node.js >= 22" };
    },
  },
  {
    name: "OpenClaw",
    nameZh: "OpenClaw",
    async run() {
      const r = await runCommand("openclaw", ["--version"], { timeoutMs: 3000 });
      if (r.code === 0) return { status: "pass", detail: r.stdout.trim() };
      return { status: "fail", hint: "安装 OpenClaw：https://github.com/openclaw/openclaw" };
    },
  },
  {
    name: "Judge model reachability",
    nameZh: "Judge 模型可达性",
    async run() {
      const config = readJudgeConfig();
      if (!config.model) return { status: "warn", detail: "未配置", hint: "运行 octoclawctl init 配置 judge 模型" };
      // 发一个 ping 请求
      const ok = await pingJudgeModel(config);
      if (ok) return { status: "pass", detail: `${config.model} 响应正常` };
      return { status: "fail", hint: "检查 Ollama 是否运行，或 endpoint 是否可达" };
    },
  },
  {
    name: "IM token validity",
    nameZh: "IM token 有效性",
    async run() {
      const channels = readConfiguredChannels();
      if (channels.length === 0) return { status: "warn", detail: "未配置任何 IM 渠道" };
      const results = await Promise.all(channels.map(validateChannelToken));
      const failed = results.filter(r => !r.ok);
      if (failed.length === 0) return { status: "pass", detail: channels.join(", ") };
      return { status: "fail", detail: failed.map(r => r.channel).join(", "), hint: "检查 token 是否过期" };
    },
  },
  {
    name: "Config file writable",
    nameZh: "配置文件可写",
    async run() {
      const configPath = getOpenclawConfigPath();
      try {
        await fs.access(configPath, fs.constants.W_OK);
        return { status: "pass", detail: configPath };
      } catch {
        return { status: "fail", detail: configPath, hint: `chmod 644 ${configPath}` };
      }
    },
  },
];
```

输出格式：

```
OctoClaw Doctor
───────────────────────────────────────
✅ Node.js 版本          v22.14.0
✅ OpenClaw              v2026.4.29
✅ Judge 模型可达性      Ollama Qwen3 0.6B — 42ms
⚠️  IM token 有效性      未配置任何 IM 渠道
   → 运行 octoclawctl init 配置 IM 渠道
✅ 配置文件可写          ~/.openclaw/openclaw.json
───────────────────────────────────────
结果：4 通过，1 警告，0 失败
```

退出码：全部 pass → 0，有 warn → 0，有 fail → 1。

## 5. CLI 全局错误处理

`tools/octoclawctl/src/cli.ts` 顶层：

```typescript
process.on("uncaughtException", (err) => {
  if (isOctoClawError(err)) {
    console.error(err.toUserString(detectLang()));
  } else {
    console.error("[UNEXPECTED]", err.message);
    console.error("请提交 issue：https://github.com/guanbear/OctoClaw/issues");
  }
  process.exit(1);
});
```

## 6. 关键路径替换清单

| 文件 | 替换点 |
|------|--------|
| `im/feishu/feishu-adapter.ts` | `return { error: "unresolvable_session_target" }` → `Errors.imUnresolvableTarget(sessionKey)` |
| `im/wechat/wechat-adapter.ts` | 同上 |
| `im/slack/slack-adapter.ts` | send 失败路径 |
| `resolve/llm-judge.ts` | timeout / parse failure |
| `tools/octoclawctl/src/cli.ts` | 顶层 catch |

注意：IM 适配器的 `send` 返回 `IMSendResult`（不 throw），所以是把 `error` 字段从字符串改成 `OctoClawError.toJSON()` 的 code 字段，而不是 throw。
