import {
  buildTsRuntimeDispatchPayload,
  resolveStatelessPolicyDecision,
} from "../../resolve/policy-resolver.js";
import {
  stableId,
  truncateText,
} from "../../resolve/env.js";
import {
  applyUserMetadataOverrides,
  buildPolicyMetadata,
  detectSessionBoundary,
  finalizeDispatchMetadata,
  resolveDispatchSessionKey,
} from "../../resolve/session.js";
import {
  recordDispatchLifecycleReplayEvents,
  recordPolicyReplay,
} from "../../replay/replay.js";
import { policyState } from "../../state/policy-state.js";
import {
  authoritativeDecisionRoute,
  normalizeLiveRoute,
} from "../../resolve/route-helpers.js";
import { createOpenClawDistTaskFlowPort } from "../../ports/openclaw-dist-taskflow-port.js";
import { checkTaskflowCapability } from "../../ports/taskflow-port.js";
import type { NativeBindingRef, WorkContract } from "@octoclaw/contracts/work-contract";
import { loadWorkContract } from "../../work-contract/store.js";
import { materializeWorkContractSuccess, materializeWorkContractFailure } from "../../work-contract/materializer.js";
import { selectPreferredChildSession } from "../../work-contract/continuity.js";
import { emitExecutionTransitionNotification } from "../../ack/execution-transition-notifier.js";
import { isPlannerAllowedForSession, resolvePlannerAllowlist, resolveSpawnBackend, resolveSpawnIntentTtlMs, resolveSpeculativePreloadEnabled } from "../../config/index.js";
import { nativeSpawnIntentStore } from "../../delegate/native-spawn-intent-store.js";
import {
  nativeAcpFallbackMetadata,
  readNativeAcpFallbackSnapshot,
  resolveNativeAcpFallbackMode,
} from "../../delegate/native-acp-fallback.js";
import {
  buildSpeculativeSessionsSendArgs,
  serializeSpeculativePreloadState,
} from "../../delegate/speculative-preload.js";
import { escalateBudgetedMainDecision, hasBudgetedMainEscalationEvidence } from "../../budgeted-main.js";
import {
  evaluateDispatchAdmission,
  explicitDelegateDispatchRequest,
  resolveDispatchTargetRoute,
} from "../../dispatch-admission.js";
import { getModelMap } from "../../model-map.js";
import { buildDelegationTicketDryRun } from "../../runtime-ledger/ticket-dry-run.js";
import { admitDelegationTicketForDispatch, issueDelegationTicketCandidate } from "../../runtime-ledger/ticket-enforcement.js";
import {
  type UnknownRecord,
  isRecord,
  asRecord,
  asString,
  asNumberOptional as asNumber,
} from "../../util/type-coercion.js";
import {
  optionalString,
  parseObjectJson,
  toolResponse,
  compactDispatchDetails,
  upsertTaskStateCache,
} from "../registration-helpers.js";
import {
  buildPlannerSessionsSpawnArgs,
  plannedAttemptId,
  plannedDelegateTaskId,
} from "../planner-context.js";
import {
  dispatchSpawnEvidence,
  hasNonNewWorkFollowupEvidence,
  plannerDispatchResponse,
  speculativePreloadStandbyRequiredResponse,
  type RuntimeTaskStateRecord,
} from "../runtime-status.js";
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
} from "../dispatch-logic.js";
import {
  buildMinimalProjection,
  ctxCwd,
  nativeFlowStatusFromSubstrate,
  nativePlannerAlreadyStartedResponse,
  policyStateTimeMs,
  persistStickyLane,
  readHelperInvoker,
  resolveDispatchPolicyContext,
  selectLatestSpeculativePreloadCandidate,
  selectSpeculativePreloadForDispatch,
  selectLatestSealedDelegateWorkContract,
  selectRouteSealState,
  setPolicyStateForContext,
  shouldPromoteBudgetedMainDispatch,
  toolLogger,
  userFacingHandoff,
  validateDispatchWorkContract,
  type ToolRegistrationOptions,
} from "../registration.js";

export async function executeOctoclawDispatch(params: Record<string, unknown>, _rawCtx: Record<string, unknown>, options: ToolRegistrationOptions = {}): Promise<Record<string, unknown>> {
        const ctx = _rawCtx ?? {};
        const dispatchToolStartedAt = Date.now();
        let { key: stateKey, state } = resolveDispatchPolicyContext(ctx, asString(params.task));
        let hadCachedDecision = Boolean(params.policyJson || state?.decision);
        let cachedDecision = selectDispatchPolicyDecision(state?.decision, params.policyJson);
        let dispatchWorkContract: WorkContract | null = null;
        let workContractDispatchError: { route: string; error: string } | null = null;
        const explicitWorkContractId = asString(params.workContractId);
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
        let initialMetadata = applyUserMetadataOverrides(
          {
            ...buildPolicyMetadata(ctx, { stateKey: stateKey || asString(asRecord(cachedDecision.request).session_key) }),
            ...(asString(params.sessionKey) ? { session_key: asString(params.sessionKey) } : {}),
            ...(asString(params.model) ? { model: asString(params.model), model_override_source: "dispatch_param" } : {}),
          },
          parseObjectJson(params.metadataJson),
        );
        const managedSessionKey = asString(asRecord(cachedDecision.request).session_key || initialMetadata.session_key);
        let resolvedRoute = resolveDispatchTargetRoute({
          params: asRecord(params),
          metadata: initialMetadata,
          cachedDecision,
          fallbackRoute: promoteBudgetedMainDispatch ? "delegate" : asRecord(cachedDecision.route_decision).route,
          dispatchCallImpliesDelegateObjection: true,
        }).route;
        const isDelegatedRoute = resolvedRoute === "delegate";
        if (!dispatchWorkContract && isDelegatedRoute) {
          const fallbackContract = selectLatestSealedDelegateWorkContract({
            sessionKeys: [
              managedSessionKey,
              stateKey,
              asString(params.sessionKey),
              asString(initialMetadata.session_key),
              asString(asRecord(cachedDecision.request).session_key),
              asString(ctx.canonicalSessionKey),
              asString(ctx.sessionKey),
            ],
            newerThanMs: policyStateTimeMs(state, cachedDecision),
            excludedWorkContractIds: [requestedWorkContractId],
          });
          if (fallbackContract) {
            dispatchWorkContract = fallbackContract;
            cachedDecision = decisionFromWorkContract(fallbackContract, cachedDecision);
            hadCachedDecision = true;
            workContractDispatchError = null;
            await recordPolicyReplay("dispatch_latest_delegate_work_contract_selected", {
              sessionKey: managedSessionKey,
              sessionId: asString(ctx.sessionId),
              route: resolvedRoute,
              stateKey,
              workContractId: fallbackContract.workContractId,
              priorWorkContractId: requestedWorkContractId,
            }, toolLogger(ctx), cachedDecision);
          }
        }
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
        if (workContractDispatchError && explicitWorkContractId) {
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
        let routeSealState = dispatchWorkContract ? null : selectRouteSealState(ctx, stateKey, state);
        let cachedRouteSeal = validCachedRouteSeal(routeSealState, cachedDecision, initialMetadata);
        const explicitDelegateRequest = explicitDelegateDispatchRequest({
          params: asRecord(params),
          metadata: initialMetadata,
          cachedDecision,
          dispatchCallImpliesDelegateObjection: true,
        });
        const explicitDelegateDispatchOverride = cachedRouteSeal?.route === "reply"
          && resolvedRoute === "delegate"
          && authoritativeDecisionRoute(cachedDecision, "reply") === "reply"
          && explicitDelegateRequest.requested;
        if (explicitDelegateDispatchOverride) {
          if (!explicitWorkContractId && String(workContractDispatchError?.error || "").startsWith("work_contract_route_not_dispatchable:")) {
            await recordPolicyReplay("stale_reply_work_contract_dispatch_ignored", {
              sessionKey: managedSessionKey,
              sessionId: asString(ctx.sessionId),
              route: resolvedRoute,
              staleWorkContractId: requestedWorkContractId,
              admissionReason: explicitDelegateRequest.reason,
            }, toolLogger(ctx), cachedDecision);
            workContractDispatchError = null;
          }
          const overrideConversationControl = {
            ...asRecord(initialMetadata.conversation_control),
            source: "explicit_conversation_control",
            explicit_delegate_request: true,
            intent_class: "delegated_work",
          };
          initialMetadata = {
            ...initialMetadata,
            conversation_control: overrideConversationControl,
            requested_route: "delegate",
            route_request_source: "force_route",
            route_request_trusted: true,
            is_new_work: true,
            expected_deliverable: asString(initialMetadata.expected_deliverable || initialMetadata.expectedDeliverable || params.task).slice(0, 200),
          };
          cachedDecision = await resolveStatelessPolicyDecision(asString(params.task), {
            command: asString(params.command),
            metadata: initialMetadata,
            forceRoute: "delegate",
          });
          freshDecisionSource = "explicit_delegate_dispatch_override";
          hadCachedDecision = true;
          const overrideWorkContractId = selectDispatchWorkContractId(asRecord(params), cachedDecision);
          if (overrideWorkContractId) {
            const validation = validateDispatchWorkContract(loadWorkContract(overrideWorkContractId), overrideWorkContractId);
            if (validation.ok) {
              dispatchWorkContract = validation.contract;
            }
          }
          routeSealState = { routeSeal: cachedDecision.routeSeal };
          cachedRouteSeal = validCachedRouteSeal(routeSealState, cachedDecision, initialMetadata);
        }
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
        const routeSealStates = [
          routeSealState,
          state,
          policyState.get(managedSessionKey),
          policyState.get(stateKey),
          policyState.get(asString(ctx.canonicalSessionKey)),
          policyState.get(asString(ctx.sessionKey)),
          policyState.get(asString(initialMetadata.session_key)),
        ];
        const budgetedMainEscalationEvidence = hasBudgetedMainEscalationEvidence(state, cachedDecision)
          || routeSealStates.some((candidate) => hasBudgetedMainEscalationEvidence(candidate, cachedDecision));
        const dispatchAdmissionResult = evaluateDispatchAdmission({
          resolvedRoute,
          cachedRouteSeal,
          explicitWorkContractId,
          requestedWorkContractId,
          workContractRoute: requestedWorkContractId ? (loadWorkContract(requestedWorkContractId)?.route ?? null) : null,
          explicitDelegateRequest,
          budgetedMainEscalationEvidence,
          statusFollowup: false,
        });
        const budgetedMainEscalationAllowed = dispatchAdmissionResult.reason === "budgeted_main_escalation";
        const staleReplyContractErrorIgnored = Boolean(
          workContractDispatchError
            && !explicitWorkContractId
            && resolvedRoute === "delegate"
            && String(workContractDispatchError.error || "").startsWith("work_contract_route_not_dispatchable:")
            && dispatchAdmissionResult.supersedeStaleReplyWorkContract,
        );
        if (workContractDispatchError && !staleReplyContractErrorIgnored) {
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
        if (staleReplyContractErrorIgnored) {
          await recordPolicyReplay("stale_reply_work_contract_dispatch_ignored", {
            sessionKey: managedSessionKey,
            sessionId: asString(ctx.sessionId),
            route: resolvedRoute,
            staleWorkContractId: requestedWorkContractId,
            admissionReason: dispatchAdmissionResult.reason,
          }, toolLogger(ctx), cachedDecision);
          workContractDispatchError = null;
        }
        if (cachedRouteSeal && resolvedRoute !== cachedRouteSeal.route && !dispatchAdmissionResult.allowed) {
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
        } else if (explicitDelegateDispatchOverride) {
          await recordPolicyReplay("sealed_explicit_delegate_dispatch_allowed", {
            sessionKey: managedSessionKey,
            sessionId: asString(ctx.sessionId),
            route: resolvedRoute,
            sealedRoute: "reply",
            hadCachedDecision,
            policyJsonProvided: Boolean(params.policyJson),
            model: asString(params.model || initialMetadata.model),
            reason: dispatchAdmissionResult.reason || explicitDelegateRequest.reason,
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
        const explicitModelOverride = asString(params.model || metadata.model);
        const selectedModel = explicitModelOverride
          || (complexityBand && complexityModelMap[complexityBand]
            ? complexityModelMap[complexityBand]
            : budgetBand && budgetModelMap[budgetBand]
            ? budgetModelMap[budgetBand]
            : "");
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

        if (isDelegatedRoute) {
          const spawnBackend = resolveSpawnBackend();
          const nativeAcpFallback = nativeAcpFallbackMetadata(
            readNativeAcpFallbackSnapshot(),
            resolveNativeAcpFallbackMode(),
          );
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
            resolveDispatchSessionKey(ctx, metadata, { stateKey, state, cachedDecision }),
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
            native_acp_fallback: nativeAcpFallback,
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
              native_acp_fallback: nativeAcpFallback,
              elapsedMs: Date.now() - dispatchToolStartedAt,
            }, toolLogger(ctx), null);
            return plannerDispatchResponse({
              spawnIntentId: intent.spawnIntentId,
              workContractId,
              delegateTaskId,
              attemptId,
              ticketId: ticketAdmission.ticket_id,
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
              user_message: "Dispatch registered but no child session/runId evidence yet. Task is not started. Retry dispatch or handle directly in main session.",
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
          model: selectedModel || asString(metadata.model),
          modelProfile: selectedModel || asString(metadata.model),
        });
}
