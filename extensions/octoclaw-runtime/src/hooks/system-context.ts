import { stringValue } from "../extension-entry-shared.js";
import type { UnknownRecord } from "../util/type-coercion.js";

export const OCTOCLAW_DELEGATION_SYSTEM_CONTEXT = [
  "OctoClaw runtime policy is authoritative for this run.",
  "When route is delegated, the main agent is a coordinator and must use OctoClaw control tools instead of doing the work directly.",
  "Do not hand-write session or subagent spawning commands.",
  "Do not explain delegation strategy, routing rationale, or task boundary analysis to the user. Use octoclaw_dispatch directly.",
  "When delegated work depends on local code, docs, or repo state, pass the smallest known anchors to octoclaw_dispatch as metadataJson.context_refs.",
  "Use this shape when anchors are known: {\"context_refs\":{\"primaryFiles\":[\"path\"],\"readScope\":[\"dir\"],\"sourcePolicy\":\"local refs first\",\"maxToolCalls\":4,\"workspaceMode\":\"read_only\"}}.",
  "When the user explicitly requests a persistent side effect and no narrower write target is known, pass {\"context_refs\":{\"requestedSideEffects\":true,\"workspaceMode\":\"write_allowed\"}}; do not rely on the child to infer write permission from wording.",
  "If anchors are not already known, use at most two lightweight read-only lookups to find exact refs, or dispatch without refs and let the child report missing context; never fabricate refs just to fill the packet.",
  "Do not emit user-visible coordinator chatter or ACK text such as '我来写'、'收到，我看一下'、'我先确认一下派发边界'. Runtime ACK handles acknowledgments as tracked deliverables.",
  "Before tool calls or route_hint, emit no user-visible text. User-visible output should only contain authoritative status receipt, final result, or clear failure.",
].join("\n");

export const OCTOCLAW_DELEGATION_SLIM_SYSTEM_CONTEXT = [
  "OctoClaw delegated-route context: before native spawn, answer directly only if this turn can be fully resolved now without background work.",
  "If delegation is still needed, use octoclaw_dispatch; do not hand-write sessions_spawn args or bypass the returned planner intent.",
  "Pass only already-known local anchors as metadataJson.context_refs; if anchors are unknown, dispatch without fabricated refs and let the child return a blocked worker result packet.",
  "For explicit persistent side effects, pass metadataJson.context_refs.requestedSideEffects=true and workspaceMode=write_allowed.",
  "Emit no user-visible ACK/coordinator text before accepted native run evidence and OctoClaw confirm exist.",
].join("\n");

export function resolveSlimMainContextEnabled(pluginConfig?: UnknownRecord): boolean {
  const env = stringValue(process.env.OCTOCLAW_SLIM_MAIN_CONTEXT).toLowerCase();
  if (env === "0" || env === "false" || env === "off") return false;
  const configured = pluginConfig?.slimMainContext ?? pluginConfig?.slim_main_context;
  if (configured === false) return false;
  if (stringValue(configured).toLowerCase() === "false") return false;
  return true;
}



export const OCTOCLAW_ROUTE_HINT_SYSTEM_CONTEXT = [
  "Use octoclaw_route_hint only as an internal control-plane action when runtime policy requires it; never introduce it with user-visible text.",
  "Use octoclaw_route_hint to state only the two-class route intent: reply or delegate. Runtime derives must_reply, must_delegate, or budgeted_main_then_delegate from route plus cost signals.",
  "After route_hint merge: reply may answer directly; delegated routes must go through octoclaw_dispatch.",
  "",
  "Handle directly for greetings, simple Q&A, clarifications, status/provenance follow-up, and up to two lightweight read-only lookups when they fit the budget.",
  "Delegate only for explicit background/subagent/parallel work, code/file mutation, tests/builds, long commands, multi-step tools, review/validation, or work that cannot fit the budget.",
  "Bare model/tool names, fresh lookup, route_hint=delegate, and fast_first_response are advisory only and do not force delegate by themselves.",
].join("\n");

export const OCTOCLAW_TASK_ACTION_SYSTEM_CONTEXT = [
  "When the user asks for task progress or acts on an OctoClaw task anchor, prefer the octoclaw_task_action tool.",
  "Use it for commands like: details <task_id>, queue, artifacts <task_id>, stop <task_id>, retry <task_id>, approve <task_id>, reject <task_id>.",
].join("\n");

export const OCTOCLAW_PRE_DELEGATION_CONFIRM_CONTEXT = [
  "This task requires review before dispatch. Proceed directly with octoclaw_dispatch — do not echo reasoning about task boundaries or delegation strategy to the user.",
].join("\n");
