import { type UnknownRecord, asRecord } from "../util/type-coercion.js";
import type { PluginInterface } from "../extension-entry-shared.js";
import { stringValue } from "../extension-entry-shared.js";
import {
  getPolicyStateForContext,
  updatePolicyState,
} from "../extension-entry.js";
import { appendReplyProjectionFooter } from "./footer-mode.js";
import { stripProjectionFooterFromText } from "../projection-footer-sanitizer.js";

export interface ReplyUsageHookDeps {
  pi: PluginInterface;
}

/**
 * Build the `reply_payload_sending` hook handler.
 *
 * openclaw 6.8 surfaces a per-turn `usageState` on this hook carrying the
 * authoritative post-fallback model, fallback flag, requested model, and turn
 * duration. We do two things here:
 *
 *   1. Persist `usageState` onto the policy state so every footer render path
 *      (reply_dispatch / message_sending / before_message_write) reads the
 *      same live model rather than guessing from config.
 *   2. Re-render the footer on the payload text right here. Because this hook
 *      fires on the live dispatcher's `beforeDeliver` chain, stripping the
 *      previously-stamped footer and re-applying one sourced from `usageState`
 *      avoids any timing race with the other render points — the payload that
 *      actually gets delivered carries the corrected footer.
 *
 * When `usageState` is absent (agent turn failed, durable/replay delivery,
 * or openclaw < 6.8), we return `void` and leave the payload untouched; the
 * footer degrades to the persisted-field chain and surfaces `health=no-usage`.
 */
export function makeReplyPayloadSendingHook(deps: ReplyUsageHookDeps) {
  void deps;
  return (event: UnknownRecord, ctx: UnknownRecord): { payload?: UnknownRecord } | void => {
    const eventRecord = asRecord(event);
    const ctxRecord = asRecord(ctx);

    const usageState = asRecord(eventRecord.usageState);
    const hasLiveUsage = usageState && Object.keys(usageState).length > 0;
    if (!hasLiveUsage) return;

    // Persist the usage snapshot so downstream footer renderers (and the
    // agent_end health recorder) see the live model/duration.
    const { key, state } = getPolicyStateForContext(ctxRecord);
    if (key && state) {
      updatePolicyState(key, (current) => ({
        ...current,
        replyUsageState: usageState,
        reply_usage_state: usageState,
      }));
    }

    // Re-render the footer directly on the payload text. This is the
    // race-free path: whatever footer was stamped earlier (from the degraded
    // chain) is stripped and replaced with one sourced from the live model.
    const payload = asRecord(eventRecord.payload);
    const text = stringValue(payload.text);
    if (!text) return;

    const stripped = stripProjectionFooterFromText(text);
    // appendReplyProjectionFooter reads replyUsageState from the freshly-updated
    // state, so it renders the post-fallback model + duration + ⚡ marker.
    const reRenderedState = state ? asRecord(state) : {};
    const reRendered = appendReplyProjectionFooter(stripped, { ...reRenderedState, replyUsageState: usageState, reply_usage_state: usageState }, eventRecord, ctxRecord);
    if (reRendered === stripped || reRendered === text) return;

    return {
      payload: {
        ...payload,
        text: reRendered,
      },
    };
  };
}
