import { resolvePolicyDecisionForContext } from "../resolve/policy-resolver.js";
import {
  isManagedAgentContext,
  resolvePolicyStateKey,
} from "../resolve/session.js";
import { recordPolicyReplay } from "../replay/replay.js";
import { type UnknownRecord, asRecord } from "../util/type-coercion.js";
import type { PluginInterface } from "../extension-entry-shared.js";
import { stringValue } from "../extension-entry-shared.js";
import { extractPromptText } from "../extension-entry-helpers.js";
import {
  handleNativeAnnounceCompletion,
  nativeAnnounceSendOverride,
} from "../extension-entry.js";

export interface BeforeModelResolveDeps {
  pi: PluginInterface;
}

export function makeBeforeModelResolveHook(deps: BeforeModelResolveDeps) {
  return async (event: UnknownRecord, ctx: UnknownRecord) => {
    if (!isManagedAgentContext(ctx)) return;
    const hookStartedAt = Date.now();
    const prompt = extractPromptText(event);
    const stateKey = resolvePolicyStateKey(ctx);
    const nativeAnnounceHandled = await handleNativeAnnounceCompletion({
      event,
      ctx,
      prompt,
      pluginConfig: deps.pi.pluginConfig,
      logger: deps.pi.logger,
      cwd: stringValue(ctx.cwd) || process.cwd(),
      sendMessage: nativeAnnounceSendOverride(deps.pi.pluginConfig),
    });
    if (nativeAnnounceHandled) {
      void recordPolicyReplay(
        "native_announce_model_resolve_skipped",
        {
          sessionKey: resolvePolicyStateKey(ctx),
          sessionId: stringValue(ctx.sessionId),
          sourceSessionKey: nativeAnnounceHandled.completion.sourceSessionKey,
          sourceTool: nativeAnnounceHandled.completion.sourceTool,
          resultHash: nativeAnnounceHandled.completion.resultHash,
          workContractId: nativeAnnounceHandled.workContractId || "",
          matched: nativeAnnounceHandled.matched,
          delivered: nativeAnnounceHandled.delivered,
        },
        deps.pi.logger,
        null,
      ).catch(() => {});
      return;
    }
    void recordPolicyReplay(
      "before_model_resolve_observed",
      {
        sessionKey: stateKey || stringValue(ctx.sessionKey),
        sessionId: stringValue(ctx.sessionId),
        stateKey,
        elapsedMs: Date.now() - hookStartedAt,
      },
      deps.pi.logger,
      null,
    ).catch(() => {});
    const policyResolveStartedAt = Date.now();
    void recordPolicyReplay(
      "before_model_policy_resolve_started",
      {
        sessionKey: stateKey || stringValue(ctx.sessionKey),
        sessionId: stringValue(ctx.sessionId),
        stateKey,
        elapsedMs: policyResolveStartedAt - hookStartedAt,
      },
      deps.pi.logger,
      null,
    ).catch(() => {});
    const resolved = await resolvePolicyDecisionForContext(
      prompt,
      ctx,
      process.cwd(),
      deps.pi.logger,
    );
    const modelPolicyDecision = asRecord(resolved?.decision);
    void recordPolicyReplay(
      "before_model_policy_resolve_completed",
      {
        sessionKey: stateKey || stringValue(ctx.sessionKey),
        sessionId: stringValue(ctx.sessionId),
        stateKey: stringValue(resolved?.stateKey || stateKey),
        elapsedMs: Date.now() - policyResolveStartedAt,
        hookElapsedMs: Date.now() - hookStartedAt,
        resolved: Boolean(resolved),
        usedCachedPolicy: resolved?.usedCachedPolicy === true,
        route: stringValue(asRecord(modelPolicyDecision.route_decision).route),
        decision_bucket: stringValue(asRecord(modelPolicyDecision.route_decision).decision_bucket),
        workContractId: stringValue(modelPolicyDecision.workContractId || asRecord(modelPolicyDecision.work_contract).workContractId || asRecord(modelPolicyDecision.work_contract).work_contract_id),
      },
      deps.pi.logger,
      null,
    ).catch(() => {});
    const decision = asRecord(resolved?.decision);
    const hookConfig = asRecord(decision.hook_interface).before_model_resolve;
    const resolvedHookConfig = asRecord(hookConfig);
    if (!resolvedHookConfig.enabled) return;
    if (stringValue(asRecord(decision.route_decision).route || "reply") !== "reply") return;
    const modelOverride = stringValue(resolvedHookConfig.selected_model);
    if (!modelOverride) return;
    deps.pi.logger?.debug?.(`octoclaw before_model_resolve modelOverride=${modelOverride}`);
    return { modelOverride };
  };
}
