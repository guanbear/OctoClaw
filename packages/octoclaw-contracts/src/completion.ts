export interface WorkerCompletionResult {
  schemaVersion: "octoclaw.worker_completion/v1";
  workContractId: string;
  childSessionKey: string;
  delegateTaskId: string;
  status: "success" | "failure" | "partial";
  summary: string;
  artifacts?: string[];
  errorCode?: string;
  errorMessage?: string;
  completedAt: string;
}
