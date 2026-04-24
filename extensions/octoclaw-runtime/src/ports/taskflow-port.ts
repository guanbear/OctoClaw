export type JsonRecord = Record<string, unknown>;

export interface TaskFlowPort {
  healthCheck?(): Promise<unknown>;
  listTasks?(input?: { limit?: number }): Promise<unknown>;
  getStatus?(): Promise<unknown>;
  bindSession(input: { sessionKey: string; requesterOrigin?: unknown }): BoundTaskFlowPort;
}

export interface BoundTaskFlowPort {
  createManaged(input: CreateManagedFlowInput): Promise<ManagedFlowRecord>;
  runTask(input: RunNativeTaskInput): Promise<NativeTaskRunResult>;
  get(flowId: string): Promise<NativeFlowRecord | null>;
  resolve(token: string): Promise<NativeFlowRecord | null>;
  getTaskSummary(flowId: string): Promise<NativeTaskSummary | null>;
  setWaiting(input: FlowMutationInput): Promise<FlowMutationResult>;
  finish(input: FlowMutationInput): Promise<FlowMutationResult>;
  fail(input: FlowMutationInput): Promise<FlowMutationResult>;
  cancel(input: CancelFlowInput): Promise<CancelFlowResult>;
}

export interface CreateManagedFlowInput extends JsonRecord {
  controllerId: string;
  goal: string;
  status?: string;
  currentStep?: string;
  notifyPolicy?: string;
}

export interface RunNativeTaskInput extends JsonRecord {
  flowId: string;
  task: string;
  runtime?: string;
  label?: string;
  runId?: string;
  childSessionKey?: string;
  status?: string;
  notifyPolicy?: string;
  progressSummary?: string;
}

export interface ManagedFlowRecord extends JsonRecord {
  flowId: string;
  status?: string;
  revision?: number;
}

export interface NativeFlowRecord extends JsonRecord {
  flowId: string;
  status?: string;
  state?: string;
  revision?: number;
  tasks?: NativeTaskSummary[];
}

export interface NativeTaskRunResult extends JsonRecord {
  created: boolean;
  flowId: string;
  taskId: string;
  task?: NativeTaskSummary | null;
  reason?: string;
}

export interface NativeTaskSummary extends JsonRecord {
  taskId: string;
  flowId?: string;
  status?: string;
  state?: string;
  revision?: number;
  progressSummary?: string;
}

export interface FlowMutationInput extends JsonRecord {
  flowId: string;
  expectedRevision?: number;
  stateJson?: unknown;
  waitJson?: unknown;
  currentStep?: string;
  blockedTaskId?: string;
  blockedSummary?: string;
}

export interface FlowMutationResult extends JsonRecord {
  applied: boolean;
  flowId: string;
  status: string;
  revision?: number;
  flow?: NativeFlowRecord | null;
}

export interface CancelFlowInput extends JsonRecord {
  flowId: string;
}

export interface CancelFlowResult extends JsonRecord {
  cancelled: boolean;
  flowId: string;
  found?: boolean;
  reason?: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  const text = String(value ?? "").trim();
  return text || fallback;
}

/**
 * Check if the taskflow backend is available and ready to accept tasks.
 * Returns structured result — never throws for availability issues.
 */
export async function checkTaskflowCapability(
  port: TaskFlowPort,
): Promise<{ available: boolean; reason?: string; latencyMs: number }> {
  const start = Date.now();
  try {
    if (port.healthCheck) {
      const healthResult = await Promise.race([
        port.healthCheck(),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("preflight_timeout")), 5000);
        }),
      ]);
      if (isRecord(healthResult) && asString(healthResult.status) === "unhealthy") {
        return { available: false, reason: "health_check_unhealthy", latencyMs: Date.now() - start };
      }
      return { available: true, latencyMs: Date.now() - start };
    }

    if (port.bindSession) {
      const probe = port.bindSession({ sessionKey: "octoclaw-preflight" }).get("octoclaw-preflight");
      const result = await Promise.race([
        probe,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("preflight_timeout")), 5000);
        }),
      ]);
      if (result === null || result === undefined) {
        return { available: false, reason: "preflight_no_taskflow_response", latencyMs: Date.now() - start };
      }
      return { available: true, latencyMs: Date.now() - start };
    }

    return { available: false, reason: "no_capability_probe_available", latencyMs: Date.now() - start };
  } catch (err) {
    return {
      available: false,
      reason: err instanceof Error ? err.message : "unknown_error",
      latencyMs: Date.now() - start,
    };
  }
}
