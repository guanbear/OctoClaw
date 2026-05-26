import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type UnknownRecord, asRecord, asString } from "../util/type-coercion.js";
import { resolveWorkspaceRoot } from "./env.js";

export type DeliveryOutboxStatus = "pending" | "delivered" | "failed" | "interrupted";

export interface DeliveryOutboxItem {
  outboxId: string;
  taskId: string;
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  requesterOrigin: UnknownRecord;
  workContractId: string;
  delegateTaskId: string;
  attemptId: string;
  resultText: string;
  resultHash: string;
  status: DeliveryOutboxStatus;
  reason: string;
  createdAt: string;
  updatedAt: string;
  deliveredAt: string;
  attemptCount: number;
}

export interface UpsertPendingResultInput {
  taskId: string;
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  requesterOrigin: UnknownRecord;
  workContractId: string;
  delegateTaskId: string;
  attemptId: string;
  resultText: string;
  now: string;
}

export interface DeliveryOutbox {
  upsertPendingResult(input: UpsertPendingResultInput): DeliveryOutboxItem;
  markDelivered(outboxId: string, now: string): DeliveryOutboxItem;
  markInterrupted(outboxId: string, reason: string, now: string): DeliveryOutboxItem;
  shouldDeliverResult(resultHash: string): boolean;
  listPending(): DeliveryOutboxItem[];
  list(): DeliveryOutboxItem[];
}

export function hashResultText(resultText: string): string {
  return `sha256:${createHash("sha256").update(resultText).digest("hex").slice(0, 16)}`;
}

export function createDeliveryOutbox(seed: DeliveryOutboxItem[] = []): DeliveryOutbox {
  const items = new Map(seed.map((item) => [item.outboxId, { ...item, requesterOrigin: asRecord(item.requesterOrigin) }]));

  const findByResultHash = (resultHash: string): DeliveryOutboxItem | undefined => {
    for (const item of items.values()) {
      if (item.resultHash === resultHash) return item;
    }
    return undefined;
  };

  return {
    upsertPendingResult(input) {
      const resultHash = hashResultText(input.resultText);
      const existing = findByResultHash(resultHash);
      if (existing) {
        return { ...existing };
      }
      const now = asString(input.now) || new Date().toISOString();
      const item: DeliveryOutboxItem = {
        outboxId: buildOutboxId(input.workContractId, input.attemptId, resultHash),
        taskId: input.taskId,
        runId: input.runId,
        childSessionKey: input.childSessionKey,
        requesterSessionKey: input.requesterSessionKey,
        requesterOrigin: asRecord(input.requesterOrigin),
        workContractId: input.workContractId,
        delegateTaskId: input.delegateTaskId,
        attemptId: input.attemptId,
        resultText: input.resultText,
        resultHash,
        status: "pending",
        reason: "",
        createdAt: now,
        updatedAt: now,
        deliveredAt: "",
        attemptCount: 0,
      };
      items.set(item.outboxId, item);
      return { ...item };
    },

    markDelivered(outboxId, now) {
      const existing = items.get(outboxId);
      if (!existing) throw new Error(`delivery_outbox_item_not_found:${outboxId}`);
      const updated = {
        ...existing,
        status: "delivered" as const,
        updatedAt: now,
        deliveredAt: now,
      };
      items.set(outboxId, updated);
      return { ...updated };
    },

    markInterrupted(outboxId, reason, now) {
      const existing = items.get(outboxId);
      if (!existing) throw new Error(`delivery_outbox_item_not_found:${outboxId}`);
      const updated = {
        ...existing,
        status: "interrupted" as const,
        reason,
        updatedAt: now,
      };
      items.set(outboxId, updated);
      return { ...updated };
    },

    shouldDeliverResult(resultHash) {
      const existing = findByResultHash(resultHash);
      return !existing || existing.status === "pending" || existing.status === "failed";
    },

    listPending() {
      return Array.from(items.values()).filter((item) => item.status === "pending").map((item) => ({ ...item }));
    },

    list() {
      return Array.from(items.values()).map((item) => ({ ...item }));
    },
  };
}

export function createFileDeliveryOutbox(pathname: string): DeliveryOutbox {
  const outbox = createDeliveryOutbox(readDeliveryOutboxFile(pathname));
  const persist = () => writeDeliveryOutboxFile(pathname, outbox.list());

  return {
    upsertPendingResult(input) {
      const item = outbox.upsertPendingResult(input);
      persist();
      return item;
    },

    markDelivered(outboxId, now) {
      const item = outbox.markDelivered(outboxId, now);
      persist();
      return item;
    },

    markInterrupted(outboxId, reason, now) {
      const item = outbox.markInterrupted(outboxId, reason, now);
      persist();
      return item;
    },

    shouldDeliverResult(resultHash) {
      return outbox.shouldDeliverResult(resultHash);
    },

    listPending() {
      return outbox.listPending();
    },

    list() {
      return outbox.list();
    },
  };
}

export function resolveDeliveryOutboxPath(): string {
  const explicit = asString(process.env.OCTOCLAW_DELIVERY_OUTBOX_PATH).trim();
  if (explicit) return path.resolve(explicit);
  return path.join(resolveWorkspaceRoot(), "tmp", "octopus", "restart-delivery-outbox.json");
}

function buildOutboxId(workContractId: string, attemptId: string, resultHash: string): string {
  return [
    "delivery",
    sanitizeIdPart(workContractId),
    sanitizeIdPart(attemptId),
    sanitizeIdPart(resultHash.replace(/^sha256:/, "")),
  ].filter(Boolean).join(":");
}

function sanitizeIdPart(value: string): string {
  return asString(value).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96);
}

function readDeliveryOutboxFile(pathname: string): DeliveryOutboxItem[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(pathname, "utf-8")) as UnknownRecord;
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    return items.map(toDeliveryOutboxItem).filter((item): item is DeliveryOutboxItem => Boolean(item));
  } catch (_) {
    return [];
  }
}

function writeDeliveryOutboxFile(pathname: string, items: DeliveryOutboxItem[]): void {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.writeFileSync(pathname, JSON.stringify({ version: 1, items }, null, 2), "utf-8");
}

function toDeliveryOutboxItem(value: unknown): DeliveryOutboxItem | null {
  const record = asRecord(value);
  const outboxId = asString(record.outboxId);
  const resultHash = asString(record.resultHash);
  if (!outboxId || !resultHash) return null;
  const status = asDeliveryOutboxStatus(record.status);
  if (!status) return null;
  return {
    outboxId,
    taskId: asString(record.taskId),
    runId: asString(record.runId),
    childSessionKey: asString(record.childSessionKey),
    requesterSessionKey: asString(record.requesterSessionKey),
    requesterOrigin: asRecord(record.requesterOrigin),
    workContractId: asString(record.workContractId),
    delegateTaskId: asString(record.delegateTaskId),
    attemptId: asString(record.attemptId),
    resultText: asString(record.resultText),
    resultHash,
    status,
    reason: asString(record.reason),
    createdAt: asString(record.createdAt),
    updatedAt: asString(record.updatedAt),
    deliveredAt: asString(record.deliveredAt),
    attemptCount: Number.isFinite(Number(record.attemptCount)) ? Number(record.attemptCount) : 0,
  };
}

function asDeliveryOutboxStatus(value: unknown): DeliveryOutboxStatus | "" {
  const status = asString(value);
  if (status === "pending" || status === "delivered" || status === "failed" || status === "interrupted") return status;
  return "";
}
