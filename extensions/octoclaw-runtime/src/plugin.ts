import type { RuntimeWorkflowState } from "../../../packages/octoclaw-runtime-core/src/workflow/index.ts";
import { judgePolicy, type PolicyDecision, type PolicyJudgeInput } from "../../../packages/octoclaw-policy/src/judge/index.ts";
import { createRuntimeTaskflowAdapter, type RuntimeTaskflowAdapter } from "./adapter/runtime-taskflow.ts";

export interface OctoClawRuntimePlugin {
  name: "octoclaw-runtime-ts";
  createAdapter: () => RuntimeTaskflowAdapter;
  bindWorkflow: (state: RuntimeWorkflowState) => { taskId: string; flowId: string; status: string };
  judgeRoute: (input: PolicyJudgeInput) => PolicyDecision;
}

export function resolveRuntimePolicyDecision(input: PolicyJudgeInput): PolicyDecision {
  return judgePolicy(input);
}

export function createOctoClawRuntimePlugin(): OctoClawRuntimePlugin {
  return {
    name: "octoclaw-runtime-ts",
    createAdapter: () => createRuntimeTaskflowAdapter(),
    judgeRoute: (input) => resolveRuntimePolicyDecision(input),
    bindWorkflow: (state) => ({
      taskId: state.taskId,
      flowId: state.flowId,
      status: state.workflowOrchestration,
    }),
  };
}
