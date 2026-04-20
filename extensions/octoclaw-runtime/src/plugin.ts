import type { RuntimeWorkflowState } from "@octoclaw/runtime-core/workflow";
import { judgePolicy, type PolicyDecision, type PolicyJudgeInput } from "@octoclaw/policy/judge";
import {
  createRuntimeTaskflowAdapter,
  type RuntimeTaskflowAdapter,
  type RuntimeTaskflowManagedRecord,
  type RuntimeTaskflowTaskRecord,
} from "./adapter/runtime-taskflow.js";
import { createRuntimeWebhookSurface, type RuntimeWebhookSurface } from "./adapter/webhook-surface.js";
import { createNativeTruthArtifactKinds } from "@octoclaw/contracts/artifacts";
import type { NativeHelperInvoker } from "./adapter/native-helper.js";

export interface OctoClawRuntimePluginOptions {
  helperInvoker?: NativeHelperInvoker;
}

export interface OctoClawRuntimePlugin {
  name: "octoclaw-runtime-ts";
  createAdapter: () => RuntimeTaskflowAdapter;
  createWebhookSurface: () => RuntimeWebhookSurface;
  bindWorkflow: (state: RuntimeWorkflowState) => {
    taskId: string;
    flowId: string;
    status: string;
    runtime: "openclaw-native";
    syncMode: "managed" | "mirrored";
    substrateState: string;
    substrateRevision: number;
    truth: RuntimeTaskflowManagedRecord["truth"];
    projection: RuntimeTaskflowTaskRecord["projection"];
  };
  judgeRoute: (input: PolicyJudgeInput) => PolicyDecision;
}

export { createNativeTruthArtifactKinds };

export function resolveRuntimePolicyDecision(input: PolicyJudgeInput): PolicyDecision {
  return judgePolicy(input);
}

export function createOctoClawRuntimePlugin(options: OctoClawRuntimePluginOptions = {}): OctoClawRuntimePlugin {
  const createAdapter = (): RuntimeTaskflowAdapter => createRuntimeTaskflowAdapter(options.helperInvoker);
  const createWebhook = (): RuntimeWebhookSurface => createRuntimeWebhookSurface({ helperInvoker: options.helperInvoker, adapter: createAdapter() });
  return {
    name: "octoclaw-runtime-ts",
    createAdapter,
    createWebhookSurface: createWebhook,
    judgeRoute: (input) => resolveRuntimePolicyDecision(input),
    bindWorkflow: (state) => {
        const identity = state.identity ?? {
          requestId: (state as unknown as { requestId?: string }).requestId || "",
          taskId: (state as unknown as { taskId?: string }).taskId || "",
        };
        const binding = createAdapter().bindSession(identity.requestId || identity.taskId);
        binding.createManaged(state);
        const taskTruth = binding.runTask(state);
        return {
        taskId: taskTruth.taskId,
        flowId: taskTruth.flowId,
        status: taskTruth.substrateState,
        runtime: "openclaw-native",
        syncMode: taskTruth.syncMode,
        substrateState: taskTruth.substrateState,
        substrateRevision: taskTruth.substrateRevision,
        truth: taskTruth.truth,
        projection: taskTruth.projection,
      };
    },
  };
}
