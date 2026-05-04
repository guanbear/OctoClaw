import {
  AckWriterInputSchema,
  AckWriterOutputSchema,
  JudgeOutputSchema,
  POLICY_LABELS,
} from "./decision-policy-spec.js";

function renderJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function renderPolicyLabels(): string {
  return [
    "labels:",
    ...Object.entries(POLICY_LABELS).map(([key, labels]) => `- ${key}: ${labels.map((label) => `\"${label}\"`).join(" | ")}`),
  ].join("\n");
}

function renderOutputContract(): string {
  return [
    "## Output contract",
    "- Return exactly one JSON object. No prose, markdown, code, commands, or execution.",
    "- Top-level route is only reply or delegate.",
    "- Required fields: route, confidence, is_followup_to_recent_execution, is_new_work, expected_deliverable, reply_mode, delegate_role, coordination_mode_hint, complexity, scope, tool_need_hint, duration_hint, decision_bucket, startup_cost_policy, hard_delegate_signal, reason_codes.",
    "- Use only canonical labels below. Put null only where the schema allows it.",
    "- confidence is a number from 0 to 1. Use high confidence for explicit signals, medium for normal classification, low only when uncertain; do not use a fixed default and do not set 0 for a valid classification.",
    renderPolicyLabels(),
  ].join("\n");
}

function renderSrP1Rules(): string {
  return [
    "## SR-P1 routing rules",
    "- must_reply: direct answer/clarification; no new execution unit; no fresh tools beyond existing execution receipt.",
    "- status/provenance follow-up: if execution.supports_provenance_reply or execution.supports_status_reply, route=reply, reply_mode=answer, is_new_work=false, expected_deliverable=null. If evidence is missing, still reply with no verifiable record; never spawn only to inspect provenance/status.",
    "- budgeted_main_then_delegate: one lightweight read-only fresh lookup/version/status/environment/release check may start on main. fresh_live_lookup, route_hint=delegate, and fast_first_response alone land here, not must_delegate.",
    "- For budgeted_main_then_delegate set startup_cost_policy.main_fast_path_allowed=true, max_wall_ms=30000, max_tool_calls<=2, escalation_triggers including budget_expired, write_or_mutation_needed, long_command, multi_step_tools, test_build_review_validation.",
    "- must_delegate: explicit request for background/subagent/parallel execution (后台/子 agent/并行/委派); code/file mutation (写代码/改文件/修复); command execution (运行命令); tests/builds (跑测试/构建); log or workspace investigation needing real tools (查日志/查仓库); review/validation (review/审查/验证); multi-step probing; expected work >90s.",
    "- Bare opencode/glm/model/tool names or discussion of routing/config/models are not hard_delegate_signal unless the user asks that agent/tool to execute work.",
    "- Scope/target unknown -> route=reply, reply_mode=clarify.",
    "- Questions are not automatically reply; classify the work required.",
    "- If route=delegate for ordinary work: is_new_work=true and expected_deliverable is a concrete verifiable deliverable. If no concrete deliverable exists, reply or clarify.",
  ].join("\n");
}

function renderBoundaryExamples(): string {
  return [
    "## Boundary examples",
    "- Explain a type / answer a concept -> reply, answer, must_reply.",
    "- Which version/latest/release changed? one read-only check -> reply or delegate with decision_bucket=budgeted_main_then_delegate, not hard delegate.",
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
    "## JSON schema",
    renderJson(JudgeOutputSchema),
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
