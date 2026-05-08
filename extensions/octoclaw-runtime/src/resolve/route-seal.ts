import {
  ROUTE_SEAL_SCHEMA_VERSION,
  type LiveRoute,
  type RouteSeal,
  type RouteSealSource,
} from "@octoclaw/contracts/route-seal";
import { isRecord, asString, asNumberOptional } from "../util/type-coercion.js";

type UnknownRecord = Record<string, unknown>;

export interface ResolveCurrentRouteSealInput {
  requestId: string;
  turnId: string;
  threadBindingKey: string;
  policyJson?: UnknownRecord;
  localJudgeOutput?: UnknownRecord;
  savedRouteSeal?: RouteSeal | null;
  inputHash?: string;
  stateGeneration?: number;
  now?: Date;
}

function canonicalLiveRoute(raw: unknown): LiveRoute | null {
  const normalized = asString(raw);
  return normalized === "reply" || normalized === "delegate" ? normalized : null;
}

function routeSealSource(raw: unknown): RouteSealSource {
  const normalized = asString(raw);
  if (
    normalized === "local_judge"
    || normalized === "accepted_objection"
    || normalized === "explicit_current_policy"
    || normalized === "safe_fallback"
  ) {
    return normalized;
  }
  return "explicit_current_policy";
}

function reasonCodesFrom(value: unknown, fallback: string): string[] {
  if (!Array.isArray(value)) {
    return [fallback];
  }

  const reasonCodes = value
    .map((item) => asString(item))
    .filter((item) => item.length > 0);
  return reasonCodes.length > 0 ? reasonCodes : [fallback];
}

function createRouteSeal(input: ResolveCurrentRouteSealInput, route: LiveRoute, source: RouteSealSource, sourceRecord: UnknownRecord): RouteSeal {
  const routeDecision = isRecord(sourceRecord.route_decision) ? sourceRecord.route_decision : {};
  const confidence = asNumberOptional(sourceRecord.confidence) ?? asNumberOptional(routeDecision.confidence);
  const reasonCodes = reasonCodesFrom(sourceRecord.reasonCodes ?? sourceRecord.reason_codes ?? routeDecision.reasonCodes ?? routeDecision.reason_codes, source);

  return {
    schemaVersion: ROUTE_SEAL_SCHEMA_VERSION,
    requestId: input.requestId,
    turnId: input.turnId,
    threadBindingKey: input.threadBindingKey,
    route,
    source,
    ...(confidence === undefined ? {} : { confidence }),
    reasonCodes,
    createdAt: (input.now ?? new Date()).toISOString(),
    inputHash: input.inputHash ?? "",
    stateGeneration: input.stateGeneration ?? 0,
  };
}

export function normalizeToLiveRoute(raw: string): LiveRoute | null {
  const normalized = raw.trim();
  if (normalized === "direct") return "reply";
  if (normalized === "runner" || normalized === "spawn_single" || normalized === "spawn_multi" || normalized === "observe") {
    return "delegate";
  }
  return canonicalLiveRoute(normalized);
}

export function validateRouteSeal(seal: RouteSeal, turnId: string, threadBindingKey: string): boolean {
  const createdAtTime = Date.parse(seal.createdAt);
  return seal.turnId === turnId
    && seal.threadBindingKey === threadBindingKey
    && seal.schemaVersion === ROUTE_SEAL_SCHEMA_VERSION
    && Number.isFinite(createdAtTime)
    && (seal.route === "reply" || seal.route === "delegate");
}

export function resolveCurrentRouteSeal(input: ResolveCurrentRouteSealInput): RouteSeal {
  const policyJson = input.policyJson ?? {};
  const policyRouteSeal = policyJson.routeSeal;
  if (isRecord(policyRouteSeal)) {
    const candidateRoute = normalizeToLiveRoute(asString(policyRouteSeal.route));
    if (candidateRoute !== null) {
      const candidate: RouteSeal = {
        schemaVersion: ROUTE_SEAL_SCHEMA_VERSION,
        requestId: asString(policyRouteSeal.requestId),
        turnId: asString(policyRouteSeal.turnId),
        threadBindingKey: asString(policyRouteSeal.threadBindingKey),
        route: candidateRoute,
        source: routeSealSource(policyRouteSeal.source),
        reasonCodes: reasonCodesFrom(policyRouteSeal.reasonCodes, "explicit_current_policy"),
        createdAt: asString(policyRouteSeal.createdAt),
        inputHash: asString(policyRouteSeal.inputHash),
        stateGeneration: asNumberOptional(policyRouteSeal.stateGeneration) ?? 0,
        ...(candidateRoute === "reply" && (policyRouteSeal.replyMode === "answer" || policyRouteSeal.replyMode === "clarify")
          ? { replyMode: policyRouteSeal.replyMode }
          : {}),
        ...(asNumberOptional(policyRouteSeal.confidence) === undefined ? {} : { confidence: asNumberOptional(policyRouteSeal.confidence) }),
      };
      if (validateRouteSeal(candidate, input.turnId, input.threadBindingKey)) {
        return candidate;
      }
    }
  }

  const explicitRoute = normalizeToLiveRoute(asString(policyJson.requested_route)) ?? normalizeToLiveRoute(asString(policyJson.forceRoute));
  if (explicitRoute) {
    return createRouteSeal(input, explicitRoute, "explicit_current_policy", policyJson);
  }

  const localJudge = input.localJudgeOutput ?? (isRecord(policyJson.local_judge) ? policyJson.local_judge : {});
  const routeDecision = isRecord(policyJson.route_decision) ? policyJson.route_decision : {};
  const judgeRoute = normalizeToLiveRoute(asString(localJudge.route)) ?? normalizeToLiveRoute(asString(routeDecision.route));
  if (judgeRoute) {
    return createRouteSeal(input, judgeRoute, "local_judge", Object.keys(localJudge).length > 0 ? localJudge : routeDecision);
  }

  if (input.savedRouteSeal && validateRouteSeal(input.savedRouteSeal, input.turnId, input.threadBindingKey)) {
    return input.savedRouteSeal;
  }

  return createRouteSeal(input, "reply", "safe_fallback", {});
}
