import {
  buildDecision,
  buildTsRuntimeDispatchPayload,
  buildTsRuntimeSpawnPayload,
  checkActiveTaskRecovery,
  resolveStatelessPolicyDecision,
} from "../resolve/policy-resolver.js";
import {
  stableId,
  truncateText,
} from "../resolve/env.js";
import {
  readTaskStateRecords,
  upsertTaskStateRecord,
} from "../state/task-state-store.js";
import {
  type NativeHelperInvoker,
} from "../adapter/native-helper.js";
import {
  applyUserMetadataOverrides,
  buildPolicyMetadata,
  detectSessionBoundary,
  finalizeDispatchMetadata,
  isManagedAgentContext,
  resolveDispatchSessionKey,
  resolvePolicyStateKey,
  resolvePolicyStateKeys,
} from "../resolve/session.js";
import { policySummaryText } from "../replay/policy-utils.js";
import {
  recordDispatchLifecycleReplayEvents,
  recordPolicyReplay,
} from "../replay/replay.js";
import { policyState } from "../state/policy-state.js";
import {
  authoritativeDecisionRoute,
  canonicalizeDecisionForPolicyState,
  normalizeLiveRoute,
} from "../resolve/route-helpers.js";
import { createOpenClawDistTaskFlowPort } from "../ports/openclaw-dist-taskflow-port.js";
import { checkTaskflowCapability } from "../ports/taskflow-port.js";
import type { RouteSeal } from "@octoclaw/contracts/route-seal";
import type { NativeBindingRef, NativeFlowStatus, WorkContract } from "@octoclaw/contracts/work-contract";
import { loadWorkContract } from "../work-contract/store.js";
import { materializeWorkContractSuccess, materializeWorkContractFailure } from "../work-contract/materializer.js";
import { markChildSessionPreferred, selectPreferredChildSession } from "../work-contract/continuity.js";
import { emitExecutionTransitionNotification } from "../ack/execution-transition-notifier.js";
import { isPlannerAllowedForSession, resolvePlannerAllowlist, resolveSpawnBackend, resolveSpawnIntentTtlMs, resolveSpeculativePreloadEnabled } from "../config/index.js";
import { confirmNativeSpawn } from "../delegate/native-spawn-confirm.js";
import { nativeSpawnIntentStore } from "../delegate/native-spawn-intent-store.js";
import {
  buildSpeculativeSessionsSendArgs,
  readSpeculativePreloadState,
  serializeSpeculativePreloadState,
  type SpeculativePreloadState,
} from "../delegate/speculative-preload.js";
import { escalateBudgetedMainDecision } from "../budgeted-main.js";
import { getModelMap } from "../model-map.js";
import { detectIMType } from "../im-status-renderer.js";
import { buildDelegationTicketDryRun } from "../runtime-ledger/ticket-dry-run.js";
import { admitDelegationTicketForDispatch, issueDelegationTicketCandidate } from "../runtime-ledger/ticket-enforcement.js";
import { openRuntimeLedger } from "../runtime-ledger/index.js";
import { isSchedulerEnabled } from "../runtime-ledger/feature-flags.js";
import { resolveRuntimeLedgerMode } from "../runtime-ledger/shadow.js";
import { performCrashRecovery } from "../runtime-ledger/crash-recovery.js";
import {
  promoteToQueued,
  releaseOrComplete,
  resolveSchedulerConfig,
  tryAcquireLease,
} from "../runtime-ledger/scheduler.js";
import {
  type UnknownRecord,
  isRecord,
  asRecord,
  asString,
  asNumberOptional as asNumber,
} from "../util/type-coercion.js";
import {
  nestedRecord,
  optionalString,
  parseObjectJson,
  stringArray,
  toolResponse,
  compactDispatchDetails,
  upsertTaskStateCache,
} from "./registration-helpers.js";
import {
  buildPlannerSessionsSpawnArgs,
  plannedAttemptId,
  plannedDelegateTaskId,
} from "./planner-context.js";
import {
  buildNativeStatusOutput,
  buildNativeTaskActionPayload,
  dispatchSpawnEvidence,
  hasNonNewWorkFollowupEvidence,
  plannerDispatchResponse,
  speculativePreloadStandbyRequiredResponse,
  normalizeTaskActionFormat,
  parseTaskAction,
  taskStateRecordMatchesId,
  type RuntimeTaskStateRecord,
} from "./runtime-status.js";
import {
  confirmedNativePlannerRefs,
  decisionFromWorkContract,
  delegatedStickyRoute,
  dispatchHonestyFailure,
  dispatchHonestySuccess,
  dispatchPlannerSessionCandidates,
  dispatchReplyToMessageId,
  selectDispatchPolicyDecision,
  selectDispatchWorkContractId,
  selectReplaySessionKeyForDispatch,
  validCachedRouteSeal,
} from "./dispatch-logic.js";
export {
  confirmedNativePlannerRefs,
  decisionFromWorkContract,
  delegatedStickyRoute,
  dispatchHonestyFailure,
  dispatchHonestySuccess,
  dispatchPlannerSessionCandidates,
  dispatchReplyToMessageId,
  selectDispatchPolicyDecision,
  selectDispatchWorkContractId,
  selectReplaySessionKeyForDispatch,
  validCachedRouteSeal,
} from "./dispatch-logic.js";
export {
  buildNativeStatusOutput,
  buildNativeTaskActionPayload,
  dispatchSpawnEvidence,
  hasNonNewWorkFollowupEvidence,
  plannerDispatchResponse,
  speculativePreloadStandbyRequiredResponse,
  dedupeTaskStateRecords,
  normalizeTaskActionFormat,
  parseTaskAction,
  taskStateRecordMatchesId,
} from "./runtime-status.js";
export {
  nestedRecord,
  optionalString,
  compactDispatchDetails,
  upsertTaskStateCache,
} from "./registration-helpers.js";
export {
  buildPlannerSessionsSpawnArgs,
  plannedAttemptId,
  plannedDelegateTaskId,
} from "./planner-context.js";
export interface ToolRegistrationOptions {
  judgeFastRaw?: UnknownRecord;
  delegationEnabled?: boolean;
  pluginConfig?: UnknownRecord;
  pluginConfigProvider?: () => UnknownRecord;
}



export interface ToolRegistration {
  name: string;
  label: string;
  description: string;
  params?: Record<string, unknown>;
  execute: (params: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

export interface CommandRegistration {
  name: string;
  description: string;
  acceptsArgs?: boolean;
  handler: (ctx: Record<string, unknown>) => Promise<void>;
}


interface SpeculativeDispatchSelection {
  speculative: SpeculativePreloadState | null;
  candidateKey: string;
  reason: string;
  status: string;
}

interface SpeculativeDispatchCandidate {
  key: string;
  state: UnknownRecord;
  speculative: SpeculativePreloadState;
  updatedAt: number;
}

function speculativeTimestamp(state: UnknownRecord, speculative: SpeculativePreloadState): number {
  const speculativeRecord = speculative as unknown as UnknownRecord;
  const numeric = Number(speculative.updatedAt || speculativeRecord.updated_at || speculative.createdAt || speculativeRecord.created_at || state.updatedAt || state.createdAt || 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function selectLatestSpeculativePreloadCandidate(input: {
  keys: unknown[];
  fallbackState?: UnknownRecord | null;
}): SpeculativeDispatchCandidate | null {
  const candidates: SpeculativeDispatchCandidate[] = [];
  const seen = new Set<string>();
  const addCandidate = (key: string, state: UnknownRecord | null | undefined) => {
    if (!state) return;
    const speculative = readSpeculativePreloadState(state);
    if (!speculative?.label) return;
    const dedupeKey = key || `fallback:${candidates.length}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    candidates.push({
      key,
      state,
      speculative,
      updatedAt: speculativeTimestamp(state, speculative),
    });
  };

  for (const rawKey of input.keys) {
    const key = asString(rawKey);
    if (!key) continue;
    addCandidate(key, asRecord(policyState.get(key)));
  }
  addCandidate("", input.fallbackState ?? null);

  candidates.sort((left, right) => right.updatedAt - left.updatedAt);
  return candidates[0] ?? null;
}

function selectSpeculativePreloadForDispatch(input: {
  keys: unknown[];
  fallbackState?: UnknownRecord | null;
}): SpeculativeDispatchSelection {
  const latest = selectLatestSpeculativePreloadCandidate(input);
  if (!latest) {
    return { speculative: null, candidateKey: "", reason: "no_speculative_state", status: "" };
  }
  const status = latest.speculative.status;
  if (status !== "ready") {
    return {
      speculative: null,
      candidateKey: latest.key,
      reason: `latest_speculative_${status || "unknown"}`,
      status,
    };
  }
  if (!latest.speculative.runId && !latest.speculative.childSessionKey) {
    return {
      speculative: null,
      candidateKey: latest.key,
      reason: "ready_missing_native_refs",
      status,
    };
  }
  return {
    speculative: latest.speculative,
    candidateKey: latest.key,
    reason: "ready",
    status,
  };
}


function sealedReplyBlocksDelegateHint(decision: UnknownRecord, requestedRoute: string, routeObjection: boolean): boolean {
  if (normalizeLiveRoute(requestedRoute, "reply") !== "delegate" || routeObjection) return false;
  const route = authoritativeDecisionRoute(decision, "reply");
  if (route !== "reply") return false;
  const workContract = asRecord(decision.work_contract);
  const replyContract = asRecord(decision.replyContract ?? decision.reply_contract);
  const toolPolicy = asRecord(decision.tool_policy);
  const forbidden = new Set([
    ...stringArray(toolPolicy.block_tool_patterns),
    ...stringArray(workContract.forbiddenTools ?? workContract.forbidden_tools),
    ...stringArray(replyContract.forbiddenTools),
    ...stringArray(replyContract.forbidden_tools),
  ]);
  return asString(workContract.route) === "reply"
    || (forbidden.has("octoclaw_dispatch") && forbidden.has("spawn"));
}

function sealedReplyRouteHintPayload(decision: UnknownRecord, routeHintPayload: UnknownRecord): UnknownRecord {
  const routeDecision = asRecord(decision.route_decision);
  const request = asRecord(decision.request);
  const metadata = asRecord(request.metadata);
  const routeHintPolicy = asRecord(decision.route_hint_policy);
  return canonicalizeDecisionForPolicyState({
    ...decision,
    request: {
      ...request,
      metadata: {
        ...metadata,
        route_hint_payload: routeHintPayload,
        route_hint_blocked_by_sealed_work_contract: true,
      },
    },
    route_decision: {
      ...routeDecision,
      route: "reply",
      system_preferred_route: "reply",
      dispatch_required: false,
      reason_codes: Array.from(new Set([
        ...stringArray(routeDecision.reason_codes),
        "route_hint_blocked_by_sealed_work_contract",
      ])),
    },
    route_hint_policy: {
      ...routeHintPolicy,
      submitted: true,
      advisory_only: true,
      blocked_by_sealed_work_contract: true,
      blocked_requested_route: "delegate",
      source: asString(routeHintPayload.source, "main_agent"),
    },
  });
}



function isBudgetedMainDispatchEscalationAllowed(input: {
  cachedRouteSeal: RouteSeal;
  cachedDecision: UnknownRecord;
  resolvedRoute: string;
  hadCachedDecision: boolean;
  routeSealState: UnknownRecord | null;
}): boolean {
  if (!input.hadCachedDecision || !input.routeSealState) return false;
  if (input.cachedRouteSeal.route !== "reply" || input.resolvedRoute !== "delegate") return false;
  const routeDecision = asRecord(input.cachedDecision.route_decision);
  const startupCostPolicy = asRecord(routeDecision.startup_cost_policy || input.cachedDecision._startup_cost_policy);
  const decisionBucket = asString(
    routeDecision.decision_bucket
    || input.cachedDecision._decision_bucket
    || startupCostPolicy.decision_bucket,
  );
  if (decisionBucket !== "budgeted_main_then_delegate") return false;
  return input.cachedDecision._budgeted_main_escalated === true
    || routeDecision.route_source === "budgeted_main_escalation"
    || routeDecision.dispatch_required === true;
}

function shouldPromoteBudgetedMainDispatch(input: {
  decision: UnknownRecord;
  state: UnknownRecord | null;
  workContract: WorkContract | null;
}): boolean {
  const routeDecision = asRecord(input.decision.route_decision);
  const startupCostPolicy = asRecord(routeDecision.startup_cost_policy || input.decision._startup_cost_policy);
  const decisionBucket = asString(
    routeDecision.decision_bucket
    || input.decision._decision_bucket
    || startupCostPolicy.decision_bucket,
  );
  if (decisionBucket !== "budgeted_main_then_delegate") return false;

  const state = asRecord(input.state);
  const budgetedMain = asRecord(state.budgetedMain || state.budgeted_main);
  const workContractView = asRecord(input.decision.work_contract);
  const alreadyEscalated = input.decision._budgeted_main_escalated === true
    || routeDecision.route_source === "budgeted_main_escalation"
    || routeDecision.dispatch_required === true
    || asString(state.dispatchStatus || state.dispatch_status) === "budgeted_main_escalated"
    || Boolean(budgetedMain.escalatedAt || budgetedMain.escalated_at);
  const hasDelegateContract = input.workContract?.route === "delegate"
    || asString(workContractView.route) === "delegate";
  return alreadyEscalated || hasDelegateContract;
}


function validateDispatchWorkContract(contract: WorkContract | null, workContractId: string): { ok: true; contract: WorkContract } | { ok: false; route: string; error: string } {
  if (!contract) {
    return { ok: false, route: "delegate", error: `work_contract_not_found:${workContractId}` };
  }
  if (contract.status !== "sealed") {
    return { ok: false, route: contract.route, error: `work_contract_not_sealed:${workContractId}:${contract.status}` };
  }
  if (contract.route !== "delegate") {
    return { ok: false, route: contract.route, error: `work_contract_route_not_dispatchable:${workContractId}:${contract.route}` };
  }
  return { ok: true, contract };
}


function nativePlannerAlreadyStartedResponse(params: {
  workContract: WorkContract;
  refs: NonNullable<ReturnType<typeof confirmedNativePlannerRefs>>;
  workerPool: string;
  model: string;
}): Record<string, unknown> {
  const delegateTaskId = asString(params.workContract.delegate?.delegateTaskId);
  const attemptId = asString(params.workContract.delegate?.currentAttemptId);
  const body = {
    ok: true,
    route: "delegate",
    status: "already_started",
    delegation_method: "octoclaw_dispatch_planner",
    work_contract_id: params.workContract.workContractId,
    workContractId: params.workContract.workContractId,
    delegate_task_id: delegateTaskId || null,
    delegateTaskId: delegateTaskId || null,
    attempt_id: attemptId || null,
    attemptId: attemptId || null,
    spawn_intent_id: params.refs.spawnIntentId || null,
    spawnIntentId: params.refs.spawnIntentId || null,
    run_id: params.refs.runId,
    runId: params.refs.runId,
    child_run_id: params.refs.childRunId || params.refs.runId,
    childRunId: params.refs.childRunId || params.refs.runId,
    child_session_key: params.refs.childSessionKey || null,
    childSessionKey: params.refs.childSessionKey || null,
    worker_pool: params.workerPool,
    model: params.model,
    execution_state: "already_started",
    terminal: false,
    is_failure: false,
    in_progress: true,
    awaiting_completion: true,
    next_action: "sessions_yield",
    completion_status: "pending",
    dispatch_executed: true,
    spawn_executed: true,
    materialized: false,
    result_materialized: false,
    ack_sent: false,
    instruction: "Native sessions_spawn is already accepted for this WorkContract. This is idempotent in-progress success, not a failure. Do not call sessions_spawn or legacy dispatch again; call sessions_yield and wait for native_announce completion or refresh with octoclaw_status. Do not report degraded/failed solely because result_materialized is currently false.",
  };
  return toolResponse(JSON.stringify(body), body);
}

function nativeFlowStatusFromSubstrate(substrate: string): NativeFlowStatus {
  switch (substrate) {
    case "running":
      return "running";
    case "blocked":
      return "blocked";
    case "completed":
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "lost":
      return "lost";
    case "waiting":
      return "waiting";
    case "queued":
    case "planned":
    default:
      return "queued";
  }
}

function selectRouteSealState(ctx: UnknownRecord, stateKey: string, state: UnknownRecord | null): UnknownRecord | null {
  if (state) {
    return state;
  }
  for (const rawKey of [stateKey, ctx.canonicalSessionKey, ctx.sessionKey, ctx.sessionId]) {
    const key = asString(rawKey);
    if (!key) continue;
    const candidate = policyState.get(key);
    if (candidate) {
      return candidate as UnknownRecord;
    }
  }
  return null;
}


function toolLogger(ctx: UnknownRecord): UnknownRecord {
  return asRecord(ctx.logger);
}

function warnToolLogger(ctx: UnknownRecord, message: string): void {
  const warn = toolLogger(ctx).warn;
  if (typeof warn === "function") {
    warn(message);
  }
}


function statusToolResponse(rawOutput: string, format: string, imType: string = "plain"): Record<string, unknown> {
  // For Slack, don't wrap in a code block — mrkdwn formatting should be preserved.
  // For other IMs / plain text, use the existing code block + verbatim instruction.
  const text = imType === "slack"
    ? [
        "OctoClaw status panel below. Return it to the user as-is without wrapping in a code block or reformatting.",
        "",
        rawOutput,
      ].join("\n")
    : [
        "OctoClaw raw status panel below. Return it verbatim to the user without summarizing or rewriting.",
        "```text",
        rawOutput,
        "```",
      ].join("\n");
  return {
    text,
    json: {
      format,
      source: "native_runtime",
      raw_output: rawOutput,
      return_verbatim: true,
    },
  };
}


function handoffText(payload: Record<string, unknown>, fallback: string): string {
  const handoff = asRecord(payload.handoff);
  if (handoff.user_safe === true && asString(handoff.reply_text)) {
    return asString(handoff.reply_text);
  }
  if (asString(handoff.summary)) {
    return asString(handoff.summary);
  }
  return fallback;
}

async function readReportExcerpt(reportPath: string, cwd?: string): Promise<Record<string, unknown>> {
  const resolvedPath = reportPath.startsWith("/")
    ? reportPath
    : `${asString(cwd, process.cwd()).replace(/\/$/u, "")}/${reportPath}`;
  return {
    exists: false,
    excerpt: "",
    path: resolvedPath,
    source: "native_runtime",
    note: "report excerpt preview is surfaced by native runtime consumers rather than this tool shim",
  };
}

async function userFacingHandoff(payload: Record<string, unknown>, fallback: string, cwd?: string): Promise<string> {
  const base = handoffText(payload, fallback);
  const handoff = asRecord(payload.handoff);
  const reportPath = asString(handoff.report_path ?? payload.report_path);
  const job = asRecord(payload.job);
  const taskId = asString(job.id ?? payload.task_id);
  if (!reportPath) {
    return base;
  }
  const artifactsCmd = taskId ? `octoclaw_task_action artifacts ${taskId}` : "octoclaw_task_action artifacts";
  try {
    const preview = await readReportExcerpt(reportPath, cwd);
    if (preview.exists === true && asString(preview.excerpt)) {
      return `${base}\n\n报告摘录：\n${asString(preview.excerpt)}\n\n结果已写入：\`${reportPath}\`\n（用 \`${artifactsCmd}\` 读取完整内容）`;
    }
  } catch {
    // Fall back to base handoff text.
  }
  return `${base}\n\n结果已写入：\`${reportPath}\`\n（用 \`${artifactsCmd}\` 读取完整内容）`;
}

function resolveToolPolicyContext(ctx: UnknownRecord, prompt = ""): { key: string; state: UnknownRecord | null } {
  const fromStore = asRecord(policyState.getToolPolicyContext(ctx, prompt));
  const contextKey = asString(fromStore.key);
  const contextState = isRecord(fromStore.state) ? fromStore.state : null;
  if (contextKey || contextState) {
    return { key: contextKey, state: contextState };
  }
  if (prompt) {
    const byPrompt = asRecord(policyState.findByPrompt(prompt));
    return {
      key: asString(byPrompt.key),
      state: isRecord(byPrompt.state) ? byPrompt.state : null,
    };
  }
  return { key: asString(resolvePolicyStateKey(ctx)), state: null };
}

function resolveDispatchPolicyContext(ctx: UnknownRecord, prompt = ""): { key: string; state: UnknownRecord | null } {
  const fromStore = asRecord(policyState.getDispatchPolicyContext(ctx, prompt));
  const contextKey = asString(fromStore.key);
  const contextState = isRecord(fromStore.state) ? fromStore.state : null;
  if (contextKey || contextState) {
    return { key: contextKey, state: contextState };
  }
  return { key: asString(resolvePolicyStateKey(ctx)), state: null };
}

function setPolicyStateForContext(ctx: UnknownRecord, entry: UnknownRecord, explicitKey = ""): string {
  const stateKey = asString(explicitKey || resolvePolicyStateKey(ctx));
  if (stateKey) {
    const normalized = isRecord(entry) && isRecord(entry.decision)
      ? { ...entry, decision: canonicalizeDecisionForPolicyState(entry.decision) }
      : entry;
    policyState.set(stateKey, normalized);
  }
  return stateKey;
}

function setPolicyStateAliasesForContext(ctx: UnknownRecord, entry: UnknownRecord, explicitKeys: string[] = []): string {
  const keys = Array.from(new Set([
    ...explicitKeys.map((key) => asString(key)),
    ...resolvePolicyStateKeys(ctx).map((key) => asString(key)),
  ].filter(Boolean)));
  let primaryKey = "";
  for (const key of keys) {
    const storedKey = setPolicyStateForContext(ctx, entry, key);
    if (!primaryKey) primaryKey = storedKey;
  }
  return primaryKey || setPolicyStateForContext(ctx, entry);
}


async function persistStickyLane(sessionKey: string, payload: UnknownRecord, logger: unknown, source: string): Promise<Record<string, unknown>> {
  const stickyPersisted = {
    persisted: Boolean(sessionKey),
    source,
    reason_codes: delegatedStickyRoute(payload) ? ["delegated_route"] : [],
  };
  if (sessionKey) {
    await recordPolicyReplay("sticky_lane_persisted", { sessionKey, source }, logger, payload);
  }
  return stickyPersisted;
}



function ctxCwd(ctx: UnknownRecord): string {
  return asString(ctx.cwd, process.cwd());
}

function ctxUi(ctx: UnknownRecord): { notify?: (message: string, level?: string) => void; setEditorText?: (text: string) => void } {
  return asRecord(ctx.ui) as { notify?: (message: string, level?: string) => void; setEditorText?: (text: string) => void };
}

function hasUi(ctx: UnknownRecord): boolean {
  return ctx.hasUI === true;
}

function readHelperInvoker(...values: unknown[]): NativeHelperInvoker | null {
  for (const value of values) {
    if (typeof value === "function") {
      return value as NativeHelperInvoker;
    }
  }
  return null;
}

function taskActionError(error: string, extra: UnknownRecord = {}): { summary: string; payload: UnknownRecord } {
  const payload = { ok: false, error, ...extra };
  return { summary: JSON.stringify(payload, null, 2), payload };
}

function findWorkContractForTaskAction(taskId: string): WorkContract | null {
  const direct = loadWorkContract(taskId);
  if (direct) return direct;

  const records = readTaskStateRecords();
  const matched = records.find((record) => taskStateRecordMatchesId(record as RuntimeTaskStateRecord, taskId));
  if (!matched) return null;

  const matchedWorkContractId = asString(matched.workContractId || matched.work_contract_id || matched.id);
  if (matchedWorkContractId) {
    const byId = loadWorkContract(matchedWorkContractId);
    if (byId) return byId;
  }

  const embedded = asRecord(matched.workContract || matched.work_contract) as Partial<WorkContract>;
  return asString(embedded.workContractId) ? embedded as WorkContract : null;
}

function issueRetryDelegationTicket(db: NonNullable<ReturnType<typeof openRuntimeLedger>["db"]>, contract: WorkContract, attemptId: string, nowIso: string): string {
  const ticketId = `retry:${contract.workContractId}:${attemptId}`;
  const expiresAt = new Date(Date.parse(nowIso) + 24 * 60 * 60 * 1000).toISOString();
  const ticketJson = {
    ticket_id: ticketId,
    work_contract_id: contract.workContractId,
    turn_id: contract.turnId,
    session_key: contract.sessionKey,
    retry: true,
    attempt_id: attemptId,
  };
  db.prepare(
    `INSERT INTO delegation_tickets (
       ticket_id, work_contract_id, turn_id, session_key,
       delivery_target_id, expected_deliverable, complexity_final,
       status, issued_at, expires_at, ticket_json, revision
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'issued', ?, ?, ?, 0)`,
  ).run(
    ticketId,
    contract.workContractId,
    contract.turnId,
    contract.sessionKey,
    contract.continuity.threadBindingKey || contract.sessionKey,
    contract.mainContext.summary.slice(0, 200),
    null,
    nowIso,
    expiresAt,
    JSON.stringify(ticketJson),
  );
  return ticketId;
}

async function executeRetryTaskAction(taskId: string, format: "text" | "json"): Promise<{ summary: string; payload: UnknownRecord }> {
  if (!taskId) return taskActionError("retry_requires_task_id");
  const contract = findWorkContractForTaskAction(taskId);
  if (!contract) return taskActionError("work_contract_not_found", { taskId });
  const delegateTaskId = asString(contract.delegate?.delegateTaskId || contract.continuity.delegateTaskId);
  if (!delegateTaskId) return taskActionError("delegate_task_id_not_found", { taskId, workContractId: contract.workContractId });

  const openResult = openRuntimeLedger({ mode: "enforce" });
  if (openResult.status !== "ok" || !openResult.db) {
    return taskActionError("ledger_unavailable", { taskId, workContractId: contract.workContractId, dbPath: openResult.dbPath });
  }

  const db = openResult.db;
  const now = new Date();
  const nowIso = now.toISOString();
  let attemptNo = 1;
  let attemptId = "";
  let queueId = "";
  let ticketId = "";
  let sessionMode = "new_session";
  let childSessionKey = "";
  let preferredReason = "";

  try {
    db.exec("BEGIN");
    const maxRow = db.prepare("SELECT MAX(attempt_no) AS max_no FROM task_attempts WHERE work_contract_id = ?").get(contract.workContractId);
    attemptNo = maxRow && maxRow.max_no != null ? Number(maxRow.max_no) + 1 : 1;
    attemptId = `${delegateTaskId}:attempt:${attemptNo}`;
    queueId = `queue:${attemptId}`;
    ticketId = issueRetryDelegationTicket(db, contract, attemptId, nowIso);
    const preferred = selectPreferredChildSession(contract, "resume_preferred");
    preferredReason = preferred.reason;
    childSessionKey = preferred.selected?.childSessionKey ?? `child:${delegateTaskId}:attempt:${attemptNo}`;
    sessionMode = preferred.selected ? "resume_preferred" : "new_session";
    const attemptJson = {
      ticket_id: ticketId,
      work_contract_id: contract.workContractId,
      delegate_task_id: delegateTaskId,
      retry: true,
      session_mode: sessionMode,
      preferred_child_session_reason: preferredReason,
    };
    db.prepare(
      `INSERT INTO task_attempts (
         attempt_id, work_contract_id, delegate_task_id, attempt_no,
         attempt_kind, status, child_session_key, model_profile, worker_pool,
         updated_at, attempt_json, revision
       ) VALUES (?, ?, ?, ?, 'retry', 'admitted', ?, ?, ?, ?, ?, 0)`,
    ).run(
      attemptId,
      contract.workContractId,
      delegateTaskId,
      attemptNo,
      childSessionKey,
      contract.delegate?.modelProfile ?? null,
      contract.delegate?.role ?? null,
      nowIso,
      JSON.stringify(attemptJson),
    );
    db.prepare(
      `INSERT INTO scheduler_queue (
         queue_id, work_contract_id, attempt_id, queue_status, priority,
         dependency_ids_json, resource_keys_json, created_at, updated_at, revision
       ) VALUES (?, ?, ?, 'admitted', 0, '[]', '[]', ?, ?, 0)`,
    ).run(queueId, contract.workContractId, attemptId, nowIso, nowIso);
    db.prepare("UPDATE delegation_tickets SET status = 'used', used_at = ?, revision = revision + 1 WHERE ticket_id = ?").run(nowIso, ticketId);
    db.prepare(
      `INSERT INTO runtime_events (event_type, work_contract_id, attempt_id, payload_json, created_at)
       VALUES ('task_retry_requested', ?, ?, ?, ?)`,
    ).run(contract.workContractId, attemptId, JSON.stringify({ taskId, delegateTaskId, attemptNo, queueId, ticketId, sessionMode, childSessionKey }), nowIso);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    return taskActionError("retry_attempt_create_failed", { taskId, workContractId: contract.workContractId, message: error instanceof Error ? error.message : String(error) });
  } finally {
    try { db.close(); } catch {}
  }

  const queued = promoteToQueued({ queueId, contract });
  const updatedContract = markChildSessionPreferred({
    workContractId: contract.workContractId,
    childSessionKey,
    delegateTaskId,
    attemptId,
    agentRole: contract.delegate?.role ?? "default",
    modelProfile: contract.delegate?.modelProfile ?? "",
    parentSessionKey: contract.continuity.parentSessionKey || contract.sessionKey,
    threadBindingKey: contract.continuity.threadBindingKey,
    scopeFingerprint: contract.delegate?.scope.scopeFingerprint ?? "",
  }) ?? contract;
  upsertTaskStateRecord({
    id: updatedContract.workContractId,
    taskId: asString(updatedContract.telemetry.nativeTaskId || taskId),
    task_id: asString(updatedContract.telemetry.nativeTaskId || taskId),
    workContractId: updatedContract.workContractId,
    work_contract_id: updatedContract.workContractId,
    status: queued.queueStatus,
    workContractStatus: updatedContract.status,
    work_contract_status: updatedContract.status,
    route: updatedContract.route,
    sessionKey: updatedContract.sessionKey,
    session_key: updatedContract.sessionKey,
    childSessionKey,
    child_session_key: childSessionKey,
    updatedAt: nowIso,
    updated_at: nowIso,
    workContract: updatedContract,
    work_contract: updatedContract,
    retry: { attempt_no: attemptNo, attempt_id: attemptId, delegateTaskId, queue_id: queueId, ticket_id: ticketId, status: queued.queueStatus },
  });

  const payload = {
    ok: true,
    mode: "native_runtime",
    action: "retry",
    taskId,
    workContractId: contract.workContractId,
    delegateTaskId,
    attempt_no: attemptNo,
    attempt_id: attemptId,
    status: queued.queueStatus,
    queue_id: queueId,
    ticket_id: ticketId,
    child_session_key: childSessionKey,
    session_mode: sessionMode,
    preferred_child_session_reason: preferredReason,
    scheduler: queued,
  };
  const summary = format === "json" ? JSON.stringify(payload, null, 2) : `Retry admitted for ${delegateTaskId}: attempt ${attemptNo} (${attemptId}) is ${queued.queueStatus}.`;
  return { summary, payload };
}

async function executeTaskAnchorCommand(rawText: string, format: string, cwd: string): Promise<{ summary: string; payload: UnknownRecord }> {
  void cwd;
  const parsed = parseTaskAction(rawText);
  if (["stop", "approve", "reject"].includes(parsed.action)) {
    return taskActionError(`action_not_implemented: ${parsed.action}`, { action_deferred: true, action: parsed.action });
  }
  if (parsed.action === "retry") {
    return executeRetryTaskAction(parsed.taskId, normalizeTaskActionFormat(format));
  }
  if ((parsed.action || "details") === "details" && parsed.taskId) {
    checkActiveTaskRecovery({ taskId: parsed.taskId });
  }
  return buildNativeTaskActionPayload(rawText, normalizeTaskActionFormat(format));
}

function buildMinimalProjection(params: {
  taskId: string;
  status: string;
  dispatchExecuted: boolean;
  spawnExecuted: boolean;
  resultMaterialized: boolean;
  modelId?: string;
  backend?: string;
  artifactRefIds?: string[];
  childSessionKey?: string;
  runId?: string;
  childRunId?: string;
  latestAnomalyNotice?: Record<string, unknown>;
}): import("@octoclaw/contracts/status-projection").TaskStatusProjection {
  return {
    schemaVersion: "octoclaw.task_status_projection/v1" as const,
    projectionId: `exec_transition_${params.taskId}_${Date.now()}`,
    generatedAt: new Date().toISOString(),
    requestId: "",
    flowId: "",
    taskId: params.taskId,
    title: "",
    summary: "",
    taskSummary: "",
    route: "delegate" as const,
    role: "",
    backend: params.backend ?? "octoclaw.delegate",
    modelProfile: "",
    modelId: params.modelId,
    status: params.status as any,
    success: false,
    createdAt: new Date().toISOString(),
    dispatchExecuted: params.dispatchExecuted,
    spawnExecuted: params.spawnExecuted,
    resultMaterialized: params.resultMaterialized,
    elapsedMs: 0,
    artifactRefs: [],
    artifactRefIds: params.artifactRefIds ?? [],
    childSessionKey: params.childSessionKey,
    runId: params.runId,
    childRunId: params.childRunId,
    actions: [],
    latestAnomalyNotice: params.latestAnomalyNotice as any,
  };
}

export function getToolRegistrations(options: ToolRegistrationOptions = {}): ToolRegistration[] {
  return [
    {
      name: "octoclaw_route_hint",
      label: "OctoClaw Route Hint",
      description: "Submit a structured main-brain route hint so OctoClaw can merge it with system policy and return the final decision.",
      params: {
        type: "object",
        additionalProperties: false,
        properties: {
          task: { type: "string", description: "Optional task override. Defaults to the current prompt for this session." },
          command: { type: "string", description: "Optional shell command context." },
          routeHint: { type: "string", enum: ["reply", "delegate"] },
          routeObjection: { type: "boolean", description: "Set true if you disagree with the recommended route" },
          objectionReason: { type: "string", description: "Required if routeObjection is true. Why you disagree." },
          requestedRoute: { type: "string", enum: ["reply", "delegate"], description: "The route you want instead. Required if routeObjection is true." },
          workType: { type: "string", enum: ["ops", "research", "code", "review"] },
          budgetBand: { type: "string", enum: ["low", "medium", "high"], description: "Override task complexity. low=fast/cheap model, medium=standard model, high=capable model." },
          phase: { type: "string", description: "Optional phase hint such as inspect, implement, collect, report, verify." },
          reviewRequired: { type: "boolean", description: "Whether review should be required after merge." },
          confidence: { type: "number", description: "Confidence from 0 to 1." },
          reason: { type: "string", description: "Short explanation for the route hint." },
        },
        required: ["routeHint"],
      },
      execute: async (params, _rawCtx) => {
        const ctx = _rawCtx ?? {};
        const { key: existingStateKey, state: existing } = resolveToolPolicyContext(ctx, asString(params.task));
        const task = asString(params.task ?? existing?.prompt);
        if (!task) {
          return { error: "octoclaw_route_hint requires task context" };
        }
        const routeObjection = params.routeObjection === true;
        if (routeObjection && !asString(params.objectionReason)) {
          return { error: "octoclaw_route_hint requires objectionReason when routeObjection is true" };
        }
        if (routeObjection && !asString(params.requestedRoute)) {
          return { error: "octoclaw_route_hint requires requestedRoute when routeObjection is true" };
        }
        const existingRecord = asRecord(existing);
        const existingDecision = nestedRecord(existingRecord, "decision");
        const existingRequest = nestedRecord(existingDecision, "request");
        let metadata = buildPolicyMetadata(ctx, { stateKey: existingStateKey || asString(existingRequest.session_key) });
        metadata = finalizeDispatchMetadata(ctx, metadata, { stateKey: existingStateKey, state: existingRecord, cachedDecision: existingDecision });
        if (!asString(metadata.message_id)) {
          metadata.message_id = asString(existingRecord.message_id || existingRecord.inboundMessageTs || existingRecord.replyToMessageId || existingRecord.reply_to_id);
        }
        if (!asString(metadata.session_thread_id)) {
          metadata.session_thread_id = asString(existingRecord.inboundMessageTs || existingRecord.message_id || existingRecord.replyToMessageId || existingRecord.reply_to_id);
        }
        if (Object.keys(asRecord(options.judgeFastRaw)).length > 0) {
          metadata._judgeFastConfig = asRecord(options.judgeFastRaw);
        }
        if (typeof options.delegationEnabled === "boolean") {
          metadata._delegationEnabled = options.delegationEnabled;
        }
        const replaySessionKey = asString(metadata.session_key || existingRequest.session_key || existingStateKey);
        const routeHintPayload = {
          route_hint: asString(params.routeHint),
          route_objection: routeObjection,
          objection_reason: asString(params.objectionReason),
          requested_route: asString(params.requestedRoute),
          work_type: asString(params.workType),
          phase: asString(params.phase),
          review_required: params.reviewRequired === true,
          confidence: asNumber(params.confidence) ?? 0,
          reason: asString(params.reason),
          source: "main_agent",
        };
        if (sealedReplyBlocksDelegateHint(existingDecision, asString(params.routeHint), routeObjection)) {
          const payload = sealedReplyRouteHintPayload(existingDecision, routeHintPayload);
          const nextState = {
            ...(existing ?? {}),
            prompt: asString(existing?.prompt, task),
            decision: payload,
            createdAt: existing?.createdAt ?? Date.now(),
            updatedAt: Date.now(),
            delegated: existing?.delegated === true,
            delegationTool: asString(existing?.delegationTool),
            blockedTools: Array.isArray(existing?.blockedTools) ? existing?.blockedTools : [],
            routeHintSubmitted: true,
            routeHintPayload,
          };
          setPolicyStateAliasesForContext(ctx, nextState, [replaySessionKey, existingStateKey]);
          await recordPolicyReplay(
            "route_hint_blocked_by_sealed_work_contract",
            {
              sessionKey: replaySessionKey,
              sessionId: asString(ctx.sessionId),
              routeHint: asString(params.routeHint),
              finalRoute: "reply",
              workContractId: asString(asRecord(payload.work_contract).workContractId || asRecord(payload.work_contract).work_contract_id),
              reason: "route_hint_blocked_by_sealed_work_contract",
            },
            toolLogger(ctx),
            payload,
          );
          return toolResponse(policySummaryText(payload), payload);
        }
        const payload = await resolveStatelessPolicyDecision(task, {
          command: asString(params.command),
          metadata,
          routeHint: routeHintPayload,
        });
        if (asString(params.budgetBand)) {
          payload._judge_budget_band = asString(params.budgetBand);
        }
        const judgeSucceeded = asRecord(payload)._judge_succeeded === true;
        const judgeRoute = asString(asRecord(payload)._judge_route || asRecord(asRecord(payload).route_decision).judge_route || asRecord(asRecord(payload).route_decision).system_preferred_route);
        const finalRoute = asString(asRecord(payload.route_decision).route);
        const objectionAccepted = routeObjection && finalRoute === asString(params.requestedRoute);
        if (routeObjection) {
          await recordPolicyReplay(
            "route_hint_objection",
            {
              route_objection: true,
              objection_reason: truncateText(params.objectionReason, 180),
              requested_route: asString(params.requestedRoute),
              judge_route: judgeRoute,
              session_key: replaySessionKey,
              tool_name: "route_hint",
              objection_accepted: objectionAccepted,
              judge_succeeded: judgeSucceeded,
            },
            toolLogger(ctx),
            payload,
          );
        }
        const stickyPersisted = await persistStickyLane(replaySessionKey, payload, toolLogger(ctx), "route_hint");
        const nextState = {
          ...(existing ?? {}),
          prompt: task,
          decision: payload,
          createdAt: existing?.createdAt ?? Date.now(),
          updatedAt: Date.now(),
          delegated: existing?.delegated === true,
          delegationTool: asString(existing?.delegationTool),
          blockedTools: Array.isArray(existing?.blockedTools) ? existing?.blockedTools : [],
          routeHintSubmitted: true,
          routeHintPayload,
        };
        setPolicyStateAliasesForContext(ctx, nextState, [replaySessionKey, existingStateKey]);
        await recordPolicyReplay(
          "route_hint_submitted",
          {
            sessionKey: replaySessionKey,
            sessionId: asString(ctx.sessionId),
            routeHint: asString(params.routeHint),
            workType: asString(params.workType),
            phase: asString(params.phase),
            reviewRequired: params.reviewRequired === true,
            confidence: asNumber(params.confidence) ?? 0,
            reason: truncateText(params.reason, 180),
            routeObjection,
            objectionReason: truncateText(params.objectionReason, 180),
            requestedRoute: asString(params.requestedRoute),
            systemPreferredRoute: asString(asRecord(payload.route_decision).system_preferred_route),
            finalRoute: asString(asRecord(payload.route_decision).route),
            workerPool: asString(asRecord(payload.route_decision).worker_pool),
            stickyPersisted,
          },
          toolLogger(ctx),
          payload,
        );
        const objectionMessage = routeObjection
          ? (finalRoute === asString(params.requestedRoute)
              ? "objection accepted, using your route"
              : "objection escalated to remote adjudication; using judge recommendation")
          : "";
        const nextSummaryBase = asString(asRecord(payload.route_decision).route) === "reply"
          ? "route_hint merged: final route is reply. You may answer directly."
          : `route_hint merged: final route is ${asString(asRecord(payload.route_decision).route, "delegate")}. Next call octoclaw_dispatch.`;
        const nextSummary = objectionMessage ? `${objectionMessage}; ${nextSummaryBase}` : nextSummaryBase;
        return toolResponse(nextSummary, payload);
      },
    },
    {
      name: "octoclaw_policy_decide",
      label: "OctoClaw Policy Decide",
      description: "Debug/parity helper that returns the structured OctoClaw runtime policy decision object, including route, model/profile, skill bundle, review policy, and hook interface hints.",
      params: {
        type: "object",
        additionalProperties: false,
        properties: {
          task: { type: "string", description: "The user task to classify and route." },
          command: { type: "string", description: "Optional shell command if one already exists." },
          channel: { type: "string", description: "Optional transport/origin hint such as slack, wechat, webchat, or any other IM identifier." },
          sessionKey: { type: "string", description: "Optional main session key." },
          forceRoute: { type: "string", enum: ["reply", "delegate"] },
          metadataJson: { type: "string", description: "Optional JSON object with extra routing metadata." },
        },
        required: ["task"],
      },
      execute: async (params, _rawCtx) => {
        const ctx = _rawCtx ?? {};
        let metadata = applyUserMetadataOverrides(buildPolicyMetadata(ctx), parseObjectJson(params.metadataJson));
        if (asString(params.channel)) metadata.channel = asString(params.channel);
        if (asString(params.sessionKey)) metadata.session_key = asString(params.sessionKey);
        metadata = finalizeDispatchMetadata(ctx, metadata, { stateKey: asString(params.sessionKey) });
        const task = asString(params.task);
        const payload = await resolveStatelessPolicyDecision(asString(params.task), {
          command: asString(params.command),
          metadata,
          forceRoute: asString(params.forceRoute),
        });
        const json: UnknownRecord = {
          ...asRecord(payload),
          managed_agent_context: isManagedAgentContext(ctx),
        };
        const routeHintPolicy = asRecord(json.route_hint_policy);
        const request = asRecord(json.request);
        const replaySessionKey = asString(request.session_key || metadata.session_key || params.sessionKey);
        const existing = replaySessionKey ? policyState.get(replaySessionKey) : undefined;
        setPolicyStateAliasesForContext(ctx, {
          ...(existing ?? {}),
          prompt: task,
          decision: json,
          canonicalSessionKey: asString(existing?.canonicalSessionKey) || replaySessionKey,
          routeHintSubmitted: routeHintPolicy.submitted === true,
          routeHintPayload: asRecord(asRecord(request.metadata).route_hint_payload),
        }, [replaySessionKey]);
        return toolResponse(policySummaryText(json), json);
      },
    },
    {
      name: "octoclaw_route",
      label: "OctoClaw Route",
      description: "Debug/parity helper that exposes the current Node-side route decision for a task.",
      params: {
        type: "object",
        additionalProperties: false,
        properties: {
          task: { type: "string", description: "The user task to classify." },
          command: { type: "string", description: "Optional shell command if the task already includes one." },
        },
        required: ["task"],
      },
      execute: async (params, _rawCtx) => {
        const ctx = _rawCtx ?? {};
        const payload = await resolveStatelessPolicyDecision(asString(params.task), {
          command: asString(params.command),
          metadata: buildPolicyMetadata(ctx),
        });
        return toolResponse(policySummaryText(payload), payload);
      },
    },
    {
      name: "octoclaw_dispatch",
      label: "OctoClaw Dispatch",
      description: "Run OctoClaw dispatch so reply or delegated work follows the runtime policy plan. Read-only observation uses delegate + observer role.",
      params: {
        type: "object",
        additionalProperties: false,
        properties: {
          task: { type: "string", description: "The task to dispatch." },
          command: { type: "string", description: "Optional shell command context for the routed task." },
          cwd: { type: "string", description: "Optional working directory override." },
          forceRoute: { type: "string", enum: ["auto", "reply", "delegate"] },
          complexityBand: { type: "string", enum: ["simple", "normal", "deep"], description: "Task complexity band. simple=light research/observer work, normal=GLM-5.1, deep=gpt-5.4" },
          expectedSeconds: { type: "number", description: "Main agent's estimate of how long this task should take. Used as timeout baseline." },
          timeoutSeconds: { type: "number", description: "Runner timeout in seconds." },
          sessionKey: { type: "string", description: "Optional session key override." },
          metadataJson: { type: "string", description: "Optional JSON object with extra session metadata. For delegated work, include known anchors as context_refs: { primaryFiles, readScope, writeScope, sourcePolicy, maxToolCalls, workspaceMode }." },
          policyJson: { type: "string", description: "Optional precomputed runtime policy decision JSON." },
          workContractId: { type: "string", description: "Optional sealed WorkContract id to dispatch without re-judging." },
          delegateTaskId: { type: "string", description: "Optional delegate task id for continuation-aware dispatch." },
          continuationMode: { type: "string", enum: ["resume_preferred", "status_only", "new_attempt"], description: "Optional continuation hint for WorkContract dispatch." },
        },
        required: ["task"],
      },
      execute: async (params, _rawCtx) => {
        const ctx = _rawCtx ?? {};
        const dispatchToolStartedAt = Date.now();
        let { key: stateKey, state } = resolveDispatchPolicyContext(ctx, asString(params.task));
        let hadCachedDecision = Boolean(params.policyJson || state?.decision);
        let cachedDecision = selectDispatchPolicyDecision(state?.decision, params.policyJson);
        let dispatchWorkContract: WorkContract | null = null;
        let workContractDispatchError: { route: string; error: string } | null = null;
        const requestedWorkContractId = selectDispatchWorkContractId(asRecord(params), cachedDecision)
          || asString(state?.workContractId || state?.work_contract_id);
        if (requestedWorkContractId) {
          const validation = validateDispatchWorkContract(loadWorkContract(requestedWorkContractId), requestedWorkContractId);
          if (validation.ok) {
            dispatchWorkContract = validation.contract;
            cachedDecision = decisionFromWorkContract(dispatchWorkContract, cachedDecision);
            hadCachedDecision = true;
          } else {
            workContractDispatchError = { route: validation.route, error: validation.error };
            cachedDecision = cachedDecision ?? {
              request: { session_key: stateKey || asString(params.sessionKey) },
              route_decision: { route: validation.route },
              workContractId: requestedWorkContractId,
            };
          }
        }
        let freshDecisionSource = "";
        if (!cachedDecision) {
          cachedDecision = await resolveStatelessPolicyDecision(asString(params.task), {
            command: asString(params.command),
            metadata: buildPolicyMetadata(ctx, { stateKey }),
            forceRoute: asString(params.forceRoute === "auto" ? "" : params.forceRoute),
          });
          freshDecisionSource = "fresh_context_resolve";
        }
        const promoteBudgetedMainDispatch = shouldPromoteBudgetedMainDispatch({
          decision: cachedDecision,
          state,
          workContract: dispatchWorkContract,
        });
        if (promoteBudgetedMainDispatch) {
          const routeDecision = asRecord(cachedDecision.route_decision);
          const reason = asString(
            cachedDecision._budgeted_main_escalation_reason
            || routeDecision.reason
            || asRecord(state?.budgetedMain || state?.budgeted_main).reason,
            "main_agent_called_dispatch",
          );
          cachedDecision = escalateBudgetedMainDecision(cachedDecision, reason);
          hadCachedDecision = true;
        }
        const initialMetadata = applyUserMetadataOverrides(
          {
            ...buildPolicyMetadata(ctx, { stateKey: stateKey || asString(asRecord(cachedDecision.request).session_key) }),
            ...(asString(params.sessionKey) ? { session_key: asString(params.sessionKey) } : {}),
          },
          parseObjectJson(params.metadataJson),
        );
        const managedSessionKey = asString(asRecord(cachedDecision.request).session_key || initialMetadata.session_key);
        const requestedForceRoute = asString(params.forceRoute === "auto" ? "" : params.forceRoute);
        const resolvedRoute = normalizeLiveRoute(
          requestedForceRoute || (promoteBudgetedMainDispatch ? "delegate" : asRecord(cachedDecision.route_decision).route),
          "reply",
        );
        const isDelegatedRoute = resolvedRoute === "delegate";
        const runtimeLedgerMode = resolveRuntimeLedgerMode();
        const recordDispatchTerminalFailure = async (errorMessage: string, options: { sealMismatch?: boolean; route?: string | null } = {}) => {
          await recordPolicyReplay("dispatch_terminal_failure", {
            sessionKey: managedSessionKey,
            sessionId: asString(ctx.sessionId),
            route: options.route ?? resolvedRoute,
            error: errorMessage,
            sealMismatch: options.sealMismatch === true,
            retryable: false,
            terminal: true,
          }, toolLogger(ctx));
        };
        if (workContractDispatchError) {
          await recordDispatchTerminalFailure(workContractDispatchError.error, { route: workContractDispatchError.route });
          return dispatchHonestyFailure({
            route: workContractDispatchError.route,
            error: workContractDispatchError.error,
            sealMismatch: false,
            retryable: false,
            terminal: true,
            details: {
              dispatch_executed: false,
              spawn_executed: false,
              materialized: false,
              result_materialized: false,
            },
          });
        }
        const routeSealState = selectRouteSealState(ctx, stateKey, state);
        const cachedRouteSeal = validCachedRouteSeal(routeSealState, cachedDecision, initialMetadata);
        if (!hadCachedDecision && isDelegatedRoute && managedSessionKey && !params.policyJson) {
          const driftSummary = `sealed_decision_required: managed session ${managedSessionKey.slice(0, 40)}… requires cached/passed policy for delegated route=${resolvedRoute}; got fresh decision from freeform prompt (source=${freshDecisionSource}). This violates §4.6.1 (dispatch must not re-judge).`;
          await recordPolicyReplay("sealed_decision_required", {
            sessionKey: managedSessionKey,
            sessionId: asString(ctx.sessionId),
            route: resolvedRoute,
            freshDecisionSource,
            hadCachedDecision: false,
            policyJsonProvided: false,
          }, toolLogger(ctx));
          await recordDispatchTerminalFailure(driftSummary);
          return dispatchHonestyFailure({
            route: resolvedRoute,
            error: driftSummary,
            sealMismatch: false,
            retryable: false,
            terminal: true,
          });
        }
        const budgetedMainEscalationAllowed = cachedRouteSeal
          ? isBudgetedMainDispatchEscalationAllowed({
              cachedRouteSeal,
              cachedDecision,
              resolvedRoute,
              hadCachedDecision,
              routeSealState,
            })
          : false;
        if (cachedRouteSeal && resolvedRoute !== cachedRouteSeal.route && !budgetedMainEscalationAllowed) {
          const driftSummary = `sealed_decision_required: managed session ${managedSessionKey.slice(0, 40)}… requires sealed route=${cachedRouteSeal.route}; got dispatch route=${resolvedRoute}. This violates §4.6.1 (dispatch must not re-route after seal).`;
          await recordPolicyReplay("sealed_decision_required", {
            sessionKey: managedSessionKey,
            sessionId: asString(ctx.sessionId),
            route: resolvedRoute,
            sealedRoute: cachedRouteSeal.route,
            hadCachedDecision,
            policyJsonProvided: Boolean(params.policyJson),
          }, toolLogger(ctx), cachedDecision);
          await recordDispatchTerminalFailure(driftSummary, { sealMismatch: true });
          return dispatchHonestyFailure({
            route: resolvedRoute,
            error: driftSummary,
            sealMismatch: true,
            retryable: false,
            terminal: true,
          });
        } else if (cachedRouteSeal && budgetedMainEscalationAllowed) {
          await recordPolicyReplay("sealed_budgeted_main_dispatch_allowed", {
            sessionKey: managedSessionKey,
            sessionId: asString(ctx.sessionId),
            route: resolvedRoute,
            sealedRoute: cachedRouteSeal.route,
            decision_bucket: "budgeted_main_then_delegate",
            hadCachedDecision,
            policyJsonProvided: Boolean(params.policyJson),
          }, toolLogger(ctx), cachedDecision);
        }
        let metadata = initialMetadata;
        metadata = finalizeDispatchMetadata(ctx, metadata, { stateKey, state, cachedDecision });
        metadata.requested_route = normalizeLiveRoute(resolvedRoute, "reply");
        await recordPolicyReplay("dispatch_tool_started", {
          sessionKey: managedSessionKey || stateKey || asString(params.sessionKey),
          sessionId: asString(ctx.sessionId),
          route: resolvedRoute,
          stateKey,
          hadCachedDecision,
          policyJsonProvided: Boolean(params.policyJson),
          work_contract_id: asString(requestedWorkContractId || asRecord(cachedDecision.work_contract).workContractId || asRecord(cachedDecision.work_contract).work_contract_id || cachedDecision.workContractId),
          elapsedMs: Date.now() - dispatchToolStartedAt,
        }, toolLogger(ctx), null).catch(() => undefined);
        if (dispatchWorkContract) {
          metadata.workContractId = dispatchWorkContract.workContractId;
          metadata.work_contract_id = dispatchWorkContract.workContractId;
          const continuationMode = asString(params.continuationMode, dispatchWorkContract.continuity.continuationMode);
          metadata.continuationMode = continuationMode;
          metadata.continuation_mode = continuationMode;
          if (continuationMode === "resume_preferred") {
            const preferred = selectPreferredChildSession(dispatchWorkContract, "resume_preferred");
            if (preferred.selected) {
              metadata.child_session_key = preferred.selected.childSessionKey;
              metadata.childSessionKey = preferred.selected.childSessionKey;
              if (preferred.selected.childSessionId) {
                metadata.child_session_id = preferred.selected.childSessionId;
              }
            }
          }
        }
        if (asString(params.delegateTaskId)) {
          metadata.delegateTaskId = asString(params.delegateTaskId);
          metadata.delegate_task_id = asString(params.delegateTaskId);
        }

        const complexityBand = asString(params.complexityBand || asRecord(cachedDecision)._judge_complexity_band || asRecord(asRecord(cachedDecision).route_decision)._judge_complexity_band);
        const budgetBand = asString(asRecord(cachedDecision._judge_budget_band ?? asRecord(cachedDecision.route_decision)._judge_budget_band));

        // Dynamic model map: reads openclaw models list and maps fallback rank to complexity bands.
        // In-memory cached (5-min TTL). Falls back to hardcoded defaults if CLI unavailable.
        const modelMap = await getModelMap();
        const complexityModelMap = modelMap.complexity as unknown as Record<string, string>;
        const budgetModelMap = modelMap.budget as unknown as Record<string, string>;
        const selectedModel = complexityBand && complexityModelMap[complexityBand]
          ? complexityModelMap[complexityBand]
          : budgetBand && budgetModelMap[budgetBand]
            ? budgetModelMap[budgetBand]
            : "";
        if (complexityBand) {
          metadata.complexity_band = complexityBand;
        }
        if (selectedModel) {
          metadata.model = selectedModel;
        }

        const expectedSeconds = asNumber(params.expectedSeconds) || 0;
        if (expectedSeconds > 0) {
          metadata.expected_seconds = expectedSeconds;
          metadata.expected_at = Date.now() + expectedSeconds * 1000;
        }

        const existingNativePlannerRefs = confirmedNativePlannerRefs(dispatchWorkContract);
        if (isDelegatedRoute && dispatchWorkContract && existingNativePlannerRefs) {
          const replaySessionKey = resolveDispatchSessionKey(ctx, metadata, { stateKey, state, cachedDecision })
            || asString(metadata.session_key || managedSessionKey || stateKey);
          const delegateTaskId = asString(dispatchWorkContract?.delegate?.delegateTaskId);
          const attemptId = asString(dispatchWorkContract?.delegate?.currentAttemptId);
          const nextState = {
            ...(state ?? {}),
            prompt: asString(params.task),
            decision: cachedDecision,
            delegated: true,
            dispatchRoute: "delegate",
            dispatchStatus: "already_started",
            dispatchExecuted: true,
            spawnExecuted: true,
            resultMaterialized: false,
            result_materialized: false,
            childSessionKey: existingNativePlannerRefs.childSessionKey,
            childRunId: existingNativePlannerRefs.childRunId || existingNativePlannerRefs.runId,
            runId: existingNativePlannerRefs.runId,
            workContractId: dispatchWorkContract.workContractId,
            spawnIntentId: existingNativePlannerRefs.spawnIntentId,
            updatedAt: Date.now(),
          };
          setPolicyStateForContext(ctx, nextState, replaySessionKey || stateKey);
          if (stateKey && replaySessionKey && stateKey !== replaySessionKey) {
            setPolicyStateForContext(ctx, nextState, stateKey);
          }
          await recordPolicyReplay("dispatch_native_spawn_already_started", {
            sessionKey: replaySessionKey,
            sessionId: asString(ctx.sessionId),
            route: "delegate",
            work_contract_id: dispatchWorkContract.workContractId,
            delegate_task_id: delegateTaskId,
            attempt_id: attemptId,
            spawn_intent_id: existingNativePlannerRefs.spawnIntentId,
            run_id: existingNativePlannerRefs.runId,
            child_run_id: existingNativePlannerRefs.childRunId || existingNativePlannerRefs.runId,
            child_session_key: existingNativePlannerRefs.childSessionKey,
            dispatch_executed: true,
            spawn_executed: true,
            materialized: false,
          }, toolLogger(ctx), null);
          return nativePlannerAlreadyStartedResponse({
            workContract: dispatchWorkContract,
            refs: existingNativePlannerRefs,
            workerPool: asString(asRecord(cachedDecision.route_decision).worker_pool),
            model: selectedModel || asString(metadata.model),
          });
        }

        const helperInvoker = readHelperInvoker(asRecord(metadata).helperInvoker, ctx.helperInvoker);
        let schedulerQueueId = "";
        let schedulerDispatchState: "inactive" | "bypassed" | "leased" = "inactive";
        const releaseSchedulerQueue = (outcome: "completed" | "failed" | "cancelled", errorMessage?: string) => {
          if (!schedulerQueueId || schedulerDispatchState !== "leased") return;
          const result = releaseOrComplete({
            queueId: schedulerQueueId,
            outcome,
            errorCode: errorMessage ? outcome : undefined,
            errorMessage,
            terminalSummary: errorMessage,
          });
          if (!result.ok) {
            warnToolLogger(ctx, `scheduler release failed: ${result.error || "unknown_error"}`);
          }
        };

        if (isDelegatedRoute) {
          const spawnBackend = resolveSpawnBackend();
          const plannerSessionCandidates = dispatchPlannerSessionCandidates(
            managedSessionKey,
            stateKey,
            params.sessionKey,
            metadata.session_key,
            initialMetadata.session_key,
            ctx.sessionKey,
            ctx.canonicalSessionKey,
            ctx.sessionId,
            state?.canonicalSessionKey,
            state?.canonical_session_key,
            state?.ackGuardKey,
            state?.ack_guard_key,
            state?.sessionKey,
            state?.session_key,
            asRecord(state?.deliveryTarget).sessionKey,
            asRecord(state?.deliveryTarget).session_key,
            asRecord(state?.delivery_target).sessionKey,
            asRecord(state?.delivery_target).session_key,
          );
          const plannerAllowedCandidates = plannerSessionCandidates.filter((candidate) => isPlannerAllowedForSession(candidate));
          const plannerEnabled = spawnBackend === "planner"
            && plannerAllowedCandidates.length > 0;
          await recordPolicyReplay("dispatch_backend_selected", {
            sessionKey: managedSessionKey || stateKey || asString(params.sessionKey),
            sessionId: asString(ctx.sessionId),
            route: resolvedRoute,
            spawn_backend: spawnBackend,
            planner_enabled: plannerEnabled,
            planner_session_candidates: plannerSessionCandidates.slice(0, 12),
            planner_allowed_candidates: plannerAllowedCandidates.slice(0, 12),
            planner_allowlist_size: resolvePlannerAllowlist().length,
            helper_invoker_present: Boolean(helperInvoker),
          }, toolLogger(ctx), null).catch(() => undefined);
          if (spawnBackend === "off") {
            const errorMessage = "spawn_backend_off";
            await recordDispatchTerminalFailure(errorMessage, { route: resolvedRoute });
            return dispatchHonestyFailure({
              route: resolvedRoute,
              error: errorMessage,
              retryable: false,
              terminal: true,
            });
          }
          if (spawnBackend === "planner" && !plannerEnabled) {
            const errorMessage = "planner_not_allowed_for_session";
            await recordPolicyReplay("dispatch_planner_not_allowed", {
              sessionKey: managedSessionKey || stateKey || asString(params.sessionKey),
              sessionId: asString(ctx.sessionId),
              route: resolvedRoute,
              error: errorMessage,
              planner_session_candidates: plannerSessionCandidates.slice(0, 12),
              planner_allowlist_size: resolvePlannerAllowlist().length,
              retryable: false,
              terminal: true,
            }, toolLogger(ctx), null);
            await recordDispatchTerminalFailure(errorMessage, { route: resolvedRoute });
            return dispatchHonestyFailure({
              route: resolvedRoute,
              error: errorMessage,
              retryable: false,
              terminal: true,
            });
          }

          // Preflight checks the execution backend that dispatch will use. The helperInvoker path
          // is a native execution path, so only probe the dist taskflow port when dispatch will use it.
          if (!plannerEnabled && !helperInvoker) {
            const taskflowCheck = await checkTaskflowCapability(createOpenClawDistTaskFlowPort());
            if (!taskflowCheck.available) {
              const errorMessage = `taskflow_unavailable: ${taskflowCheck.reason || "unknown_error"}`;
              await recordPolicyReplay("dispatch_capability_failure", {
                sessionKey: managedSessionKey,
                sessionId: asString(ctx.sessionId),
                route: resolvedRoute,
                error: errorMessage,
                retryable: false,
                terminal: true,
              }, toolLogger(ctx));
              await recordDispatchTerminalFailure(errorMessage);
              return dispatchHonestyFailure({
                route: resolvedRoute,
                error: errorMessage,
                retryable: false,
                terminal: true,
              });
            }
          }
          const ticketCandidate = buildDelegationTicketDryRun({
            contract: dispatchWorkContract,
            decision: cachedDecision,
            payload: { task: asString(params.task) },
            metadata,
          });
          cachedDecision.delegation_ticket_candidate = asRecord(cachedDecision.delegation_ticket_candidate).ticket_decision
            ? cachedDecision.delegation_ticket_candidate
            : ticketCandidate;
          // Backstop against repeat delegated execution: policyState may know about a recent
          // delegated receipt even when metadata lacks relation_to_recent_execution.
          const recentDelegated = policyState.findRecentDelegated(asString(params.task));
          const recentDelegatedInCurrentContext = Boolean(recentDelegated) && [
            stateKey,
            managedSessionKey,
            asString(params.sessionKey),
            asString(initialMetadata.session_key),
          ].filter(Boolean).includes(asString(recentDelegated?.key));
          const rejectedAsFollowup = ticketCandidate.ticket_decision !== "ticket_would_issue"
            && ticketCandidate.ticket_denial_reason === "not_new_work"
            && hasNonNewWorkFollowupEvidence(cachedDecision, metadata);
          if (recentDelegated && recentDelegatedInCurrentContext && rejectedAsFollowup) {
            const fallbackBody = {
              ok: true,
              route: "reply",
              dispatch_skipped: true,
              fallback_to_main_reply: true,
              reason: "not_new_work",
              guard: "recent_delegated_execution_guard",
              rejection_reason: "recent_delegated_without_new_work_ticket",
              recent_delegated_key: recentDelegated.key,
              ticket_decision: ticketCandidate.ticket_decision,
              ticket_denial_reason: ticketCandidate.ticket_denial_reason,
              is_new_work: ticketCandidate.is_new_work,
              expected_deliverable: ticketCandidate.expected_deliverable,
              work_contract_id: ticketCandidate.work_contract_id ?? null,
              ticket_id: ticketCandidate.ticket_id ?? null,
              dispatch_executed: false,
              spawn_executed: false,
              materialized: false,
              main_session_action: "answer_followup_or_refresh_status",
            };
            await recordPolicyReplay("dispatch_recent_delegated_reused_main_reply", {
              sessionKey: managedSessionKey,
              sessionId: asString(ctx.sessionId),
              route: resolvedRoute,
              recent_delegated_key: recentDelegated.key,
              ticket_decision: ticketCandidate.ticket_decision,
              ticket_denial_reason: ticketCandidate.ticket_denial_reason,
              is_new_work: ticketCandidate.is_new_work,
              expected_deliverable: ticketCandidate.expected_deliverable,
              work_contract_id: ticketCandidate.work_contract_id ?? null,
              ticket_id: ticketCandidate.ticket_id ?? null,
              dispatch_executed: false,
              spawn_executed: false,
              materialized: false,
              fallback_to_main_reply: true,
              terminal: false,
            }, toolLogger(ctx), cachedDecision);
            return toolResponse(JSON.stringify(fallbackBody), fallbackBody);
          }
          if (plannerEnabled) {
            if (ticketCandidate.ticket_decision !== "ticket_would_issue") {
              const errorMessage = `delegation_ticket_rejected:${ticketCandidate.ticket_denial_reason || "not_new_work"}`;
              await recordPolicyReplay("dispatch_planner_ticket_rejected", {
                sessionKey: managedSessionKey,
                sessionId: asString(ctx.sessionId),
                route: resolvedRoute,
                error: errorMessage,
                ticket_decision: ticketCandidate.ticket_decision,
                ticket_denial_reason: ticketCandidate.ticket_denial_reason,
                dispatch_executed: false,
                spawn_executed: false,
                materialized: false,
                terminal: true,
              }, toolLogger(ctx), cachedDecision);
              await recordDispatchTerminalFailure(errorMessage, { route: resolvedRoute });
              return dispatchHonestyFailure({
                route: resolvedRoute,
                error: errorMessage,
                retryable: false,
                terminal: true,
                details: {
                  rejected: true,
                  rejection_reason: ticketCandidate.ticket_denial_reason || "not_new_work",
                  ticket_decision: ticketCandidate.ticket_decision,
                  dispatch_executed: false,
                  spawn_executed: false,
                  materialized: false,
                },
              });
            }

            const workContractId = dispatchWorkContract?.workContractId
              || asString(ticketCandidate.work_contract_id)
              || asString(asRecord(cachedDecision.work_contract).workContractId);
            if (!workContractId) {
              const errorMessage = "planner_requires_work_contract";
              await recordDispatchTerminalFailure(errorMessage, { route: resolvedRoute });
              return dispatchHonestyFailure({ route: resolvedRoute, error: errorMessage, retryable: false, terminal: true });
            }

            const ticketCandidateRecord = ticketCandidate as unknown as UnknownRecord;
            const delegateTaskId = plannedDelegateTaskId(workContractId, ticketCandidateRecord, dispatchWorkContract);
            const attemptId = plannedAttemptId(delegateTaskId, ticketCandidateRecord, dispatchWorkContract);
            const sessionsSpawnArgs = buildPlannerSessionsSpawnArgs({
              task: asString(params.task),
              workContractId,
              delegateTaskId,
              attemptId,
              expectedDeliverable: asString(ticketCandidate.expected_deliverable),
              selectedModel,
              cwd: asString(params.cwd, ctxCwd(ctx)),
              expectedSeconds,
              timeoutSeconds: asNumber(params.timeoutSeconds),
              preferredChildSessionKey: asString(metadata.childSessionKey || metadata.child_session_key)
                || dispatchWorkContract?.continuity.preferredChildSessionKey
                || undefined,
              label: asString(asRecord(dispatchWorkContract?.mainContext).summary || params.task),
              decision: cachedDecision,
              metadata,
              workContract: dispatchWorkContract,
            });
            const pluginConfig = options.pluginConfigProvider?.() ?? options.pluginConfig;
            const speculativePreloadEnabled = resolveSpeculativePreloadEnabled(pluginConfig);
            const speculativeSelectionKeys = [
              managedSessionKey,
              stateKey,
              params.sessionKey,
              metadata.session_key,
              initialMetadata.session_key,
              ctx.sessionKey,
              ctx.canonicalSessionKey,
              ctx.sessionId,
              ...plannerSessionCandidates,
            ];
            const latestSpeculative = speculativePreloadEnabled
              ? selectLatestSpeculativePreloadCandidate({
                  keys: speculativeSelectionKeys,
                  fallbackState: state,
                })
              : null;
            const latestSpawnArgs = asRecord(latestSpeculative?.speculative.spawnArgs);
            if (latestSpeculative?.speculative.status === "hinted" && Object.keys(latestSpawnArgs).length > 0) {
              await recordPolicyReplay("speculative_preload_dispatch_deferred", {
                sessionKey: latestSpeculative.key || managedSessionKey || stateKey || asString(params.sessionKey),
                sessionId: asString(ctx.sessionId),
                route: resolvedRoute,
                toolName: "octoclaw_dispatch",
                label: latestSpeculative.speculative.label,
                reason: "standby_spawn_required",
                status: latestSpeculative.speculative.status,
                candidate_key: latestSpeculative.key,
                dispatch_executed: false,
                spawn_executed: false,
                materialized: false,
                elapsedMs: Date.now() - dispatchToolStartedAt,
              }, toolLogger(ctx), null).catch(() => undefined);
              return speculativePreloadStandbyRequiredResponse({
                label: latestSpeculative.speculative.label,
                sessionsSpawnArgs: latestSpawnArgs,
                candidateKey: latestSpeculative.key,
                status: latestSpeculative.speculative.status,
              });
            }
            const speculativeSelection = speculativePreloadEnabled
              ? selectSpeculativePreloadForDispatch({
                  keys: speculativeSelectionKeys,
                  fallbackState: state,
                })
              : { speculative: null, candidateKey: "", reason: "disabled", status: "" };
            const speculative = speculativeSelection.speculative;
            const useSpeculativeSend = Boolean(speculative?.label);
            if (speculativePreloadEnabled && !useSpeculativeSend) {
              await recordPolicyReplay("speculative_preload_dispatch_fallback", {
                sessionKey: managedSessionKey || stateKey || asString(params.sessionKey),
                sessionId: asString(ctx.sessionId),
                route: resolvedRoute,
                reason: speculativeSelection.reason,
                status: speculativeSelection.status,
                candidate_key: speculativeSelection.candidateKey,
              }, toolLogger(ctx), cachedDecision).catch(() => undefined);
            }
            const sessionsSendArgs = useSpeculativeSend && speculative?.label
              ? buildSpeculativeSessionsSendArgs({
                  label: speculative.label,
                  agentId: asString(ctx.agentId),
                  message: asString(sessionsSpawnArgs.task),
                }) as unknown as Record<string, unknown>
              : null;
            const dispatchMode = useSpeculativeSend ? "send_to_speculative" as const : "new_spawn" as const;
            const nativeIntentArgs = (sessionsSendArgs || sessionsSpawnArgs) as { task: string; [key: string]: unknown };
            let intent: ReturnType<typeof nativeSpawnIntentStore.create>;
            try {
              intent = nativeSpawnIntentStore.create({
                workContractId,
                delegateTaskId,
                attemptId,
                sessionKey: managedSessionKey || stateKey || asString(params.sessionKey),
                sessionsSpawnArgs: nativeIntentArgs,
                dispatchMode,
                speculativeSessionLabel: useSpeculativeSend ? speculative?.label : undefined,
                ttlMs: resolveSpawnIntentTtlMs(),
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              const errorMessage = message.includes("SQLITE") || message.includes("sqlite")
                ? "native_spawn_intent_store_unavailable"
                : "native_spawn_intent_create_failed";
              await recordDispatchTerminalFailure(errorMessage, { route: resolvedRoute });
              return dispatchHonestyFailure({ route: resolvedRoute, error: errorMessage, retryable: true, terminal: false });
            }

            const ticketIssue = dispatchWorkContract
              ? issueDelegationTicketCandidate({
                  contract: dispatchWorkContract,
                  candidate: ticketCandidate,
                })
              : { ok: false, skipped: true, reason: "missing_work_contract" };
            const ticketAdmission = admitDelegationTicketForDispatch({
              contract: dispatchWorkContract,
              candidate: ticketCandidate,
              delegateTaskId,
              attemptId,
              workerPool: asString(asRecord(cachedDecision.route_decision).worker_pool),
              modelProfile: selectedModel || asString(metadata.model),
            });
            if (!ticketAdmission.allowed) {
              try {
                nativeSpawnIntentStore.markFailed({
                  spawnIntentId: intent.spawnIntentId,
                  workContractId,
                  sessionKey: managedSessionKey || stateKey || asString(params.sessionKey),
                  error: `delegation_ticket_rejected:${ticketAdmission.reason}`,
                });
              } catch {}
              const errorMessage = `delegation_ticket_rejected:${ticketAdmission.reason}`;
              await recordPolicyReplay("dispatch_planner_ticket_rejected", {
                sessionKey: managedSessionKey,
                sessionId: asString(ctx.sessionId),
                route: resolvedRoute,
                error: errorMessage,
                ticket_decision: ticketCandidate.ticket_decision,
                ticket_denial_reason: ticketAdmission.reason,
                is_new_work: ticketCandidate.is_new_work,
                expected_deliverable: ticketCandidate.expected_deliverable,
                work_contract_id: ticketAdmission.work_contract_id ?? ticketCandidate.work_contract_id ?? null,
                ticket_id: ticketAdmission.ticket_id ?? ticketCandidate.ticket_id ?? null,
                attempt_id: ticketAdmission.attempt_id ?? attemptId,
                queue_id: ticketAdmission.queue_id ?? null,
                spawn_intent_id: intent.spawnIntentId,
                dispatch_executed: false,
                spawn_executed: false,
                materialized: false,
                retryable: ticketAdmission.reason === "ledger_unavailable",
                terminal: ticketAdmission.reason !== "ledger_unavailable",
              }, toolLogger(ctx), cachedDecision);
              await recordDispatchTerminalFailure(errorMessage, { route: resolvedRoute });
              return dispatchHonestyFailure({
                route: resolvedRoute,
                error: errorMessage,
                retryable: ticketAdmission.reason === "ledger_unavailable",
                terminal: ticketAdmission.reason !== "ledger_unavailable",
                details: {
                  rejected: true,
                  rejection_reason: ticketAdmission.reason,
                  ticket_decision: ticketCandidate.ticket_decision,
                  ticket_denial_reason: ticketAdmission.reason,
                  is_new_work: ticketCandidate.is_new_work,
                  expected_deliverable: ticketCandidate.expected_deliverable,
                  work_contract_id: ticketAdmission.work_contract_id ?? ticketCandidate.work_contract_id ?? null,
                  ticket_id: ticketAdmission.ticket_id ?? ticketCandidate.ticket_id ?? null,
                  attempt_id: ticketAdmission.attempt_id ?? attemptId,
                  queue_id: ticketAdmission.queue_id ?? null,
                  spawn_intent_id: intent.spawnIntentId,
                  dispatch_executed: false,
                  spawn_executed: false,
                  materialized: false,
                },
              });
            }

            const nextState = {
              ...(state ?? {}),
              prompt: asString(params.task),
              decision: cachedDecision,
              delegated: false,
              dispatchRoute: "delegate",
              dispatchStatus: "requires_native_spawn",
              dispatchExecuted: false,
              spawnExecuted: false,
              spawnIntentId: intent.spawnIntentId,
              workContractId,
              dispatchMode,
              dispatch_mode: dispatchMode,
              ...(useSpeculativeSend && speculative?.label ? {
                speculativePreload: serializeSpeculativePreloadState({
                  ...speculative,
                  status: "dispatched",
                  updatedAt: Date.now(),
                }),
                speculative_preload: serializeSpeculativePreloadState({
                  ...speculative,
                  status: "dispatched",
                  updatedAt: Date.now(),
                }),
              } : {}),
              updatedAt: Date.now(),
            };
            setPolicyStateForContext(ctx, nextState, managedSessionKey || stateKey);
            if (stateKey && managedSessionKey && stateKey !== managedSessionKey) {
              setPolicyStateForContext(ctx, nextState, stateKey);
            }
            await recordPolicyReplay("dispatch_planner_intent_created", {
              sessionKey: managedSessionKey,
              sessionId: asString(ctx.sessionId),
              route: resolvedRoute,
              work_contract_id: workContractId,
              delegate_task_id: delegateTaskId,
              attempt_id: attemptId,
              ticket_id: ticketAdmission.ticket_id ?? null,
              queue_id: ticketAdmission.queue_id ?? null,
              ticket_issue_ok: ticketIssue.ok === true,
              ticket_issue_reason: ticketIssue.reason ?? "",
              ticket_admission_reason: ticketAdmission.reason,
              ticket_enforced: ticketAdmission.enforced,
              spawn_intent_id: intent.spawnIntentId,
              canonical_args_hash: intent.canonicalArgsHash,
              expires_at: intent.expiresAt,
              dispatch_mode: dispatchMode,
              speculative_session_label: useSpeculativeSend ? speculative?.label : "",
              dispatch_executed: false,
              spawn_executed: false,
              materialized: false,
              speculative_preload_enabled: speculativePreloadEnabled,
              speculative_selection_reason: speculativeSelection.reason,
              speculative_selection_status: speculativeSelection.status,
              speculative_selection_candidate_key: speculativeSelection.candidateKey,
              elapsedMs: Date.now() - dispatchToolStartedAt,
            }, toolLogger(ctx), null);
            return plannerDispatchResponse({
              spawnIntentId: intent.spawnIntentId,
              workContractId,
              delegateTaskId,
              attemptId,
              ticketId: ticketAdmission.ticket_id,
              queueId: ticketAdmission.queue_id,
              ticketAdmissionReason: ticketAdmission.reason,
              ticketEnforced: ticketAdmission.enforced,
              sessionsSpawnArgs,
              sessionsSendArgs: sessionsSendArgs || undefined,
              dispatchMode,
              speculativeSessionLabel: useSpeculativeSend ? speculative?.label : undefined,
              canonicalArgsHash: intent.canonicalArgsHash,
              expiresAt: intent.expiresAt,
              workerPool: asString(asRecord(cachedDecision.route_decision).worker_pool),
              model: selectedModel || asString(metadata.model),
            });
          }

          const ticketAdmission = admitDelegationTicketForDispatch({
            contract: dispatchWorkContract,
            candidate: ticketCandidate,
            delegateTaskId: asString(params.delegateTaskId),
            workerPool: asString(asRecord(cachedDecision.route_decision).worker_pool),
            modelProfile: selectedModel || asString(metadata.model),
          });
          if (!ticketAdmission.allowed) {
            if (ticketAdmission.reason === "not_new_work") {
              const fallbackBody = {
                ok: true,
                route: "reply",
                dispatch_skipped: true,
                fallback_to_main_reply: true,
                reason: "not_new_work",
                ticket_decision: ticketCandidate.ticket_decision,
                ticket_denial_reason: ticketAdmission.reason,
                is_new_work: ticketCandidate.is_new_work,
                expected_deliverable: ticketCandidate.expected_deliverable,
                work_contract_id: ticketAdmission.work_contract_id ?? ticketCandidate.work_contract_id ?? null,
                ticket_id: ticketAdmission.ticket_id ?? ticketCandidate.ticket_id ?? null,
                dispatch_executed: false,
                spawn_executed: false,
                materialized: false,
                main_session_action: "answer_followup_or_refresh_status",
              };
              await recordPolicyReplay("dispatch_ticket_reused_main_reply", {
                sessionKey: managedSessionKey,
                sessionId: asString(ctx.sessionId),
                route: resolvedRoute,
                ticket_decision: ticketCandidate.ticket_decision,
                ticket_denial_reason: ticketAdmission.reason,
                is_new_work: ticketCandidate.is_new_work,
                expected_deliverable: ticketCandidate.expected_deliverable,
                work_contract_id: ticketAdmission.work_contract_id ?? ticketCandidate.work_contract_id ?? null,
                ticket_id: ticketAdmission.ticket_id ?? ticketCandidate.ticket_id ?? null,
                dispatch_executed: false,
                spawn_executed: false,
                materialized: false,
                fallback_to_main_reply: true,
                terminal: false,
              }, toolLogger(ctx), cachedDecision);
              return toolResponse(JSON.stringify(fallbackBody), fallbackBody);
            }
            const errorMessage = `delegation_ticket_rejected:${ticketAdmission.reason}`;
            await recordPolicyReplay("dispatch_ticket_rejected", {
              sessionKey: managedSessionKey,
              sessionId: asString(ctx.sessionId),
              route: resolvedRoute,
              error: errorMessage,
              ticket_decision: ticketCandidate.ticket_decision,
              ticket_denial_reason: ticketAdmission.reason,
              is_new_work: ticketCandidate.is_new_work,
              expected_deliverable: ticketCandidate.expected_deliverable,
              work_contract_id: ticketAdmission.work_contract_id ?? ticketCandidate.work_contract_id ?? null,
              ticket_id: ticketAdmission.ticket_id ?? ticketCandidate.ticket_id ?? null,
              dispatch_executed: false,
              spawn_executed: false,
              materialized: false,
              retryable: ticketAdmission.reason === "ledger_unavailable",
              terminal: ticketAdmission.reason !== "ledger_unavailable",
            }, toolLogger(ctx), cachedDecision);
            await recordDispatchTerminalFailure(errorMessage, { route: resolvedRoute });
            return dispatchHonestyFailure({
              route: resolvedRoute,
              error: errorMessage,
              retryable: ticketAdmission.reason === "ledger_unavailable",
              terminal: ticketAdmission.reason !== "ledger_unavailable",
              details: {
                rejected: true,
                rejection_reason: ticketAdmission.reason,
                ticket_decision: ticketCandidate.ticket_decision,
                ticket_denial_reason: ticketAdmission.reason,
                is_new_work: ticketCandidate.is_new_work,
                expected_deliverable: ticketCandidate.expected_deliverable,
                work_contract_id: ticketAdmission.work_contract_id ?? ticketCandidate.work_contract_id ?? null,
                ticket_id: ticketAdmission.ticket_id ?? ticketCandidate.ticket_id ?? null,
                dispatch_executed: false,
                spawn_executed: false,
                materialized: false,
              },
            });
          }
          if (ticketAdmission.enforced) {
            metadata.delegation_ticket_id = ticketAdmission.ticket_id;
            metadata.delegateTaskId = ticketAdmission.delegate_task_id;
            metadata.delegate_task_id = ticketAdmission.delegate_task_id;
            metadata.attemptId = ticketAdmission.attempt_id;
            metadata.attempt_id = ticketAdmission.attempt_id;
            schedulerQueueId = asString(ticketAdmission.queue_id);
            if (runtimeLedgerMode === "enforce") {
              if (!isSchedulerEnabled()) {
                const errorMessage = "blocked_by_scheduler_mandatory:scheduler_not_enabled";
                warnToolLogger(ctx, "OCTOCLAW_SCHEDULER_ENABLED is false; blocking dispatch because scheduler gating is mandatory in enforce mode");
                await recordPolicyReplay("dispatch_scheduler_mandatory_blocked", {
                  sessionKey: managedSessionKey,
                  sessionId: asString(ctx.sessionId),
                  route: resolvedRoute,
                  queue_id: schedulerQueueId || null,
                  work_contract_id: ticketAdmission.work_contract_id ?? null,
                  attempt_id: ticketAdmission.attempt_id ?? null,
                  reason: "scheduler_not_enabled",
                  dispatch_executed: false,
                  spawn_executed: false,
                  materialized: false,
                  retryable: false,
                  terminal: true,
                }, toolLogger(ctx), cachedDecision);
                await recordDispatchTerminalFailure(errorMessage, { route: resolvedRoute });
                return dispatchHonestyFailure({
                  route: resolvedRoute,
                  error: errorMessage,
                  retryable: false,
                  terminal: true,
                  details: {
                    status: "blocked_by_scheduler_mandatory",
                    scheduler_status: "blocked_by_scheduler_mandatory",
                    queue_id: schedulerQueueId || null,
                    work_contract_id: ticketAdmission.work_contract_id ?? null,
                    attempt_id: ticketAdmission.attempt_id ?? null,
                    reason: "scheduler_not_enabled",
                    dispatch_executed: false,
                    spawn_executed: false,
                    materialized: false,
                  },
                });
              } else if (!schedulerQueueId) {
                const errorMessage = "blocked_by_scheduler:missing_queue_id";
                await recordDispatchTerminalFailure(errorMessage, { route: resolvedRoute });
                return dispatchHonestyFailure({
                  route: resolvedRoute,
                  error: errorMessage,
                  retryable: false,
                  terminal: true,
                  details: {
                    status: "blocked_by_scheduler",
                    scheduler_status: "blocked_by_scheduler",
                    queue_id: null,
                    dispatch_executed: false,
                    spawn_executed: false,
                    materialized: false,
                  },
                });
              } else {
                const promoted = promoteToQueued({ queueId: schedulerQueueId, contract: dispatchWorkContract });
                if (!promoted.ok) {
                  const schedulerStatus = promoted.queueStatus === "blocked" ? "blocked_by_scheduler" : "blocked_by_scheduler";
                  const errorMessage = `${schedulerStatus}:${promoted.blockedReason || promoted.error || promoted.queueStatus}`;
                  await recordPolicyReplay("dispatch_scheduler_blocked", {
                    sessionKey: managedSessionKey,
                    sessionId: asString(ctx.sessionId),
                    route: resolvedRoute,
                    queue_id: schedulerQueueId,
                    queue_status: promoted.queueStatus,
                    blocked_by: promoted.blockedBy ?? null,
                    blocked_reason: promoted.blockedReason ?? promoted.error ?? null,
                    dispatch_executed: false,
                    spawn_executed: false,
                    materialized: false,
                  }, toolLogger(ctx), cachedDecision);
                  await recordDispatchTerminalFailure(errorMessage, { route: resolvedRoute });
                  return dispatchHonestyFailure({
                    route: resolvedRoute,
                    error: errorMessage,
                    retryable: promoted.error === "ledger_unavailable",
                    terminal: promoted.error !== "ledger_unavailable",
                    details: {
                      status: "blocked_by_scheduler",
                      scheduler_status: "blocked_by_scheduler",
                      queue_id: schedulerQueueId,
                      queue_status: promoted.queueStatus,
                      blocked_by: promoted.blockedBy ?? null,
                      blocked_reason: promoted.blockedReason ?? promoted.error ?? null,
                      dispatch_executed: false,
                      spawn_executed: false,
                      materialized: false,
                    },
                  });
                }
                const schedulerConfig = resolveSchedulerConfig();
                const lease = tryAcquireLease({
                  queueId: schedulerQueueId,
                  leaseOwner: `octoclaw_dispatch:${asString(ctx.sessionId, managedSessionKey) || process.pid}`,
                  maxConcurrentSpawns: schedulerConfig.maxConcurrentSpawns,
                  leaseDurationMs: schedulerConfig.leaseDurationMs,
                });
                if (!lease.acquired || lease.queueId !== schedulerQueueId) {
                  const errorMessage = `queued_not_leased:${lease.reason || (lease.queueId && lease.queueId !== schedulerQueueId ? "different_queue_leased" : "unknown")}`;
                  await recordPolicyReplay("dispatch_scheduler_not_leased", {
                    sessionKey: managedSessionKey,
                    sessionId: asString(ctx.sessionId),
                    route: resolvedRoute,
                    queue_id: schedulerQueueId,
                    leased_queue_id: lease.queueId ?? null,
                    reason: lease.reason ?? null,
                    blocked_by: lease.blockedBy ?? null,
                    blocked_reason: lease.blockedReason ?? null,
                    dispatch_executed: false,
                    spawn_executed: false,
                    materialized: false,
                  }, toolLogger(ctx), cachedDecision);
                  if (lease.acquired && lease.queueId && lease.queueId !== schedulerQueueId) {
                    const releaseResult = releaseOrComplete({
                      queueId: lease.queueId,
                      outcome: "cancelled",
                      errorCode: "unexpected_lease_owner",
                      errorMessage: `dispatch acquired ${lease.queueId} while waiting for ${schedulerQueueId}`,
                    });
                    if (!releaseResult.ok) warnToolLogger(ctx, `scheduler unexpected lease release failed: ${releaseResult.error || "unknown_error"}`);
                  }
                  await recordDispatchTerminalFailure(errorMessage, { route: resolvedRoute });
                  return dispatchHonestyFailure({
                    route: resolvedRoute,
                    error: errorMessage,
                    retryable: true,
                    terminal: false,
                    details: {
                      status: "queued_not_leased",
                      scheduler_status: "queued_not_leased",
                      queue_id: schedulerQueueId,
                      leased_queue_id: lease.queueId ?? null,
                      blocked_by: lease.blockedBy ?? null,
                      blocked_reason: lease.blockedReason ?? lease.reason ?? null,
                      dispatch_executed: false,
                      spawn_executed: false,
                      materialized: false,
                    },
                  });
                }
                schedulerDispatchState = "leased";
                metadata.scheduler_queue_id = schedulerQueueId;
                metadata.scheduler_status = "leased";
              }
            }
          }
        }

        let payload: UnknownRecord;
        try {
          payload = buildTsRuntimeDispatchPayload({
            task: asString(params.task),
            command: asString(params.command),
            cwd: asString(params.cwd, ctxCwd(ctx)),
            decision: cachedDecision,
            metadata,
            timeoutSeconds: asNumber(params.timeoutSeconds) ?? undefined,
            helperInvoker,
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const candidate = asRecord(error);
          payload = isRecord(candidate.payload) ? asRecord(candidate.payload) : {};
          if (Object.keys(payload).length === 0) {
            await recordDispatchTerminalFailure(errorMessage);
            releaseSchedulerQueue("failed", errorMessage);
            return dispatchHonestyFailure({
              route: resolvedRoute,
              error: errorMessage,
              sealMismatch: false,
              retryable: true,
            });
          }
          await recordDispatchTerminalFailure(errorMessage, { route: asString(payload.route, resolvedRoute) });
          if (dispatchWorkContract) {
            materializeWorkContractFailure({
              workContractId: dispatchWorkContract.workContractId,
              errorMessage,
              nativeBinding: dispatchWorkContract.delegate?.nativeBinding ?? undefined,
            });
          }
          try {
            void emitExecutionTransitionNotification({
              transitionKind: "spawn_failed",
              projection: buildMinimalProjection({
                taskId: asString(payload.delegateTaskId || payload.task_id || dispatchWorkContract?.workContractId || ""),
                status: "failed",
                dispatchExecuted: true,
                spawnExecuted: false,
                resultMaterialized: false,
              }),
              attemptId: asString(payload.attemptId || ""),
              workContractId: dispatchWorkContract?.workContractId ?? "",
              sessionKey: stateKey,
              stateKey,
            });
          } catch (_) { }
          releaseSchedulerQueue("failed", errorMessage);
          return dispatchHonestyFailure({
            route: asString(payload.route, resolvedRoute),
            error: errorMessage,
            sealMismatch: false,
            retryable: true,
          });
        }
        const authoritativeDecision = asRecord(payload.policy_decision ?? cachedDecision);
        const replaySessionKey = selectReplaySessionKeyForDispatch(
          ctx,
          metadata,
          stateKey,
          state,
          authoritativeDecision,
          payload,
        );
        const stickyDecision = delegatedStickyRoute(authoritativeDecision)
          ? authoritativeDecision
          : {
              route_decision: {
                route: asString(payload.route),
                system_preferred_route: asString(payload.system_preferred_route ?? payload.route),
                work_type: asString(payload.work_type),
                phase: asString(payload.phase),
                protocol: asString(payload.protocol),
              },
            };
        const stickyPersisted = await persistStickyLane(replaySessionKey, stickyDecision, toolLogger(ctx), "dispatch");
        const summary = await userFacingHandoff(
          payload,
          `OctoClaw dispatch: ${asString(payload.route)}${payload.executed === true ? " (executed)" : " (planned)"}`,
          ctxCwd(ctx),
        );
        const delegateReasonCodes = Array.isArray(asRecord(authoritativeDecision)._delegate_reason_codes)
          ? (asRecord(authoritativeDecision)._delegate_reason_codes as unknown[]).map((value) => asString(value)).filter(Boolean)
          : [];
        const delegationTicketDryRun = buildDelegationTicketDryRun({
          contract: dispatchWorkContract,
          decision: authoritativeDecision,
          payload,
          metadata,
        });
        authoritativeDecision.delegation_ticket_candidate = asRecord(authoritativeDecision.delegation_ticket_candidate).ticket_decision
          ? authoritativeDecision.delegation_ticket_candidate
          : delegationTicketDryRun;
        await recordDispatchLifecycleReplayEvents({
          decision: authoritativeDecision,
          payload,
          sessionKey: replaySessionKey,
          sessionId: asString(ctx.sessionId),
          logger: toolLogger(ctx),
        });
        const sessionBoundary = detectSessionBoundary(ctx);
        await recordPolicyReplay(
          "dispatch_called",
          {
            sessionKey: replaySessionKey,
            sessionId: asString(ctx.sessionId),
            route: asString(asRecord(authoritativeDecision.route_decision).route || payload.route),
            systemPreferredRoute: asString(asRecord(authoritativeDecision.route_decision).system_preferred_route || payload.system_preferred_route),
            workerPool: asString(asRecord(authoritativeDecision.route_decision).worker_pool || payload.worker_pool),
            executed: payload.executed === true,
            usedCachedPolicy: hadCachedDecision,
            originalRoute: asString(asRecord(cachedDecision.route_decision).route || params.forceRoute),
            routeChanged: asString(asRecord(cachedDecision.route_decision).route) !== asString(payload.route),
            decisionSource: hadCachedDecision ? "cached" : (params.policyJson ? "policy_json" : freshDecisionSource || "fresh"),
            stickyPersisted,
            complexityBand,
            delegateReasonCodes,
            ticket_decision: delegationTicketDryRun.ticket_decision,
            ticket_denial_reason: delegationTicketDryRun.ticket_denial_reason,
            is_new_work: delegationTicketDryRun.is_new_work,
            expected_deliverable: delegationTicketDryRun.expected_deliverable,
            sessionBoundaryStatus: asString(sessionBoundary.status),
            canonicalSessionKey: asString(sessionBoundary.canonicalSessionKey || replaySessionKey),
          },
          toolLogger(ctx),
          authoritativeDecision,
        );
        if (!stateKey) {
          stateKey = asString(metadata.session_key, stableId("policy", [asString(params.task), asString(ctx.sessionId)]));
        }
        const nextState = {
          ...(state ?? {}),
          prompt: asString(params.task),
          decision: authoritativeDecision,
          delegated: asString(payload.route) === "delegate",
          dispatchRoute: asString(payload.route),
          dispatchStatus: asString(payload.status),
          dispatchExecuted: payload.executed === true,
          updatedAt: Date.now(),
        };
        setPolicyStateForContext(ctx, nextState, replaySessionKey || stateKey);
        if (stateKey && replaySessionKey && stateKey !== replaySessionKey) {
          setPolicyStateForContext(ctx, nextState, stateKey);
        }
        const materialization = asRecord(payload.materialization);
        const payloadRuntimeTruth = asRecord(payload.runtime_truth);
        const payloadNativeTaskBinding = asRecord(payloadRuntimeTruth.nativeTaskBinding);
        const payloadDelegateAttempt = asRecord(payloadRuntimeTruth.delegateAttempt);
        const payloadNativeAttemptBinding = asRecord(payloadDelegateAttempt.nativeBinding);
        const materializedNativeTaskId = optionalString(
          payloadNativeTaskBinding.nativeTaskId,
          payloadNativeAttemptBinding.nativeTaskId,
          materialization.task_id,
          payload.task_id,
        );
        const materializedNativeFlowId = optionalString(
          payloadNativeTaskBinding.nativeFlowId,
          payloadNativeAttemptBinding.nativeFlowId,
          materialization.flow_id,
          payload.flow_id,
        );
        void summary;
        void compactDispatchDetails;
        const finalRoute = normalizeLiveRoute(payload.route, resolvedRoute);
        const finalDecisionRoute = asRecord(authoritativeDecision.route_decision);
        const workerPool = asString(finalDecisionRoute.worker_pool || payload.worker_pool);
        const taskClass = asString(finalDecisionRoute.task_class || finalDecisionRoute.judge_role || finalDecisionRoute.role);
        const nativeBinding = dispatchWorkContract?.delegate?.nativeBinding;
        let spawnEvidence = dispatchSpawnEvidence({
          payloadRuntimeTruth,
          payloadNativeTaskBinding,
          payloadDelegateAttempt,
          payloadNativeAttemptBinding,
          nativeBinding,
        });
        const materialized = Boolean(asString(materialization.task_id) || materializedNativeTaskId || materializedNativeFlowId);
        const dispatchExecuted = materialized;
        const delegateTaskId = asString(payload.delegateTaskId || materialization.delegateTaskId || materialization.task_id || payload.task_id);
        const workContractIdForDispatch = (dispatchWorkContract?.workContractId ?? asString(authoritativeDecision.workContractId)) || "";
        const executionState = finalRoute === "delegate"
          ? spawnEvidence.spawnExecuted
            ? "spawn_confirmed"
            : materialized
              ? "materialized_no_spawn"
              : "not_materialized"
          : payload.executed === true ? "executed" : "planned";
        const materializedAt = new Date().toISOString();
        const nativeSubstrateState = asString(materialization.substrate_state);
        const projectedSubstrateState = spawnEvidence.spawnExecuted
          ? nativeSubstrateState && nativeSubstrateState !== "queued" ? nativeSubstrateState : "running"
          : "queued";
        const childSessionKey = spawnEvidence.childSessionKey || nativeBinding?.childSessionKey || dispatchWorkContract?.continuity.preferredChildSessionKey || undefined;
        if (asString(materialization.task_id) || workContractIdForDispatch) {
          await upsertTaskStateCache({
            id: workContractIdForDispatch || asString(materialization.task_id),
            workContractId: workContractIdForDispatch || undefined,
            work_contract_id: workContractIdForDispatch || undefined,
            taskId: asString(materialization.task_id) || materializedNativeTaskId || undefined,
            task_id: asString(materialization.task_id) || materializedNativeTaskId || undefined,
            nativeTaskId: materializedNativeTaskId || asString(materialization.task_id) || undefined,
            native_task_id: materializedNativeTaskId || asString(materialization.task_id) || undefined,
            flowId: materializedNativeFlowId || asString(materialization.flow_id) || undefined,
            flow_id: materializedNativeFlowId || asString(materialization.flow_id) || undefined,
            nativeFlowId: materializedNativeFlowId || asString(materialization.flow_id) || undefined,
            native_flow_id: materializedNativeFlowId || asString(materialization.flow_id) || undefined,
            sessionKey: replaySessionKey,
            session_key: replaySessionKey,
            deliveryTarget: asRecord(metadata.delivery_target || state?.deliveryTarget || state?.delivery_target),
            delivery_target: asRecord(metadata.delivery_target || state?.deliveryTarget || state?.delivery_target),
            replyToMessageId: dispatchReplyToMessageId(metadata, state, ctx) || undefined,
            reply_to_message_id: dispatchReplyToMessageId(metadata, state, ctx) || undefined,
            route: asString(payload.route),
            status: projectedSubstrateState,
            summary: spawnEvidence.spawnExecuted
              ? asString(asRecord(payload.handoff).summary || payload.summary)
              : "TaskFlow materialized; child session spawn not confirmed",
            role: asString(asRecord(authoritativeDecision.route_decision).task_class),
            workerPool,
            worker_pool: workerPool,
            title: truncateText(asString(asRecord(dispatchWorkContract?.mainContext).summary || dispatchWorkContract?.userAsk || params.task), 160),
            complexityBand: complexityBand || undefined,
            complexity_band: complexityBand || undefined,
            model: selectedModel || asString(metadata.model),
            modelProfile: selectedModel || asString(metadata.model),
            model_profile: selectedModel || asString(metadata.model),
            materialized_at: materializedAt,
            spawned_at: spawnEvidence.spawnExecuted ? materializedAt : undefined,
            started_at: spawnEvidence.spawnExecuted ? materializedAt : undefined,
            updated_at: materializedAt,
            updatedAt: materializedAt,
            dispatchExecuted,
            dispatch_executed: dispatchExecuted,
            spawnExecuted: spawnEvidence.spawnExecuted,
            spawn_executed: spawnEvidence.spawnExecuted,
            resultMaterialized: false,
            result_materialized: false,
            childSessionKey: childSessionKey || undefined,
            child_session_key: childSessionKey || undefined,
            runId: spawnEvidence.runId || undefined,
            run_id: spawnEvidence.runId || undefined,
            childRunId: spawnEvidence.childRunId || undefined,
            child_run_id: spawnEvidence.childRunId || undefined,
          } as RuntimeTaskStateRecord);
        }
        if (dispatchWorkContract) {
          const revision = asNumber(materialization.substrate_revision) ?? nativeBinding?.revision ?? 1;
          const nextNativeBinding: NativeBindingRef = {
            ...(nativeBinding ?? {}),
            flowId: materializedNativeFlowId ?? nativeBinding?.flowId ?? asString(materialization.flow_id, "unknown"),
            nativeFlowId: materializedNativeFlowId ?? nativeBinding?.nativeFlowId,
            ownerKey: nativeBinding?.ownerKey ?? dispatchWorkContract.delegate?.delegateTaskId ?? dispatchWorkContract.workContractId,
            controllerId: nativeBinding?.controllerId ?? "octoclaw.delegate",
            revision,
            expectedRevision: revision,
            taskId: materializedNativeTaskId ?? nativeBinding?.taskId,
            nativeTaskId: materializedNativeTaskId ?? nativeBinding?.nativeTaskId,
            runId: spawnEvidence.runId || nativeBinding?.runId,
            childRunId: spawnEvidence.childRunId || nativeBinding?.childRunId,
            childSessionKey,
            syncMode: nativeBinding?.syncMode ?? "managed",
            status: nativeFlowStatusFromSubstrate(projectedSubstrateState),
            lastMutation: nativeBinding?.lastMutation ?? "createManaged",
            lastMutationApplied: true,
          };
          materializeWorkContractSuccess({
            workContractId: dispatchWorkContract.workContractId,
            nativeBinding: nextNativeBinding,
            delegateTaskId: asString(payload.delegateTaskId || materialization.delegateTaskId || materialization.task_id || payload.task_id),
            attemptId: asString(payload.attemptId || materialization.attemptId),
            nativeTaskId: materializedNativeTaskId,
            nativeFlowId: materializedNativeFlowId,
            childSessionKey,
            childSessionId: spawnEvidence.childSessionId || undefined,
            runId: spawnEvidence.runId || undefined,
            substrateState: projectedSubstrateState,
            spawnExecuted: spawnEvidence.spawnExecuted,
            resultMaterialized: false,
            deliveryStatus: "none",
          });
        }
        const statePatch = {
          dispatchExecuted,
          spawnExecuted: spawnEvidence.spawnExecuted,
          dispatchStatus: executionState,
          executionState,
          latestAnomalyNotice: finalRoute === "delegate" && materialized && !spawnEvidence.spawnExecuted
            ? {
              kind: "spawn_not_confirmed",
              severity: "error",
              taskId: delegateTaskId,
              nativeTaskId: materializedNativeTaskId ?? null,
              nativeFlowId: materializedNativeFlowId ?? null,
              workContractId: (dispatchWorkContract?.workContractId ?? asString(authoritativeDecision.workContractId)) || null,
              message: "Native TaskFlow was materialized, but no child session/run evidence confirmed subagent start.",
              createdAt: materializedAt,
            }
            : undefined,
          updatedAt: Date.now(),
        };
        setPolicyStateForContext(ctx, { ...nextState, ...statePatch }, replaySessionKey || stateKey);
        if (stateKey && replaySessionKey && stateKey !== replaySessionKey) {
          setPolicyStateForContext(ctx, { ...nextState, ...statePatch }, stateKey);
        }
        try {
          const baseProjection = buildMinimalProjection({
            taskId: delegateTaskId,
            status: spawnEvidence.spawnExecuted ? "running" : "queued",
            dispatchExecuted,
            spawnExecuted: spawnEvidence.spawnExecuted,
            resultMaterialized: false,
            modelId: selectedModel || asString(metadata.model),
            backend: "octoclaw.delegate",
            childSessionKey,
            runId: spawnEvidence.runId,
            childRunId: spawnEvidence.childRunId,
            latestAnomalyNotice: statePatch.latestAnomalyNotice,
          });
          const attemptId = asString(payload.attemptId || materialization.attemptId);
          const workContractId = workContractIdForDispatch;
          const replyToMessageId = dispatchReplyToMessageId(metadata, state, ctx);
          const notifyParams = {
            projection: baseProjection,
            attemptId,
            workContractId: workContractId || "",
            sessionKey: replaySessionKey || stateKey,
            stateKey: replaySessionKey || stateKey,
            decision: authoritativeDecision as Record<string, unknown>,
            replyToMessageId: replyToMessageId || undefined,
            occurredAt: materializedAt,
          };
          if (materialized) {
            void emitExecutionTransitionNotification({
              ...notifyParams,
              transitionKind: "dispatch_materialized",
            });
            if (spawnEvidence.spawnExecuted) {
              void emitExecutionTransitionNotification({
                ...notifyParams,
                transitionKind: "spawn_started",
              });
            } else {
              releaseSchedulerQueue("failed", "spawn_not_confirmed");
              void emitExecutionTransitionNotification({
                ...notifyParams,
                transitionKind: "materialized_no_spawn",
              });
            }
          }
        } catch (_) { }
        if (finalRoute === "delegate" && materialized && !spawnEvidence.spawnExecuted) {
          return dispatchHonestyFailure({
            route: finalRoute,
            error: "spawn_not_confirmed",
            retryable: true,
            terminal: false,
            details: {
              materialized: true,
              execution_state: executionState,
              delegation_method: "octoclaw_dispatch",
              work_contract_id: workContractIdForDispatch || null,
              delegate_task_id: delegateTaskId || null,
              attempt_id: asString(payload.attemptId || materialization.attemptId) || null,
              dispatch_executed: dispatchExecuted,
              spawn_executed: false,
              native_task_id: materializedNativeTaskId ?? null,
              native_flow_id: materializedNativeFlowId ?? null,
              result_materialized: false,
              delivery_status: null,
              user_message: "已登记到 Native TaskFlow，但没有子会话/runId 证据，不能视为已启动子 agent；请重试派发或改为主会话直接处理。",
            },
          });
        }
        return dispatchHonestySuccess({
          route: finalRoute,
          workerPool,
          taskId: delegateTaskId,
          taskClass,
          workContractId: dispatchWorkContract?.workContractId ?? asString(authoritativeDecision.workContractId),
          delegateTaskId,
          attemptId: asString(payload.attemptId || materialization.attemptId),
          childSessionKey: childSessionKey ?? null,
          childSessionId: (spawnEvidence.childSessionId || dispatchWorkContract?.continuity.preferredChildSessionId) ?? null,
          runId: spawnEvidence.runId || null,
          childRunId: spawnEvidence.childRunId || null,
          materialized,
          executionState,
          dispatchExecuted,
          spawnExecuted: spawnEvidence.spawnExecuted,
          nativeTaskId: materializedNativeTaskId,
          nativeFlowId: materializedNativeFlowId,
          resultMaterialized: false,
          deliveryStatus: null,
        });
      },
    },
    {
      name: "octoclaw_dispatch_confirm",
      label: "OctoClaw Dispatch Confirm",
      description: "Confirm native sessions_spawn acceptance for an OctoClaw planner intent. Records native refs only after accepted run evidence exists.",
      params: {
        type: "object",
        additionalProperties: false,
        properties: {
          spawnIntentId: { type: "string", description: "spawnIntentId returned by octoclaw_dispatch." },
          workContractId: { type: "string", description: "WorkContract id returned by octoclaw_dispatch." },
          sessionsSpawnStatus: { type: "string", description: "Native sessions_spawn status, usually accepted or error." },
          runId: { type: "string", description: "Native runId returned by sessions_spawn. Required when accepted." },
          childRunId: { type: "string", description: "Optional child run id if distinct from runId." },
          childSessionKey: { type: "string", description: "Optional native child session key." },
          sessionsSpawnResultJson: { type: "string", description: "Optional raw sessions_spawn result JSON for status/error/child refs; accepted runId must be passed as top-level runId." },
          error: { type: "string", description: "Native spawn error if sessionsSpawnStatus is not accepted." },
        },
        required: ["spawnIntentId", "workContractId", "sessionsSpawnStatus"],
      },
      execute: async (params, _rawCtx) => {
        const ctx = _rawCtx ?? {};
        const resultJson = parseObjectJson(params.sessionsSpawnResultJson);
        const status = asString(params.sessionsSpawnStatus || resultJson.status);
        const runId = asString(params.runId);
        const childRunId = asString(params.childRunId || resultJson.childRunId || resultJson.child_run_id || runId);
        const childSessionKey = asString(params.childSessionKey || resultJson.childSessionKey || resultJson.child_session_key);
        const { key: stateKey, state } = resolveToolPolicyContext(ctx, "");
        const decision = asRecord(state?.decision);
        const replayDecision = Object.keys(decision).length > 0 ? decision : null;
        const sessionKey = asString(asRecord(decision.request).session_key)
          || asString(ctx.sessionKey || ctx.canonicalSessionKey || stateKey);
        const confirmed = await confirmNativeSpawn({
          spawnIntentId: asString(params.spawnIntentId),
          workContractId: asString(params.workContractId),
          sessionKey,
          stateKey,
          sessionsSpawnStatus: status,
          runId,
          childRunId,
          childSessionKey,
          error: asString(params.error || resultJson.error),
          modelId: asString(resultJson.model || resultJson.modelId),
          replyToMessageId: dispatchReplyToMessageId({}, state, ctx) || undefined,
          cwd: ctxCwd(ctx),
          decision,
        });
        await recordPolicyReplay("dispatch_confirm_completed", {
          sessionKey,
          stateKey,
          sessionId: asString(ctx.sessionId),
          spawn_intent_id: asString(params.spawnIntentId),
          work_contract_id: asString(params.workContractId),
          sessions_spawn_status: status,
          ok: confirmed.ok,
          confirm_status: confirmed.status,
          error: asString(confirmed.error),
          run_id: asString(confirmed.runId),
          child_run_id: asString(confirmed.childRunId),
          child_session_key: asString(confirmed.childSessionKey),
          ack_sent: confirmed.ackSent === true,
          ack_skipped: confirmed.ackSkipped === true,
        }, toolLogger(ctx), replayDecision);
        if (confirmed.ok) {
          const confirmedAt = new Date().toISOString();
          const updatedContract = loadWorkContract(confirmed.workContractId);
          await upsertTaskStateCache({
            id: confirmed.workContractId,
            workContractId: confirmed.workContractId,
            work_contract_id: confirmed.workContractId,
            route: "delegate",
            status: "running",
            sessionKey,
            session_key: sessionKey,
            flow_id: asString(updatedContract?.delegate?.nativeBinding?.flowId) || (confirmed.runId ? `sessions_spawn:${confirmed.runId}` : ""),
            runId: confirmed.runId || undefined,
            run_id: confirmed.runId || undefined,
            childRunId: confirmed.childRunId || undefined,
            child_run_id: confirmed.childRunId || undefined,
            childSessionKey: confirmed.childSessionKey || undefined,
            child_session_key: confirmed.childSessionKey || undefined,
            dispatchExecuted: true,
            dispatch_executed: true,
            spawnExecuted: true,
            spawn_executed: true,
            resultMaterialized: false,
            result_materialized: false,
            spawned_at: confirmedAt,
            started_at: confirmedAt,
            updatedAt: confirmedAt,
            updated_at: confirmedAt,
            ...(updatedContract ? { workContract: updatedContract, work_contract: updatedContract } : {}),
          });
          const nextState = {
            ...(state ?? {}),
            delegated: true,
            dispatchRoute: "delegate",
            dispatchStatus: "spawn_confirmed",
            dispatchExecuted: true,
            dispatch_executed: true,
            spawnExecuted: true,
            spawn_executed: true,
            spawnIntentId: confirmed.spawnIntentId,
            spawn_intent_id: confirmed.spawnIntentId,
            workContractId: confirmed.workContractId,
            work_contract_id: confirmed.workContractId,
            runId: confirmed.runId,
            run_id: confirmed.runId,
            childRunId: confirmed.childRunId,
            child_run_id: confirmed.childRunId,
            childSessionKey: confirmed.childSessionKey,
            child_session_key: confirmed.childSessionKey,
            updatedAt: Date.now(),
          };
          setPolicyStateAliasesForContext(ctx, nextState, [
            sessionKey,
            stateKey,
            asString(ctx.sessionKey),
            asString(ctx.canonicalSessionKey),
            asString(asRecord(updatedContract).sessionKey),
          ]);
        }
        return toolResponse(JSON.stringify(confirmed), confirmed as unknown as Record<string, unknown>);
      },
    },
    {
      name: "octoclaw_task_action",
      label: "OctoClaw Task Action",
      description: "Handle implemented task anchor fallback commands: details, queue, artifacts, and retry. Deferred: stop, approve, reject.",
      params: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string", description: "Fallback command text such as 'details task-123' or 'queue'." },
          // deferred: stop, approve, reject
          action: { type: "string", enum: ["details", "queue", "artifacts", "retry", "view", "detail"] },
          taskId: { type: "string", description: "Task id for task-scoped actions." },
          format: { type: "string", enum: ["text", "json"] },
        },
      },
      execute: async (params, _rawCtx) => {
        const ctx = _rawCtx ?? {};
        const action = asString(params.action);
        const taskId = asString(params.taskId);
        const rawText = asString(params.text) || [action, taskId].filter(Boolean).join(" ").trim();
        if (!rawText) {
          return { error: "octoclaw_task_action requires either text or action/taskId" };
        }
        const format = asString(params.format, "json");
        const result = await executeTaskAnchorCommand(rawText, format, ctxCwd(ctx));
        return toolResponse(result.summary, result.payload);
      },
    },
    {
      name: "octoclaw_status",
      label: "OctoClaw Status",
      description: "Show current OctoClaw task state. Default to task anchors; use compact/table/lanes only when the user explicitly asks for those legacy views.",
      params: {
        type: "object",
        additionalProperties: false,
        properties: {
          format: { type: "string", enum: ["anchors", "compact", "table", "lanes", "raw"] },
        },
      },
      execute: async (params, _rawCtx) => {
        const format = asString(params.format, "anchors");
        const ctx = _rawCtx ?? {};
        // Detect IM type from multiple ctx fields — OpenClaw may use different key names
        const sessionKey = asString(
          ctx.sessionKey || ctx.canonicalSessionKey || ctx.agentId ||
          ctx.session_key || ctx.canonical_session_key,
        );
        const imType = sessionKey ? detectIMType(sessionKey) : "plain";
        checkActiveTaskRecovery();
        const output = await buildNativeStatusOutput(format, imType, ctx);
        return statusToolResponse(output, format, imType);
      },
    },
    {
      name: "octoclaw_crash_recovery",
      label: "OctoClaw Crash Recovery",
      description: "Operator tool to manually run runtime ledger crash recovery for stale leases, attempt reconciliation, orphan scans, and projection rebuild.",
      params: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      execute: async () => {
        if (resolveRuntimeLedgerMode() === "off") {
          return toolResponse("crash_recovery_unavailable", { reason: "runtime_ledger_off" });
        }
        const result = performCrashRecovery({});
        const summary = [
          "crash_recovery_completed",
          `staleLeasesReleased=${result.staleLeasesReleased}`,
          `attemptsReconciled=${result.attemptsReconciled}`,
          `spawnConfirmed=${result.spawnConfirmed}`,
          `orphansFound=${result.orphansFound}`,
          `projectionRebuilt=${result.projectionRebuilt}`,
          `errors=${result.errors.length}`,
        ].join("; ");
        return toolResponse(summary, { ...result });
      },
    },
  ];
}

export function getCommandRegistrations(): CommandRegistration[] {
  return [
    {
      name: "octotask",
      description: "Run an OctoClaw task anchor fallback command such as details <task_id> or queue",
      acceptsArgs: true,
      handler: async (ctx) => {
        const commandText = asString(ctx.args);
        const ui = ctxUi(ctx);
        if (!commandText) {
          if (hasUi(ctx)) ui.notify?.("Usage: /octotask <details|queue|artifacts|stop|retry|approve|reject> [task_id]", "error");
          return;
        }
        const result = await executeTaskAnchorCommand(commandText, "text", ctxCwd(ctx));
        if (hasUi(ctx)) {
          ui.setEditorText?.(result.summary);
          ui.notify?.("OctoClaw task action completed", "info");
        }
      },
    },
    {
      name: "octostatus",
      description: "Show OctoClaw status; default task anchors, with compact/table/lanes available when explicitly requested",
      acceptsArgs: true,
      handler: async (ctx) => {
        const format = asString(ctx.args, "anchors");
        const output = await buildNativeStatusOutput(format);
        const ui = ctxUi(ctx);
        if (hasUi(ctx)) {
          ui.notify?.(`OctoClaw status (${format})`);
          ui.setEditorText?.(output);
        }
      },
    },
    {
      name: "octoroute",
      description: "Show the current Node-side OctoClaw route decision for a task",
      acceptsArgs: true,
      handler: async (ctx) => {
        const task = asString(ctx.args);
        const ui = ctxUi(ctx);
        if (!task) {
          if (hasUi(ctx)) ui.notify?.("Usage: /octoroute <task>", "error");
          return;
        }
        const payload = await resolveStatelessPolicyDecision(task, { metadata: buildPolicyMetadata(ctx) });
        if (hasUi(ctx)) {
          ui.setEditorText?.(JSON.stringify(payload, null, 2));
          ui.notify?.(policySummaryText(payload));
        }
      },
    },
    {
      name: "octopolicy",
      description: "Show the structured OctoClaw runtime policy decision for a task",
      acceptsArgs: true,
      handler: async (ctx) => {
        const task = asString(ctx.args);
        const ui = ctxUi(ctx);
        if (!task) {
          if (hasUi(ctx)) ui.notify?.("Usage: /octopolicy <task>", "error");
          return;
        }
        const payload = await resolveStatelessPolicyDecision(task, { metadata: buildPolicyMetadata(ctx) });
        if (hasUi(ctx)) {
          ui.setEditorText?.(JSON.stringify(payload, null, 2));
          ui.notify?.(policySummaryText(payload));
        }
      },
    },
    {
      name: "octospawn",
      description: "Register a validated OctoClaw spawn task",
      acceptsArgs: true,
      handler: async (ctx) => {
        const task = asString(ctx.args);
        const ui = ctxUi(ctx);
        if (!task) {
          if (hasUi(ctx)) ui.notify?.("Usage: /octospawn <task>", "error");
          return;
        }
        let payload: UnknownRecord;
        try {
          payload = buildTsRuntimeSpawnPayload({
            task,
              route: "delegate",
            decision: {},
            metadata: buildPolicyMetadata(ctx),
          });
        } catch (error) {
          const candidate = asRecord(error);
          if (!isRecord(candidate.payload)) {
            throw error;
          }
          payload = asRecord(candidate.payload);
        }
        const workflowDecision = buildDecision(task, payload.policy_decision as UnknownRecord | undefined, buildPolicyMetadata(ctx));
        if (hasUi(ctx)) {
          ui.setEditorText?.(JSON.stringify({ ...payload, workflow_decision: workflowDecision }, null, 2));
          ui.notify?.(`OctoClaw spawn registered: ${asString(payload.task_id)}`);
        }
      },
    },
  ];
}
