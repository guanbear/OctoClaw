import { envOverrides } from "../resolve/env.js";
import { upsertTaskStateRecord, type TaskStateRecord } from "../state/task-state-store.js";
import { asRecord, asString, isRecord, type UnknownRecord } from "../util/type-coercion.js";

export interface RuntimeTaskStateRecord extends TaskStateRecord {
  id?: unknown;
  status?: unknown;
  summary?: unknown;
  route?: unknown;
  role?: unknown;
  session_key?: unknown;
  flow_id?: unknown;
  worker_pool?: unknown;
  updated_at?: unknown;
  created_at?: unknown;
  started_at?: unknown;
  completed_at?: unknown;
  failed_at?: unknown;
  spawned_at?: unknown;
  materialized_at?: unknown;
  report_path?: unknown;
  model?: unknown;
  model_profile?: unknown;
  backend?: unknown;
  artifacts?: unknown;
}

export function isSyntheticTestTaskState(record: RuntimeTaskStateRecord): boolean {
  const id = asString(record.id);
  const flowId = asString(record.flow_id);
  const sessionKey = asString(record.session_key);
  const summary = asString(record.summary);
  return id === "task-honesty"
    || id === "task-no-spawn"
    || id === "task-spawned"
    || flowId === "flow-honesty"
    || flowId === "flow-no-spawn"
    || flowId === "flow-spawned"
    || sessionKey.startsWith("session-dispatch-honesty")
    || sessionKey === "session-dispatch-spawned-test"
    || sessionKey === "session-work-contract-prior-continuity"
    || sessionKey === "session-contract-wins"
    || summary.includes("Dispatch from sealed WorkContract");
}

export async function upsertTaskStateCache(record: RuntimeTaskStateRecord): Promise<void> {
  try {
    if (!envOverrides.workspaceRoot && isSyntheticTestTaskState(record)) return;
    upsertTaskStateRecord(record);
  } catch { /* best effort cache write */ }
}

export function nestedRecord(value: unknown, key: string): UnknownRecord {
  return asRecord(asRecord(value)[key]);
}

export function explicitBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function hasExplicitTrue(values: unknown[]): boolean {
  return values.some((value) => explicitBoolean(value) === true);
}

export function hasExplicitFalse(values: unknown[]): boolean {
  return values.some((value) => explicitBoolean(value) === false);
}

export function optionalString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = asString(value);
    if (text) return text;
  }
  return undefined;
}

export function optionalReplyTargetId(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = asString(value);
    if (text && text !== "0" && text !== "0.0" && text.toLowerCase() !== "root") return text;
  }
  return undefined;
}

export function parseObjectJson(value: unknown): UnknownRecord {
  const text = asString(value);
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function parsePolicyDecisionJson(value: unknown): UnknownRecord | null {
  const parsed = parseObjectJson(value);
  return Object.keys(parsed).length > 0 ? parsed : null;
}
export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => asString(item)).filter(Boolean) : [];
}

export function toolResponse(summary: string, details: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    text: summary,
    json: details,
  };
}

export function timestampMs(value: unknown): number | null {
  const parsed = Date.parse(asString(value));
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatElapsed(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "unknown";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60 ? `${seconds % 60}s` : ""}`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 48) return `${hours}h${remainingMinutes ? `${remainingMinutes}m` : ""}`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24 ? `${hours % 24}h` : ""}`;
}

export function formatTimeAgo(timestampMs: number | null, nowMs: number): string {
  if (timestampMs === null || !Number.isFinite(timestampMs) || timestampMs < 0) return "";
  const diffMs = nowMs - timestampMs;
  if (diffMs < 0) return "刚刚";
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return seconds <= 5 ? "刚刚" : `${seconds}秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  return `${days}天前`;
}

export function formatAbsoluteShort(timestampMs: number | null): string {
  if (timestampMs === null || !Number.isFinite(timestampMs)) return "";
  const d = new Date(timestampMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function firstTimestamp(...values: unknown[]): string {
  for (const value of values) {
    const text = asString(value);
    if (timestampMs(text) !== null) return text;
  }
  return "";
}

export function compactDispatchDetails(payload: UnknownRecord): UnknownRecord {
  return {
    route: asString(payload.route),
    status: asString(payload.status),
    executed: payload.executed === true,
    worker_pool: asString(payload.worker_pool),
    model: asString(payload.model),
    task_id: asString(payload.task_id ?? asRecord(payload.materialization).task_id),
    flow_id: asString(payload.flow_id ?? asRecord(payload.materialization).flow_id),
  };
}
