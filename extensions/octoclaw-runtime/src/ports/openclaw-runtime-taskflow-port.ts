import type {
  BoundTaskFlowPort,
  CancelFlowInput,
  CancelFlowResult,
  CreateManagedFlowInput,
  FlowMutationInput,
  FlowMutationResult,
  JsonRecord,
  ManagedFlowRecord,
  NativeFlowRecord,
  NativeTaskRunResult,
  NativeTaskSummary,
  RunNativeTaskInput,
  TaskFlowPort,
} from "./taskflow-port.js";

interface OpenClawRuntimeTaskFlowApi {
  bindSession(input: { sessionKey: string; requesterOrigin?: unknown }): OpenClawRuntimeTaskFlowBoundApi;
}

interface OpenClawRuntimeTaskFlowBoundApi {
  createManaged(input: CreateManagedFlowInput): unknown;
  runTask(input: RunNativeTaskInput): unknown;
  getFlow?(input: { flowId: string }): unknown;
  get?(flowId: string): unknown;
  resolve?(token: string): unknown;
  getTaskSummary?(flowId: string): unknown;
  setWaiting(input: FlowMutationInput): unknown;
  finish(input: FlowMutationInput): unknown;
  fail(input: FlowMutationInput): unknown;
  cancel(input: CancelFlowInput): unknown;
}

export interface OpenClawRuntimeTaskFlowApiContainer {
  runtime: {
    taskFlow: OpenClawRuntimeTaskFlowApi;
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function stringField(value: unknown): string {
  return String(value ?? "").trim();
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function isTaskSummary(value: NativeTaskSummary | null): value is NativeTaskSummary {
  return value !== null;
}

function toFlowRecord(value: unknown, fallbackFlowId = ""): NativeFlowRecord | null {
  if (!isRecord(value)) return null;
  const flow = isRecord(value.flow) ? value.flow : value;
  const flowId = stringField(flow.flowId ?? value.flowId ?? value.flow_id ?? fallbackFlowId);
  if (!flowId) return null;
  return {
    ...flow,
    flowId,
    status: typeof flow.status === "string" ? flow.status : undefined,
    state: typeof flow.state === "string" ? flow.state : undefined,
    revision: numberField(flow.revision),
    tasks: Array.isArray(flow.tasks) ? flow.tasks.map(toTaskSummary).filter(isTaskSummary) : undefined,
  };
}

function toTaskSummary(value: unknown): NativeTaskSummary | null {
  if (!isRecord(value)) return null;
  const taskId = stringField(value.taskId ?? value.task_id);
  if (!taskId) return null;
  return {
    ...value,
    taskId,
    flowId: typeof value.flowId === "string" ? value.flowId : undefined,
    status: typeof value.status === "string" ? value.status : undefined,
    state: typeof value.state === "string" ? value.state : undefined,
    revision: numberField(value.revision),
    progressSummary: typeof value.progressSummary === "string" ? value.progressSummary : undefined,
  };
}

function toManagedFlowRecord(value: unknown): ManagedFlowRecord {
  const flow = toFlowRecord(value);
  if (!flow) {
    throw new Error("OpenClaw taskFlow.createManaged did not return a flowId");
  }
  return flow;
}

function toTaskRunResult(value: unknown, flowId: string): NativeTaskRunResult {
  const record = asRecord(value);
  const task = toTaskSummary(record.task);
  const taskId = stringField(record.taskId ?? record.task_id ?? task?.taskId);
  return {
    ...record,
    created: record.created !== false && Boolean(taskId),
    flowId: stringField(record.flowId ?? record.flow_id ?? flowId),
    taskId,
    task,
    reason: typeof record.reason === "string" ? record.reason : undefined,
  };
}

function toMutationResult(value: unknown, flowId: string): FlowMutationResult {
  const record = asRecord(value);
  const flow = toFlowRecord(record.flow, flowId);
  const code = stringField(record.code);
  return {
    ...record,
    applied: record.applied === true,
    flowId: stringField(record.flowId ?? record.flow_id ?? flowId),
    status: record.applied === true ? "ok" : code || "not_applied",
    revision: numberField(record.revision) ?? flow?.revision,
    flow,
  };
}

function toCancelResult(value: unknown, flowId: string): CancelFlowResult {
  const record = asRecord(value);
  return {
    ...record,
    cancelled: record.cancelled === true,
    flowId: stringField(record.flowId ?? record.flow_id ?? flowId),
    found: typeof record.found === "boolean" ? record.found : undefined,
    reason: typeof record.reason === "string" ? record.reason : undefined,
  };
}

export class OpenClawRuntimeTaskFlowPort implements TaskFlowPort {
  constructor(private readonly api: OpenClawRuntimeTaskFlowApiContainer) {}

  bindSession(input: { sessionKey: string; requesterOrigin?: unknown }): BoundTaskFlowPort {
    const bound = this.api.runtime.taskFlow.bindSession(input);
    return {
      createManaged: (createInput) => toManagedFlowRecord(bound.createManaged(createInput)),
      runTask: (runInput) => toTaskRunResult(bound.runTask(runInput), runInput.flowId),
      get: (flowId) => {
        const flow = typeof bound.getFlow === "function" ? bound.getFlow({ flowId }) : bound.get?.(flowId);
        return toFlowRecord(flow, flowId);
      },
      resolve: (token) => typeof bound.resolve === "function" ? toFlowRecord(bound.resolve(token)) : null,
      getTaskSummary: (flowId) => typeof bound.getTaskSummary === "function" ? toTaskSummary(bound.getTaskSummary(flowId)) : null,
      setWaiting: (mutationInput) => toMutationResult(bound.setWaiting(mutationInput), mutationInput.flowId),
      finish: (mutationInput) => toMutationResult(bound.finish(mutationInput), mutationInput.flowId),
      fail: (mutationInput) => toMutationResult(bound.fail(mutationInput), mutationInput.flowId),
      cancel: async (cancelInput) => toCancelResult(await bound.cancel(cancelInput), cancelInput.flowId),
    };
  }
}

export function createOpenClawRuntimeTaskFlowPort(api: OpenClawRuntimeTaskFlowApiContainer): TaskFlowPort {
  return new OpenClawRuntimeTaskFlowPort(api);
}
