import { createHash } from "node:crypto";
import type { JudgeOutput, JudgeRecentExecution } from "./judge-schema.js";

export interface JudgeCacheKeyInput {
  prompt: string;
  sessionKey: string;
  recentExecution: JudgeRecentExecution | null;
  judgeModelId: string;
  snapshotId: string;
}

export function computeJudgeCacheKey(input: JudgeCacheKeyInput): string {
  const normalizedPrompt = input.prompt
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  const execFingerprint = input.recentExecution
    ? `${input.recentExecution.taskId}:${input.recentExecution.status}`
    : "none";
  const material = [
    normalizedPrompt,
    input.sessionKey,
    execFingerprint,
    input.judgeModelId,
    input.snapshotId,
  ].join("::");
  return createHash("sha256").update(material).digest("hex");
}

export class JudgeCache {
  private readonly entries = new Map<string, { result: JudgeOutput; expiresAt: number }>();

  constructor(
    private readonly options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {},
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get(key: string): JudgeOutput | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (this.now() > entry.expiresAt) {
      this.entries.delete(key);
      return null;
    }
    return entry.result;
  }

  set(key: string, result: JudgeOutput): void {
    if (this.entries.size >= this.maxEntries()) {
      // Evict the single entry with the smallest expiresAt. A full sort is
      // O(n log n) on every capacity write; a single-pass min scan is O(n) and
      // sufficient since we only need the oldest one.
      let oldestKey: string | null = null;
      let oldestExpiresAt = Number.POSITIVE_INFINITY;
      for (const [entryKey, entry] of this.entries) {
        if (entry.expiresAt < oldestExpiresAt) {
          oldestExpiresAt = entry.expiresAt;
          oldestKey = entryKey;
        }
      }
      if (oldestKey !== null) this.entries.delete(oldestKey);
    }
    this.entries.set(key, { result, expiresAt: this.now() + this.ttlMs() });
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private ttlMs(): number {
    return this.options.ttlMs ?? 120_000;
  }

  private maxEntries(): number {
    return this.options.maxEntries ?? 1000;
  }
}
