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
      const oldest = [...this.entries.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
      if (oldest) this.entries.delete(oldest[0]);
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
