import fsSync from "node:fs";
import path from "node:path";

import {
  buildIntentPacket,
  type IntentClass,
  type IntentHints,
  type IntentPacket,
} from "@octoclaw/policy/intent";

interface FsSyncLike {
  readFileSync(pathname: string, encoding: string): string;
}

const fs = fsSync as unknown as FsSyncLike;

type JsonRecord = Record<string, unknown>;

export interface ConversationIntentPacket extends IntentPacket {
  available: boolean;
  intent_class: IntentClass;
  schema_version: string;
  source: string;
  reason_codes: string[];
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
  finalDeliveryRelayEvent: string;
  finalDeliveryRelayState: string;
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
  /(谁查的|谁做的|谁处理的|谁执行的|是不是子任务做的|是不是主agent自己查的)/iu,
  /\b(who handled this|who answered this|was this delegated|was this a subtask)\b/iu,
];
const TASK_PROGRESS_PROMPT_PATTERNS = [
  /((?:single|spawn|runner)\s*成功了吗|任务怎样了|任务怎么样了|现在什么状态|还在\s*queued\s*吗|还在排队吗)/iu,
  /\b(single succeeded|spawn succeeded|runner succeeded|task status|still queued|still running)\b/iu,
];
const FRESH_LIVE_LOOKUP_PATTERNS = [
  /(查|查下|查一下|再查|再看|看下|看一下|看看|确认|确认下|确认一下).{0,16}(openclaw|octoclaw).{0,20}(更新|发版|release|版本|changelog|memory|dream)/iu,
  /(openclaw|octoclaw).{0,20}(有啥更新|有什么更新|有没有新的发版|有没有新发版|有没有新的release|有没有新release|最近.*更新|最新.*更新|最近.*发版|最近.*release|新版本)/iu,
  /\b(check|look up|see|verify|confirm)\b.{0,18}\b(openclaw|octoclaw)\b.{0,24}\b(update|updates|release|version|changelog|memory|dream)\b/iu,
];
const OPERATOR_SURFACE_REGISTRY = [
  {
    surface_id: "system_load",
    lane_hint: "direct",
    scope: "local_surface_lookup",
    patterns: [
      /(系统负载|机器负载|系统状态|cpu|内存|磁盘|load average|uptime|负载情况|资源占用)/iu,
      /\b(system load|machine load|cpu usage|memory usage|disk usage|load average|uptime|system status)\b/iu,
    ],
  },
  {
    surface_id: "runtime_version",
    lane_hint: "direct",
    scope: "local_surface_lookup",
    patterns: [
      /(你现在啥版本|现在什么版本|当前.*版本|openclaw.*版本|版本号)/iu,
      /\b(current version|openclaw version|runtime version)\b/iu,
    ],
  },
  {
    surface_id: "runtime_model",
    lane_hint: "direct",
    scope: "local_surface_lookup",
    patterns: [
      /(你是啥模型|你是什么模型|当前是啥模型|现在用的啥模型)/iu,
      /\b(what model are you using|what model are you on|current model|main session model)\b/iu,
    ],
  },
  {
    surface_id: "service_health",
    lane_hint: "runner",
    scope: "local_surface_lookup",
    patterns: [
      /(服务健康|健康状态|服务状态|gateway状态|gateway health|health check)/iu,
      /\b(service health|service status|system health|gateway status|gateway health)\b/iu,
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

function deriveDeliveryRelayPath(taskStatePath = ""): string {
  const normalized = stringValue(taskStatePath);
  return normalized ? path.join(path.dirname(normalized), "delivery-relay.jsonl") : "";
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

function buildDeliveryRelayIndex(deliveryRelayPath = ""): Map<string, JsonRecord[]> {
  const events = readJsonl(deliveryRelayPath);
  const index = new Map<string, JsonRecord[]>();
  for (const event of events) {
    const sessionKey = stringValue(event.sessionKey);
    const taskId = stringValue(event.taskId);
    const runnerJobId = stringValue(event.runnerJobId);
    const keys = [
      sessionKey ? `session:${sessionKey}` : "",
      taskId ? `task:${taskId}` : "",
      runnerJobId ? `runner:${runnerJobId}` : "",
    ].filter(Boolean);
    for (const key of keys) {
      index.set(key, [...(index.get(key) || []), event]);
    }
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

function buildTurnFacts(
  turn: ReplayTurn,
  taskIndex: Map<string, JsonRecord>,
  taskEventIndex: Map<string, JsonRecord[]>,
  deliveryRelayIndex: Map<string, JsonRecord[]>,
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
    "completion_relay_sent",
    "completion_relay_failed",
    "completion_relay_resolution_failed",
    "user_notified",
  ].includes(stringValue(event.kind))) || {};
  const relayEvents = Array.from(
    new Set([
      ...(taskId ? (deliveryRelayIndex.get(`task:${taskId}`) || []) : []),
      ...(runnerJobId ? (deliveryRelayIndex.get(`runner:${runnerJobId}`) || []) : []),
      ...((!taskId && !runnerJobId && turn.sessionKey) ? (deliveryRelayIndex.get(`session:${turn.sessionKey}`) || []) : []),
    ]),
  ).sort((left, right) => parseTimestamp(left.at) - parseTimestamp(right.at));
  const finalRelay = relayEvents[relayEvents.length - 1] || {};
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
    finalDeliveryRelayEvent: stringValue(finalRelay.event),
    finalDeliveryRelayState: stringValue(finalRelay.state),
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
      return Boolean(facts && (facts.dispatchSeen || facts.taskId || facts.runnerJobId || ["runner", "spawn_single", "spawn_multi"].includes(turn.route)));
    });
    if (delegatedTurns.length > 0) {
      return delegatedTurns[delegatedTurns.length - 1] || null;
    }
  }
  if (isProvenancePrompt(prompt)) {
    const factualTurns = nonMetaTurns.filter((turn) => {
      const facts = turn.facts;
      return Boolean(facts && (facts.dispatchSeen || facts.directTools.length > 0 || turn.route));
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

export function buildConversationIntentPacket(options: {
  prompt?: string;
  replayLogPath?: string;
  taskStatePath?: string;
  sessionKeys?: string[];
} = {}): ConversationIntentPacket {
  const prompt = stringValue(options.prompt);
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
  const deliveryRelayIndex = buildDeliveryRelayIndex(deriveDeliveryRelayPath(stringValue(options.taskStatePath)));
  const enrichedTurns = turns.map((turn) => ({
    ...turn,
    facts: buildTurnFacts(turn, taskIndex, taskEventIndex, deliveryRelayIndex),
  }));
  const subjectTurn = selectSubjectTurn(enrichedTurns, prompt, Array.isArray(options.sessionKeys) ? options.sessionKeys : []);

  let hints: IntentHints = {};
  let source = "deterministic_front_gate";
  let reasonCodes = ["semantic_judge_required"];
  if (surface) {
    hints = { surfaceBound: true };
    source = "deterministic_surface_registry";
    reasonCodes = [`operator_surface:${surface.surface_id}`];
  } else if (isFreshLiveLookupPrompt(prompt)) {
    hints = { requiresFreshLookup: true };
    source = "deterministic_live_lookup_classifier";
    reasonCodes = ["stable_fresh_live_lookup"];
  } else if (subjectTurn && (isMetaPrompt(prompt) || isTaskProgressPrompt(prompt) || isProvenancePrompt(prompt) || promptsEquivalent(prompt, subjectTurn.prompt))) {
    hints = { executionFollowup: true };
    source = "deterministic_followup_grounding";
    reasonCodes = ["recent_execution_followup"];
  }

  const packet = buildIntentPacket(hints);
  return {
    ...packet,
    available: true,
    intent_class: packet.intentClass,
    schema_version: INTENT_PACKET_SCHEMA_VERSION,
    source,
    reason_codes: reasonCodes,
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
  const base: ConversationControlHints = {
    available: true,
    kind: intentClass,
    intent_class: intentClass,
    intent_packet: intentPacket as ConversationIntentPacket,
  };
  if (intentClass === "execution_followup") {
    return {
      ...base,
      route_hint: "direct",
      lane_hint: "control_observer",
      protected_lane: "control_observer",
      require_state_grounding: true,
    };
  }
  if (intentClass === "local_surface_lookup") {
    return {
      ...base,
      route_hint: "direct",
      lane_hint: "direct",
      lookup_scope: "local_instance",
      require_state_grounding: false,
    };
  }
  if (intentClass === "fresh_live_lookup") {
    return {
      ...base,
      route_hint: "runner",
      lane_hint: "runner",
      lookup_scope: "upstream_project",
      lookup_project: inferFreshLookupProject(""),
      lookup_focus: inferFreshLookupFocus(""),
      require_fresh_lookup: true,
      require_state_grounding: false,
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
} = {}): { available: boolean; reason?: string; context?: string; subjectPrompt?: string; route?: string; taskClass?: string; protectedLane?: string; facts?: TurnFacts } {
  const prompt = stringValue(options.prompt);
  const turns = groupedReplayTurns(readJsonl(stringValue(options.replayLogPath)));
  const taskIndex = buildTaskIndex(stringValue(options.taskStatePath));
  const taskEventIndex = buildTaskEventIndex(deriveTaskEventsPath(stringValue(options.taskStatePath)));
  const deliveryRelayIndex = buildDeliveryRelayIndex(deriveDeliveryRelayPath(stringValue(options.taskStatePath)));
  const enrichedTurns = turns.map((turn) => ({
    ...turn,
    facts: buildTurnFacts(turn, taskIndex, taskEventIndex, deliveryRelayIndex),
  }));
  const subjectTurn = selectSubjectTurn(enrichedTurns, prompt, Array.isArray(options.sessionKeys) ? options.sessionKeys.map((item) => stringValue(item)) : []);
  if (!subjectTurn?.facts) {
    return noGrounding("no_recent_subject_turn");
  }
  const facts = subjectTurn.facts;
  const lines = [
    "[OctoClaw grounded follow-up]",
    "Answer only from these execution facts. Do not guess from memory.",
    `- Subject prompt: ${stringValue(subjectTurn.prompt) || "(unknown)"}`,
    `- Route decision: ${stringValue(subjectTurn.route) || "(unknown)"}`,
  ];
  if (subjectTurn.taskClass) lines.push(`- Task class: ${subjectTurn.taskClass}`);
  if (subjectTurn.protectedLane) lines.push(`- Protected lane: ${subjectTurn.protectedLane}`);
  if (facts.ackSeen) {
    lines.push(`- Ack: ${[facts.ackKind, facts.ackMode, facts.ackSent ? "sent" : "not_sent"].filter(Boolean).join(" · ")}`);
    if (facts.ackReason) lines.push(`- Ack reason: ${facts.ackReason}`);
  }
  lines.push(`- Dispatch called: ${facts.dispatchSeen ? "yes" : "no"}`);
  lines.push(`- Dispatch executed: ${facts.dispatchExecuted ? "yes" : "no"}`);
  lines.push(`- Delegated: ${facts.delegated ? "yes" : "no"}`);
  if (facts.delegationTool) lines.push(`- Delegation tool: ${facts.delegationTool}`);
  if (facts.materializationStatus) lines.push(`- Materialization: ${facts.executionKind || "delegated"} · ${facts.materializationStatus}`);
  if (facts.directTools.length > 0) lines.push(`- Direct tools used: ${facts.directTools.join(", ")}`);
  else if (isProvenancePrompt(prompt)) lines.push("- Direct tools used: unavailable in main session");
  if (facts.runnerPlanKind) lines.push(`- Delegated workflow: ${facts.runnerPlanKind}`);
  if (facts.runnerPlanSummary) lines.push(`- Delegated workflow summary: ${facts.runnerPlanSummary}`);
  if (facts.delegatedProbeKind) lines.push(`- Delegated probe: ${facts.delegatedProbeKind}`);
  if (facts.delegatedProbeSource) lines.push(`- Delegated evidence source: ${facts.delegatedProbeSource}`);
  if (facts.delegatedProbeProject) lines.push(`- Delegated lookup project: ${facts.delegatedProbeProject}`);
  if (facts.delegatedProbeFocus) lines.push(`- Delegated lookup focus: ${facts.delegatedProbeFocus}`);
  if (facts.dispatchMode) lines.push(`- Runner dispatch mode: ${facts.dispatchMode}`);
  if (facts.runnerJobId) lines.push(`- Runner job id: ${facts.runnerJobId}`);
  if (facts.taskId) lines.push(`- Task id: ${facts.taskId}`);
  if (facts.taskBoundSeen) lines.push("- Task bound: yes");
  if (facts.runnerStartedSeen) lines.push("- Runner started: yes");
  if (facts.currentTaskStatus) lines.push(`- Current task status: ${facts.currentTaskStatus}`);
  if (facts.currentTaskSummary) lines.push(`- Current task summary: ${facts.currentTaskSummary}`);
  if (facts.claimOwner) lines.push(`- Claim owner: ${facts.claimOwner}`);
  if (facts.workspaceMode) lines.push(`- Workspace mode: ${facts.workspaceMode}`);
  if (facts.writeScopeSummary) lines.push(`- Write scope: ${facts.writeScopeSummary}`);
  if (facts.substrateState || facts.substrateRevision !== null) {
    lines.push(`- Substrate state: ${[facts.substrateState, facts.substrateRevision !== null ? `rev ${facts.substrateRevision}` : ""].filter(Boolean).join(" · ")}`);
  }
  if (facts.queuePosition !== null) lines.push(`- Queue position: ${facts.queuePosition}`);
  if (facts.actionAvailability.length > 0) lines.push(`- Action availability: ${facts.actionAvailability.join(", ")}`);
  if (facts.deliveryEventKind) lines.push(`- Delivery state: ${facts.deliveryEventKind}`);
  else if (facts.finalDeliveryRelayEvent) lines.push(`- Final delivery: ${[facts.finalDeliveryRelayEvent, facts.finalDeliveryRelayState].filter(Boolean).join(" · ")}`);
  if (facts.latestTaskEventKind) lines.push(`- Latest task event: ${facts.latestTaskEventKind}${facts.latestTaskEventMessage ? ` · ${facts.latestTaskEventMessage}` : ""}`);
  if (Object.keys(facts.capabilityFailure).length > 0) {
    lines.push(`- Capability failure: ${stringValue(facts.capabilityFailure.reason || facts.capabilityFailure.code || "unknown")}`);
    if (facts.capabilityFailureDetail) lines.push(`- Capability failure detail: ${facts.capabilityFailureDetail}`);
  }
  lines.push("If the user asks how it was checked, only mention tools listed above. If the fact is unavailable, say so plainly.");

  return {
    available: true,
    subjectPrompt: stringValue(subjectTurn.prompt),
    route: stringValue(subjectTurn.route),
    taskClass: stringValue(subjectTurn.taskClass),
    protectedLane: stringValue(subjectTurn.protectedLane),
    facts,
    context: lines.join("\n"),
  };
}

export function buildDirectLookupGuard(decision: JsonRecord = {}): string {
  const request = isRecord(decision.request) ? decision.request : {};
  const metadata = isRecord(request.metadata) ? request.metadata : {};
  const intentPacket = isRecord(metadata.intent_packet) ? metadata.intent_packet : {};
  const routerDecision = isRecord(decision.router_decision_v2) ? decision.router_decision_v2 : {};
  const latencyAck = isRecord(decision.latency_ack) ? decision.latency_ack : {};
  const intentClass = stringValue(intentPacket.intent_class || intentPacket.intentClass);
  const evidenceRequired = Array.isArray(routerDecision.evidence_required) ? routerDecision.evidence_required.map((item) => stringValue(item)) : [];
  const guardedIntent = ["fresh_live_lookup", "local_surface_lookup"].includes(intentClass)
    || evidenceRequired.some((item) => ["web_lookup", "local_probe", "remote_probe"].includes(item));
  if (!Boolean(latencyAck.required) && !guardedIntent) {
    return "";
  }
  return [
    "[OctoClaw live lookup guard]",
    "This is a bounded live lookup. Do not answer from memory.",
    "Use the execution lane selected by the policy, and only report facts backed by the task/provenance ledger.",
  ].join("\n");
}
