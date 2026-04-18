import type { ScopeDescriptor, WorkspaceMode } from "@octoclaw/contracts/schemas";
import { describe, expect, it, vi, afterEach } from "vitest";
import { materializeDelegatedWork } from "./index.js";

describe("materializeDelegatedWork", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function buildInput(overrides: Partial<Parameters<typeof materializeDelegatedWork>[0]> = {}) {
    const readScope: ScopeDescriptor[] = [
      { resource: "docs/design.md", access: "read", reason: "read requirements" },
    ];
    const writeScope: ScopeDescriptor[] = [
      { resource: "src/plugin.ts", access: "write", reason: "apply requested change" },
      { resource: "src/plugin.test.ts", access: "write", reason: "verify behavior" },
    ];
    const workspaceMode: WorkspaceMode = "shared_workspace";

    return {
      requestId: "req-1",
      taskId: "task-1",
      flowId: "flow-1",
      role: "worker_code" as const,
      objective: JSON.stringify({
        goal: "Implement the change",
        constraints: ["stay in scope"],
        expected_output: "worker_result",
        relevant_artifact_refs: ["artifacts/spec.md"],
      }),
      requestIdempotencyKey: "idem-1",
      deliveryId: "delivery-1",
      deliveryReceiptId: "receipt-1",
      claimOwner: "worker-7",
      leaseDurationMs: 60_000,
      queueBudget: 4,
      inflightCount: 1,
      capabilitySatisfied: true,
      writeConflict: false,
      readScope,
      writeScope,
      workspaceMode,
      ...overrides,
    };
  }

  it("produces a complete delegated materialization", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-18T08:00:00.000Z"));

    const materialized = materializeDelegatedWork(buildInput());

    expect(materialized).toMatchObject({
      requestId: "req-1",
      taskId: "task-1",
      flowId: "flow-1",
      role: "worker_code",
      requestIdempotencyKey: "idem-1",
      deliveryId: "delivery-1",
      deliveryReceiptId: "receipt-1",
      claimOwner: "worker-7",
      workspaceMode: "shared_workspace",
      backend: "openclaw-native",
      modelProfile: "code",
      allowedTools: ["read", "edit", "write", "bash", "lsp"],
      outputContract: "worker_result",
    });
    expect(materialized.readScope).toEqual(buildInput().readScope);
    expect(materialized.writeScope).toEqual(buildInput().writeScope);
  });

  it("evaluates admission inline", () => {
    const materialized = materializeDelegatedWork(buildInput({ capabilitySatisfied: false }));

    expect(materialized.admission).toEqual({
      admission: "reject",
      queueBudget: 4,
      maxWorkers: undefined,
      latencyTarget: undefined,
      reason: "capability_guard_failed",
    });
  });

  it("applies the conflict policy", () => {
    const materialized = materializeDelegatedWork(buildInput({ writeConflict: true }));

    expect(materialized.conflict).toEqual({
      workspaceMode: "shared_workspace",
      hasOverlappingWrites: true,
      policy: "serialize",
      reason: "shared_workspace writes serialize by default to avoid concurrent mutation conflicts",
    });
  });

  it("generates a brief and claim token metadata", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-18T08:00:00.000Z"));

    const materialized = materializeDelegatedWork(buildInput());

    expect(materialized.brief.role).toBe("worker_code");
    expect(materialized.brief.objective).toContain("expected_output");
    expect(materialized.claimToken).toBe("task-1:worker-7:1776499200000");
    expect(materialized.leaseExpiresAt).toBe("2026-04-18T08:01:00.000Z");
  });

  it("derives write scope summary from scope descriptors", () => {
    const materialized = materializeDelegatedWork(buildInput());

    expect(materialized.writeScopeSummary).toBe("src/plugin.ts, src/plugin.test.ts");
  });

  it("is idempotent for the same inputs under a fixed clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-18T08:00:00.000Z"));

    const input = buildInput();
    const first = materializeDelegatedWork(input);
    vi.setSystemTime(new Date("2026-04-18T08:00:00.000Z"));
    const second = materializeDelegatedWork(input);

    expect(second).toEqual(first);
  });
});
