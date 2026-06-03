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
  promptMatchedInboundAnchor,
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
    const stateKey = resolvePolicyStateKey(mergedCtx);
    const extractedAnchor = extractInboundMessageTimestampWithSource(ctxRecord, eventRecord, prompt);
    const existingStateInfo = getPolicyStateForContext(mergedCtx);
    const existingState = asRecord(existingStateInfo.state);
    const promptAnchor = promptMatchedInboundAnchor(prompt);
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
        sessionKey: stringValue(mergedCtx.sessionKey || event.sessionKey),
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
      mergedCtx,
      eventRecord,
      ctxRecord,
      stateKey,
      logger: deps.pi.logger,
    });
    if (controlPlaneResult) return controlPlaneResult;
    void deps.maybeSendNeutralInboundAckForContext("before_dispatch", event, ctx, prompt, {
      stateKey,
      inboundMessageTs: anchor.ts,
      inboundMessageTsSource: anchor.source,
    }).catch((error) => {
      deps.pi.logger?.warn?.(`octoclaw neutral inbound ACK failed: ${String(error)}`);
    });
  };
}
