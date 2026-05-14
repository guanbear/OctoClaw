import { ERROR_CODES } from "./codes.js";
import { OctoClawError } from "./error.js";

export const Errors = {
  imUnresolvableTarget: (sessionKey: string) =>
    new OctoClawError({
      code: ERROR_CODES.IM_UNRESOLVABLE_TARGET,
      userMessageZh: `无法解析会话目标：${sessionKey}`,
      userMessageEn: `Cannot resolve delivery target for session: ${sessionKey}`,
      actionableHint: "检查 sessionKey 格式是否正确，例如 slack:C123:U456:ts789",
    }),

  imSendFailed: (channel: string, detail: string) =>
    new OctoClawError({
      code: ERROR_CODES.IM_SEND_FAILED,
      userMessageZh: `${channel} 消息发送失败：${detail}`,
      userMessageEn: `${channel} message delivery failed: ${detail}`,
      actionableHint: "检查 IM 渠道配置、网络连接和平台 API 返回的错误详情",
    }),

  imTokenInvalid: (channel: string) =>
    new OctoClawError({
      code: ERROR_CODES.IM_TOKEN_INVALID,
      userMessageZh: `${channel} token 无效或已过期`,
      userMessageEn: `${channel} token is invalid or expired`,
      actionableHint: "重新生成 token，并更新 OpenClaw/OctoClaw 的 IM 配置",
    }),

  imTokenMissing: (channel: string) =>
    new OctoClawError({
      code: ERROR_CODES.IM_TOKEN_MISSING,
      userMessageZh: `缺少 ${channel} token`,
      userMessageEn: `${channel} token is missing`,
      actionableHint: "在配置文件或环境变量中补充对应 IM 渠道的 token",
    }),

  imChannelNotConfigured: (channel: string) =>
    new OctoClawError({
      code: ERROR_CODES.IM_CHANNEL_NOT_CONFIGURED,
      userMessageZh: `IM 渠道未配置：${channel}`,
      userMessageEn: `IM channel is not configured: ${channel}`,
      actionableHint: "运行 octoclawctl init 或手动添加该 IM 渠道配置",
    }),

  judgeTimeout: (modelId: string, timeoutMs: number) =>
    new OctoClawError({
      code: ERROR_CODES.JUDGE_TIMEOUT,
      userMessageZh: `Judge 模型 ${modelId} 超时（${timeoutMs}ms）`,
      userMessageEn: `Judge model ${modelId} timed out after ${timeoutMs}ms`,
      actionableHint: "检查 Ollama 是否运行，或切换到远端 judge endpoint",
    }),

  judgeParseFailed: (raw: string) =>
    new OctoClawError({
      code: ERROR_CODES.JUDGE_PARSE_FAILED,
      userMessageZh: "Judge 返回了非 JSON 格式，已使用 fallback 规则",
      userMessageEn: "Judge returned non-JSON output, using fallback rules",
      actionableHint: `原始输出：${raw.slice(0, 100)}`,
    }),

  judgeModelNotConfigured: () =>
    new OctoClawError({
      code: ERROR_CODES.JUDGE_MODEL_NOT_CONFIGURED,
      userMessageZh: "未配置 Judge 模型",
      userMessageEn: "Judge model is not configured",
      actionableHint: "运行 octoclawctl init 配置本地或远端 judge 模型",
    }),

  judgeCooldown: (modelId: string) =>
    new OctoClawError({
      code: ERROR_CODES.JUDGE_COOLDOWN,
      userMessageZh: `Judge 模型 ${modelId} 正在冷却中`,
      userMessageEn: `Judge model ${modelId} is in cooldown`,
      actionableHint: "稍后重试，或临时切换到备用 judge 模型",
    }),

  judgeEndpointUnreachable: (url: string) =>
    new OctoClawError({
      code: ERROR_CODES.JUDGE_ENDPOINT_UNREACHABLE,
      userMessageZh: `无法访问 Judge endpoint：${url}`,
      userMessageEn: `Judge endpoint is unreachable: ${url}`,
      actionableHint: "检查 endpoint URL、网络连接、防火墙和 API 服务状态",
    }),

  openclawNotFound: () =>
    new OctoClawError({
      code: ERROR_CODES.OPENCLAW_NOT_FOUND,
      userMessageZh: "未检测到 OpenClaw。OctoClaw 需要 OpenClaw 才能运行。",
      userMessageEn: "OpenClaw not found. OctoClaw requires OpenClaw to run.",
      actionableHint: "安装 OpenClaw：https://github.com/openclaw/openclaw#installation",
    }),

  openclawConfigUnreadable: (path: string) =>
    new OctoClawError({
      code: ERROR_CODES.OPENCLAW_CONFIG_UNREADABLE,
      userMessageZh: `无法读取 OpenClaw 配置文件：${path}`,
      userMessageEn: `Cannot read OpenClaw config file: ${path}`,
      actionableHint: "检查文件是否存在，以及当前用户是否拥有读取权限",
    }),

  openclawConfigUnwritable: (path: string) =>
    new OctoClawError({
      code: ERROR_CODES.OPENCLAW_CONFIG_UNWRITABLE,
      userMessageZh: `无法写入 OpenClaw 配置文件：${path}`,
      userMessageEn: `Cannot write OpenClaw config file: ${path}`,
      actionableHint: `检查文件权限，必要时运行 chmod 644 ${path}`,
    }),

  dispatchAdmissionDenied: (reason: string) =>
    new OctoClawError({
      code: ERROR_CODES.DISPATCH_ADMISSION_DENIED,
      userMessageZh: `任务派发被准入规则拒绝：${reason}`,
      userMessageEn: `Dispatch admission denied: ${reason}`,
      actionableHint: "检查任务复杂度、并发上限、预算和安全策略配置",
    }),

  dispatchNoEligibleModel: () =>
    new OctoClawError({
      code: ERROR_CODES.DISPATCH_NO_ELIGIBLE_MODEL,
      userMessageZh: "没有符合条件的 delegated/sub-agent 模型",
      userMessageEn: "No eligible delegated/sub-agent model is available",
      actionableHint: "检查模型配置、限制规则、配额状态和 router promotion 决策",
    }),

  dispatchTimeout: () =>
    new OctoClawError({
      code: ERROR_CODES.DISPATCH_TIMEOUT,
      userMessageZh: "任务派发超时",
      userMessageEn: "Dispatch timed out",
      actionableHint: "检查 OpenClaw TaskFlow 状态，并查看任务时间线定位卡点",
    }),

  routerSnapshotMissing: () =>
    new OctoClawError({
      code: ERROR_CODES.ROUTER_SNAPSHOT_MISSING,
      userMessageZh: "缺少 Auto Router 模型情报快照",
      userMessageEn: "Auto Router model-intel snapshot is missing",
      actionableHint: "运行 octoclawctl router model-intel refresh 生成最新快照",
    }),

  routerSnapshotStale: (age: string) =>
    new OctoClawError({
      code: ERROR_CODES.ROUTER_SNAPSHOT_STALE,
      userMessageZh: `Auto Router 模型情报快照已过期：${age}`,
      userMessageEn: `Auto Router model-intel snapshot is stale: ${age}`,
      actionableHint: "运行 octoclawctl router model-intel refresh 刷新快照",
    }),

  imTimeout: (channel: string) =>
    new OctoClawError({
      code: ERROR_CODES.IM_TIMEOUT,
      userMessageZh: `${channel} 消息发送超时`,
      userMessageEn: `${channel} message delivery timed out`,
      actionableHint: "检查 IM 平台状态、网络连接和该渠道的 timeout 配置",
    }),

  imRateLimited: (channel: string) =>
    new OctoClawError({
      code: ERROR_CODES.IM_RATE_LIMITED,
      userMessageZh: `${channel} 触发发送频率限制`,
      userMessageEn: `${channel} delivery is rate limited`,
      actionableHint: "稍后重试，或降低进度通知频率和并发发送量",
    }),
};
