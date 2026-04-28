import type { JudgeExecutionLayer } from "@octoclaw/policy/judge";
import { type TurnExecutionReceipt, buildTurnExecutionReceipt } from "../replay/replay-logger.js";
import { policyState } from "../state/policy-state.js";
import { parseSessionRoute } from "./session.js";

type JsonRecord = Record<string, unknown>;
type TurnExecutionReceiptWithSpawn = TurnExecutionReceipt & { spawnExecuted?: unknown };

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function explicitBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function entryTurnId(state: JsonRecord): string | null {
  const decision = isRecord(state.decision) ? state.decision : {};
  const correlation = isRecord(decision.correlation) ? decision.correlation : {};
  const routeSeal = isRecord(state.routeSeal) ? state.routeSeal : {};
  return asString(
    state.turnId
      ?? state.turn_id
      ?? state.messageTurnId
      ?? state.message_turn_id
      ?? correlation.turn_id
      ?? correlation.turnId
      ?? routeSeal.turnId,
  );
}

function attachExplicitSpawnReceipt(
  receipt: TurnExecutionReceipt,
  state: JsonRecord,
): TurnExecutionReceiptWithSpawn {
  const decision = isRecord(state.decision) ? state.decision : {};
  const runtimeTruth = isRecord(decision.runtime_truth) ? decision.runtime_truth : {};
  const delegateAttempt = isRecord(runtimeTruth.delegateAttempt) ? runtimeTruth.delegateAttempt : {};
  const candidates = [
    state.spawnExecuted,
    state.spawn_executed,
    decision.spawnExecuted,
    decision.spawn_executed,
    runtimeTruth.spawnExecuted,
    runtimeTruth.spawn_executed,
    delegateAttempt.spawnExecuted,
    delegateAttempt.spawn_executed,
  ];
  const explicitValues = candidates.map(explicitBoolean).filter((value) => value !== undefined);
  if (explicitValues.some((value) => value === true)) return { ...receipt, spawnExecuted: true };
  if (explicitValues.some((value) => value === false) && receipt.spawnExecuted !== true) {
    return { ...receipt, spawnExecuted: false };
  }
  return receipt;
}

function noneExecutionLayer(): JudgeExecutionLayer {
  return {
    coverage: "none",
    freshness: "stale",
    supports_provenance_reply: false,
    supports_status_reply: false,
    requires_control_plane_refresh: false,
    dispatch_executed: false,
    spawn_executed: false,
    result_materialized: false,
    evidence_summary: "no execution receipt available",
  };
}

function normalizeSessionKeys(sessionKeys: string[] | string | null): string[] {
  const raw = Array.isArray(sessionKeys) ? sessionKeys : [sessionKeys];
  return Array.from(new Set(raw.map((key) => String(key || "").trim()).filter(Boolean)));
}

function rootSessionKey(raw: string): string {
  const value = String(raw || "").trim();
  if (!value) return "";

  const parts = value.split(":");
  const threadMarker = parts.findIndex((part) => {
    const normalized = part.toLowerCase();
    return normalized === "thread" || normalized === "topic";
  });
  return threadMarker > 0 ? parts.slice(0, threadMarker).join(":") : value;
}

function deriveSessionAliases(sessionKeys: string[]): Set<string> {
  const aliases = new Set<string>();

  for (const key of normalizeSessionKeys(sessionKeys)) {
    aliases.add(key);

    const rootKey = rootSessionKey(key);
    if (rootKey) aliases.add(rootKey);

    const parsed = parseSessionRoute(key);
    if (parsed.bindingKey) aliases.add(parsed.bindingKey);
  }

  return aliases;
}

/**
 * Collect the most recent TurnExecutionReceipt for the given session key.
 * Strict session isolation — only same canonicalSessionKey.
 */
function collectLatestReceipt(
  sessionKeys: string[],
  excludeTurnId: string | undefined,
  decisionStartedAt: number,
): TurnExecutionReceiptWithSpawn | null {
  const sessionKeySet = deriveSessionAliases(sessionKeys);
  if (sessionKeySet.size === 0) return null;

  let best: TurnExecutionReceiptWithSpawn | null = null;
  let bestUpdatedAt = 0;

  for (const { state } of policyState.entries()) {
    const latestReceipt = isRecord(state?.latestExecutionReceipt)
      ? state.latestExecutionReceipt as unknown as TurnExecutionReceiptWithSpawn
      : null;
    const hasDecision = isRecord(state?.decision);
    if (!hasDecision && !latestReceipt) continue;

    const stateSession = asString(state.canonicalSessionKey ?? latestReceipt?.sessionKey);
    const stateBinding = asString(state.session_binding_key);
    if (
      (!stateSession || !sessionKeySet.has(stateSession))
      && (!stateBinding || !sessionKeySet.has(stateBinding))
    ) continue;

    if (excludeTurnId && (entryTurnId(state) === excludeTurnId || latestReceipt?.turnId === excludeTurnId)) continue;

    const updatedAt = Number(latestReceipt?.completedAt || state.updatedAt || state.createdAt || 0);
    if (!updatedAt || updatedAt >= decisionStartedAt) continue;
    if (updatedAt > bestUpdatedAt) {
      bestUpdatedAt = updatedAt;
      best = latestReceipt
        ? latestReceipt
        : attachExplicitSpawnReceipt(
          buildTurnExecutionReceipt(state, Math.max(0, updatedAt - Number(state.createdAt || updatedAt)), updatedAt || undefined),
          state,
        );
    }
  }

  return best;
}

/**
 * Derive coverage level from receipt freshness.
 */
function deriveCoverage(receipt: TurnExecutionReceipt | null, now: number): JudgeExecutionLayer["coverage"] {
  if (!receipt) return "none";
  const ageMs = now - receipt.completedAt;
  if (ageMs < 30_000) return "current_turn";
  if (ageMs < 5 * 60_000) return "recent_turn";
  return "thread";
}

/**
 * Derive freshness from receipt age.
 */
function deriveFreshness(receipt: TurnExecutionReceipt | null, now: number): JudgeExecutionLayer["freshness"] {
  if (!receipt) return undefined;
  const ageMs = now - receipt.completedAt;
  if (ageMs < 60_000) return "current";
  if (ageMs < 10 * 60_000) return "recent";
  return "stale";
}

/**
 * Build execution coverage layer for the judge context packet.
 * This is the PRIMARY signal for provenance/status routing.
 */
export function buildExecutionCoverageLayer(
  sessionKeys: string[],
  excludeTurnId?: string,
): JudgeExecutionLayer;
export function buildExecutionCoverageLayer(
  sessionKey: string | null,
  excludeTurnId?: string,
): JudgeExecutionLayer;
export function buildExecutionCoverageLayer(
  sessionKeysInput: string[] | string | null,
  excludeTurnId?: string,
): JudgeExecutionLayer {
  const now = Date.now();
  const sessionKeys = normalizeSessionKeys(sessionKeysInput);
  const receipt = collectLatestReceipt(sessionKeys, excludeTurnId, now);

  const coverage = deriveCoverage(receipt, now);
  const freshness = deriveFreshness(receipt, now);

  if (coverage === "none") {
    return noneExecutionLayer();
  }

  const supportsProvenanceReply = (
    receipt!.toolsUsed.length > 0
    || receipt!.delegated
    || receipt!.dispatchExecuted
    || receipt!.route === "reply"
  );

  const supportsStatusReply = (
    receipt!.delegated
    || receipt!.dispatchExecuted
    || receipt!.nativeTaskId !== null
  );

  const requiresControlPlaneRefresh = receipt!.delegated
    && receipt!.outcome === "unknown";

  const parts: string[] = [];
  if (receipt!.route === "reply") {
    parts.push("previous answer used main-session path");
  } else if (receipt!.delegated) {
    parts.push(`previous answer used delegated path (worker=${receipt!.workerPool ?? "unknown"})`);
  }
  if (receipt!.toolsUsed.length > 0) {
    parts.push(`tools=[${receipt!.toolsUsed.join(", ")}]`);
  }
  if (receipt!.dispatchExecuted) {
    parts.push("dispatch was executed");
  }
  if (receipt!.dispatchExecuted && explicitBoolean(receipt!.spawnExecuted) !== true) {
    parts.push("spawn not confirmed");
  } else if (explicitBoolean(receipt!.spawnExecuted) === true) {
    parts.push("spawn was confirmed");
  }
  if (receipt!.nativeTaskId) {
    parts.push(`native_task=${receipt!.nativeTaskId}`);
  }
  if (receipt!.resultMaterialized) {
    parts.push("result was materialized");
  }
  if (receipt!.deliveryStatus) {
    parts.push(`delivery=${receipt!.deliveryStatus}`);
  }

  return {
    coverage,
    freshness,
    supports_provenance_reply: supportsProvenanceReply,
    supports_status_reply: supportsStatusReply,
    requires_control_plane_refresh: requiresControlPlaneRefresh,
    last_route: receipt!.route === "reply" ? "reply" : receipt!.route === "delegate" ? "delegate" : "unknown",
    tools_used: receipt!.toolsUsed.length > 0 ? receipt!.toolsUsed : undefined,
    dispatch_executed: receipt!.dispatchExecuted ?? false,
    spawn_executed: explicitBoolean(receipt!.spawnExecuted) ?? false,
    native_task_id: receipt!.nativeTaskId ?? undefined,
    native_flow_id: receipt!.nativeFlowId ?? undefined,
    result_materialized: receipt!.resultMaterialized ?? false,
    delivery_status: (receipt!.deliveryStatus as JudgeExecutionLayer["delivery_status"]) ?? undefined,
    evidence_summary: parts.length > 0 ? parts.join("; ") : undefined,
  };
}
