import { stableHash, stableId } from "../resolve/env.js";
import { buildPolicyMetadata, isManagedAgentContext, resolvePolicyStateKey } from "../resolve/session.js";
import {
  asBooleanStrict as asBoolean,
  asNumberOptional as asNumber,
  asRecord,
  asString,
  type UnknownRecord,
} from "../util/type-coercion.js";

export const FAST_SPAWN_PLAN_TTL_MS = 60_000;

export interface FastSpawnPlanDraft {
  kind: "native_planner_acceleration";
  status: "draft";
  planId: string;
  stateKey: string;
  sessionKey: string;
  promptHash: string;
  route: "delegate";
  routeSource: string;
  expectedDeliverable: string;
  confidence?: number;
  messageId?: string;
  bindingKey?: string;
  threadKey?: string;
  createdAtMs: number;
  expiresAtMs: number;
  sessionsSpawnArgsDraft: {
    promptHash: string;
    context: "isolated";
    lightContext: true;
  };
}

export interface FastDelegateAdmissionInput {
  prompt: string;
  ctx: UnknownRecord;
  decision: UnknownRecord;
  enabled?: boolean;
  nowMs?: number;
  ttlMs?: number;
  minConfidence?: number;
  activeDuplicate?: boolean;
}

export interface FastDelegateAdmissionResult {
  evaluated: boolean;
  handled: false;
  result: "allowed" | "passed" | "disabled";
  reason: string;
  draft?: FastSpawnPlanDraft;
  replay: UnknownRecord;
}

export interface FastSpawnPlanConsumeInput {
  planId: string;
  stateKey: string;
  promptHash: string;
  nowMs?: number;
}

export type FastSpawnPlanConsumeResult =
  | { ok: true; draft: FastSpawnPlanDraft }
  | { ok: false; reason: "missing" | "expired" | "state_key_mismatch" | "prompt_hash_mismatch" };

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = asString(value);
    if (text) return text;
  }
  return "";
}

function routeDecision(decision: UnknownRecord): UnknownRecord {
  return asRecord(decision.route_decision);
}

function requestMetadata(decision: UnknownRecord): UnknownRecord {
  return asRecord(asRecord(decision.request).metadata);
}

function conversationControl(decision: UnknownRecord): UnknownRecord {
  return asRecord(requestMetadata(decision).conversation_control);
}

export function fastDelegatePromptHash(prompt: string): string {
  return stableHash(prompt);
}

export function expectedDeliverableFromDecision(decision: UnknownRecord): string {
  const route = routeDecision(decision);
  const workContract = asRecord(decision.work_contract);
  const taskContext = asRecord(decision.delegateTaskContext);
  const ticket = asRecord(decision.delegation_ticket_candidate);
  const metadata = requestMetadata(decision);
  return firstString(
    ticket.expected_deliverable,
    decision.expected_deliverable,
    decision.expectedDeliverable,
    route.expected_deliverable,
    route.expectedDeliverable,
    workContract.expected_deliverable,
    workContract.expectedDeliverable,
    taskContext.expected_deliverable,
    taskContext.expectedDeliverable,
    taskContext.task_summary,
    taskContext.summary,
    metadata.expected_deliverable,
    metadata.expectedDeliverable,
  );
}

function routeSourceFromDecision(decision: UnknownRecord): string {
  const route = routeDecision(decision);
  return firstString(
    route.final_judge_source,
    route.route_source,
    decision._judge_source,
    asRecord(asRecord(decision.policy_router).judge).selected,
    "unknown",
  );
}

function confidenceFromDecision(decision: UnknownRecord): number | undefined {
  const route = routeDecision(decision);
  return asNumber(decision.judge_confidence)
    ?? asNumber(route.confidence)
    ?? asNumber(route.judge_confidence)
    ?? asNumber(asRecord(asRecord(decision.policy_router).judge).confidence);
}

function judgeIsUnsafeForFastAdmission(decision: UnknownRecord): boolean {
  const route = routeDecision(decision);
  const shadow = asRecord(decision._judge_shadow_log);
  return asBoolean(decision.judge_schema_degraded)
    || asBoolean(route.judge_schema_degraded)
    || asBoolean(shadow.judge_schema_degraded)
    || asBoolean(route.judge_timeout)
    || asBoolean(decision.judge_timeout)
    || asString(route.final_judge_source).includes("timeout")
    || asString(decision.abstain_reason).length > 0;
}

function isExecutionFollowup(decision: UnknownRecord): boolean {
  const control = conversationControl(decision);
  const ticket = asRecord(decision.delegation_ticket_candidate);
  const intentClass = firstString(
    decision.intent_class,
    control.intent_class,
    asRecord(requestMetadata(decision).intent_packet).intent_class,
  );
  return intentClass === "execution_followup"
    || asBoolean(control.status_followup)
    || asBoolean(control.provenance_followup)
    || ticket.is_new_work === false;
}

function requiresApproval(decision: UnknownRecord): boolean {
  const route = routeDecision(decision);
  const toolPolicy = asRecord(decision.tool_policy);
  return asBoolean(decision.requires_approval)
    || asBoolean(route.requires_approval)
    || asBoolean(toolPolicy.requires_approval)
    || asBoolean(asRecord(decision.admission).requires_approval);
}

function hasActiveDuplicate(input: FastDelegateAdmissionInput): boolean {
  return input.activeDuplicate === true;
}

function admissionAllowsDraft(decision: UnknownRecord): boolean {
  const ticket = asRecord(decision.delegation_ticket_candidate);
  const ticketDecision = asString(ticket.ticket_decision);
  return !ticketDecision || ticketDecision === "ticket_would_issue";
}

export function buildFastSpawnPlanDraft(input: {
  prompt: string;
  ctx: UnknownRecord;
  decision: UnknownRecord;
  nowMs?: number;
  ttlMs?: number;
}): FastSpawnPlanDraft {
  const nowMs = input.nowMs ?? Date.now();
  const ttlMs = input.ttlMs ?? FAST_SPAWN_PLAN_TTL_MS;
  const stateKey = resolvePolicyStateKey(input.ctx);
  const metadata = buildPolicyMetadata(input.ctx, { stateKey });
  const promptHash = fastDelegatePromptHash(input.prompt);
  const expectedDeliverable = expectedDeliverableFromDecision(input.decision);
  const routeSource = routeSourceFromDecision(input.decision);
  const planId = stableId("fast-spawn-plan", [
    stateKey,
    promptHash,
    asString(metadata.turn_id),
    routeSource,
    expectedDeliverable,
  ]);
  const confidence = confidenceFromDecision(input.decision);

  return {
    kind: "native_planner_acceleration",
    status: "draft",
    planId,
    stateKey,
    sessionKey: asString(metadata.session_key || stateKey),
    promptHash,
    route: "delegate",
    routeSource,
    expectedDeliverable,
    ...(confidence !== undefined ? { confidence } : {}),
    messageId: asString(metadata.message_id) || undefined,
    bindingKey: asString(metadata.session_binding_key) || undefined,
    threadKey: asString(metadata.session_thread_key) || undefined,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + ttlMs,
    sessionsSpawnArgsDraft: {
      promptHash,
      context: "isolated",
      lightContext: true,
    },
  };
}

export function evaluateFastDelegateAdmission(input: FastDelegateAdmissionInput): FastDelegateAdmissionResult {
  const decision = input.decision;
  const route = asString(routeDecision(decision).route);
  const confidence = confidenceFromDecision(decision);
  const minConfidence = input.minConfidence ?? 0.75;
  const expectedDeliverable = expectedDeliverableFromDecision(decision);

  const baseReplay = {
    event: "fast_delegate_evaluated",
    route,
    route_source: routeSourceFromDecision(decision),
    confidence: confidence ?? null,
    expected_deliverable_present: Boolean(expectedDeliverable),
  };

  const pass = (reason: string): FastDelegateAdmissionResult => ({
    evaluated: true,
    handled: false,
    result: "passed",
    reason,
    replay: { ...baseReplay, fast_delegate_result: "passed", reason },
  });

  if (input.enabled !== true) {
    return {
      evaluated: false,
      handled: false,
      result: "disabled",
      reason: "disabled",
      replay: { ...baseReplay, fast_delegate_result: "disabled", reason: "disabled" },
    };
  }
  if (!isManagedAgentContext(input.ctx) || !resolvePolicyStateKey(input.ctx)) return pass("unmanaged_context");
  if (route !== "delegate") return pass("route_not_delegate");
  if (judgeIsUnsafeForFastAdmission(decision)) return pass("judge_not_safe");
  if (confidence !== undefined && confidence < minConfidence) return pass("confidence_below_threshold");
  if (!expectedDeliverable) return pass("missing_expected_deliverable");
  if (!admissionAllowsDraft(decision)) return pass("admission_not_allowed");
  if (isExecutionFollowup(decision)) return pass("execution_followup");
  if (requiresApproval(decision)) return pass("requires_approval");
  if (hasActiveDuplicate(input)) return pass("active_duplicate");

  const draft = buildFastSpawnPlanDraft(input);
  return {
    evaluated: true,
    handled: false,
    result: "allowed",
    reason: "high_confidence_delegate",
    draft,
    replay: {
      ...baseReplay,
      fast_delegate_result: "allowed",
      reason: "high_confidence_delegate",
      plan_id: draft.planId,
      prompt_hash: draft.promptHash,
      draft_ttl_ms: draft.expiresAtMs - draft.createdAtMs,
    },
  };
}

export function buildFastDelegatePromptHint(draft: FastSpawnPlanDraft): string {
  return [
    "OctoClaw fast delegate draft is available for this exact inbound turn.",
    `If delegation is still correct, call octoclaw_dispatch with fast=true and spawnPlanId=${draft.planId}.`,
    "Then call native sessions_spawn and octoclaw_dispatch_confirm; do not claim the task started before accepted run evidence exists.",
  ].join(" ");
}

export function createInMemoryFastSpawnPlanDraftStore() {
  const drafts = new Map<string, FastSpawnPlanDraft>();

  return {
    put(draft: FastSpawnPlanDraft): void {
      drafts.set(draft.planId, { ...draft });
    },
    get(planId: string): FastSpawnPlanDraft | null {
      const draft = drafts.get(planId);
      return draft ? { ...draft } : null;
    },
    consume(input: FastSpawnPlanConsumeInput): FastSpawnPlanConsumeResult {
      const draft = drafts.get(input.planId);
      if (!draft) return { ok: false, reason: "missing" };
      const nowMs = input.nowMs ?? Date.now();
      if (nowMs > draft.expiresAtMs) {
        drafts.delete(input.planId);
        return { ok: false, reason: "expired" };
      }
      if (draft.stateKey !== input.stateKey) return { ok: false, reason: "state_key_mismatch" };
      if (draft.promptHash !== input.promptHash) return { ok: false, reason: "prompt_hash_mismatch" };
      drafts.delete(input.planId);
      return { ok: true, draft: { ...draft } };
    },
    size(): number {
      return drafts.size;
    },
  };
}
