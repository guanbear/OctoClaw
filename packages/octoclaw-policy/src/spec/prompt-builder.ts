import {
  AckWriterInputSchema,
  AckWriterOutputSchema,
  ANTI_REPLY_BIAS_RULES,
  DECISION_RUBRIC,
  IRON_LAWS,
  JudgeOutputSchema,
  POLICY_LABELS,
  VALIDATOR_DEFAULT_RULES,
} from "./decision-policy-spec.js";

function renderJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function renderPolicyLabels(): string {
  return [
    "## Policy labels",
    ...Object.entries(POLICY_LABELS).map(([key, labels]) => `- ${key}: ${labels.map((label) => `\"${label}\"`).join(" | ")}`),
  ].join("\n");
}

function renderRouteDefinitions(): string {
  return [
    "## Route definitions",
    "- route=reply: stay on the main thread because no new execution work unit is needed. This includes direct answers and safe clarification questions.",
    "- route=delegate: create or hand off a new execution work unit because tools, probing, inspection, verification, or longer-running work are needed.",
    "- reply_mode=answer: the main thread can answer now without new tooling or guessing.",
    "- reply_mode=clarify: ask for missing scope / target / critical slot before answering or delegating.",
    "- delegate_role=observer: read-only observation / snapshot work.",
    "- delegate_role=default: generic delegated work when no more specific role fits.",
    "- delegate_role=code: implementation / editing / fix / build work.",
    "- delegate_role=research: investigation / lookup / comparison / synthesis work.",
    "- delegate_role=review: audit / QA / validation / critique work.",
    "",
    "Examples:",
    "- 'Explain what this TypeScript type means' -> likely reply + reply_mode=answer.",
    "- 'Which version is installed on this machine?' -> delegate, because this is a fresh environment lookup.",
    "- 'Check repo status and summarize' -> delegate, because this requires workspace inspection.",
    "- 'Was that written by you or by a sub-agent?' -> if execution.supports_provenance_reply=true then reply+answer (use execution receipt), else reply+answer with 'no verifiable record'. NEVER delegate or spawn for provenance lookup.",
    "- 'Check that delegated task status again' -> if execution.supports_status_reply=true then reply+answer (use receipt), else reply + allow control-plane refresh (status/task-action tools). NEVER spawn for status lookup.",
    "- 'Do you mean package A or package B?' when target is unclear -> reply + reply_mode=clarify.",
    "- 'Run tests, inspect failures, and fix them' -> delegate, because this is a new execution work unit and likely long-running.",
  ].join("\n");
}

function renderIronLaws(): string {
  return [
    "## Iron laws",
    ...IRON_LAWS.map((law, index) => `${index + 1}. ${law.id}: ${law.rule}`),
  ].join("\n");
}

function renderAntiReplyBiasRules(): string {
  return [
    "## Anti-reply-bias rules",
    ...ANTI_REPLY_BIAS_RULES.map((rule, index) => `${index + 1}. ${rule.rule}`),
  ].join("\n");
}

function renderDecisionRubric(): string {
  return [
    "## Decision rubric",
    "### reply (§10.1)",
    ...DECISION_RUBRIC.reply.map((item, index) => `${index + 1}. ${item}`),
    "### delegate (§10.2)",
    ...DECISION_RUBRIC.delegate.map((item, index) => `${index + 1}. ${item}`),
    "### clarify (§10.3)",
    ...DECISION_RUBRIC.clarify.map((item, index) => `${index + 1}. ${item}`),
  ].join("\n");
}

function renderValidatorDefaultRules(): string {
  return [
    "## Validator default rules",
    ...VALIDATOR_DEFAULT_RULES.map((rule, index) => `${index + 1}. if ${rule.if}, then ${rule.then}`),
  ].join("\n");
}

function renderCriticalRules(): string {
  return [
    "## CRITICAL defaults",
    "- Questions ≠ reply. 问句不等于reply.",
    "- Tool/probe/command → delegate. 新工具调用默认委派.",
    "- Expected >1min → delegate. 预计超过1分钟默认委派.",
    "- Scope unknown → clarify. scope不明优先clarify.",
    "- check version/status/environment → delegate. 查版本/查状态/查环境 → delegate.",
    "- execution truth/provenance follow-up → check execution coverage first. 查执行事实/查是谁做的 → check execution layer: if supports_provenance_reply → reply.answer; if missing → reply 'no verifiable record' + at most status/task-action tool; NEVER spawn for provenance.",
  ].join("\n");
}

function renderLocalJudgeInstructions(): string {
  return [
    "## ⛔ HARD CONSTRAINTS — VIOLATION = INVALID OUTPUT",
    "- You CANNOT write code, scripts, commands, or any executable content.",
    "- You CANNOT execute, run, or perform any task the user asked.",
    "- You CANNOT produce anything except the JSON routing decision below.",
    "- If the user asks to write code/run commands/analyze logs/check status → that PROVES route=delegate.",
    "- If the user asks who handled prior work or whether it was delegated → CHECK execution.supports_provenance_reply first: if true → route=reply, reply_mode=answer; if false → route=reply, answer 'no verifiable record', at most allow control-plane tools. NEVER spawn to answer provenance questions.",
    "- confidence field is REQUIRED. Set 0.7 for routine decisions, 0.9 for obvious ones, 0.5 for uncertain ones.",
    "- is_followup_to_recent_execution, is_new_work, and expected_deliverable are REQUIRED.",
    "- If the turn asks about previous execution/status/provenance/dispatch/spawn/delivery/failure, set is_followup_to_recent_execution=true, is_new_work=false, expected_deliverable=null, and do NOT delegate just to inspect it.",
    "- If route=delegate for ordinary work, is_new_work must be true and expected_deliverable must be a concrete verifiable deliverable. If there is no concrete deliverable, route=reply.",
    "- scope, tool_need_hint, duration_hint fields are REQUIRED. Never omit them.",
    "- Your ONLY job: classify the user's intent into route + metadata fields.",
    "- Any output that is not a JSON object with route/confidence/scope/... fields is INVALID.",
    "",
    "## Local judge instructions",
    "- You are the hot-path authority for route selection ONLY.",
    "- Top-level route options are ONLY \"reply\" or \"delegate\".",
    "- Do not invent other route labels.",
    "- If route=reply, set reply_mode to \"answer\" or \"clarify\".",
    "- If route=delegate, set delegate_role to the best matching role; otherwise use null.",
    "- coordination_mode_hint, complexity, scope, tool_need_hint, and duration_hint must use only canonical labels.",
    "- reason_codes should be concise machine-readable strings explaining the decision.",
    "- Output JSON only. No prose before or after JSON.",
  ].join("\n");
}

export function buildLocalJudgeSystemPrompt(): string {
  return [
    "You are OctoClaw local_judge. You are the hot-path routing authority.",
    "Implement exactly the canonical decision policy spec. Do not improvise. Do not redesign abstractions.",
    renderCriticalRules(),
    renderRouteDefinitions(),
    renderPolicyLabels(),
    renderIronLaws(),
    renderAntiReplyBiasRules(),
    renderDecisionRubric(),
    renderValidatorDefaultRules(),
    renderLocalJudgeInstructions(),
    "## Output JSON schema",
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
