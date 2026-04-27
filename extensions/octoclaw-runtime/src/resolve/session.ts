import {
  resolveMainAgentSessionsPath,
  resolveReplayLogPath,
  resolveRootSessionsPath,
  resolveTaskStatePath,
  stableId,
} from "./env.js";
import { buildConversationControlHintsFromIntent } from "../conversation-grounding.js";
import fsSync from "node:fs";

export const IM_SESSION_ORIGINS = new Set([
  "slack",
  "discord",
  "telegram",
  "whatsapp",
  "signal",
  "msteams",
  "googlechat",
  "wechat",
  "webchat",
  "feishu",
]);

export const SESSION_NAMESPACE_KINDS = new Set(["default"]);
export const USER_SESSION_KINDS = new Set(["dm", "direct", "user"]);
export const CHANNEL_SESSION_KINDS = new Set(["channel", "group", "room", "conversation", "space", "chat"]);
export const THREAD_SESSION_KINDS = new Set(["thread", "topic"]);

export interface SessionRouteInfo {
  sessionKey: string;
  stripped: string;
  origin: string;
  target: string;
  threadId: string;
  bindingKey: string;
  threadKey: string;
  looksLikeImSession: boolean;
  isPrimaryMainSession: boolean;
  imSession: boolean;
  channelSession: boolean;
  userSession: boolean;
  threadSession: boolean;
}

export interface SessionDescriptor extends SessionRouteInfo {
  controlKey: string;
  channelSessionKey: string;
  sessionId: string;
  sessionFile: string;
  nativeChannelId: string;
  chatType: string;
  updatedSort: number;
  isSubagent: boolean;
  isUserFacing: boolean;
  isContaminatedUserSession: boolean;
}

export interface AckTargetInfo {
  ackTarget: string;
  ackThreadId: string;
}

export interface AckTargetResolutionInfo {
  hasTarget: boolean;
  hasThread: boolean;
}

export interface AckDeliveryInfo {
  delivered: boolean;
  deliveryId: string;
}

export interface SessionBoundaryInfo {
  sessionKey: string;
  sessionId: string;
  agentId: string;
  hasCanonicalUserSession: boolean;
  contaminatedBySubagent: boolean;
  contaminatedByRegistry: boolean;
  subagentRefs: string[];
  registrySubagentRefs: string[];
  canonicalSessionKey: string;
  canonicalBindingKey: string;
  canonicalThreadKey: string;
  status: string;
  reason: string;
}

type UnknownRecord = Record<string, unknown>;
type FsSyncCompat = {
  readFileSync: (pathname: string, encoding: string) => string;
};

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readJsonFileSync<T>(pathname: string, fallback: T): T {
  try {
    const raw = (fsSync as unknown as FsSyncCompat).readFileSync(pathname, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function stringValue(value: unknown): string {
  return String(value ?? "").trim();
}

function lowerStringValue(value: unknown): string {
  return stringValue(value).toLowerCase();
}

function recordValue(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function parseUpdatedSortValue(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  const text = stringValue(value);
  if (!text) {
    return 0;
  }
  if (/^\d+(\.\d+)?$/u.test(text)) {
    return Number(text);
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

function buildConversationIntentPacketCompat(options: UnknownRecord = {}): UnknownRecord {
  return {
    available: true,
    prompt: stringValue(options.prompt),
    replay_log_path: stringValue(options.replayLogPath),
    task_state_path: stringValue(options.taskStatePath),
    session_keys: Array.isArray(options.sessionKeys) ? options.sessionKeys : [],
  };
}

function buildConversationControlHintsFromIntentCompat(intentPacket: UnknownRecord = {}): UnknownRecord {
  if (recordValue(intentPacket).available === false) {
    return { available: false };
  }

  const projected = recordValue(buildConversationControlHintsFromIntent(intentPacket));
  if (projected.available) {
    return {
      ...projected,
      source: "session_resolver_fallback",
      subject_prompt: stringValue(intentPacket.prompt),
    };
  }

  return {
    available: true,
    source: "session_resolver_fallback",
    subject_prompt: stringValue(intentPacket.prompt),
  };
}

export function stripAgentSessionPrefix(raw: string): string {
  const value = stringValue(raw);
  if (!value) {
    return "";
  }

  const parts = value.split(":");
  if (parts.length >= 3 && parts[0] === "agent") {
    return parts.slice(2).join(":");
  }

  return value;
}

export function parseSessionRoute(raw: string): SessionRouteInfo {
  const sessionKey = stringValue(raw);
  const stripped = stripAgentSessionPrefix(sessionKey);
  const parts = stripped.split(":").filter(Boolean);
  const normalizedParts = parts.length >= 2 && SESSION_NAMESPACE_KINDS.has(lowerStringValue(parts[1]))
    ? [parts[0], ...parts.slice(2)]
    : parts;

  const origin = lowerStringValue(normalizedParts[0]);
  let target = "";
  let threadId = "";
  let userSession = false;
  let channelSession = false;
  let threadSession = false;

  if (normalizedParts.length >= 3 && USER_SESSION_KINDS.has(lowerStringValue(normalizedParts[1]))) {
    userSession = true;
    target = `user:${stringValue(normalizedParts[2])}`;
    if (normalizedParts.length >= 5 && THREAD_SESSION_KINDS.has(lowerStringValue(normalizedParts[3]))) {
      threadSession = true;
      threadId = stringValue(normalizedParts[4]);
    }
  } else if (normalizedParts.length >= 3 && CHANNEL_SESSION_KINDS.has(lowerStringValue(normalizedParts[1]))) {
    channelSession = true;
    const kind = lowerStringValue(normalizedParts[1]);
    target = `${kind}:${stringValue(normalizedParts[2])}`;
    if (normalizedParts.length >= 5 && THREAD_SESSION_KINDS.has(lowerStringValue(normalizedParts[3]))) {
      threadSession = true;
      threadId = stringValue(normalizedParts[4]);
    }
  } else if (normalizedParts.length >= 3 && THREAD_SESSION_KINDS.has(lowerStringValue(normalizedParts[1]))) {
    threadSession = true;
    const kind = lowerStringValue(normalizedParts[1]);
    target = `${kind}:${stringValue(normalizedParts[2])}`;
  } else if (normalizedParts.length >= 2 && IM_SESSION_ORIGINS.has(origin)) {
    target = normalizedParts.slice(1, Math.min(3, normalizedParts.length)).map(stringValue).join(":");
    const targetKind = lowerStringValue(normalizedParts[1]);
    userSession = USER_SESSION_KINDS.has(targetKind);
    channelSession = CHANNEL_SESSION_KINDS.has(targetKind);
    threadSession = THREAD_SESSION_KINDS.has(targetKind);
    if (normalizedParts.length >= 4 && THREAD_SESSION_KINDS.has(lowerStringValue(normalizedParts[2]))) {
      threadSession = true;
      threadId = stringValue(normalizedParts[3]);
    }
  }

  const bindingKey = origin && target ? `${origin}:${target}` : "";
  const threadKey = bindingKey ? `${bindingKey}:${threadId || "root"}` : "";
  const looksLikeImSession = Boolean(origin && (target || (IM_SESSION_ORIGINS.has(origin) && normalizedParts.length >= 2)));
  const normalizedSessionKey = sessionKey.toLowerCase();
  const isPrimaryMainSession = normalizedSessionKey === "agent:main:main" || stripped.toLowerCase() === "main";

  return {
    sessionKey,
    stripped,
    origin,
    target,
    threadId,
    bindingKey,
    threadKey,
    looksLikeImSession,
    isPrimaryMainSession,
    imSession: looksLikeImSession,
    channelSession,
    userSession,
    threadSession,
  };
}

export function normalizeAckTarget(origin: string, target: string, threadId = ""): AckTargetInfo {
  const normalizedOrigin = lowerStringValue(origin);
  const rawTarget = stringValue(target);
  if (!normalizedOrigin || !rawTarget) {
    return { ackTarget: "", ackThreadId: "" };
  }

  const [rawKind, rawId] = rawTarget.split(":", 2);
  const kind = lowerStringValue(rawKind);
  const id = stringValue(rawId);
  if (!kind || !id) {
    return { ackTarget: "", ackThreadId: "" };
  }

  if (normalizedOrigin === "slack") {
    if (USER_SESSION_KINDS.has(kind)) {
      return { ackTarget: `user:${id.toUpperCase()}`, ackThreadId: stringValue(threadId) };
    }
    if (kind === "dm") {
      return { ackTarget: `dm:${id.toUpperCase()}`, ackThreadId: stringValue(threadId) };
    }
    if (CHANNEL_SESSION_KINDS.has(kind)) {
      return { ackTarget: `channel:${id.toUpperCase()}`, ackThreadId: stringValue(threadId) };
    }
  }

  return { ackTarget: `${kind}:${id}`, ackThreadId: stringValue(threadId) };
}

export function ackTargetResolutionState(result: { hasTarget?: boolean; ackTarget?: unknown; ackThreadId?: unknown; threadId?: unknown; hasThread?: boolean }): AckTargetResolutionInfo {
  const ackTarget = stringValue(result.ackTarget);
  const ackThreadId = stringValue(result.ackThreadId || result.threadId);
  return {
    hasTarget: Boolean(result.hasTarget ?? ackTarget),
    hasThread: Boolean(result.hasThread ?? ackThreadId),
  };
}

export function ackDeliveryState(result: { delivered?: boolean; sent?: unknown; deliveryId?: string; delivery_id?: unknown }): AckDeliveryInfo {
  return {
    delivered: Boolean(result.delivered ?? result.sent),
    deliveryId: stringValue(result.deliveryId || result.delivery_id),
  };
}

export function isSubagentSessionRef(raw: string): boolean {
  const value = lowerStringValue(raw);
  if (!value) {
    return false;
  }
  if (value.includes("octoclaw-subagent-")) {
    return true;
  }
  if (value.includes(":subagent:")) {
    return true;
  }
  return /^agent:[^:]+:(?!main$)/iu.test(stringValue(raw)) && value.includes("subagent");
}

export function deriveSessionDescriptor(controlKey: string, record: UnknownRecord = {}): SessionDescriptor {
  const parsed = parseSessionRoute(controlKey);
  const originRecord = recordValue(record.origin);
  const deliveryRecord = recordValue(record.deliveryContext);

  const metadataOrigin = lowerStringValue(
    originRecord.provider
      || originRecord.surface
      || originRecord.channel
      || deliveryRecord.channel
      || "",
  );

  const origin = lowerStringValue(
    (parsed.looksLikeImSession && parsed.origin && IM_SESSION_ORIGINS.has(parsed.origin))
      ? parsed.origin
      : metadataOrigin || parsed.origin || "",
  );

  const target = stringValue(
    parsed.target
      || deliveryRecord.to
      || originRecord.to
      || "",
  );

  const threadId = stringValue(
    parsed.threadId
      || deliveryRecord.threadId
      || originRecord.threadId
      || record.lastThreadId
      || "",
  );

  const bindingKey = origin && target ? `${origin}:${target}` : "";
  const threadKey = bindingKey ? `${bindingKey}:${threadId || "root"}` : "";
  const looksLikeImSession = Boolean(parsed.looksLikeImSession || (origin && (target || IM_SESSION_ORIGINS.has(origin))));

  return {
    ...parsed,
    origin,
    target,
    threadId,
    bindingKey,
    threadKey,
    looksLikeImSession,
    imSession: looksLikeImSession,
    controlKey: stringValue(controlKey),
    channelSessionKey: stringValue(record.channelSessionKey),
    sessionId: stringValue(record.sessionId),
    sessionFile: stringValue(record.sessionFile),
    nativeChannelId: stringValue(originRecord.nativeChannelId || deliveryRecord.nativeChannelId || ""),
    chatType: stringValue(record.chatType || originRecord.chatType || ""),
    updatedSort: parseUpdatedSortValue(record.updatedAt),
    isSubagent: false,
    isUserFacing: looksLikeImSession,
    isContaminatedUserSession: false,
  };
}

export function loadSessionDescriptors(): Map<string, SessionDescriptor> {
  const descriptors = new Map<string, SessionDescriptor>();

  const register = (sessionKey: string, value: unknown): void => {
    const key = stringValue(sessionKey);
    if (!key) {
      return;
    }

    const record = recordValue(value);
    const channelSessionKey = stringValue(record.channelSessionKey);
    const controlKey = channelSessionKey || key;
    const parsed = deriveSessionDescriptor(controlKey, record);

    const next: SessionDescriptor = {
      ...parsed,
      sessionKey: key,
      controlKey,
      channelSessionKey,
      sessionId: stringValue(record.sessionId),
      sessionFile: stringValue(record.sessionFile),
      origin: stringValue(parsed.origin),
      target: stringValue(parsed.target),
      bindingKey: stringValue(parsed.bindingKey),
      threadKey: stringValue(parsed.threadKey),
      threadId: stringValue(parsed.threadId),
      nativeChannelId: stringValue(parsed.nativeChannelId),
      chatType: stringValue(parsed.chatType),
      updatedSort: parseUpdatedSortValue(record.updatedAt),
      isSubagent: isSubagentSessionRef(key) || isSubagentSessionRef(stringValue(record.agentId)),
      isUserFacing: Boolean(parsed.looksLikeImSession),
      isContaminatedUserSession: false,
    };

    next.isContaminatedUserSession = Boolean(
      next.isUserFacing
        && !next.isSubagent
        && isSubagentSessionRef(next.sessionId),
    );

    const previous = descriptors.get(key);
    if (!previous || next.updatedSort >= previous.updatedSort) {
      descriptors.set(key, next);
    }
  };

  for (const pathname of [resolveRootSessionsPath(), resolveMainAgentSessionsPath()]) {
    const raw = readJsonFileSync<unknown>(pathname, {});
    if (!isRecord(raw)) {
      continue;
    }

    for (const [key, value] of Object.entries(raw)) {
      register(key, value);
      const entry = recordValue(value);
      if (typeof entry.channelSessionKey === "string" && stringValue(entry.channelSessionKey)) {
        register(stringValue(entry.channelSessionKey), { channelSessionKey: stringValue(entry.channelSessionKey) });
      }
    }
  }

  return new Map(
    [...descriptors.entries()].sort(
      (left, right) => right[1].updatedSort - left[1].updatedSort,
    ),
  );
}

export function resolveCanonicalSessionDescriptor(ctx: UnknownRecord): SessionDescriptor | null {
  const safe = ctx ?? {};
  const provider = lowerStringValue(safe.messageProvider);
  const channelId = stringValue(safe.channelId);
  const descriptors = [...loadSessionDescriptors().values()].filter((entry) => entry.isUserFacing && !entry.isSubagent);

  if (provider && channelId) {
    const exact = descriptors.find(
      (entry) => entry.origin === provider && entry.nativeChannelId === channelId && !entry.threadId,
    );
    if (exact) {
      return exact;
    }

    const threaded = descriptors.find(
      (entry) => entry.origin === provider && entry.nativeChannelId === channelId,
    );
    if (threaded) {
      return threaded;
    }
  }

  if (provider) {
    const providerMatch = descriptors.find(
      (entry) => entry.origin === provider && /^agent:main:main$/iu.test(stringValue(entry.controlKey)),
    );
    if (providerMatch) {
      return providerMatch;
    }
  }

  return null;
}

export function resolveAckDeliverySessionKey(
  metadata: UnknownRecord,
  stateKey: string,
  state: UnknownRecord | null,
  ctx: UnknownRecord,
): string {
  const directCandidates = [
    metadata.session_key,
    state?.canonicalSessionKey,
    stateKey,
    ctx.sessionKey,
    ctx.sessionId,
  ]
    .map(stringValue)
    .filter(Boolean);

  for (const candidate of directCandidates) {
    const parsed = parseSessionRoute(candidate);
    if (parsed.looksLikeImSession && !isSubagentSessionRef(candidate)) {
      return candidate;
    }
  }

  const desiredThreadKey = stringValue(metadata.session_thread_key);
  const desiredBindingKey = stringValue(metadata.session_binding_key);
  const desiredOrigin = lowerStringValue(metadata.session_origin);
  const candidates = [...loadSessionDescriptors().values()].filter(
    (entry) => entry.isUserFacing && !entry.isSubagent && !entry.isContaminatedUserSession,
  );

  if (desiredThreadKey) {
    const match = candidates.find((entry) => entry.threadKey === desiredThreadKey);
    if (match?.controlKey) {
      return match.controlKey;
    }
  }

  if (desiredBindingKey) {
    const match = candidates.find((entry) => entry.bindingKey === desiredBindingKey);
    if (match?.controlKey) {
      return match.controlKey;
    }
  }

  if (desiredOrigin) {
    const match = candidates.find((entry) => entry.origin === desiredOrigin);
    if (match?.controlKey) {
      return match.controlKey;
    }
  }

  return "";
}

export function detectSessionBoundary(ctx: UnknownRecord): SessionBoundaryInfo {
  const safe = ctx ?? {};
  const sessionKey = stringValue(safe.sessionKey);
  const sessionId = stringValue(safe.sessionId);
  const agentId = stringValue(safe.agentId);
  const descriptorCanonical = resolveCanonicalSessionDescriptor(ctx);
  const subagentRefs = [sessionKey, sessionId, agentId].filter((item) => isSubagentSessionRef(item));
  const registrySubagentRefs = descriptorCanonical?.isContaminatedUserSession && descriptorCanonical.sessionId
    ? [descriptorCanonical.sessionId]
    : [];

  const canonicalCandidates = [sessionKey, sessionId]
    .map((raw) => ({ raw: stringValue(raw), parsed: parseSessionRoute(raw) }))
    .filter((item) => item.raw && !isSubagentSessionRef(item.raw));

  const canonicalUserSession = canonicalCandidates.find((item) => item.parsed.looksLikeImSession)
    || canonicalCandidates.find((item) => item.parsed.isPrimaryMainSession)
    || (descriptorCanonical
      ? {
          raw: stringValue(descriptorCanonical.controlKey),
          parsed: {
            bindingKey: stringValue(descriptorCanonical.bindingKey),
            threadKey: stringValue(descriptorCanonical.threadKey),
          },
        }
      : null)
    || canonicalCandidates[0]
    || null;

  const hasCanonicalUserSession = Boolean(canonicalUserSession);
  const contaminatedByRegistry = Boolean(descriptorCanonical?.isContaminatedUserSession);
  const contaminatedBySubagent = hasCanonicalUserSession && (subagentRefs.length > 0 || contaminatedByRegistry);
  const status = contaminatedBySubagent ? "contaminated_subagent_identity" : "clean";
  const reason = contaminatedBySubagent
    ? (contaminatedByRegistry ? "registry_contaminated_user_session" : "subagent_ref_present")
    : (hasCanonicalUserSession ? "canonical_user_session_detected" : "no_canonical_user_session");

  return {
    sessionKey,
    sessionId,
    agentId,
    hasCanonicalUserSession,
    contaminatedBySubagent,
    contaminatedByRegistry,
    subagentRefs,
    registrySubagentRefs,
    canonicalSessionKey: canonicalUserSession ? canonicalUserSession.raw : "",
    canonicalBindingKey: canonicalUserSession ? canonicalUserSession.parsed.bindingKey : "",
    canonicalThreadKey: canonicalUserSession ? canonicalUserSession.parsed.threadKey : "",
    status,
    reason,
  };
}

export function sessionPreferenceRank(raw: string): number {
  if (isSubagentSessionRef(raw)) {
    return -50;
  }
  const parsed = parseSessionRoute(raw);
  if (parsed.looksLikeImSession) {
    return 30;
  }
  if (parsed.isPrimaryMainSession) {
    return 20;
  }
  if (/^agent:main:/iu.test(stringValue(raw))) {
    return 10;
  }
  return 0;
}

export function isManagedAgentContext(ctx: UnknownRecord): boolean {
  const safe = ctx ?? {};
  if (stringValue(process.env.OCTOCLAW_DISABLE_RUNTIME_POLICY) === "1") {
    return false;
  }

  const trigger = lowerStringValue(safe.trigger);
  if (trigger && ["heartbeat", "cron", "memory"].includes(trigger)) {
    return false;
  }

  const sessionKey = stringValue(safe.sessionKey);
  const sessionId = stringValue(safe.sessionId);
  const agentId = stringValue(safe.agentId);

  if (sessionKey.includes(":active-memory:") || sessionId.startsWith("active-memory-")) {
    return false;
  }
  if (/subagent/iu.test(sessionKey) || /subagent/iu.test(sessionId) || /subagent/iu.test(agentId)) {
    return false;
  }

  const managedRefs = [parseSessionRoute(sessionKey), parseSessionRoute(sessionId)].filter(
    (item) => item.sessionKey,
  );
  if (managedRefs.some((item) => item.looksLikeImSession || item.isPrimaryMainSession)) {
    return true;
  }
  if (/^agent:main:(?!main$)/iu.test(sessionKey) || /^agent:main:(?!main$)/iu.test(agentId)) {
    return false;
  }
  return true;
}

export function buildPolicyMetadata(ctx: UnknownRecord, options: { stateKey?: string } = {}): UnknownRecord {
  const safe = ctx ?? {};
  const metadata: UnknownRecord = {};
  const boundary = detectSessionBoundary(safe);
  const requestedStateKey = stringValue(options.stateKey);
  const stableSessionKey = stringValue(
    (requestedStateKey && isDispatchableUserSessionKey(requestedStateKey) ? requestedStateKey : "")
    || boundary.canonicalSessionKey
    || resolvePolicyStateKey(safe)
    || requestedStateKey
    || "",
  );
  const stableSession = parseSessionRoute(stableSessionKey);

  if (safe.channelId) metadata.channel = safe.channelId;
  if (stableSessionKey) metadata.session_key = stableSessionKey;
  if (stableSession.origin) metadata.session_origin = stableSession.origin;
  if (stableSession.target) metadata.session_target = stableSession.target;
  if (stableSession.threadId) metadata.session_thread_id = stableSession.threadId;
  if (stableSession.threadKey) metadata.session_thread_key = stableSession.threadKey;
  if (stableSession.bindingKey) metadata.session_binding_key = stableSession.bindingKey;
  if (safe.trigger) metadata.trigger = safe.trigger;
  if (safe.agentId) metadata.agent_id = safe.agentId;
  if (safe.sessionId) metadata.session_id = safe.sessionId;
  if (safe.messageProvider) metadata.message_provider = safe.messageProvider;
  metadata.message_id = stringValue(safe.messageId || safe.messageTs || safe.eventId || safe.ts || "");
  metadata.agent_namespace = "octoclaw";
  metadata.managed_by_octoclaw = true;
  metadata.session_boundary_status = boundary.status;
  metadata.session_boundary_reason = boundary.reason;
  metadata.turn_id = metadata.message_id
    ? stableId("turn", [
        stableSessionKey,
        stringValue(metadata.message_id),
        stringValue(safe.sessionId),
        stringValue(safe.agentId),
        stringValue(safe.trigger),
      ])
    : "";

  return metadata;
}

export function isDispatchableUserSessionKey(raw: string): boolean {
  const value = stringValue(raw);
  if (!value || isSubagentSessionRef(value)) {
    return false;
  }
  const parsed = parseSessionRoute(value);
  if (parsed.looksLikeImSession || parsed.isPrimaryMainSession) {
    return true;
  }
  return /^agent:main:/iu.test(value);
}

export function applyUserMetadataOverrides(metadata: UnknownRecord, overrides: UnknownRecord): UnknownRecord {
  const next = isRecord(metadata) ? { ...metadata } : {};
  if (!isRecord(overrides)) {
    return next;
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (key === "session_key" && !stringValue(value)) {
      continue;
    }
    next[key] = value;
  }

  return next;
}

export function resolveDispatchSessionKey(
  ctx: UnknownRecord,
  metadata: UnknownRecord,
  options: UnknownRecord = {},
): string {
  const safe = ctx ?? {};
  const state = recordValue(options.state);
  const stateDecision = recordValue(state.decision);
  const stateRequest = recordValue(stateDecision.request);
  const stateRequestMetadata = recordValue(stateRequest.metadata);
  const cachedDecision = recordValue(options.cachedDecision);
  const cachedRequest = recordValue(cachedDecision.request);
  const cachedRequestMetadata = recordValue(cachedRequest.metadata);
  const boundary = detectSessionBoundary(safe);

  const candidates = [
    metadata.session_key,
    options.stateKey,
    state.canonicalSessionKey,
    stateRequest.session_key,
    stateRequestMetadata.session_key,
    cachedRequest.session_key,
    cachedRequestMetadata.session_key,
    boundary.canonicalSessionKey,
    safe.sessionKey,
  ];

  for (const candidate of candidates) {
    const value = stringValue(candidate);
    if (isDispatchableUserSessionKey(value)) {
      return value;
    }
  }

  return "";
}

export function finalizeDispatchMetadata(
  ctx: UnknownRecord,
  metadata: UnknownRecord,
  options: UnknownRecord = {},
): UnknownRecord {
  const next = isRecord(metadata) ? { ...metadata } : {};
  const sessionKey = resolveDispatchSessionKey(ctx ?? {}, next, options);
  if (!sessionKey) {
    return next;
  }

  next.session_key = sessionKey;
  const parsed = parseSessionRoute(sessionKey);
  if (parsed.origin && !next.session_origin) next.session_origin = parsed.origin;
  if (parsed.target && !next.session_target) next.session_target = parsed.target;
  if (parsed.threadId && !next.session_thread_id) next.session_thread_id = parsed.threadId;
  if (parsed.threadKey && !next.session_thread_key) next.session_thread_key = parsed.threadKey;
  if (parsed.bindingKey && !next.session_binding_key) next.session_binding_key = parsed.bindingKey;
  return next;
}

export function enrichConversationControlMetadata(prompt: string, metadata: UnknownRecord): UnknownRecord {
  const nextMetadata = isRecord(metadata) ? { ...metadata } : {};
  const existingConversationControl = isRecord(nextMetadata.conversation_control)
    ? nextMetadata.conversation_control
    : null;
  const existingIntentPacket = isRecord(nextMetadata.intent_packet) ? nextMetadata.intent_packet : null;
  const existingConversationControlSufficient = Boolean(
    existingConversationControl
    && (
      stringValue(existingConversationControl.route_hint)
      || stringValue(existingConversationControl.intent_class)
      || stringValue(existingConversationControl.lane_hint)
      || typeof existingConversationControl.require_fresh_lookup === "boolean"
      || typeof existingConversationControl.require_state_grounding === "boolean"
      || stringValue(existingConversationControl.protected_lane)
    ),
  );
  if (existingConversationControlSufficient && existingIntentPacket) {
    const explicitConversationControl = existingConversationControl ?? {};
    nextMetadata.conversation_control = {
      ...explicitConversationControl,
      source: stringValue(explicitConversationControl.source || "explicit_conversation_control"),
    };
    return nextMetadata;
  }

  const hintOptions = {
    prompt,
    replayLogPath: resolveReplayLogPath(),
    taskStatePath: resolveTaskStatePath(),
    sessionKeys: [
      nextMetadata.session_key,
      nextMetadata.session_binding_key,
      nextMetadata.session_thread_key,
    ].filter((value): value is string => Boolean(stringValue(value))),
  };

  const intentPacket = existingIntentPacket || buildConversationIntentPacketCompat(hintOptions);
  if (recordValue(intentPacket).available !== false) {
    nextMetadata.intent_packet = intentPacket;
  }

  const projectedConversationControl = buildConversationControlHintsFromIntentCompat(intentPacket);
  const conversationControl = existingConversationControl
    ? {
        ...projectedConversationControl,
        ...existingConversationControl,
        source: stringValue(existingConversationControl.source || "explicit_conversation_control"),
        route_hint: stringValue(existingConversationControl.route_hint || projectedConversationControl.route_hint),
        intent_class: stringValue(existingConversationControl.intent_class || projectedConversationControl.intent_class),
        lane_hint: stringValue(existingConversationControl.lane_hint || projectedConversationControl.lane_hint),
        protected_lane: stringValue(existingConversationControl.protected_lane || projectedConversationControl.protected_lane),
        require_fresh_lookup: typeof existingConversationControl.require_fresh_lookup === "boolean"
          ? existingConversationControl.require_fresh_lookup
          : projectedConversationControl.require_fresh_lookup,
        require_state_grounding: typeof existingConversationControl.require_state_grounding === "boolean"
          ? existingConversationControl.require_state_grounding
          : projectedConversationControl.require_state_grounding,
      }
    : projectedConversationControl;
  if (recordValue(conversationControl).available) {
    nextMetadata.conversation_control = conversationControl;
  }

  return nextMetadata;
}

export function resolvePolicyStateKeys(ctx: UnknownRecord): string[] {
  const safe = ctx ?? {};
  const entries: Array<{ value: string; rank: number; order: number }> = [];
  const boundary = detectSessionBoundary(safe);

  for (const raw of [boundary.canonicalSessionKey, safe.sessionKey, safe.sessionId]) {
    const value = stringValue(raw);
    if (value && !entries.some((entry) => entry.value === value)) {
      entries.push({
        value,
        rank: sessionPreferenceRank(value),
        order: entries.length,
      });
    }
  }

  entries.sort((left, right) => right.rank - left.rank || left.order - right.order);
  const preferred = entries.filter((entry) => entry.rank >= 0);
  return (preferred.length > 0 ? preferred : entries).map((entry) => entry.value);
}

export function resolvePolicyStateKey(ctx: UnknownRecord): string {
  return resolvePolicyStateKeys(ctx)[0] || "";
}

export function extractQueuedBusyMessages(raw: Record<string, unknown> | string): Record<string, unknown>[] {
  const text = stringValue(typeof raw === "string" ? raw : raw.prompt ?? raw.raw ?? "");
  if (!text.startsWith("[Queued messages while agent was busy]")) {
    return [];
  }

  const messages: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!String(line).startsWith("System:")) {
      continue;
    }
    const rawLine = String(line).replace(/^System:\s*/u, "").trim();
    const lastColon = rawLine.lastIndexOf(": ");
    const message = stringValue(lastColon >= 0 ? rawLine.slice(lastColon + 2) : rawLine);
    if (message) {
      messages.push({ message });
    }
  }

  return messages;
}

export function unwrapQueuedBusyPrompt(raw: Record<string, unknown> | string): string {
  const text = stringValue(typeof raw === "string" ? raw : raw.prompt ?? raw.raw ?? "");
  if (!text) {
    return "";
  }

  const messages = extractQueuedBusyMessages(text)
    .map((entry) => stringValue(entry.message))
    .filter(Boolean);
  if (messages.length === 0) {
    return text;
  }
  return messages.join("\n\n");
}

export function promptLookupCandidates(raw: Record<string, unknown> | string): string[] {
  const base = stringValue(typeof raw === "string" ? raw : raw.prompt ?? raw.raw ?? "");
  if (!base) {
    return [];
  }

  const values: string[] = [];
  const seen = new Set<string>();
  const pushValue = (value: string): void => {
    const normalized = String(value || "").replace(/\s+/gu, " ").trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    values.push(normalized);
  };

  const queuedMessages = extractQueuedBusyMessages(base)
    .map((entry) => stringValue(entry.message))
    .filter(Boolean);
  if (queuedMessages.length > 0) {
    pushValue(queuedMessages[queuedMessages.length - 1]);
    for (const message of queuedMessages) {
      pushValue(message);
    }
    pushValue(queuedMessages.join("\n\n"));
  }

  pushValue(unwrapQueuedBusyPrompt(base));
  pushValue(base);
  return values;
}

export function promptsEquivalent(left: string, right: string): boolean {
  const leftCandidates = promptLookupCandidates(left);
  const rightCandidates = promptLookupCandidates(right);
  if (leftCandidates.length === 0 || rightCandidates.length === 0) {
    return false;
  }

  const rightSet = new Set(rightCandidates);
  return leftCandidates.some((value) => rightSet.has(value));
}
