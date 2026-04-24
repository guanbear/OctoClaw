import type { CanonicalRoute, ContractEnvelope } from "./schemas.js";
import type { CoordinationMode } from "./delegate.js";

export const ROUTE_SEAL_SCHEMA_VERSION = "octoclaw.route_seal.v1" as const;

export type LiveRoute = Extract<CanonicalRoute, "reply" | "delegate">;
export type RouteSealSource =
  | "local_judge"
  | "accepted_objection"
  | "explicit_current_policy"
  | "safe_fallback";

export interface RouteSeal extends Omit<ContractEnvelope, "schemaVersion" | "kind"> {
  schemaVersion: typeof ROUTE_SEAL_SCHEMA_VERSION;
  requestId: string;
  turnId: string;
  threadBindingKey: string;
  route: LiveRoute;
  replyMode?: "answer" | "clarify";
  delegateRole?: "observer" | "default" | "code" | "research" | "review";
  coordinationMode?: CoordinationMode;
  source: RouteSealSource;
  confidence?: number;
  reasonCodes: string[];
  createdAt: string;
  inputHash: string;
  stateGeneration: number;
}
