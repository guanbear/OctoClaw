import {
  authoritativeDecisionRoute,
  canonicalizeDecisionForPolicyState,
  DELEGATED_ROUTE_NAMES,
  isObserveMode,
} from "../resolve/route-helpers.js";
import { isDelegatedRoute } from "./policy-utils.js";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item ?? "").trim()).filter(Boolean)
    : [];
}



function conversationIntentClass(decision: UnknownRecord): string {
  const request = asRecord(decision.request);
  const metadata = asRecord(request.metadata);
  const intentPacket = asRecord(metadata.intent_packet);
  const conversationControl = asRecord(metadata.conversation_control);
  return String(intentPacket.intent_class ?? conversationControl.intent_class ?? "").trim();
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (isRecord(part) && typeof part.text === "string") {
          return String(part.text);
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (isRecord(content) && typeof content.text === "string") {
    return String(content.text).trim();
  }
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
  return {
    mode: "replace",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "让我先查一下当前任务最新状态。" }],
    },
  };
}


export function stripStaleDelegateFailureProjection(text: string): string {
  return String(text || "")
    .replace(/这次任务还没派发成功，等我拿到真实执行结果后回复。[\n\s]*/gu, "")
    .replace(/这次查询还没拿到结果，等我拿到真实执行结果后回复。[\n\s]*/gu, "")
    .trim();
}

function hasReplyRouteTruth(state: Record<string, unknown>): boolean {
  const latestReceipt = asRecord(state.latestExecutionReceipt ?? state.latest_execution_receipt);
  const receiptRoute = String(latestReceipt.route ?? "").trim();
  if (receiptRoute === "reply") return true;
  const decision = canonicalizeDecisionForPolicyState(asRecord(state.decision));
  return authoritativeDecisionRoute(decision, "reply") === "reply";
}

function hasPreDispatchReplyCorrection(state: Record<string, unknown>): boolean {
  const decision = asRecord(state.decision);
  const requestMetadata = asRecord(asRecord(decision.request).metadata);
  const routeCorrection = asRecord(decision.route_correction ?? requestMetadata.route_correction);
  const dispatchExecuted = state.dispatchExecuted === true || state.dispatch_executed === true;
  const spawnExecuted = state.spawnExecuted === true || state.spawn_executed === true;
  return String(routeCorrection.from ?? "").trim() === "delegate"
    && String(routeCorrection.to ?? "").trim() === "reply"
    && dispatchExecuted !== true
    && spawnExecuted !== true;
}


export function genericGreetingFallbackReply(state: Record<string, unknown>): { mode: string; message: Record<string, unknown> } {
  const decision = asRecord(state.decision);
  const route = String(asRecord(decision.route_decision).route ?? "").trim();
  let text = "收到，我继续按当前任务处理。";
  if (DELEGATED_ROUTE_NAMES.has(route) && !state.delegated && !hasPreDispatchReplyCorrection(state)) {
    return delegationFailureReply(state);
  }
  const taskClass = String(asRecord(decision.route_decision).task_class ?? "").trim();
  if (taskClass === "session_control") {
    text = "收到，这条我按当前会话状态继续处理，不再插入泛泛问候。";
  } else if (taskClass === "control_observer") {
    text = "我在，这条我按当前执行事实继续处理，不再复述无关内容。";
  }
  return { mode: "replace", message: { role: "assistant", content: [{ type: "text", text }] } };
}

export function looksLikeGenericGreeting(text: string): boolean {
  const raw = String(text || "").trim();
  if (!raw) return false;
  return /^(你好[！!。.]?|您好[！!。.]?|嗨[！!。.]?|hello[!.]?|hi[!.]?)(\s*|$)/iu.test(raw)
    || /(有什么需要帮忙的吗|有什么可以帮你的吗|how can i help|what can i help)/iu.test(raw);
}

export function claimedDirectToolNames(text: string): string[] {
  const raw = String(text || "");
  const normalized = raw.toLowerCase();
  const names: string[] = [];
  const add = (name: string) => {
    if (name && !names.includes(name)) names.push(name);
  };
  for (const name of [
    "web_fetch",
    "web_search",
    "web.run",
    "exec",
    "shell",
    "curl",
    "openclaw",
    "github api",
  ]) {
    if (normalized.includes(name)) add(name);
  }
  return names;
}

export function looksLikeToolProvenanceClaim(text: string): boolean {
  const raw = String(text || "");
  if (claimedDirectToolNames(raw).length === 0) return false;
  return /(我|这次|刚才|实际|确实|已经|子任务|runner|主\s*agent).{0,40}(用|用了|调用|跑|执行|查|抓|fetch|拿到|返回)/iu.test(raw)
    || /\b(i|this run|that run|actually|used|called|ran|fetched|queried)\b.{0,50}\b(web_fetch|web_search|web\.run|exec|shell|curl|openclaw|github api)\b/iu.test(raw)
    || /direct tools used.{0,80}(实际|actually|used|web_fetch|web_search|exec|unavailable)/iu.test(raw);
}

function hasStatusProjectionToolEvidence(state: Record<string, unknown>): boolean {
  const seenTools = new Set([
    ...asStringArray(state.controlToolsSeen),
    ...asStringArray(state.directToolsSeen),
  ].map((item) => item.toLowerCase()));
  return seenTools.has("octoclaw_status") || seenTools.has("octoclaw_task_action");
}

function looksLikeTransientProcessingAck(text: string): boolean {
  const raw = String(text || "").trim();
  return raw.length > 0 && raw.length < 30 && (
    /^(收到|好的|好|明白|正在|处理中)(?:[，,。.!！\s]|$)/u.test(raw)
    || /^(ok|okay|working|checking|looking|processing)\b/iu.test(raw)
  );
}

export function ungroundedToolProvenanceReply(
  state: Record<string, unknown>,
  claimedTools: string[],
): { mode: string; message: Record<string, unknown> } {
  const seen = asStringArray(state.directToolsSeen);
  const text = seen.length > 0
    ? `这条回复里有未被执行事实记录覆盖的工具来源声明（${claimedTools.join(", ")}）。目前可确认的 direct tools 只有：${seen.join(", ")}。我不能把未记录的工具说成已经用过。`
    : `这条回复试图声明用了 ${claimedTools.join(", ")}，但当前 execution facts 没有记录到可验证的 direct tool 调用。按事实口径：route=${String(asRecord(asRecord(state.decision).route_decision).route ?? "").trim() || "unknown"}，request_kind=${String(asRecord(asRecord(state.decision).router_decision_v2).request_kind ?? "").trim() || "unknown"}，Direct tools used 目前不可用。我需要重新走受控查询或执行链路，不能凭记忆声称已经查过。`;
  return { mode: "replace", message: { role: "assistant", content: [{ type: "text", text }] } };
}

const DELEGATION_REASONING_PATTERNS: readonly RegExp[] = [
  /(?:先确认一下|先看看|让我先确认|确认一下).{0,30}(派发|委派|delegation|dispatch|边界|boundary)/iu,
  /(?:任务边界|派发边界|委派边界).{0,20}(清楚|清晰|明确)/iu,
  /(?:适合|适合独立|应当).{0,15}(派发|委派|delegate)/iu,
  /(?:这条追问命中了被子任务污染|contaminated.*subagent)/iu,
  /(?:OctoClaw runtime policy is authoritative|Do not hand-write session)/iu,
];

function looksLikeRawSubagentContextLeak(text: string): boolean {
  return /BEGIN_OPENCLAW_INTERNAL_CONTEXT|Internal task completion event|source:\s*subagent|session_key:\s*agent:.*subagent|childTranscript|rawTranscript|workerChainOfThought|subagent session_key|child session transcript/iu.test(text)
    || /(?:我是|作为).{0,12}(?:子\s*agent|subagent|worker)/iu.test(text)
    || /(?:子\s*agent|subagent|worker).{0,20}(?:完整|原始|raw).{0,20}(?:transcript|对话|记录|上下文)/iu.test(text);
}

export function sanitizeDelegationReasoning(text: string): string {
  let result = text;
  for (const pattern of DELEGATION_REASONING_PATTERNS) {
    result = result.replace(pattern, "");
  }
  result = result.replace(/\n{3,}/g, "\n\n").trim();
  if (!result) {
    return "收到，正在处理。";
  }
  return result;
}


function appendExecutionCoverageProjection(replyText: string, state: Record<string, unknown>): string {
  const decision = asRecord(state.decision);
  const workContract = asRecord(decision.work_contract);
  const executionPacket = asRecord(decision._execution_coverage_packet);
  const executionLayer = asRecord(decision.execution_layer ?? decision._execution_coverage);
  const routeDecision = asRecord(decision.route_decision);
  const routerDecision = asRecord(decision.router_decision_v2);
  const requestKind = String(routerDecision.request_kind ?? "").trim();
  const isCoverageAnswer = String(workContract.decisionSource ?? "") === "execution_coverage"
    || String(executionPacket.replyMode ?? workContract.replyMode ?? "") === "answer"
    || decision._execution_supports_provenance_reply === true
    || decision._execution_supports_status_reply === true
    || requestKind === "status_or_provenance";
  if (!isCoverageAnswer || String(routeDecision.route ?? workContract.route ?? "reply") !== "reply") {
    return replyText;
  }
  const route = String(workContract.route ?? routeDecision.route ?? "reply").trim() || "reply";
  const modelPolicy = asRecord(decision.model_policy);
  const runtimeTruth = asRecord(decision.runtime_truth);
  const model = String(
    state.model
    ?? state.modelProfile
    ?? state.model_profile
    ?? modelPolicy.selected_model
    ?? modelPolicy.model
    ?? runtimeTruth.model
    ?? decision.model
    ?? "unknown",
  ).trim() || "unknown";
  const footerDisabled = ["0", "false", "off", "no"].includes(String(process.env.OCTOCLAW_REPLY_PROJECTION_FOOTER ?? "").trim().toLowerCase());
  if (footerDisabled) return replyText;
  if (/route=\w+\s*\|\s*model=/u.test(replyText)) return replyText;
  if (/OctoClaw\s*投影[：:]/iu.test(replyText)) return replyText;
  const workContractId = String(workContract.workContractId ?? workContract.work_contract_id ?? decision.workContractId ?? decision.work_contract_id ?? "").trim();
  const coverage = String(
    asRecord(asRecord(executionPacket.coverage).execution).coverage
    ?? asRecord(executionLayer.execution).coverage
    ?? executionLayer.coverage
    ?? "",
  ).trim();
  const routeSource = String(workContract.decisionSource ?? routeDecision.route_source ?? routeDecision.source ?? "").trim();
  const dispatchExecuted = executionPacket.dispatchExecuted
    ?? executionLayer.dispatchExecuted
    ?? executionLayer.dispatch_executed
    ?? state.dispatchExecuted
    ?? state.dispatch_executed;
  const spawnExecuted = executionPacket.spawnExecuted
    ?? executionLayer.spawnExecuted
    ?? executionLayer.spawn_executed
    ?? state.spawnExecuted
    ?? state.spawn_executed;
  const facts = [
    `route=${route}`,
    `model=${model}`,
    workContractId ? `wc=${workContractId}` : "",
    coverage ? `coverage=${coverage}` : "",
    routeSource ? `route_source=${routeSource}` : "",
    dispatchExecuted !== undefined ? `dispatchExecuted=${Boolean(dispatchExecuted)}` : "",
    spawnExecuted !== undefined ? `spawnExecuted=${Boolean(spawnExecuted)}` : "",
  ].filter(Boolean);
  return `${replyText.trim()}\n\n${facts.join(" | ")} · thread`;
}

export function guardAssistantMessageForPolicyState(
  message: Record<string, unknown>,
  state: Record<string, unknown>,
): { mode: string; message?: Record<string, unknown> } {
  if (assistantMessageRole(message) !== "assistant") {
    return { mode: "pass", message };
  }
  const replyText = assistantMessageText(message);
  if (!replyText) {
    return { mode: "pass", message };
  }
  const dispatchRoute = String(state.dispatchRoute ?? state.dispatch_route ?? "").trim();
  const dispatchExecuted = state.dispatchExecuted === true || state.dispatch_executed === true;
  const spawnExecuted = state.spawnExecuted === true || state.spawn_executed === true;
  const resultMaterialized = state.resultMaterialized === true || state.result_materialized === true;
  const statusProjectionToolSeen = hasStatusProjectionToolEvidence(state);
  const hasExecutionEvidence = dispatchExecuted || spawnExecuted || resultMaterialized;
  const genericGreetingReply = looksLikeGenericGreeting(replyText);
  const correctedToReplyBeforeDispatch = hasPreDispatchReplyCorrection(state);
  if (
    isDelegatedRoute(asRecord(state.decision))
    && !statusProjectionToolSeen
    && !hasExecutionEvidence
    && !(dispatchRoute === "reply" && dispatchExecuted)
    && !looksLikeTransientProcessingAck(replyText)
    && !genericGreetingReply
    && !correctedToReplyBeforeDispatch
  ) {
    const fallback = delegationFailureReply(state);
    return { mode: fallback.mode, message: replaceAssistantMessageText(message, assistantMessageText(fallback.message)) };
  }
  const sessionBoundary = asRecord(state.sessionBoundary);
  if (String(sessionBoundary.status ?? "").trim() === "contaminated_subagent_identity" && looksLikeRawSubagentContextLeak(replyText)) {
    const fallback = contaminationFallbackReply();
    return { mode: fallback.mode, message: replaceAssistantMessageText(message, assistantMessageText(fallback.message)) };
  }
  if (hasReplyRouteTruth(state)) {
    const cleaned = stripStaleDelegateFailureProjection(replyText);
    if (cleaned && cleaned !== replyText) {
      return { mode: "replace", message: replaceAssistantMessageText(message, cleaned) };
    }
  }
  const requestKind = String(asRecord(asRecord(state.decision).router_decision_v2).request_kind ?? "").trim();
  if (genericGreetingReply && requestKind && requestKind !== "chat_or_explain") {
    const fallback = genericGreetingFallbackReply(state);
    return { mode: fallback.mode, message: replaceAssistantMessageText(message, assistantMessageText(fallback.message)) };
  }
  const claimedTools = claimedDirectToolNames(replyText);
  const seenTools = new Set(asStringArray(state.directToolsSeen).map((item) => item.toLowerCase()));
  const ungroundedClaims = claimedTools.filter((item) => !seenTools.has(item.toLowerCase()));
  if (ungroundedClaims.length > 0 && looksLikeToolProvenanceClaim(replyText)) {
    const fallback = ungroundedToolProvenanceReply(state, ungroundedClaims);
    return { mode: fallback.mode, message: replaceAssistantMessageText(message, assistantMessageText(fallback.message)) };
  }
  const sanitized = sanitizeDelegationReasoning(replyText);
  if (sanitized !== replyText) {
    return { mode: "replace", message: replaceAssistantMessageText(message, sanitized) };
  }
  const provenanceProjected = appendExecutionCoverageProjection(replyText, state);
  if (provenanceProjected !== replyText) {
    return { mode: "replace", message: replaceAssistantMessageText(message, provenanceProjected) };
  }
  // Do not infer delegation truth from natural-language prose here. Dispatch/spawn
  // honesty is projected from TurnExecutionReceipt / ExecutionCoveragePacket above.
  // Keep only an internal API leak guard for raw spawn implementation details.
  if (!statusProjectionToolSeen && !hasExecutionEvidence && /sessions_spawn|session_spawn/iu.test(replyText)) {
    return { mode: "replace", message: replaceAssistantMessageText(message, "这次任务还没派发成功，等我拿到真实执行结果后回复。") };
  }
  return { mode: "pass", message };
}
