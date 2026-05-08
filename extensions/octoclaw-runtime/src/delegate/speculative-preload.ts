import { stableId } from "../resolve/env.js";
import { asRecord, asString, type UnknownRecord } from "../util/type-coercion.js";

export const SPECULATIVE_PRELOAD_LABEL_PREFIX = "octoclaw-speculative-";
export const SPECULATIVE_PRELOAD_STANDBY_TASK = "Standby worker. Do not execute any task. Await task assignment via sessions_send.";

export interface SessionsSendArgs {
  message: string;
  sessionKey?: string;
  label?: string;
  agentId?: string;
  timeoutSeconds?: number;
  [key: string]: unknown;
}

export interface SpeculativePreloadState {
  label: string;
  status: "hinted" | "spawn_call_started" | "ready" | "dispatched" | "stale";
  createdAt?: number;
  updatedAt?: number;
  runId?: string;
  childSessionKey?: string;
  error?: string;
  spawnArgs?: UnknownRecord;
}

export function readSpeculativePreloadState(state: unknown): SpeculativePreloadState | null {
  const record = asRecord(asRecord(state).speculativePreload || asRecord(state).speculative_preload);
  const label = asString(record.label);
  if (!label) return null;
  const status = asString(record.status);
  return {
    label,
    status: status === "spawn_call_started" || status === "ready" || status === "dispatched" || status === "stale" ? status : "hinted",
    createdAt: Number(record.createdAt || record.created_at) || undefined,
    updatedAt: Number(record.updatedAt || record.updated_at) || undefined,
    runId: asString(record.runId || record.run_id) || undefined,
    childSessionKey: asString(record.childSessionKey || record.child_session_key) || undefined,
    error: asString(record.error) || undefined,
    spawnArgs: asRecord(record.spawnArgs || record.spawn_args),
  };
}

export function buildSpeculativePreloadLabel(input: {
  stateKey: string;
  sessionId?: string;
  inboundMessageTs?: string;
  prompt?: string;
  nonce?: string;
}): string {
  return stableId(SPECULATIVE_PRELOAD_LABEL_PREFIX.replace(/-$/u, ""), [
    input.stateKey,
    input.sessionId || "",
    input.inboundMessageTs || "",
    input.prompt || "",
    input.nonce || "",
  ]);
}

export function buildSpeculativePreloadSpawnArgs(input: {
  label: string;
  model?: string;
  cwd?: string;
  runTimeoutSeconds?: number;
}): UnknownRecord {
  return {
    task: SPECULATIVE_PRELOAD_STANDBY_TASK,
    label: input.label,
    runtime: "subagent",
    mode: "session",
    thread: true,
    cleanup: "keep",
    sandbox: "inherit",
    context: "isolated",
    lightContext: true,
    expectsCompletionMessage: false,
    ...(input.model ? { model: input.model } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    runTimeoutSeconds: input.runTimeoutSeconds || 300,
  };
}

export function isSpeculativePreloadSpawnArgs(args: unknown): boolean {
  const record = asRecord(args);
  const label = asString(record.label);
  const task = asString(record.task);
  return label.startsWith(SPECULATIVE_PRELOAD_LABEL_PREFIX)
    && task === SPECULATIVE_PRELOAD_STANDBY_TASK
    && record.mode === "session"
    && record.thread === true
    && record.context === "isolated"
    && record.lightContext === true;
}

export function buildSpeculativePreloadHint(spawnArgs: UnknownRecord): string {
  return [
    "OCTOCLAW_SPECULATIVE_SPAWN_HINT:",
    "If runtime route is delegate, your first control-plane action must be this exact standby spawn before octoclaw_dispatch:",
    `sessions_spawn(${JSON.stringify(spawnArgs)})`,
    "These are runtime-generated exact args, not a hand-written spawn command.",
    "Do not call octoclaw_dispatch first while this hint is active.",
    "This standby worker must not execute user work yet. After octoclaw_dispatch returns dispatchMode=send_to_speculative, call sessions_send with the returned sessionsSendArgs.",
    "If you answer directly, do not mention the standby worker and do not send an accepted/delegated ACK.",
  ].join("\n");
}

export function speculativePreloadStateForHint(input: {
  label: string;
  spawnArgs: UnknownRecord;
  now?: number;
}): SpeculativePreloadState {
  const now = input.now ?? Date.now();
  return {
    label: input.label,
    status: "hinted",
    createdAt: now,
    updatedAt: now,
    spawnArgs: input.spawnArgs,
  };
}

export function serializeSpeculativePreloadState(state: SpeculativePreloadState): UnknownRecord {
  return {
    label: state.label,
    status: state.status,
    createdAt: state.createdAt,
    created_at: state.createdAt,
    updatedAt: state.updatedAt,
    updated_at: state.updatedAt,
    runId: state.runId,
    run_id: state.runId,
    childSessionKey: state.childSessionKey,
    child_session_key: state.childSessionKey,
    error: state.error,
    spawnArgs: state.spawnArgs,
    spawn_args: state.spawnArgs,
  };
}

export function isMatchingSpeculativePreloadSpawn(state: unknown, args: unknown): boolean {
  const speculative = readSpeculativePreloadState(state);
  const record = asRecord(args);
  return Boolean(speculative?.label)
    && speculative?.label === asString(record.label)
    && isSpeculativePreloadSpawnArgs(record);
}

export function buildSpeculativeSessionsSendArgs(input: {
  label: string;
  message: string;
  agentId?: string;
}): SessionsSendArgs {
  return {
    label: input.label,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    message: input.message,
    timeoutSeconds: 0,
  };
}

export function isMatchingSpeculativeSessionsSendArgs(expected: unknown, actual: unknown): boolean {
  const expectedRecord = asRecord(expected);
  const actualRecord = asRecord(actual);
  return asString(expectedRecord.label) === asString(actualRecord.label)
    && asString(expectedRecord.message) === asString(actualRecord.message)
    && Number(expectedRecord.timeoutSeconds) === Number(actualRecord.timeoutSeconds);
}
