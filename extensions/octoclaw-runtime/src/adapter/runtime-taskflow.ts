import type { RuntimeWorkflowState } from "../../../../packages/octoclaw-runtime-core/src/workflow";

export interface RuntimeTaskflowSessionBinding {
  sessionKey: string;
  bindSession: (sessionKey: string) => RuntimeTaskflowSessionBinding;
  createManaged: (workflow: RuntimeWorkflowState) => { flowId: string; controllerId: string; managed: true };
  runTask: (workflow: RuntimeWorkflowState) => { taskId: string; flowId: string; runtime: "openclaw-native" };
}

export interface RuntimeTaskflowAdapter {
  bindSession: (sessionKey: string) => RuntimeTaskflowSessionBinding;
}

export function createRuntimeTaskflowAdapter(): RuntimeTaskflowAdapter {
  const createBinding = (sessionKey: string): RuntimeTaskflowSessionBinding => ({
    sessionKey,
    bindSession: (nextSessionKey: string) => createBinding(nextSessionKey),
    createManaged: (workflow) => ({
      flowId: workflow.flowId,
      controllerId: workflow.claim?.claimOwner ?? "runtime-core",
      managed: true,
    }),
    runTask: (workflow) => ({
      taskId: workflow.taskId,
      flowId: workflow.flowId,
      runtime: "openclaw-native",
    }),
  });

  return {
    bindSession: (sessionKey: string) => createBinding(sessionKey),
  };
}
