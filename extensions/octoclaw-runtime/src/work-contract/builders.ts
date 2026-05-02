import type {
  ContextCoverageSnapshot,
  DelegateContract,
  IntentClass,
  MainContextPacket,
  ReplyContract,
  WorkContract,
  WorkContractStatus,
  WorkContinuity,
  WorkDecisionSeal,
  WorkDecisionSource,
  WorkRoute,
} from "@octoclaw/contracts/work-contract";
import { randomUUID } from "node:crypto";
import { stableId } from "../resolve/env.js";

export interface BuildWorkDecisionSealOptions {
  replyMode?: "answer" | "clarify";
  delegateRole?: "observer" | "default" | "code" | "research" | "review";
  confidence?: number;
  routeSealId?: string;
  judgeTraceRef?: string;
}

export function buildWorkDecisionSeal(
  source: WorkDecisionSource,
  route: WorkRoute,
  reasonCodes: string[],
  options: BuildWorkDecisionSealOptions = {},
): WorkDecisionSeal {
  return {
    source,
    route,
    reasonCodes,
    replyMode: options.replyMode,
    delegateRole: options.delegateRole,
    confidence: options.confidence,
    routeSealId: options.routeSealId,
    judgeTraceRef: options.judgeTraceRef,
    sealedAt: new Date().toISOString(),
  };
}

export interface BuildWorkContractFromPolicyOptions {
  turnId?: string;
  status?: WorkContractStatus;
  reply?: ReplyContract;
  delegate?: DelegateContract;
  decisionOverrides?: Partial<WorkDecisionSeal>;
}

export function buildWorkContractFromPolicy(
  sessionKey: string,
  userAsk: string,
  intentClass: IntentClass,
  coverage: ContextCoverageSnapshot,
  decisionSeal: WorkDecisionSeal,
  options: BuildWorkContractFromPolicyOptions = {},
): WorkContract {
  const now = new Date().toISOString();
  const decision: WorkDecisionSeal = { ...decisionSeal, ...options.decisionOverrides };
  const turnId = options.turnId || stableId("turn", [sessionKey, userAsk, now, randomUUID()]);
  const workContractId = stableId("wc", [
    sessionKey,
    userAsk,
    turnId,
    decision.routeSealId || "",
    decision.sealedAt || now,
  ]);

  const mainContext: MainContextPacket = {
    summary: userAsk.slice(0, 200),
    statusLine: `${decision.route} via ${decision.source}`,
    visibleIds: {
      workContractId,
    },
    artifactRefs: [],
    nextAction: decision.route === "delegate" ? "dispatch" : "answer",
    tokenBudget: {
      maxResumeTokens: 700,
      maxArtifactSummaryTokens: 250,
    },
    forbiddenContent: ["full_transcript", "internal_route_rationale", "delegation_rationale", "contamination_guard_text", "worker_chain_of_thought", "raw_execution_log"],
  };

  const continuity: WorkContinuity = {
    threadBindingKey: stableId("thread", [sessionKey]),
    parentSessionKey: sessionKey,
    continuationMode: decision.route === "delegate" ? "resume_preferred" : "status_only",
  };

  return {
    schemaVersion: "octoclaw.work_contract.v1",
    workContractId,
    turnId,
    sessionKey,
    userAsk,
    intentClass,
    route: decision.route,
    status: options.status || "sealed",
    coverage,
    decision,
    reply: options.reply,
    delegate: options.delegate,
    continuity,
    mainContext,
    telemetry: {
      executionCoverage: coverage.execution.coverage,
      executionSupportsProvenanceReply: coverage.execution.supports_provenance_reply ?? false,
      executionSupportsStatusReply: coverage.execution.supports_status_reply ?? false,
      executionRequiresControlPlaneRefresh: coverage.execution.requires_control_plane_refresh ?? false,
      memoryCoverage: coverage.memory.coverage,
      memoryFreshnessRisk: coverage.memory.freshness_risk,
      authority: coverage.authority,
      decisionSource: decisionSeal.source,
      parentContextTokensAdded: 0,
    },
    createdAt: now,
    updatedAt: now,
  };
}
