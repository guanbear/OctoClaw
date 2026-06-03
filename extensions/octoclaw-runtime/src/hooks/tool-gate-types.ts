import type { PolicyStateEntry } from "../state/policy-state.js";
import type { UnknownRecord } from "../util/type-coercion.js";

export interface ToolGateInput {
  toolName: string;
  toolParams: UnknownRecord;
  event: UnknownRecord;
  ctx: UnknownRecord;
  stateKey: string;
  state: PolicyStateEntry | UnknownRecord | null;
  decision: UnknownRecord;
}

export interface ToolGateReplayEvent {
  event: string;
  payload: UnknownRecord;
  decision?: "current" | "none";
}

export interface ToolGateResultBase {
  statePatch?: UnknownRecord;
  replayEvents?: ToolGateReplayEvent[];
  stop?: boolean;
  params?: UnknownRecord;
}

export interface ToolGateAllowResult extends ToolGateResultBase {
  kind: "allow";
}

export interface ToolGateObserveResult extends ToolGateResultBase {
  kind: "observe";
}

export interface ToolGateBlockResult extends ToolGateResultBase {
  kind: "block";
  block: true;
  blockReason: string;
}

export type ToolGateResult = ToolGateAllowResult | ToolGateObserveResult | ToolGateBlockResult;

export function gateAllow(options: ToolGateResultBase = {}): ToolGateAllowResult {
  return { kind: "allow", ...options };
}

export function gateObserve(options: ToolGateResultBase = {}): ToolGateObserveResult {
  return { kind: "observe", ...options };
}

export function gateBlock(blockReason: string, options: ToolGateResultBase = {}): ToolGateBlockResult {
  return {
    kind: "block",
    block: true,
    blockReason,
    ...options,
  };
}
