import { executeOctoclawDispatch } from "./handlers/dispatch.js";
import {
  buildDecision,
  buildTsRuntimeSpawnPayload,
  checkActiveTaskRecovery,
  resolveStatelessPolicyDecision,
} from "../resolve/policy-resolver.js";
import {
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
  finalizeDispatchMetadata,
  isManagedAgentContext,
  resolvePolicyStateKey,
  resolvePolicyStateKeys,
} from "../resolve/session.js";
import { policySummaryText } from "../replay/policy-utils.js";
import {
  recordPolicyReplay,
} from "../replay/replay.js";
import { policyState } from "../state/policy-state.js";
import {
  authoritativeDecisionRoute,
  canonicalizeDecisionForPolicyState,
  normalizeLiveRoute,
} from "../resolve/route-helpers.js";
import type { NativeFlowStatus, WorkContract } from "@octoclaw/contracts/work-contract";
import { listWorkContractsBySession, loadWorkContract } from "../work-contract/store.js";
import { markChildSessionPreferred, selectPreferredChildSession } from "../work-contract/continuity.js";
import { confirmNativeSpawn } from "../delegate/native-spawn-confirm.js";
import {
  readSpeculativePreloadState,
  type SpeculativePreloadState,
} from "../delegate/speculative-preload.js";
import { hasBudgetedMainEscalationEvidence } from "../budgeted-main.js";
import { detectIMType } from "../im-status-renderer.js";
import { openRuntimeLedger } from "../runtime-ledger/index.js";
import { resolveRuntimeLedgerMode } from "../runtime-ledger/shadow.js";
import { performCrashRecovery } from "../runtime-ledger/crash-recovery.js";
import {
  promoteToQueued,
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
  parseObjectJson,
  stringArray,
  toolResponse,
  upsertTaskStateCache,
} from "./registration-helpers.js";
import {
  buildNativeStatusOutput,
  buildNativeStatusPanelOutput,
  buildNativeTaskActionPayload,
  normalizeTaskActionFormat,
  parseTaskAction,
  taskStateRecordMatchesId,
  type RuntimeTaskStateRecord,
} from "./runtime-status.js";
import {
  confirmedNativePlannerRefs,
  delegatedStickyRoute,
  dispatchReplyToMessageId,
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
  buildNativeStatusPanelOutput,
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

export function selectLatestSpeculativePreloadCandidate(input: {
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

export function selectSpeculativePreloadForDispatch(input: {
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



export function shouldPromoteBudgetedMainDispatch(input: {
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

  const state = asRecord(input.state);
  const workContractView = asRecord(input.decision.work_contract);
  const alreadyEscalated = hasBudgetedMainEscalationEvidence(state, input.decision)
    || routeDecision.dispatch_required === true;
  const hasDelegateContract = input.workContract?.route === "delegate"
    || asString(workContractView.route) === "delegate";
  if (alreadyEscalated) return true;
  if (decisionBucket !== "budgeted_main_then_delegate") return false;
  return alreadyEscalated || hasDelegateContract;
}


export function validateDispatchWorkContract(contract: WorkContract | null, workContractId: string): { ok: true; contract: WorkContract } | { ok: false; route: string; error: string } {
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

function workContractTimeMs(contract: WorkContract): number {
  const values = [contract.createdAt, contract.updatedAt].map((value) => Date.parse(asString(value)));
  const finite = values.filter((value) => Number.isFinite(value));
  return finite.length > 0 ? Math.max(...finite) : 0;
}

export function policyStateTimeMs(state: UnknownRecord | null, decision: UnknownRecord): number {
  const stateRecord = asRecord(state);
  const routeSeal = asRecord(stateRecord.routeSeal || decision.routeSeal);
  const workContract = asRecord(decision.work_contract);
  const values = [
    Number(stateRecord.updatedAt || 0),
    Number(stateRecord.createdAt || 0),
    Date.parse(asString(routeSeal.createdAt)),
    Date.parse(asString(workContract.updatedAt || workContract.createdAt)),
  ].filter((value) => Number.isFinite(value) && value > 0);
  return values.length > 0 ? Math.max(...values) : 0;
}

function workContractHasNativeDispatchEvidence(contract: WorkContract): boolean {
  const telemetry = asRecord(contract.telemetry);
  const refs = asRecord(contract.nativeSpawnRefs);
  const delegate = asRecord(contract.delegate);
  const nativeBinding = asRecord(delegate.nativeBinding);
  return telemetry.dispatchExecuted === true
    || telemetry.spawnExecuted === true
    || telemetry.resultMaterialized === true
    || Boolean(asString(refs.openclawRunId || refs.childRunId || refs.childSessionKey || refs.spawnIntentId))
    || Boolean(asString(nativeBinding.runId || nativeBinding.childRunId || nativeBinding.childSessionKey || nativeBinding.nativeTaskId));
}

export function selectLatestSealedDelegateWorkContract(input: {
  sessionKeys: string[];
  newerThanMs: number;
  excludedWorkContractIds?: string[];
}): WorkContract | null {
  const excluded = new Set((input.excludedWorkContractIds ?? []).map((value) => asString(value)).filter(Boolean));
  const candidates: WorkContract[] = [];
  const seen = new Set<string>();
  for (const sessionKey of Array.from(new Set(input.sessionKeys.map((value) => asString(value)).filter(Boolean)))) {
    for (const contract of listWorkContractsBySession(sessionKey)) {
      if (!contract?.workContractId || seen.has(contract.workContractId)) continue;
      seen.add(contract.workContractId);
      if (excluded.has(contract.workContractId)) continue;
      if (contract.route !== "delegate" || contract.status !== "sealed") continue;
      if (workContractHasNativeDispatchEvidence(contract)) continue;
      const contractTime = workContractTimeMs(contract);
      if (input.newerThanMs > 0 && contractTime > 0 && contractTime <= input.newerThanMs) continue;
      candidates.push(contract);
    }
  }
  return candidates
    .sort((left, right) => workContractTimeMs(right) - workContractTimeMs(left))[0] ?? null;
}


export function nativePlannerAlreadyStartedResponse(params: {
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

export function nativeFlowStatusFromSubstrate(substrate: string): NativeFlowStatus {
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

export function selectRouteSealState(ctx: UnknownRecord, stateKey: string, state: UnknownRecord | null): UnknownRecord | null {
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


export function toolLogger(ctx: UnknownRecord): UnknownRecord {
  return asRecord(ctx.logger);
}

export function warnToolLogger(ctx: UnknownRecord, message: string): void {
  const warn = toolLogger(ctx).warn;
  if (typeof warn === "function") {
    warn(message);
  }
}


export function statusToolResponse(
  rawOutput: string,
  format: string,
  imType: string = "plain",
  interactiveBlocks?: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const nativeCard = Array.isArray(interactiveBlocks) && interactiveBlocks.length > 0;
  // Native IM renderers should preserve mrkdwn/card fallback text. Plain text
  // keeps the existing code block behavior for CLI-style surfaces.
  const text = imType === "slack" || nativeCard
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
      ...(nativeCard ? {
        interactive_blocks: interactiveBlocks,
        im_native_card: true,
      } : {}),
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

export async function userFacingHandoff(payload: Record<string, unknown>, fallback: string, cwd?: string): Promise<string> {
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

export function resolveDispatchPolicyContext(ctx: UnknownRecord, prompt = ""): { key: string; state: UnknownRecord | null } {
  const fromStore = asRecord(policyState.getDispatchPolicyContext(ctx, prompt));
  const contextKey = asString(fromStore.key);
  const contextState = isRecord(fromStore.state) ? fromStore.state : null;
  if (contextKey || contextState) {
    return { key: contextKey, state: contextState };
  }
  return { key: asString(resolvePolicyStateKey(ctx)), state: null };
}

export function setPolicyStateForContext(ctx: UnknownRecord, entry: UnknownRecord, explicitKey = ""): string {
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


export async function persistStickyLane(sessionKey: string, payload: UnknownRecord, logger: unknown, source: string): Promise<Record<string, unknown>> {
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



export function ctxCwd(ctx: UnknownRecord): string {
  return asString(ctx.cwd, process.cwd());
}

function ctxUi(ctx: UnknownRecord): { notify?: (message: string, level?: string) => void; setEditorText?: (text: string) => void } {
  return asRecord(ctx.ui) as { notify?: (message: string, level?: string) => void; setEditorText?: (text: string) => void };
}

function hasUi(ctx: UnknownRecord): boolean {
  return ctx.hasUI === true;
}

export function readHelperInvoker(...values: unknown[]): NativeHelperInvoker | null {
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

export function buildMinimalProjection(params: {
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
          model: { type: "string", description: "Optional explicit child model override for delegated dispatch, for example gpt-5.5." },
          complexityBand: { type: "string", enum: ["simple", "normal", "deep"], description: "Task complexity band. simple=light research/observer work, normal=GLM-5.1, deep=gpt-5.4" },
          expectedSeconds: { type: "number", description: "Main agent's estimate of how long this task should take. Used as timeout baseline." },
          timeoutSeconds: { type: "number", description: "Runner timeout in seconds." },
          sessionKey: { type: "string", description: "Optional session key override." },
          metadataJson: { type: "string", description: "Optional JSON object with extra session metadata. For delegated work, include known anchors as context_refs: { primaryFiles, readScope, writeScope, sourcePolicy, maxToolCalls, workspaceMode }. For explicit persistent side effects without a narrower write target, use context_refs: { requestedSideEffects: true, workspaceMode: \"write_allowed\" }." },
          policyJson: { type: "string", description: "Optional precomputed runtime policy decision JSON." },
          workContractId: { type: "string", description: "Optional sealed WorkContract id to dispatch without re-judging." },
          delegateTaskId: { type: "string", description: "Optional delegate task id for continuation-aware dispatch." },
          continuationMode: { type: "string", enum: ["resume_preferred", "status_only", "new_attempt"], description: "Optional continuation hint for WorkContract dispatch." },
        },
        required: ["task"],
      },
      execute: (params, _rawCtx) => executeOctoclawDispatch(params, _rawCtx ?? {}, options),
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
        const output = await buildNativeStatusPanelOutput(format, imType, ctx);
        return statusToolResponse(output.text, format, imType, output.interactiveBlocks);
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
