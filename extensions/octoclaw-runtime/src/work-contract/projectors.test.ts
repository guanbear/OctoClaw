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
      openclawRunId: undefined,
      spawnIntentId: undefined,
      spawnBackend: undefined,
      spawnMode: undefined,
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

describe("Phase B acceptance: TaskStatusProjection field completeness", () => {
  it("projectMainContextPacket includes all required visible IDs", () => {
    const contract = buildPhaseBProjectionContract();

    const packet = projectMainContextPacket(contract);

    expect(packet.visibleIds.workContractId).toBe(contract.workContractId);
    expect(packet.visibleIds.delegateTaskId).toBe("delegate-phase-b");
    expect(packet.visibleIds.attemptId).toBe("attempt-phase-b-1");
    expect(packet.visibleIds.nativeFlowId).toBe("flow-phase-b");
    expect(packet.visibleIds.childSessionKey).toBe("child-key-phase-b");
    expect(packet.visibleIds.childSessionId).toBe("provider-session-phase-b");
  });

  it("projectDelegateStatusPacket includes status, role, nextAction, nativeFlowId, and artifactRefs", () => {
    const contract = buildPhaseBProjectionContract();

    const packet = projectDelegateStatusPacket(contract);

    expect(packet).toEqual({
      workContractId: contract.workContractId,
      delegateTaskId: "delegate-phase-b",
      status: "running",
      role: "research",
      nextAction: "open_artifact",
      nativeFlowId: "flow-phase-b",
      openclawRunId: undefined,
      spawnIntentId: undefined,
      spawnBackend: undefined,
      spawnMode: undefined,
      artifactRefs: ["artifact-phase-b-1", "artifact-phase-b-2"],
    });
  });

  it("projectMainContextPacket passes through context sanitizer", () => {
    const contract = buildPhaseBProjectionContract();
    contract.mainContext.summary = "raw route rationale: hidden\nVisible Phase B summary";
    (contract.mainContext as unknown as Record<string, unknown>).childTranscript = "full transcript should not project";

    const rendered = JSON.stringify(projectMainContextPacket(contract));

    expect(rendered).not.toContain("raw route rationale");
    expect(rendered).not.toContain("full transcript should not project");
    expect(rendered).toContain("Visible Phase B summary");
  });

  it("projectMainContextPacket includes continuation hint with resume_preferred", () => {
    const contract = buildPhaseBProjectionContract();

    const packet = projectMainContextPacket(contract);

    expect(packet.continuationHint).toEqual({
      handle: `resume_dont_restart: workContractId=${contract.workContractId}, delegateTaskId=delegate-phase-b, childSessionKey=child-key-phase-b, childSessionId=provider-session-phase-b`,
      preferredMode: "resume_preferred",
      text: "resume_dont_restart",
    });
  });
});

function buildPhaseBProjectionContract(): ReturnType<typeof buildWorkContractFromPolicy> {
  const contract = buildWorkContractFromPolicy(
    "session-phase-b",
    "Continue Phase B delegated implementation",
    "execution_followup",
    coverage,
    buildWorkDecisionSeal("continuation", "delegate", ["same_delegate_task"]),
    { status: "running", delegate: phaseBDelegate },
  );

  return {
    ...contract,
    continuity: {
      ...contract.continuity,
      preferredChildSessionKey: "child-key-phase-b",
      preferredChildSessionId: "provider-session-phase-b",
      preferredRunId: "run-phase-b",
      continuationMode: "resume_preferred",
      delegateTaskId: "delegate-phase-b",
    },
  };
}

const phaseBDelegate: DelegateContract = {
  delegateTaskId: "delegate-phase-b",
  currentAttemptId: "attempt-phase-b-1",
  role: "research",
  coordinationMode: "solo_worker",
  acceptanceCriteria: ["project all Phase B task status fields"],
  scope: {
    read: ["extensions/octoclaw-runtime/src/work-contract"],
    write: ["extensions/octoclaw-runtime/src/work-contract"],
    workspaceMode: "write_allowed",
    scopeFingerprint: "scope-phase-b",
  },
  modelProfile: "research",
  nativeBinding: {
    flowId: "flow-phase-b",
    ownerKey: "wc-phase-b",
    controllerId: "octoclaw.delegate",
    revision: 3,
    expectedRevision: 3,
    nativeTaskId: "native-task-phase-b",
    runId: "run-phase-b",
    childSessionKey: "child-key-phase-b",
    syncMode: "managed",
    status: "running",
  },
  childSessions: [],
  artifactRefs: [
    {
      artifactId: "artifact-phase-b-1",
      artifactKind: "worker_report",
      createdAt: "2026-04-25T12:10:00.000Z",
    },
    {
      artifactId: "artifact-phase-b-2",
      artifactKind: "worker_report",
      createdAt: "2026-04-25T12:11:00.000Z",
    },
  ],
  nextAction: "open_artifact",
};

describe("PC6: nativeSpawnRefs projection", () => {
  it("projectDelegateStatusPacket surfaces nativeSpawnRefs when present", () => {
    const contract = buildWorkContractFromPolicy(
      "session-pc6",
      "PC6 native refs test",
      "delegated_work",
      coverage,
      buildWorkDecisionSeal("local_judge", "delegate", ["needs_execution"]),
      {
        status: "running",
        delegate: {
          ...phaseBDelegate,
          delegateTaskId: "delegate-pc6",
          nextAction: "wait",
        },
      },
    );
    contract.nativeSpawnRefs = {
      openclawRunId: "run-pc6-1",
      spawnIntentId: "nsp_pc6_001",
      spawnBackend: "sessions_spawn_planner",
      spawnMode: "run",
      childSessionKey: "child-pc6-key",
    };

    const packet = projectDelegateStatusPacket(contract);

    expect(packet.openclawRunId).toBe("run-pc6-1");
    expect(packet.spawnIntentId).toBe("nsp_pc6_001");
    expect(packet.spawnBackend).toBe("sessions_spawn_planner");
    expect(packet.spawnMode).toBe("run");
    expect(packet.status).toBe("running");
  });

  it("projectDelegateStatusPacket omits nativeSpawnRefs fields when absent", () => {
    const contract = buildWorkContractFromPolicy(
      "session-pc6-no-refs",
      "PC6 no refs test",
      "delegated_work",
      coverage,
      buildWorkDecisionSeal("local_judge", "delegate", ["needs_execution"]),
      { delegate: phaseBDelegate },
    );

    const packet = projectDelegateStatusPacket(contract);

    expect(packet.openclawRunId).toBeUndefined();
    expect(packet.spawnIntentId).toBeUndefined();
    expect(packet.spawnBackend).toBeUndefined();
    expect(packet.spawnMode).toBeUndefined();
  });

  it("projectMainContextPacket surfaces nativeSpawnRefs in visibleIds", () => {
    const contract = buildWorkContractFromPolicy(
      "session-pc6-ctx",
      "PC6 context packet test",
      "delegated_work",
      coverage,
      buildWorkDecisionSeal("local_judge", "delegate", ["needs_execution"]),
      { delegate: phaseBDelegate },
    );
    contract.nativeSpawnRefs = {
      openclawRunId: "run-pc6-ctx",
      spawnIntentId: "nsp_pc6_ctx",
      spawnBackend: "sessions_spawn_planner",
      spawnMode: "session",
    };

    const packet = projectMainContextPacket(contract);

    expect(packet.visibleIds.openclawRunId).toBe("run-pc6-ctx");
    expect(packet.visibleIds.spawnIntentId).toBe("nsp_pc6_ctx");
    expect(packet.visibleIds.spawnBackend).toBe("sessions_spawn_planner");
    expect(packet.visibleIds.spawnMode).toBe("session");
  });

  it("nativeSpawnRefs do not cause delegate status to show running without evidence", () => {
    const contract = buildWorkContractFromPolicy(
      "session-pc6-honest",
      "PC6 honesty test",
      "delegated_work",
      coverage,
      buildWorkDecisionSeal("local_judge", "delegate", ["needs_execution"]),
      {
        status: "sealed",
        delegate: {
          ...phaseBDelegate,
          nativeBinding: null,
          nextAction: "dispatch",
        },
      },
    );
    contract.nativeSpawnRefs = {
      openclawRunId: "run-phantom",
      spawnIntentId: "nsp_phantom",
      spawnBackend: "sessions_spawn_planner",
      spawnMode: "run",
    };

    const packet = projectDelegateStatusPacket(contract);

    expect(packet.status).toBe("sealed");
    expect(packet.nextAction).toBe("dispatch");
    expect(packet.openclawRunId).toBe("run-phantom");
  });
});
