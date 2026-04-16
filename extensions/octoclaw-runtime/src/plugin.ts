import type { RuntimeWorkflowState } from "../../../packages/octoclaw-runtime-core/src/workflow";
import { createRuntimeTaskflowAdapter, type RuntimeTaskflowAdapter } from "./adapter/runtime-taskflow";

export interface OctoClawRuntimePlugin {
  name: "octoclaw-runtime-ts";
  createAdapter: () => RuntimeTaskflowAdapter;
  bindWorkflow: (state: RuntimeWorkflowState) => { taskId: string; flowId: string; status: string };
}

export function createOctoClawRuntimePlugin(): OctoClawRuntimePlugin {
  return {
    name: "octoclaw-runtime-ts",
    createAdapter: () => createRuntimeTaskflowAdapter(),
    bindWorkflow: (state) => ({
      taskId: state.taskId,
      flowId: state.flowId,
      status: state.workflowOrchestration,
    }),
  };
}
