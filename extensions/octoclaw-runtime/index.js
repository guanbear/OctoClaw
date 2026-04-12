import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildConversationControlHints,
  buildConversationControlHintsFromIntent,
  buildConversationIntentPacket,
  buildConversationGrounding,
  buildDirectLookupGuard,
  __conversationControlTest,
} from "./conversation-control.js";
import { buildDecision as buildPolicyDecision } from "./policy/decide.js";
import { loadOctoClawConfig, resolveRuntimeFeatureFlags } from "./policy/config.js";
import { invokePolicyJudge } from "./policy/judge.js";
import { invokeCompoundPlanner } from "./policy/planner.js";
import { scheduleCompoundPlan, evaluateGuard } from "./policy/compound_plan.js";
import { buildCompoundDecisions } from "./policy/decide.js";
import { executeCompoundPlan, ledgerToJSON } from "./policy/compound_executor.js";
import { buildRouteOutcome } from "./policy/outcome.js";
import { inferRoute } from "./policy/route.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let OCTOCLAW_ROOT_OVERRIDE = "";
let WORKSPACE_ROOT_OVERRIDE = "";

// ── Session state persistence ──
const SESSION_STATE_FILE = process.env.OCTOCLAW_SESSION_STATE_FILE || "";

function _loadPersistedSessionState() {
  if (!SESSION_STATE_FILE) return new Map();
  try {
    if (!fsSync.existsSync(SESSION_STATE_FILE)) return new Map();
    const raw = fsSync.readFileSync(SESSION_STATE_FILE, "utf-8");
    const obj = JSON.parse(raw);
    return new Map(Object.entries(obj));
  } catch {
    return new Map();
  }
}

function _persistSessionState(map) {
  if (!SESSION_STATE_FILE) return;
  try {
    const dir = path.dirname(SESSION_STATE_FILE);
    if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir, { recursive: true });
    const obj = Object.fromEntries(map.entries());
    fsSync.writeFileSync(SESSION_STATE_FILE, JSON.stringify(obj, null, 2), "utf-8");
  } catch {
    // Silent fail — persistence is best-effort
  }
}

let _persistTimer;
function _setSessionPolicyState(key, value) {
  policyStateBySession.set(key, value);
  clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => _persistSessionState(policyStateBySession), 2000);
}

function stableHash(value = "") {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
}

function stableId(prefix, parts = []) {
  return `${prefix}-${stableHash(parts.map((part) => String(part || "")).join("\u001f"))}`;
}

function firstExistingPath(candidates, matcher = null) {
  for (const candidate of candidates) {
    const raw = String(candidate || "").trim();
    if (!raw) continue;
    const resolved = path.resolve(raw);
    try {
      if (!fsSync.existsSync(resolved)) continue;
      if (matcher && !matcher(resolved)) continue;
      return resolved;
    } catch {
      continue;
    }
  }
  return "";
}

function resolveHomeDir() {
  return String(process.env.HOME || os.homedir() || "").trim() || os.homedir();
}

function resolveOctoClawRoot() {
  const homeDir = resolveHomeDir();
  const resolved = firstExistingPath(
    [
      OCTOCLAW_ROOT_OVERRIDE,
      process.env.OCTOCLAW_ROOT,
      path.join(homeDir, ".openclaw", "workspace", "openclaw", "skills", "octopus"),
      path.resolve(__dirname, "..", ".."),
    ],
    (candidate) => fsSync.existsSync(path.join(candidate, "lib")),
  );
  return resolved || path.resolve(__dirname, "..", "..");
}

function resolveScript(...parts) {
  return path.join(resolveOctoClawRoot(), "lib", ...parts);
}

function resolveWorkspaceRoot() {
  const root = resolveOctoClawRoot();
  const homeDir = resolveHomeDir();
  const explicit = firstExistingPath(
    [
      WORKSPACE_ROOT_OVERRIDE,
      process.env.WORKSPACE,
    ],
  );
  if (explicit) {
    return explicit;
  }
  const resolved = firstExistingPath(
    [
      root ? path.resolve(root, "..", "..", "..") : "",
      path.join(homeDir, ".openclaw", "workspace"),
    ],
    (candidate) => fsSync.existsSync(path.join(candidate, "tmp")),
  );
  return resolved || process.env.WORKSPACE || "/workspace";
}

function resolvePythonBin() {
  const resolved = firstExistingPath(
    [
      process.env.OCTOCLAW_PYTHON_BIN,
      "/opt/homebrew/bin/python3",
      "/usr/local/bin/python3",
    ],
  );
  return resolved || "python3";
}

function resolveReplayLogPath() {
  return path.join(resolveWorkspaceRoot(), "tmp", "octopus", "runtime-policy-replay.jsonl");
}

function resolveDeliveryRelayPath() {
  return path.join(resolveWorkspaceRoot(), "tmp", "octopus", "delivery-relay.jsonl");
}

function resolveTaskStatePath() {
  return path.join(resolveWorkspaceRoot(), "tmp", "octopus", "task-state.json");
}

function resolveRouteStickinessPath() {
  return path.join(resolveWorkspaceRoot(), "tmp", "octopus", "route-stickiness.json");
}

function resolvePolicyStateLedgerPath() {
  return path.join(resolveWorkspaceRoot(), "tmp", "octopus", "runtime-policy-state.json");
}

function resolveRootSessionsPath() {
  return path.join(resolveHomeDir(), ".openclaw", "sessions.json");
}

function resolveMainAgentSessionsPath() {
  return path.join(resolveHomeDir(), ".openclaw", "agents", "main", "sessions", "sessions.json");
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: {
        ...process.env,
        WORKSPACE: resolveWorkspaceRoot(),
        OCTOCLAW_ROOT: resolveOctoClawRoot(),
        OCTOCLAW_PYTHON_BIN: resolvePythonBin(),
        ...(options.env || {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer = null;
    const timeoutMs = Math.max(0, Number(options.timeoutMs || 0));
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGTERM");
          killTimer = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {}
          }, 500);
        } catch {}
      }, timeoutMs)
      : null;
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        code: timedOut ? 124 : (code ?? 1),
        stdout: stdout.trim(),
        stderr: (timedOut ? (stderr || `command timed out after ${timeoutMs}ms`) : stderr).trim(),
        timedOut,
      });
    });
  });
}

async function runJsonScript(scriptName, args, cwd, options = {}) {
  const result = await runCommand(resolvePythonBin(), [resolveScript(scriptName), ...args], { cwd, ...options });
  if (result.code !== 0) {
    throw new Error(result.stderr || `${scriptName} failed`);
  }
  try {
    return JSON.parse(result.stdout || "{}");
  } catch {
    throw new Error(`${scriptName} returned invalid JSON: ${result.stdout}`);
  }
}

async function runStatus(format, cwd) {
  const result = await runCommand("bash", [resolveScript("status.sh"), "--format", format], { cwd });
  if (result.code !== 0) {
    throw new Error(result.stderr || "status.sh failed");
  }
  return result.stdout;
}

async function readReportExcerpt(reportPath, cwd) {
  const result = await runCommand(
    resolvePythonBin(),
    [resolveScript("report_excerpt.py"), "--path", reportPath, "--max-lines", "20", "--max-chars", "1800"],
    { cwd },
  );
  if (result.code !== 0) {
    throw new Error(result.stderr || "report_excerpt.py failed");
  }
  try {
    return JSON.parse(result.stdout || "{}");
  } catch {
    throw new Error(`report_excerpt.py returned invalid JSON: ${result.stdout}`);
  }
}

function toolResponse(summary, details = {}) {
  return {
    content: [{ type: "text", text: summary }],
    details,
  };
}

function preDispatchAckText(decision) {
  return String(decision?.pre_dispatch_ack?.text || "").trim();
}

function latencyAckText(decision) {
  return String(decision?.latency_ack?.text || "").trim();
}

function conversationIntentClass(decision) {
  return String(
    decision?.request?.metadata?.intent_packet?.intent_class
      || decision?.request?.metadata?.conversation_control?.intent_class
      || "",
  ).trim();
}

function shouldSendPreDispatchAck(decision, state = {}, ctx = {}) {
  if (!isDelegatedRoute(decision)) return false;
  if (!decision?.pre_dispatch_ack?.required) return false;
  if (state?.preDispatchAckSent) return false;
  const trigger = String(ctx?.trigger || "").trim().toLowerCase();
  if (trigger && ["heartbeat", "cron", "memory"].includes(trigger)) return false;
  return Boolean(preDispatchAckText(decision));
}

async function maybeEmitPreDispatchAckProgress(onUpdate, decision, stateKey, logger) {
  const message = preDispatchAckText(decision);
  if (typeof onUpdate !== "function" || !message) {
    return { attempted: false, sent: false, reason: "progress_update_unavailable", message };
  }
  const candidates = [
    { content: [{ type: "text", text: message }] },
    message,
  ];
  for (const payload of candidates) {
    try {
      await onUpdate(payload);
      updatePolicyState(stateKey, (current) => ({
        ...current,
        preDispatchAckSent: true,
        preDispatchAckText: message,
        preDispatchAckMode: "progress_update",
      }));
      return {
        attempted: true,
        sent: true,
        reason: "progress_update_sent",
        message,
      };
    } catch (err) {
      logger?.warn?.(`octoclaw pre-dispatch progress ack failed: ${String(err)}`);
    }
  }
  return {
    attempted: true,
    sent: false,
    reason: "progress_update_failed",
    message,
  };
}

async function maybeSendPreDispatchAck(decision, metadata, stateKey, state, ctx, logger) {
  const message = preDispatchAckText(decision);
  if (!shouldSendPreDispatchAck(decision, state, ctx)) {
    return { attempted: false, sent: false, reason: "not_required", message: "" };
  }
  const sessionKey = resolveAckDeliverySessionKey(metadata, stateKey, state, ctx);
  if (!sessionKey) {
    return { attempted: false, sent: false, reason: "missing_session_key", message };
  }
  try {
    const timeoutMs = Math.max(500, Number(decision?.pre_dispatch_ack?.channel_timeout_ms || 1800));
    const payload = await runJsonScript(
      "send_pre_dispatch_ack.py",
      ["--session-key", sessionKey, "--channel", String(metadata?.channel || ""), "--message", message],
      ctx?.cwd || process.cwd(),
      { timeoutMs },
    );
    const sent = Boolean(payload?.delivered);
    if (sent) {
      updatePolicyState(stateKey, (current) => ({
        ...current,
        preDispatchAckSent: true,
        preDispatchAckText: message,
        preDispatchAckMode: "channel_message",
      }));
    }
    return {
      attempted: true,
      sent,
      delivered: Boolean(payload?.delivered),
      error: String(payload?.error || ""),
      reason: sent ? "channel_message_sent" : String(payload?.error || "channel_message_failed"),
      message,
      payload,
    };
  } catch (err) {
    logger?.warn?.(`octoclaw pre-dispatch ack failed: ${String(err)}`);
    return {
      attempted: true,
      sent: false,
      delivered: false,
      error: String(err),
      reason: String(err),
      message,
    };
  }
}

async function maybeSendEagerPreDispatchAck(decision, metadata, stateKey, state, ctx, logger) {
  if (!shouldSendPreDispatchAck(decision, state, ctx)) {
    return { attempted: false, sent: false, reason: "not_required", message: "" };
  }
  return maybeSendPreDispatchAck(decision, metadata, stateKey, state, ctx, logger);
}

function scheduleEagerPreDispatchAck(decision, metadata, stateKey, state, ctx, logger) {
  if (!shouldSendPreDispatchAck(decision, state, ctx)) {
    return { scheduled: false, reason: "not_required" };
  }
  const promise = maybeSendEagerPreDispatchAck(decision, metadata, stateKey, state, ctx, logger)
    .then(async (result) => {
      await recordPolicyReplay(
        "pre_dispatch_ack_attempted",
        {
          sessionKey: stateKey || String(metadata?.session_key || ""),
          sessionId: String(ctx?.sessionId || ""),
          route: String(decision?.route_decision?.route || ""),
          taskClass: String(decision?.route_decision?.task_class || ""),
          attempted: Boolean(result?.attempted),
          delivered: Boolean(result?.delivered || result?.sent),
          error: String(result?.error || ""),
          sent: Boolean(result?.sent),
          reason: String(result?.reason || ""),
          message: String(result?.message || ""),
          mode: "eager_async",
        },
        logger,
        decision,
      );
      await recordAckReplay({
        decision,
        stateKey,
        ctx,
        logger,
        kind: "pre_dispatch",
        phase: "eager_async",
        result,
      });
    })
    .catch((err) => {
      logger?.warn?.(`octoclaw eager pre-dispatch ack scheduling failed: ${String(err)}`);
    });
  return {
    scheduled: true,
    reason: "scheduled",
    promise,
  };
}

function shouldSendLatencyAck(decision, state = {}, ctx = {}, toolName = "") {
  if (isDelegatedRoute(decision)) return false;
  if (!decision?.latency_ack?.required) return false;
  if (state?.latencyAckSent) return false;
  const trigger = String(ctx?.trigger || "").trim().toLowerCase();
  if (trigger && ["heartbeat", "cron", "memory"].includes(trigger)) return false;
  const name = String(toolName || "").trim();
  if (!name || name.startsWith("octoclaw_")) return false;
  return Boolean(latencyAckText(decision));
}

async function maybeSendLatencyAck(decision, metadata, stateKey, state, ctx, logger, toolName) {
  const message = latencyAckText(decision);
  if (!shouldSendLatencyAck(decision, state, ctx, toolName)) {
    return { attempted: false, sent: false, reason: "not_required", message: "" };
  }
  const sessionKey = resolveAckDeliverySessionKey(metadata, stateKey, state, ctx);
  if (!sessionKey) {
    return { attempted: false, sent: false, reason: "missing_session_key", message };
  }
  try {
    const timeoutMs = Math.max(500, Number(decision?.latency_ack?.channel_timeout_ms || 1800));
    const payload = await runJsonScript(
      "send_pre_dispatch_ack.py",
      ["--session-key", sessionKey, "--channel", String(metadata?.channel || ""), "--message", message],
      ctx?.cwd || process.cwd(),
      { timeoutMs },
    );
    const sent = Boolean(payload?.delivered);
    if (sent) {
      updatePolicyState(stateKey, (current) => ({
        ...current,
        latencyAckSent: true,
        latencyAckText: message,
        latencyAckMode: "channel_message",
      }));
    }
    return {
      attempted: true,
      sent,
      delivered: Boolean(payload?.delivered),
      error: String(payload?.error || ""),
      reason: sent ? "channel_message_sent" : String(payload?.error || "channel_message_failed"),
      message,
      payload,
    };
  } catch (err) {
    logger?.warn?.(`octoclaw latency ack failed: ${String(err)}`);
    return {
      attempted: true,
      sent: false,
      delivered: false,
      error: String(err),
      reason: String(err),
      message,
    };
  }
}

async function ensurePreDispatchAck(decision, metadata, stateKey, state, ctx, onUpdate, logger) {
  const channelAttempt = await maybeSendPreDispatchAck(decision, metadata, stateKey, state, ctx, logger);
  if (channelAttempt.delivered) {
    return {
      ...channelAttempt,
      fallback_used: false,
      channel_attempt: channelAttempt,
    };
  }
  if (!decision?.pre_dispatch_ack?.fallback_to_progress_update) {
    return {
      ...channelAttempt,
      fallback_used: false,
      channel_attempt: channelAttempt,
    };
  }
  const progressAttempt = await maybeEmitPreDispatchAckProgress(onUpdate, decision, stateKey, logger);
  return {
    attempted: Boolean(channelAttempt.attempted || progressAttempt.attempted),
    delivered: Boolean(channelAttempt.delivered || progressAttempt.sent),
    sent: Boolean(channelAttempt.sent || progressAttempt.sent),
    error: channelAttempt.error || (progressAttempt.sent ? "" : "progress_update_failed"),
    reason: progressAttempt.sent ? progressAttempt.reason : channelAttempt.reason,
    message: progressAttempt.message || channelAttempt.message || "",
    payload: channelAttempt.payload,
    fallback_used: Boolean(progressAttempt.sent),
    channel_attempt: channelAttempt,
    progress_attempt: progressAttempt,
  };
}

function compactDispatchDetails(payload) {
  const taskId = payload?.job?.id || payload?.task_id || "";
  const reportPath = payload?.handoff?.report_path || payload?.report_path || "";
  const status = payload?.status || (payload?.executed ? "executed" : "planned");
  const materialization = payload?.materialization && typeof payload.materialization === "object" ? payload.materialization : {};
  const capabilityFailure = payload?.capability_failure && typeof payload.capability_failure === "object"
    ? payload.capability_failure
    : (materialization?.capability_failure && typeof materialization.capability_failure === "object" ? materialization.capability_failure : {});
  return {
    route: payload?.route || "",
    task_id: taskId,
    report_path: reportPath,
    status,
    handoff_kind: payload?.handoff?.kind || "",
    materialization,
    capability_failure: capabilityFailure,
  };
}

async function appendJsonl(pathname, payload) {
  await fs.mkdir(path.dirname(pathname), { recursive: true });
  await fs.appendFile(pathname, `${JSON.stringify(payload)}\n`, "utf8");
}

function deliveryRelayEventIsIdempotent(eventType = "") {
  return new Set([
    "delivery_pending",
    "delivery_observed",
    "delivery_compensated",
    "delivery_reconciled_delivered",
    "delivery_failed",
    "delivery_retry_deferred",
  ]).has(String(eventType || "").trim());
}

async function hasDeliveryRelayEvent(pathname, eventType, deliveryId) {
  if (!deliveryRelayEventIsIdempotent(eventType) || !deliveryId) return false;
  try {
    const raw = await fs.readFile(pathname, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const payload = JSON.parse(lines[index]);
        if (String(payload?.deliveryId || "").trim() !== deliveryId) continue;
        if (String(payload?.event || "").trim() === String(eventType || "").trim()) {
          return true;
        }
      } catch {
        continue;
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function readJsonFile(pathname, fallback = {}) {
  try {
    const raw = await fs.readFile(pathname, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJsonFile(pathname, payload) {
  await fs.mkdir(path.dirname(pathname), { recursive: true });
  const tempPath = `${pathname}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tempPath, pathname);
}

function readJsonFileSync(pathname, fallback = {}) {
  try {
    const raw = fsSync.readFileSync(pathname, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function truncateText(value, limit = 320) {
  const text = String(value || "").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

const POLICY_STATE_TTL_MS = 30 * 60 * 1000;
const policyStateBySession = _loadPersistedSessionState();
let policyStateLedgerMtimeMs = 0;
const DELEGATED_ROUTE_NAMES = new Set(["runner", "spawn_single", "spawn_multi"]);
const IM_SESSION_ORIGINS = new Set([
  "slack",
  "discord",
  "telegram",
  "whatsapp",
  "signal",
  "msteams",
  "googlechat",
  "wechat",
  "webchat",
  "feishu",
]);
const USER_SESSION_KINDS = new Set(["dm", "direct", "user"]);
const CHANNEL_SESSION_KINDS = new Set(["channel", "group", "room", "conversation", "space", "chat"]);
const THREAD_SESSION_KINDS = new Set(["thread", "topic"]);
const OCTOCLAW_DELEGATION_SYSTEM_CONTEXT = [
  "OctoClaw runtime policy is authoritative for this run.",
  "When route is delegated, the main agent is a coordinator and must use OctoClaw control tools instead of doing the work directly.",
  "Do not hand-write session or subagent spawning commands.",
].join("\n");
const OCTOCLAW_ROUTE_HINT_SYSTEM_CONTEXT = [
  "For non-hard-runner requests, submit a structured route hint before answering or dispatching.",
  "Use octoclaw_route_hint to state whether this should be direct, spawn_single, or spawn_multi.",
  "After route_hint merge: direct may answer directly; delegated routes must go through octoclaw_dispatch.",
].join("\n");
const OCTOCLAW_TASK_ACTION_SYSTEM_CONTEXT = [
  "When the user asks for task progress or acts on an OctoClaw task anchor, prefer the octoclaw_task_action tool.",
  "Use it for commands like: details <task_id>, queue, artifacts <task_id>, stop <task_id>, retry <task_id>, approve <task_id>, reject <task_id>.",
].join("\n");
const OCTOCLAW_PRE_DELEGATION_CONFIRM_CONTEXT = [
  "Before dispatching this task to a subagent, briefly confirm:",
  "- What is the core deliverable?",
  "- What are the key constraints?",
  "- Is the task boundary clear enough for a subagent to execute independently?",
  "Then proceed with octoclaw_dispatch.",
].join("\n");

function prunePolicyState() {
  const now = Date.now();
  const expiredKeys = [];
  for (const [key, value] of policyStateBySession.entries()) {
    if (!value || now - Number(value.updatedAt || value.createdAt || 0) > POLICY_STATE_TTL_MS) {
      expiredKeys.push(key);
    }
  }
  for (const key of expiredKeys) {
    policyStateBySession.delete(key);
  }
}

function stripAgentSessionPrefix(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  const parts = value.split(":");
  if (parts.length >= 3 && parts[0] === "agent") {
    return parts.slice(2).join(":");
  }
  return value;
}

function parseSessionRoute(raw) {
  const sessionKey = String(raw || "").trim();
  const stripped = stripAgentSessionPrefix(sessionKey);
  const parts = stripped.split(":").filter(Boolean);
  const origin = String(parts[0] || "").trim().toLowerCase();
  let target = "";
  let threadId = "";

  if (parts.length >= 3 && USER_SESSION_KINDS.has(parts[1])) {
    target = `user:${parts[2]}`;
    if (parts.length >= 5 && THREAD_SESSION_KINDS.has(parts[3])) {
      threadId = parts[4];
    }
  } else if (parts.length >= 3 && CHANNEL_SESSION_KINDS.has(parts[1])) {
    target = `${parts[1]}:${parts[2]}`;
    if (parts.length >= 5 && THREAD_SESSION_KINDS.has(parts[3])) {
      threadId = parts[4];
    }
  } else if (parts.length >= 3 && THREAD_SESSION_KINDS.has(parts[1])) {
    target = `${parts[1]}:${parts[2]}`;
  } else if (parts.length >= 2 && IM_SESSION_ORIGINS.has(origin)) {
    target = parts.slice(1, Math.min(3, parts.length)).join(":");
    if (parts.length >= 4 && THREAD_SESSION_KINDS.has(parts[2])) {
      threadId = parts[3];
    }
  }

  const bindingKey = origin && target ? `${origin}:${target}` : "";
  const threadKey = bindingKey ? `${bindingKey}:${threadId || "root"}` : "";
  const looksLikeImSession = Boolean(origin && (target || (IM_SESSION_ORIGINS.has(origin) && parts.length >= 2)));
  const isPrimaryMainSession = sessionKey.toLowerCase() === "agent:main:main" || stripped.toLowerCase() === "main";
  return {
    sessionKey,
    stripped,
    origin,
    target,
    threadId,
    bindingKey,
    threadKey,
    looksLikeImSession,
    isPrimaryMainSession,
  };
}

function deriveSessionDescriptor(controlKey, record = {}) {
  const parsed = parseSessionRoute(controlKey);
  const originRecord = record && typeof record.origin === "object" && !Array.isArray(record.origin) ? record.origin : {};
  const deliveryRecord = record && typeof record.deliveryContext === "object" && !Array.isArray(record.deliveryContext) ? record.deliveryContext : {};
  const metadataOrigin = String(
    originRecord.provider
      || originRecord.surface
      || originRecord.channel
      || deliveryRecord.channel
      || "",
  ).trim().toLowerCase();
  const origin = String(
    (parsed.looksLikeImSession && parsed.origin && IM_SESSION_ORIGINS.has(parsed.origin))
      ? parsed.origin
      : metadataOrigin
        || parsed.origin
      || "",
  ).trim().toLowerCase();
  const target = String(
    parsed.target
      || deliveryRecord.to
      || originRecord.to
      || "",
  ).trim();
  const threadId = String(
    parsed.threadId
      || deliveryRecord.threadId
      || originRecord.threadId
      || record.lastThreadId
      || "",
  ).trim();
  const bindingKey = origin && target ? `${origin}:${target}` : "";
  const threadKey = bindingKey ? `${bindingKey}:${threadId || "root"}` : "";
  const looksLikeImSession = Boolean(
    parsed.looksLikeImSession
      || (origin && (target || IM_SESSION_ORIGINS.has(origin))),
  );
  return {
    ...parsed,
    origin,
    target,
    threadId,
    bindingKey,
    threadKey,
    looksLikeImSession,
    nativeChannelId: String(
      originRecord.nativeChannelId
        || deliveryRecord.nativeChannelId
        || "",
    ).trim(),
    chatType: String(record.chatType || originRecord.chatType || "").trim(),
  };
}

function parseUpdatedSortValue(value) {
  if (typeof value === "number") return value;
  const text = String(value || "").trim();
  if (!text) return 0;
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

function loadSessionDescriptors() {
  const descriptors = new Map();
  const register = (sessionKey, value = {}) => {
    const key = String(sessionKey || "").trim();
    if (!key) return;
    const record = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const channelSessionKey = String(record.channelSessionKey || "").trim();
    const controlKey = channelSessionKey || key;
    const parsed = deriveSessionDescriptor(controlKey, record);
    const sessionId = String(record.sessionId || "").trim();
    const next = {
      sessionKey: key,
      controlKey,
      channelSessionKey,
      sessionId,
      sessionFile: String(record.sessionFile || "").trim(),
      origin: String(parsed.origin || "").trim(),
      target: String(parsed.target || "").trim(),
      bindingKey: String(parsed.bindingKey || "").trim(),
      threadKey: String(parsed.threadKey || "").trim(),
      threadId: String(parsed.threadId || "").trim(),
      nativeChannelId: String(parsed.nativeChannelId || "").trim(),
      chatType: String(parsed.chatType || "").trim(),
      updatedSort: parseUpdatedSortValue(record.updatedAt),
      isSubagent: isSubagentSessionRef(key) || isSubagentSessionRef(record.agentId),
      isUserFacing: Boolean(parsed.looksLikeImSession),
    };
    next.isContaminatedUserSession = Boolean(
      next.isUserFacing
        && !next.isSubagent
        && isSubagentSessionRef(next.sessionId),
    );
    const previous = descriptors.get(key);
    if (!previous || next.updatedSort >= Number(previous.updatedSort || 0)) {
      descriptors.set(key, next);
    }
  };

  for (const pathname of [resolveRootSessionsPath(), resolveMainAgentSessionsPath()]) {
    const raw = readJsonFileSync(pathname, {});
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    for (const [key, value] of Object.entries(raw)) {
      register(key, value);
      if (value && typeof value === "object" && typeof value.channelSessionKey === "string" && value.channelSessionKey) {
        register(String(value.channelSessionKey), { channelSessionKey: String(value.channelSessionKey) });
      }
    }
  }

  return [...descriptors.values()].sort(
    (left, right) => Number(right.updatedSort || 0) - Number(left.updatedSort || 0),
  );
}

function resolveCanonicalSessionDescriptor(ctx = {}) {
  const provider = String(ctx.messageProvider || "").trim().toLowerCase();
  const channelId = String(ctx.channelId || "").trim();
  const descriptors = loadSessionDescriptors().filter((entry) => entry.isUserFacing && !entry.isSubagent);
  if (provider && channelId) {
    const exact = descriptors.find(
      (entry) => entry.origin === provider && entry.nativeChannelId === channelId && !entry.threadId,
    );
    if (exact) return exact;
    const threaded = descriptors.find(
      (entry) => entry.origin === provider && entry.nativeChannelId === channelId,
    );
    if (threaded) return threaded;
  }
  if (provider) {
    const providerMatch = descriptors.find((entry) => entry.origin === provider && /^agent:main:main$/i.test(String(entry.controlKey || "").trim()));
    if (providerMatch) return providerMatch;
  }
  return null;
}

function isSubagentSessionRef(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return false;
  if (value.includes("octoclaw-subagent-")) return true;
  if (value.includes(":subagent:")) return true;
  if (/^agent:[^:]+:(?!main$)/i.test(String(raw || "").trim()) && value.includes("subagent")) return true;
  return false;
}

function resolveAckDeliverySessionKey(metadata = {}, stateKey = "", state = null, ctx = {}) {
  const directCandidates = [
    metadata.session_key,
    state?.canonicalSessionKey,
    stateKey,
    ctx?.sessionKey,
    ctx?.sessionId,
  ]
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  for (const candidate of directCandidates) {
    const parsed = parseSessionRoute(candidate);
    if (parsed.looksLikeImSession && !isSubagentSessionRef(candidate)) {
      return candidate;
    }
  }

  const desiredThreadKey = String(metadata.session_thread_key || "").trim();
  const desiredBindingKey = String(metadata.session_binding_key || "").trim();
  const desiredOrigin = String(metadata.session_origin || "").trim().toLowerCase();
  const candidates = loadSessionDescriptors().filter((entry) => (
    entry.isUserFacing && !entry.isSubagent && !entry.isContaminatedUserSession
  ));

  if (desiredThreadKey) {
    const match = candidates.find((entry) => entry.threadKey === desiredThreadKey);
    if (match?.controlKey) return match.controlKey;
  }
  if (desiredBindingKey) {
    const match = candidates.find((entry) => entry.bindingKey === desiredBindingKey);
    if (match?.controlKey) return match.controlKey;
  }
  if (desiredOrigin) {
    const match = candidates.find((entry) => entry.origin === desiredOrigin);
    if (match?.controlKey) return match.controlKey;
  }
  return "";
}

function detectSessionBoundary(ctx = {}) {
  const sessionKey = String(ctx.sessionKey || "").trim();
  const sessionId = String(ctx.sessionId || "").trim();
  const agentId = String(ctx.agentId || "").trim();
  const parsedSessionKey = parseSessionRoute(sessionKey);
  const parsedSessionId = parseSessionRoute(sessionId);
  const descriptorCanonical = resolveCanonicalSessionDescriptor(ctx);
  const subagentRefs = [sessionKey, sessionId, agentId].filter((item) => isSubagentSessionRef(item));
  const registrySubagentRefs = descriptorCanonical?.isContaminatedUserSession && descriptorCanonical.sessionId
    ? [descriptorCanonical.sessionId]
    : [];
  const canonicalCandidates = [sessionKey, sessionId]
    .map((raw) => ({ raw: String(raw || "").trim(), parsed: parseSessionRoute(raw) }))
    .filter((item) => item.raw && !isSubagentSessionRef(item.raw));
  const canonicalUserSession = canonicalCandidates.find((item) => item.parsed.looksLikeImSession)
    || canonicalCandidates.find((item) => item.parsed.isPrimaryMainSession)
    || (descriptorCanonical
      ? {
        raw: String(descriptorCanonical.controlKey || "").trim(),
        parsed: {
          bindingKey: String(descriptorCanonical.bindingKey || "").trim(),
          threadKey: String(descriptorCanonical.threadKey || "").trim(),
        },
      }
      : null)
    || canonicalCandidates[0]
    || null;
  const hasCanonicalUserSession = Boolean(canonicalUserSession);
  const contaminatedByRegistry = Boolean(descriptorCanonical?.isContaminatedUserSession);
  const contaminatedBySubagent = hasCanonicalUserSession && (subagentRefs.length > 0 || contaminatedByRegistry);
  return {
    sessionKey,
    sessionId,
    agentId,
    hasCanonicalUserSession,
    contaminatedBySubagent,
    subagentRefs,
    registrySubagentRefs,
    canonicalSessionKey: canonicalUserSession ? canonicalUserSession.raw : "",
    canonicalBindingKey: canonicalUserSession ? canonicalUserSession.parsed.bindingKey : "",
    canonicalThreadKey: canonicalUserSession ? canonicalUserSession.parsed.threadKey : "",
    contaminatedByRegistry,
    status: contaminatedBySubagent ? "contaminated_subagent_identity" : "clean",
  };
}

function sessionPreferenceRank(raw) {
  if (isSubagentSessionRef(raw)) return -50;
  const parsed = parseSessionRoute(raw);
  if (parsed.looksLikeImSession) return 30;
  if (parsed.isPrimaryMainSession) return 20;
  if (/^agent:main:/i.test(String(raw || "").trim())) return 10;
  return 0;
}

function resolvePolicyStateKeys(ctx = {}) {
  hydratePolicyStateFromLedger();
  const entries = [];
  const boundary = detectSessionBoundary(ctx);
  for (const raw of [boundary.canonicalSessionKey, ctx.sessionKey, ctx.sessionId]) {
    const value = String(raw || "").trim();
    if (value && !entries.some((entry) => entry.value === value)) {
      entries.push({
        value,
        rank: sessionPreferenceRank(value),
        order: entries.length,
      });
    }
  }
  entries.sort((left, right) => right.rank - left.rank || left.order - right.order);
  const preferred = entries.filter((entry) => entry.rank >= 0);
  return (preferred.length > 0 ? preferred : entries).map((entry) => entry.value);
}

function resolvePolicyStateKey(ctx = {}) {
  return resolvePolicyStateKeys(ctx)[0] || "";
}

function getPolicyStateForContext(ctx = {}) {
  hydratePolicyStateFromLedger();
  for (const key of resolvePolicyStateKeys(ctx)) {
    const state = policyStateBySession.get(key);
    if (state) {
      return { key, state };
    }
  }
  return { key: "", state: null };
}

function findPolicyStateByPrompt(prompt = "") {
  const task = String(prompt || "").trim();
  if (!task) return { key: "", state: null };
  hydratePolicyStateFromLedger();
  prunePolicyState();
  let bestKey = "";
  let bestState = null;
  let bestUpdatedAt = 0;
  let bestRank = -1;
  for (const [key, state] of policyStateBySession.entries()) {
    if (!state || !promptsEquivalent(task, state.prompt || "")) continue;
    const updatedAt = Number(state.updatedAt || state.createdAt || 0);
    const rank = sessionPreferenceRank(key);
    if (updatedAt > bestUpdatedAt || (updatedAt === bestUpdatedAt && rank >= bestRank)) {
      bestUpdatedAt = updatedAt;
      bestRank = rank;
      bestKey = key;
      bestState = state;
    }
  }
  return { key: bestKey, state: bestState };
}

function promptTokenScore(prompt = "", candidatePrompt = "") {
  const query = String(prompt || "").trim().toLowerCase();
  const candidate = String(candidatePrompt || "").trim().toLowerCase();
  if (!query || !candidate) return 0;
  if (query === candidate) return 100;
  const tokens = Array.from(
    new Set(
      query
        .split(/[^a-z0-9\u4e00-\u9fff._/-]+/i)
        .map((item) => item.trim())
        .filter((item) => item.length >= 3),
    ),
  );
  let score = 0;
  for (const token of tokens) {
    const parts = token.split(/[./_-]+/).filter((item) => item.length >= 3);
    const variants = parts.length > 0 ? parts : [token];
    if (variants.some((variant) => candidate.includes(variant))) {
      score += 1;
    }
  }
  return score;
}

function findRecentDelegatedPolicyState(prompt = "", maxAgeMs = 2 * 60 * 1000) {
  hydratePolicyStateFromLedger();
  const now = Date.now();
  const normalizedPrompt = promptLookupCandidates(prompt)[0] || String(prompt || "").trim();
  let bestKey = "";
  let bestState = null;
  let bestScore = -1;
  let bestUpdatedAt = 0;
  let bestRank = -1;
  for (const [key, state] of policyStateBySession.entries()) {
    const route = String(state?.decision?.route_decision?.route || "").trim();
    if (!DELEGATED_ROUTE_NAMES.has(route)) continue;
    const updatedAt = Number(state?.updatedAt || state?.createdAt || 0);
    if (!updatedAt || now - updatedAt > maxAgeMs) continue;
    const score = promptTokenScore(normalizedPrompt, promptLookupCandidates(state?.prompt || "")[0] || state?.prompt || "");
    if (score <= 0) continue;
    const rank = sessionPreferenceRank(key);
    if (score > bestScore || (score === bestScore && updatedAt > bestUpdatedAt) || (score === bestScore && updatedAt === bestUpdatedAt && rank > bestRank)) {
      bestScore = score;
      bestUpdatedAt = updatedAt;
      bestRank = rank;
      bestKey = key;
      bestState = state;
    }
  }
  return { key: bestKey, state: bestState };
}

function resolveToolPolicyContext(ctx = {}, prompt = "") {
  const direct = getPolicyStateForContext(ctx);
  if (direct.state && (!prompt || promptsEquivalent(prompt, direct.state.prompt || ""))) {
    return direct;
  }
  const taskClass = String(buildDecision(prompt || "").route_decision?.task_class || "").trim();
  if (taskClass === "control_observer" || taskClass === "session_control") {
    return { key: "", state: null };
  }
  const byPrompt = findPolicyStateByPrompt(prompt);
  if (byPrompt.key || byPrompt.state) return byPrompt;
  return findRecentDelegatedPolicyState(prompt);
}

function setPolicyStateForContext(ctx = {}, payload) {
  for (const key of resolvePolicyStateKeys(ctx)) {
    _setSessionPolicyState(key, payload);
  }
  persistPolicyStateLedger();
}

function clearPolicyStateForContext(ctx = {}) {
  for (const key of resolvePolicyStateKeys(ctx)) {
    policyStateBySession.delete(key);
  }
  persistPolicyStateLedger();
}

function hydratePolicyStateFromLedger() {
  const pathname = resolvePolicyStateLedgerPath();
  let stat = null;
  try {
    stat = fsSync.statSync(pathname);
  } catch {
    return;
  }
  if (!stat?.mtimeMs || stat.mtimeMs <= policyStateLedgerMtimeMs) {
    return;
  }
  const payload = readJsonFileSync(pathname, {});
  const sessions = payload && typeof payload === "object" && payload.sessions && typeof payload.sessions === "object"
    ? payload.sessions
    : {};
  policyStateBySession.clear();
  const now = Date.now();
  for (const [key, state] of Object.entries(sessions)) {
    if (!state || typeof state !== "object") continue;
    const updatedAt = Number(state.updatedAt || state.createdAt || 0);
    if (updatedAt && now - updatedAt > POLICY_STATE_TTL_MS) continue;
    policyStateBySession.set(key, state);
  }
  policyStateLedgerMtimeMs = stat.mtimeMs;
}

function persistPolicyStateLedger() {
  prunePolicyState();
  const pathname = resolvePolicyStateLedgerPath();
  const tempPath = `${pathname}.tmp`;
  const payload = {
    schema_version: "octoclaw.runtime_policy.state_ledger/v1",
    updated_at: new Date().toISOString(),
    ttl_ms: POLICY_STATE_TTL_MS,
    sessions: Object.fromEntries(policyStateBySession.entries()),
  };
  try {
    fsSync.mkdirSync(path.dirname(pathname), { recursive: true });
    fsSync.writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf8");
    fsSync.renameSync(tempPath, pathname);
    const stat = fsSync.statSync(pathname);
    policyStateLedgerMtimeMs = stat?.mtimeMs || Date.now();
  } catch {
    // Keep in-memory state even when persistence fails.
  }
}

function extractMessageText(content) {
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof part.text === "string") {
          return String(part.text);
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (content && typeof content === "object" && typeof content.text === "string") {
    return String(content.text).trim();
  }
  return "";
}

function extractQueuedBusyMessages(raw) {
  const text = String(raw || "").trim();
  if (!text.startsWith("[Queued messages while agent was busy]")) {
    return [];
  }
  const messages = [];
  const lines = text.split("\n");
  for (const line of lines) {
    if (!String(line || "").startsWith("System:")) continue;
    const rawLine = String(line).replace(/^System:\s*/, "").trim();
    const lastColon = rawLine.lastIndexOf(": ");
    const message = String(lastColon >= 0 ? rawLine.slice(lastColon + 2) : rawLine).trim();
    if (message) {
      messages.push(message);
    }
  }
  return messages;
}

function unwrapQueuedBusyPrompt(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  const messages = extractQueuedBusyMessages(text);
  if (messages.length === 0) {
    return text;
  }
  return messages.join("\n\n");
}

function promptLookupCandidates(raw) {
  const base = String(raw || "").trim();
  if (!base) return [];
  const values = [];
  const seen = new Set();
  const pushValue = (value) => {
    const normalized = String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    values.push(normalized);
  };
  const queuedMessages = extractQueuedBusyMessages(base);
  if (queuedMessages.length > 0) {
    pushValue(queuedMessages[queuedMessages.length - 1]);
    for (const message of queuedMessages) {
      pushValue(message);
    }
    pushValue(queuedMessages.join("\n\n"));
  }
  pushValue(unwrapQueuedBusyPrompt(base));
  pushValue(base);
  return values;
}

function promptsEquivalent(left = "", right = "") {
  const leftCandidates = promptLookupCandidates(left);
  const rightCandidates = promptLookupCandidates(right);
  if (leftCandidates.length === 0 || rightCandidates.length === 0) {
    return false;
  }
  const rightSet = new Set(rightCandidates);
  return leftCandidates.some((value) => rightSet.has(value));
}

function unwrapImRelayPrompt(raw = "") {
  const text = String(raw || "").trim();
  if (!text) return "";
  const hasRelayMetadata = /Conversation info \(untrusted metadata\):/u.test(text)
    || /Sender \(untrusted metadata\):/u.test(text);
  if (!hasRelayMetadata) return "";

  const afterSender = text.replace(
    /^.*?Sender \(untrusted metadata\):\s*```[\s\S]*?```\s*/u,
    "",
  ).trim();
  if (afterSender && !/^System:/u.test(afterSender)) {
    return afterSender;
  }

  const afterConversation = text.replace(
    /^.*?Conversation info \(untrusted metadata\):\s*```[\s\S]*?```\s*/u,
    "",
  ).trim();
  if (afterConversation && !/^System:/u.test(afterConversation)) {
    return afterConversation;
  }

  const firstLine = text.split(/\r?\n/u, 1)[0] || "";
  const systemMatch = firstLine.match(/^System:\s*\[[^\]]+\]\s*[^:]+:\s*(.+)$/u);
  if (systemMatch?.[1]) {
    return String(systemMatch[1]).trim();
  }
  return "";
}

function unwrapCodexHarnessPrompt(raw = "") {
  const text = String(raw || "").trim();
  if (!text.startsWith("[codex-slack-e2e")) return "";
  const match = text.match(/当前用户问题：([\s\S]+)$/u);
  if (!match?.[1]) return "";
  return String(match[1]).trim();
}

function extractPromptText(event = {}) {
  const prompt = String(event?.prompt || "").trim();
  const harnessPrompt = unwrapCodexHarnessPrompt(prompt);
  if (harnessPrompt) {
    return harnessPrompt;
  }
  if (prompt.startsWith("[Queued messages while agent was busy]")) {
    const busyMessages = prompt
      .split(/\r?\n/u)
      .filter((line) => String(line || "").startsWith("System:"))
      .map((line) => {
        const rawLine = String(line || "").replace(/^System:\s*/, "").trim();
        const lastColon = rawLine.lastIndexOf(": ");
        return String(lastColon >= 0 ? rawLine.slice(lastColon + 2) : rawLine).trim();
      })
      .filter(Boolean);
    if (busyMessages.length > 0) {
      return busyMessages.join("\n\n");
    }
  }
  const relayPrompt = unwrapImRelayPrompt(prompt);
  if (relayPrompt) {
    return relayPrompt;
  }
  const unwrappedPrompt = unwrapQueuedBusyPrompt(prompt);
  if (unwrappedPrompt && unwrappedPrompt !== prompt) {
    return unwrappedPrompt;
  }
  if (prompt) {
    return prompt;
  }
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (String(message?.role || "").trim().toLowerCase() !== "user") {
      continue;
    }
    const messageText = extractMessageText(message?.content);
    const harnessText = unwrapCodexHarnessPrompt(messageText);
    if (harnessText) {
      return harnessText;
    }
    const relayText = unwrapImRelayPrompt(messageText);
    if (relayText) {
      return relayText;
    }
    const text = unwrapQueuedBusyPrompt(messageText);
    if (text && text !== messageText) {
      return text;
    }
    if (messageText) {
      return messageText;
    }
  }
  return "";
}

function delegatedStickyRoute(decision) {
  const route = String(decision?.route_decision?.route || "").trim();
  if (route === "spawn_single" || route === "spawn_multi") {
    return route;
  }
  return "";
}

function parsePolicyDecisionJson(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function parseObjectJson(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function preHintAllowedTools(decision, routeHintTool) {
  const toolPolicy = decision?.tool_policy || {};
  const allowed = new Set([
    routeHintTool,
    "octoclaw_status",
    "octoclaw_task_action",
  ]);
  const delegateTool = String(toolPolicy?.must_delegate_via || "").trim();
  if (delegateTool) {
    allowed.add(delegateTool);
  }
  const controlTools = Array.isArray(toolPolicy?.allowed_control_tools) ? toolPolicy.allowed_control_tools : [];
  for (const toolName of controlTools) {
    const value = String(toolName || "").trim();
    if (value) allowed.add(value);
  }
  return allowed;
}

function observerControlTools(decision, routeHintTool) {
  const toolPolicy = decision?.tool_policy || {};
  const configured = Array.isArray(toolPolicy?.observer_control_tools) ? toolPolicy.observer_control_tools : [];
  const allowed = new Set(configured.map((item) => String(item || "").trim()).filter(Boolean));
  if (routeHintTool) {
    allowed.add(String(routeHintTool).trim());
  }
  allowed.add("octoclaw_status");
  allowed.add("octoclaw_task_action");
  allowed.add("session_status");
  return allowed;
}

function sessionControlTools(decision, routeHintTool) {
  const toolPolicy = decision?.tool_policy || {};
  const configured = Array.isArray(toolPolicy?.session_control_tools) ? toolPolicy.session_control_tools : [];
  const allowed = new Set(configured.map((item) => String(item || "").trim()).filter(Boolean));
  if (routeHintTool) {
    allowed.add(String(routeHintTool).trim());
  }
  allowed.add("octoclaw_status");
  allowed.add("session_status");
  return allowed;
}

function runnerWorkflowTools(decision, routeHintTool) {
  const toolPolicy = decision?.tool_policy || {};
  const allowed = new Set(
    (Array.isArray(toolPolicy?.allowed_control_tools) ? toolPolicy.allowed_control_tools : [])
      .map((item) => String(item || "").trim())
      .filter(Boolean),
  );
  const delegateTool = String(toolPolicy?.must_delegate_via || "").trim();
  if (delegateTool) {
    allowed.add(delegateTool);
  }
  if (routeHintTool) {
    allowed.add(String(routeHintTool).trim());
  }
  allowed.add("octoclaw_status");
  allowed.add("octoclaw_task_action");
  return allowed;
}

function isControlObserverDecision(decision) {
  return String(decision?.route_decision?.task_class || "").trim() === "control_observer";
}

function isSessionControlDecision(decision) {
  return String(decision?.route_decision?.task_class || "").trim() === "session_control";
}

function isRunnerDecision(decision) {
  return String(decision?.route_decision?.route || "").trim() === "runner";
}

function assistantMessageRole(message = {}) {
  return String(message?.role || "").trim().toLowerCase();
}

function assistantMessageText(message = {}) {
  return extractMessageText(message?.content);
}

function replaceAssistantMessageText(message = {}, text = "") {
  const next = message && typeof message === "object" ? { ...message } : {};
  if (typeof next.content === "string") {
    next.content = text;
    return next;
  }
  if (Array.isArray(next.content)) {
    next.content = [{ type: "text", text }];
    return next;
  }
  if (next.content && typeof next.content === "object" && !Array.isArray(next.content)) {
    next.content = { ...next.content, text };
    return next;
  }
  next.content = [{ type: "text", text }];
  return next;
}

function delegationFailureReply(state = {}) {
  const route = String(state?.decision?.route_decision?.route || "").trim();
  const intentClass = String(state?.conversationIntentClass || conversationIntentClass(state?.decision) || "").trim();
  if (route === "runner" && ["fresh_live_lookup", "local_surface_lookup"].includes(intentClass)) {
    return "这次查询还没真正派发到执行链，所以我现在不能把结果说成已经查到。等拿到真实执行结果后我再回复。";
  }
  return "这次任务还没真正派发成功，所以我现在不能把它说成已经完成。等拿到真实执行结果后我再回复。";
}

function contaminationFallbackReply() {
  return "这条追问命中了被子任务污染的会话上下文，我先按最新执行事实重绑后再回答，这次先不凭旧记忆下结论。";
}

function claimedDirectToolNames(text = "") {
  const raw = String(text || "");
  const normalized = raw.toLowerCase();
  const names = [];
  const add = (name) => {
    if (name && !names.includes(name)) names.push(name);
  };
  for (const name of [
    "web_fetch",
    "web_search",
    "web.run",
    "exec",
    "shell",
    "bash",
    "curl",
    "openclaw",
    "github api",
  ]) {
    if (normalized.includes(name)) add(name);
  }
  return names;
}

function looksLikeToolProvenanceClaim(text = "") {
  const raw = String(text || "");
  if (claimedDirectToolNames(raw).length === 0) return false;
  return /(我|这次|刚才|实际|确实|已经|子任务|runner|主\s*agent).{0,40}(用|用了|调用|跑|执行|查|抓|fetch|拿到|返回)/iu.test(raw)
    || /\b(i|this run|that run|actually|used|called|ran|fetched|queried)\b.{0,50}\b(web_fetch|web_search|web\.run|exec|shell|bash|curl|openclaw|github api)\b/iu.test(raw)
    || /direct tools used.{0,80}(实际|actually|used|web_fetch|web_search|exec|unavailable)/iu.test(raw);
}

function ungroundedToolProvenanceReply(state = {}, claimedTools = []) {
  const seen = Array.isArray(state?.directToolsSeen) ? state.directToolsSeen.filter(Boolean) : [];
  if (seen.length > 0) {
    return `这条回复里有未被执行事实记录覆盖的工具来源声明（${claimedTools.join(", ")}）。目前可确认的 direct tools 只有：${seen.join(", ")}。我不能把未记录的工具说成已经用过。`;
  }
  const route = String(state?.decision?.route_decision?.route || "").trim() || "unknown";
  const requestKind = String(state?.decision?.router_decision_v2?.request_kind || "").trim() || "unknown";
  return `这条回复试图声明用了 ${claimedTools.join(", ")}，但当前 execution facts 没有记录到可验证的 direct tool 调用。按事实口径：route=${route}，request_kind=${requestKind}，Direct tools used 目前不可用。我需要重新走受控查询或执行链路，不能凭记忆声称已经查过。`;
}

function guardAssistantMessageForPolicyState(message = {}, state = {}) {
  if (assistantMessageRole(message) !== "assistant") {
    return { mode: "pass", message };
  }
  const replyText = assistantMessageText(message);
  if (!replyText) {
    return { mode: "pass", message };
  }
  if (isDelegatedRoute(state?.decision) && !state?.delegated) {
    return {
      mode: "replace",
      reason: "undelegated_route_response_blocked",
      message: replaceAssistantMessageText(message, delegationFailureReply(state)),
    };
  }
  if (String(state?.sessionBoundary?.status || "").trim() === "contaminated_subagent_identity") {
    return {
      mode: "replace",
      reason: "contaminated_session_response_blocked",
      message: replaceAssistantMessageText(message, contaminationFallbackReply()),
    };
  }
  const claimedTools = claimedDirectToolNames(replyText);
  const seenTools = new Set((Array.isArray(state?.directToolsSeen) ? state.directToolsSeen : []).map((item) => String(item || "").trim().toLowerCase()).filter(Boolean));
  const ungroundedClaims = claimedTools.filter((item) => !seenTools.has(String(item || "").trim().toLowerCase()));
  if (ungroundedClaims.length > 0 && looksLikeToolProvenanceClaim(replyText)) {
    return {
      mode: "replace",
      reason: "ungrounded_tool_provenance_claim_blocked",
      message: replaceAssistantMessageText(message, ungroundedToolProvenanceReply(state, ungroundedClaims)),
    };
  }
  return { mode: "pass", message };
}

function runtimeSwitches(decision) {
  return decision?.runtime_switches || {};
}

function buildRolloutFlags(decision = {}) {
  const switches = runtimeSwitches(decision);
  return {
    contractVersion: String(switches.rollout_contract_version || "octoclaw.runtime_flags/v1"),
    policyJudgeLiveEnabled: Boolean(switches.policy_judge_live_enabled),
    cheapJudgeLiveEnabled: Boolean(switches.cheap_judge_live_enabled),
    localJudgeLiveEnabled: Boolean(switches.local_judge_live_enabled),
    runnerPoolEnabled: Boolean(switches.runner_pool_enabled),
    deliveryRelayEnabled: Boolean(switches.delivery_relay_enabled),
    legacyRunnerFallbackEnabled: Boolean(switches.legacy_runner_fallback_enabled),
    patrolLoopEnabled: Boolean(switches.patrol_loop_enabled),
    safeModeEnabled: Boolean(switches.safe_mode_enabled),
    judgeLock: String(switches.judge_lock || ""),
    overrideSources: Array.isArray(switches.override_sources) ? switches.override_sources : [],
  };
}

async function persistStickyLane(sessionKey, decision, logger, options = {}) {
  if (!runtimeSwitches(decision).sticky_lane_enabled) {
    return false;
  }
  const stickyRoute = delegatedStickyRoute(decision);
  if (!sessionKey || !stickyRoute) {
    return false;
  }
  try {
    const pathname = resolveRouteStickinessPath();
    const current = await readJsonFile(pathname, {});
    const next = current && typeof current === "object" ? { ...current } : {};
    const previous = next[sessionKey] && typeof next[sessionKey] === "object" ? next[sessionKey] : {};
    const workContract = String(decision?.route_decision?.work_contract || decision?.route_decision?.work_contract_hint || "").trim();
    const previousWorkContract = String(previous?.work_contract || previous?.work_contract_hint || "").trim();
    const previousRoute = String(previous?.route || "").trim();
    const preservedAppliedCount = previousRoute === stickyRoute && previousWorkContract === workContract
      ? Number(previous?.applied_count || 0)
      : 0;
    next[sessionKey] = {
      route: stickyRoute,
      work_type: String(decision?.route_decision?.work_type || "").trim(),
      work_contract: workContract,
      phase: String(decision?.route_decision?.phase || "").trim(),
      protocol: String(decision?.route_decision?.protocol || "").trim(),
      system_preferred_route: String(decision?.route_decision?.system_preferred_route || "").trim(),
      applied_count: preservedAppliedCount,
      updated_at: new Date().toISOString(),
      source: String(options.source || "runtime_policy").trim() || "runtime_policy",
      reason_codes: Array.isArray(decision?.route_decision?.reason_codes)
        ? decision.route_decision.reason_codes.slice(0, 8)
        : [],
    };
    await writeJsonFile(pathname, next);
    return true;
  } catch (err) {
    logger?.warn?.(`octoclaw sticky lane persist failed: ${String(err)}`);
    return false;
  }
}

async function recordPolicyReplay(eventType, payload = {}, logger, decision = null) {
  if (decision && !runtimeSwitches(decision).replay_logging_enabled) {
    return;
  }
  const correlation = decision?.correlation && typeof decision.correlation === "object" ? decision.correlation : {};
  const routeOutcomeEvents = new Set(["policy_resolved", "dispatch_called", "agent_end"]);
  const routeOutcome = decision && routeOutcomeEvents.has(String(eventType || "").trim())
    ? buildRouteOutcome(eventType, decision, payload)
    : null;
  try {
    await appendJsonl(resolveReplayLogPath(), {
      schema_version: "octoclaw.runtime_policy.replay_event/v1",
      event: eventType,
      at: new Date().toISOString(),
      turnId: String(correlation.turn_id || payload.turnId || ""),
      decisionId: String(correlation.decision_id || payload.decisionId || ""),
      deliveryId: String(correlation.delivery_id || payload.deliveryId || ""),
      runnerJobId: String(correlation.runner_job_id || payload.runnerJobId || ""),
      taskId: String(correlation.task_id || payload.taskId || ""),
      ...(decision ? { rolloutFlags: buildRolloutFlags(decision) } : {}),
      ...(routeOutcome ? { routeOutcome } : {}),
      ...payload,
    });
  } catch (err) {
    logger?.warn?.(`octoclaw runtime replay log failed: ${String(err)}`);
  }
}

function buildPolicyResolvedReplayPayload({
  decision = {},
  stateKey = "",
  ctx = {},
  boundary = {},
  metadata = {},
  prompt = "",
  routeHintSubmitted = false,
  usedCachedPolicy = false,
} = {}) {
  return {
    sessionKey: stateKey || "",
    sessionId: String(ctx?.sessionId || ""),
    trigger: String(ctx?.trigger || ""),
    route: String(decision?.route_decision?.route || ""),
    systemPreferredRoute: String(decision?.route_decision?.system_preferred_route || ""),
    workerPool: String(decision?.route_decision?.worker_pool || ""),
    taskClass: String(decision?.route_decision?.task_class || ""),
    protectedLane: String(decision?.route_decision?.protected_lane || ""),
    routeHintRequired: Boolean(decision?.route_hint_policy?.required),
    routeHintSubmitted: Boolean(routeHintSubmitted),
    stateGroundingRequired: Boolean(decision?.state_grounding?.required),
    latencyAckRequired: Boolean(decision?.latency_ack?.required),
    stickyApplied: Boolean(decision?.route_hint_policy?.sticky_applied),
    ackFollowupCandidate: Boolean(decision?.route_hint_policy?.ack_followup_candidate),
    ackFollowupApplied: Boolean(decision?.route_hint_policy?.ack_followup_applied),
    routeRecommendationConflict: Boolean(decision?.route_recommendation?.arbitration?.required),
    routeRecommendationStrategy: String(decision?.route_recommendation?.arbitration?.strategy || ""),
    routeRecommendationConflictType: String(decision?.route_recommendation?.arbitration?.conflict_type || ""),
    routeLanguagePacks: Array.isArray(decision?.route_language_packs) ? decision.route_language_packs : [],
    sessionBoundaryStatus: String(boundary?.status || ""),
    canonicalSessionKey: String(boundary?.canonicalSessionKey || stateKey || ""),
    conversationControlKind: String(metadata?.conversation_control?.kind || ""),
    conversationIntentClass: String(metadata?.intent_packet?.intent_class || metadata?.conversation_control?.intent_class || ""),
    routerRequestKind: String(decision?.router_decision_v2?.request_kind || ""),
    routerScope: String(decision?.router_decision_v2?.scope || ""),
    routerTarget: String(decision?.router_decision_v2?.target || ""),
    routerEvidenceRequired: Array.isArray(decision?.router_decision_v2?.evidence_required) ? decision.router_decision_v2.evidence_required : [],
    routerDecisionSource: String(decision?.router_decision_v2?.decision_source || ""),
    routerDecisionValid: Boolean(decision?.router_decision_v2?.validation?.passed),
    policyJudgeSelected: String(decision?.policy_router?.judge?.selected || ""),
    policyJudgeInvoked: Boolean(decision?.policy_router?.judge?.invoked),
    policyJudgeApplied: Boolean(decision?.policy_router?.judge?.applied),
    policyJudgeInvocationState: String(decision?.policy_router?.judge?.invocation_state || ""),
    policyJudgeConfidence: Number(decision?.policy_router?.judge?.confidence || 0),
    policyJudgeValidationProblems: Array.isArray(decision?.policy_router?.judge?.validation?.problems) ? decision.policy_router.judge.validation.problems : [],
    policyJudgePromptVersion: String(decision?.policy_router?.judge?.prompt_version || ""),
    policyJudgeSchemaVersion: String(decision?.policy_router?.judge?.schema_version || ""),
    decisionCacheState: String(decision?.policy_router?.cache?.state || ""),
    usedCachedPolicy: Boolean(usedCachedPolicy),
    intentPacketConfidence: Number(metadata?.intent_packet?.confidence || 0),
    intentPacketReasons: Array.isArray(metadata?.intent_packet?.reason_codes) ? metadata.intent_packet.reason_codes : [],
    prompt: truncateText(prompt),
  };
}

function buildPolicyJudgedReplayPayload(decision = {}) {
  return {
    route: String(decision?.route_decision?.route || ""),
    taskClass: String(decision?.route_decision?.task_class || ""),
    protectedLane: String(decision?.route_decision?.protected_lane || ""),
    policyJudgeSelected: String(decision?.policy_router?.judge?.selected || ""),
    policyJudgeInvoked: Boolean(decision?.policy_router?.judge?.invoked),
    policyJudgeApplied: Boolean(decision?.policy_router?.judge?.applied),
    policyJudgeInvocationState: String(decision?.policy_router?.judge?.invocation_state || ""),
    policyJudgeRoute: String(decision?.policy_router?.judge?.route || ""),
    policyJudgeConfidence: Number(decision?.policy_router?.judge?.confidence || 0),
    policyJudgeValidationProblems: Array.isArray(decision?.policy_router?.judge?.validation?.problems) ? decision.policy_router.judge.validation.problems : [],
    policyJudgePromptVersion: String(decision?.policy_router?.judge?.prompt_version || ""),
    policyJudgeSchemaVersion: String(decision?.policy_router?.judge?.schema_version || ""),
    validationOutcome: Boolean(decision?.policy_router?.judge?.validation?.passed) ? "passed" : "failed",
  };
}

function buildRouteValidatedReplayPayload(decision = {}) {
  const validation = decision?.router_decision_v2?.validation && typeof decision.router_decision_v2.validation === "object"
    ? decision.router_decision_v2.validation
    : {};
  return {
    route: String(decision?.route_decision?.route || ""),
    systemPreferredRoute: String(decision?.route_decision?.system_preferred_route || ""),
    workerPool: String(decision?.route_decision?.worker_pool || ""),
    taskClass: String(decision?.route_decision?.task_class || ""),
    protectedLane: String(decision?.route_decision?.protected_lane || ""),
    routerRequestKind: String(decision?.router_decision_v2?.request_kind || ""),
    routerScope: String(decision?.router_decision_v2?.scope || ""),
    routerTarget: String(decision?.router_decision_v2?.target || ""),
    routerEvidenceRequired: Array.isArray(decision?.router_decision_v2?.evidence_required) ? decision.router_decision_v2.evidence_required : [],
    routerDecisionSource: String(decision?.router_decision_v2?.decision_source || ""),
    routerDecisionValid: Boolean(validation?.passed),
    validationOutcome: Boolean(validation?.passed) ? "passed" : "failed",
    reason: Array.isArray(validation?.problems) && validation.problems.length > 0 ? String(validation.problems[0] || "") : "",
  };
}

async function recordAckReplay({
  decision = {},
  stateKey = "",
  ctx = {},
  logger = null,
  kind = "",
  phase = "",
  result = {},
  toolName = "",
} = {}) {
  if (!kind) return;
  const reason = String(result?.reason || "");
  if (!Boolean(result?.attempted) && !Boolean(result?.sent) && !reason) return;
  if (!Boolean(result?.attempted) && !Boolean(result?.sent) && reason === "not_required") return;
  const sent = Boolean(result?.sent);
  const fallbackUsed = Boolean(result?.fallback_used);
  const ackMode = sent
    ? (fallbackUsed ? "progress_update" : "channel_message")
    : "not_sent";
  await recordPolicyReplay(
    "ack_sent",
    {
      sessionKey: stateKey || String(decision?.request?.session_key || ""),
      sessionId: String(ctx?.sessionId || ""),
      route: String(decision?.route_decision?.route || ""),
      taskClass: String(decision?.route_decision?.task_class || ""),
      protectedLane: String(decision?.route_decision?.protected_lane || ""),
      phase: String(phase || ""),
      toolName: String(toolName || ""),
      ackKind: String(kind || ""),
      ackMode,
      ackSent: sent,
      reason,
      ackMessage: truncateText(result?.message || "", 400),
    },
    logger,
    decision,
  );
}

async function recordDeliveryRelayEvent(eventType, payload = {}, logger) {
  try {
    const pathname = resolveDeliveryRelayPath();
    const deliveryId = String(payload?.deliveryId || "").trim();
    if (await hasDeliveryRelayEvent(pathname, eventType, deliveryId)) {
      return;
    }
    await appendJsonl(resolveDeliveryRelayPath(), {
      schema_version: "octoclaw.delivery_relay.event/v1",
      event: eventType,
      at: new Date().toISOString(),
      ...payload,
    });
  } catch (err) {
    logger?.warn?.(`octoclaw delivery relay log failed: ${String(err)}`);
  }
}

function deliveryIdFor(decision = {}, payload = {}) {
  const correlation = decision?.correlation && typeof decision.correlation === "object" ? decision.correlation : {};
  return stableId("delivery", [
    correlation.turn_id,
    correlation.decision_id,
    payload?.task_id,
    payload?.materialization?.task_id,
    payload?.job?.id,
    payload?.route,
  ]);
}

function deliveryRelayEnabled(decision = {}) {
  return Boolean(runtimeSwitches(decision).delivery_relay_enabled);
}

function resolveDeliveryRelaySettings(runtimeCfg = {}) {
  const relayCfg = runtimeCfg && typeof runtimeCfg === "object" && !Array.isArray(runtimeCfg)
    && runtimeCfg.delivery_relay && typeof runtimeCfg.delivery_relay === "object" && !Array.isArray(runtimeCfg.delivery_relay)
    ? runtimeCfg.delivery_relay
    : {};
  return {
    retry_cooldown_seconds: Math.max(0, Number(relayCfg.retry_cooldown_seconds || 30)),
  };
}

function shouldRegisterPendingDelivery(decision = {}, payload = {}) {
  const materialization = payload?.materialization && typeof payload.materialization === "object" ? payload.materialization : {};
  const materializationStatus = String(materialization?.status || "").trim().toLowerCase();
  const capabilityFailure = payload?.capability_failure && typeof payload.capability_failure === "object"
    ? payload.capability_failure
    : (materialization?.capability_failure && typeof materialization.capability_failure === "object" ? materialization.capability_failure : {});
  const failureReason = String(capabilityFailure?.reason || "").trim();
  const taskId = String(payload?.task_id || materialization?.task_id || "").trim();
  const runnerJobId = String(payload?.job?.id || materialization?.runner_job_id || "").trim();
  if (failureReason || materializationStatus === "materialization_failed") {
    return { allowed: false, reason: "materialization_failed" };
  }
  if (!taskId && !runnerJobId) {
    return { allowed: false, reason: "missing_execution_identity" };
  }
  return { allowed: true, reason: "ok" };
}

async function registerPendingDelivery({
  decision = {},
  payload = {},
  summary = "",
  sessionKey = "",
  stateKey = "",
  logger = null,
} = {}) {
  if (!deliveryRelayEnabled(decision)) return { registered: false, reason: "disabled" };
  const registrationGate = shouldRegisterPendingDelivery(decision, payload);
  if (!registrationGate.allowed) return { registered: false, reason: registrationGate.reason };
  const deliveryId = deliveryIdFor(decision, payload);
  const taskId = String(payload?.task_id || payload?.materialization?.task_id || "").trim();
  const runnerJobId = String(payload?.job?.id || payload?.materialization?.runner_job_id || "").trim();
  const replaySessionKey = String(sessionKey || stateKey || decision?.request?.metadata?.session_key || "").trim();
  const event = {
    deliveryId,
    sessionKey: replaySessionKey,
    turnId: String(decision?.correlation?.turn_id || ""),
    decisionId: String(decision?.correlation?.decision_id || ""),
    route: String(decision?.route_decision?.route || payload?.route || ""),
    requestKind: String(decision?.router_decision_v2?.request_kind || ""),
    taskId,
    runnerJobId,
    state: "pending_user_visible_final",
    executed: Boolean(payload?.executed),
    materialization: payload?.materialization && typeof payload.materialization === "object" ? payload.materialization : {},
    summary: truncateText(summary, 1000),
  };
  await recordDeliveryRelayEvent("delivery_pending", event, logger);
  if (stateKey) {
    updatePolicyState(stateKey, (current) => ({
      ...current,
      pendingDeliveryId: deliveryId,
      pendingDeliverySummary: truncateText(summary, 1000),
      pendingDeliveryTaskId: taskId,
      pendingDeliveryRunnerJobId: runnerJobId,
      deliveryObserved: false,
    }));
  }
  return { registered: true, deliveryId };
}

async function reconcilePendingDeliveriesForSession(sessionKey = "", cwd = process.cwd(), logger = null, runtimeCfg = {}) {
  const normalizedSessionKey = String(sessionKey || "").trim();
  if (!normalizedSessionKey) {
    return { ok: true, pending_count: 0, items: [], skipped: true, reason: "missing_session_key" };
  }
  const relaySettings = resolveDeliveryRelaySettings(runtimeCfg);
  try {
    return await runJsonScript(
      "delivery_relay_reconcile.py",
      [
        "--relay-path",
        resolveDeliveryRelayPath(),
        "--task-state",
        resolveTaskStatePath(),
        "--session-key",
        normalizedSessionKey,
        "--retry-cooldown-seconds",
        String(relaySettings.retry_cooldown_seconds),
      ],
      cwd,
      { timeoutMs: 4000 },
    );
  } catch (err) {
    logger?.warn?.(`octoclaw delivery reconcile failed: ${String(err)}`);
    return { ok: false, pending_count: 0, items: [], error: String(err) };
  }
}

async function recordDeliveryReconcileResults(result = {}, logger = null) {
  const items = Array.isArray(result?.items) ? result.items : [];
  for (const item of items) {
    const status = String(item?.status || "").trim();
    const deliveryId = String(item?.deliveryId || "").trim();
    if (!deliveryId || !status) continue;
    if (status === "compensated") {
      await recordDeliveryRelayEvent("delivery_compensated", {
        deliveryId,
        sessionKey: String(result?.session_key || ""),
        taskId: String(item?.taskId || ""),
        runnerJobId: String(item?.runnerJobId || ""),
        state: "completion_relay_sent",
        messageId: String(item?.messageId || ""),
        summary: truncateText(item?.summary || "", 1000),
      }, logger);
    } else if (status === "already_delivered") {
      await recordDeliveryRelayEvent("delivery_reconciled_delivered", {
        deliveryId,
        sessionKey: String(result?.session_key || ""),
        taskId: String(item?.taskId || ""),
        runnerJobId: String(item?.runnerJobId || ""),
        state: "already_delivered",
        summary: truncateText(item?.summary || "", 1000),
      }, logger);
    } else if (status === "send_failed") {
      await recordDeliveryRelayEvent("delivery_failed", {
        deliveryId,
        sessionKey: String(result?.session_key || ""),
        taskId: String(item?.taskId || ""),
        runnerJobId: String(item?.runnerJobId || ""),
        state: "completion_relay_failed",
        error: String(item?.error || ""),
      }, logger);
    } else if (status === "retry_deferred") {
      await recordDeliveryRelayEvent("delivery_retry_deferred", {
        deliveryId,
        sessionKey: String(result?.session_key || ""),
        taskId: String(item?.taskId || ""),
        runnerJobId: String(item?.runnerJobId || ""),
        state: "completion_relay_retry_deferred",
        failedAttempts: Number(item?.failedAttempts || 0),
        retryAfter: String(item?.retryAfter || ""),
      }, logger);
    }
  }
}

async function recordObservedDeliveryFromMessage(message = {}, state = {}, stateKey = "", logger = null) {
  const deliveryId = String(state?.pendingDeliveryId || "").trim();
  if (!deliveryId) return { recorded: false, reason: "no_pending_delivery" };
  if (state?.deliveryObserved) return { recorded: false, reason: "already_observed", deliveryId };
  const text = assistantMessageText(message);
  if (!text) return { recorded: false, reason: "empty_message" };
  await recordDeliveryRelayEvent(
    "delivery_observed",
    {
      deliveryId,
      sessionKey: stateKey,
      route: String(state?.decision?.route_decision?.route || ""),
      taskId: String(state?.pendingDeliveryTaskId || ""),
      runnerJobId: String(state?.pendingDeliveryRunnerJobId || ""),
      state: "observed_assistant_final",
      messagePreview: truncateText(text, 1000),
    },
    logger,
  );
  updatePolicyState(stateKey, (current) => ({
    ...current,
    deliveryObserved: true,
    deliveredAt: Date.now(),
  }));
  return { recorded: true, deliveryId };
}

function isManagedAgentContext(ctx = {}) {
  if (String(process.env.OCTOCLAW_DISABLE_RUNTIME_POLICY || "").trim() === "1") {
    return false;
  }
  const trigger = String(ctx.trigger || "").trim().toLowerCase();
  if (trigger && ["heartbeat", "cron", "memory"].includes(trigger)) {
    return false;
  }
  const sessionKey = String(ctx.sessionKey || "");
  const sessionId = String(ctx.sessionId || "");
  const agentId = String(ctx.agentId || "");
  if (/subagent/i.test(sessionKey) || /subagent/i.test(sessionId) || /subagent/i.test(agentId)) {
    return false;
  }
  const managedRefs = [parseSessionRoute(sessionKey), parseSessionRoute(sessionId)].filter(
    (item) => item.sessionKey,
  );
  if (managedRefs.some((item) => item.looksLikeImSession || item.isPrimaryMainSession)) {
    return true;
  }
  if (/^agent:main:(?!main$)/i.test(sessionKey) || /^agent:main:(?!main$)/i.test(agentId)) {
    return false;
  }
  return true;
}

function buildPolicyMetadata(ctx = {}, options = {}) {
  const metadata = {};
  const boundary = detectSessionBoundary(ctx);
  const stableSessionKey = String(options.stateKey || boundary.canonicalSessionKey || resolvePolicyStateKey(ctx) || "").trim();
  const stableSession = parseSessionRoute(stableSessionKey);
  if (ctx.channelId) metadata.channel = ctx.channelId;
  if (stableSessionKey) metadata.session_key = stableSessionKey;
  if (stableSession.origin) metadata.session_origin = stableSession.origin;
  if (stableSession.target) metadata.session_target = stableSession.target;
  if (stableSession.threadId) metadata.session_thread_id = stableSession.threadId;
  if (stableSession.threadKey) metadata.session_thread_key = stableSession.threadKey;
  if (stableSession.bindingKey) metadata.session_binding_key = stableSession.bindingKey;
  if (ctx.trigger) metadata.trigger = ctx.trigger;
  if (ctx.agentId) metadata.agent_id = ctx.agentId;
  if (ctx.sessionId) metadata.session_id = ctx.sessionId;
  if (ctx.messageProvider) metadata.message_provider = ctx.messageProvider;
  metadata.message_id = String(ctx.messageId || ctx.messageTs || ctx.eventId || ctx.ts || "").trim();
  metadata.agent_namespace = "octoclaw";
  metadata.managed_by_octoclaw = true;
  metadata.session_boundary_status = boundary.status;
  metadata.turn_id = metadata.message_id
    ? stableId("turn", [
      stableSessionKey,
      metadata.message_id,
      ctx.sessionId,
      ctx.agentId,
      ctx.trigger,
    ])
    : "";
  return metadata;
}

function isDispatchableUserSessionKey(raw) {
  const value = String(raw || "").trim();
  if (!value || isSubagentSessionRef(value)) return false;
  const parsed = parseSessionRoute(value);
  if (parsed.looksLikeImSession || parsed.isPrimaryMainSession) return true;
  return /^agent:main:/i.test(value);
}

function applyUserMetadataOverrides(metadata = {}, overrides = {}) {
  const next = metadata && typeof metadata === "object" ? { ...metadata } : {};
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    return next;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (key === "session_key" && !String(value || "").trim()) {
      continue;
    }
    next[key] = value;
  }
  return next;
}

function resolveDispatchSessionKey(ctx = {}, metadata = {}, options = {}) {
  const state = options?.state && typeof options.state === "object" ? options.state : {};
  const cachedDecision = options?.cachedDecision && typeof options.cachedDecision === "object" ? options.cachedDecision : {};
  const boundary = detectSessionBoundary(ctx);
  const candidates = [
    metadata?.session_key,
    options?.stateKey,
    state?.canonicalSessionKey,
    cachedDecision?.request?.session_key,
    cachedDecision?.request?.metadata?.session_key,
    boundary.canonicalSessionKey,
    ctx?.sessionKey,
  ];
  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (isDispatchableUserSessionKey(value)) {
      return value;
    }
  }
  return "";
}

function finalizeDispatchMetadata(ctx = {}, metadata = {}, options = {}) {
  const next = metadata && typeof metadata === "object" ? { ...metadata } : {};
  const sessionKey = resolveDispatchSessionKey(ctx, next, options);
  if (sessionKey) {
    next.session_key = sessionKey;
    const parsed = parseSessionRoute(sessionKey);
    if (parsed.origin && !next.session_origin) next.session_origin = parsed.origin;
    if (parsed.target && !next.session_target) next.session_target = parsed.target;
    if (parsed.threadId && !next.session_thread_id) next.session_thread_id = parsed.threadId;
    if (parsed.threadKey && !next.session_thread_key) next.session_thread_key = parsed.threadKey;
    if (parsed.bindingKey && !next.session_binding_key) next.session_binding_key = parsed.bindingKey;
  }
  return next;
}

function enrichConversationControlMetadata(prompt, metadata = {}) {
  const nextMetadata = metadata && typeof metadata === "object" ? { ...metadata } : {};
  if (nextMetadata?.conversation_control && nextMetadata?.intent_packet) return nextMetadata;
  const hintOptions = {
    prompt,
    replayLogPath: resolveReplayLogPath(),
    taskStatePath: resolveTaskStatePath(),
    sessionKeys: [
      nextMetadata.session_key,
      nextMetadata.session_binding_key,
      nextMetadata.session_thread_key,
    ].filter(Boolean),
  };
  const intentPacket = nextMetadata?.intent_packet || buildConversationIntentPacket(hintOptions);
  if (intentPacket?.available !== false) {
    nextMetadata.intent_packet = intentPacket;
  }
  const conversationControl = nextMetadata?.conversation_control || buildConversationControlHintsFromIntent(intentPacket);
  if (conversationControl?.available) {
    nextMetadata.conversation_control = conversationControl;
  }
  return nextMetadata;
}

function inferRouteWithConversationContext(task, command = "", metadata = {}) {
  const nextMetadata = enrichConversationControlMetadata(task, metadata);
  return inferRoute(task, command, nextMetadata);
}

function buildDecision(task, options = {}) {
  const metadata = enrichConversationControlMetadata(task, options?.metadata || {});
  return buildPolicyDecision(task, {
    ...options,
    metadata,
  });
}

async function resolveStatelessPolicyDecision(task, options = {}) {
  const prompt = String(task || "").trim();
  const metadata = enrichConversationControlMetadata(prompt, options?.metadata || {});
  const runtimeCfg = loadOctoClawConfig().runtime_policy || {};
  const intentPacket = metadata?.intent_packet && typeof metadata.intent_packet === "object" ? metadata.intent_packet : {};
  if (!metadata.policy_judge_result) {
    const judgeResult = await invokePolicyJudge({
      task: prompt,
      metadata,
      intentPacket,
      runtimeCfg,
      cwd: process.cwd(),
    });
    if (judgeResult && typeof judgeResult === "object" && Object.keys(judgeResult).length > 0) {
      metadata.policy_judge_result = judgeResult;
    }
  }
  return buildPolicyDecision(prompt, {
    ...options,
    metadata,
  });
}

async function resolvePolicyDecisionForContext(prompt, ctx, cwd, logger, options = {}) {
  if (!prompt || !isManagedAgentContext(ctx)) {
    return null;
  }
  prunePolicyState();
  const stateKey = resolvePolicyStateKey(ctx);
  const existing = getPolicyStateForContext(ctx).state;
  const boundary = detectSessionBoundary(ctx);
  const metadata = { ...buildPolicyMetadata(ctx), ...(options.metadata || {}) };
  if (!String(metadata.turn_id || "").trim()) {
    metadata.turn_id = stableId("turn", [
      stateKey,
      metadata.session_key,
      ctx?.sessionId,
      ctx?.agentId,
      prompt,
    ]);
  }
  const runtimeCfg = loadOctoClawConfig().runtime_policy || {};
  const rolloutFlags = resolveRuntimeFeatureFlags(runtimeCfg);
  const deliveryRelayLive = Boolean(rolloutFlags.delivery_relay_enabled);
  if (deliveryRelayLive) {
    const reconciled = await reconcilePendingDeliveriesForSession(stateKey || String(ctx?.sessionKey || "").trim(), cwd, logger, runtimeCfg);
    await recordDeliveryReconcileResults(reconciled, logger);
    const compensatedIds = new Set(
      (Array.isArray(reconciled?.items) ? reconciled.items : [])
        .filter((item) => ["compensated", "already_delivered"].includes(String(item?.status || "").trim()))
        .map((item) => String(item?.deliveryId || "").trim())
        .filter(Boolean),
    );
    if (compensatedIds.size > 0 && stateKey) {
      updatePolicyState(stateKey, (current) => {
        if (!current || !compensatedIds.has(String(current.pendingDeliveryId || "").trim())) return current;
        return {
          ...current,
          deliveryObserved: true,
          deliveredAt: Date.now(),
        };
      });
    }
  }
  const cacheMissReason = options.force
    ? "force_refresh"
    : existing?.decision
      ? "prompt_mismatch"
      : "no_existing_state";
  if (!options.force && existing?.decision && promptsEquivalent(existing?.prompt || "", prompt)) {
    const cached = { ...existing.decision };
    if (cached.policy_router && typeof cached.policy_router === "object") {
      cached.policy_router = { ...cached.policy_router, cache: { ...cached.policy_router.cache, hit: true, state: "hit" } };
    }
    existing.updatedAt = Date.now();
    existing.decision = cached;
    setPolicyStateForContext(ctx, existing);
    await recordPolicyReplay(
      "policy_resolved",
      buildPolicyResolvedReplayPayload({
        decision: existing.decision,
        stateKey,
        ctx,
        boundary,
        metadata: existing?.decision?.request?.metadata && typeof existing.decision.request.metadata === "object"
          ? existing.decision.request.metadata
          : metadata,
        prompt,
        routeHintSubmitted: Boolean(existing?.routeHintSubmitted),
        usedCachedPolicy: true,
      }),
      logger,
      existing.decision,
    );
    await recordPolicyReplay(
      "decision_cache_hit",
      {
        sessionKey: stateKey || "",
        sessionId: String(ctx?.sessionId || ""),
        route: String(existing?.decision?.route_decision?.route || ""),
        taskClass: String(existing?.decision?.route_decision?.task_class || ""),
        protectedLane: String(existing?.decision?.route_decision?.protected_lane || ""),
        decisionCacheState: "hit",
        usedCachedPolicy: true,
        reason: "prompt_equivalent_state_reused",
      },
      logger,
      existing.decision,
    );
    return { stateKey, state: existing, decision: existing.decision };
  }
  const hintOptions = {
    prompt,
    replayLogPath: resolveReplayLogPath(),
    taskStatePath: resolveTaskStatePath(),
    sessionKeys: [
      stateKey,
      metadata.session_key,
      existing?.canonicalSessionKey,
      ctx?.sessionKey,
    ].filter(Boolean),
  };
  const intentPacket = metadata?.intent_packet || buildConversationIntentPacket(hintOptions);
  if (intentPacket?.available !== false) {
    metadata.intent_packet = intentPacket;
  }
  const conversationControl = metadata?.conversation_control || buildConversationControlHintsFromIntent(intentPacket);
  if (conversationControl?.available) {
    metadata.conversation_control = conversationControl;
  }
  const compoundPlannerResult = await invokeCompoundPlanner({
    prompt,
    intentPacket,
    sessionContext: { sessionKey: stateKey, channel: metadata?.channel },
    runtimeCfg,
  });
  if (compoundPlannerResult?.decision_mode === "compound_plan" && compoundPlannerResult.plan) {
    metadata.compound_plan = compoundPlannerResult.plan;
    const compoundDecisions = buildCompoundDecisions(compoundPlannerResult.plan, prompt, { command, metadata });
    const compoundLedger = await executeCompoundPlan(compoundPlannerResult.plan, compoundDecisions, {
      dispatchFn: async (decision) => ({ status: "dispatched", task_id: null, runner_job_id: null }),
      materializeFn: async (decision, dispatchResult) => dispatchResult || {},
      logger,
    });
    metadata.compound_plan_ledger = ledgerToJSON(compoundLedger);
  }
  const judgeResult = await invokePolicyJudge({
    task: prompt,
    metadata,
    intentPacket,
    runtimeCfg,
    cwd,
    logger,
  });
  if (judgeResult && typeof judgeResult === "object" && Object.keys(judgeResult).length > 0) {
    metadata.policy_judge_result = judgeResult;
  }
  try {
    const decision = buildDecision(prompt, { metadata });
    const nextState = {
      prompt,
      decision,
      createdAt: existing?.createdAt || Date.now(),
      updatedAt: Date.now(),
      sessionBoundary: boundary,
      canonicalSessionKey: String(boundary.canonicalSessionKey || stateKey || "").trim(),
      delegated: false,
      delegationTool: "",
      conversationIntentClass: String(metadata?.intent_packet?.intent_class || metadata?.conversation_control?.intent_class || ""),
      routeHintSubmitted: false,
      routeHintPayload: null,
      blockedTools: [],
      preDispatchAckSent: false,
      preDispatchAckText: "",
      latencyAckSent: false,
      latencyAckText: "",
    };
    setPolicyStateForContext(ctx, nextState);
    await recordPolicyReplay(
      "policy_resolved",
      buildPolicyResolvedReplayPayload({
        decision,
        stateKey,
        ctx,
        boundary,
        metadata,
        prompt,
        routeHintSubmitted: Boolean(nextState.routeHintSubmitted),
        usedCachedPolicy: false,
      }),
      logger,
      decision,
    );
    await recordPolicyReplay(
      "decision_cache_miss",
      {
        sessionKey: stateKey || "",
        sessionId: String(ctx?.sessionId || ""),
        route: String(decision?.route_decision?.route || ""),
        taskClass: String(decision?.route_decision?.task_class || ""),
        protectedLane: String(decision?.route_decision?.protected_lane || ""),
        decisionCacheState: "miss",
        usedCachedPolicy: false,
        reason: cacheMissReason,
      },
      logger,
      decision,
    );
    await recordPolicyReplay(
      "policy_judged",
      {
        sessionKey: stateKey || "",
        sessionId: String(ctx?.sessionId || ""),
        ...buildPolicyJudgedReplayPayload(decision),
      },
      logger,
      decision,
    );
    await recordPolicyReplay(
      "route_validated",
      {
        sessionKey: stateKey || "",
        sessionId: String(ctx?.sessionId || ""),
        ...buildRouteValidatedReplayPayload(decision),
      },
      logger,
      decision,
    );
    return { stateKey, state: nextState, decision };
  } catch (err) {
    logger?.warn?.(`octoclaw runtime policy resolve failed: ${String(err)}`);
    return null;
  }
}

function updatePolicyState(stateKey, mutator) {
  if (!stateKey) return null;
  hydratePolicyStateFromLedger();
  const current = policyStateBySession.get(stateKey);
  if (!current) return null;
  const next = typeof mutator === "function" ? mutator(current) : { ...current, ...mutator };
  next.updatedAt = Date.now();
  _setSessionPolicyState(stateKey, next);
  persistPolicyStateLedger();
  return next;
}

function compactPolicyPrompt(decision) {
  const route = decision?.route_decision?.route || "direct";
  const systemPreferredRoute = decision?.route_decision?.system_preferred_route || route;
  const routeHintPolicy = decision?.route_hint_policy || {};
  const routeSummary = [
    `route=${route}`,
    `system_preferred_route=${systemPreferredRoute}`,
    `worker_pool=${decision?.route_decision?.worker_pool || "octoclaw-main"}`,
    `work_type=${decision?.route_decision?.work_type || ""}`,
    `phase=${decision?.route_decision?.phase || ""}`,
    `protocol=${decision?.route_decision?.protocol || "normal"}`,
    `review_required=${decision?.review_policy?.required ? "true" : "false"}`,
  ].join(" ; ");
  const lines = [`[OctoClaw runtime policy] ${routeSummary}`];
  const skillBundle = Array.isArray(decision?.skill_policy?.default_skill_bundle)
    ? decision.skill_policy.default_skill_bundle
    : [];
  const toolPolicy = decision?.tool_policy || {};
  if (DELEGATED_ROUTE_NAMES.has(route)) {
    const controlTools = Array.isArray(toolPolicy.allowed_control_tools) ? toolPolicy.allowed_control_tools : [];
    lines.push("Delegated run: do not solve the task directly and do not use non-OctoClaw tools.");
    if (toolPolicy.must_delegate_via) {
      lines.push(`Call ${toolPolicy.must_delegate_via} first with the user's task, then answer from its handoff/report.`);
    }
    if (controlTools.length > 0) {
      lines.push(`Allowed control tools: ${controlTools.join(", ")}`);
    }
    if (decision?.prompt_contract?.artifact_first) {
      lines.push("Prefer report/artifact summaries over redoing the work in the main context.");
    }
  }
  if (route === "runner") {
    const controlTools = Array.isArray(toolPolicy.allowed_control_tools) ? toolPolicy.allowed_control_tools : [];
    lines.push("Runner workflow: do not use generic external tools directly from the main agent.");
    if (toolPolicy.must_delegate_via) {
      lines.push(`Call ${toolPolicy.must_delegate_via} first so the task runs through the runner workflow and then answer from its handoff/report.`);
    }
    if (controlTools.length > 0) {
      lines.push(`Allowed runner workflow tools: ${controlTools.join(", ")}`);
    }
  }
  if (routeHintPolicy?.required) {
    lines.push("Before answering or dispatching, call octoclaw_route_hint with your structured route suggestion.");
    lines.push(`System preferred route right now: ${routeHintPolicy.system_preferred_route || route}`);
  }
  if (routeHintPolicy?.sticky_applied && routeHintPolicy?.sticky_route) {
    lines.push(`Sticky lane is active for this session follow-up: ${routeHintPolicy.sticky_route}`);
  }
  if (decision?.state_grounding?.required) {
    lines.push("This is a fact-grounded control follow-up. Prefer current execution facts over memory.");
  }
  if (decision?.latency_ack?.required) {
    lines.push("This is a bounded live lookup. Verify with tools before answering; do not answer from memory.");
  }
  if (skillBundle.length > 0) {
    lines.push(`Preferred skill bundle: ${skillBundle.join(", ")}`);
  }
  return lines.join("\n");
}

function stringifyParamsForPolicy(value) {
  try {
    return JSON.stringify(value || {});
  } catch {
    return String(value || "");
  }
}

function matchesBlockedPattern(text, patterns = []) {
  const haystack = String(text || "").toLowerCase();
  return patterns.some((pattern) => {
    const needle = String(pattern || "").trim().toLowerCase();
    return needle && haystack.includes(needle);
  });
}

function workflowEnforcementRule(decision, toolName, routeHintTool) {
  const route = String(decision?.route_decision?.route || "").trim();
  const toolPolicy = decision?.tool_policy || {};
  const delegateTool = String(toolPolicy?.must_delegate_via || "").trim();
  const allowedTools = runnerWorkflowTools(decision, routeHintTool);
  const workflowRequired = route === "runner" || DELEGATED_ROUTE_NAMES.has(route);
  if (!workflowRequired) {
    return { block: false, route, delegateTool, allowedTools: [...allowedTools] };
  }
  if (delegateTool && toolName === delegateTool) {
    return { block: false, route, delegateTool, allowedTools: [...allowedTools] };
  }
  if (allowedTools.has(toolName)) {
    return { block: false, route, delegateTool, allowedTools: [...allowedTools] };
  }
  return {
    block: true,
    route,
    delegateTool,
    allowedTools: [...allowedTools],
  };
}

function isDelegatedRoute(decision) {
  return DELEGATED_ROUTE_NAMES.has(String(decision?.route_decision?.route || ""));
}

function routeHintRequired(decision) {
  if (decision?.route_hint_policy?.ack_followup_applied) {
    return false;
  }
  if (decision?.route_hint_policy?.sticky_applied) {
    return false;
  }
  return Boolean(decision?.route_hint_policy?.required);
}

function shouldRetainPolicyStateOnAgentEnd(state) {
  return Boolean(isDelegatedRoute(state?.decision) && !state?.delegated);
}

function policySummaryText(payload) {
  if (payload?.summary) {
    return payload.summary;
  }
  const route = payload?.route_decision?.route || "direct";
  const workerPool = payload?.route_decision?.worker_pool || "octoclaw-main";
  const profile = payload?.model_policy?.profile || "";
  const model = payload?.model_policy?.selected_model || "";
  const protocol = payload?.route_decision?.protocol || "normal";
  const review = payload?.review_policy?.required ? " / review" : "";
  const suffix = model ? ` / ${model}` : "";
  return `policy=${route} -> ${workerPool} / profile=${profile} / protocol=${protocol}${review}${suffix}`;
}

function statusToolResponse(rawOutput, format) {
  const text = [
    "OctoClaw raw status panel below. Return it verbatim to the user without summarizing or rewriting.",
    "```text",
    rawOutput,
    "```",
  ].join("\n");
  return {
    content: [{ type: "text", text }],
    details: {
      format,
      source: "status.sh",
      raw_output: rawOutput,
      return_verbatim: true,
    },
  };
}

function handoffText(payload, fallback) {
  const handoff = payload?.handoff;
  if (handoff?.user_safe && handoff?.reply_text) {
    return handoff.reply_text;
  }
  if (handoff?.summary) {
    return handoff.summary;
  }
  return fallback;
}

async function userFacingHandoff(payload, fallback, cwd) {
  const base = handoffText(payload, fallback);
  const handoff = payload?.handoff || {};
  const reportPath = handoff?.report_path || payload?.report_path || "";
  const taskId = payload?.job?.id || payload?.task_id || "";
  if (!reportPath) {
    return base;
  }
  const artifactsCmd = taskId
    ? `octoclaw_task_action artifacts ${taskId}`
    : "octoclaw_task_action artifacts";
  try {
    const preview = await readReportExcerpt(reportPath, cwd);
    if (preview?.exists && preview?.excerpt) {
      return `${base}\n\n报告摘录：\n${preview.excerpt}\n\n结果已写入：\`${reportPath}\`\n（用 \`${artifactsCmd}\` 读取完整内容）`;
    }
  } catch {
    // Fall back to the base handoff text when report preview fails.
  }
  return `${base}\n\n结果已写入：\`${reportPath}\`\n（用 \`${artifactsCmd}\` 读取完整内容）`;
}

const plugin = {
  id: "octoclaw-runtime",
  name: "OctoClaw Runtime",
  description: "Runtime policy hooks, dispatch tools, and replay logging for OctoClaw",
  register(pi) {
    OCTOCLAW_ROOT_OVERRIDE = String(pi?.pluginConfig?.octoclawRoot || "").trim();
    WORKSPACE_ROOT_OVERRIDE = String(pi?.pluginConfig?.workspaceRoot || "").trim();
    const registerLifecycleHook = (hookName, handler, priority = 180) => {
      if (typeof pi.on === "function") {
        pi.on(hookName, handler, { priority });
        return true;
    }
    if (typeof pi.registerHook === "function") {
      pi.registerHook(hookName, handler, { priority });
      return true;
    }
    return false;
  };

  registerLifecycleHook("before_model_resolve", async (event, ctx) => {
    if (!isManagedAgentContext(ctx)) return;
    const prompt = extractPromptText(event);
    const resolved = await resolvePolicyDecisionForContext(
      prompt,
      ctx,
      process.cwd(),
      pi.logger,
    );
    const decision = resolved?.decision;
    const hookConfig = decision?.hook_interface?.before_model_resolve;
    if (!hookConfig?.enabled) return;
    if (String(decision?.route_decision?.route || "direct") !== "direct") return;
    const modelOverride = String(hookConfig.selected_model || "").trim();
    if (!modelOverride) return;
    pi.logger?.debug?.(`octoclaw before_model_resolve modelOverride=${modelOverride}`);
    return { modelOverride };
  });

  registerLifecycleHook("before_prompt_build", async (event, ctx) => {
    if (!isManagedAgentContext(ctx)) return;
    const prompt = extractPromptText(event);

    // Racing ACK timer — fire neutral indicator if pipeline is slow
    let timerAckFired = false;
    let timerAckHandle = null;
    const preStateKey = resolvePolicyStateKey(ctx);
    const preMetadata = buildPolicyMetadata(ctx, { stateKey: preStateKey });
    const preSessionKey = resolveAckDeliverySessionKey(preMetadata, preStateKey, getPolicyStateForContext(ctx).state, ctx);
    if (preSessionKey) {
      timerAckHandle = setTimeout(() => {
        timerAckFired = true;
        try {
          runJsonScript(
            "send_pre_dispatch_ack.py",
            ["--session-key", preSessionKey, "--channel", String(preMetadata?.channel || ""), "--message", "…"],
            ctx?.cwd || process.cwd(),
            { timeoutMs: 2000 },
          ).catch(() => {});
        } catch {}
      }, 600);
    }

    const resolved = await resolvePolicyDecisionForContext(
      prompt,
      ctx,
      process.cwd(),
      pi.logger,
    );

    if (timerAckHandle !== null) {
      clearTimeout(timerAckHandle);
    }

    const decision = resolved?.decision;
    const hookConfig = decision?.hook_interface?.before_prompt_build;
    if (!hookConfig?.enabled) return;
    const stateKey = String(resolved?.stateKey || resolvePolicyStateKey(ctx) || "").trim();
    const state = resolved?.state || getPolicyStateForContext(ctx).state;
    const metadata = buildPolicyMetadata(ctx, { stateKey });
    await maybeSendLatencyAck(decision, metadata, stateKey, state, ctx, pi.logger, "direct_lookup");
    if (!timerAckFired) {
      scheduleEagerPreDispatchAck(decision, metadata, stateKey, state, ctx, pi.logger);
    }
    const prependSystem = [];
    if (routeHintRequired(decision)) {
      prependSystem.push(OCTOCLAW_ROUTE_HINT_SYSTEM_CONTEXT);
    }
    if (isDelegatedRoute(decision)) {
      prependSystem.push(OCTOCLAW_DELEGATION_SYSTEM_CONTEXT);
    }
    const route = String(decision?.route_decision?.route || "");
    const isSpawnRoute = route === "spawn_single" || route === "spawn_multi";
    const reviewRequired = Boolean(decision?.review_policy?.required);
    if (isSpawnRoute && reviewRequired) {
      prependSystem.push(OCTOCLAW_PRE_DELEGATION_CONFIRM_CONTEXT);
    }
    const lookupGuard = buildDirectLookupGuard(decision);
    if (lookupGuard) {
      prependSystem.push(lookupGuard);
    }
    if (decision?.state_grounding?.required) {
      const grounding = buildConversationGrounding({
        prompt,
        replayLogPath: resolveReplayLogPath(),
        taskStatePath: resolveTaskStatePath(),
        sessionKeys: [
          stateKey,
          metadata.session_key,
          state?.canonicalSessionKey,
          ctx?.sessionKey,
        ].filter(Boolean),
      });
      if (grounding?.context) {
        prependSystem.push(grounding.context);
      }
    }
    if (String(state?.sessionBoundary?.status || resolved?.state?.sessionBoundary?.status || detectSessionBoundary(ctx).status || "") === "contaminated_subagent_identity") {
      prependSystem.push([
        "[OctoClaw session boundary guard]",
        "This turn arrived on a session contaminated by subagent identity.",
        "Ignore any recalled subagent memory, tool history, or prior task outcome unless it appears in authoritative execution facts below or in fresh workflow outputs from this turn.",
        "For delegated routes, you must not claim the task was dispatched unless octoclaw_dispatch actually ran and returned a materialized result.",
      ].join("\n"));
    }
    prependSystem.push(OCTOCLAW_TASK_ACTION_SYSTEM_CONTEXT);
    if (prependSystem.length === 0) return;
    return {
      prependSystemContext: prependSystem.join("\n\n"),
      prependContext: compactPolicyPrompt(decision),
    };
  });

  registerLifecycleHook("before_tool_call", async (event, ctx) => {
    if (!isManagedAgentContext(ctx)) return;
    const { key: stateKey, state } = getPolicyStateForContext(ctx);
    const decision = state?.decision;
    const hookConfig = decision?.hook_interface?.before_tool_call;
    if (!hookConfig?.enabled) return;

    const toolName = String(event?.toolName || ctx?.toolName || "").trim();
    const routeHintTool = String(hookConfig?.route_hint_tool || "octoclaw_route_hint").trim();
    const routeHintIsRequired = Boolean(hookConfig?.route_hint_required);
    const delegationEnforcementEnabled = Boolean(hookConfig?.delegation_enforcement);
    const routeHintAlreadySubmitted = Boolean(state?.routeHintSubmitted);
    const allowedPreHintTools = preHintAllowedTools(decision, routeHintTool);
    const allowedObserverTools = observerControlTools(decision, routeHintTool);
    const allowedSessionTools = sessionControlTools(decision, routeHintTool);
    const metadata = buildPolicyMetadata(ctx, { stateKey });
    if (
      String(decision?.route_decision?.route || "") === "direct"
      && !isControlObserverDecision(decision)
      && !isSessionControlDecision(decision)
      && toolName
      && !toolName.startsWith("octoclaw_")
    ) {
      const latencyAck = await maybeSendLatencyAck(decision, metadata, stateKey, state, ctx, pi.logger, toolName);
      updatePolicyState(stateKey, (current) => ({
        ...current,
        directToolsSeen: Array.from(new Set([...(Array.isArray(current?.directToolsSeen) ? current.directToolsSeen : []), toolName])),
      }));
      await recordAckReplay({
        decision,
        stateKey,
        ctx,
        logger: pi.logger,
        kind: "latency",
        phase: "direct_tool",
        result: latencyAck,
        toolName,
      });
      await recordPolicyReplay(
        "direct_tool_called",
        {
          sessionKey: stateKey || "",
          sessionId: String(ctx?.sessionId || ""),
          route: String(decision?.route_decision?.route || ""),
          taskClass: String(decision?.route_decision?.task_class || ""),
          protectedLane: String(decision?.route_decision?.protected_lane || ""),
          toolName,
          latencyAckRequired: Boolean(decision?.latency_ack?.required),
          latencyAckSent: Boolean(latencyAck?.sent),
          latencyAckReason: String(latencyAck?.reason || ""),
        },
        pi.logger,
        decision,
      );
      await recordPolicyReplay(
        "tool_used",
        {
          sessionKey: stateKey || "",
          sessionId: String(ctx?.sessionId || ""),
          route: String(decision?.route_decision?.route || ""),
          taskClass: String(decision?.route_decision?.task_class || ""),
          protectedLane: String(decision?.route_decision?.protected_lane || ""),
          toolName,
          latencyAckRequired: Boolean(decision?.latency_ack?.required),
          latencyAckSent: Boolean(latencyAck?.sent),
          latencyAckReason: String(latencyAck?.reason || ""),
        },
        pi.logger,
        decision,
      );
    }
    if (isControlObserverDecision(decision)) {
      if (allowedObserverTools.has(toolName)) {
        return;
      }
      updatePolicyState(stateKey, (current) => ({
        ...current,
        blockedTools: [...(Array.isArray(current.blockedTools) ? current.blockedTools.slice(-7) : []), toolName].filter(Boolean),
      }));
      await recordPolicyReplay(
        "tool_blocked_control_observer",
        {
          sessionKey: stateKey || "",
          sessionId: String(ctx?.sessionId || ""),
          route: String(decision?.route_decision?.route || ""),
          toolName,
          allowedTools: [...allowedObserverTools],
        },
        pi.logger,
        decision,
      );
      return {
        block: true,
        blockReason: `OctoClaw control/observer request must use control tools only: ${[...allowedObserverTools].join(", ")}.`,
      };
    }
    if (isSessionControlDecision(decision)) {
      if (allowedSessionTools.has(toolName)) {
        return;
      }
      updatePolicyState(stateKey, (current) => ({
        ...current,
        blockedTools: [...(Array.isArray(current.blockedTools) ? current.blockedTools.slice(-7) : []), toolName].filter(Boolean),
      }));
      await recordPolicyReplay(
        "tool_blocked_session_control",
        {
          sessionKey: stateKey || "",
          sessionId: String(ctx?.sessionId || ""),
          route: String(decision?.route_decision?.route || ""),
          toolName,
          allowedTools: [...allowedSessionTools],
        },
        pi.logger,
        decision,
      );
      return {
        block: true,
        blockReason: `OctoClaw current-session control request must use session control tools only: ${[...allowedSessionTools].join(", ")}.`,
      };
    }
    if (routeHintIsRequired && !routeHintAlreadySubmitted && !allowedPreHintTools.has(toolName)) {
      updatePolicyState(stateKey, (current) => ({
        ...current,
        blockedTools: [...(Array.isArray(current.blockedTools) ? current.blockedTools.slice(-7) : []), toolName].filter(Boolean),
      }));
      await recordPolicyReplay(
        "tool_blocked_before_route_hint",
        {
          sessionKey: stateKey || "",
          sessionId: String(ctx?.sessionId || ""),
          route: String(decision?.route_decision?.route || ""),
          toolName,
          requiredTool: routeHintTool,
        },
        pi.logger,
        decision,
      );
      return {
        block: true,
        blockReason: `OctoClaw runtime policy requires ${routeHintTool} before using other tools.`,
      };
    }
    const toolPolicy = decision?.tool_policy || {};
    const blockedPatterns = Array.isArray(toolPolicy.block_tool_patterns) ? toolPolicy.block_tool_patterns : [];
    if (matchesBlockedPattern(stringifyParamsForPolicy(event?.params), blockedPatterns)) {
      await recordPolicyReplay(
        "tool_blocked_manual_delegation",
        {
          sessionKey: stateKey || "",
          sessionId: String(ctx?.sessionId || ""),
          route: String(decision?.route_decision?.route || ""),
          toolName,
        },
        pi.logger,
        decision,
      );
      return {
        block: true,
        blockReason: `OctoClaw runtime policy blocked a manual delegation pattern. Use ${toolPolicy.must_delegate_via || "octoclaw_dispatch"} instead.`,
      };
    }

    if (!delegationEnforcementEnabled) {
      return;
    }

    const workflowRule = workflowEnforcementRule(decision, toolName, routeHintTool);
    if (!workflowRule.block && workflowRule.delegateTool && toolName === workflowRule.delegateTool) {
      updatePolicyState(stateKey, (current) => ({
        ...current,
        delegated: true,
        delegationTool: toolName,
      }));
      return;
    }
    if (!workflowRule.block) {
      return;
    }
    updatePolicyState(stateKey, (current) => ({
      ...current,
      blockedTools: [...(Array.isArray(current.blockedTools) ? current.blockedTools.slice(-7) : []), toolName].filter(Boolean),
    }));
    const workflowRoute = String(workflowRule.route || decision?.route_decision?.route || "").trim();
    await recordPolicyReplay(
      workflowRoute === "runner" ? "tool_blocked_runner_policy" : "tool_blocked_delegation_policy",
      {
        sessionKey: stateKey || "",
        sessionId: String(ctx?.sessionId || ""),
        route: workflowRoute,
        toolName,
        allowedTools: workflowRule.allowedTools,
      },
      pi.logger,
      state?.decision || null,
    );
    return {
      block: true,
      blockReason: workflowRoute === "runner"
        ? `OctoClaw runtime policy route=runner requires the runner workflow. Use ${workflowRule.delegateTool || "octoclaw_dispatch"} first. Allowed workflow tools: ${workflowRule.allowedTools.join(", ") || "octoclaw_dispatch"}.`
        : `OctoClaw runtime policy route=${decision?.route_decision?.route || "direct"} requires delegation. Use ${workflowRule.delegateTool || "octoclaw_dispatch"} first. Allowed control tools: ${workflowRule.allowedTools.join(", ") || "octoclaw_dispatch"}.`,
    };
  });

  registerLifecycleHook("agent_end", async (_event, ctx) => {
    const { key: stateKey, state } = getPolicyStateForContext(ctx);
    if (!stateKey) return;
    await recordPolicyReplay(
      "agent_end",
      {
        sessionKey: stateKey,
        sessionId: String(ctx?.sessionId || ""),
        route: String(state?.decision?.route_decision?.route || ""),
        systemPreferredRoute: String(state?.decision?.route_decision?.system_preferred_route || ""),
        workerPool: String(state?.decision?.route_decision?.worker_pool || ""),
        taskClass: String(state?.decision?.route_decision?.task_class || ""),
        protectedLane: String(state?.decision?.route_decision?.protected_lane || ""),
        routeHintRequired: Boolean(state?.decision?.route_hint_policy?.required),
        routeHintSubmitted: Boolean(state?.routeHintSubmitted),
        delegated: Boolean(state?.delegated),
        delegationTool: String(state?.delegationTool || ""),
        directToolsSeen: Array.isArray(state?.directToolsSeen) ? state.directToolsSeen : [],
        blockedTools: Array.isArray(state?.blockedTools) ? state.blockedTools : [],
        ackFollowupCandidate: Boolean(state?.decision?.route_hint_policy?.ack_followup_candidate),
        ackFollowupApplied: Boolean(state?.decision?.route_hint_policy?.ack_followup_applied),
        latencyAckRequired: Boolean(state?.decision?.latency_ack?.required),
        latencyAckSent: Boolean(state?.latencyAckSent),
        routeLanguagePacks: Array.isArray(state?.decision?.route_language_packs) ? state.decision.route_language_packs : [],
      },
      pi.logger,
      state?.decision || null,
    );
    if (String(state?.pendingDeliveryId || "").trim() && !state?.deliveryObserved) {
      await recordDeliveryRelayEvent(
        "delivery_agent_end_pending",
        {
          deliveryId: String(state?.pendingDeliveryId || ""),
          sessionKey: stateKey,
          route: String(state?.decision?.route_decision?.route || ""),
          taskId: String(state?.pendingDeliveryTaskId || ""),
          runnerJobId: String(state?.pendingDeliveryRunnerJobId || ""),
          state: "pending_at_agent_end",
        },
        pi.logger,
      );
    }
    if (shouldRetainPolicyStateOnAgentEnd(state)) {
      return;
    }
    clearPolicyStateForContext(ctx);
  }, 50);

  registerLifecycleHook("before_message_write", async (event, ctx) => {
    const { key: stateKey, state } = getPolicyStateForContext({
      sessionKey: String(ctx?.sessionKey || "").trim(),
      agentId: String(ctx?.agentId || "").trim(),
    });
    if (!state) return;
    const guarded = guardAssistantMessageForPolicyState(event?.message || {}, state);
    const visibleMessage = guarded.mode === "replace" && guarded.message ? guarded.message : (event?.message || {});
    try {
      await recordObservedDeliveryFromMessage(visibleMessage, state, stateKey, pi.logger);
    } catch (err) {
      pi.logger?.warn?.(`octoclaw delivery observe failed: ${String(err)}`);
    }
    if (guarded.mode === "replace" && guarded.message) {
      return { message: guarded.message };
    }
  }, 120);

  pi.registerTool(
    {
      name: "octoclaw_route_hint",
      label: "OctoClaw Route Hint",
      description: "Submit a structured main-brain route hint so OctoClaw can merge it with system policy and return the final decision.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          task: { type: "string", description: "Optional task override. Defaults to the current prompt for this session." },
          command: { type: "string", description: "Optional shell command context." },
          routeHint: { type: "string", enum: ["direct", "spawn_single", "spawn_multi"] },
          workType: { type: "string", enum: ["ops", "research", "code", "review"] },
          phase: { type: "string", description: "Optional phase hint such as inspect, implement, collect, report, verify." },
          reviewRequired: { type: "boolean", description: "Whether review should be required after merge." },
          confidence: { type: "number", description: "Confidence from 0 to 1." },
          reason: { type: "string", description: "Short explanation for the route hint." }
        },
        required: ["routeHint"]
      },
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const { key: existingStateKey, state: existing } = resolveToolPolicyContext(ctx, params.task || "");
        const task = String(params.task || existing?.prompt || "").trim();
        if (!task) {
          throw new Error("octoclaw_route_hint requires task context");
        }
        const metadata = buildPolicyMetadata(ctx, { stateKey: existingStateKey || existing?.decision?.request?.session_key || "" });
        const replaySessionKey = String(
          existingStateKey || metadata.session_key || existing?.decision?.request?.session_key || "",
        ).trim();
        const routeHintPayload = {
          route_hint: params.routeHint,
          work_type: params.workType || "",
          phase: params.phase || "",
          review_required: Boolean(params.reviewRequired),
          confidence: typeof params.confidence === "number" ? params.confidence : 0.0,
          reason: params.reason || "",
          source: "main_agent",
        };
        const payload = await resolveStatelessPolicyDecision(task, {
          command: params.command || "",
          metadata,
          routeHint: routeHintPayload,
        });
        const stickyPersisted = await persistStickyLane(replaySessionKey, payload, pi.logger, { source: "route_hint" });
        setPolicyStateForContext(ctx, {
          ...(existing || {}),
          prompt: task,
          decision: payload,
          createdAt: existing?.createdAt || Date.now(),
          updatedAt: Date.now(),
          delegated: Boolean(existing?.delegated),
          delegationTool: existing?.delegationTool || "",
          blockedTools: Array.isArray(existing?.blockedTools) ? existing.blockedTools : [],
          routeHintSubmitted: true,
          routeHintPayload,
        });
        await recordPolicyReplay(
          "route_hint_submitted",
          {
            sessionKey: replaySessionKey,
            sessionId: String(ctx?.sessionId || ""),
            routeHint: params.routeHint,
            workType: params.workType || "",
            phase: params.phase || "",
            reviewRequired: Boolean(params.reviewRequired),
            confidence: typeof params.confidence === "number" ? params.confidence : 0.0,
            reason: truncateText(params.reason || "", 180),
            systemPreferredRoute: String(payload?.route_decision?.system_preferred_route || ""),
            finalRoute: String(payload?.route_decision?.route || ""),
            workerPool: String(payload?.route_decision?.worker_pool || ""),
            taskClass: String(payload?.route_decision?.task_class || ""),
            protectedLane: String(payload?.route_decision?.protected_lane || ""),
            stickyApplied: Boolean(payload?.route_hint_policy?.sticky_applied),
            ackFollowupCandidate: Boolean(payload?.route_hint_policy?.ack_followup_candidate),
            ackFollowupApplied: Boolean(payload?.route_hint_policy?.ack_followup_applied),
            stickyPersisted,
            routeLanguagePacks: Array.isArray(payload?.route_language_packs) ? payload.route_language_packs : [],
          },
          pi.logger,
          payload,
        );
        const nextSummary = payload?.route_decision?.route === "direct"
          ? `route_hint merged: final route is direct. You may answer directly.`
          : `route_hint merged: final route is ${payload?.route_decision?.route || "spawn_single"}. Next call octoclaw_dispatch.`;
        return toolResponse(nextSummary, payload);
      },
    },
    { source: "octoclaw-runtime" },
  );

  pi.registerTool(
    {
      name: "octoclaw_policy_decide",
      label: "OctoClaw Policy Decide",
      description: "Debug/parity helper that returns the structured OctoClaw runtime policy decision object, including route, model/profile, skill bundle, review policy, and hook interface hints.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          task: { type: "string", description: "The user task to classify and route." },
          command: { type: "string", description: "Optional shell command if one already exists." },
          channel: { type: "string", description: "Optional transport/origin hint such as slack, wechat, webchat, or any other IM identifier." },
          sessionKey: { type: "string", description: "Optional main session key." },
          forceRoute: { type: "string", enum: ["direct", "runner", "spawn_single", "spawn_multi"] },
          metadataJson: { type: "string", description: "Optional JSON object with extra routing metadata." }
        },
        required: ["task"]
      },
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        let metadata = applyUserMetadataOverrides(buildPolicyMetadata(ctx), parseObjectJson(params.metadataJson));
        if (params.channel) metadata.channel = params.channel;
        if (params.sessionKey) metadata.session_key = params.sessionKey;
        metadata = finalizeDispatchMetadata(ctx, metadata, { stateKey: String(params.sessionKey || "").trim() });
        const payload = await resolveStatelessPolicyDecision(params.task, {
          command: params.command || "",
          metadata,
          forceRoute: params.forceRoute || "",
        });
        return toolResponse(policySummaryText(payload), payload);
      },
    },
    { source: "octoclaw-runtime" },
  );

  pi.registerTool(
    {
      name: "octoclaw_route",
      label: "OctoClaw Route",
      description: "Debug/parity helper that exposes the current Node-side route decision for a task.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          task: { type: "string", description: "The user task to classify." },
          command: { type: "string", description: "Optional shell command if the task already includes one." }
        },
        required: ["task"]
      },
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const payload = await resolveStatelessPolicyDecision(params.task, {
          command: params.command || "",
          metadata: buildPolicyMetadata(ctx),
        });
        return toolResponse(
          policySummaryText(payload),
          payload,
        );
      },
    },
    { source: "octoclaw-runtime" },
  );

  pi.registerTool(
    {
      name: "octoclaw_dispatch",
      label: "OctoClaw Dispatch",
      description: "Run OctoClaw dispatch so lightweight tasks use runner and larger tasks return a subagent execution plan.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          task: { type: "string", description: "The task to dispatch." },
          command: { type: "string", description: "Optional shell command for runner tasks." },
          cwd: { type: "string", description: "Optional working directory override." },
          forceRoute: { type: "string", enum: ["auto", "direct", "runner", "spawn_single", "spawn_multi"] },
          timeoutSeconds: { type: "number", description: "Runner timeout in seconds." },
          sessionKey: { type: "string", description: "Optional session key override." },
          metadataJson: { type: "string", description: "Optional JSON object with extra session metadata." },
          policyJson: { type: "string", description: "Optional precomputed runtime policy decision JSON." }
        },
        required: ["task"]
      },
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const args = ["--task", params.task];
        if (params.command) args.push("--command", params.command);
        if (params.cwd) args.push("--cwd", params.cwd);
        if (typeof params.timeoutSeconds === "number") args.push("--timeout-seconds", String(params.timeoutSeconds));
        if (params.forceRoute) args.push("--force-route", params.forceRoute);
        let { key: stateKey, state } = resolveToolPolicyContext(ctx, params.task || "");
        const hadCachedDecision = Boolean(params.policyJson || state?.decision);
        const managedSessionKey = String(state?.decision?.request?.session_key || buildPolicyMetadata(ctx).session_key || "").trim();
        let cachedDecision = state?.decision || parsePolicyDecisionJson(params.policyJson || "");
        let freshDecisionSource = "";
        if (!cachedDecision) {
          const resolved = await resolvePolicyDecisionForContext(
            String(params.task || "").trim(),
            ctx,
            ctx?.cwd || process.cwd(),
            pi.logger,
          );
          if (resolved?.decision) {
            stateKey = resolved.stateKey || stateKey;
            state = resolved.state || state;
            cachedDecision = resolved.decision;
            freshDecisionSource = "fresh_context_resolve";
          }
        }
        // P0-1: fail closed — managed context without sealed decision cannot materialize delegated route
        const resolvedRoute = String(params.forceRoute || cachedDecision?.route_decision?.route || "direct").trim();
        const isDelegatedRoute = ["runner", "spawn_single", "spawn_multi"].includes(resolvedRoute);
        if (!hadCachedDecision && isDelegatedRoute && managedSessionKey && !params.policyJson) {
          const driftSummary = `sealed_decision_required: managed session ${managedSessionKey.substring(0, 40)}… requires cached/passed policy for delegated route=${resolvedRoute}; got fresh decision from freeform prompt (source=${freshDecisionSource}). This violates §4.6.1 (dispatch must not re-judge).`;
          await recordPolicyReplay("sealed_decision_required", {
            sessionKey: managedSessionKey,
            sessionId: String(ctx?.sessionId || ""),
            route: resolvedRoute,
            freshDecisionSource,
            hadCachedDecision: false,
            policyJsonProvided: false,
          }, pi.logger);
          return toolResponse(
            driftSummary,
            { sealed_decision_required: true, route: resolvedRoute, error: "freeform_reroute_blocked" },
          );
        }
        let metadata = { ...buildPolicyMetadata(ctx, { stateKey: stateKey || cachedDecision?.request?.session_key || "" }) };
        if (params.sessionKey) metadata.session_key = params.sessionKey;
        if (params.metadataJson) {
          try {
            const parsed = JSON.parse(params.metadataJson);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              metadata = applyUserMetadataOverrides(metadata, parsed);
            }
          } catch {}
        }
        metadata = finalizeDispatchMetadata(ctx, metadata, { stateKey, state, cachedDecision });
        if (metadata.session_key) args.push("--session-key", String(metadata.session_key));
        if (Object.keys(metadata).length > 0) args.push("--metadata-json", JSON.stringify(metadata));
        const policyDecisionJson = params.policyJson || (cachedDecision ? JSON.stringify(cachedDecision) : "");
        if (policyDecisionJson) args.push("--policy-json", policyDecisionJson);
        const ackResult = await ensurePreDispatchAck(cachedDecision, metadata, stateKey, state, ctx, _onUpdate, pi.logger);
        await recordAckReplay({
          decision: cachedDecision,
          stateKey,
          ctx,
          logger: pi.logger,
          kind: "pre_dispatch",
          phase: "before_dispatch",
          result: ackResult,
        });
        const dispatchRoute = String(cachedDecision?.route_decision?.route || params.route || "").trim();
        const waitTimeoutSeconds = { runner: 12, spawn_single: 30, spawn_multi: 5, direct: 5 }[dispatchRoute] ?? 12;
        args.push("--wait", "--wait-timeout-seconds", String(waitTimeoutSeconds));
        const payload = await runJsonScript("dispatch_task.py", args, ctx?.cwd || process.cwd());
        const authoritativeDecision = payload?.policy_decision || cachedDecision || parsePolicyDecisionJson(params.policyJson || "");
        const replaySessionKey = String(
          stateKey
          || metadata.session_key
          || authoritativeDecision?.request?.session_key
          || payload?.job?.session_key
          || payload?.session_key
          || "",
        ).trim();
        const stickyDecision = delegatedStickyRoute(authoritativeDecision)
          ? authoritativeDecision
          : {
              route_decision: {
                route: String(payload?.route || ""),
                system_preferred_route: String(payload?.system_preferred_route || payload?.route || ""),
                work_type: String(payload?.work_type || ""),
                phase: String(payload?.phase || ""),
                protocol: String(payload?.protocol || ""),
                reason_codes: Array.isArray(payload?.reason_codes) ? payload.reason_codes : [],
              },
            };
        const stickyPersisted = await persistStickyLane(replaySessionKey, stickyDecision, pi.logger, { source: "dispatch" });
        const summary = await userFacingHandoff(
          payload,
          `OctoClaw dispatch: ${payload.route}${payload.executed ? " (executed)" : " (planned)"}`,
          ctx?.cwd || process.cwd(),
        );
        const deliveryRegistration = await registerPendingDelivery({
          decision: authoritativeDecision,
          payload,
          summary,
          sessionKey: replaySessionKey,
          stateKey,
          logger: pi.logger,
        });
        const sessionBoundary = detectSessionBoundary(ctx);
        await recordPolicyReplay(
          "dispatch_called",
          {
            sessionKey: replaySessionKey,
            sessionId: String(ctx?.sessionId || ""),
            route: String(authoritativeDecision?.route_decision?.route || payload?.route || ""),
            systemPreferredRoute: String(authoritativeDecision?.route_decision?.system_preferred_route || payload?.system_preferred_route || ""),
            workerPool: String(authoritativeDecision?.route_decision?.worker_pool || payload?.worker_pool || ""),
            taskClass: String(authoritativeDecision?.route_decision?.task_class || ""),
            protectedLane: String(authoritativeDecision?.route_decision?.protected_lane || ""),
            routeHintRequired: Boolean(authoritativeDecision?.route_hint_policy?.required),
            routeHintSubmitted: Boolean(state?.routeHintSubmitted || authoritativeDecision?.route_hint_policy?.submitted),
            executed: Boolean(payload?.executed),
            usedCachedPolicy: hadCachedDecision,
            originalRoute: String(cachedDecision?.route_decision?.route || params.forceRoute || ""),
            routeChanged: String(cachedDecision?.route_decision?.route || "") !== String(payload?.route || ""),
            decisionSource: hadCachedDecision ? "cached" : (params.policyJson ? "policy_json" : freshDecisionSource || "fresh"),
            routeOverrideSource: String(stickyResult?.stickyReasons?.[0] || ""),
            fallbackReason: String(payload?.capability_failure?.reason || payload?.reason || ""),
            stickyPersisted,
            preDispatchAckRequired: Boolean(cachedDecision?.pre_dispatch_ack?.required),
            preDispatchAckAttempted: Boolean(ackResult?.attempted || ackResult?.sent),
            preDispatchAckDelivered: Boolean(ackResult?.sent && !ackResult?.fallback_used && ackResult?.channel_attempt?.sent),
            preDispatchAckSent: Boolean(ackResult?.sent),
            preDispatchAckReason: String(ackResult?.reason || ""),
            preDispatchAckFallbackUsed: Boolean(ackResult?.fallback_used),
            preDispatchAckChannelReason: String(ackResult?.channel_attempt?.reason || ""),
            deliveryId: String(deliveryRegistration?.deliveryId || ""),
            deliveryPendingRegistered: Boolean(deliveryRegistration?.registered),
            taskId: String(payload?.task_id || payload?.materialization?.task_id || ""),
            runnerJobId: String(payload?.job?.id || payload?.materialization?.runner_job_id || ""),
            runnerExecutionMode: String(payload?.runner_execution_mode || ""),
            runner_runtime_resolution: payload?.runner_runtime_resolution && typeof payload.runner_runtime_resolution === "object"
              ? payload.runner_runtime_resolution
              : {},
            routeRecommendationConflict: Boolean(authoritativeDecision?.route_recommendation?.arbitration?.required),
            routeRecommendationStrategy: String(authoritativeDecision?.route_recommendation?.arbitration?.strategy || ""),
            routeRecommendationConflictType: String(authoritativeDecision?.route_recommendation?.arbitration?.conflict_type || ""),
            sessionBoundaryStatus: String(sessionBoundary.status || ""),
            canonicalSessionKey: String(sessionBoundary.canonicalSessionKey || replaySessionKey || ""),
            materialization: payload?.materialization && typeof payload.materialization === "object" ? payload.materialization : {},
            capability_failure: payload?.capability_failure && typeof payload.capability_failure === "object"
              ? payload.capability_failure
              : (payload?.materialization?.capability_failure && typeof payload.materialization.capability_failure === "object" ? payload.materialization.capability_failure : {}),
          },
          pi.logger,
          authoritativeDecision,
        );
        return toolResponse(
          summary,
          compactDispatchDetails(payload),
        );
      },
    },
    { source: "octoclaw-runtime" },
  );

  pi.registerTool(
    {
      name: "octoclaw_spawn",
      label: "OctoClaw Spawn",
      description: "Generate and register a validated OctoClaw spawn task. Use this instead of hand-writing sessions_spawn arguments.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          task: { type: "string", description: "The task to run in a subagent." },
          route: { type: "string", enum: ["spawn_single", "spawn_multi"] },
          model: { type: "string", description: "Optional model override." },
          runtime: { type: "string", enum: ["subagent", "acp"] },
          streamTo: { type: "string", description: "Only valid when runtime=acp." },
          parentId: { type: "string", description: "Optional parent task id." },
          sessionKey: { type: "string", description: "Optional parent session key." },
          metadataJson: { type: "string", description: "Optional JSON object with extra session metadata." },
          execute: { type: "boolean", description: "Whether to immediately execute spawn via ClawTeam when enabled." }
        },
        required: ["task"]
      },
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const args = ["--task", params.task, "--register"];
        if (params.route) args.push("--route", params.route);
        if (params.model) args.push("--model", params.model);
        if (params.runtime) args.push("--runtime", params.runtime);
        if (params.streamTo) args.push("--stream-to", params.streamTo);
        if (params.parentId) args.push("--parent-id", params.parentId);
        const { key: existingStateKey, state: existingState } = resolveToolPolicyContext(ctx, params.task || "");
        const parentDecision = existingState?.decision;
        const parentRoute = String(parentDecision?.route_decision?.route || "").trim();
        const parentSessionKey = String(parentDecision?.request?.session_key || "").trim();
        if (parentDecision && parentRoute === "runner" && params.route === "spawn_single") {
          return toolResponse(
            `sealed_route_violation: parent route is runner, cannot reroute to spawn_single. This violates §4.6.1.`,
            { sealed_route_violation: true, parent_route: "runner", attempted_route: "spawn_single", error: "freeform_reroute_blocked" },
          );
        }
        let metadata = { ...buildPolicyMetadata(ctx, { stateKey: existingStateKey || parentSessionKey || existingState?.decision?.request?.session_key || "" }) };
        if (params.sessionKey) metadata.session_key = params.sessionKey;
        if (!metadata.session_key && parentSessionKey) metadata.session_key = parentSessionKey;
        if (params.metadataJson) {
          try {
            const parsed = JSON.parse(params.metadataJson);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              metadata = applyUserMetadataOverrides(metadata, parsed);
            }
          } catch {}
        }
        metadata = finalizeDispatchMetadata(ctx, metadata, {
          stateKey: existingStateKey,
          state: existingState,
          cachedDecision: existingState?.decision,
        });
        if (metadata.session_key) args.push("--session-key", String(metadata.session_key));
        if (Object.keys(metadata).length > 0) args.push("--metadata-json", JSON.stringify(metadata));
        if (typeof params.execute === "boolean") args.push(params.execute ? "--execute" : "--no-execute");
        const payload = await runJsonScript("octoclaw_spawn.py", args, ctx?.cwd || process.cwd());
        const summary = await userFacingHandoff(
          payload,
          `OctoClaw spawn registered: ${payload.worker_pool || payload.route} / ${payload.model}`,
          ctx?.cwd || process.cwd(),
        );
        return toolResponse(
          summary,
          compactDispatchDetails(payload),
        );
      },
    },
    { source: "octoclaw-runtime" },
  );

  pi.registerTool(
    {
      name: "octoclaw_task_action",
      label: "OctoClaw Task Action",
      description: "Handle task anchor fallback commands like details, queue, artifacts, stop, retry, approve, and reject.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string", description: "Fallback command text such as 'details task-123' or 'queue'." },
          action: { type: "string", enum: ["details", "queue", "artifacts", "stop", "retry", "approve", "reject", "view", "detail"] },
          taskId: { type: "string", description: "Task id for task-scoped actions." },
          format: { type: "string", enum: ["text", "json"] },
        },
      },
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const action = String(params.action || "").trim();
        const taskId = String(params.taskId || "").trim();
        const rawText = String(params.text || "").trim() || [action, taskId].filter(Boolean).join(" ").trim();
        if (!rawText) {
          throw new Error("octoclaw_task_action requires either text or action/taskId");
        }
        const format = String(params.format || "json").trim() || "json";
        const result = await runCommand(
          "python3",
          [resolveScript("task_anchor_commands.py"), "--format", format, ...rawText.split(/\s+/)],
          { cwd: ctx?.cwd || process.cwd() },
        );
        if (result.code !== 0 && !result.stdout) {
          throw new Error(result.stderr || "task_anchor_commands.py failed");
        }
        let payload = null;
        if (format === "json") {
          try {
            payload = JSON.parse(result.stdout || "{}");
          } catch {
            throw new Error(`task_anchor_commands.py returned invalid JSON: ${result.stdout}`);
          }
        }
        const summary = payload?.text || result.stdout || rawText;
        return toolResponse(String(summary || "").trim(), payload || { raw_output: result.stdout, stderr: result.stderr, action_text: rawText });
      },
    },
    { source: "octoclaw-runtime" },
  );

  pi.registerTool(
    {
      name: "octoclaw_status",
      label: "OctoClaw Status",
      description: "Show current OctoClaw runner and task state. Default to task anchors; use compact/table/lanes only when the user explicitly asks for those legacy views.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          format: { type: "string", enum: ["anchors", "compact", "table", "lanes"] }
        }
      },
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const format = params.format || "anchors";
        const output = await runStatus(format, ctx?.cwd || process.cwd());
        return statusToolResponse(output, format);
      },
    },
    { source: "octoclaw-runtime" },
  );

  pi.registerCommand({
    name: "octotask",
    description: "Run an OctoClaw task anchor fallback command such as details <task_id> or queue",
    acceptsArgs: true,
    handler: async (ctx) => {
      const commandText = String(ctx.args || "").trim();
      if (!commandText) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /octotask <details|queue|artifacts|stop|retry|approve|reject> [task_id]", "error");
        return;
      }
      const result = await runCommand(
        "python3",
        [resolveScript("task_anchor_commands.py"), "--format", "text", ...commandText.split(/\s+/)],
        { cwd: ctx?.cwd || process.cwd() },
      );
      const output = String(result.stdout || result.stderr || "").trim();
      if (ctx.hasUI) {
        ctx.ui.setEditorText(output);
        ctx.ui.notify(result.code === 0 ? "OctoClaw task action completed" : "OctoClaw task action failed", result.code === 0 ? "info" : "error");
      }
    },
  });

  pi.registerCommand({
    name: "octostatus",
    description: "Show OctoClaw status; default task anchors, with compact/table/lanes available when explicitly requested",
    acceptsArgs: true,
    handler: async (ctx) => {
      const format = String(ctx.args || "").trim() || "anchors";
      const output = await runStatus(format, ctx?.cwd || process.cwd());
      if (ctx.hasUI) {
        ctx.ui.notify(`OctoClaw status (${format})`);
        ctx.ui.setEditorText(output);
      }
    },
  });

  pi.registerCommand({
    name: "octoroute",
    description: "Show the current Node-side OctoClaw route decision for a task",
    acceptsArgs: true,
    handler: async (ctx) => {
      const task = String(ctx.args || "").trim();
      if (!task) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /octoroute <task>", "error");
        return;
      }
      const payload = await resolveStatelessPolicyDecision(task, { metadata: buildPolicyMetadata(ctx) });
      if (ctx.hasUI) {
        ctx.ui.setEditorText(JSON.stringify(payload, null, 2));
        ctx.ui.notify(policySummaryText(payload));
      }
    },
  });

  pi.registerCommand({
    name: "octopolicy",
    description: "Show the structured OctoClaw runtime policy decision for a task",
    acceptsArgs: true,
    handler: async (ctx) => {
      const task = String(ctx.args || "").trim();
      if (!task) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /octopolicy <task>", "error");
        return;
      }
      const payload = await resolveStatelessPolicyDecision(task);
      if (ctx.hasUI) {
        ctx.ui.setEditorText(JSON.stringify(payload, null, 2));
        ctx.ui.notify(policySummaryText(payload));
      }
    },
  });

  pi.registerCommand({
    name: "octospawn",
    description: "Register a validated OctoClaw spawn task",
    acceptsArgs: true,
    handler: async (ctx) => {
      const task = String(ctx.args || "").trim();
      if (!task) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /octospawn <task>", "error");
        return;
      }
      const payload = await runJsonScript("octoclaw_spawn.py", ["--task", task, "--register"], ctx?.cwd || process.cwd());
      if (ctx.hasUI) {
        ctx.ui.setEditorText(JSON.stringify(payload, null, 2));
        ctx.ui.notify(`OctoClaw spawn registered: ${payload.task_id}`);
      }
    },
  });
  },
};

export default plugin;
export const __octoclawTest = {
  resolveOctoClawRoot,
  resolveWorkspaceRoot,
  resolvePythonBin,
  resolvePolicyStateLedgerPath,
  resolveReplayLogPath,
  resolveDeliveryRelayPath,
  resolveTaskStatePath,
  stripAgentSessionPrefix,
  parseSessionRoute,
  loadSessionDescriptors,
  resolveAckDeliverySessionKey,
  isSubagentSessionRef,
  detectSessionBoundary,
  resolvePolicyStateKeys,
  resolvePolicyStateKey,
  extractQueuedBusyMessages,
  promptLookupCandidates,
  promptsEquivalent,
  findPolicyStateByPrompt,
  resolveToolPolicyContext,
  unwrapQueuedBusyPrompt,
  extractPromptText,
  isManagedAgentContext,
  buildPolicyMetadata,
  applyUserMetadataOverrides,
  resolveDispatchSessionKey,
  finalizeDispatchMetadata,
  preHintAllowedTools,
  observerControlTools,
  sessionControlTools,
  runnerWorkflowTools,
  isControlObserverDecision,
  isSessionControlDecision,
  isRunnerDecision,
  workflowEnforcementRule,
  shouldRetainPolicyStateOnAgentEnd,
  preDispatchAckText,
  shouldSendPreDispatchAck,
  maybeSendEagerPreDispatchAck,
  registerPendingDelivery,
  reconcilePendingDeliveriesForSession,
  recordDeliveryReconcileResults,
  recordObservedDeliveryFromMessage,
  scheduleEagerPreDispatchAck,
  latencyAckText,
  shouldSendLatencyAck,
  maybeEmitPreDispatchAckProgress,
  ensurePreDispatchAck,
  maybeSendLatencyAck,
  assistantMessageRole,
  assistantMessageText,
  replaceAssistantMessageText,
  guardAssistantMessageForPolicyState,
  resolvePolicyDecisionForContext,
  inferRoute,
  inferRouteWithConversationContext,
  buildRawDecision: buildPolicyDecision,
  buildDecision,
  resolveStatelessPolicyDecision,
  buildConversationGrounding,
  buildDirectLookupGuard,
  __conversationControlTest,
  __setPolicyState: setPolicyStateForContext,
  __resetPolicyState: () => {
    policyStateBySession.clear();
    persistPolicyStateLedger();
  },
};
process.on("exit", () => _persistSessionState(policyStateBySession));
