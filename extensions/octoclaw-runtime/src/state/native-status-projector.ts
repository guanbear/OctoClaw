export type NativeProjectedStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "canceled"
  | "unknown"
  | "lost"
  | "degraded";

export type NativeStatusSource = "run" | "flow" | "latest" | "cache" | "none";

export interface NativeStatusCacheInput {
  status?: string;
  rawStatus?: string;
  summary?: string;
  corrupt?: boolean;
  missing?: boolean;
}

export interface NativeStatusProjectorInput {
  ctx?: unknown;
  sessionKey?: string;
  workContractId?: string;
  openclawRunId?: string;
  openclawTaskId?: string;
  openclawFlowId?: string;
  childSessionKey?: string;
  cache?: NativeStatusCacheInput;
  allowFindLatest?: boolean;
}

export interface NativeStatusProjection {
  status: NativeProjectedStatus;
  rawStatus: string;
  source: NativeStatusSource;
  reason: string;
  found: boolean;
  degraded: boolean;
  runId?: string;
  flowId?: string;
  taskId?: string;
  childSessionKey?: string;
  summary?: string;
  revision?: number;
  error?: string;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function asString(value: unknown): string {
  return String(value ?? "").trim();
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = asString(value);
    if (text) return text;
  }
  return "";
}

function mapNativeStatus(value: unknown): NativeProjectedStatus {
  const status = asString(value).toLowerCase();
  if (["queued", "pending", "planned", "created", "accepted"].includes(status)) return "queued";
  if (["running", "in_progress", "active", "executing", "started"].includes(status)) return "running";
  if (["completed", "succeeded", "success", "done"].includes(status)) return "completed";
  if (["failed", "error", "errored"].includes(status)) return "failed";
  if (["timed_out", "timeout", "expired"].includes(status)) return "timed_out";
  if (["cancelled", "canceled", "aborted"].includes(status)) return "canceled";
  if (["missing", "not_found", "lost"].includes(status)) return "lost";
  if (["degraded", "corrupt", "corrupted"].includes(status)) return "degraded";
  return "unknown";
}

function unwrapNativeRecord(value: unknown, kind: "run" | "flow" | "latest"): UnknownRecord | null {
  if (!isRecord(value)) return null;
  if (value.found === false || value.ok === false) return null;
  const nested = kind === "run" ? value.run : kind === "flow" ? value.flow : (value.run ?? value.flow ?? value.task);
  const record = isRecord(nested) ? nested : value;
  if (record.found === false || record.ok === false) return null;
  return record;
}

function statusFromNativeRecord(record: UnknownRecord, source: NativeStatusSource, reason: string): NativeStatusProjection {
  const lifecycle = asRecord(record.lifecycle);
  const result = asRecord(record.result);
  const rawStatus = firstString(
    record.status,
    record.state,
    record.phase,
    lifecycle.status,
    lifecycle.phase,
    result.status,
  ) || "unknown";
  return {
    status: mapNativeStatus(rawStatus),
    rawStatus,
    source,
    reason,
    found: true,
    degraded: false,
    runId: firstString(record.runId, record.run_id, record.id),
    flowId: firstString(record.flowId, record.flow_id),
    taskId: firstString(record.taskId, record.task_id, record.nativeTaskId, record.native_task_id),
    childSessionKey: firstString(record.childSessionKey, record.child_session_key, record.sessionKey, record.session_key),
    summary: firstString(record.summary, record.progressSummary, record.progress_summary, result.summary),
    revision: asNumber(record.revision),
  };
}

async function bindFromToolContext(api: unknown, ctx: unknown): Promise<UnknownRecord | null> {
  const record = asRecord(api);
  if (!Object.keys(record).length) return null;
  const binder = record.fromToolContext;
  if (typeof binder !== "function") return record;
  const bound = await Promise.resolve(binder.call(record, ctx));
  return isRecord(bound) ? bound : null;
}

async function runtimeTaskApi(ctx: unknown, kind: "runs" | "flows"): Promise<UnknownRecord | null> {
  const root = asRecord(ctx);
  const runtime = asRecord(root.runtime ?? asRecord(root.api).runtime);
  const tasks = asRecord(runtime.tasks);
  return bindFromToolContext(tasks[kind], ctx);
}

async function resolveNative(api: UnknownRecord | null, id: string): Promise<unknown> {
  if (!api || !id) return null;
  const resolve = api.resolve;
  if (typeof resolve !== "function") return null;
  return Promise.resolve(resolve.call(api, id));
}

async function findLatestNative(api: UnknownRecord | null, input: NativeStatusProjectorInput): Promise<unknown> {
  if (!api) return null;
  const findLatest = api.findLatest;
  if (typeof findLatest !== "function") return null;
  return Promise.resolve(findLatest.call(api, {
    sessionKey: input.sessionKey,
    workContractId: input.workContractId,
    openclawTaskId: input.openclawTaskId,
    childSessionKey: input.childSessionKey,
  }));
}

function cacheProjection(input: NativeStatusProjectorInput, reason: string): NativeStatusProjection {
  const cache = input.cache ?? {};
  if (reason === "native_registry_unavailable_cache_projection") {
    return {
      status: "degraded",
      rawStatus: "native_registry_unavailable",
      source: "none",
      reason: "native_registry_unavailable",
      found: false,
      degraded: true,
      runId: asString(input.openclawRunId) || undefined,
      flowId: asString(input.openclawFlowId) || undefined,
      taskId: asString(input.openclawTaskId) || undefined,
      childSessionKey: asString(input.childSessionKey) || undefined,
      summary: asString(cache.summary) || undefined,
    };
  }
  const rawStatus = firstString(cache.rawStatus, cache.status) || (cache.corrupt ? "degraded" : "unknown");
  return {
    status: cache.corrupt ? "degraded" : mapNativeStatus(rawStatus),
    rawStatus,
    source: cache.status || cache.rawStatus || cache.corrupt ? "cache" : "none",
    reason,
    found: Boolean(cache.status || cache.rawStatus),
    degraded: true,
    runId: asString(input.openclawRunId) || undefined,
    flowId: asString(input.openclawFlowId) || undefined,
    taskId: asString(input.openclawTaskId) || undefined,
    childSessionKey: asString(input.childSessionKey) || undefined,
    summary: asString(cache.summary) || undefined,
  };
}

export async function projectNativeStatus(input: NativeStatusProjectorInput): Promise<NativeStatusProjection> {
  const runId = asString(input.openclawRunId);
  const flowId = asString(input.openclawFlowId);
  const hasNativeId = Boolean(runId || flowId || asString(input.openclawTaskId));

  if (input.cache?.corrupt) {
    return cacheProjection(input, "task_state_cache_degraded");
  }

  let lastError = "";
  let attemptedNativeLookup = false;

  if (runId) {
    try {
      const runs = await runtimeTaskApi(input.ctx, "runs");
      if (runs) attemptedNativeLookup = true;
      const resolved = unwrapNativeRecord(await resolveNative(runs, runId), "run");
      if (resolved) return statusFromNativeRecord(resolved, "run", "resolved_by_openclaw_run_id");
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  if (flowId) {
    try {
      const flows = await runtimeTaskApi(input.ctx, "flows");
      if (flows) attemptedNativeLookup = true;
      const resolved = unwrapNativeRecord(await resolveNative(flows, flowId), "flow");
      if (resolved) return statusFromNativeRecord(resolved, "flow", "resolved_by_openclaw_flow_id");
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  if (input.allowFindLatest !== false) {
    try {
      const runs = await runtimeTaskApi(input.ctx, "runs");
      if (runs) attemptedNativeLookup = true;
      const latestRun = unwrapNativeRecord(await findLatestNative(runs, input), "latest");
      if (latestRun) return statusFromNativeRecord(latestRun, "latest", "ui_fallback_find_latest_run");
      const flows = await runtimeTaskApi(input.ctx, "flows");
      if (flows) attemptedNativeLookup = true;
      const latestFlow = unwrapNativeRecord(await findLatestNative(flows, input), "latest");
      if (latestFlow) return statusFromNativeRecord(latestFlow, "latest", "ui_fallback_find_latest_flow");
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  if (hasNativeId && !attemptedNativeLookup && (input.cache?.status || input.cache?.rawStatus)) {
    return cacheProjection(input, "native_registry_unavailable_cache_projection");
  }

  if (hasNativeId) {
    return {
      status: "lost",
      rawStatus: "missing",
      source: "none",
      reason: lastError ? "native_registry_lookup_failed" : "native_id_known_but_registry_missing",
      found: false,
      degraded: true,
      runId: runId || undefined,
      flowId: flowId || undefined,
      taskId: asString(input.openclawTaskId) || undefined,
      childSessionKey: asString(input.childSessionKey) || undefined,
      error: lastError || undefined,
    };
  }

  if (input.cache?.status || input.cache?.rawStatus) {
    return cacheProjection(input, "cache_only_no_native_id");
  }

  return cacheProjection(input, "no_native_status_available");
}
