import { resolvePolicyStateKey } from "../resolve/session.js";
import { recordPolicyReplay } from "../replay/replay.js";
import { type UnknownRecord, asRecord } from "../util/type-coercion.js";
import type { PluginInterface } from "../extension-entry-shared.js";
import { stringValue } from "../extension-entry-shared.js";
import { extractPromptText } from "../extension-entry-helpers.js";
import { extractInboundMessageTimestampWithSource, type InboundMessageTimestampSource } from "../inbound-timestamps.js";
import {
  getPolicyStateForContext,
  handleOctoClawControlPlaneFastPath,
} from "../extension-entry.js";
import {
  bindContextToCurrentTurn,
  promptMatchedInboundAnchor,
  resolveCurrentTurnBinding,
  usableExistingInboundAnchor,
} from "./inbound-anchor-state.js";

export interface BeforeDispatchDeps {
  pi: PluginInterface;
  maybeSendNeutralInboundAckForContext: (
    hookName: string,
    event: UnknownRecord,
    ctx: UnknownRecord,
    prompt?: string,
    overrides?: { stateKey?: string; sessionKey?: string; inboundMessageTs?: string; inboundMessageTsSource?: InboundMessageTimestampSource },
  ) => Promise<void>;
}

export function makeBeforeDispatchHook(deps: BeforeDispatchDeps) {
  return async (event: UnknownRecord, ctx: UnknownRecord) => {
    const prompt = extractPromptText(event);
    const eventRecord = asRecord(event);
    const ctxRecord = asRecord(ctx);
    const mergedCtx = { ...eventRecord, ...ctxRecord };
    const initialStateKey = resolvePolicyStateKey(mergedCtx);
    const initialStateInfo = getPolicyStateForContext(mergedCtx);
    const explicitAnchor = extractInboundMessageTimestampWithSource(ctxRecord, eventRecord, prompt);
    const currentTurnBinding = resolveCurrentTurnBinding({
      prompt,
      ctx: ctxRecord,
      event: eventRecord,
      fallbackStateKey: initialStateInfo.key || initialStateKey,
      fallbackState: initialStateInfo.state,
    });
    const boundCtx = currentTurnBinding ? bindContextToCurrentTurn(mergedCtx, currentTurnBinding) : mergedCtx;
    const stateKey = currentTurnBinding?.stateKey || initialStateKey;
    const extractedAnchor = explicitAnchor.ts ? explicitAnchor : extractInboundMessageTimestampWithSource(boundCtx, eventRecord, prompt);
    const existingStateInfo = getPolicyStateForContext(boundCtx);
    const existingState = asRecord(existingStateInfo.state);
    const promptAnchor = currentTurnBinding || promptMatchedInboundAnchor(prompt);
    const existingAnchor = usableExistingInboundAnchor({
      prompt,
      currentStateKey: stateKey,
      resolvedStateKey: existingStateInfo.key,
      state: existingState,
    });
    const stateAnchor = promptAnchor?.replyToMessageId
      || existingAnchor?.replyToMessageId;
    const anchor = extractedAnchor.ts
      ? extractedAnchor
      : stateAnchor
        ? { ts: stateAnchor, source: "ctx" as const }
        : extractedAnchor;
    void recordPolicyReplay(
      "before_dispatch_observed",
      {
        sessionKey: stringValue(currentTurnBinding?.sessionKey || mergedCtx.sessionKey || event.sessionKey),
        sessionId: stringValue(mergedCtx.sessionId || event.sessionId),
        stateKey,
        inboundMessageTs: anchor.ts,
        anchor_source: anchor.source,
      },
      deps.pi.logger,
      null,
    ).catch(() => {});
    const controlPlaneResult = await handleOctoClawControlPlaneFastPath({
      prompt,
      mergedCtx: boundCtx,
      eventRecord,
      ctxRecord,
      stateKey,
      logger: deps.pi.logger,
    });
    if (controlPlaneResult) return controlPlaneResult;
    void deps.maybeSendNeutralInboundAckForContext("before_dispatch", event, boundCtx, prompt, {
      stateKey,
      sessionKey: currentTurnBinding?.sessionKey,
      inboundMessageTs: anchor.ts,
      inboundMessageTsSource: anchor.source,
    }).catch((error) => {
      deps.pi.logger?.warn?.(`octoclaw neutral inbound ACK failed: ${String(error)}`);
    });
  };
}
