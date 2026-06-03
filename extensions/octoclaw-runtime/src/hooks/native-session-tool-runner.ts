import {
  buildBudgetedMainState,
  budgetedMainVisibleStartAt,
  type BudgetedMainState,
  readBudgetedMainState,
} from "../budgeted-main.js";
import {
  isPlannerAllowedForSession,
  resolveSpawnBackend,
  resolveSpeculativePreloadEnabled,
} from "../config/index.js";
import type { PolicyStateEntry } from "../state/policy-state.js";
import { asRecord, type UnknownRecord } from "../util/type-coercion.js";
import { stringValue, type LoggerLike } from "../extension-entry-shared.js";
import {
  evaluateNativeSessionsSendHookGate,
  evaluateNativeSessionsYieldHookGate,
  evaluateNativeSpawnHookGate,
} from "./native-spawn-gate-runner.js";
import {
  evaluateSpeculativePreloadSpawnGate,
  type SpeculativePreloadSpawnGateResult,
} from "./speculative-preload-gate.js";
import type { ToolGateResult } from "./tool-gate-types.js";

export type NativeSessionToolRunnerResult =
  | { kind: "allow" }
  | { kind: "handled"; state?: PolicyStateEntry | null; result?: ToolGateResult }
  | { kind: "block"; result: ToolGateResult };

export interface NativeSessionToolRunnerDeps {
  statesByKey: Map<string, unknown>;
  updatePolicyState: (stateKey: string, updater: (current: PolicyStateEntry) => PolicyStateEntry) => void;
  updateBudgetedMainForContext: (input: {
    stateKey: string;
    ctx: UnknownRecord;
    state: UnknownRecord;
    budgetState: BudgetedMainState;
    extra?: UnknownRecord;
  }) => PolicyStateEntry | null;
  recordBudgetedMainEvent: (input: {
    event: string;
    stateKey: string;
    ctx: UnknownRecord;
    state: UnknownRecord;
    decision: UnknownRecord;
    budgetState: BudgetedMainState;
    reason: string;
    logger?: LoggerLike;
    now?: number;
  }) => Promise<void>;
  recordPolicyReplay: (
    event: string,
    payload: UnknownRecord,
    logger: unknown,
    decision?: UnknownRecord,
  ) => Promise<void>;
  applySpeculativeStatePatches?: (input: {
    result: SpeculativePreloadSpawnGateResult;
    toolName: string;
  }) => void;
  now: () => number;
}

function sessionKeysForNativeTool(input: {
  stateKey: string;
  ctx: UnknownRecord;
  decision: UnknownRecord;
  resolvePolicyStateKeys: (ctx: UnknownRecord) => string[];
}): string[] {
  return [
    input.stateKey,
    stringValue(input.ctx.sessionKey),
    stringValue(input.ctx.canonicalSessionKey),
    stringValue(asRecord(input.decision.request).session_key),
    ...input.resolvePolicyStateKeys(input.ctx),
  ];
}

function plannerGateEnabled(sessionKeys: string[]): boolean {
  return resolveSpawnBackend() === "planner"
    && sessionKeys.some((sessionKey) => isPlannerAllowedForSession(sessionKey));
}

function patchSpawnCallStarted(input: {
  stateKey: string;
  toolName: string;
  spawnIntentId: string;
  workContractId: string;
  updatePolicyState: NativeSessionToolRunnerDeps["updatePolicyState"];
}): void {
  input.updatePolicyState(input.stateKey, (current) => ({
    ...current,
    delegated: false,
    spawnIntentId: input.spawnIntentId,
    workContractId: input.workContractId,
    dispatchStatus: "spawn_call_started",
    controlToolsSeen: Array.from(new Set([...(Array.isArray(current.controlToolsSeen) ? current.controlToolsSeen : []), input.toolName])),
  }));
}

function recordGateReplay(input: {
  result: ToolGateResult;
  logger: unknown;
  decision: UnknownRecord;
  recordPolicyReplay: NativeSessionToolRunnerDeps["recordPolicyReplay"];
}): void {
  for (const replayEvent of input.result.replayEvents ?? []) {
    void input.recordPolicyReplay(
      replayEvent.event,
      replayEvent.payload,
      input.logger,
      replayEvent.decision === "none" ? undefined : input.decision,
    ).catch(() => {});
  }
}

async function recordBudgetEscalationForSpawn(input: {
  stateKey: string;
  ctx: UnknownRecord;
  state: UnknownRecord;
  decision: UnknownRecord;
  workContractId: string;
  spawnIntentId: string;
  logger?: LoggerLike;
  deps: NativeSessionToolRunnerDeps;
}): Promise<void> {
  const decisionBucket = stringValue(asRecord(input.decision.route_decision).decision_bucket
    || input.decision._decision_bucket
    || asRecord(asRecord(input.decision.route_decision).startup_cost_policy).decision_bucket);
  if (decisionBucket !== "budgeted_main_then_delegate") return;

  const now = input.deps.now();
  const liveBudget = readBudgetedMainState(input.state);
  if (liveBudget?.escalatedAt) return;

  const startedBudget = liveBudget ?? buildBudgetedMainState({
    now,
    decision: input.decision,
    visibleStartAt: budgetedMainVisibleStartAt(input.state, now),
    budgetStartSource: "sessions_spawn_gate_fallback",
    workContractId: input.workContractId,
    spawnIntentId: input.spawnIntentId,
  });
  const reason = liveBudget?.escalatedPending || now - startedBudget.startedAt >= startedBudget.maxWallMs
    ? "wall_time_over_budget"
    : "main_agent_called_dispatch";
  const escalatedBudget = {
    ...startedBudget,
    active: false,
    escalatedAt: now,
    escalatedPending: false,
    reason,
    workContractId: input.workContractId,
    spawnIntentId: input.spawnIntentId,
  };
  input.deps.updateBudgetedMainForContext({
    stateKey: input.stateKey,
    ctx: input.ctx,
    state: input.state,
    budgetState: escalatedBudget,
    extra: {
      budgeted_main_escalated: true,
      budgeted_main_escalated_at: new Date(now).toISOString(),
    },
  });
  await input.deps.recordBudgetedMainEvent({
    event: "budgeted_main_escalated",
    stateKey: input.stateKey,
    ctx: input.ctx,
    state: input.state,
    decision: input.decision,
    budgetState: escalatedBudget,
    reason,
    logger: input.logger,
    now,
  }).catch(() => {});
}

export async function runNativeSessionToolGate(input: {
  toolName: string;
  toolParams: UnknownRecord;
  decision: UnknownRecord;
  state: PolicyStateEntry | null | undefined;
  stateKey: string;
  ctx: UnknownRecord;
  currentPluginConfig: UnknownRecord;
  logger?: LoggerLike;
  resolvePolicyStateKeys?: (ctx: UnknownRecord) => string[];
}, deps: NativeSessionToolRunnerDeps): Promise<NativeSessionToolRunnerResult> {
  const resolvePolicyStateKeys = input.resolvePolicyStateKeys ?? (() => []);
  const sessionKeys = sessionKeysForNativeTool({
    stateKey: input.stateKey,
    ctx: input.ctx,
    decision: input.decision,
    resolvePolicyStateKeys,
  });
  const gateEnabled = plannerGateEnabled(sessionKeys);
  if (!gateEnabled) return { kind: "allow" };

  if (input.toolName === "sessions_spawn") {
    if (resolveSpeculativePreloadEnabled(input.currentPluginConfig)) {
      const speculativeSpawnGate = evaluateSpeculativePreloadSpawnGate({
        toolName: input.toolName,
        toolParams: input.toolParams,
        decision: input.decision,
        stateKey: input.stateKey,
        state: input.state,
        ctx: input.ctx,
        statesByKey: deps.statesByKey,
        sessionKeys,
      });
      if (speculativeSpawnGate.kind !== "allow") {
        deps.applySpeculativeStatePatches?.({ result: speculativeSpawnGate, toolName: input.toolName });
        recordGateReplay({
          result: speculativeSpawnGate,
          logger: input.logger,
          decision: input.decision,
          recordPolicyReplay: deps.recordPolicyReplay,
        });
        return { kind: "handled" };
      }
    }

    const spawnHookGate = evaluateNativeSpawnHookGate({
      toolName: input.toolName,
      sessionKeys,
      args: input.toolParams as { task: string; [key: string]: unknown },
      decision: input.decision,
      stateKey: input.stateKey,
      sessionId: stringValue(input.ctx.sessionId),
    });
    if (spawnHookGate.kind === "block") return { kind: "block", result: spawnHookGate };
    const gate = spawnHookGate.nativeGate;
    if (!gate?.allowed) return { kind: "handled" };

    patchSpawnCallStarted({
      stateKey: input.stateKey,
      toolName: input.toolName,
      spawnIntentId: gate.intent.spawnIntentId,
      workContractId: gate.intent.workContractId,
      updatePolicyState: deps.updatePolicyState,
    });
    await recordBudgetEscalationForSpawn({
      stateKey: input.stateKey || gate.intent.sessionKey,
      ctx: input.ctx,
      state: asRecord(input.state),
      decision: input.decision,
      workContractId: gate.intent.workContractId,
      spawnIntentId: gate.intent.spawnIntentId,
      logger: input.logger,
      deps,
    });
    const decisionBucket = stringValue(asRecord(input.decision.route_decision).decision_bucket
      || input.decision._decision_bucket
      || asRecord(asRecord(input.decision.route_decision).startup_cost_policy).decision_bucket);
    void deps.recordPolicyReplay("sessions_spawn_intent_allowed", {
      sessionKey: input.stateKey || gate.intent.sessionKey,
      sessionId: stringValue(input.ctx.sessionId),
      route: stringValue(asRecord(input.decision.route_decision).route),
      decision_bucket: decisionBucket,
      decisionBucket,
      toolName: input.toolName,
      spawn_intent_id: gate.intent.spawnIntentId,
      work_contract_id: gate.intent.workContractId,
    }, input.logger).catch(() => {});
    return { kind: "handled", result: spawnHookGate };
  }

  if (input.toolName === "sessions_yield") {
    const yieldHookGate = evaluateNativeSessionsYieldHookGate({
      toolName: input.toolName,
      sessionKeys,
      decision: input.decision,
      stateKey: input.stateKey,
      sessionId: stringValue(input.ctx.sessionId),
    });
    if (yieldHookGate.kind === "block") return { kind: "block", result: yieldHookGate };
    return { kind: "allow" };
  }

  if (input.toolName === "sessions_send") {
    const route = stringValue(asRecord(input.decision.route_decision).route);
    if (route !== "delegate") return { kind: "allow" };
    const sendHookGate = evaluateNativeSessionsSendHookGate({
      toolName: input.toolName,
      sessionKeys,
      args: input.toolParams as { task: string; [key: string]: unknown },
      decision: input.decision,
      stateKey: input.stateKey,
      sessionId: stringValue(input.ctx.sessionId),
    });
    if (sendHookGate.kind === "block") return { kind: "block", result: sendHookGate };
    const gate = sendHookGate.nativeGate;
    if (!gate?.allowed) return { kind: "handled" };

    patchSpawnCallStarted({
      stateKey: input.stateKey,
      toolName: input.toolName,
      spawnIntentId: gate.intent.spawnIntentId,
      workContractId: gate.intent.workContractId,
      updatePolicyState: deps.updatePolicyState,
    });
    void deps.recordPolicyReplay("sessions_send_intent_allowed", {
      sessionKey: input.stateKey || gate.intent.sessionKey,
      sessionId: stringValue(input.ctx.sessionId),
      route,
      decision_bucket: stringValue(asRecord(input.decision.route_decision).decision_bucket),
      toolName: input.toolName,
      spawn_intent_id: gate.intent.spawnIntentId,
      work_contract_id: gate.intent.workContractId,
      dispatch_mode: gate.intent.dispatchMode || "send_to_speculative",
      speculative_session_label: gate.intent.speculativeSessionLabel || "",
    }, input.logger).catch(() => {});
    return { kind: "handled", result: sendHookGate };
  }

  return { kind: "allow" };
}
