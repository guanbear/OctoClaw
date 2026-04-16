import type { RuntimeWorkflowState } from "../../../packages/octoclaw-runtime-core/src/workflow/index.ts";
import { judgePolicy, type PolicyDecision, type PolicyJudgeInput } from "../../../packages/octoclaw-policy/src/judge/index.ts";
import {
  createRuntimeTaskflowAdapter,
  type RuntimeTaskflowAdapter,
  type RuntimeTaskflowManagedRecord,
  type RuntimeTaskflowTaskRecord,
} from "./adapter/runtime-taskflow.ts";
import { createNativeTruthArtifactKinds } from "../../../packages/octoclaw-contracts/src/artifacts.ts";
import type { NativeHelperInvoker } from "./adapter/native-helper.ts";

export interface OctoClawRuntimePluginOptions {
  helperInvoker?: NativeHelperInvoker;
}

export interface OctoClawRuntimePlugin {
  name: "octoclaw-runtime-ts";
  createAdapter: () => RuntimeTaskflowAdapter;
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
  return {
    name: "octoclaw-runtime-ts",
    createAdapter,
    judgeRoute: (input) => resolveRuntimePolicyDecision(input),
    bindWorkflow: (state) => {
      const binding = createAdapter().bindSession(state.requestId || state.taskId);
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
