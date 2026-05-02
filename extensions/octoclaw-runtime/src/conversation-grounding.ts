import fsSync from "node:fs";
import path from "node:path";

import {
  buildIntentPacket,
  type IntentClass,
  type IntentHints,
  type IntentPacket,
} from "@octoclaw/policy/intent";
import { buildDelegateStatusPacket } from "./context/delegate-packets.js";
import { sanitizeMainContextInjection } from "./context/context-budget.js";
import type { DelegateStatusPacket } from "@octoclaw/contracts/delegate-context";
import { normalizeSemanticPrompt } from "./semantic-prompt.js";
import { openRuntimeLedger } from "./runtime-ledger/index.js";
import type { DatabaseSync } from "./runtime-ledger/types.js";

interface FsSyncLike {
  readFileSync(pathname: string, encoding: string): string;
}

const fs = fsSync as unknown as FsSyncLike;

type JsonRecord = Record<string, unknown>;

export type RelationToRecentExecution =
  | "existing_execution_followup"
  | "existing_execution_provenance_query"
  | "new_work"
  | "ambiguous";

export interface RecentExecutionContext {
  workContractId: string;
  taskStateStatus: string;
  lastEventType: string;
  completionVerdict: string;
}

export interface ConversationIntentPacket extends IntentPacket {
  available: boolean;
  intent_class: IntentClass;
  schema_version: string;
  source: string;
  reason_codes: string[];
  surface_id?: string;
  lane_hint?: string;
  lookup_scope?: string;
  require_fresh_lookup?: boolean;
  require_state_grounding?: boolean;
  provenance_followup?: boolean;
  relation_to_recent_execution?: RelationToRecentExecution;
  recent_execution_context?: RecentExecutionContext;
}

export interface ConversationControlHints {
  available: boolean;
  reason?: string;
  kind?: string;
  intent_class?: string;
  route_hint?: string;
  lane_hint?: string;
  protected_lane?: string;
  require_state_grounding?: boolean;
  require_fresh_lookup?: boolean;
  provenance_followup?: boolean;
  status_followup?: boolean;
  lookup_scope?: string;
  lookup_project?: string;
  lookup_focus?: string;
  surface_id?: string;
  intent_packet: ConversationIntentPacket;
}

interface ReplayTurn {
  sessionKey: string;
  sessionId: string;
  at: string;
  prompt: string;
  route: string;
  taskClass: string;
  protectedLane: string;
  events: JsonRecord[];
  facts?: TurnFacts;
}

interface TurnFacts {
  ackSeen: boolean;
  ackKind: string;
  ackMode: string;
  ackSent: boolean;
  ackReason: string;
  dispatchSeen: boolean;
  dispatchExecuted: boolean;
  delegated: boolean;
  delegationTool: string;
  directTools: string[];
  taskId: string;
  runnerJobId: string;
  currentTaskStatus: string;
  currentTaskSummary: string;
  taskBoundSeen: boolean;
  runnerStartedSeen: boolean;
  latestTaskEventKind: string;
  latestTaskEventMessage: string;
  deliveryEventKind: string;
  materializationStatus: string;
  executionKind: string;
  runnerPlanKind: string;
  runnerPlanSummary: string;
  delegatedProbeKind: string;
  delegatedProbeSource: string;
  delegatedProbeProject: string;
  delegatedProbeFocus: string;
  dispatchMode: string;
  claimOwner: string;
  workspaceMode: string;
  writeScopeSummary: string;
  substrateState: string;
  substrateRevision: number | null;
  queuePosition: number | null;
  actionAvailability: string[];
  capabilityFailure: JsonRecord;
  capabilityFailureDetail: string;
}

const INTENT_PACKET_SCHEMA_VERSION = "octoclaw.intent_packet/v1";
const META_PROMPT_PATTERNS = [
  /(你是怎么查的|咋查的|如何查的|怎么查到的|用什么查的)/iu,
  /(刚才那个任务.*判定是啥|刚才.*不是\s*runner|是不是\s*runner|是不是\s*spawn_single|是不是\s*single)/iu,
  /(刚才.*(?:single|spawn|runner)\s*成功了吗|(?:single|spawn|runner)\s*成功了吗|那个\s*(?:single|spawn|runner)怎么样了|那个任务怎么样了)/iu,
  /\b(how did you check|how was this checked|was this runner|was this spawn(?:_single)?|did the single succeed)\b/iu,
];
const PROVENANCE_PROMPT_PATTERNS = [
  /(谁查的|谁做的|谁处理的|谁执行的|是不是子任务做的|是不是主agent自己查的|自己查的[，,、\s]*还是|自己做的[，,、\s]*还是)/iu,
  /\b(who handled this|who answered this|was this delegated|was this a subtask|did you look that up yourself|did you do it yourself)\b/iu,
];
const TASK_PROGRESS_PROMPT_PATTERNS = [
  /((?:single|spawn|runner)\s*成功了吗|任务怎样了|任务怎么样了|现在什么状态|还在\s*queued\s*吗|还在排队吗)/iu,
  /\b(single succeeded|spawn succeeded|runner succeeded|task status|still queued|still running)\b/iu,
];
const PLAIN_CHAT_PROMPT_PATTERNS = [
  /^(在吗|在不在|你好|您好|嗨|哈喽|hello|hi|hey)[？?!.。！\s]*$/iu,
];
const FRESH_LIVE_LOOKUP_PATTERNS = [
  /(查|查下|查一下|查询|再查|再看|看下|看一下|看看|确认|确认下|确认一下).{0,16}(openclaw|octoclaw).{0,24}(更新|发版|release|版本|最新版|最新版本|新特性|特性|changelog|memory|dream)/iu,
  /(查|查下|查一下|查询|搜索|确认|确认下|确认一下|真实查证).{0,40}(openclaw|octoclaw).{0,80}(相比|对比|比较|变化|差异|release|changelog|发布说明)/iu,
  /(openclaw|octoclaw).{0,24}(有啥更新|有什么更新|有没有新的发版|有没有新发版|有没有新的release|有没有新release|最近.*更新|最新.*更新|最近.*发版|最近.*release|新版本|最新版|最新版本|最新.*特性|新特性|release notes|发布说明)/iu,
  /(查|查下|查一下|查询|搜索|确认|确认下|确认一下).{0,32}(官方|官网|model card|模型说明|release notes|发布说明|最新版|最新版本)/iu,
  /\b(check|look up|see|verify|confirm)\b.{0,18}\b(openclaw|octoclaw)\b.{0,24}\b(update|updates|release|version|latest version|what'?s new|changelog|memory|dream)\b/iu,
];
const OPERATOR_SURFACE_REGISTRY = [
  {
    surface_id: "system_load",
    lane_hint: "reply",
    scope: "local_surface_lookup",
    patterns: [
      /(系统负载|机器负载|系统状态|cpu|内存|磁盘|load average|uptime|负载情况|资源占用)/iu,
      /\b(system load|machine load|cpu usage|memory usage|disk usage|load average|uptime|system status)\b/iu,
    ],
  },
  {
    surface_id: "runtime_version",
    lane_hint: "reply",
    scope: "local_surface_lookup",
    patterns: [
      /(你现在啥版本|现在什么版本|当前.*版本|openclaw.*版本|版本号)/iu,
      /\b(current version|openclaw version|runtime version)\b/iu,
    ],
  },
  {
    surface_id: "runtime_model",
    lane_hint: "reply",
    scope: "local_surface_lookup",
    patterns: [
      /(你是啥模型|你是什么模型|当前是啥模型|现在用的啥模型)/iu,
      /\b(what model are you using|what model are you on|current model|main session model)\b/iu,
    ],
  },
  {
    surface_id: "service_health",
    lane_hint: "observe",
    scope: "local_surface_lookup",
    patterns: [
      /(服务健康|健康状态|服务状态|gateway状态|gateway health|health check)/iu,
      /\b(service health|service status|system health|gateway status|gateway health)\b/iu,
    ],
  },
  {
    surface_id: "octoclaw_task_status_panel",
    lane_hint: "reply",
    scope: "local_status_surface",
    patterns: [
      /^\s*(?:状态面板|八爪鱼状态)[\s。！？!?]*$/iu,
    ],
  },
];

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return String(value ?? "").trim();
}

function parseTimestamp(value: unknown): number {
  const parsed = new Date(stringValue(value));
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

function normalizeText(value: string): string {
  return stringValue(value).replace(/\s+/g, " ").toLowerCase();
}

function promptLookupCandidates(raw: string): string[] {
  const base = stringValue(raw);
  if (!base) {
    return [];
  }
  const values: string[] = [];
  const seen = new Set<string>();
  const push = (value: string) => {
    const normalized = normalizeText(value);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    values.push(normalized);
  };
  const queued = extractQueuedBusyMessages(base);
  if (queued.length > 0) {
    push(queued[queued.length - 1] || "");
    for (const item of queued) {
      push(item);
    }
    push(queued.join("\n\n"));
  }
  push(unwrapQueuedBusyPrompt(base));
  push(base);
  return values;
}

function promptsEquivalent(left: string, right: string): boolean {
  const leftCandidates = promptLookupCandidates(left);
  const rightSet = new Set(promptLookupCandidates(right));
  return leftCandidates.some((value) => rightSet.has(value));
}

function extractQueuedBusyMessages(raw: string): string[] {
  const text = stringValue(raw);
  if (!text.startsWith("[Queued messages while agent was busy]")) {
    return [];
  }
  const messages: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("System:")) {
      continue;
    }
    const rawLine = line.replace(/^System:\s*/, "").trim();
    const lastColon = rawLine.lastIndexOf(": ");
    const message = stringValue(lastColon >= 0 ? rawLine.slice(lastColon + 2) : rawLine);
    if (message) {
      messages.push(message);
    }
  }
  return messages;
}

function unwrapQueuedBusyPrompt(raw: string): string {
  const text = stringValue(raw);
  if (!text) {
    return "";
  }
  const messages = extractQueuedBusyMessages(text);
  return messages.length > 0 ? messages.join("\n\n") : text;
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (isRecord(part) && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (isRecord(content) && typeof content.text === "string") {
    return content.text.trim();
  }
  return "";
}

function unwrapImRelayPrompt(raw: string): string {
  const text = stringValue(raw);
  if (!text) {
    return "";
  }
  const hasRelayMetadata = /Conversation info \(untrusted metadata\):/u.test(text)
    || /Sender \(untrusted metadata\):/u.test(text);
  if (!hasRelayMetadata) {
    return "";
  }
  const afterSender = text.replace(/^.*?Sender \(untrusted metadata\):\s*```[\s\S]*?```\s*/u, "").trim();
  if (afterSender && !/^System:/u.test(afterSender)) {
    return afterSender;
  }
  const afterConversation = text.replace(/^.*?Conversation info \(untrusted metadata\):\s*```[\s\S]*?```\s*/u, "").trim();
  if (afterConversation && !/^System:/u.test(afterConversation)) {
    return afterConversation;
  }
  const firstLine = text.split(/\r?\n/u, 1)[0] || "";
  const systemMatch = firstLine.match(/^System:\s*\[[^\]]+\]\s*[^:]+:\s*(.+)$/u);
  return stringValue(systemMatch?.[1]);
}

function unwrapCodexHarnessPrompt(raw: string): string {
  const text = stringValue(raw);
  if (!text.startsWith("[codex-slack-e2e")) {
    return "";
  }
  const match = text.match(/当前用户问题：([\s\S]+)$/u);
  return stringValue(match?.[1]);
}

function extractPromptText(event: JsonRecord): string {
  const prompt = stringValue(event.prompt);
  const harnessPrompt = unwrapCodexHarnessPrompt(prompt);
  if (harnessPrompt) {
    return harnessPrompt;
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
  const messages = Array.isArray(event.messages) ? event.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || stringValue(message.role).toLowerCase() !== "user") {
      continue;
    }
    const text = extractMessageText(message.content);
    const harnessText = unwrapCodexHarnessPrompt(text);
    if (harnessText) {
      return harnessText;
    }
    const relayText = unwrapImRelayPrompt(text);
    if (relayText) {
      return relayText;
    }
    const unwrapped = unwrapQueuedBusyPrompt(text);
    if (unwrapped && unwrapped !== text) {
      return unwrapped;
    }
    if (text) {
      return text;
    }
  }
  return "";
}

function inferFreshLookupProject(prompt = ""): string {
  const text = stringValue(prompt);
  if (/(openclaw)/iu.test(text)) return "openclaw";
  if (/(octoclaw)/iu.test(text)) return "octoclaw";
  return "";
}

function inferFreshLookupFocus(prompt = ""): string {
  const text = stringValue(prompt);
  if (/(memory|dream|diary|rem)/iu.test(text)) return "memory";
  if (/(release|发版|版本|更新|changelog|特性|变化|what'?s new)/iu.test(text)) return "release_updates";
  return "latest_updates";
}

function isMetaPrompt(prompt = ""): boolean {
  const text = stringValue(prompt);
  return META_PROMPT_PATTERNS.some((pattern) => pattern.test(text))
    || PROVENANCE_PROMPT_PATTERNS.some((pattern) => pattern.test(text))
    || TASK_PROGRESS_PROMPT_PATTERNS.some((pattern) => pattern.test(text));
}

function isTaskProgressPrompt(prompt = ""): boolean {
  const text = stringValue(prompt);
  return TASK_PROGRESS_PROMPT_PATTERNS.some((pattern) => pattern.test(text));
}

function isPlainChatPrompt(prompt = ""): boolean {
  const text = stringValue(prompt);
  return PLAIN_CHAT_PROMPT_PATTERNS.some((pattern) => pattern.test(text));
}

function isProvenancePrompt(prompt = ""): boolean {
  const text = stringValue(prompt);
  return PROVENANCE_PROMPT_PATTERNS.some((pattern) => pattern.test(text))
    || /怎么查/u.test(text)
    || /\bhow did you check\b/iu.test(text);
}

function isFreshLiveLookupPrompt(prompt = ""): boolean {
  const text = stringValue(prompt);
  if (!text || isMetaPrompt(text) || isTaskProgressPrompt(text) || isProvenancePrompt(text)) {
    return false;
  }
  return FRESH_LIVE_LOOKUP_PATTERNS.some((pattern) => pattern.test(text));
}

function detectOperatorSurface(prompt = ""): { surface_id: string; lane_hint: string; scope: string } | null {
  const text = stringValue(prompt);
  if (!text) {
    return null;
  }
  for (const surface of OPERATOR_SURFACE_REGISTRY) {
    if (surface.patterns.some((pattern) => pattern.test(text))) {
      return {
        surface_id: surface.surface_id,
        lane_hint: surface.lane_hint,
        scope: surface.scope,
      };
    }
  }
  return null;
}

export function readJsonl(pathname: string): Record<string, unknown>[] {
  try {
    const raw = fs.readFileSync(pathname, "utf8");
    return String(raw || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
  } catch {
    return [];
  }
}

function readJsonFile(pathname: string): JsonRecord {
  try {
    const raw = fs.readFileSync(pathname, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function buildTaskIndex(taskStatePath = ""): Map<string, JsonRecord> {
  const payload = readJsonFile(taskStatePath);
  const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
  const index = new Map<string, JsonRecord>();
  for (const task of tasks) {
    if (!isRecord(task)) {
      continue;
    }
    const taskId = stringValue(task.id);
    if (taskId) {
      index.set(taskId, task);
    }
  }
  return index;
}

function deriveTaskEventsPath(taskStatePath = ""): string {
  const normalized = stringValue(taskStatePath);
  return normalized ? path.join(path.dirname(normalized), "task-events.jsonl") : "";
}

function buildTaskEventIndex(taskEventsPath = ""): Map<string, JsonRecord[]> {
  const events = readJsonl(taskEventsPath);
  const index = new Map<string, JsonRecord[]>();
  for (const event of events) {
    const taskId = stringValue(event.task_id);
    if (!taskId) {
      continue;
    }
    index.set(taskId, [...(index.get(taskId) || []), event]);
  }
  return index;
}

function groupedReplayTurns(events: JsonRecord[]): ReplayTurn[] {
  const ordered = [...events].sort((left, right) => parseTimestamp(left.at) - parseTimestamp(right.at));
  const activeBySession = new Map<string, ReplayTurn>();
  const turns: ReplayTurn[] = [];
  for (const event of ordered) {
    const sessionKey = stringValue(event.sessionKey);
    if (!sessionKey) {
      continue;
    }
    if (stringValue(event.event) === "policy_resolved") {
      const turn: ReplayTurn = {
        sessionKey,
        sessionId: stringValue(event.sessionId),
        at: stringValue(event.at),
        prompt: extractPromptText(event),
        route: stringValue(event.route),
        taskClass: stringValue(event.taskClass),
        protectedLane: stringValue(event.protectedLane),
        events: [event],
      };
      activeBySession.set(sessionKey, turn);
      turns.push(turn);
      continue;
    }
    const current = activeBySession.get(sessionKey);
    if (!current) {
      continue;
    }
    current.events.push(event);
    if (!current.route && event.route) current.route = stringValue(event.route);
    if (!current.taskClass && event.taskClass) current.taskClass = stringValue(event.taskClass);
    if (!current.protectedLane && event.protectedLane) current.protectedLane = stringValue(event.protectedLane);
  }
  return turns;
}

function latestEvent(turn: ReplayTurn, eventName: string): JsonRecord | null {
  for (let index = turn.events.length - 1; index >= 0; index -= 1) {
    const event = turn.events[index];
    if (stringValue(event.event) === eventName) {
      return event;
    }
  }
  return null;
}

function projectionInt(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeDelegateStatus(value: string): DelegateStatusPacket["status"] {
  switch (normalizeText(value)) {
    case "planned":
    case "pending":
      return "planned";
    case "queued":
      return "queued";
    case "running":
    case "in_progress":
      return "running";
    case "completed":
    case "done":
    case "success":
    case "succeeded":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "timed_out":
    case "timeout":
      return "timed_out";
    case "blocked":
      return "blocked";
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      return "planned";
  }
}

function sanitizedStatusPacket(value: unknown): DelegateStatusPacket {
  const sanitized = sanitizeMainContextInjection(value);
  return isRecord(sanitized) ? sanitized as unknown as DelegateStatusPacket : value as DelegateStatusPacket;
}

function renderDelegateStatusContext(packet: DelegateStatusPacket, extras: {
  route?: string;
  workerPool?: string;
  substrate?: string;
  delivery?: string;
} = {}): string {
  const lines = [
    "[OctoClaw task status]",
    `schema: ${packet.schemaVersion}`,
    `task_id: ${packet.delegateTaskId || "(unknown)"}`,
    `status: ${packet.status || "unknown"}`,
  ];
  if (extras.route) lines.push(`route: ${extras.route}`);
  if (extras.workerPool) lines.push(`worker_pool: ${extras.workerPool}`);
  if (packet.modelProfile) lines.push(`model: ${packet.modelProfile}`);
  if (packet.createdAt) lines.push(`created_at: ${packet.createdAt}`);
  if (packet.lastEventAt) lines.push(`last_event_at: ${packet.lastEventAt}`);
  if (packet.progressSummary) lines.push(`progress: ${packet.progressSummary}`);
  if (packet.terminalSummary) lines.push(`terminal_summary: ${packet.terminalSummary}`);
  if (extras.substrate) lines.push(`substrate: ${extras.substrate}`);
  if (extras.delivery) lines.push(`delivery: ${extras.delivery}`);
  if (packet.error) lines.push(`error: ${packet.error}`);
  if (["failed", "timed_out", "blocked"].includes(packet.status)) {
    lines.push(`retryable: ${packet.retryable ? "true" : "check with octoclaw_task_action retry"}`);
  }
  if (packet.artifactRefs.length > 0) lines.push(`artifacts: ${packet.artifactRefs.join(", ")}`);
  lines.push("Answer from these facts only. Do not guess from memory.");
  return lines.join("\n");
}

function buildTurnFacts(
  turn: ReplayTurn,
  taskIndex: Map<string, JsonRecord>,
  taskEventIndex: Map<string, JsonRecord[]>,
): TurnFacts {
  const ackEvent = latestEvent(turn, "ack_sent") || {};
  const dispatch = latestEvent(turn, "dispatch_called") || {};
  const agentEnd = latestEvent(turn, "agent_end") || {};
  const materialization = isRecord(dispatch.materialization) ? dispatch.materialization : {};
  const capabilityFailure = isRecord(dispatch.capability_failure)
    ? dispatch.capability_failure
    : (isRecord(materialization.capability_failure) ? materialization.capability_failure : {});
  const taskId = stringValue(dispatch.taskId || materialization.task_id || materialization.child_spec_id);
  const runnerJobId = stringValue(dispatch.runnerJobId || materialization.runner_job_id);
  const taskRecordId = taskId || runnerJobId;
  const task = taskRecordId ? (taskIndex.get(taskRecordId) || {}) : {};
  const artifacts = isRecord(task.artifacts) ? task.artifacts : {};
  const runnerPlan = isRecord(artifacts.runner_plan) ? artifacts.runner_plan : {};
  const probeSpec = isRecord(runnerPlan.probe_spec) ? runnerPlan.probe_spec : {};
  const runtimeTruth = isRecord(artifacts.runtime_truth) ? artifacts.runtime_truth : {};
  const substrate = isRecord(runtimeTruth.substrate) ? runtimeTruth.substrate : {};
  const taskEvents = taskRecordId ? (taskEventIndex.get(taskRecordId) || []) : [];
  const latestTaskEvent = taskEvents[taskEvents.length - 1] || {};
  const taskBoundEvent = [...taskEvents].reverse().find((event) => stringValue(event.kind) === "task_bound") || {};
  const runnerStartedEvent = [...taskEvents].reverse().find((event) => stringValue(event.kind) === "runner_started") || {};
  const deliveryEvent = [...taskEvents].reverse().find((event) => [
    "delivery_sent",
    "delivery_failed",
    "user_notified",
  ].includes(stringValue(event.kind))) || {};
  const directToolEvents = turn.events.filter((event) => ["direct_tool_called", "tool_used"].includes(stringValue(event.event)));
  const state = normalizeText(stringValue(task.status));
  const actionAvailability = ["details", "queue", "timeline", "retrieve", "graph"];
  if (["queued", "running", "blocked", "needs_approval"].includes(state)) actionAvailability.push("stop");
  if (["failed", "deferred", "blocked"].includes(state)) actionAvailability.push("retry");

  return {
    ackSeen: Object.keys(ackEvent).length > 0,
    ackKind: stringValue(ackEvent.ackKind),
    ackMode: stringValue(ackEvent.ackMode),
    ackSent: Boolean(ackEvent.ackSent),
    ackReason: stringValue(ackEvent.reason),
    dispatchSeen: Object.keys(dispatch).length > 0,
    dispatchExecuted: Boolean(dispatch.executed),
    delegated: Boolean(agentEnd.delegated || dispatch.executed),
    delegationTool: stringValue(agentEnd.delegationTool),
    directTools: Array.from(new Set(directToolEvents.map((event) => stringValue(event.toolName)).filter(Boolean))),
    taskId,
    runnerJobId,
    currentTaskStatus: stringValue(task.status),
    currentTaskSummary: stringValue(task.summary),
    taskBoundSeen: Object.keys(taskBoundEvent).length > 0,
    runnerStartedSeen: Object.keys(runnerStartedEvent).length > 0,
    latestTaskEventKind: stringValue(latestTaskEvent.kind),
    latestTaskEventMessage: stringValue(latestTaskEvent.message),
    deliveryEventKind: stringValue(deliveryEvent.kind),
    materializationStatus: stringValue(materialization.status),
    executionKind: stringValue(materialization.kind),
    runnerPlanKind: stringValue(runnerPlan.kind),
    runnerPlanSummary: stringValue(runnerPlan.summary),
    delegatedProbeKind: stringValue(probeSpec.kind),
    delegatedProbeSource: stringValue(probeSpec.source),
    delegatedProbeProject: stringValue(probeSpec.project),
    delegatedProbeFocus: stringValue(probeSpec.focus),
    dispatchMode: stringValue(dispatch.runnerExecutionMode || dispatch.runner_execution_mode),
    claimOwner: stringValue(task.claim_owner || runtimeTruth.claim_owner || runtimeTruth.owner),
    workspaceMode: stringValue(task.workspace_mode || runtimeTruth.workspace_mode),
    writeScopeSummary: stringValue(task.write_scope_summary || runtimeTruth.write_scope_summary),
    substrateState: stringValue(task.openclaw_taskflow_substrate_state || substrate.state || task.openclaw_native_status),
    substrateRevision: projectionInt(task.openclaw_taskflow_substrate_revision ?? substrate.revision),
    queuePosition: projectionInt(task.queue_position),
    actionAvailability,
    capabilityFailure,
    capabilityFailureDetail: stringValue(capabilityFailure.detail),
  };
}

function selectSubjectTurn(turns: ReplayTurn[], prompt = "", sessionKeys: string[] = []): ReplayTurn | null {
  const normalizedPrompt = normalizeText(prompt);
  const preferredSessionSet = new Set(sessionKeys.map((item) => stringValue(item)).filter(Boolean));
  const scopedTurns = preferredSessionSet.size > 0
    ? turns.filter((turn) => preferredSessionSet.has(turn.sessionKey))
    : turns;
  const olderTurns = scopedTurns.filter((turn) => normalizeText(turn.prompt) !== normalizedPrompt);
  const nonMetaTurns = olderTurns.filter((turn) => !isMetaPrompt(turn.prompt));
  if (isTaskProgressPrompt(prompt)) {
    const delegatedTurns = nonMetaTurns.filter((turn) => {
      const facts = turn.facts;
      return Boolean(facts && (facts.dispatchSeen || facts.taskId || facts.runnerJobId));
    });
    if (delegatedTurns.length > 0) {
      return delegatedTurns[delegatedTurns.length - 1] || null;
    }
  }
  if (isProvenancePrompt(prompt)) {
    const factualTurns = nonMetaTurns.filter((turn) => {
      const facts = turn.facts;
      return Boolean(facts && (facts.dispatchSeen || facts.directTools.length > 0));
    });
    if (factualTurns.length > 0) {
      return factualTurns[factualTurns.length - 1] || null;
    }
  }
  return nonMetaTurns[nonMetaTurns.length - 1] || olderTurns[olderTurns.length - 1] || null;
}

function noGrounding(reason = "no_recent_subject_turn"): { available: false; reason: string; context: string } {
  return {
    available: false,
    reason,
    context: [
      "[OctoClaw grounded follow-up]",
      "No reliable execution facts were recovered for this follow-up.",
      "Do not answer from memory. Use octoclaw_status / octoclaw_task_action to refresh facts first, or state that the fact is unavailable.",
    ].join("\n"),
  };
}

function buildRecentExecutionContext(options: {
  taskStatePath?: string;
  replayLogPath?: string;
}): RecentExecutionContext | null {
  const taskStatePath = stringValue(options.taskStatePath);
  if (!taskStatePath) return null;

  const taskIndex = buildTaskIndex(taskStatePath);
  if (taskIndex.size === 0) return null;

  const turns = groupedReplayTurns(readJsonl(stringValue(options.replayLogPath)));

  let latestTaskId = "";
  for (const turn of turns) {
    const facts = buildTurnFacts(turn, taskIndex, buildTaskEventIndex(deriveTaskEventsPath(taskStatePath)));
    const tId = stringValue(facts.taskId);
    if (tId) {
      latestTaskId = tId;
    }
  }

  if (!latestTaskId) return null;

  const taskRecord = taskIndex.get(latestTaskId);
  if (!taskRecord) return null;

  const workContractId = stringValue(taskRecord.workContractId || taskRecord.work_contract_id);
  const taskStateStatus = stringValue(taskRecord.status || taskRecord.task_status);
  const lastEventType = stringValue(taskRecord.last_event_type || taskRecord.latest_event_kind);

  let completionVerdict = "missing";
  if (workContractId) {
    try {
      const opened = openRuntimeLedgerBestEffort();
      if (opened) {
        try {
          const row = opened.prepare("SELECT verdict FROM completion_bindings WHERE work_contract_id = ? ORDER BY created_at DESC LIMIT 1").get(workContractId);
          completionVerdict = stringValue((row as JsonRecord | null)?.verdict) || "missing";
        } finally {
          opened.close();
        }
      }
    } catch {
      completionVerdict = "missing";
    }
  }

  return {
    workContractId,
    taskStateStatus,
    lastEventType,
    completionVerdict,
  };
}

function openRuntimeLedgerBestEffort(): DatabaseSync | null {
  try {
    const result = openRuntimeLedger({ mode: "best_effort" });
    return result.status === "ok" && result.db ? result.db : null;
  } catch {
    return null;
  }
}

function classifyRelationToRecentExecution(
  ctx: RecentExecutionContext | null,
  prompt: string,
): RelationToRecentExecution {
  if (!ctx) return "new_work";
  if (!ctx.workContractId && !ctx.taskStateStatus) return "new_work";

  const terminalStatuses = new Set(["completed", "failed", "timed_out", "cancelled"]);
  if (terminalStatuses.has(ctx.taskStateStatus)) return "new_work";

  if (isProvenancePrompt(prompt) && !isMetaPrompt(prompt) && !isTaskProgressPrompt(prompt)) {
    return "existing_execution_provenance_query";
  }

  if (isMetaPrompt(prompt) || isTaskProgressPrompt(prompt)) {
    return "existing_execution_followup";
  }

  return "ambiguous";
}

export function buildConversationIntentPacket(options: {
  prompt?: string;
  replayLogPath?: string;
  taskStatePath?: string;
  sessionKeys?: string[];
} = {}): ConversationIntentPacket {
  const prompt = normalizeSemanticPrompt(options.prompt) || stringValue(options.prompt);
  if (!prompt) {
    const packet = buildIntentPacket({ intentClass: "undetermined" });
    return {
      ...packet,
      available: false,
      intent_class: packet.intentClass,
      schema_version: INTENT_PACKET_SCHEMA_VERSION,
      source: "deterministic_front_gate",
      reason_codes: ["empty_prompt"],
    };
  }

  const surface = detectOperatorSurface(prompt);
  const turns = groupedReplayTurns(readJsonl(stringValue(options.replayLogPath)));
  const taskIndex = buildTaskIndex(stringValue(options.taskStatePath));
  const taskEventIndex = buildTaskEventIndex(deriveTaskEventsPath(stringValue(options.taskStatePath)));
  const enrichedTurns = turns.map((turn) => ({
    ...turn,
    facts: buildTurnFacts(turn, taskIndex, taskEventIndex),
  }));
  const subjectTurn = selectSubjectTurn(enrichedTurns, prompt, Array.isArray(options.sessionKeys) ? options.sessionKeys : []);

  const recentExecutionContext = buildRecentExecutionContext({
    taskStatePath: stringValue(options.taskStatePath),
    replayLogPath: stringValue(options.replayLogPath),
  });
  const relationToRecentExecution = classifyRelationToRecentExecution(recentExecutionContext, prompt);

  let hints: IntentHints = {};
  let source = "deterministic_front_gate";
  let reasonCodes = ["semantic_judge_required"];
  let isProvenanceOnly = false;
  const explicitFollowup = Boolean(subjectTurn && (isMetaPrompt(prompt) || isTaskProgressPrompt(prompt) || isProvenancePrompt(prompt)));
  const similarityFallbackFollowup = Boolean(subjectTurn && !explicitFollowup && promptsEquivalent(prompt, subjectTurn.prompt));
  if (isPlainChatPrompt(prompt)) {
    hints = { intentClass: "plain_chat" };
    source = "deterministic_plain_chat_classifier";
    reasonCodes = ["plain_chat_short_greeting"];
  } else if (surface) {
    hints = { surfaceBound: true };
    source = "deterministic_surface_registry";
    reasonCodes = [`operator_surface:${surface.surface_id}`];
  } else if (isFreshLiveLookupPrompt(prompt)) {
    hints = { requiresFreshLookup: true };
    source = "deterministic_live_lookup_classifier";
    reasonCodes = ["stable_fresh_live_lookup"];
  } else if (explicitFollowup || similarityFallbackFollowup) {
    hints = { executionFollowup: true };
    source = "deterministic_followup_grounding";
    reasonCodes = similarityFallbackFollowup ? ["recent_execution_followup_similarity_fallback"] : ["recent_execution_followup"];
    isProvenanceOnly = isProvenancePrompt(prompt) && !isMetaPrompt(prompt) && !isTaskProgressPrompt(prompt);
  } else if (!subjectTurn && isProvenancePrompt(prompt)) {
    // Provenance prompt without history — still execution_followup (no verifiable record)
    hints = { executionFollowup: true };
    source = "deterministic_provenance_no_history";
    reasonCodes = ["provenance_followup_no_history"];
    isProvenanceOnly = true;
  }

  const packet = buildIntentPacket(hints);
  return {
    ...packet,
    available: true,
    intent_class: packet.intentClass,
    schema_version: INTENT_PACKET_SCHEMA_VERSION,
    source,
    reason_codes: reasonCodes,
    surface_id: surface?.surface_id,
    lane_hint: surface?.lane_hint,
    lookup_scope: surface?.scope,
    require_fresh_lookup: Boolean(surface),
    require_state_grounding: Boolean(surface && surface.lane_hint !== "reply"),
    provenance_followup: isProvenanceOnly,
    relation_to_recent_execution: recentExecutionContext ? relationToRecentExecution : undefined,
    recent_execution_context: recentExecutionContext || undefined,
  };
}

export function buildConversationControlHints(options: {
  prompt?: string;
  replayLogPath?: string;
  taskStatePath?: string;
  sessionKeys?: string[];
} = {}): ConversationControlHints {
  return buildConversationControlHintsFromIntent(buildConversationIntentPacket(options));
}

export function buildConversationControlHintsFromIntent(intentPacket: Partial<ConversationIntentPacket> = {}): ConversationControlHints {
  const intentClass = stringValue(intentPacket.intent_class || intentPacket.intentClass);
  const surfaceId = stringValue(intentPacket.surface_id);
  const packetLaneHint = stringValue(intentPacket.lane_hint);
  const packetLookupScope = stringValue(intentPacket.lookup_scope);
  const base: ConversationControlHints = {
    available: true,
    kind: intentClass,
    intent_class: intentClass,
    intent_packet: intentPacket as ConversationIntentPacket,
  };
  if (intentClass === "execution_followup") {
    return {
      ...base,
      route_hint: "reply",
      lane_hint: "control_observer",
      protected_lane: "control_observer",
      require_state_grounding: true,
      provenance_followup: Boolean(intentPacket.provenance_followup),
    };
  }
  if (intentClass === "plain_chat") {
    return {
      ...base,
      route_hint: "reply",
      lane_hint: "reply",
      require_state_grounding: false,
      require_fresh_lookup: false,
    };
  }
  if (intentClass === "local_surface_lookup") {
    if (surfaceId === "octoclaw_task_status_panel") {
      return {
        ...base,
        route_hint: "reply",
        lane_hint: "status_surface",
        protected_lane: "control_observer",
        lookup_scope: packetLookupScope || "local_status_surface",
        require_fresh_lookup: true,
        require_state_grounding: true,
        status_followup: true,
        surface_id: surfaceId,
      };
    }
    const shouldDelegateObservedSurface = new Set(["system_load", "runtime_version", "runtime_model", "service_health"]).has(surfaceId);
    if (shouldDelegateObservedSurface) {
      return {
        ...base,
        route_hint: "delegate",
        lane_hint: packetLaneHint === "reply" ? "observe" : (packetLaneHint || "observe"),
        protected_lane: "control_observer",
        lookup_scope: packetLookupScope || "local_instance",
        require_fresh_lookup: true,
        require_state_grounding: true,
        surface_id: surfaceId,
      };
    }
    return {
      ...base,
      route_hint: "reply",
      lane_hint: "reply",
      lookup_scope: packetLookupScope || "local_instance",
      require_state_grounding: false,
      surface_id: surfaceId,
    };
  }
  if (intentClass === "fresh_live_lookup") {
    return {
      ...base,
        route_hint: "delegate",
        lane_hint: "observe",
      lookup_scope: "upstream_project",
      lookup_project: inferFreshLookupProject(""),
      lookup_focus: inferFreshLookupFocus(""),
      require_fresh_lookup: true,
      require_state_grounding: false,
      surface_id: surfaceId,
    };
  }
  return {
    available: false,
    reason: "intent_not_projected_to_conversation_control",
    intent_packet: intentPacket as ConversationIntentPacket,
  };
}

export function buildConversationGrounding(options: {
  prompt?: string;
  replayLogPath?: string;
  taskStatePath?: string;
  sessionKeys?: string[];
  recentExecutionFacts?: string;
} = {}): { available: boolean; reason?: string; context?: string; subjectPrompt?: string; route?: string; taskClass?: string; protectedLane?: string; facts?: TurnFacts } {
  const prompt = stringValue(options.prompt);
  const recentExecutionFacts = stringValue(options.recentExecutionFacts);
  const turns = groupedReplayTurns(readJsonl(stringValue(options.replayLogPath)));
  const taskIndex = buildTaskIndex(stringValue(options.taskStatePath));
  const taskEventIndex = buildTaskEventIndex(deriveTaskEventsPath(stringValue(options.taskStatePath)));
  const enrichedTurns = turns.map((turn) => ({
    ...turn,
    facts: buildTurnFacts(turn, taskIndex, taskEventIndex),
  }));
  const subjectTurn = selectSubjectTurn(enrichedTurns, prompt, Array.isArray(options.sessionKeys) ? options.sessionKeys.map((item) => stringValue(item)) : []);
  if (!subjectTurn?.facts) {
    return noGrounding("no_recent_subject_turn");
  }
  const facts = subjectTurn.facts;
  const taskRecord = facts.taskId ? taskIndex.get(facts.taskId) : null;
  const workerPool = taskRecord ? stringValue(taskRecord.worker_pool) : "";
  const modelProfile = taskRecord
    ? stringValue((taskRecord as JsonRecord).model || taskRecord.role)
    : "";
  const createdAt = taskRecord ? stringValue(taskRecord.spawned_at || taskRecord.started_at) : "";
  const lastEventAt = taskRecord ? stringValue(taskRecord.updated_at || taskRecord.completed_at) : "";
  const isTerminal = facts.currentTaskStatus === "completed" || facts.currentTaskStatus === "failed" || facts.currentTaskStatus === "timed_out";
  const statusPacket = buildDelegateStatusPacket({
    threadBindingKey: stringValue(subjectTurn.sessionKey),
    delegateTaskId: facts.taskId || facts.runnerJobId || "(unknown)",
    nativeFlowId: stringValue((taskRecord as JsonRecord | null)?.flow_id || (taskRecord as JsonRecord | null)?.flowId),
    nativeTaskId: facts.taskId || facts.runnerJobId || "(unknown)",
    status: normalizeDelegateStatus(facts.currentTaskStatus || facts.materializationStatus),
    attemptStatus: facts.latestTaskEventKind || facts.materializationStatus || null,
    role: stringValue((taskRecord as JsonRecord | null)?.role || subjectTurn.protectedLane || "delegate"),
    modelProfile: modelProfile || "unknown",
    createdAt: createdAt || undefined,
    lastEventAt: lastEventAt || undefined,
    progressSummary: facts.currentTaskSummary,
    terminalSummary: isTerminal ? (facts.currentTaskSummary || facts.materializationStatus || "unknown") : "",
    error: facts.capabilityFailure && Object.keys(facts.capabilityFailure).length > 0
      ? stringValue(facts.capabilityFailure.reason || facts.capabilityFailure.code || "unknown")
      : "",
    retryable: facts.capabilityFailure?.retryable === true,
    artifactRefs: [],
  });
  const substrate = facts.substrateState ? `${facts.substrateState}${facts.substrateRevision !== null ? ` rev=${facts.substrateRevision}` : ""}` : "";
  const sanitized = sanitizedStatusPacket(statusPacket);
  const context = renderDelegateStatusContext(sanitized, {
    route: facts.taskId && facts.dispatchSeen ? stringValue(subjectTurn.route) || "delegate" : "",
    workerPool,
    substrate,
    delivery: facts.deliveryEventKind,
  });
  const groundingSections = recentExecutionFacts ? [recentExecutionFacts, context] : [context];
  return {
    available: true,
    subjectPrompt: stringValue(subjectTurn.prompt),
    route: stringValue(subjectTurn.route),
    taskClass: stringValue(subjectTurn.taskClass),
    protectedLane: stringValue(subjectTurn.protectedLane),
    facts,
    context: groundingSections.join("\n\n"),
  };
}

export function buildDirectLookupGuard(decision: JsonRecord = {}): string {
  const request = isRecord(decision.request) ? decision.request : {};
  const metadata = isRecord(request.metadata) ? request.metadata : {};
  const intentPacket = isRecord(metadata.intent_packet) ? metadata.intent_packet : {};
  const latencyAck = isRecord(decision.latency_ack) ? decision.latency_ack : {};
  const intentClass = stringValue(intentPacket.intent_class || intentPacket.intentClass);
  const guardedIntent = ["fresh_live_lookup", "local_surface_lookup"].includes(intentClass);
  if (!Boolean(latencyAck.required) && !guardedIntent) {
    return "";
  }
  return [
    "[OctoClaw live lookup guard]",
    "This is a bounded live lookup. Do not answer from memory.",
    "Use the execution lane selected by the policy, and only report facts backed by the task/provenance ledger.",
  ].join("\n");
}
