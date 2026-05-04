import { createHash } from "node:crypto";
import fsSync from "node:fs";
import path from "node:path";
import { sendIMMessage, type SendIMResult } from "../im/send.js";
import { resolveDeliveryOutboxPath } from "../resolve/env.js";
import { resolveAckDeliverySessionKey } from "../resolve/session.js";
import { upsertTaskStateRecord } from "../state/task-state-store.js";
import { atomicWriteJsonSync } from "../util/atomic-write.js";

export type DeliveryOutboxKind = "final_result" | "progress" | "ack";

export interface DeliveryOutboxEntry {
  id: string;
  workContractId: string;
  kind: DeliveryOutboxKind;
  parentSessionKey: string;
  replyToMessageId?: string;
  message: string;
  cwd?: string;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  nextRetryAt: string;
  lastError?: string;
}

export interface AppendDeliveryOutboxInput {
  workContractId: string;
  kind: DeliveryOutboxKind;
  parentSessionKey: string;
  replyToMessageId?: string;
  message: string;
  cwd?: string;
  now?: Date;
}

export interface FlushDeliveryOutboxOptions {
  outboxPath?: string;
  taskStatePath?: string;
  now?: Date;
  maxAttempts?: number;
  sendMessage?: (params: { sessionKey: string; message: string; replyToMessageId?: string; cwd?: string }) => Promise<SendIMResult>;
  logger?: { debug?: (msg: string) => void; warn?: (msg: string) => void };
}

export interface FlushDeliveryOutboxResult {
  attempted: number;
  delivered: number;
  failed: number;
  retryPending: number;
  remaining: number;
}

const INITIAL_RETRY_MS = 30_000;
const RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 300_000];
const DEFAULT_MAX_ATTEMPTS = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function optionalString(value: unknown): string | undefined {
  const text = asString(value);
  return text || undefined;
}

function outboxPathFromOverride(outboxPath?: string): string {
  return asString(outboxPath) || resolveDeliveryOutboxPath();
}

function stableDeliveryId(input: Pick<AppendDeliveryOutboxInput, "workContractId" | "kind" | "parentSessionKey" | "replyToMessageId" | "message">): string {
  const hash = createHash("sha256")
    .update([input.parentSessionKey, input.replyToMessageId || "", input.message].join("\n"))
    .digest("hex")
    .slice(0, 16);
  return `${input.workContractId}:${input.kind}:${hash}`;
}

function normalizeEntry(value: unknown): DeliveryOutboxEntry | null {
  if (!isRecord(value)) return null;
  const workContractId = asString(value.workContractId);
  const kind = asString(value.kind, "final_result") as DeliveryOutboxKind;
  const parentSessionKey = asString(value.parentSessionKey);
  const message = asString(value.message);
  if (!workContractId || !parentSessionKey || !message) return null;
  const createdAt = asString(value.createdAt) || new Date(0).toISOString();
  return {
    id: asString(value.id) || stableDeliveryId({ workContractId, kind, parentSessionKey, replyToMessageId: optionalString(value.replyToMessageId), message }),
    workContractId,
    kind: kind === "progress" || kind === "ack" ? kind : "final_result",
    parentSessionKey,
    replyToMessageId: optionalString(value.replyToMessageId),
    message,
    cwd: optionalString(value.cwd),
    createdAt,
    updatedAt: asString(value.updatedAt) || createdAt,
    attempts: Math.max(0, Number(value.attempts || 0)),
    nextRetryAt: asString(value.nextRetryAt) || createdAt,
    lastError: optionalString(value.lastError),
  };
}

function writeDeliveryOutbox(entries: DeliveryOutboxEntry[], outboxPath?: string): void {
  const targetPath = outboxPathFromOverride(outboxPath);
  fsSync.mkdirSync(path.dirname(targetPath), { recursive: true });
  atomicWriteJsonSync(targetPath, entries);
}

function nextRetryAt(now: Date, attempts: number): string {
  const delay = RETRY_DELAYS_MS[Math.min(Math.max(0, attempts), RETRY_DELAYS_MS.length - 1)] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
  return new Date(now.getTime() + delay).toISOString();
}

function updateDeliveryState(params: { workContractId: string; status: string; messageId?: string; deliveredAt?: string; lastError?: string; taskStatePath?: string }): void {
  if (!params.workContractId) return;
  const now = new Date().toISOString();
  upsertTaskStateRecord({
    id: params.workContractId,
    workContractId: params.workContractId,
    work_contract_id: params.workContractId,
    delivery_status: params.status,
    delivery: {
      status: params.status,
      ...(params.messageId ? { messageId: params.messageId } : {}),
      ...(params.deliveredAt ? { deliveredAt: params.deliveredAt } : {}),
      ...(params.lastError ? { lastError: params.lastError } : {}),
    },
    updatedAt: now,
    updated_at: now,
  }, params.taskStatePath);
}

export function readDeliveryOutbox(outboxPath?: string): DeliveryOutboxEntry[] {
  try {
    const parsed = JSON.parse(fsSync.readFileSync(outboxPathFromOverride(outboxPath), "utf-8")) as unknown;
    return Array.isArray(parsed) ? parsed.map(normalizeEntry).filter((entry): entry is DeliveryOutboxEntry => Boolean(entry)) : [];
  } catch {
    return [];
  }
}

export function appendToDeliveryOutbox(input: AppendDeliveryOutboxInput, outboxPath?: string): DeliveryOutboxEntry {
  const now = input.now ?? new Date();
  const workContractId = asString(input.workContractId);
  const parentSessionKey = asString(input.parentSessionKey);
  const message = asString(input.message);
  if (!workContractId || !parentSessionKey || !message) {
    throw new Error("delivery_outbox_entry_missing_identity");
  }
  const entry: DeliveryOutboxEntry = {
    id: stableDeliveryId({ ...input, workContractId, parentSessionKey, message }),
    workContractId,
    kind: input.kind,
    parentSessionKey,
    replyToMessageId: optionalString(input.replyToMessageId),
    message,
    cwd: optionalString(input.cwd),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    attempts: 0,
    nextRetryAt: new Date(now.getTime() + INITIAL_RETRY_MS).toISOString(),
  };
  const entries = readDeliveryOutbox(outboxPath);
  const existingIndex = entries.findIndex((candidate) => candidate.id === entry.id);
  if (existingIndex >= 0) {
    return entries[existingIndex];
  }
  entries.push(entry);
  writeDeliveryOutbox(entries, outboxPath);
  return entry;
}

export function removeDeliveryOutboxEntry(id: string, outboxPath?: string): void {
  const targetId = asString(id);
  if (!targetId) return;
  writeDeliveryOutbox(readDeliveryOutbox(outboxPath).filter((entry) => entry.id !== targetId), outboxPath);
}

function resolveOutboxDeliverySessionKey(parentSessionKey: string): string {
  return resolveAckDeliverySessionKey(
    { session_key: parentSessionKey },
    parentSessionKey,
    null,
    { sessionKey: parentSessionKey, sessionId: parentSessionKey },
  ) || parentSessionKey;
}

export async function flushDeliveryOutbox(options: FlushDeliveryOutboxOptions = {}): Promise<FlushDeliveryOutboxResult> {
  const now = options.now ?? new Date();
  const maxAttempts = Math.max(1, Number(options.maxAttempts || DEFAULT_MAX_ATTEMPTS));
  const sendMessage = options.sendMessage ?? ((params) => sendIMMessage({
    ...params,
    timeoutMs: 5000,
    deliveryKind: "legacy_fallback",
    deliveryTargetSource: params.replyToMessageId ? "inbound_anchor" : "session_fallback",
    footerMode: "off",
  }));
  const entries = readDeliveryOutbox(options.outboxPath);
  const remaining: DeliveryOutboxEntry[] = [];
  const result: FlushDeliveryOutboxResult = { attempted: 0, delivered: 0, failed: 0, retryPending: 0, remaining: 0 };

  for (const entry of entries) {
    if (Date.parse(entry.nextRetryAt) > now.getTime()) {
      remaining.push(entry);
      continue;
    }
    if (entry.attempts >= maxAttempts) {
      result.failed += 1;
      updateDeliveryState({ workContractId: entry.workContractId, status: "failed", lastError: entry.lastError || "max_attempts_reached", taskStatePath: options.taskStatePath });
      continue;
    }

    result.attempted += 1;
    try {
      const sent = await sendMessage({ sessionKey: resolveOutboxDeliverySessionKey(entry.parentSessionKey), message: entry.message, replyToMessageId: entry.replyToMessageId, cwd: entry.cwd });
      if (sent.sent) {
        result.delivered += 1;
        updateDeliveryState({ workContractId: entry.workContractId, status: "delivered", messageId: sent.messageId, deliveredAt: now.toISOString(), taskStatePath: options.taskStatePath });
        continue;
      }
      const attempts = entry.attempts + 1;
      const lastError = sent.error || "send_failed";
      if (attempts >= maxAttempts) {
        result.failed += 1;
        updateDeliveryState({ workContractId: entry.workContractId, status: "failed", lastError, taskStatePath: options.taskStatePath });
        continue;
      }
      result.retryPending += 1;
      remaining.push({ ...entry, attempts, updatedAt: now.toISOString(), nextRetryAt: nextRetryAt(now, attempts), lastError });
      updateDeliveryState({ workContractId: entry.workContractId, status: "retry_pending", lastError, taskStatePath: options.taskStatePath });
    } catch (error) {
      const attempts = entry.attempts + 1;
      const lastError = error instanceof Error ? `${error.name}: ${error.message}` : String(error || "send_failed");
      if (attempts >= maxAttempts) {
        result.failed += 1;
        updateDeliveryState({ workContractId: entry.workContractId, status: "failed", lastError, taskStatePath: options.taskStatePath });
        continue;
      }
      result.retryPending += 1;
      remaining.push({ ...entry, attempts, updatedAt: now.toISOString(), nextRetryAt: nextRetryAt(now, attempts), lastError });
      updateDeliveryState({ workContractId: entry.workContractId, status: "retry_pending", lastError, taskStatePath: options.taskStatePath });
      options.logger?.warn?.(`delivery outbox flush failed for ${entry.id}: ${lastError}`);
    }
  }

  result.remaining = remaining.length;
  writeDeliveryOutbox(remaining, options.outboxPath);
  return result;
}
