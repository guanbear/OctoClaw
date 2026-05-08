import {
  authoritativeDecisionRoute,
  canonicalizeDecisionForPolicyState,
  isObserveMode,
} from "../resolve/route-helpers.js";
import { type UnknownRecord, isRecord, asRecord, asStringArray } from "../util/type-coercion.js";
import { isDelegatedRoute } from "./policy-utils.js";

function conversationIntentClass(decision: UnknownRecord): string {
  const request = asRecord(decision.request);
  const metadata = asRecord(request.metadata);
  const intentPacket = asRecord(metadata.intent_packet);
  const conversationControl = asRecord(metadata.conversation_control);
  return String(intentPacket.intent_class ?? conversationControl.intent_class ?? "").trim();
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (isRecord(part) && typeof part.text === "string") return String(part.text);
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (isRecord(content) && typeof content.text === "string") return String(content.text).trim();
  return "";
}

export function assistantMessageRole(message: Record<string, unknown>): string {
  return String(message.role ?? "").trim().toLowerCase();
}

export function assistantMessageText(message: Record<string, unknown>): string {
  return extractMessageText(message.content);
}

export function replaceAssistantMessageText(message: Record<string, unknown>, text: string): Record<string, unknown> {
  const next = isRecord(message) ? { ...message } : {};
  if (typeof next.content === "string") {
    next.content = text;
    return next;
  }
  if (Array.isArray(next.content)) {
    next.content = [{ type: "text", text }];
    return next;
  }
  if (isRecord(next.content)) {
    next.content = { ...next.content, text };
    return next;
  }
  next.content = [{ type: "text", text }];
  return next;
}

export function delegationFailureReply(state: Record<string, unknown>): { mode: string; message: Record<string, unknown> } {
  const decision = canonicalizeDecisionForPolicyState(asRecord(state.decision));
  const route = authoritativeDecisionRoute(decision, "reply");
  const intentClass = String(state.conversationIntentClass ?? conversationIntentClass(decision) ?? "").trim();
  const observe = route === "delegate" && isObserveMode(
    String(asRecord(decision.route_decision).judge_role ?? asRecord(decision).role ?? "").trim(),
    String(asRecord(decision).executionProfile ?? "").trim(),
  );
  const text = observe && ["fresh_live_lookup", "local_surface_lookup"].includes(intentClass)
    ? "这次查询还没拿到结果，等我拿到真实执行结果后回复。"
    : "这次任务还没派发成功，等我拿到真实执行结果后回复。";
  return { mode: "replace", message: { role: "assistant", content: [{ type: "text", text }] } };
}

export function contaminationFallbackReply(): { mode: string; message: Record<string, unknown> } {
  return { mode: "replace", message: { role: "assistant", content: [{ type: "text", text: "让我先查一下当前任务最新状态。" }] } };
}

export function silentDelegatePendingReply(): { mode: string; message: Record<string, unknown> } {
  return { mode: "replace", message: { role: "assistant", content: [{ type: "text", text: "NO_REPLY" }] } };
}

export function stripStaleDelegateFailureProjection(text: string): string {
  return String(text || "");
}

function hasReplyRouteTruth(state: Record<string, unknown>): boolean {
  const latestReceipt = asRecord(state.latestExecutionReceipt ?? state.latest_execution_receipt);
  const receiptRoute = String(latestReceipt.route ?? "").trim();
  if (receiptRoute === "reply") return true;
  const decision = canonicalizeDecisionForPolicyState(asRecord(state.decision));
  return authoritativeDecisionRoute(decision, "reply") === "reply";
}

function hasStatusProjectionToolEvidence(state: Record<string, unknown>): boolean {
  const seenTools = new Set([
    ...asStringArray(state.controlToolsSeen),
    ...asStringArray(state.directToolsSeen),
  ].map((item) => item.toLowerCase()));
  return seenTools.has("octoclaw_status") || seenTools.has("octoclaw_task_action");
}

export function genericGreetingFallbackReply(state: Record<string, unknown>): { mode: string; message: Record<string, unknown> } {
  void state;
  return { mode: "pass", message: { role: "assistant", content: [{ type: "text", text: "" }] } };
}

export function looksLikeGenericGreeting(text: string): boolean {
  void text;
  return false;
}

export function claimedDirectToolNames(text: string): string[] {
  void text;
  return [];
}

export function looksLikeToolProvenanceClaim(text: string): boolean {
  void text;
  return false;
}

export function ungroundedToolProvenanceReply(
  state: Record<string, unknown>,
  claimedTools: string[],
): { mode: string; message: Record<string, unknown> } {
  void state;
  void claimedTools;
  return { mode: "pass", message: { role: "assistant", content: [{ type: "text", text: "" }] } };
}

export function sanitizeDelegationReasoning(text: string): string {
  return String(text || "");
}

export function guardAssistantMessageForPolicyState(
  message: Record<string, unknown>,
  state: Record<string, unknown>,
): { mode: string; message?: Record<string, unknown> } {
  if (assistantMessageRole(message) !== "assistant") return { mode: "pass", message };
  const replyText = assistantMessageText(message);
  if (!replyText) return { mode: "pass", message };

  const dispatchRoute = String(state.dispatchRoute ?? state.dispatch_route ?? "").trim();
  const dispatchExecuted = state.dispatchExecuted === true || state.dispatch_executed === true;
  const spawnExecuted = state.spawnExecuted === true || state.spawn_executed === true;
  const resultMaterialized = state.resultMaterialized === true || state.result_materialized === true;
  const statusProjectionToolSeen = hasStatusProjectionToolEvidence(state);
  const delegatedRoute = isDelegatedRoute(asRecord(state.decision));
  const replyRouteTruth = hasReplyRouteTruth(state);
  const explicitReplyExecution = dispatchRoute === "reply" && dispatchExecuted;

  if (
    delegatedRoute
    && !replyRouteTruth
    && dispatchExecuted
    && spawnExecuted
    && !resultMaterialized
    && !statusProjectionToolSeen
    && !explicitReplyExecution
  ) {
    const fallback = silentDelegatePendingReply();
    return { mode: fallback.mode, message: replaceAssistantMessageText(message, assistantMessageText(fallback.message)) };
  }

  return { mode: "pass", message };
}
