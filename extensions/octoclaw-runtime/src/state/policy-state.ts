import type { RouteSeal } from "@octoclaw/contracts/route-seal";
import { canonicalizeDecisionForPolicyState, isDelegatedRoute } from "../resolve/route-helpers.js";

export const POLICY_STATE_TTL_MS = 5 * 60 * 1000;
const RECENT_DELEGATED_MAX_AGE_MS = 2 * 60 * 1000;

export interface PolicyStateEntry {
  prompt?: string;
  decision?: Record<string, unknown>;
  routeSeal?: RouteSeal;
  routeHintSubmitted?: boolean;
  routeHintPayload?: Record<string, unknown> | null;
  routeCommitAckSent?: boolean;
  route_commit_ack_sent?: boolean;
  routeCommitAckId?: string;
  directToolsSeen?: string[];
  controlToolsSeen?: string[];
  blockedTools?: string[];
  toolsUsed?: string[];
  delegated?: boolean;
  delegationTool?: string;
  delegateTaskContext?: Record<string, unknown>;
  delegateProgressEvents?: unknown[];
  delegate_without_dispatch?: boolean;
  dispatchExecuted?: boolean;
  dispatch_executed?: boolean;
  spawnExecuted?: boolean;
  spawn_executed?: boolean;
  resultMaterialized?: boolean;
  result_materialized?: boolean;
  latencyAckSent?: boolean;
  latencyAckText?: string;
  reactionAckEnabled?: boolean;
  reactionAckSupported?: boolean;
  reactionAckSent?: boolean;
  reactionAckEmoji?: string;
  reaction_ack_emoji?: string;
  ackGuardKey?: string;
  ack_guard_key?: string;
  inboundMessageTs?: string;
  message_id?: string;
  messageId?: string;
  turnId?: string;
  turn_id?: string;
  messageTurnId?: string;
  message_turn_id?: string;
  replyToMessageId?: string;
  reply_to_id?: string;
  session_binding_key?: string;
  pending_slots?: string[];
  formal_reply_visible?: boolean;
  outbound_guard_replaced?: boolean;
  outbound_guard_replaced_at?: string;
  outbound_projection_footer_appended?: boolean;
  outbound_projection_footer_appended_at?: string;
  latestAnomalyNotice?: Record<string, unknown>;
  pendingDeliveryId?: string;
  pendingDeliveryTaskId?: string;
  pendingDeliveryRunnerJobId?: string;
  deliveryObserved?: boolean;
  canonicalSessionKey?: string;
  sessionBoundary?: { status: string; reason: string };
  workContractId?: string;
  latestStatus?: import("@octoclaw/contracts/work-contract").WorkContractStatus;
  latestExecutionReceipt?: import("../receipt.js").TurnExecutionReceipt;
  updatedAt?: number;
  createdAt?: number;
  extraState?: Record<string, unknown>;
}

export interface PolicyStateStoreOptions {
  sessionStateFile?: string;
  resolveKey?: (ctx: Record<string, unknown>) => string;
  resolveKeys?: (ctx: Record<string, unknown>) => string[];
  isControlPrompt?: (prompt: string, ctx: Record<string, unknown>) => boolean;
  ttlMs?: number;
  persistDebounceMs?: number;
}

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
  }
  next.delegated = next.delegated === true;
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
  private readonly resolveKeyCallback?: (ctx: Record<string, unknown>) => string;
  private readonly resolveKeysCallback?: (ctx: Record<string, unknown>) => string[];
  private readonly isControlPromptCallback?: (prompt: string, ctx: Record<string, unknown>) => boolean;
  private readonly ttlMs: number;
  private readonly _entries = new Map<string, PolicyStateEntry>();

  constructor(options: PolicyStateStoreOptions = {}) {
    void options.sessionStateFile;
    this.resolveKeyCallback = options.resolveKey;
    this.resolveKeysCallback = options.resolveKeys;
    this.isControlPromptCallback = options.isControlPrompt;
    this.ttlMs = options.ttlMs ?? POLICY_STATE_TTL_MS;
    void options.persistDebounceMs;
    this.load();
  }

  get(stateKey: string): PolicyStateEntry | undefined {
    this.prune();
    const key = String(stateKey || "").trim();
    if (!key) {
      return undefined;
    }

    const entry = this._entries.get(key);
    return entry ? cloneEntry(entry) : undefined;
  }

  set(stateKey: string, entry: PolicyStateEntry): void {
    const key = String(stateKey || "").trim();
    if (!key) {
      return;
    }

    const now = Date.now();
    const previous = this._entries.get(key);
    const next: PolicyStateEntry = {
      ...normalizeEntry(cloneEntry(entry)),
      createdAt: entry.createdAt ?? previous?.createdAt ?? now,
      updatedAt: now,
    };
    this._entries.set(key, next);
    this.schedulePersist();
  }

  update(stateKey: string, mutator: (current: PolicyStateEntry) => PolicyStateEntry): void {
    const key = String(stateKey || "").trim();
    if (!key) {
      return;
    }

    const current = this._entries.get(key);
    const base: PolicyStateEntry = current ? cloneEntry(current) : { createdAt: Date.now() };
    const next = mutator(base);
    this.set(key, next);
  }

  clear(stateKey: string): void {
    const key = String(stateKey || "").trim();
    if (!key) {
      return;
    }

    if (this._entries.delete(key)) {
      this.schedulePersist();
    }
  }

  prune(): void {
    const now = Date.now();
    let changed = false;
    for (const [key, value] of this._entries.entries()) {
      if (!value || now - entryTimestamp(value) > this.ttlMs) {
        this._entries.delete(key);
        changed = true;
      }
    }
    if (changed) {
      this.schedulePersist();
    }
  }

  clearAll(): void {
    if (this._entries.size === 0) {
      return;
    }

    this._entries.clear();
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

    for (const [key, entry] of this._entries.entries()) {
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

    for (const [key, entry] of this._entries.entries()) {
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
      const entry = this._entries.get(key);
      if (entry) {
        return { key, state: cloneEntry(entry) };
      }
    }
    return { key: keys[0] || "", state: null };
  }

  /**
   * Resolve policy state for generic before_tool_call gate.
   * Uses ONLY exact/current context state — no fuzzy prompt matching.
   * If no exact state exists for the current context, returns null state
   * so the tool gate does not apply stale route_hint/delegate blocks.
   */
  getToolPolicyContext(ctx: Record<string, unknown>, _prompt = ""): { key: string; state: PolicyStateEntry | null } {
    return this.resolveForContext(ctx);
  }

  /**
   * Resolve policy state for octoclaw_route_hint and octoclaw_dispatch
   * where prompt-fuzzy lookup is explicitly allowed.
   * Falls back to findByPrompt and findRecentDelegated when no exact context match exists.
   */
  getDispatchPolicyContext(ctx: Record<string, unknown>, prompt = ""): { key: string; state: PolicyStateEntry | null } {
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
    this.pruneInMemoryOnly();
  }

  load(): void {
    this.pruneInMemoryOnly();
  }

  private schedulePersist(): void {
    this.pruneInMemoryOnly();
  }

  private pruneInMemoryOnly(): void {
    const now = Date.now();
    for (const [key, value] of this._entries.entries()) {
      if (!value || now - entryTimestamp(value) > this.ttlMs) {
        this._entries.delete(key);
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

  public entries(): Map<string, PolicyStateEntry> {
    return this._entries;
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
  getDispatchPolicyContext: (ctx: Record<string, unknown>, prompt?: string) => { key: string; state: PolicyStateEntry | null };
  persist: () => void;
  load: () => void;
}

export function createPolicyStateStore(sessionStateFile?: string): PolicyStateStoreApi {
  const store = new PolicyStateStore({
    sessionStateFile: String(sessionStateFile || "").trim(),
  });
  return {
    get: (stateKey) => store.get(stateKey),
    getState: (stateKey) => store.get(stateKey),
    entries: () => {
      store.prune();
      return Array.from(store.entries().entries())
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
    getDispatchPolicyContext: (ctx, prompt = "") => store.getDispatchPolicyContext(ctx, prompt),
    persist: () => store.persist(),
    load: () => store.load(),
  };
}

export const policyState = createPolicyStateStore(
  String(process.env.OCTOCLAW_SESSION_STATE_FILE || "").trim(),
);

export default policyState;
