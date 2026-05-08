import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import type {
  ChildSessionContinuity,
  ContextCoverageSnapshot,
  DelegateContract,
  NativeBindingRef,
} from "@octoclaw/contracts/work-contract";
import { buildWorkContractFromPolicy, buildWorkDecisionSeal } from "./builders.js";
import { saveWorkContract } from "./store.js";
import {
  selectPreferredChildSession,
  markChildSessionPreferred,
  markChildSessionRetired,
  buildContinuationHandle,
} from "./continuity.js";

const mockFs = vi.hoisted(() => ({
  files: new Map<string, string>(),
  directories: new Set<string>(),
  existsSync: vi.fn((pathname: string) => mockFs.files.has(pathname) || mockFs.directories.has(pathname)),
  mkdirSync: vi.fn((pathname: string) => { mockFs.directories.add(pathname); }),
  readFileSync: vi.fn((pathname: string) => {
    const content = mockFs.files.get(pathname);
    if (content === undefined) throw new Error(`missing file: ${pathname}`);
    return content;
  }),
  writeFileSync: vi.fn((pathname: string, data: string) => { mockFs.files.set(pathname, data); }),
  renameSync: vi.fn((oldPath: string, newPath: string) => {
    const data = mockFs.files.get(oldPath);
    if (data !== undefined) {
      mockFs.files.delete(oldPath);
      mockFs.files.set(newPath, data);
    }
  }),
  unlinkSync: vi.fn((pathname: string) => {
    mockFs.files.delete(pathname);
  }),
}));

vi.mock("node:fs", () => ({ default: mockFs }));

describe("child session continuity", () => {
  let ledgerPath: string;
  let originalRuntimeLedger: string | undefined;

  beforeEach(() => {
    originalRuntimeLedger = process.env.OCTOCLAW_RUNTIME_LEDGER;
    process.env.OCTOCLAW_RUNTIME_LEDGER = "off";
    mockFs.files.clear();
    mockFs.directories.clear();
    mockFs.existsSync.mockClear();
    mockFs.mkdirSync.mockClear();
    mockFs.readFileSync.mockClear();
    mockFs.writeFileSync.mockClear();
    mockFs.renameSync.mockClear();
    mockFs.unlinkSync.mockClear();
    ledgerPath = path.join("/tmp", "octoclaw-wp6-test", "work-contracts.json");
  });

  afterEach(() => {
    if (originalRuntimeLedger !== undefined) process.env.OCTOCLAW_RUNTIME_LEDGER = originalRuntimeLedger;
    else delete process.env.OCTOCLAW_RUNTIME_LEDGER;
    vi.restoreAllMocks();
  });

  const nativeBinding: NativeBindingRef = {
    flowId: "flow-wp6",
    ownerKey: "wc-wp6",
    controllerId: "octoclaw.delegate",
    revision: 1,
    expectedRevision: 1,
    syncMode: "managed",
    status: "running",
    childSessionKey: "child-key-1",
  };

  function buildSealedDelegate(overrides: {
    sessionKey?: string;
    userAsk?: string;
    delegate?: DelegateContract;
  } = {}): ReturnType<typeof buildWorkContractFromPolicy> {
    const delegate: DelegateContract = overrides.delegate ?? {
      delegateTaskId: "delegate-wp6",
      currentAttemptId: "attempt-1",
      role: "code",
      coordinationMode: "solo_worker",
      acceptanceCriteria: ["tests pass"],
      scope: { read: ["src"], write: ["src/wp6"], workspaceMode: "write_allowed", scopeFingerprint: "scope-wp6" },
      modelProfile: "coding",
      nativeBinding,
      childSessions: [],
      artifactRefs: [],
      nextAction: "wait",
    };
    return buildWorkContractFromPolicy(
      overrides.sessionKey ?? "session-wp6",
      overrides.userAsk ?? "Implement WP6 continuity",
      "delegated_work",
      coverage,
      buildWorkDecisionSeal("local_judge", "delegate", ["needs_execution"]),
      { delegate },
    );
  }

  function withPreferredChild(contract: ReturnType<typeof buildWorkContractFromPolicy>, key: string): typeof contract {
    const child: ChildSessionContinuity = {
      childSessionKey: key,
      delegateTaskId: "delegate-wp6",
      firstAttemptId: "attempt-1",
      latestAttemptId: "attempt-1",
      agentRole: "code",
      modelProfile: "coding",
      parentSessionKey: contract.sessionKey,
      threadBindingKey: contract.continuity.threadBindingKey,
      scopeFingerprint: "scope-wp6",
      status: "running",
      reuseState: "preferred",
    };
    const delegate = {
      ...contract.delegate!,
      childSessions: [child],
    };
    const continuity = {
      ...contract.continuity,
      preferredChildSessionKey: key,
    };
    return { ...contract, delegate, continuity };
  }

  it("same delegate task follow-up selects preferred child session", () => {
    const contract = withPreferredChild(buildSealedDelegate(), "child-key-1");

    const result = selectPreferredChildSession(contract, "resume_preferred");

    expect(result.selected).not.toBeNull();
    expect(result.selected!.childSessionKey).toBe("child-key-1");
    expect(result.selected!.reuseState).toBe("preferred");
    expect(result.reason).toBe("preferred_child_session_found");
  });

  it("new intent does not reuse unrelated child session", () => {
    const newContract = buildSealedDelegate({
      sessionKey: "session-new-intent",
      userAsk: "Completely different task",
      delegate: {
        delegateTaskId: "delegate-different",
        currentAttemptId: "attempt-new",
        role: "research",
        coordinationMode: "solo_worker",
        acceptanceCriteria: [],
        scope: { read: [], write: [], workspaceMode: "read_only", scopeFingerprint: "scope-different" },
        modelProfile: "research",
        nativeBinding: null,
        childSessions: [],
        artifactRefs: [],
        nextAction: "dispatch",
      },
    });

    const result = selectPreferredChildSession(newContract, "resume_preferred");

    expect(result.selected).toBeNull();
    expect(result.reason).toBe("no_reusable_child_session");
  });

  it("retry transient preserves preferred session", () => {
    const contract = withPreferredChild(buildSealedDelegate(), "child-key-retry");

    const result = selectPreferredChildSession(contract, "resume_preferred");

    expect(result.selected).not.toBeNull();
    expect(result.selected!.childSessionKey).toBe("child-key-retry");
    expect(result.selected!.reuseState).toBe("preferred");
  });

  it("contamination/wrong scope retires old session", () => {
    const contract = buildSealedDelegate();
    saveWorkContract(contract, ledgerPath);

    const withChild = withPreferredChild(contract, "child-key-contaminated");
    saveWorkContract(withChild, ledgerPath);

    const retired = markChildSessionRetired({
      workContractId: contract.workContractId,
      ledgerPath,
      childSessionKey: "child-key-contaminated",
      reason: "contamination",
    });

    expect(retired).not.toBeNull();
    const child = retired!.delegate?.childSessions?.find(
      (s: ChildSessionContinuity) => s.childSessionKey === "child-key-contaminated",
    );
    expect(child?.reuseState).toBe("retired");
    expect(child?.status).toBe("retired");
    expect(child?.reuseBlockedReason).toBe("contamination");
    expect(retired!.continuity.preferredChildSessionKey).toBeUndefined();
  });

  it("wrong scope retires old session", () => {
    const contract = buildSealedDelegate();
    saveWorkContract(contract, ledgerPath);
    const withChild = withPreferredChild(contract, "child-key-wrong-scope");
    saveWorkContract(withChild, ledgerPath);

    const retired = markChildSessionRetired({
      workContractId: contract.workContractId,
      ledgerPath,
      childSessionKey: "child-key-wrong-scope",
      reason: "wrong_scope",
    });

    expect(retired).not.toBeNull();
    const child = retired!.delegate?.childSessions?.find(
      (s: ChildSessionContinuity) => s.childSessionKey === "child-key-wrong-scope",
    );
    expect(child?.reuseBlockedReason).toBe("wrong_scope");
    expect(child?.reuseState).toBe("retired");
  });

  it("parent main context projection includes compact resume_dont_restart handle", () => {
    const contract = withPreferredChild(buildSealedDelegate(), "child-key-ctx");

    const handle = buildContinuationHandle(contract);

    expect(handle).toContain("resume_dont_restart:");
    expect(handle).toContain(`workContractId=${contract.workContractId}`);
    expect(handle).toContain("delegateTaskId=delegate-wp6");
    expect(handle).toContain("childSessionKey=child-key-ctx");
    expect(handle).not.toContain("childSessionId=");
  });

  it("parent main context handle does not contain child transcript", () => {
    const contract = withPreferredChild(buildSealedDelegate(), "child-key-compact");

    const handle = buildContinuationHandle(contract);

    expect(handle).not.toContain("full_transcript");
    expect(handle).not.toContain("chain_of_thought");
    expect(handle!.length).toBeLessThan(300);
  });

  it("childSessionId absent when not provided - never faked", () => {
    const contract = buildSealedDelegate();
    saveWorkContract(contract, ledgerPath);

    const marked = markChildSessionPreferred({
      workContractId: contract.workContractId,
      ledgerPath,
      childSessionKey: "child-key-no-provider-id",
      delegateTaskId: "delegate-wp6",
      attemptId: "attempt-1",
      agentRole: "code",
      modelProfile: "coding",
      parentSessionKey: contract.sessionKey,
      threadBindingKey: contract.continuity.threadBindingKey,
      scopeFingerprint: "scope-wp6",
    });

    expect(marked).not.toBeNull();
    const child = marked!.delegate?.childSessions?.find(
      (s: ChildSessionContinuity) => s.childSessionKey === "child-key-no-provider-id",
    );
    expect(child).not.toBeNull();
    expect(child!.childSessionId).toBeUndefined();

    const handle = buildContinuationHandle(marked!);
    expect(handle).not.toContain("childSessionId=");
  });

  it("childSessionId present only when provider exposes it", () => {
    const contract = buildSealedDelegate();
    saveWorkContract(contract, ledgerPath);

    const marked = markChildSessionPreferred({
      workContractId: contract.workContractId,
      ledgerPath,
      childSessionKey: "child-key-with-provider",
      delegateTaskId: "delegate-wp6",
      attemptId: "attempt-2",
      agentRole: "code",
      modelProfile: "coding",
      parentSessionKey: contract.sessionKey,
      threadBindingKey: contract.continuity.threadBindingKey,
      scopeFingerprint: "scope-wp6",
      childSessionId: "provider-session-abc",
      runId: "run-123",
    });

    expect(marked).not.toBeNull();
    const child = marked!.delegate?.childSessions?.find(
      (s: ChildSessionContinuity) => s.childSessionKey === "child-key-with-provider",
    );
    expect(child!.childSessionId).toBe("provider-session-abc");
    expect(child!.runId).toBe("run-123");

    const handle = buildContinuationHandle(marked!);
    expect(handle).toContain("childSessionId=provider-session-abc");
  });

  it("new_attempt mode returns null even with preferred session", () => {
    const contract = withPreferredChild(buildSealedDelegate(), "child-key-new");

    const result = selectPreferredChildSession(contract, "new_attempt");

    expect(result.selected).toBeNull();
    expect(result.reason).toBe("new_attempt_requested");
  });

  it("status_only mode with preferred session returns it", () => {
    const contract = withPreferredChild(buildSealedDelegate(), "child-key-status");

    const result = selectPreferredChildSession(contract, "status_only");

    expect(result.selected).not.toBeNull();
    expect(result.selected!.childSessionKey).toBe("child-key-status");
    expect(result.reason).toBe("status_only_with_preferred");
  });

  it("status_only mode without preferred session returns null", () => {
    const contract = buildSealedDelegate();

    const result = selectPreferredChildSession(contract, "status_only");

    expect(result.selected).toBeNull();
    expect(result.reason).toBe("no_preferred_available");
  });

  it("eligible session promoted when no preferred exists", () => {
    const child: ChildSessionContinuity = {
      childSessionKey: "child-eligible",
      delegateTaskId: "delegate-wp6",
      firstAttemptId: "attempt-1",
      latestAttemptId: "attempt-1",
      agentRole: "code",
      modelProfile: "coding",
      parentSessionKey: "session-wp6",
      threadBindingKey: "thread-wp6",
      scopeFingerprint: "scope-wp6",
      status: "idle",
      reuseState: "eligible",
    };
    const contract = buildSealedDelegate({
      delegate: {
        delegateTaskId: "delegate-wp6",
        currentAttemptId: "attempt-1",
        role: "code",
        coordinationMode: "solo_worker",
        acceptanceCriteria: [],
        scope: { read: [], write: [], workspaceMode: "write_allowed", scopeFingerprint: "scope-wp6" },
        modelProfile: "coding",
        nativeBinding: null,
        childSessions: [child],
        artifactRefs: [],
        nextAction: "dispatch",
      },
    });

    const result = selectPreferredChildSession(contract, "resume_preferred");

    expect(result.selected).not.toBeNull();
    expect(result.selected!.childSessionKey).toBe("child-eligible");
    expect(result.reason).toBe("eligible_child_session_promoted");
  });

  it("retired session not selected even if only one available", () => {
    const child: ChildSessionContinuity = {
      childSessionKey: "child-retired",
      delegateTaskId: "delegate-wp6",
      firstAttemptId: "attempt-1",
      latestAttemptId: "attempt-1",
      agentRole: "code",
      modelProfile: "coding",
      parentSessionKey: "session-wp6",
      threadBindingKey: "thread-wp6",
      scopeFingerprint: "scope-wp6",
      status: "retired",
      reuseState: "retired",
      reuseBlockedReason: "contamination",
    };
    const contract = buildSealedDelegate({
      delegate: {
        delegateTaskId: "delegate-wp6",
        currentAttemptId: "attempt-1",
        role: "code",
        coordinationMode: "solo_worker",
        acceptanceCriteria: [],
        scope: { read: [], write: [], workspaceMode: "write_allowed", scopeFingerprint: "scope-wp6" },
        modelProfile: "coding",
        nativeBinding: null,
        childSessions: [child],
        artifactRefs: [],
        nextAction: "dispatch",
      },
    });

    const result = selectPreferredChildSession(contract, "resume_preferred");

    expect(result.selected).toBeNull();
    expect(result.reason).toBe("no_reusable_child_session");
  });

  it("markChildSessionPreferred demotes previous preferred to eligible", () => {
    const contract = buildSealedDelegate();
    saveWorkContract(contract, ledgerPath);

    markChildSessionPreferred({
      workContractId: contract.workContractId,
      ledgerPath,
      childSessionKey: "child-first",
      delegateTaskId: "delegate-wp6",
      attemptId: "attempt-1",
      agentRole: "code",
      modelProfile: "coding",
      parentSessionKey: contract.sessionKey,
      threadBindingKey: contract.continuity.threadBindingKey,
      scopeFingerprint: "scope-wp6",
    });

    const marked2 = markChildSessionPreferred({
      workContractId: contract.workContractId,
      ledgerPath,
      childSessionKey: "child-second",
      delegateTaskId: "delegate-wp6",
      attemptId: "attempt-2",
      agentRole: "code",
      modelProfile: "coding",
      parentSessionKey: contract.sessionKey,
      threadBindingKey: contract.continuity.threadBindingKey,
      scopeFingerprint: "scope-wp6",
    });

    expect(marked2).not.toBeNull();
    const first = marked2!.delegate?.childSessions?.find(
      (s: ChildSessionContinuity) => s.childSessionKey === "child-first",
    );
    const second = marked2!.delegate?.childSessions?.find(
      (s: ChildSessionContinuity) => s.childSessionKey === "child-second",
    );
    expect(first?.reuseState).toBe("eligible");
    expect(second?.reuseState).toBe("preferred");
    expect(marked2!.continuity.preferredChildSessionKey).toBe("child-second");
  });

  it("preferred child with mismatched delegateTaskId is not selected", () => {
    const child: ChildSessionContinuity = {
      childSessionKey: "child-wrong-delegate",
      delegateTaskId: "delegate-UNRELATED",
      firstAttemptId: "attempt-1",
      latestAttemptId: "attempt-1",
      agentRole: "code",
      modelProfile: "coding",
      parentSessionKey: "session-wp6",
      threadBindingKey: "thread-wp6",
      scopeFingerprint: "scope-wp6",
      status: "running",
      reuseState: "preferred",
    };
    const contract = buildSealedDelegate({
      delegate: {
        delegateTaskId: "delegate-wp6",
        currentAttemptId: "attempt-1",
        role: "code",
        coordinationMode: "solo_worker",
        acceptanceCriteria: [],
        scope: { read: [], write: [], workspaceMode: "write_allowed", scopeFingerprint: "scope-wp6" },
        modelProfile: "coding",
        nativeBinding: null,
        childSessions: [child],
        artifactRefs: [],
        nextAction: "dispatch",
      },
    });

    const result = selectPreferredChildSession(contract, "resume_preferred");

    expect(result.selected).toBeNull();
    expect(result.reason).toBe("no_reusable_child_session");
  });

  it("preferred child with mismatched scopeFingerprint is not selected", () => {
    const child: ChildSessionContinuity = {
      childSessionKey: "child-wrong-scope",
      delegateTaskId: "delegate-wp6",
      firstAttemptId: "attempt-1",
      latestAttemptId: "attempt-1",
      agentRole: "code",
      modelProfile: "coding",
      parentSessionKey: "session-wp6",
      threadBindingKey: "thread-wp6",
      scopeFingerprint: "scope-UNRELATED",
      status: "running",
      reuseState: "preferred",
    };
    const contract = buildSealedDelegate({
      delegate: {
        delegateTaskId: "delegate-wp6",
        currentAttemptId: "attempt-1",
        role: "code",
        coordinationMode: "solo_worker",
        acceptanceCriteria: [],
        scope: { read: [], write: [], workspaceMode: "write_allowed", scopeFingerprint: "scope-wp6" },
        modelProfile: "coding",
        nativeBinding: null,
        childSessions: [child],
        artifactRefs: [],
        nextAction: "dispatch",
      },
    });

    const result = selectPreferredChildSession(contract, "resume_preferred");

    expect(result.selected).toBeNull();
    expect(result.reason).toBe("no_reusable_child_session");
  });

  it("re-marking preferred without childSessionId/runId preserves existing values", () => {
    const contract = buildSealedDelegate();
    saveWorkContract(contract, ledgerPath);

    const first = markChildSessionPreferred({
      workContractId: contract.workContractId,
      ledgerPath,
      childSessionKey: "child-persist",
      delegateTaskId: "delegate-wp6",
      attemptId: "attempt-1",
      agentRole: "code",
      modelProfile: "coding",
      parentSessionKey: contract.sessionKey,
      threadBindingKey: contract.continuity.threadBindingKey,
      scopeFingerprint: "scope-wp6",
      childSessionId: "provider-session-xyz",
      runId: "run-456",
      providerSessionBinding: { provider: "claude-code", sessionId: "provider-session-xyz" },
    });
    expect(first).not.toBeNull();

    const second = markChildSessionPreferred({
      workContractId: contract.workContractId,
      ledgerPath,
      childSessionKey: "child-persist",
      delegateTaskId: "delegate-wp6",
      attemptId: "attempt-2",
      agentRole: "code",
      modelProfile: "coding",
      parentSessionKey: contract.sessionKey,
      threadBindingKey: contract.continuity.threadBindingKey,
      scopeFingerprint: "scope-wp6",
    });
    expect(second).not.toBeNull();

    const child = second!.delegate?.childSessions?.find(
      (s: ChildSessionContinuity) => s.childSessionKey === "child-persist",
    );
    expect(child!.childSessionId).toBe("provider-session-xyz");
    expect(child!.runId).toBe("run-456");
    expect(child!.providerSessionBinding?.provider).toBe("claude-code");
    expect(child!.providerSessionBinding?.sessionId).toBe("provider-session-xyz");

    expect(second!.continuity.preferredChildSessionId).toBe("provider-session-xyz");
    expect(second!.continuity.preferredRunId).toBe("run-456");
    expect(second!.mainContext.visibleIds.childSessionId).toBe("provider-session-xyz");
  });

  it("buildContinuationHandle returns undefined when no childSessionKey", () => {
    const contract = buildSealedDelegate({
      delegate: {
        delegateTaskId: "delegate-no-child",
        currentAttemptId: null,
        role: "code",
        coordinationMode: "solo_worker",
        acceptanceCriteria: [],
        scope: { read: [], write: [], workspaceMode: "read_only", scopeFingerprint: "" },
        modelProfile: "",
        nativeBinding: null,
        childSessions: [],
        artifactRefs: [],
        nextAction: "dispatch",
      },
    });

    expect(buildContinuationHandle(contract)).toBeUndefined();
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
  execution: { coverage: "none" },
  memory: { coverage: "none" },
  conflict: false,
  authority: "none",
};

describe("Phase B acceptance: child session continuity invariants", () => {
  let ledgerPath: string;
  let originalRuntimeLedger: string | undefined;

  beforeEach(() => {
    originalRuntimeLedger = process.env.OCTOCLAW_RUNTIME_LEDGER;
    process.env.OCTOCLAW_RUNTIME_LEDGER = "off";
    mockFs.files.clear();
    mockFs.directories.clear();
    mockFs.existsSync.mockClear();
    mockFs.mkdirSync.mockClear();
    mockFs.readFileSync.mockClear();
    mockFs.writeFileSync.mockClear();
    ledgerPath = path.join("/tmp", "octoclaw-phase-b-test", "work-contracts.json");
  });

  afterEach(() => {
    if (originalRuntimeLedger !== undefined) process.env.OCTOCLAW_RUNTIME_LEDGER = originalRuntimeLedger;
    else delete process.env.OCTOCLAW_RUNTIME_LEDGER;
    vi.restoreAllMocks();
  });

  const phaseBNativeBinding: NativeBindingRef = {
    flowId: "flow-phase-b",
    ownerKey: "wc-phase-b",
    controllerId: "octoclaw.delegate",
    revision: 1,
    expectedRevision: 1,
    syncMode: "managed",
    status: "running",
    childSessionKey: "child-key-phase-b",
  };

  function buildPhaseBContract(overrides: {
    sessionKey?: string;
    userAsk?: string;
    delegate?: DelegateContract;
  } = {}): ReturnType<typeof buildWorkContractFromPolicy> {
    const delegate: DelegateContract = overrides.delegate ?? {
      delegateTaskId: "delegate-phase-b",
      currentAttemptId: "attempt-phase-b-1",
      role: "code",
      coordinationMode: "solo_worker",
      acceptanceCriteria: ["phase b acceptance passes"],
      scope: { read: ["src"], write: ["src/work-contract"], workspaceMode: "write_allowed", scopeFingerprint: "scope-phase-b" },
      modelProfile: "coding",
      nativeBinding: phaseBNativeBinding,
      childSessions: [],
      artifactRefs: [],
      nextAction: "wait",
    };
    return buildWorkContractFromPolicy(
      overrides.sessionKey ?? "session-phase-b",
      overrides.userAsk ?? "Implement Phase B continuity acceptance",
      "delegated_work",
      coverage,
      buildWorkDecisionSeal("local_judge", "delegate", ["phase_b_acceptance"]),
      { delegate },
    );
  }

  function saveAndMarkPreferred(
    contract: ReturnType<typeof buildWorkContractFromPolicy>,
    overrides: Partial<Parameters<typeof markChildSessionPreferred>[0]> = {},
  ): ReturnType<typeof markChildSessionPreferred> {
    saveWorkContract(contract, ledgerPath);
    return markChildSessionPreferred({
      workContractId: contract.workContractId,
      ledgerPath,
      childSessionKey: "child-key-phase-b",
      delegateTaskId: "delegate-phase-b",
      attemptId: "attempt-phase-b-1",
      agentRole: "code",
      modelProfile: "coding",
      parentSessionKey: contract.sessionKey,
      threadBindingKey: contract.continuity.threadBindingKey,
      scopeFingerprint: "scope-phase-b",
      ...overrides,
    });
  }

  it("saves childSessionKey, childSessionId, and runId to WorkContract", () => {
    const contract = buildPhaseBContract();

    const marked = saveAndMarkPreferred(contract, {
      childSessionKey: "child-key-phase-b-saved",
      childSessionId: "provider-session-phase-b",
      runId: "run-phase-b",
    });

    expect(marked).not.toBeNull();
    const child = marked!.delegate?.childSessions[0];
    expect(child?.childSessionKey).toBe("child-key-phase-b-saved");
    expect(child?.childSessionId).toBe("provider-session-phase-b");
    expect(child?.runId).toBe("run-phase-b");
    expect(marked!.continuity.preferredChildSessionKey).toBe("child-key-phase-b-saved");
    expect(marked!.continuity.preferredChildSessionId).toBe("provider-session-phase-b");
    expect(marked!.continuity.preferredRunId).toBe("run-phase-b");
  });

  it("same-task follow-up uses resume_preferred", () => {
    const contract = buildPhaseBContract();
    const marked = saveAndMarkPreferred(contract);

    const result = selectPreferredChildSession(marked!, "resume_preferred");

    expect(result.selected).not.toBeNull();
    expect(result.selected!.delegateTaskId).toBe("delegate-phase-b");
    expect(result.selected!.childSessionKey).toBe("child-key-phase-b");
    expect(result.reason).toBe("preferred_child_session_found");
  });

  it("new intent with a different delegateTaskId does not reuse old session", () => {
    const oldChild: ChildSessionContinuity = {
      childSessionKey: "child-key-old-intent",
      delegateTaskId: "delegate-old-intent",
      firstAttemptId: "attempt-old-1",
      latestAttemptId: "attempt-old-1",
      agentRole: "code",
      modelProfile: "coding",
      parentSessionKey: "session-phase-b",
      threadBindingKey: "thread-phase-b",
      scopeFingerprint: "scope-phase-b",
      status: "running",
      reuseState: "preferred",
    };
    const contract = buildPhaseBContract({
      userAsk: "Start a new Phase B intent",
      delegate: {
        delegateTaskId: "delegate-new-intent",
        currentAttemptId: "attempt-new-1",
        role: "code",
        coordinationMode: "solo_worker",
        acceptanceCriteria: ["new intent should not resume old child"],
        scope: { read: ["src"], write: ["src/work-contract"], workspaceMode: "write_allowed", scopeFingerprint: "scope-phase-b" },
        modelProfile: "coding",
        nativeBinding: phaseBNativeBinding,
        childSessions: [oldChild],
        artifactRefs: [],
        nextAction: "dispatch",
      },
    });

    const result = selectPreferredChildSession(contract, "resume_preferred");

    expect(result.selected).toBeNull();
    expect(result.reason).toBe("no_reusable_child_session");
  });

  it("buildContinuationHandle does not include child transcript content in parent context", () => {
    const contract = buildPhaseBContract();
    const marked = saveAndMarkPreferred(contract, {
      childSessionKey: "child-key-compact-handle",
      childSessionId: "provider-session-compact",
    });
    marked!.mainContext.summary = "Child said SECRET_TRANSCRIPT_CONTENT and raw execution details";

    const handle = buildContinuationHandle(marked!);

    expect(handle).toContain("resume_dont_restart:");
    expect(handle).toContain(`workContractId=${marked!.workContractId}`);
    expect(handle).toContain("delegateTaskId=delegate-phase-b");
    expect(handle).toContain("childSessionKey=child-key-compact-handle");
    expect(handle).toContain("childSessionId=provider-session-compact");
    expect(handle).not.toContain("SECRET_TRANSCRIPT_CONTENT");
    expect(handle).not.toContain("raw execution details");
    expect(handle!.length).toBeLessThan(300);
  });

  it("retired session is never selected for reuse", () => {
    const contract = buildPhaseBContract();
    const marked = saveAndMarkPreferred(contract, {
      childSessionKey: "child-key-retired-phase-b",
    });
    expect(marked).not.toBeNull();

    const retired = markChildSessionRetired({
      workContractId: contract.workContractId,
      ledgerPath,
      childSessionKey: "child-key-retired-phase-b",
      reason: "superseded",
    });
    const result = selectPreferredChildSession(retired!, "resume_preferred");

    expect(retired).not.toBeNull();
    expect(result.selected).toBeNull();
    expect(result.reason).toBe("no_reusable_child_session");
  });
});
