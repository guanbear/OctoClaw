import fsSync from "node:fs";

import type {
  JudgeBindingControlLayer,
  JudgeContextPacket,
  JudgeContinuationStateLayer,
  JudgeCoreTurnLayer,
  JudgeMinimalEvidenceLayer,
} from "@octoclaw/policy/judge";

import { readJsonl } from "../conversation-grounding.js";
import { extractPromptText } from "./policy-resolver.js";
import { detectSessionBoundary } from "./session.js";
import { policyState, type PolicyStateEntry } from "../state/policy-state.js";

type JsonRecord = Record<string, unknown>;

interface FsSyncLike {
  readFileSync(pathname: string, encoding: string): string;
}

interface ReplayTurn {
  at: string;
  prompt: string;
  sessionKey: string;
}

interface TaskRecord extends JsonRecord {
  id?: unknown;
  task_id?: unknown;
  flow_id?: unknown;
  session_key?: unknown;
  sessionKey?: unknown;
  status?: unknown;
  summary?: unknown;
  description?: unknown;
  task_description?: unknown;
  lifecycle_state?: unknown;
  outcome_state?: unknown;
  handoff_state?: unknown;
  updated_at?: unknown;
  updatedAt?: unknown;
  created_at?: unknown;
  createdAt?: unknown;
}

const fs = fsSync as unknown as FsSyncLike;

const PACKET_TEXT_BUDGET = 1000;
const CURRENT_TURN_MAX = 500;
const THREAD_SUMMARY_MAX = 200;
const RECENT_EXCERPT_ENTRY_MAX = 100;
const RECENT_EXCERPT_MAX_ENTRIES = 3;
const ACTIVE_INTENT_MAX = 160;
const LAST_AGENT_ACT_MAX = 64;
const BINDING_MAX = 96;
const SURFACE_MAX = 48;
const FLAG_MAX = 32;

export interface JudgeContextPacketOptions {
  prompt: string;
  replayLogPath?: string;
  taskStatePath?: string;
  sessionKeys?: string[];
  metadata?: Record<string, unknown>;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeWhitespace(value: string): string {
  return stringValue(value).replace(/\s+/gu, " ").trim();
}

function truncateText(value: unknown, max: number): string {
  const text = normalizeWhitespace(String(value ?? ""));
  if (!text || text.length <= max) {
    return text;
  }
  if (max <= 1) {
    return text.slice(0, Math.max(0, max));
  }
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function parseTimestamp(value: unknown): number {
  const parsed = new Date(stringValue(value));
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

function readJsonFile(pathname: string): JsonRecord {
  if (!pathname) {
    return {};
  }
  try {
    const raw = fs.readFileSync(pathname, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeSessionKeys(sessionKeys: string[] | undefined): string[] {
  return Array.from(new Set((sessionKeys || []).map(stringValue).filter(Boolean)));
}

function buildReplayTurns(replayLogPath: string, sessionKeys: string[]): ReplayTurn[] {
  const events = readJsonl(replayLogPath);
  const sessionKeySet = new Set(sessionKeys);
  return events
    .filter((event) => stringValue(event.event) === "policy_resolved")
    .filter((event) => {
      const sessionKey = stringValue(event.sessionKey);
      return sessionKeySet.size === 0 || sessionKeySet.has(sessionKey);
    })
    .map((event) => ({
      at: stringValue(event.at),
      prompt: extractPromptText(event),
      sessionKey: stringValue(event.sessionKey),
    }))
    .filter((turn) => Boolean(turn.prompt))
    .sort((left, right) => parseTimestamp(left.at) - parseTimestamp(right.at));
}

function buildThreadSummary(turns: ReplayTurn[]): string {
  const prompts = turns
    .slice(-5)
    .map((turn) => truncateText(turn.prompt, 60))
    .filter(Boolean);
  return truncateText(prompts.join(" • "), THREAD_SUMMARY_MAX);
}

function buildRecentExcerpt(turns: ReplayTurn[]): string[] {
  return turns
    .slice(-RECENT_EXCERPT_MAX_ENTRIES)
    .map((turn) => truncateText(turn.prompt, RECENT_EXCERPT_ENTRY_MAX))
    .filter(Boolean);
}

function selectRecentReplayEvent(replayLogPath: string, sessionKeys: string[]): JsonRecord | null {
  const events = readJsonl(replayLogPath);
  const sessionKeySet = new Set(sessionKeys);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] || {};
    const sessionKey = stringValue(event.sessionKey);
    if (sessionKeySet.size > 0 && !sessionKeySet.has(sessionKey)) {
      continue;
    }
    return event;
  }
  return null;
}

function selectPolicyEntry(sessionKeys: string[]): PolicyStateEntry | null {
  let best: PolicyStateEntry | null = null;
  let bestUpdatedAt = 0;
  for (const key of sessionKeys) {
    const entry = policyState.get(key);
    if (!entry) {
      continue;
    }
    const updatedAt = Number(entry.updatedAt ?? entry.createdAt ?? 0);
    if (!best || updatedAt >= bestUpdatedAt) {
      best = entry;
      bestUpdatedAt = updatedAt;
    }
  }
  return best;
}

function readTaskRecords(taskStatePath: string): TaskRecord[] {
  const payload = readJsonFile(taskStatePath);
  return Array.isArray(payload.tasks) ? payload.tasks.filter(isRecord) as TaskRecord[] : [];
}

function taskTimestamp(task: TaskRecord): number {
  return parseTimestamp(task.updated_at ?? task.created_at)
    || Number(task.updatedAt ?? task.createdAt ?? 0);
}

function taskMatchesSession(task: TaskRecord, sessionKeys: string[]): boolean {
  if (sessionKeys.length === 0) {
    return true;
  }
  const candidates = [
    task.session_key,
    task.sessionKey,
    task.session_id,
    task.sessionId,
    task.control_session_key,
    task.parent_session_key,
  ].map(stringValue).filter(Boolean);
  return candidates.some((candidate) => sessionKeys.includes(candidate));
}

function selectActiveTask(taskStatePath: string, sessionKeys: string[]): TaskRecord | null {
  const tasks = readTaskRecords(taskStatePath)
    .filter((task) => taskMatchesSession(task, sessionKeys))
    .sort((left, right) => taskTimestamp(left) - taskTimestamp(right));
  return tasks[tasks.length - 1] || null;
}

function deriveActiveIntent(entry: PolicyStateEntry | null, task: TaskRecord | null, prompt: string): string | undefined {
  const decision = isRecord(entry?.decision) ? entry.decision : {};
  const request = isRecord(decision.request) ? decision.request : {};
  const routeDecision = isRecord(decision.route_decision) ? decision.route_decision : {};
  const candidate = stringValue(
    task?.task_description
      || task?.description
      || entry?.prompt
      || request.task
      || request.prompt
      || routeDecision.task_class,
  );
  const truncated = truncateText(candidate || prompt, ACTIVE_INTENT_MAX);
  return truncated || undefined;
}

function deriveIntentStatus(task: TaskRecord | null): JudgeContinuationStateLayer["intent_status"] {
  const status = stringValue(task?.status).toLowerCase();
  if (!status) {
    return "idle";
  }
  if (["running", "dispatched", "in_progress", "executing"].includes(status)) {
    return "executing";
  }
  if (status.includes("wait") || ["queued", "planned", "pending", "blocked", "needs_approval"].includes(status)) {
    return "waiting_input";
  }
  return "idle";
}

function derivePendingSlots(entry: PolicyStateEntry | null): string[] {
  const direct = Array.isArray(entry?.pending_slots) ? entry.pending_slots : [];
  return direct.map((item) => truncateText(item, 40)).filter(Boolean);
}

function deriveBinding(task: TaskRecord | null): string | null | undefined {
  const taskId = stringValue(task?.id || task?.task_id);
  if (taskId) {
    return truncateText(taskId, BINDING_MAX);
  }
  const flowId = stringValue(task?.flow_id);
  if (flowId) {
    return truncateText(flowId, BINDING_MAX);
  }
  return null;
}

function deriveLifecycleFlags(sessionKeys: string[], task: TaskRecord | null): string[] {
  const firstSessionKey = sessionKeys[0] || "";
  const boundary = firstSessionKey
    ? detectSessionBoundary({ sessionKey: firstSessionKey, sessionId: firstSessionKey })
    : null;

  const flags = [
    boundary?.status,
    stringValue(task?.status).toLowerCase(),
    stringValue(task?.lifecycle_state).toLowerCase(),
    stringValue(task?.handoff_state).toLowerCase(),
    stringValue(task?.outcome_state).toLowerCase(),
  ]
    .map((value) => truncateText(value, FLAG_MAX))
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)
    .filter((value) => value !== "clean" && value !== "idle");

  return flags;
}

function collectTextContent(value: unknown): number {
  if (typeof value === "string") {
    return value.length;
  }
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + collectTextContent(item), 0);
  }
  if (isRecord(value)) {
    return Object.values(value).reduce<number>((sum, item) => sum + collectTextContent(item), 0);
  }
  return 0;
}

function enforcePacketBudget(packet: JudgeContextPacket): JudgeContextPacket {
  if (collectTextContent(packet) <= PACKET_TEXT_BUDGET) {
    return packet;
  }

  if (packet.evidence?.recent_excerpt?.length) {
    const trimmedExcerpt = packet.evidence.recent_excerpt.slice(0, 2).map((item) => truncateText(item, 72));
    packet.evidence = trimmedExcerpt.length > 0 ? { recent_excerpt: trimmedExcerpt } : undefined;
  }
  if (collectTextContent(packet) <= PACKET_TEXT_BUDGET) {
    return packet;
  }

  if (packet.core.thread_summary) {
    packet.core.thread_summary = truncateText(packet.core.thread_summary, 120) || undefined;
  }
  if (packet.continuation?.active_intent) {
    packet.continuation.active_intent = truncateText(packet.continuation.active_intent, 96) || undefined;
  }
  if (collectTextContent(packet) <= PACKET_TEXT_BUDGET) {
    return packet;
  }

  packet.evidence = undefined;
  if (packet.binding?.lifecycle_flags && packet.binding.lifecycle_flags.length > 2) {
    packet.binding.lifecycle_flags = packet.binding.lifecycle_flags.slice(0, 2);
  }
  if (packet.continuation?.pending_slots && packet.continuation.pending_slots.length > 3) {
    packet.continuation.pending_slots = packet.continuation.pending_slots.slice(0, 3);
  }
  return packet;
}

export function buildJudgeContextPacket(options: JudgeContextPacketOptions): JudgeContextPacket {
  const prompt = truncateText(options.prompt, CURRENT_TURN_MAX);
  const metadata = isRecord(options.metadata) ? options.metadata : {};
  const sessionKeys = normalizeSessionKeys(options.sessionKeys);
  const replayTurns = buildReplayTurns(stringValue(options.replayLogPath), sessionKeys);
  const latestReplayEvent = selectRecentReplayEvent(stringValue(options.replayLogPath), sessionKeys);
  const policyEntry = selectPolicyEntry(sessionKeys);
  const activeTask = selectActiveTask(stringValue(options.taskStatePath), sessionKeys);

  const threadSummary = buildThreadSummary(replayTurns);
  const recentExcerpt = buildRecentExcerpt(replayTurns);

  const core: JudgeCoreTurnLayer = {
    current_turn: prompt,
    turn_metadata: {
      channel: truncateText(metadata.channel, 32) || undefined,
    },
    thread_summary: threadSummary || undefined,
  };

  if (!core.turn_metadata?.channel) {
    delete core.turn_metadata;
  }

  const continuation: JudgeContinuationStateLayer = {
    active_intent: deriveActiveIntent(policyEntry, activeTask, prompt),
    intent_status: deriveIntentStatus(activeTask),
    last_agent_act: truncateText(latestReplayEvent?.event, LAST_AGENT_ACT_MAX) || undefined,
    pending_slots: derivePendingSlots(policyEntry),
    open_question: undefined,
  };

  if (!continuation.active_intent) delete continuation.active_intent;
  if (!continuation.last_agent_act) delete continuation.last_agent_act;
  if (!continuation.pending_slots || continuation.pending_slots.length === 0) delete continuation.pending_slots;

  const lifecycleFlags = deriveLifecycleFlags(sessionKeys, activeTask);
  const binding: JudgeBindingControlLayer = {
    anchor_or_task_binding: deriveBinding(activeTask),
    surface_context: truncateText(metadata.surface || metadata.channel, SURFACE_MAX) || undefined,
    lifecycle_flags: lifecycleFlags.length > 0 ? lifecycleFlags : undefined,
  };

  if (binding.anchor_or_task_binding === undefined) delete binding.anchor_or_task_binding;
  if (!binding.surface_context) delete binding.surface_context;
  if (!binding.lifecycle_flags || binding.lifecycle_flags.length === 0) delete binding.lifecycle_flags;

  const needsEvidence = !threadSummary || threadSummary.length < 40;
  const evidence: JudgeMinimalEvidenceLayer | undefined = needsEvidence && recentExcerpt.length > 0
    ? {
        recent_excerpt: recentExcerpt,
        artifact_refs: undefined,
      }
    : undefined;

  return enforcePacketBudget({
    core,
    continuation,
    binding,
    ...(evidence ? { evidence } : {}),
  });
}
