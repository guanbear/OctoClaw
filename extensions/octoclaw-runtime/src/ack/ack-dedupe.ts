export type AckLeaseOwner = "main_model" | "ack_controller" | "";

export type AckLeaseClaimResult = {
  claimed: boolean;
  owner: AckLeaseOwner;
  expiresAt: number;
};

export interface AckKeyParts {
  threadId: string;
  anchorId?: string;
  ackStage: string;
  routePhase: string;
  messageTurnId: string;
}

export interface AckDeliveryReceipt {
  ackKey: string;
  sent: boolean;
  deliveredAt: number;
  target: string;
  threadId: string;
  error?: string;
}

interface AckLeaseEntry {
  owner: AckLeaseOwner;
  expiresAt: number;
}

const MAX_OUTBOX_ENTRIES = 1_000;

const ackLeases = new Map<string, AckLeaseEntry>();
const ackIdempotencyOwners = new Map<string, string>();
const ackDeliveryOutbox = new Map<string, AckDeliveryReceipt>();

function asKeyPart(value: string | undefined): string {
  return String(value ?? "");
}

function isLeaseExpired(entry: AckLeaseEntry, now: number): boolean {
  return entry.expiresAt <= now;
}

function getActiveLeaseEntry(leaseKey: string, now: number): AckLeaseEntry | null {
  const key = asKeyPart(leaseKey);
  if (!key) {
    return null;
  }

  const entry = ackLeases.get(key) ?? null;
  if (!entry) {
    return null;
  }

  if (isLeaseExpired(entry, now)) {
    ackLeases.delete(key);
    return null;
  }

  return entry;
}

function capOutboxSize(): void {
  while (ackDeliveryOutbox.size > MAX_OUTBOX_ENTRIES) {
    const oldestKey = ackDeliveryOutbox.keys().next().value;
    if (typeof oldestKey !== "string") {
      break;
    }
    ackDeliveryOutbox.delete(oldestKey);
  }
}

export function tryClaimLease(
  leaseKey: string,
  owner: AckLeaseOwner,
  deadlineMs: number,
): AckLeaseClaimResult {
  const key = asKeyPart(leaseKey);
  const now = Date.now();
  const expiresAt = now + Math.max(0, deadlineMs);

  if (!key || !owner) {
    return { claimed: false, owner: "", expiresAt: 0 };
  }

  const existing = getActiveLeaseEntry(key, now);
  if (existing) {
    return {
      claimed: existing.owner === owner,
      owner: existing.owner,
      expiresAt: existing.expiresAt,
    };
  }

  const nextEntry: AckLeaseEntry = { owner, expiresAt };
  ackLeases.set(key, nextEntry);
  return { claimed: true, owner, expiresAt };
}

export function releaseLease(leaseKey: string): void {
  const key = asKeyPart(leaseKey);
  if (!key) {
    return;
  }
  ackLeases.delete(key);
}

export function isLeaseClaimed(leaseKey: string): boolean {
  return getActiveLeaseEntry(leaseKey, Date.now()) !== null;
}

export function currentLeaseOwner(leaseKey: string): AckLeaseOwner | null {
  return getActiveLeaseEntry(leaseKey, Date.now())?.owner ?? null;
}

export function buildAckKey(parts: AckKeyParts): string {
  return `ack:${parts.threadId}:${parts.anchorId ?? "none"}:${parts.ackStage}:${parts.routePhase}:${parts.messageTurnId}`;
}

export function checkAndSet(
  ackKey: string,
  owner: string,
): { allowed: boolean; existingOwner?: string } {
  const key = asKeyPart(ackKey);
  const normalizedOwner = asKeyPart(owner);

  if (!key) {
    return { allowed: false };
  }

  const existingOwner = ackIdempotencyOwners.get(key);
  if (existingOwner !== undefined) {
    return { allowed: false, existingOwner };
  }

  ackIdempotencyOwners.set(key, normalizedOwner);
  return { allowed: true };
}

export function recordDelivery(ackKey: string, result: AckDeliveryReceipt): void {
  const key = asKeyPart(ackKey);
  if (!key) {
    return;
  }

  ackDeliveryOutbox.set(key, { ...result, ackKey: key });
  capOutboxSize();
}

export function getReceipt(ackKey: string): AckDeliveryReceipt | null {
  const key = asKeyPart(ackKey);
  if (!key) {
    return null;
  }
  return ackDeliveryOutbox.get(key) ?? null;
}

export function cleanupExpiredEntries(now: number = Date.now()): void {
  for (const [leaseKey, entry] of ackLeases.entries()) {
    if (isLeaseExpired(entry, now)) {
      ackLeases.delete(leaseKey);
    }
  }

  capOutboxSize();
}

export function resetAllState(): void {
  ackLeases.clear();
  ackIdempotencyOwners.clear();
  ackDeliveryOutbox.clear();
}
