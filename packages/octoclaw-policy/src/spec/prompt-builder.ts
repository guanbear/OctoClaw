import {
  AckWriterInputSchema,
  AckWriterOutputSchema,
  POLICY_LABELS,
} from "./decision-policy-spec.js";

function renderJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function renderPolicyLabels(): string {
  return [
    "## Policy labels",
    `- route: ${POLICY_LABELS.route.map((label) => `"${label}"`).join(" | ")}`,
    `- complexity: ${POLICY_LABELS.complexity.map((label) => `"${label}"`).join(" | ")}`,
  ].join("\n");
}

function renderOutputContract(): string {
  return [
    "## Output contract",
    "- Return exactly one JSON object. No prose, markdown, code, commands, or execution.",
    "- Top-level route is only reply or delegate. Do not choose SR-P1 buckets directly.",
    "- Required fields: route, confidence, complexity.",
    "- Do not output scenario, complexity_confidence, complexityConfidence, reasoning, thought, role, workType, scope, tool_need_hint, duration_hint, reason_codes, is_new_work, expected_deliverable, or startup buckets.",
    "- confidence is 0..1 and only describes route certainty.",
    "- complexity is simple, normal, complex, or deep. It is model/cost complexity only and must not override or imply route.",
    renderPolicyLabels(),
  ].join("\n");
}

function renderSrP1Rules(): string {
  return [
    "## SR-P1 routing rules",
    "- Judge only decides route=reply or route=delegate plus complexity. Runtime maps route and runtime facts to must_reply, must_delegate, or budgeted_main_then_delegate.",
    "- status/provenance follow-up: route=reply when the user is asking about an existing execution record; never spawn only to inspect provenance/status.",
    "- One lightweight read-only lookup or local status check can remain route=reply; runtime may run it on the main fast path or budgeted_main_then_delegate.",
    "- Fresh version/latest/status/local-machine/release lookup is not delegate by itself; prefer route=reply unless it needs write work, long-running work, multi-step investigation, review/validation, or explicit delegation.",
    "- Explicit requests to delegate, use a subagent, or create a separate execution unit are route=delegate even when the requested deliverable is a status or lookup summary.",
    "- route=delegate when the user asks for a new execution unit: background/subagent/parallel execution, code/file mutation, tests/builds, review/validation, multi-step probing, long commands, or clearly long-running work.",
    "- Bare opencode/glm/model/tool names or discussion of routing/config/models are not delegate unless the user asks that agent/tool to execute work.",
    "- Unknown scope/target -> route=reply.",
    "- Questions are not automatically reply; classify the work required.",
  ].join("\n");
}

function renderBoundaryExamples(): string {
  return [
    "## Boundary examples",
    "- Explain a type / answer a concept -> reply.",
    "- Check local Python version / Redis port / OctoClaw status / today's weather -> reply when it is one lightweight read-only lookup.",
    "- Which version/latest/release changed? -> reply for one lightweight lookup; delegate for multi-source research or comparison.",
    "- 请委派一个子任务查询当前运行状态，然后汇总结论 -> delegate.",
    "- Check repo status once -> reply; inspect logs, run tests, inspect failures, or fix code -> delegate.",
    "- 后台跑测试并修复失败用例 -> delegate.",
    "- Was that done by you or a sub-agent? -> reply using execution receipt/no verifiable record; never spawn.",
    "- I mentioned opencode/GLM config -> reply unless asked to make that agent execute work.",
  ].join("\n");
}

export function buildLocalJudgeSystemPrompt(): string {
  return [
    "You are OctoClaw local_judge. You are the hot-path routing authority.",
    "Classify route and complexity only. Do not execute or answer the user task.",
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
