export type JsonRecord = Record<string, unknown>;

export interface TaskFlowPort {
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
