import os from "node:os";
import path from "node:path";
import { createHealthEventSink, type HealthEventInput, type HealthEventSink } from "@octoclaw/router";
import { asRecord, type UnknownRecord } from "../util/type-coercion.js";
import { stringValue } from "../extension-entry-shared.js";

type LoggerLike = { warn?: (message: string) => void } | null | undefined;
const runtimeHealthSinks = new Map<string, HealthEventSink>();

export interface RuntimeHealthBuildInput {
  event: unknown;
  ctx: unknown;
  state: unknown;
  stateKey?: string;
  model?: string;
  success?: boolean;
  latencyMs?: number;
  toolCallFailed?: boolean;
}

export interface RuntimeHealthRecordInput extends RuntimeHealthBuildInput {
  openclawHome?: string;
  logger?: LoggerLike;
}

export interface RuntimeHealthRecordResult {
  recorded: boolean;
  reason?: string;
  flush?: () => Promise<void>;
}

export function buildRuntimeHealthEvent(input: RuntimeHealthBuildInput): HealthEventInput | null {
  const event = asRecord(input.event);
  const ctx = asRecord(input.ctx);
  const state = asRecord(input.state);
  const decision = asRecord(state.decision || event.decision);
  const modelPolicy = asRecord(decision.model_policy || decision.modelPolicy);
  const routeDecision = asRecord(decision.route_decision || decision.routeDecision);
  const params = asRecord(event.params || event.arguments || event.input);
  const result = asRecord(event.result);
  const modelKey = firstString(
    input.model,
    event.model,
    event.resolvedModel,
    event.resolved_model,
    event.actualModel,
    event.actual_model,
    params.model,
    params.modelId,
    params.model_id,
    result.model,
    result.modelId,
    state.model,
    state.resolvedModel,
    state.resolved_model,
    state.actualModel,
    state.actual_model,
    modelPolicy.selected_model,
    modelPolicy.selectedModel,
    modelPolicy.profile,
    routeDecision.model,
    routeDecision.selected_model,
  );
  if (!modelKey) return null;

  const hasError = Boolean(firstString(event.error, result.error, state.error));
  const success = input.success ?? !hasError;
  const errorCode = success ? undefined : firstString(event.errorCode, event.error_code, result.errorCode, result.error_code) || "RUNTIME_ERROR";
  const latencyMs = input.latencyMs ?? firstNumber(event.latencyMs, event.latency_ms, event.durationMs, event.duration_ms, result.latencyMs, result.durationMs);
  const sessionKey = firstString(input.stateKey, ctx.sessionKey, ctx.canonicalSessionKey, event.sessionKey, state.sessionKey);
  const turnId = firstString(ctx.turnId, ctx.turn_id, event.turnId, event.turn_id, state.turnId, state.turn_id);
  const agentId = firstString(ctx.agentId, ctx.agent_id, event.agentId, event.agent_id);

  return {
    modelKey,
    source: "runtime",
    success,
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(isTimeout(event, result) ? { timeout: true } : {}),
    ...(input.toolCallFailed ? { toolCallFailed: true } : {}),
    evidence: {
      ...(sessionKey ? { sessionKey } : {}),
      ...(turnId ? { turnId } : {}),
      ...(agentId ? { agentId } : {}),
    },
  };
}

export function recordRuntimeHealthCall(input: RuntimeHealthRecordInput): RuntimeHealthRecordResult {
  try {
    const event = buildRuntimeHealthEvent(input);
    if (!event) return { recorded: false, reason: "no_model" };
    const sink = createRuntimeHealthSink(input.openclawHome);
    sink.recordCall(event);
    return { recorded: true, flush: () => sink.flush() };
  } catch (error) {
    input.logger?.warn?.(`[router-health] runtime health record failed: ${error instanceof Error ? error.message : String(error)}`);
    return { recorded: false, reason: "record_failed" };
  }
}

export function createRuntimeHealthSink(openclawHome = resolveOpenclawHome()): HealthEventSink {
  const cached = runtimeHealthSinks.get(openclawHome);
  if (cached) return cached;
  const sink = createHealthEventSink({
    jsonlPath: path.join(openclawHome, "octoclaw", "router-lite", "model-health.jsonl"),
    snapshotPath: path.join(openclawHome, "octoclaw", "router-lite", "model-health-snapshot.json"),
  });
  runtimeHealthSinks.set(openclawHome, sink);
  return sink;
}

function resolveOpenclawHome(): string {
  return stringValue(process.env.OPENCLAW_HOME) || path.join(os.homedir(), ".openclaw");
}

function isTimeout(...records: UnknownRecord[]): boolean {
  const text = records.map((record) => `${stringValue(record.errorCode)} ${stringValue(record.error)} ${stringValue(record.status)}`).join(" ").toLowerCase();
  return text.includes("timeout") || text.includes("timed out");
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = stringValue(value);
    if (text) return text;
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const number = typeof value === "number" ? value : (typeof value === "string" ? Number(value) : Number.NaN);
    if (Number.isFinite(number)) return number;
  }
  return undefined;
}
