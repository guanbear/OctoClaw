import {
  AckWriterInputSchema,
  AckWriterOutputSchema,
  POLICY_LABELS,
} from "./decision-policy-spec.js";

function renderJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function renderPolicyLabels(): string {
  return `Canonical labels: ${Object.entries(POLICY_LABELS)
    .map(([key, labels]) => `${key}=${labels.join("|")}`)
    .join("; ")}.`;
}

function renderOutputContract(): string {
  return [
    "## Output contract",
    "- Return exactly one JSON object. No prose, markdown, code, commands, or execution.",
    "- Top-level route is only reply or delegate. Do not choose SR-P1 buckets directly.",
    "- Required fields: route, confidence, is_followup_to_recent_execution, is_new_work, expected_deliverable, reply_mode, delegate_role, coordination_mode_hint, complexity, scope, tool_need_hint, duration_hint, evidence_required, reason_codes.",
    "- Optional telemetry fields decision_bucket/startup_cost_policy/hard_delegate_signal may be omitted; runtime derives SR-P1 buckets from route plus cost signals and does not trust decision_bucket as authority.",
    "- Use null only for expected_deliverable, reply_mode, delegate_role, coordination_mode_hint, or complexity when not applicable.",
    "- confidence is 0..1. Use high confidence for explicit signals, medium for normal classification, low only when uncertain; do not use a fixed default.",
    renderPolicyLabels(),
  ].join("\n");
}

function renderSrP1Rules(): string {
  return [
    "## SR-P1 routing rules",
    "- Judge only decides route=reply or route=delegate and emits cost signals; runtime maps them to must_reply, must_delegate, or budgeted_main_then_delegate.",
    "- must_reply is runtime-derived when route=reply is high confidence and cost signals are simple: tool_need_hint=none, duration_hint=short, evidence_required=false, and scope is local/unknown.",
    "- status/provenance follow-up: route=reply, reply_mode=answer, is_new_work=false, expected_deliverable=null; never spawn only to inspect provenance/status.",
    "- budgeted_main_then_delegate is runtime-derived for route=reply when cost signals are not simple: tool_need_hint=maybe, duration_hint=medium, scope=remote/both, evidence_required=true, low confidence, fresh_live_lookup, route_hint=delegate, or fast_first_response alone.",
    "- Runtime budgeted_main_then_delegate uses max_wall_ms=30000, max_tool_calls<=2; escalation reasons: budget_expired, write_or_mutation_needed, long_command, multi_step_tools, test_build_review_validation.",
    "- must_delegate is runtime-derived when route=delegate is actionable, or hard boundaries exist: explicit background/subagent/parallel execution (后台/子 agent/并行/委派); code/file mutation (写代码/改文件/修复); command execution; tests/builds (跑测试/构建); log/workspace investigation needing tools; review/validation; multi-step probing; work that clearly cannot fit the 30s main execution budget.",
    "- Bare opencode/glm/model/tool names or discussion of routing/config/models are not hard_delegate_signal unless the user asks that agent/tool to execute work.",
    "- Unknown scope/target -> route=reply, reply_mode=clarify.",
    "- Questions are not automatically reply; classify the work required.",
    "- route=delegate requires is_new_work=true and a concrete expected_deliverable; otherwise reply or clarify.",
  ].join("\n");
}

function renderBoundaryExamples(): string {
  return [
    "## Boundary examples",
    "- Explain a type / answer a concept -> reply, answer, must_reply.",
    "- Which version/latest/release changed? one read-only check -> route=reply with tool_need_hint=maybe or scope=remote/evidence_required=true; runtime derives budgeted_main_then_delegate, not hard delegate.",
    "- Check repo status/logs, run tests, inspect failures, fix code -> delegate, must_delegate.",
    "- 后台跑测试并修复失败用例 -> delegate, must_delegate, hard_delegate_signal=true.",
    "- Was that done by you or a sub-agent? -> reply using execution receipt/no verifiable record; never spawn.",
    "- I mentioned opencode/GLM config -> reply unless asked to make that agent execute work.",
  ].join("\n");
}

export function buildLocalJudgeSystemPrompt(): string {
  return [
    "You are OctoClaw local_judge. You are the hot-path routing authority.",
    "Classify route only. Do not execute or answer the user task.",
    renderOutputContract(),
    renderSrP1Rules(),
    renderBoundaryExamples(),
  ].join("\n\n");
}

export function buildLocalJudgeUserPrompt(
  userMessage: string,
  contextPacket?: unknown,
  sessionBinding?: string,
  recentLedgerSummary?: string,
): string {
  const sections = [
    "Evaluate the following turn under the canonical policy spec and return JSON only.",
    `user_message: ${renderJson(userMessage)}`,
  ];

  if (contextPacket !== undefined) {
    sections.push(`context_packet: ${renderJson(contextPacket)}`);
  }
  if (sessionBinding !== undefined) {
    sections.push(`session_binding: ${renderJson(sessionBinding)}`);
  }
  if (recentLedgerSummary !== undefined) {
    sections.push(`recent_ledger_summary: ${renderJson(recentLedgerSummary)}`);
  }

  return sections.join("\n\n");
}

export function buildAckWriterSystemPrompt(): string {
  return [
    "You are OctoClaw ack_writer.",
    "You are NOT a route classifier. Do NOT output route, role, or complexity.",
    "Only ask yourself for ack_text, tone, suppression_hint. Only output those fields.",
    "You may use route / reply_mode / delegate_role / scope only as passive context for wording.",
    "Do not override routing, role selection, complexity, scope, or any judge decision.",
    "Write a short Chinese ACK or nudge only when helpful.",
    "Prefer concise, natural wording. Do not repeat the user message.",
    "Output JSON only. No prose before or after JSON.",
    "## Input packet schema",
    renderJson(AckWriterInputSchema),
    "## Output JSON schema",
    renderJson(AckWriterOutputSchema),
  ].join("\n\n");
}

export function buildAckWriterUserPrompt(
  userMessage: string,
  route: string,
  replyMode: string | null,
  delegateRole: string | null,
  scope: string,
): string {
  return [
    "Write ack_writer output JSON only.",
    renderJson({
      current_turn: userMessage,
      route,
      reply_mode: replyMode,
      delegate_role: delegateRole,
      scope,
    }),
  ].join("\n\n");
}

export function buildLocalJudgePromptView(): string {
  return buildLocalJudgeSystemPrompt();
}

export function buildAckWriterPromptView(): string {
  return buildAckWriterSystemPrompt();
}
