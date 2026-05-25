import {
  evaluateNativeSessionsSendGate,
  evaluateNativeSpawnGate,
  type NativeSessionsSendGateDecision,
  type NativeSpawnGateDecision,
} from "../delegate/native-spawn-gate.js";
import { nativeSpawnIntentStore } from "../delegate/native-spawn-intent-store.js";
import { asRecord, type UnknownRecord } from "../util/type-coercion.js";
import { stringValue } from "../extension-entry-shared.js";
import { gateAllow, gateBlock, type ToolGateResult } from "./tool-gate-types.js";

export type NativeSpawnHookGateResult = ToolGateResult & {
  nativeGate?: NativeSpawnGateDecision;
};

export type NativeSessionsSendHookGateResult = ToolGateResult & {
  nativeGate?: NativeSessionsSendGateDecision;
};

export type NativeSessionsYieldHookGateResult = ToolGateResult;

function blockedToolsPatch(toolName: string): UnknownRecord {
  return { blockedTools: [toolName].filter(Boolean) };
}

export function evaluateNativeSpawnHookGate(input: {
  toolName: string;
  sessionKeys: string[];
  args: { task?: string; [key: string]: unknown };
  decision: UnknownRecord;
  stateKey?: string;
  sessionId?: string;
}): NativeSpawnHookGateResult {
  if (input.toolName !== "sessions_spawn") return gateAllow();
  const gate = evaluateNativeSpawnGate({
    sessionKeys: input.sessionKeys,
    args: input.args as { task: string; [key: string]: unknown },
    decision: input.decision,
  });
  if (gate.allowed) return { ...gateAllow(), nativeGate: gate };
  return gateBlock(
    gate.reason === "args_hash_mismatch"
      ? "OctoClaw blocked sessions_spawn because the arguments do not match the pending native spawn intent. Retry sessions_spawn with the exact sessionsSpawnArgs from the most recent octoclaw_dispatch result; do not call octoclaw_dispatch again."
      : "OctoClaw blocked sessions_spawn because no current pending native spawn intent exists. Call octoclaw_dispatch first.",
    {
      statePatch: blockedToolsPatch(input.toolName),
      replayEvents: [{
        event: "sessions_spawn_intent_blocked",
        decision: "none",
        payload: {
          sessionKey: input.stateKey || "",
          sessionId: input.sessionId || "",
          route: stringValue(asRecord(input.decision.route_decision).route),
          toolName: input.toolName,
          reason: gate.reason,
          spawn_intent_id: gate.intent?.spawnIntentId ?? null,
          expected_hash: gate.expectedHash ?? null,
          actual_hash: gate.actualHash ?? null,
        },
      }],
    },
  );
}

export function evaluateNativeSessionsSendHookGate(input: {
  toolName: string;
  sessionKeys: string[];
  args: { task?: string; [key: string]: unknown };
  decision: UnknownRecord;
  stateKey?: string;
  sessionId?: string;
}): NativeSessionsSendHookGateResult {
  if (input.toolName !== "sessions_send") return gateAllow();
  const route = stringValue(asRecord(input.decision.route_decision).route);
  const gate = evaluateNativeSessionsSendGate({
    sessionKeys: input.sessionKeys,
    args: input.args as { task: string; [key: string]: unknown },
    decision: input.decision,
  });
  if (gate.allowed) return { ...gateAllow(), nativeGate: gate };
  return gateBlock(
    gate.reason === "args_hash_mismatch"
      ? "OctoClaw blocked sessions_send because the arguments do not match the pending speculative send intent. Retry sessions_send with the exact sessionsSendArgs from the most recent octoclaw_dispatch result; do not call octoclaw_dispatch again."
      : "OctoClaw blocked sessions_send because no current pending speculative send intent exists. Call octoclaw_dispatch first.",
    {
      statePatch: blockedToolsPatch(input.toolName),
      replayEvents: [{
        event: "sessions_send_intent_blocked",
        payload: {
          sessionKey: input.stateKey || "",
          sessionId: input.sessionId || "",
          route,
          toolName: input.toolName,
          reason: gate.reason,
          spawn_intent_id: gate.intent?.spawnIntentId ?? null,
          expected_hash: gate.expectedHash ?? null,
          actual_hash: gate.actualHash ?? null,
        },
      }],
    },
  );
}

export function evaluateNativeSessionsYieldHookGate(input: {
  toolName: string;
  sessionKeys: string[];
  decision: UnknownRecord;
  stateKey?: string;
  sessionId?: string;
}): NativeSessionsYieldHookGateResult {
  if (input.toolName !== "sessions_yield") return gateAllow();
  let pendingIntent: ReturnType<typeof nativeSpawnIntentStore.findPendingForSession> | null = null;
  for (const key of Array.from(new Set(input.sessionKeys.map((value) => stringValue(value)).filter(Boolean)))) {
    try {
      pendingIntent = nativeSpawnIntentStore.findPendingForSession(key, { dispatchMode: "new_spawn" })
        ?? nativeSpawnIntentStore.findPendingForSession(key, { dispatchMode: "send_to_speculative" });
    } catch {
      pendingIntent = null;
    }
    if (pendingIntent) break;
  }
  if (!pendingIntent) return gateAllow();

  const nextTool = pendingIntent.dispatchMode === "send_to_speculative" ? "sessions_send" : "sessions_spawn";
  return gateBlock([
    "OctoClaw blocked sessions_yield because a native spawn intent is pending but the child session has not started.",
    `Call ${nextTool} exactly with the args from the latest octoclaw_dispatch result before waiting.`,
    "Do not wait for a child that has not started.",
  ].join(" "), {
    statePatch: blockedToolsPatch(input.toolName),
    replayEvents: [{
      event: "sessions_yield_blocked_pending_native_spawn",
      payload: {
        sessionKey: input.stateKey || pendingIntent.sessionKey || "",
        sessionId: input.sessionId || "",
        route: stringValue(asRecord(input.decision.route_decision).route),
        toolName: input.toolName,
        spawn_intent_id: pendingIntent.spawnIntentId,
        work_contract_id: pendingIntent.workContractId,
        dispatch_mode: pendingIntent.dispatchMode || "new_spawn",
      },
    }],
  });
}
