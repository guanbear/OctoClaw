import fs from "node:fs/promises";
import type {
  AcceptanceGate,
  AssertionResult,
  SlackAcceptanceCaseConfig,
  SlackAcceptanceCaseKind,
  SlackAcceptanceCaseResult,
  SlackAcceptanceClient,
  SlackAcceptanceConfig,
  SlackAcceptanceReport,
  SlackAcceptanceResolvedConfig,
  SlackAcceptanceProgressEvent,
  SlackMessageRecord,
  SlackPostMessageResult,
  SlackToolExposureAuditResult,
} from "./types.js";
import { sanitizeForArtifact } from "./sanitize.js";

const SAFE_SLACK_TOOLS = new Set(["message.send", "message.update", "message.react", "message.typing"]);
const DEFAULT_ACCEPTANCE_MARKER_PREFIX = "[OCTOCLAW_ACCEPTANCE]";

function makeAcceptanceRunId(label: string): string {
  const safeLabel = label.toLowerCase().replace(/[^a-z0-9_.-]+/gu, "-").replace(/^-+|-+$/gu, "") || "acceptance";
  return `${safeLabel}-${Date.now().toString(36)}`;
}

function buildAcceptancePrompt(prompt: string, runId: string, caseId: string, markerPrefix: string, enabled: boolean): string {
  if (!enabled) return prompt;
  return `${markerPrefix} run=${runId} case=${caseId} acceptance=true\n${prompt}`;
}

const DEFAULT_CASES: SlackAcceptanceCaseConfig[] = [
  {
    kind: "plain_chat",
    prompt: "在吗",
    ackRequired: false,
    finalRequired: true,
    noSpawnExpected: true,
    expectFinal: ["在", "可以", "你好", "状态正常"],
  },
  {
    kind: "fresh_lookup",
    prompt: "请查一下 OpenClaw 最近一次发布说明，简要回答。",
    ackRequired: true,
    finalRequired: true,
    expectAck: ["查", "准备", "开始", "派发", "处理"],
    expectFinalAll: ["OpenClaw", "发布|release|说明|亮点"],
  },
  {
    kind: "delegated_work",
    prompt: "请委派子 agent 调研 OctoClaw 当前任务状态面板需要展示哪些字段，完成后给摘要。",
    ackRequired: true,
    finalRequired: true,
    expectAck: ["委派", "子", "派发", "准备"],
    expectFinalAll: ["任务", "状态", "字段"],
  },
  {
    kind: "status_panel",
    prompt: "显示任务状态面板：哪些任务还在跑、跑了多久、用的哪个模型、结果在哪？",
    ackRequired: false,
    finalRequired: true,
    noSpawnExpected: true,
    expectFinalAll: ["任务|task", "状态|status|running|queued|completed", "模型|model|profile", "耗时|运行|elapsed", "结果|artifact|位置|在哪"],
  },
  {
    kind: "provenance_followup",
    prompt: "刚才那个任务判定是啥，怎么查的？",
    ackRequired: false,
    finalRequired: true,
    noSpawnExpected: true,
    expectFinalAll: ["判定|route", "证据|coverage|WorkContract"],
  },
  {
    kind: "route_objection_correction",
    prompt: "这个不用委派，直接回答就行。请纠正刚才的判定。",
    ackRequired: false,
    finalRequired: true,
    noSpawnExpected: true,
    expectFinal: ["直接", "纠正", "不委派", "已改"],
  },
  {
    kind: "route_flip_no_stale_projection",
    prompt: "OpenClaw 的最新版是啥？有啥最新特性？这条请主会话直接回答；如果前置判定偏向委派，请用结构化 route hint/objection 纠成 reply 后再答。",
    ackRequired: false,
    finalRequired: true,
    noSpawnExpected: true,
    expectFinalAll: ["OpenClaw", "版本|最新版|release|发布"],
    rejectFinal: ["还没派发成功", "真实执行结果", "没派发成功"],
  },
  {
    kind: "no_lie_materialized_no_spawn",
    prompt: "显示 no-lie fixture：已物化但没有 spawn evidence 的任务现在应该显示什么状态？",
    ackRequired: false,
    finalRequired: true,
    noSpawnExpected: true,
    requiresFixture: true,
    fixtureKey: "materializedNoSpawn",
    expectFinal: ["queued", "materialized", "尚未实际执行", "未实际执行", "不显示 running"],
    rejectFinal: ["正在运行"],
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asPositiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeCase(caseConfig: SlackAcceptanceCaseConfig, index: number): SlackAcceptanceCaseConfig {
  return {
    id: caseConfig.id || `${caseConfig.kind}-${index + 1}`,
    enabled: caseConfig.enabled !== false,
    ...caseConfig,
  };
}

function validateKnownCaseKind(kind: string): asserts kind is SlackAcceptanceCaseKind {
  const known = new Set(DEFAULT_CASES.map((item) => item.kind));
  if (!known.has(kind as SlackAcceptanceCaseKind)) {
    throw new Error(`Slack acceptance config uses unknown case kind: ${kind}`);
  }
}

export function parseSlackAcceptanceConfig(raw: unknown, env: Record<string, string | undefined>): SlackAcceptanceResolvedConfig {
  if (!isRecord(raw)) {
    throw new Error("Slack acceptance config must be a JSON object");
  }
  const config = raw as SlackAcceptanceConfig;
  const botTokenEnv = asString(config.botTokenEnv);
  if (!botTokenEnv) {
    throw new Error("Slack acceptance requires botTokenEnv; inline tokens are not accepted");
  }
  const botToken = asString(env[botTokenEnv]);
  if (!botToken) {
    throw new Error(`Slack acceptance token env is not set: ${botTokenEnv}`);
  }
  const isolationRaw = isRecord(config.isolation) ? config.isolation : {};
  const outputLabel = asString(config.outputLabel) || "acceptance";
  const acceptanceRunId = asString(isolationRaw.runId) || makeAcceptanceRunId(outputLabel);
  const isolation = {
    enabled: isolationRaw.enabled !== false,
    markerPrefix: asString(isolationRaw.markerPrefix) || DEFAULT_ACCEPTANCE_MARKER_PREFIX,
    allowUserToken: isolationRaw.allowUserToken === true,
  };
  const userTokenEnv = asString(config.userTokenEnv);
  if (userTokenEnv && !isolation.allowUserToken) {
    throw new Error("Slack acceptance userTokenEnv requires isolation.allowUserToken=true; use a dedicated test identity, not a personal user token");
  }
  const userToken = userTokenEnv ? asString(env[userTokenEnv]) : undefined;
  if (userTokenEnv && !userToken) {
    throw new Error(`Slack acceptance user token env is not set: ${userTokenEnv}`);
  }
  const sessionKey = asString(config.sessionKey);
  if (!sessionKey) {
    throw new Error("Slack acceptance requires sessionKey");
  }
  const target = isRecord(config.target) ? config.target : undefined;
  const channel = asString(target?.channel);
  const user = asString(target?.user);
  if (!channel) {
    throw new Error("Slack acceptance requires target.channel; no production DM default is allowed");
  }
  if ((sessionKey.includes(":dm:") || sessionKey.includes(":direct:") || user) && target?.allowDm !== true) {
    throw new Error("Slack acceptance DM/direct target requires target.allowDm=true");
  }
  if (asString(config.outputLabel).toLowerCase().includes("prod") && target?.allowProductionTarget !== true) {
    throw new Error("Slack acceptance production-labeled targets require target.allowProductionTarget=true");
  }
  const cases = (config.cases && config.cases.length > 0 ? config.cases : DEFAULT_CASES).map((item, index) => {
    validateKnownCaseKind(String(item.kind));
    return normalizeCase(item, index);
  });
  return {
    botToken,
    botTokenEnv,
    userToken,
    userTokenEnv: userTokenEnv || undefined,
    sessionKey,
    target: {
      channel,
      user: user || undefined,
      threadTs: asString(target?.threadTs) || undefined,
      allowDm: target?.allowDm === true,
      allowProductionTarget: target?.allowProductionTarget === true,
    },
    outputLabel,
    cases,
    replayPath: asString(config.replayPath) || undefined,
    exposedTools: Array.isArray(config.exposedTools) ? config.exposedTools.map((tool) => asString(tool)).filter(Boolean) : [],
    ackTimeoutMs: asPositiveNumber(config.ackTimeoutMs, 30_000),
    finalTimeoutMs: asPositiveNumber(config.finalTimeoutMs, 180_000),
    pollIntervalMs: asPositiveNumber(config.pollIntervalMs, 2_000),
    maxTranscriptMessages: Math.max(10, asPositiveNumber(config.maxTranscriptMessages, 50)),
    requestTimeoutMs: asPositiveNumber(config.requestTimeoutMs, 15_000),
    totalTimeoutMs: asPositiveNumber(config.totalTimeoutMs, 10 * 60_000),
    fixtures: isRecord(config.fixtures) ? config.fixtures as Record<string, string | boolean | number> : {},
    acceptanceRunId,
    isolation,
  };
}

export async function loadSlackAcceptanceConfig(filePath: string, env: Record<string, string | undefined>): Promise<SlackAcceptanceResolvedConfig> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch {
    throw new Error(`Slack acceptance config file not found: ${filePath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Slack acceptance config is not valid JSON");
  }
  return parseSlackAcceptanceConfig(parsed, env);
}

export function auditSlackTools(exposedTools: string[]): SlackToolExposureAuditResult {
  const normalized = exposedTools.map((tool) => tool.trim()).filter(Boolean);
  const blockedTools = normalized.filter((tool) => !SAFE_SLACK_TOOLS.has(tool));
  return {
    status: blockedTools.length > 0 ? "fail" : "pass",
    exposedTools: normalized,
    blockedTools,
  };
}

function normalizeAcceptancePattern(pattern: string): string {
  // Footer separators are often written as " |" in JSON configs. A trailing
  // regex alternation would match every message, so treat it as a literal pipe.
  return pattern.replace(/(^|[^\\])\|(\s*)$/u, "$1\\|$2");
}

function compilePatterns(patterns: string[] | undefined): RegExp[] {
  return (patterns ?? []).map((pattern) => new RegExp(normalizeAcceptancePattern(pattern), "iu"));
}

function assertText(
  messages: SlackMessageRecord[],
  expectedAny: string[] | undefined,
  expectedAll: string[] | undefined,
  rejected: string[] | undefined,
  required: boolean,
): AssertionResult {
  const rejectPatterns = compilePatterns(rejected);
  const expectedAnyPatterns = compilePatterns(expectedAny);
  const expectedAllPatterns = compilePatterns(expectedAll);
  const transcriptText = messages.map((message) => message.text).join("\n");
  const rejectedMessage = messages.find((message) => rejectPatterns.some((pattern) => pattern.test(message.text)));
  if (rejectedMessage) {
    return { status: "fail", reason: "matched rejected content", matchedText: rejectedMessage.text };
  }
  if (expectedAllPatterns.length > 0) {
    const missing = expectedAllPatterns.filter((pattern) => !pattern.test(transcriptText));
    if (missing.length > 0) {
      return required
        ? { status: "fail", reason: "required expected content missing" }
        : { status: "unknown", reason: "optional expected content not observed" };
    }
  }
  if (expectedAnyPatterns.length > 0) {
    const matched = messages.find((message) => expectedAnyPatterns.some((pattern) => pattern.test(message.text)));
    if (!matched) {
      return required
        ? { status: "fail", reason: "required expected content missing" }
        : { status: "unknown", reason: "optional expected content not observed" };
    }
    return { status: "pass", reason: "matched expected content", matchedText: matched.text };
  }
  if (expectedAllPatterns.length > 0) {
    return { status: "pass", reason: "matched all expected content", matchedText: transcriptText.slice(0, 500) };
  }
  if (!required) return { status: "skipped", reason: "assertion not required" };
  const first = messages.find((message) => message.text.trim());
  return first ? { status: "pass", reason: "non-empty reply observed", matchedText: first.text } : { status: "fail", reason: "required reply missing" };
}

function eventHasSpawn(event: Record<string, unknown>): boolean {
  const transitionKind = asString(event.transitionKind);
  const eventName = asString(event.event);
  const finalRoute = asString(event.finalRoute || event.route);
  return event.spawnExecuted === true
    || transitionKind === "spawn_started"
    || eventName.toLowerCase().includes("spawn")
    || (finalRoute === "delegate" && event.executed === true);
}

async function checkNoSpawn(replayPath: string | undefined, sinceIso: string | undefined, sessionKey: string, expected: boolean): Promise<AssertionResult> {
  if (!expected) return { status: "skipped", reason: "no-spawn assertion not required" };
  if (!replayPath) return { status: "unknown", reason: "replayPath not configured; cannot prove no spawn" };
  if (!sinceIso) return { status: "unknown", reason: "prompt send time missing" };
  let content: string;
  try {
    content = await fs.readFile(replayPath, "utf8");
  } catch {
    return { status: "unknown", reason: `replayPath not readable: ${replayPath}` };
  }
  const since = Date.parse(sinceIso);
  const spawned: Record<string, unknown>[] = [];
  const lines = content.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed) continue;
    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(trimmed);
      if (!isRecord(parsed)) {
        return { status: "unknown", reason: `malformed replay JSONL at line ${index + 1}` };
      }
      event = parsed;
    } catch {
      return { status: "unknown", reason: `malformed replay JSONL at line ${index + 1}` };
    }
    const at = Date.parse(asString(event.at));
    const eventSessionKey = asString(event.sessionKey || event.session_key);
    if (Number.isFinite(at) && at >= since && (!eventSessionKey || eventSessionKey === sessionKey) && eventHasSpawn(event)) {
      spawned.push(event);
    }
  }
  if (spawned.length > 0) {
    return { status: "fail", reason: `spawn evidence observed: ${spawned.length}` };
  }
  return { status: "pass", reason: "no spawn evidence observed in replay" };
}

function caseGate(ack: AssertionResult, final: AssertionResult, noSpawn: AssertionResult, errors: string[]): AcceptanceGate {
  if (errors.length > 0 || [ack, final, noSpawn].some((result) => result.status === "fail")) return "fail";
  if ([ack, final, noSpawn].some((result) => result.status === "unknown")) return "unknown";
  return "pass";
}

function fastFinalSatisfiesAck(
  ack: AssertionResult,
  final: AssertionResult,
  replies: SlackMessageRecord[],
  promptTs: string | undefined,
  ackTimeoutMs: number,
): AssertionResult {
  if (ack.status !== "fail" || final.status !== "pass") return ack;
  if (!ack.reason.includes("required expected content missing") && !ack.reason.includes("required reply missing")) return ack;
  const promptAt = tsToMillis(promptTs);
  if (!promptAt) return ack;
  const finalReply = replies.find((message) => message.text.trim() && tsToMillis(message.ts) !== undefined);
  const finalAt = tsToMillis(finalReply?.ts);
  if (!finalAt || Math.max(0, finalAt - promptAt) > ackTimeoutMs) return ack;
  return {
    status: "pass",
    reason: "fast final reply arrived before ACK deadline",
    matchedText: finalReply?.text,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function tsToMillis(ts: string | undefined): number | undefined {
  if (!ts) return undefined;
  const normalized = ts.includes(".") ? Number(ts) * 1000 : Date.parse(ts);
  return Number.isFinite(normalized) ? normalized : undefined;
}

function shouldStopPolling(assertion: AssertionResult): boolean {
  if (assertion.status === "pass" || assertion.status === "skipped") return true;
  if (assertion.status === "fail") return !assertion.reason.includes("missing");
  return false;
}

async function withPromiseTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}_timeout_after_${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function elapsedMs(startMs: number): number {
  return Math.max(0, Date.now() - startMs);
}

function progressEvent(startMs: number, event: string, detail?: string): SlackAcceptanceProgressEvent {
  return { at: nowIso(), event, elapsedMs: elapsedMs(startMs), detail };
}

function timeoutAdjustedAssertion(assertion: AssertionResult, required: boolean, timeoutMs: number): AssertionResult {
  if (assertion.status === "pass" || assertion.status === "skipped") return assertion;
  const status = required ? "fail" : "unknown";
  return { status, reason: `${assertion.reason}; timed out after ${timeoutMs}ms` };
}

async function collectRepliesUntil(params: {
  client: SlackAcceptanceClient;
  channel: string;
  threadTs: string;
  promptTs: string;
  timeoutMs: number;
  requestTimeoutMs: number;
  pollIntervalMs: number;
  limit: number;
  expectedAny?: string[];
  expectedAll?: string[];
  rejected?: string[];
  required: boolean;
  phase: "ack" | "final";
  caseStartMs: number;
  progress: SlackAcceptanceProgressEvent[];
}): Promise<{ replies: SlackMessageRecord[]; assertion: AssertionResult; errors: string[] }> {
  const start = Date.now();
  const errors: string[] = [];
  let latest: SlackMessageRecord[] = [];
  let firstReplySeen = false;
  let assertion = assertText(latest, params.expectedAny, params.expectedAll, params.rejected, params.required);
  params.progress.push(progressEvent(params.caseStartMs, `${params.phase}_poll_started`, `timeout_ms=${params.timeoutMs}`));
  while (Date.now() - start <= params.timeoutMs) {
    try {
      latest = (await withPromiseTimeout(params.client.fetchReplies({
        channel: params.channel,
        threadTs: params.threadTs,
        oldestTs: params.promptTs,
        limit: params.limit,
      }), params.requestTimeoutMs, `${params.phase}_fetch_replies`)).filter((message) => message.ts !== params.promptTs);
    } catch (error) {
      const reason = `${params.phase} fetch failed: ${errorMessage(error)}`;
      errors.push(reason);
      params.progress.push(progressEvent(params.caseStartMs, `${params.phase}_fetch_failed`, reason));
      return {
        replies: latest,
        assertion: { status: params.required ? "fail" : "unknown", reason },
        errors,
      };
    }
    if (!firstReplySeen && latest.some((message) => message.text.trim())) {
      firstReplySeen = true;
      params.progress.push(progressEvent(params.caseStartMs, "first_reply_seen", `${params.phase}; replies=${latest.length}`));
    }
    assertion = assertText(latest, params.expectedAny, params.expectedAll, params.rejected, params.required);
    if (shouldStopPolling(assertion)) {
      params.progress.push(progressEvent(params.caseStartMs, `${params.phase}_assertion_${assertion.status}`, assertion.reason));
      return { replies: latest, assertion, errors };
    }
    await new Promise((resolve) => setTimeout(resolve, params.pollIntervalMs));
  }
  const timedOut = timeoutAdjustedAssertion(assertion, params.required, params.timeoutMs);
  params.progress.push(progressEvent(params.caseStartMs, `${params.phase}_timed_out`, timedOut.reason));
  return { replies: latest, assertion: timedOut, errors };
}

function notRunCaseResult(caseConfig: SlackAcceptanceCaseConfig, reason: string): SlackAcceptanceCaseResult {
  const prompt = caseConfig.prompt || DEFAULT_CASES.find((item) => item.kind === caseConfig.kind)?.prompt || caseConfig.kind;
  return {
    id: caseConfig.id || caseConfig.kind,
    kind: caseConfig.kind,
    prompt,
    status: "fail",
    ack: { status: "fail", reason },
    final: { status: "fail", reason },
    noSpawn: { status: "unknown", reason },
    transcript: [],
    errors: [reason],
    elapsedMs: 0,
    progress: [{ at: nowIso(), event: "case_not_run", elapsedMs: 0, detail: reason }],
  };
}

async function runCase(client: SlackAcceptanceClient, config: SlackAcceptanceResolvedConfig, caseConfig: SlackAcceptanceCaseConfig): Promise<SlackAcceptanceCaseResult> {
  const caseStartMs = Date.now();
  const progress: SlackAcceptanceProgressEvent[] = [progressEvent(caseStartMs, "case_started", caseConfig.kind)];
  const id = caseConfig.id || caseConfig.kind;
  const prompt = caseConfig.prompt || DEFAULT_CASES.find((item) => item.kind === caseConfig.kind)?.prompt || caseConfig.kind;
  const sentPrompt = buildAcceptancePrompt(prompt, config.acceptanceRunId, id, config.isolation.markerPrefix, config.isolation.enabled);
  const errors: string[] = [];
  const finish = (result: Omit<SlackAcceptanceCaseResult, "elapsedMs" | "progress">): SlackAcceptanceCaseResult => ({
    ...result,
    elapsedMs: elapsedMs(caseStartMs),
    progress,
  });
  if (caseConfig.enabled === false) {
    progress.push(progressEvent(caseStartMs, "case_disabled"));
    return finish({
      id,
      kind: caseConfig.kind,
      prompt,
      sentPrompt,
      acceptanceRunId: config.acceptanceRunId,
      status: "unknown",
      ack: { status: "skipped", reason: "case disabled" },
      final: { status: "skipped", reason: "case disabled" },
      noSpawn: { status: "skipped", reason: "case disabled" },
      transcript: [],
      errors: [],
    });
  }
  if (caseConfig.requiresFixture && !config.fixtures[caseConfig.fixtureKey || caseConfig.kind]) {
    progress.push(progressEvent(caseStartMs, "fixture_missing", caseConfig.fixtureKey || caseConfig.kind));
    return finish({
      id,
      kind: caseConfig.kind,
      prompt,
      sentPrompt,
      acceptanceRunId: config.acceptanceRunId,
      status: "unknown",
      ack: { status: "skipped", reason: "fixture missing" },
      final: { status: "unknown", reason: "fixture missing" },
      noSpawn: { status: "unknown", reason: "fixture missing" },
      transcript: [],
      errors: [],
    });
  }

  const sentIso = nowIso();
  let posted: SlackPostMessageResult;
  try {
    progress.push(progressEvent(caseStartMs, "prompt_send_started"));
    posted = await withPromiseTimeout(
      client.postMessage({ channel: config.target.channel, text: sentPrompt, threadTs: config.target.threadTs }),
      config.requestTimeoutMs,
      "post_message",
    );
    progress.push(progressEvent(caseStartMs, "prompt_send_completed", posted.ok ? posted.ts : posted.error));
  } catch (error) {
    const reason = `post failed: ${errorMessage(error)}`;
    errors.push(reason);
    progress.push(progressEvent(caseStartMs, "prompt_send_failed", reason));
    return finish({
      id,
      kind: caseConfig.kind,
      prompt,
      sentPrompt,
      acceptanceRunId: config.acceptanceRunId,
      status: "fail",
      sentAt: sentIso,
      ack: { status: "fail", reason },
      final: { status: "fail", reason },
      noSpawn: { status: "unknown", reason: "post failed" },
      transcript: [],
      errors,
    });
  }
  if (!posted.ok || !posted.ts) {
    const reason = posted.error || "post failed";
    errors.push(reason);
    return finish({
      id,
      kind: caseConfig.kind,
      prompt,
      sentPrompt,
      acceptanceRunId: config.acceptanceRunId,
      status: "fail",
      sentAt: sentIso,
      ack: { status: "fail", reason },
      final: { status: "fail", reason },
      noSpawn: { status: "unknown", reason: "post failed" },
      transcript: [],
      errors,
    });
  }
  const threadTs = posted.threadTs || posted.ts;
  const ackTimeoutMs = asPositiveNumber(caseConfig.ackTimeoutMs, config.ackTimeoutMs);
  const finalTimeoutMs = asPositiveNumber(caseConfig.finalTimeoutMs, config.finalTimeoutMs);
  const pollIntervalMs = asPositiveNumber(caseConfig.pollIntervalMs, config.pollIntervalMs);
  const ackCollection = await collectRepliesUntil({
    client,
    channel: posted.channel,
    threadTs,
    promptTs: posted.ts,
    timeoutMs: ackTimeoutMs,
    requestTimeoutMs: config.requestTimeoutMs,
    pollIntervalMs,
    limit: config.maxTranscriptMessages,
    expectedAny: caseConfig.expectAck,
    expectedAll: caseConfig.expectAckAll,
    rejected: caseConfig.rejectAck,
    required: caseConfig.ackRequired === true,
    phase: "ack",
    caseStartMs,
    progress,
  });
  errors.push(...ackCollection.errors);
  const ackReplies = ackCollection.replies;
  const ack = ackCollection.assertion;
  const finalCollection = await collectRepliesUntil({
    client,
    channel: posted.channel,
    threadTs,
    promptTs: posted.ts,
    timeoutMs: finalTimeoutMs,
    requestTimeoutMs: config.requestTimeoutMs,
    pollIntervalMs,
    limit: config.maxTranscriptMessages,
    expectedAny: caseConfig.expectFinal,
    expectedAll: caseConfig.expectFinalAll,
    rejected: caseConfig.rejectFinal,
    required: caseConfig.finalRequired !== false,
    phase: "final",
    caseStartMs,
    progress,
  });
  errors.push(...finalCollection.errors);
  const allReplies = finalCollection.replies;
  const final = finalCollection.assertion;
  const noSpawn = await checkNoSpawn(config.replayPath, sentIso, config.sessionKey, caseConfig.noSpawnExpected === true);
  progress.push(progressEvent(caseStartMs, "nospawn_assertion_completed", noSpawn.reason));
  const effectiveAck = caseConfig.ackRequired === true
    ? fastFinalSatisfiesAck(ack, final, allReplies, posted.ts, ackTimeoutMs)
    : ack;
  if (effectiveAck !== ack) {
    progress.push(progressEvent(caseStartMs, "ack_satisfied_by_fast_final", effectiveAck.reason));
  }
  const ackAt = tsToMillis(ackReplies[0]?.ts) ?? tsToMillis(allReplies.find((message) => message.text.trim())?.ts);
  const finalAt = tsToMillis(allReplies[allReplies.length - 1]?.ts);
  const promptAt = tsToMillis(posted.ts);
  return finish({
    id,
    kind: caseConfig.kind,
    prompt,
    sentPrompt,
    acceptanceRunId: config.acceptanceRunId,
    status: caseGate(effectiveAck, final, noSpawn, errors),
    sentAt: sentIso,
    threadTs,
    ackMs: ackAt && promptAt ? Math.max(0, Math.round(ackAt - promptAt)) : undefined,
    finalMs: finalAt && promptAt ? Math.max(0, Math.round(finalAt - promptAt)) : undefined,
    ack: effectiveAck,
    final,
    noSpawn,
    transcript: allReplies.slice(-config.maxTranscriptMessages),
    errors,
  });
}

function overallGate(cases: SlackAcceptanceCaseResult[], audit: SlackToolExposureAuditResult): AcceptanceGate {
  if (audit.status === "fail" || cases.some((item) => item.status === "fail")) return "fail";
  if (cases.length === 0 || cases.some((item) => item.status === "unknown") || audit.status === "unknown") return "unknown";
  return "pass";
}

export async function runSlackAcceptanceHarness(client: SlackAcceptanceClient, config: SlackAcceptanceResolvedConfig): Promise<SlackAcceptanceReport> {
  const results: SlackAcceptanceCaseResult[] = [];
  const runStartMs = Date.now();
  for (const caseConfig of config.cases) {
    const remainingMs = config.totalTimeoutMs - elapsedMs(runStartMs);
    if (remainingMs <= 0) {
      results.push(notRunCaseResult(caseConfig, `slack acceptance total timeout after ${config.totalTimeoutMs}ms`));
      continue;
    }
    try {
      results.push(await withPromiseTimeout(runCase(client, config, caseConfig), remainingMs, "slack_acceptance_case"));
    } catch (error) {
      results.push(notRunCaseResult(caseConfig, `case aborted by total timeout: ${errorMessage(error)}`));
    }
  }
  const audit = auditSlackTools(config.exposedTools);
  const report: SlackAcceptanceReport = {
    schemaVersion: "octoclaw.slack_acceptance.report/v1",
    reportId: `slack-acceptance:${config.outputLabel}:${Date.now()}`,
    generatedAt: nowIso(),
    acceptanceRunId: config.acceptanceRunId,
    sessionKey: config.sessionKey,
    isolation: {
      enabled: config.isolation.enabled,
      markerPrefix: config.isolation.markerPrefix,
      userTokenAllowed: config.isolation.allowUserToken,
    },
    target: {
      channel: config.target.channel,
      threadTs: config.target.threadTs,
      user: config.target.user,
    },
    overallGate: overallGate(results, audit),
    total: results.length,
    pass: results.filter((item) => item.status === "pass").length,
    fail: results.filter((item) => item.status === "fail").length,
    unknown: results.filter((item) => item.status === "unknown").length,
    skipped: results.filter((item) => item.ack.status === "skipped" && item.final.status === "skipped").length,
    toolExposureAudit: audit,
    cases: results,
  };
  return sanitizeForArtifact(report) as SlackAcceptanceReport;
}
