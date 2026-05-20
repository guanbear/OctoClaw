import {
  authoritativeDecisionRoute,
  canonicalizeDecisionForPolicyState,
  DELEGATED_ROUTE_NAMES,
  isDelegatedRoute as isDelegatedRouteName,
  isObserveMode,
  normalizeLiveRoute,
} from "../resolve/route-helpers.js";
import { type UnknownRecord, asRecord, asStringArray } from "../util/type-coercion.js";



export function runtimeSwitches(decision: Record<string, unknown>): Record<string, boolean> {
  return asRecord(decision.runtime_switches) as Record<string, boolean>;
}

export function buildRolloutFlags(decision?: Record<string, unknown>): Record<string, boolean> {
  const switches = runtimeSwitches(asRecord(decision));
  const switchRecord = switches as UnknownRecord;
  return {
    contractVersion: Boolean(String(switchRecord.rollout_contract_version ?? "octoclaw.runtime_flags/v1").trim()),
    policyJudgeLiveEnabled: Boolean(switchRecord.policy_judge_live_enabled),
    cheapJudgeLiveEnabled: Boolean(switchRecord.cheap_judge_live_enabled),
    localJudgeLiveEnabled: Boolean(switchRecord.local_judge_live_enabled),
    runnerPoolEnabled: Boolean(switchRecord.runner_pool_enabled),
    legacyRunnerFallbackEnabled: Boolean(switchRecord.legacy_runner_fallback_enabled),
    patrolLoopEnabled: Boolean(switchRecord.patrol_loop_enabled),
    safeModeEnabled: Boolean(switchRecord.safe_mode_enabled),
    judgeLock: Boolean(String(switchRecord.judge_lock ?? "").trim()),
    overrideSources: Boolean(asStringArray(switchRecord.override_sources).length),
  };
}

export function preHintAllowedTools(decision: Record<string, unknown>, routeHintTool: string): Set<string> {
  const toolPolicy = asRecord(decision.tool_policy);
  const workContract = asRecord(decision.work_contract);
  const allowed = new Set([routeHintTool, "octoclaw_status", "octoclaw_task_action", "octoclaw_dispatch_confirm", "sessions_yield", "session_status"].filter(Boolean));
  const delegateTool = String(toolPolicy.must_delegate_via ?? "").trim();
  if (delegateTool) {
    allowed.add(delegateTool);
  }
  for (const toolName of asStringArray(toolPolicy.allowed_control_tools)) {
    allowed.add(toolName);
  }
  for (const toolName of asStringArray(workContract.allowedTools ?? workContract.allowed_tools)) {
    allowed.add(toolName);
  }
  return allowed;
}

export function observerControlTools(decision: Record<string, unknown>, routeHintTool: string): Set<string> {
  const toolPolicy = asRecord(decision.tool_policy);
  const workContract = asRecord(decision.work_contract);
  const allowed = new Set(asStringArray(toolPolicy.observer_control_tools));
  if (routeHintTool) allowed.add(String(routeHintTool).trim());
  allowed.add("octoclaw_status");
  allowed.add("octoclaw_task_action");
  allowed.add("octoclaw_dispatch_confirm");
  allowed.add("sessions_yield");
  allowed.add("session_status");
  for (const toolName of asStringArray(workContract.allowedTools ?? workContract.allowed_tools)) {
    allowed.add(toolName);
  }
  return allowed;
}

export function sessionControlTools(decision: Record<string, unknown>, routeHintTool: string): Set<string> {
  const toolPolicy = asRecord(decision.tool_policy);
  const workContract = asRecord(decision.work_contract);
  const allowed = new Set(asStringArray(toolPolicy.session_control_tools));
  if (routeHintTool) allowed.add(String(routeHintTool).trim());
  allowed.add("octoclaw_status");
  allowed.add("session_status");
  for (const toolName of asStringArray(workContract.allowedTools ?? workContract.allowed_tools)) {
    allowed.add(toolName);
  }
  return allowed;
}

export function runnerWorkflowTools(decision: Record<string, unknown>, routeHintTool: string): Set<string> {
  const toolPolicy = asRecord(decision.tool_policy);
  const workContract = asRecord(decision.work_contract);
  const allowed = new Set(asStringArray(toolPolicy.allowed_control_tools));
  const delegateTool = String(toolPolicy.must_delegate_via ?? "").trim();
  if (delegateTool) allowed.add(delegateTool);
  if (routeHintTool) allowed.add(String(routeHintTool).trim());
  allowed.add("octoclaw_status");
  allowed.add("octoclaw_task_action");
  allowed.add("octoclaw_dispatch_confirm");
  allowed.add("sessions_yield");
  for (const toolName of asStringArray(workContract.allowedTools ?? workContract.allowed_tools)) {
    allowed.add(toolName);
  }
  return allowed;
}

export function isControlObserverDecision(decision: Record<string, unknown>): boolean {
  return String(asRecord(decision.route_decision).task_class ?? "").trim() === "control_observer";
}

export function isSessionControlDecision(decision: Record<string, unknown>): boolean {
  return String(asRecord(decision.route_decision).task_class ?? "").trim() === "session_control";
}

export function isRunnerDecision(decision: Record<string, unknown>): boolean {
  return normalizeLiveRoute(asRecord(decision.route_decision).route, "reply") === "delegate"
    && isObserveMode(
      String(asRecord(decision.route_decision).judge_role ?? asRecord(decision).role ?? "").trim(),
      String(asRecord(decision).executionProfile ?? "").trim(),
    );
}

export function workflowEnforcementRule(
  decision: Record<string, unknown>,
  toolName: string,
  routeHintTool: string,
): { block: boolean; delegateTool?: string; allowedTools: string[]; route?: string } {
  const route = String(asRecord(decision.route_decision).route ?? "").trim();
  const toolPolicy = asRecord(decision.tool_policy);
  const workContract = asRecord(decision.work_contract);
  const delegateTool = String(toolPolicy.must_delegate_via ?? "").trim();
  const allowedTools = runnerWorkflowTools(decision, routeHintTool);
  const forbiddenTools = new Set(asStringArray(workContract.forbiddenTools ?? workContract.forbidden_tools));
  const isDispatchArbiterTool = toolName === "octoclaw_dispatch" || (delegateTool && toolName === delegateTool);
  if (forbiddenTools.has(toolName) && !isDispatchArbiterTool) {
    return { block: true, route, delegateTool, allowedTools: [...allowedTools] };
  }
  const sealedContractRoute = String(workContract.route ?? workContract.route_decision ?? "").trim();
  const directToolsAllowed = toolPolicy.allow_direct_tools === true;
  if (sealedContractRoute === "delegate" && !directToolsAllowed) {
    return isDispatchArbiterTool || allowedTools.has(toolName)
      ? { block: false, route, delegateTool, allowedTools: [...allowedTools] }
      : { block: true, route, delegateTool, allowedTools: [...allowedTools] };
  }
  const workflowRequired = DELEGATED_ROUTE_NAMES.has(route) && !directToolsAllowed;
  if (!workflowRequired) {
    return { block: false, route, delegateTool, allowedTools: [...allowedTools] };
  }
  if ((delegateTool && toolName === delegateTool) || allowedTools.has(toolName)) {
    return { block: false, route, delegateTool, allowedTools: [...allowedTools] };
  }
  return { block: true, route, delegateTool, allowedTools: [...allowedTools] };
}

export function isDelegatedRoute(decision: Record<string, unknown>): boolean {
  return isDelegatedRouteName(authoritativeDecisionRoute(decision, "reply"));
}

export function routeHintRequired(decision: Record<string, unknown>): boolean {
  const routeHintPolicy = asRecord(decision.route_hint_policy);
  if (routeHintPolicy.ack_followup_applied) return false;
  if (routeHintPolicy.sticky_applied) return false;
  return Boolean(routeHintPolicy.required);
}


export function routeHintPromptRequired(decision: Record<string, unknown>): boolean {
  if (!routeHintRequired(decision)) return false;
  const canonicalDecision = canonicalizeDecisionForPolicyState(decision);
  const routeDecision = asRecord(canonicalDecision.route_decision);
  const route = authoritativeDecisionRoute(canonicalDecision, "reply");
  const taskClass = String(routeDecision.task_class ?? "").trim();
  const hardGate = Boolean(asRecord(canonicalDecision.hook_interface).before_tool_call)
    && Boolean(asRecord(asRecord(canonicalDecision.hook_interface).before_tool_call).delegate_required);
  if (route === "reply" && (taskClass === "main_direct" || !taskClass) && !hardGate) {
    return false;
  }
  return true;
}

export function shouldRetainPolicyStateOnAgentEnd(state: Record<string, unknown>): boolean {
  return Boolean(isDelegatedRoute(asRecord(state.decision)) && !state.delegated);
}

export function compactPolicyPrompt(decision: Record<string, unknown>): string {
  const canonicalDecision = canonicalizeDecisionForPolicyState(decision);
  const routeDecision = asRecord(canonicalDecision.route_decision);
  const routerDecision = asRecord(canonicalDecision.router_decision_v2);
  const policyRouter = asRecord(canonicalDecision.policy_router);
  const judge = asRecord(policyRouter.judge);
  const toolPolicy = asRecord(canonicalDecision.tool_policy);
  const workContract = asRecord(canonicalDecision.work_contract);
  const executionPacket = asRecord(canonicalDecision._execution_coverage_packet);
  const executionLayer = asRecord(canonicalDecision.execution_layer ?? canonicalDecision._execution_coverage);
  const blocked = asStringArray(toolPolicy.blocked_patterns).slice(0, 8);
  const allowedControls = asStringArray(toolPolicy.allowed_control_tools).slice(0, 8);
  const evidenceSummary = String(executionPacket.evidenceSummary ?? executionLayer.evidence_summary ?? "").trim();
  const route = String(routeDecision.route ?? "reply");
  const requestKind = String(routerDecision.request_kind ?? "");
  const decisionSource = String(workContract.decisionSource ?? routeDecision.route_source ?? "");
  const executionPacketId = String(executionPacket.packetId ?? "");
  const executionCoverage = String(asRecord(asRecord(executionPacket.coverage).execution).coverage ?? executionLayer.coverage ?? "");
  const dispatchExecuted = executionPacket.dispatchExecuted ?? executionLayer.dispatch_executed;
  const spawnExecuted = executionPacket.spawnExecuted ?? executionLayer.spawn_executed;
  const shouldProjectExecutionFacts = route !== "reply"
    || requestKind === "status_or_provenance"
    || decisionSource === "execution_coverage"
    || Boolean(executionPacketId)
    || Boolean(executionCoverage)
    || dispatchExecuted === true
    || spawnExecuted === true
    || Boolean(evidenceSummary);
  const parts = [
    `route=${route}`,
    route !== "reply" ? `worker_pool=${String(routeDecision.worker_pool ?? "octoclaw-main")}` : "",
    `task_class=${String(routeDecision.task_class ?? "")}`,
    `request_kind=${requestKind}`,
    `protected_lane=${String(routeDecision.protected_lane ?? "")}`,
    `must_delegate_via=${String(toolPolicy.must_delegate_via ?? "")}`,
    `policy_judge=${String(judge.selected ?? "")}`,
    shouldProjectExecutionFacts ? `WorkContract=${String(workContract.workContractId ?? canonicalDecision.workContractId ?? "")}` : "",
    shouldProjectExecutionFacts ? `work_contract_route=${String(workContract.route ?? "")}` : "",
    shouldProjectExecutionFacts ? `decision_source=${decisionSource}` : "",
    shouldProjectExecutionFacts ? `ExecutionCoverage=${executionPacketId}` : "",
    shouldProjectExecutionFacts ? `coverage=${executionCoverage}` : "",
    shouldProjectExecutionFacts ? `reply_mode=${String(executionPacket.replyMode ?? workContract.replyMode ?? "")}` : "",
    shouldProjectExecutionFacts ? `dispatch_executed=${String(dispatchExecuted ?? "")}` : "",
    shouldProjectExecutionFacts ? `spawn_executed=${String(spawnExecuted ?? "")}` : "",
    shouldProjectExecutionFacts ? `evidence=${evidenceSummary}` : "",
  ].filter((item) => item && !item.endsWith("=") && !item.endsWith("=undefined"));
  if (allowedControls.length > 0) parts.push(`allowed_control_tools=${allowedControls.join(",")}`);
  if (blocked.length > 0) parts.push(`blocked_patterns=${blocked.join(",")}`);
  return parts.join(" | ");
}

function compactPromptValue(value: unknown, maxLength = 240): string {
  const text = String(value ?? "").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function compactDelegatePolicyPrompt(decision: Record<string, unknown>): string {
  const canonicalDecision = canonicalizeDecisionForPolicyState(decision);
  const routeDecision = asRecord(canonicalDecision.route_decision);
  const toolPolicy = asRecord(canonicalDecision.tool_policy);
  const workContract = asRecord(canonicalDecision.work_contract);
  const reviewPolicy = asRecord(canonicalDecision.review_policy);
  const executionPacket = asRecord(canonicalDecision._execution_coverage_packet);
  const executionLayer = asRecord(canonicalDecision.execution_layer ?? canonicalDecision._execution_coverage);
  const allowedControls = asStringArray(toolPolicy.allowed_control_tools).slice(0, 6);
  const expectedDeliverable = compactPromptValue(
    workContract.expectedDeliverable
      ?? workContract.expected_deliverable
      ?? routeDecision.expected_deliverable
      ?? "",
  );
  const parts = [
    `route=${String(routeDecision.route ?? "delegate")}`,
    `decision_bucket=${String(routeDecision.decision_bucket ?? "")}`,
    `route_confidence=${String(routeDecision.route_confidence ?? canonicalDecision.route_confidence ?? "")}`,
    `complexity=${String(routeDecision.complexity ?? canonicalDecision.complexity ?? "")}`,
    `worker_pool=${String(routeDecision.worker_pool ?? "")}`,
    `task_class=${String(routeDecision.task_class ?? "")}`,
    `must_delegate_via=${String(toolPolicy.must_delegate_via ?? "")}`,
    `WorkContract=${String(workContract.workContractId ?? canonicalDecision.workContractId ?? "")}`,
    `review_required=${String(Boolean(reviewPolicy.required))}`,
    `dispatch_executed=${String(executionPacket.dispatchExecuted ?? executionLayer.dispatch_executed ?? "")}`,
    `spawn_executed=${String(executionPacket.spawnExecuted ?? executionLayer.spawn_executed ?? "")}`,
    expectedDeliverable ? `expected_deliverable=${expectedDeliverable}` : "",
  ].filter((item) => item && !item.endsWith("=") && !item.endsWith("=undefined"));
  if (allowedControls.length > 0) parts.push(`allowed_control_tools=${allowedControls.join(",")}`);
  return parts.join(" | ");
}

export function policySummaryText(payload: Record<string, unknown>): string {
  if (payload.summary) {
    return String(payload.summary);
  }
  const routeDecision = asRecord(payload.route_decision);
  const modelPolicy = asRecord(payload.model_policy);
  const reviewPolicy = asRecord(payload.review_policy);
  const route = String(routeDecision.route ?? "reply");
  const workerPool = String(routeDecision.worker_pool ?? "octoclaw-main");
  const profile = String(modelPolicy.profile ?? "");
  const model = String(modelPolicy.selected_model ?? "");
  const protocol = String(routeDecision.protocol ?? "normal");
  const review = Boolean(reviewPolicy.required) ? " / review" : "";
  const suffix = model ? ` / ${model}` : "";
  return `policy=${route} -> ${workerPool} / profile=${profile} / protocol=${protocol}${review}${suffix}`;
}

export function stringifyParamsForPolicy(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return String(value ?? "");
  }
}

export function matchesBlockedPattern(text: string, patterns: string[]): boolean {
  const haystack = String(text || "").toLowerCase();
  return patterns.some((pattern) => {
    const needle = String(pattern || "").trim().toLowerCase();
    return Boolean(needle) && haystack.includes(needle);
  });
}
