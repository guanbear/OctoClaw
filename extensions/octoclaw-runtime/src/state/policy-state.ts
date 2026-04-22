import fsSync from "node:fs";
import path from "node:path";
import { resolvePolicyStateLedgerPath } from "../resolve/env.js";
import { authoritativeDecisionRoute, canonicalizeDecisionForPolicyState, isDelegatedRoute } from "../resolve/route-helpers.js";

export const POLICY_STATE_TTL_MS = 30 * 60 * 1000;
const PERSIST_DEBOUNCE_MS = 2_000;
const RECENT_DELEGATED_MAX_AGE_MS = 2 * 60 * 1000;

export interface PolicyStateEntry {
  decision?: Record<string, unknown>;
  routeHintSubmitted?: boolean;
  directToolsSeen?: string[];
  blockedTools?: string[];
  delegated?: boolean;
  delegationTool?: string;
  latencyAckSent?: boolean;
  ackGuardKey?: string;
  pendingDeliveryId?: string;
  pendingDeliveryTaskId?: string;
  pendingDeliveryRunnerJobId?: string;
  deliveryObserved?: boolean;
  canonicalSessionKey?: string;
  sessionBoundary?: { status: string; reason: string };
  updatedAt?: number;
  createdAt?: number;
  [key: string]: unknown;
}

export interface PolicyStateStoreOptions {
  sessionStateFile?: string;
  resolveKey?: (ctx: Record<string, unknown>) => string;
  resolveKeys?: (ctx: Record<string, unknown>) => string[];
  isControlPrompt?: (prompt: string, ctx: Record<string, unknown>) => boolean;
  ttlMs?: number;
  persistDebounceMs?: number;
}

interface PersistedPolicyStateLedger {
  schema_version?: string;
  updated_at?: string;
  ttl_ms?: number;
  sessions?: Record<string, PolicyStateEntry>;
}

interface FsSyncLike {
  existsSync(pathname: string): boolean;
  mkdirSync(pathname: string, options?: { recursive?: boolean }): void;
  readFileSync(pathname: string, encoding: string): string;
  writeFileSync(pathname: string, data: string, encoding: string): void;
}

interface PathLike {
  dirname(pathname: string): string;
  join(...parts: string[]): string;
}

const fs = fsSync as unknown as FsSyncLike;
const pathApi = path as unknown as PathLike;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneEntry(entry: PolicyStateEntry): PolicyStateEntry {
  return { ...entry };
}

function normalizeEntry(entry: PolicyStateEntry): PolicyStateEntry {
  const next = { ...entry };
  if (isRecord(next.decision)) {
    next.decision = canonicalizeDecisionForPolicyState(next.decision);
    next.delegated = authoritativeDecisionRoute(next.decision, "reply") === "delegate";
  }
  return next;
}

function normalizePrompt(prompt: string): string {
  return String(prompt || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function promptLookupCandidates(prompt: string): string[] {
  const normalized = normalizePrompt(prompt);
  if (!normalized) {
    return [];
  }

  const compact = normalized.replace(/[\s\p{P}\p{S}]+/gu, " ").trim();
  const candidates = [normalized, compact].filter(Boolean);
  return Array.from(new Set(candidates));
}

function promptsEquivalent(prompt: string, candidatePrompt: string): boolean {
  const leftCandidates = promptLookupCandidates(prompt);
  const rightCandidates = promptLookupCandidates(candidatePrompt);
  if (leftCandidates.length === 0 || rightCandidates.length === 0) {
    return false;
  }

  return leftCandidates.some((left) => rightCandidates.includes(left));
}

function entryTimestamp(entry: PolicyStateEntry | null | undefined): number {
  return Number(entry?.updatedAt || entry?.createdAt || 0);
}

function extractPrompt(entry: PolicyStateEntry): string {
  const value = entry.prompt;
  return typeof value === "string" ? value : "";
}

function extractDecisionRoute(entry: PolicyStateEntry): string {
  const decision = entry.decision;
  if (!isRecord(decision)) {
    return "";
  }

  const routeDecision = decision.route_decision;
  if (!isRecord(routeDecision)) {
    return "";
  }

  const route = routeDecision.route;
  return typeof route === "string" ? route.trim() : "";
}

function toPersistedSessions(payload: unknown): Record<string, PolicyStateEntry> {
  if (!isRecord(payload)) {
    return {};
  }

  const sessions = isRecord(payload.sessions) ? payload.sessions : payload;
  const result: Record<string, PolicyStateEntry> = {};

  for (const [key, value] of Object.entries(sessions)) {
    if (isRecord(value)) {
      result[key] = { ...value };
    }
  }

  return result;
}

export function promptTokenScore(prompt: string, candidatePrompt: string): number {
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

export class PolicyStateStore {
  private readonly sessionStateFile: string;
  private readonly resolveKeyCallback?: (ctx: Record<string, unknown>) => string;
  private readonly resolveKeysCallback?: (ctx: Record<string, unknown>) => string[];
  private readonly isControlPromptCallback?: (prompt: string, ctx: Record<string, unknown>) => boolean;
  private readonly ttlMs: number;
  private readonly persistDebounceMs: number;
  private readonly entries = new Map<string, PolicyStateEntry>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: PolicyStateStoreOptions = {}) {
    this.sessionStateFile = String(options.sessionStateFile || "").trim();
    this.resolveKeyCallback = options.resolveKey;
    this.resolveKeysCallback = options.resolveKeys;
    this.isControlPromptCallback = options.isControlPrompt;
    this.ttlMs = options.ttlMs ?? POLICY_STATE_TTL_MS;
    this.persistDebounceMs = options.persistDebounceMs ?? PERSIST_DEBOUNCE_MS;
    this.load();
  }

  get(stateKey: string): PolicyStateEntry | undefined {
    this.prune();
    const key = String(stateKey || "").trim();
    if (!key) {
      return undefined;
    }

    const entry = this.entries.get(key);
    return entry ? cloneEntry(entry) : undefined;
  }

  set(stateKey: string, entry: PolicyStateEntry): void {
    const key = String(stateKey || "").trim();
    if (!key) {
      return;
    }

    const now = Date.now();
    const previous = this.entries.get(key);
    const next: PolicyStateEntry = {
      ...normalizeEntry(cloneEntry(entry)),
      createdAt: entry.createdAt ?? previous?.createdAt ?? now,
      updatedAt: now,
    };
    this.entries.set(key, next);
    this.schedulePersist();
  }

  update(stateKey: string, mutator: (current: PolicyStateEntry) => PolicyStateEntry): void {
    const key = String(stateKey || "").trim();
    if (!key) {
      return;
    }

    const current = this.entries.get(key);
    const base: PolicyStateEntry = current ? cloneEntry(current) : { createdAt: Date.now() };
    const next = mutator(base);
    this.set(key, next);
  }

  clear(stateKey: string): void {
    const key = String(stateKey || "").trim();
    if (!key) {
      return;
    }

    if (this.entries.delete(key)) {
      this.schedulePersist();
    }
  }

  prune(): void {
    const now = Date.now();
    let changed = false;
    for (const [key, value] of this.entries.entries()) {
      if (!value || now - entryTimestamp(value) > this.ttlMs) {
        this.entries.delete(key);
        changed = true;
      }
    }
    if (changed) {
      this.schedulePersist();
    }
  }

  clearAll(): void {
    if (this.entries.size === 0) {
      return;
    }

    this.entries.clear();
    this.schedulePersist();
  }

  findByPrompt(prompt: string): { key: string; entry: PolicyStateEntry } | null {
    const task = String(prompt || "").trim();
    if (!task) {
      return null;
    }

    this.prune();
    let best: { key: string; entry: PolicyStateEntry } | null = null;
    let bestUpdatedAt = 0;

    for (const [key, entry] of this.entries.entries()) {
      if (!promptsEquivalent(task, extractPrompt(entry))) {
        continue;
      }
      const updatedAt = entryTimestamp(entry);
      if (!best || updatedAt >= bestUpdatedAt) {
        best = { key, entry: cloneEntry(entry) };
        bestUpdatedAt = updatedAt;
      }
    }

    return best;
  }

  findRecentDelegated(prompt: string, maxAgeMs = RECENT_DELEGATED_MAX_AGE_MS): { key: string; entry: PolicyStateEntry } | null {
    this.prune();
    const now = Date.now();
    const normalizedPrompt = promptLookupCandidates(prompt)[0] || String(prompt || "").trim();
    if (!normalizedPrompt) {
      return null;
    }

    let best: { key: string; entry: PolicyStateEntry } | null = null;
    let bestScore = -1;
    let bestUpdatedAt = 0;

    for (const [key, entry] of this.entries.entries()) {
      const route = extractDecisionRoute(entry);
      if (!isDelegatedRoute(route)) {
        continue;
      }

      const updatedAt = entryTimestamp(entry);
      if (!updatedAt || now - updatedAt > maxAgeMs) {
        continue;
      }

      const candidatePrompt = promptLookupCandidates(extractPrompt(entry))[0] || extractPrompt(entry);
      const score = promptTokenScore(normalizedPrompt, candidatePrompt);
      if (score <= 0) {
        continue;
      }

      if (score > bestScore || (score === bestScore && updatedAt > bestUpdatedAt)) {
        best = { key, entry: cloneEntry(entry) };
        bestScore = score;
        bestUpdatedAt = updatedAt;
      }
    }

    return best;
  }

  resolveForContext(ctx: Record<string, unknown>): { key: string; state: PolicyStateEntry | null } {
    this.prune();
    const keys = this.resolveContextKeys(ctx);
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (entry) {
        return { key, state: cloneEntry(entry) };
      }
    }
    return { key: keys[0] || "", state: null };
  }

  getToolPolicyContext(ctx: Record<string, unknown>, prompt = ""): { key: string; state: PolicyStateEntry | null } {
    const direct = this.resolveForContext(ctx);
    if (direct.state && (!prompt || promptsEquivalent(prompt, extractPrompt(direct.state)))) {
      return direct;
    }

    if (this.isControlPromptCallback?.(prompt, ctx)) {
      return { key: "", state: null };
    }

    const byPrompt = this.findByPrompt(prompt);
    if (byPrompt) {
      return { key: byPrompt.key, state: byPrompt.entry };
    }

    const recent = this.findRecentDelegated(prompt);
    if (recent) {
      return { key: recent.key, state: recent.entry };
    }

    return { key: "", state: null };
  }

  persist(): void {
    this.clearPersistTimer();
    if (!this.sessionStateFile) {
      return;
    }

    this.pruneInMemoryOnly();

    try {
      const directory = pathApi.dirname(this.sessionStateFile);
      if (!fs.existsSync(directory)) {
        fs.mkdirSync(directory, { recursive: true });
      }

      const payload: PersistedPolicyStateLedger = {
        schema_version: "octoclaw.runtime_policy.state_ledger/v1",
        updated_at: new Date().toISOString(),
        ttl_ms: this.ttlMs,
        sessions: Object.fromEntries(this.entries.entries()),
      };
      fs.writeFileSync(this.sessionStateFile, JSON.stringify(payload, null, 2), "utf-8");
    } catch {
      // Best-effort persistence only.
    }
  }

  load(): void {
    this.clearPersistTimer();
    this.entries.clear();
    if (!this.sessionStateFile || !fs.existsSync(this.sessionStateFile)) {
      return;
    }

    try {
      const raw = fs.readFileSync(this.sessionStateFile, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      const sessions = toPersistedSessions(parsed);
      const now = Date.now();

      for (const [key, entry] of Object.entries(sessions)) {
        const updatedAt = entryTimestamp(entry);
        if (updatedAt && now - updatedAt > this.ttlMs) {
          continue;
        }
        this.entries.set(key, normalizeEntry(cloneEntry(entry)));
      }
    } catch {
      this.entries.clear();
    }
  }

  private schedulePersist(): void {
    if (!this.sessionStateFile) {
      return;
    }
    this.clearPersistTimer();
    this.persistTimer = setTimeout(() => {
      this.persist();
    }, this.persistDebounceMs);
  }

  private clearPersistTimer(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
  }

  private pruneInMemoryOnly(): void {
    const now = Date.now();
    for (const [key, value] of this.entries.entries()) {
      if (!value || now - entryTimestamp(value) > this.ttlMs) {
        this.entries.delete(key);
      }
    }
  }

  private resolveContextKeys(ctx: Record<string, unknown>): string[] {
    const explicitKeys = this.resolveKeysCallback?.(ctx) || [];
    const resolvedKey = this.resolveKeyCallback?.(ctx);
    const fallbackKeys = [
      typeof ctx.canonicalSessionKey === "string" ? ctx.canonicalSessionKey : "",
      typeof ctx.sessionKey === "string" ? ctx.sessionKey : "",
      typeof ctx.sessionId === "string" ? ctx.sessionId : "",
      typeof resolvedKey === "string" ? resolvedKey : "",
    ];

    return Array.from(
      new Set(
        [...explicitKeys, ...fallbackKeys]
          .map((value) => String(value || "").trim())
          .filter(Boolean),
      ),
    );
  }
}

export interface PolicyStateStoreApi {
  get: (stateKey: string) => PolicyStateEntry | undefined;
  getState: (stateKey: string) => PolicyStateEntry | undefined;
  entries: () => Array<{ key: string; state: PolicyStateEntry }>;
  set: (stateKey: string, entry: PolicyStateEntry) => void;
  setState: (stateKey: string, entry: PolicyStateEntry) => void;
  clear: (stateKey: string) => void;
  clearState: (stateKey: string) => void;
  update: (stateKey: string, mutator: (current: PolicyStateEntry) => PolicyStateEntry) => void;
  updateState: (stateKey: string, mutator: (current: PolicyStateEntry) => PolicyStateEntry) => void;
  prune: () => void;
  findByPrompt: (prompt: string) => { key: string; state: PolicyStateEntry | null };
  findRecentDelegated: (prompt: string, maxAgeMs?: number) => { key: string; state: PolicyStateEntry | null };
  resolveForContext: (ctx: Record<string, unknown>) => { key: string; state: PolicyStateEntry | null };
  getToolPolicyContext: (ctx: Record<string, unknown>, prompt?: string) => { key: string; state: PolicyStateEntry | null };
  persist: () => void;
  load: () => void;
}

export function createPolicyStateStore(sessionStateFile?: string): PolicyStateStoreApi {
  const store = new PolicyStateStore({
    sessionStateFile: String(sessionStateFile || "").trim() || resolvePolicyStateLedgerPath(),
  });
  return {
    get: (stateKey) => store.get(stateKey),
    getState: (stateKey) => store.get(stateKey),
    entries: () => {
      store.prune();
      return Array.from((store as unknown as { entries: Map<string, PolicyStateEntry> }).entries.entries())
        .map(([key, state]) => ({ key, state: { ...state } }));
    },
    set: (stateKey, entry) => store.set(stateKey, entry),
    setState: (stateKey, entry) => store.set(stateKey, entry),
    clear: (stateKey) => store.clear(stateKey),
    clearState: (stateKey) => store.clear(stateKey),
    update: (stateKey, mutator) => store.update(stateKey, mutator),
    updateState: (stateKey, mutator) => store.update(stateKey, mutator),
    prune: () => store.prune(),
    findByPrompt: (prompt) => {
      const result = store.findByPrompt(prompt);
      return { key: result?.key || "", state: result?.entry || null };
    },
    findRecentDelegated: (prompt, maxAgeMs) => {
      const result = store.findRecentDelegated(prompt, maxAgeMs);
      return { key: result?.key || "", state: result?.entry || null };
    },
    resolveForContext: (ctx) => store.resolveForContext(ctx),
    getToolPolicyContext: (ctx, prompt = "") => store.getToolPolicyContext(ctx, prompt),
    persist: () => store.persist(),
    load: () => store.load(),
  };
}

export const policyState = createPolicyStateStore(
  String(process.env.OCTOCLAW_SESSION_STATE_FILE || "").trim() || resolvePolicyStateLedgerPath(),
);

export default policyState;
