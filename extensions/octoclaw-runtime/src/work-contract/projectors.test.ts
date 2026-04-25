import { describe, it, expect } from "vitest";
import type { ContextCoverageSnapshot, DelegateContract } from "@octoclaw/contracts/work-contract";
import { buildWorkContractFromPolicy, buildWorkDecisionSeal } from "./builders.js";
import { projectDelegateStatusPacket, projectMainContextPacket } from "./projectors.js";

describe("work contract projectors", () => {
  it("projectMainContextPacket returns correct shape from contract", () => {
    const contract = buildWorkContractFromPolicy(
      "session-1",
      "Continue delegated implementation",
      "execution_followup",
      coverage,
      buildWorkDecisionSeal("continuation", "delegate", ["same_delegate_task"]),
      { delegate },
    );

    const packet = projectMainContextPacket(contract);

    expect(packet).toEqual({
      summary: "Continue delegated implementation",
      statusLine: "delegate via continuation",
      visibleIds: {
        workContractId: contract.workContractId,
        delegateTaskId: "delegate-1",
        attemptId: "attempt-1",
        nativeFlowId: "flow-1",
        nativeTaskId: "native-task-1",
        childSessionKey: "child-session-key-1",
        childSessionId: "run-1",
      },
      continuationHint: {
        handle: `resume_dont_restart: workContractId=${contract.workContractId}, delegateTaskId=delegate-1, childSessionKey=child-session-key-1`,
        preferredMode: "resume_preferred",
        text: "resume_dont_restart",
      },
      artifactRefs: [],
      nextAction: "dispatch",
      tokenBudget: {
        maxResumeTokens: 700,
        maxArtifactSummaryTokens: 250,
      },
      forbiddenContent: ["full_transcript", "internal_route_rationale", "delegation_rationale", "contamination_guard_text", "worker_chain_of_thought", "raw_execution_log"],
    });
  });

  it("projectDelegateStatusPacket maps delegate fields correctly", () => {
    const contract = buildWorkContractFromPolicy(
      "session-2",
      "Wait for worker",
      "delegated_work",
      coverage,
      buildWorkDecisionSeal("local_judge", "delegate", ["worker_running"]),
      { status: "running", delegate },
    );

    expect(projectDelegateStatusPacket(contract)).toEqual({
      workContractId: contract.workContractId,
      delegateTaskId: "delegate-1",
      status: "running",
      role: "code",
      nextAction: "wait",
      nativeFlowId: "flow-1",
      artifactRefs: ["artifact-1"],
    });
  });

  it("projectMainContextPacket sanitizes parent-visible content", () => {
    const contract = buildWorkContractFromPolicy(
      "session-3",
      "Check projected context",
      "delegated_work",
      coverage,
      buildWorkDecisionSeal("local_judge", "delegate", ["worker_running"]),
      { delegate },
    );
    contract.mainContext.summary = "raw route rationale: internal\nUser-visible: compact";
    (contract.mainContext as unknown as Record<string, unknown>).childTranscript = "full child transcript";

    const rendered = JSON.stringify(projectMainContextPacket(contract));

    expect(rendered).not.toContain("raw route rationale");
    expect(rendered).not.toContain("full child transcript");
    expect(rendered).toContain("User-visible: compact");
    expect(rendered).toContain(contract.workContractId);
  });
});

const coverage: ContextCoverageSnapshot = {
  precheckOrder: [
    "conversation_grounding",
    "continuation_route_reuse",
    "execution_coverage",
    "memory_coverage",
    "build_judge_context_packet",
    "local_judge",
    "validator_or_remote",
    "route_seal_commit",
  ],
  execution: {
    coverage: "thread",
  },
  memory: {
    coverage: "partial",
  },
  conflict: true,
  authority: "execution_wins",
};

const delegate: DelegateContract = {
  delegateTaskId: "delegate-1",
  currentAttemptId: "attempt-1",
  role: "code",
  coordinationMode: "solo_worker",
  acceptanceCriteria: ["produce implementation"],
  scope: {
    read: ["src"],
    write: ["src/work-contract"],
    workspaceMode: "write_allowed",
    scopeFingerprint: "scope-1",
  },
  modelProfile: "coding",
  nativeBinding: {
    flowId: "flow-1",
    ownerKey: "wc-1",
    controllerId: "octoclaw.delegate",
    revision: 2,
    expectedRevision: 2,
    nativeTaskId: "native-task-1",
    runId: "run-1",
    childSessionKey: "child-session-key-1",
    syncMode: "managed",
    status: "running",
  },
  childSessions: [],
  artifactRefs: [
    {
      artifactId: "artifact-1",
      artifactKind: "worker_report",
      createdAt: "2026-04-25T12:00:00.000Z",
    },
  ],
  nextAction: "wait",
};
