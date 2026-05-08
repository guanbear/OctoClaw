import { createTaskFlowBridge, type TaskFlowBridge } from "../adapter/taskflow-bridge.js";
import type {
  BoundTaskFlowPort,
  CancelFlowResult,
  CreateManagedFlowInput,
  FlowMutationInput,
  FlowMutationResult,
  ManagedFlowRecord,
  NativeFlowRecord,
  NativeTaskRunResult,
  NativeTaskSummary,
  RunNativeTaskInput,
  TaskFlowPort,
} from "./taskflow-port.js";
import { isRecord, asRecord } from "../util/type-coercion.js";

type BridgeFactory = (openclawBin?: string) => Promise<TaskFlowBridge>;

export type BoundDistTaskFlowPort = BoundTaskFlowPort;

export interface OpenClawDistTaskFlowPortOptions {
  openclawBin?: string;
  bridgeFactory?: BridgeFactory;
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

function encodeJson(value: unknown): string | undefined {
  return value === undefined ? undefined : JSON.stringify(value);
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
    throw new Error("OpenClaw dist taskFlow bridge did not return a flowId");
  }
  return flow;
}

function toTaskRunResult(value: unknown, flowId: string): NativeTaskRunResult {
  const record = asRecord(value);
  const task = toTaskSummary(record.task);
  const taskId = stringField(record.native_task_id ?? record.taskId ?? record.task_id ?? task?.taskId);
  return {
    ...record,
    created: record.ok === true || record.created === true,
    flowId: stringField(record.flow_id ?? record.flowId ?? flowId),
    taskId,
    task,
    reason: typeof record.reason === "string" ? record.reason : undefined,
  };
}

function toMutationResult(value: unknown, flowId: string): FlowMutationResult {
  const record = asRecord(value);
  return {
    ...record,
    applied: record.ok === true || record.applied === true,
    flowId: stringField(record.flow_id ?? record.flowId ?? flowId),
    status: stringField(record.status) || (record.ok === true ? "ok" : "not_applied"),
    revision: numberField(record.revision),
    flow: toFlowRecord(record.flow, flowId),
  };
}

function toCancelResult(value: unknown, flowId: string): CancelFlowResult {
  const record = asRecord(value);
  return {
    ...record,
    cancelled: record.cancelled === true,
    flowId: stringField(record.flow_id ?? record.flowId ?? flowId),
    found: typeof record.found === "boolean" ? record.found : undefined,
    reason: typeof record.reason === "string" ? record.reason : undefined,
  };
}

export class OpenClawDistTaskFlowPort implements TaskFlowPort {
  private readonly bridgePromise: Promise<TaskFlowBridge>;

  constructor(options: OpenClawDistTaskFlowPortOptions = {}) {
    const factory = options.bridgeFactory ?? createTaskFlowBridge;
    this.bridgePromise = factory(options.openclawBin);
  }

  bindSession(input: { sessionKey: string; requesterOrigin?: unknown }): BoundDistTaskFlowPort {
    const bridgePromise = this.bridgePromise;
    const sessionKey = input.sessionKey;
      let lastFlow: NativeFlowRecord | null = null;
    return {
      async createManaged(createInput: CreateManagedFlowInput): Promise<ManagedFlowRecord> {
        const bridge = await bridgePromise;
        const record = toManagedFlowRecord(bridge.createManagedFlow({
          sessionKey,
          controllerId: createInput.controllerId,
          goal: createInput.goal,
          status: createInput.status,
          currentStep: createInput.currentStep,
          notifyPolicy: createInput.notifyPolicy,
          stateJson: encodeJson(createInput.stateJson),
          waitJson: encodeJson(createInput.waitJson),
        }));
        lastFlow = record;
        return record;
      },
      async runTask(runInput: RunNativeTaskInput): Promise<NativeTaskRunResult> {
        const bridge = await bridgePromise;
        return toTaskRunResult(bridge.runTask({ sessionKey, ...runInput }), runInput.flowId);
      },
      async get(flowId: string): Promise<NativeFlowRecord | null> {
        const bridge = await bridgePromise;
        const flow = toFlowRecord(bridge.readFlow({ sessionKey, flowId }), flowId);
        lastFlow = flow;
        return flow;
      },
      async resolve(token: string): Promise<NativeFlowRecord | null> {
        if (lastFlow?.flowId === token) return lastFlow;
        return this.get(token);
      },
      async getTaskSummary(flowId: string): Promise<NativeTaskSummary | null> {
        const bridge = await bridgePromise;
        const flow = toFlowRecord(bridge.readFlow({ sessionKey, flowId }), flowId);
        lastFlow = flow;
        return flow?.tasks?.[0] ?? null;
      },
      async setWaiting(mutationInput: FlowMutationInput): Promise<FlowMutationResult> {
        const bridge = await bridgePromise;
        return toMutationResult(bridge.setWaiting({
          sessionKey,
          flowId: mutationInput.flowId,
          expectedRevision: mutationInput.expectedRevision === undefined ? undefined : String(mutationInput.expectedRevision),
          currentStep: mutationInput.currentStep,
          stateJson: encodeJson(mutationInput.stateJson),
          waitJson: encodeJson(mutationInput.waitJson),
        }), mutationInput.flowId);
      },
      async finish(mutationInput: FlowMutationInput): Promise<FlowMutationResult> {
        const bridge = await bridgePromise;
        return toMutationResult(bridge.finishFlow({
          sessionKey,
          flowId: mutationInput.flowId,
          expectedRevision: mutationInput.expectedRevision === undefined ? undefined : String(mutationInput.expectedRevision),
          stateJson: encodeJson(mutationInput.stateJson),
        }), mutationInput.flowId);
      },
      async fail(mutationInput: FlowMutationInput): Promise<FlowMutationResult> {
        const bridge = await bridgePromise;
        return toMutationResult(bridge.failFlow({
          sessionKey,
          flowId: mutationInput.flowId,
          expectedRevision: mutationInput.expectedRevision === undefined ? undefined : String(mutationInput.expectedRevision),
          stateJson: encodeJson(mutationInput.stateJson),
          blockedTaskId: mutationInput.blockedTaskId,
          blockedSummary: mutationInput.blockedSummary,
        }), mutationInput.flowId);
      },
      async cancel(cancelInput) {
        const bridge = await bridgePromise;
        return toCancelResult(bridge.cancelFlow({ sessionKey, flowId: cancelInput.flowId }), cancelInput.flowId);
      },
    };
  }
}

export function createOpenClawDistTaskFlowPort(options: OpenClawDistTaskFlowPortOptions = {}): TaskFlowPort {
  return new OpenClawDistTaskFlowPort(options);
}
