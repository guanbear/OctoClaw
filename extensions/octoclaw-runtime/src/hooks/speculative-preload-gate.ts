import {
  isMatchingSpeculativePreloadSpawn,
  readSpeculativePreloadState,
  serializeSpeculativePreloadState,
  type SpeculativePreloadState,
} from "../delegate/speculative-preload.js";
import { stateWorkContractId } from "../extension-entry.js";
import { stringValue } from "../extension-entry-shared.js";
import { asRecord, type UnknownRecord } from "../util/type-coercion.js";
import { gateAllow, gateBlock, gateObserve, type ToolGateResult } from "./tool-gate-types.js";

export type SpeculativePreloadDispatchGateResult = ToolGateResult;

export type SpeculativePreloadSpawnGateResult = ToolGateResult & {
  statePatchesByKey?: Record<string, UnknownRecord>;
};

interface SpeculativeCandidate {
  key: string;
  speculative: SpeculativePreloadState;
  spawnArgs: UnknownRecord;
}

function uniqueStrings(values: unknown[]): string[] {
  return Array.from(new Set(values.map((value) => stringValue(value)).filter(Boolean)));
}

function collectHintedCandidates(input: {
  stateKey: string;
  state: unknown;
  statesByKey: Map<string, unknown>;
  candidateKeys: string[];
  expectedWorkContractId?: string;
}): SpeculativeCandidate[] {
  const candidates: SpeculativeCandidate[] = [];
  const addCandidate = (key: string, candidateState: unknown): void => {
    const candidateKey = stringValue(key);
    if (!candidateKey || candidates.some((candidate) => candidate.key === candidateKey)) return;
    const candidateRecord = asRecord(candidateState);
    if (input.expectedWorkContractId && stateWorkContractId(candidateRecord) !== input.expectedWorkContractId) return;
    const speculative = readSpeculativePreloadState(candidateRecord);
    const spawnArgs = asRecord(speculative?.spawnArgs);
    if (speculative?.status !== "hinted" || Object.keys(spawnArgs).length === 0) return;
    candidates.push({ key: candidateKey, speculative, spawnArgs });
  };

  for (const key of uniqueStrings(input.candidateKeys)) {
    addCandidate(key, input.statesByKey.get(key));
  }
  if (input.stateKey) addCandidate(input.stateKey, input.state);
  if (candidates.length === 0 && input.expectedWorkContractId) {
    for (const [key, state] of input.statesByKey.entries()) addCandidate(key, state);
  }
  return candidates;
}

export function evaluateSpeculativePreloadDispatchGate(input: {
  toolName: string;
  decision: UnknownRecord;
  stateKey: string;
  state: unknown;
  ctx: UnknownRecord;
  statesByKey: Map<string, unknown>;
  candidateKeys?: string[];
  expectedWorkContractId?: string;
}): SpeculativePreloadDispatchGateResult {
  if (input.toolName !== "octoclaw_dispatch") return gateAllow();
  const decisionRoute = stringValue(asRecord(input.decision.route_decision).route);
  if (decisionRoute !== "delegate") return gateAllow();

  const candidates = collectHintedCandidates({
    stateKey: input.stateKey,
    state: input.state,
    statesByKey: input.statesByKey,
    candidateKeys: input.candidateKeys ?? [input.stateKey],
    expectedWorkContractId: input.expectedWorkContractId,
  });
  const deferred = candidates[0];
  if (!deferred) return gateAllow();

  return gateBlock([
    "OctoClaw speculative preload is active for this delegated route.",
    `First call sessions_spawn exactly with these runtime-generated args: ${JSON.stringify(deferred.spawnArgs)}.`,
    "After sessions_spawn returns, call octoclaw_dispatch with the original task.",
    "If sessions_spawn is rejected or unavailable, call octoclaw_dispatch after the failed result so OctoClaw can fall back to new_spawn.",
  ].join(" "), {
    replayEvents: [{
      event: "speculative_preload_dispatch_deferred",
      payload: {
        sessionKey: stringValue(asRecord(input.decision.request).session_key) || deferred.key || input.stateKey || "",
        sessionId: stringValue(input.ctx.sessionId),
        route: decisionRoute,
        toolName: input.toolName,
        label: deferred.speculative.label,
        reason: "standby_spawn_required",
        alias_count: candidates.length,
      },
    }],
  });
}

export function evaluateSpeculativePreloadSpawnGate(input: {
  toolName: string;
  toolParams: UnknownRecord;
  decision: UnknownRecord;
  stateKey: string;
  state: unknown;
  ctx: UnknownRecord;
  statesByKey: Map<string, unknown>;
  sessionKeys: string[];
  now?: number;
}): SpeculativePreloadSpawnGateResult {
  if (input.toolName !== "sessions_spawn") return gateAllow();
  const matches: SpeculativeCandidate[] = [];
  const addMatch = (key: string, candidateState: unknown): void => {
    const candidateKey = stringValue(key);
    if (!candidateKey || matches.some((match) => match.key === candidateKey)) return;
    const candidateRecord = asRecord(candidateState);
    const speculative = readSpeculativePreloadState(candidateRecord);
    if (speculative?.status !== "hinted") return;
    if (!isMatchingSpeculativePreloadSpawn(candidateRecord, input.toolParams)) return;
    matches.push({ key: candidateKey, speculative, spawnArgs: asRecord(speculative.spawnArgs) });
  };

  for (const key of uniqueStrings(input.sessionKeys)) {
    addMatch(key, input.statesByKey.get(key));
  }
  if (input.stateKey) addMatch(input.stateKey, input.state);
  if (matches.length === 0) {
    for (const [key, state] of input.statesByKey.entries()) addMatch(key, state);
  }
  if (matches.length === 0) return gateAllow();

  const now = input.now ?? Date.now();
  const statePatchesByKey: Record<string, UnknownRecord> = {};
  for (const match of matches) {
    const nextSpeculative = serializeSpeculativePreloadState({
      ...match.speculative,
      status: "spawn_call_started",
      updatedAt: now,
    });
    statePatchesByKey[match.key] = {
      speculativePreload: nextSpeculative,
      speculative_preload: nextSpeculative,
      controlToolsSeen: [input.toolName],
    };
  }

  const preferredReplayKeys = new Set(uniqueStrings([
    input.ctx.sessionKey,
    input.ctx.canonicalSessionKey,
    asRecord(input.decision.request).session_key,
    input.stateKey,
  ]));
  const replayMatch = matches.find((match) => preferredReplayKeys.has(match.key)) || matches[0];
  return {
    ...gateObserve({
      replayEvents: [{
        event: "speculative_preload_spawn_allowed",
        payload: {
          sessionKey: stringValue(input.ctx.sessionKey) || stringValue(input.ctx.canonicalSessionKey) || replayMatch.key || input.stateKey || "",
          sessionId: stringValue(input.ctx.sessionId),
          route: stringValue(asRecord(input.decision.route_decision).route),
          toolName: input.toolName,
          label: replayMatch.speculative.label || stringValue(input.toolParams.label),
          alias_count: matches.length,
        },
      }],
    }),
    statePatchesByKey,
  };
}
