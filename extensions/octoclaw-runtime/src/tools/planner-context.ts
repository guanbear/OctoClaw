import { envOverrides, resolveWorkspaceRoot, stableId, truncateText } from "../resolve/env.js";
import { buildDelegateHandoffPacket } from "../context/delegate-packets.js";
import { isOpenClawManagedOctoClawRepoPath, resolvePlannerNativeCwd } from "../delegate/planner-cwd.js";
import type { WorkContract } from "@octoclaw/contracts/work-contract";
import { asRecord, asString, type UnknownRecord } from "../util/type-coercion.js";
import { optionalString } from "./registration-helpers.js";

const PLANNER_CONTEXT_PACKET_MAX_ITEMS = 8;

function plannerStringArray(...values: unknown[]): string[] {
  const out: string[] = [];
  const push = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) push(item);
      return;
    }
    const text = asString(value);
    if (text && !out.includes(text)) out.push(text);
  };
  for (const value of values) push(value);
  return out.slice(0, PLANNER_CONTEXT_PACKET_MAX_ITEMS);
}

function plannerAbsoluteScopePath(value: string, cwd: string): string {
  const home = process.env.HOME || "";
  const expanded = home && (value === "~" || value.startsWith("~/"))
    ? `${home.replace(/\/+$/, "")}/${value.slice(2).replace(/^\/+/, "")}`
    : value;
  const absolute = expanded.startsWith("/")
    ? expanded
    : `${cwd.replace(/\/+$/, "")}/${expanded}`;
  const parts: string[] = [];
  for (const part of absolute.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function isOpenClawRepoRootPath(value: string): boolean {
  const parts = value.split("/").filter(Boolean);
  for (let index = 0; index < parts.length - 2; index += 1) {
    if (parts[index] === "openclaw" && parts[index + 1] === "repos") {
      return index + 3 === parts.length;
    }
  }
  return false;
}

function plannerWorkspaceRootCandidate(value: unknown, params: { rawCwd: string; cwd: string }): string {
  const text = asString(value);
  if (!text) return "";
  if (
    params.cwd !== params.rawCwd
    && (text === params.rawCwd || text === envOverrides.workspaceRoot || isOpenClawManagedOctoClawRepoPath(text))
  ) {
    return "";
  }
  return text;
}

function isBroadPlannerReadScope(value: string, params: { cwd: string; workspaceRoot: string }): boolean {
  const text = value.trim();
  if (!text || text === "." || text === "./" || text === "/" || text === "~") return true;
  const absolute = plannerAbsoluteScopePath(text, params.cwd);
  const cwd = plannerAbsoluteScopePath(params.cwd, params.cwd);
  const workspaceRoot = plannerAbsoluteScopePath(params.workspaceRoot, params.cwd);
  if (absolute === cwd || absolute === workspaceRoot) return true;
  return isOpenClawRepoRootPath(absolute);
}

function plannerReadScopeArray(params: { cwd: string; workspaceRoot: string; values: unknown[] }): string[] {
  const out: string[] = [];
  const push = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) push(item);
      return;
    }
    const text = asString(value);
    if (!text || isBroadPlannerReadScope(text, params) || out.includes(text)) return;
    out.push(text);
  };
  for (const value of params.values) push(value);
  return out.slice(0, PLANNER_CONTEXT_PACKET_MAX_ITEMS);
}

function plannerContextRecord(...values: unknown[]): UnknownRecord {
  for (const value of values) {
    const record = asRecord(value);
    if (Object.keys(record).length > 0) return record;
  }
  return {};
}

function normalizePlannerWorkspaceMode(value: unknown, fallback: "read_only" | "write_allowed" = "write_allowed"): "read_only" | "write_allowed" {
  const mode = asString(value);
  if (mode === "read_only" || mode === "readonly" || mode === "read-only") return "read_only";
  if (mode === "write_allowed" || mode === "shared_workspace" || mode === "isolated_worktree") return "write_allowed";
  return fallback;
}

function normalizePlannerRole(value: unknown): "observer" | "default" | "code" | "research" | "review" {
  const role = asString(value);
  if (role === "observer" || role === "code" || role === "research" || role === "review") return role;
  if (role === "worker_code" || role === "octoclaw-code") return "code";
  if (role === "worker_research" || role === "octoclaw-research") return "research";
  if (role === "worker_review" || role === "octoclaw-review") return "review";
  return "default";
}

function plannerMaxToolCalls(value: unknown, fallback = 10): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(2, Math.min(24, Math.floor(numeric)));
}

function plannerDefaultMaxToolCalls(role: "observer" | "default" | "code" | "research" | "review", hasExplicitContextRefs: boolean): number {
  if (role === "code" || role === "review") return 14;
  if (role === "research") return hasExplicitContextRefs ? 8 : 5;
  return hasExplicitContextRefs ? 8 : 4;
}

export function buildPlannerContextPacket(params: {
  task: string;
  workContractId: string;
  delegateTaskId: string;
  attemptId?: string;
  expectedDeliverable?: string;
  childSessionKey?: string;
  cwd?: string;
  selectedModel?: string;
  decision?: UnknownRecord | null;
  metadata?: UnknownRecord | null;
  workContract?: WorkContract | null;
}): string {
  const metadata = asRecord(params.metadata);
  const decision = asRecord(params.decision);
  const routeDecision = asRecord(decision.route_decision);
  const requestMetadata = asRecord(asRecord(decision.request).metadata);
  const contextRefs = plannerContextRecord(
    metadata.context_refs,
    metadata.contextRefs,
    requestMetadata.context_refs,
    requestMetadata.contextRefs,
    decision.context_refs,
    decision.contextRefs,
    routeDecision.context_refs,
    routeDecision.contextRefs,
  );
  const hasExplicitContextPacket = Object.keys(contextRefs).length > 0;
  const delegateScope = params.workContract?.delegate?.scope;
  const rawCwd = asString(params.cwd, resolveWorkspaceRoot());
  const cwd = resolvePlannerNativeCwd(rawCwd) || rawCwd;
  const defaultWorkspaceRoot = cwd !== rawCwd ? cwd : envOverrides.workspaceRoot || cwd;
  const workspaceRootFallbacks = cwd !== rawCwd
    ? [
        defaultWorkspaceRoot,
        plannerWorkspaceRootCandidate(metadata.workspaceRoot, { rawCwd, cwd }),
        plannerWorkspaceRootCandidate(metadata.workspace_root, { rawCwd, cwd }),
      ]
    : [metadata.workspaceRoot, metadata.workspace_root, defaultWorkspaceRoot];
  const workspaceRoot = optionalString(
    plannerWorkspaceRootCandidate(contextRefs.workspaceRoot, { rawCwd, cwd }),
    plannerWorkspaceRootCandidate(contextRefs.workspace_root, { rawCwd, cwd }),
    ...workspaceRootFallbacks,
    cwd,
  ) || cwd;
  const primaryFiles = plannerReadScopeArray({
    cwd,
    workspaceRoot,
    values: [
      contextRefs.primaryFiles,
      contextRefs.primary_files,
      metadata.primaryFiles,
      metadata.primary_files,
      routeDecision.primaryFiles,
      routeDecision.primary_files,
    ],
  });
  const readScope = plannerReadScopeArray({
    cwd,
    workspaceRoot,
    values: [
      contextRefs.readScope,
      contextRefs.read_scope,
      primaryFiles,
    ],
  });
  const explicitSideEffectsRequested = hasExplicitContextPacket && (
    contextRefs.requestedSideEffects === true
    || contextRefs.requested_side_effects === true
    || contextRefs.sideEffects === true
    || contextRefs.side_effects === true
  );
  const contextWorkspaceMode = contextRefs.workspaceMode ?? contextRefs.workspace_mode;
  const contextGrantsWrite = normalizePlannerWorkspaceMode(contextWorkspaceMode, "read_only") === "write_allowed";
  const writeScope = plannerStringArray(
    contextRefs.writeScope,
    contextRefs.write_scope,
    explicitSideEffectsRequested || (contextGrantsWrite && !contextRefs.writeScope && !contextRefs.write_scope)
      ? "requested:side_effects"
      : undefined,
    delegateScope?.write,
  );
  const artifactRefs = params.workContract?.delegate?.artifactRefs ?? [];
  const hasExplicitContextRefs = primaryFiles.length > 0 || readScope.length > 0 || writeScope.length > 0 || artifactRefs.length > 0;
  const role = normalizePlannerRole(params.workContract?.delegate?.role
    ?? routeDecision.worker_role
    ?? routeDecision.role
    ?? routeDecision.task_class
    ?? routeDecision.worker_pool);
  const workspaceFallback = role === "code" || writeScope.length > 0 ? "write_allowed" : "read_only";
  const workspaceMode = normalizePlannerWorkspaceMode(
    contextRefs.workspaceMode
      ?? contextRefs.workspace_mode
      ?? delegateScope?.workspaceMode
      ?? metadata.workspaceMode
      ?? metadata.workspace_mode,
    workspaceFallback,
  );
  const maxToolCalls = plannerMaxToolCalls(
    hasExplicitContextRefs
      ? contextRefs.maxToolCalls
        ?? contextRefs.max_tool_calls
        ?? metadata.maxToolCalls
        ?? metadata.max_tool_calls
      : undefined,
    plannerDefaultMaxToolCalls(role, hasExplicitContextRefs),
  );
  const requestedSideEffectScope = writeScope.includes("requested:side_effects");
  const defaultSourcePolicy = hasExplicitContextRefs
    ? requestedSideEffectScope
      ? "Use the supplied task brief first. For requested side effects, prefer the native CLI/API for the target system, make only the smallest requested change, and verify with a read-only status/list command. If the target or destination is ambiguous, stop with a blocker instead of broadening scope."
      : "Use explicit refs and local workspace first. Use external web only when the task explicitly needs current outside facts or local refs are insufficient."
    : "Use the supplied task brief first. No explicit refs were provided, so avoid broad workspace inventory; use external web only when the task explicitly needs current outside facts.";
  const sourcePolicy = optionalString(
    hasExplicitContextRefs ? contextRefs.sourcePolicy : undefined,
    hasExplicitContextRefs ? contextRefs.source_policy : undefined,
    defaultSourcePolicy,
  ) || defaultSourcePolicy;
  const threadSummary = optionalString(
    contextRefs.threadSummary,
    contextRefs.thread_summary,
    metadata.threadSummary,
    metadata.thread_summary,
    "",
  ) || "";
  const handoffPacket = buildDelegateHandoffPacket({
    delegateTaskId: params.delegateTaskId,
    attemptId: params.attemptId || `${params.delegateTaskId}:attempt:1`,
    threadBindingKey: params.workContract?.continuity.threadBindingKey || stableId("thread", [params.workContractId]),
    currentUserAsk: truncateText(params.task, 700),
    taskBrief: truncateText(params.task, 900),
    acceptanceCriteria: [asString(params.expectedDeliverable, "Return a compact result that directly satisfies the parent user request.")],
    readScope,
    writeScope,
    workspaceMode,
    role,
    modelProfile: asString(params.selectedModel, params.workContract?.delegate?.modelProfile || "default"),
    maxInputTokens: 1800,
    maxSummaryTokens: 500,
    threadSummary: threadSummary ? truncateText(threadSummary, 500) : undefined,
    artifactRefs: params.workContract?.delegate?.artifactRefs ?? [],
    forbiddenContent: params.workContract?.mainContext.forbiddenContent ?? [],
  });
  return [
    "## Runtime Context Packet",
    "This packet is generated by OctoClaw runtime; do not infer hidden parent transcript.",
    "```json",
    JSON.stringify({
      schemaVersion: "octoclaw.planner_native_context.v1",
      workContractId: params.workContractId,
      delegateTaskId: params.delegateTaskId,
      attemptId: params.attemptId || `${params.delegateTaskId}:attempt:1`,
      preferredChildSessionKey: asString(params.childSessionKey) || undefined,
      cwd,
      workspaceRoot,
      contextMode: "isolated",
      lightContext: true,
      contextStrategy: hasExplicitContextRefs ? "explicit_refs" : "bounded_brief_only",
      primaryFiles,
      sourcePolicy,
      executionBudget: {
        maxToolCalls,
        broadDiscovery: "forbidden_outside_cwd_without_explicit_need",
        resultOnBudgetPressure: "return_partial_with_caveats",
      },
      handoff: handoffPacket,
    }, null, 2),
    "```",
    "",
    "Operational rules:",
    hasExplicitContextRefs
      ? "- Start from primaryFiles/readScope/artifactRefs; do not expand beyond them unless the task cannot be answered otherwise."
      : "- No primaryFiles/readScope/artifactRefs were supplied. Treat the task as bounded by the brief; avoid broad workspace inventory and use only narrowly targeted read-only checks when indispensable.",
    workspaceMode === "write_allowed"
      ? "- For write_allowed work, make the smallest requested native CLI/API change and verify it with a read-only status/list command."
      : "",
    "- Do not run broad discovery under /Users, memory/wiki search, or web search unless explicit refs fail and the task requires it.",
    "- If a fast file search tool is unavailable, use a scoped fallback under cwd/workspaceRoot only.",
    "- Treat maxToolCalls as a hard budget. If the budget or context is insufficient, stop and return a blocked worker result packet.",
    "- If you are blocked, include exactly one control block: <<<BEGIN_OCTOCLAW_WORKER_RESULT>>> {\"schemaVersion\":\"octoclaw.worker_result.v1\",\"delegateTaskId\":\"<handoff.delegateTaskId>\",\"attemptId\":\"<handoff.attemptId>\",\"status\":\"blocked\",\"summary\":\"<short reason>\",\"blockers\":[\"<missing input>\"]} <<<END_OCTOCLAW_WORKER_RESULT>>>.",
    "- Do not search package installs, shell history, or unrelated OpenClaw state to discover a repo. If cwd/workspaceRoot do not contain the needed source, return a blocked worker result packet.",
    "- Native announce handles final delivery; do not create side-channel result files.",
  ].join("\n");
}

export function buildPlannerSpawnTask(params: {
  task: string;
  workContractId: string;
  delegateTaskId: string;
  attemptId?: string;
  expectedDeliverable?: string;
  childSessionKey?: string;
  cwd?: string;
  selectedModel?: string;
  decision?: UnknownRecord | null;
  metadata?: UnknownRecord | null;
  workContract?: WorkContract | null;
}): string {
  return [
    "[OctoClaw delegated work]",
    `workContractId: ${params.workContractId}`,
    `delegateTaskId: ${params.delegateTaskId}`,
    params.attemptId ? `attemptId: ${params.attemptId}` : "",
    params.childSessionKey ? `preferredChildSessionKey: ${params.childSessionKey}` : "",
    "",
    "Expected deliverable:",
    params.expectedDeliverable || "A compact result packet that directly satisfies the parent user request.",
    "",
    buildPlannerContextPacket(params),
    "",
    "Rules:",
    "- Work only on the task below; do not expose hidden reasoning or raw transcript.",
    "- Return a compact, user-safe summary and any artifact refs needed by the parent.",
    "- Prefer concise progress and final output; OpenClaw native delivery handles announce/return.",
    "- For live lookup or research, bound source checks to the minimum needed and deliver partial findings with caveats instead of exhausting the run timeout.",
    "",
    "Task:",
    truncateText(params.task, 1800),
  ].filter(Boolean).join("\n");
}

export function plannedDelegateTaskId(workContractId: string, payload: UnknownRecord, contract?: WorkContract | null): string {
  return asString(contract?.delegate?.delegateTaskId)
    || asString(payload.delegate_task_id || payload.delegateTaskId)
    || `delegate-task:${workContractId}`;
}

export function plannedAttemptId(delegateTaskId: string, payload: UnknownRecord, contract?: WorkContract | null): string {
  return asString(contract?.delegate?.currentAttemptId)
    || asString(payload.attempt_id || payload.attemptId)
    || `${delegateTaskId}:attempt:1`;
}

const PLANNER_SPAWN_LABEL_MAX_LENGTH = 80;
const PLANNER_SPAWN_LABEL_ID_MAX_LENGTH = 40;

export function buildPlannerSpawnLabel(params: {
  text?: string;
  workContractId: string;
  delegateTaskId: string;
  attemptId?: string;
}): string {
  const labelText = asString(params.text, "OctoClaw delegate");
  const rawLabelId = asString(params.workContractId || params.delegateTaskId || params.attemptId);
  const labelId = rawLabelId.length > PLANNER_SPAWN_LABEL_ID_MAX_LENGTH
    ? stableId("ref", [rawLabelId])
    : rawLabelId;
  if (!labelId) return truncateText(labelText, PLANNER_SPAWN_LABEL_MAX_LENGTH);
  const suffix = ` [${labelId}]`;
  const prefixLimit = Math.max(1, PLANNER_SPAWN_LABEL_MAX_LENGTH - suffix.length);
  return `${truncateText(labelText, prefixLimit)}${suffix}`;
}

export function buildPlannerSessionsSpawnArgs(params: {
  task: string;
  workContractId: string;
  delegateTaskId: string;
  expectedDeliverable?: string;
  selectedModel?: string;
  cwd?: string;
  expectedSeconds: number;
  timeoutSeconds?: number;
  preferredChildSessionKey?: string;
  label?: string;
  attemptId?: string;
  decision?: UnknownRecord | null;
  metadata?: UnknownRecord | null;
  workContract?: WorkContract | null;
}): Record<string, unknown> {
  const cwd = resolvePlannerNativeCwd(params.cwd);
  return {
    task: buildPlannerSpawnTask({
      task: params.task,
      workContractId: params.workContractId,
      delegateTaskId: params.delegateTaskId,
      attemptId: params.attemptId,
      expectedDeliverable: params.expectedDeliverable,
      childSessionKey: params.preferredChildSessionKey,
      cwd: params.cwd,
      selectedModel: params.selectedModel,
      decision: params.decision,
      metadata: params.metadata,
      workContract: params.workContract,
    }),
    label: buildPlannerSpawnLabel({
      text: params.label || params.expectedDeliverable || params.task,
      workContractId: params.workContractId,
      delegateTaskId: params.delegateTaskId,
      attemptId: params.attemptId,
    }),
    runtime: "subagent",
    ...(params.selectedModel ? { model: params.selectedModel } : {}),
    ...(cwd ? { cwd } : {}),
    mode: "run",
    cleanup: "keep",
    sandbox: "inherit",
    context: "isolated",
    lightContext: true,
  };
}
