import {
  buildIntentPacket,
  buildTaskIndex,
  buildTurnFacts,
  conversationControlFromIntentPacket,
  detectOperatorSurface,
  groupedReplayTurns,
  isFreshLiveLookupPrompt,
  isMetaPrompt,
  isProvenancePrompt,
  isTaskProgressPrompt,
  readJsonl,
  selectSubjectTurn,
} from "./policy/intent.js";

export function buildConversationIntentPacket(options = {}) {
  return buildIntentPacket(options);
}

export function buildConversationControlHints(options = {}) {
  const intentPacket = buildConversationIntentPacket(options);
  return conversationControlFromIntentPacket(intentPacket);
}

export function buildConversationControlHintsFromIntent(intentPacket = {}) {
  return conversationControlFromIntentPacket(intentPacket);
}

function noGrounding(reason = "no_recent_subject_turn") {
  return {
    available: false,
    reason,
    context: [
      "[OctoClaw grounded follow-up]",
      "No reliable execution facts were recovered for this follow-up.",
      "Do not answer from memory. Use octoclaw_status / octoclaw_task_action to refresh facts first, or state that the fact is unavailable.",
    ].join("\n"),
  };
}

export function buildConversationGrounding({
  prompt = "",
  replayLogPath = "",
  taskStatePath = "",
  sessionKeys = [],
} = {}) {
  const turns = groupedReplayTurns(readJsonl(replayLogPath));
  const taskIndex = buildTaskIndex(taskStatePath);
  const enrichedTurns = turns.map((turn) => ({ ...turn, facts: buildTurnFacts(turn, taskIndex) }));
  const subjectTurn = selectSubjectTurn(enrichedTurns, prompt, sessionKeys);
  if (!subjectTurn) return noGrounding("no_recent_subject_turn");

  const facts = subjectTurn.facts || {};
  const lines = [
    "[OctoClaw grounded follow-up]",
    "Answer only from these execution facts. Do not guess from memory.",
    `- Subject prompt: ${String(subjectTurn.prompt || "").trim() || "(unknown)"}`,
    `- Route decision: ${String(subjectTurn.route || "").trim() || "(unknown)"}`,
  ];

  if (subjectTurn.taskClass) lines.push(`- Task class: ${subjectTurn.taskClass}`);
  if (subjectTurn.protectedLane) lines.push(`- Protected lane: ${subjectTurn.protectedLane}`);
  lines.push(`- Dispatch called: ${facts.dispatchSeen ? "yes" : "no"}`);
  lines.push(`- Dispatch executed: ${facts.dispatchExecuted ? "yes" : "no"}`);
  lines.push(`- Delegated: ${facts.delegated ? "yes" : "no"}`);

  if (facts.delegationTool) lines.push(`- Delegation tool: ${facts.delegationTool}`);
  if (facts.materializationStatus) {
    lines.push(`- Materialization: ${facts.executionKind || "delegated"} · ${facts.materializationStatus}`);
  }
  if ((facts.directTools || []).length > 0) {
    lines.push(`- Direct tools used: ${facts.directTools.join(", ")}`);
  } else if (isProvenancePrompt(prompt)) {
    lines.push("- Direct tools used: unavailable in main session");
  }
  if (facts.runnerPlanKind) lines.push(`- Delegated workflow: ${facts.runnerPlanKind}`);
  if (facts.runnerPlanSummary) lines.push(`- Delegated workflow summary: ${facts.runnerPlanSummary}`);
  if (facts.delegatedProbeKind) lines.push(`- Delegated probe: ${facts.delegatedProbeKind}`);
  if (facts.delegatedProbeSource) lines.push(`- Delegated evidence source: ${facts.delegatedProbeSource}`);
  if (facts.delegatedProbeProject) lines.push(`- Delegated lookup project: ${facts.delegatedProbeProject}`);
  if (facts.delegatedProbeFocus) lines.push(`- Delegated lookup focus: ${facts.delegatedProbeFocus}`);
  if (facts.runnerJobId) lines.push(`- Runner job id: ${facts.runnerJobId}`);
  if (facts.taskRecordId && !facts.taskId) lines.push(`- Task record id: ${facts.taskRecordId}`);
  if (facts.taskId) lines.push(`- Task id: ${facts.taskId}`);
  if (facts.currentTaskStatus) lines.push(`- Current task status: ${facts.currentTaskStatus}`);
  if (facts.currentTaskSummary) lines.push(`- Current task summary: ${facts.currentTaskSummary}`);
  if (facts.capabilityFailure && Object.keys(facts.capabilityFailure).length > 0) {
    lines.push(`- Capability failure: ${String(facts.capabilityFailure.reason || facts.capabilityFailure.code || "unknown").trim()}`);
  }
  lines.push("If the user asks how it was checked, only mention tools listed above. If the fact is unavailable, say so plainly.");

  return {
    available: true,
    subjectPrompt: String(subjectTurn.prompt || "").trim(),
    route: String(subjectTurn.route || "").trim(),
    taskClass: String(subjectTurn.taskClass || "").trim(),
    protectedLane: String(subjectTurn.protectedLane || "").trim(),
    facts,
    context: lines.join("\n"),
  };
}

export function buildDirectLookupGuard(decision = {}) {
  const intentClass = String(decision?.request?.metadata?.intent_packet?.intent_class || "").trim();
  const evidenceRequired = Array.isArray(decision?.router_decision_v2?.evidence_required)
    ? decision.router_decision_v2.evidence_required
    : [];
  const guardedIntent = ["fresh_live_lookup", "local_surface_lookup"].includes(intentClass)
    || evidenceRequired.some((item) => ["web_lookup", "local_probe", "remote_probe"].includes(String(item || "").trim()));
  if (!decision?.latency_ack?.required && !guardedIntent) return "";
  return [
    "[OctoClaw live lookup guard]",
    "This is a bounded live lookup. Do not answer from memory.",
    "Use the execution lane selected by the policy, and only report facts backed by the task/provenance ledger.",
  ].join("\n");
}

export const __conversationControlTest = {
  groupedReplayTurns,
  buildConversationIntentPacket,
  buildConversationControlHintsFromIntent,
  buildConversationGrounding,
  buildConversationControlHints,
  isMetaPrompt,
  isTaskProgressPrompt,
  isProvenancePrompt,
  isFreshLiveLookupPrompt,
  detectOperatorSurface,
};
