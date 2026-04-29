import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { TaskStatusProjection } from "@octoclaw/contracts/status-projection";
import {
  type CompactParentPacket,
  type ExecutionTransitionNotification,
  buildCompactParentPacket,
  buildExecTransitionKey,
  checkAndSetExecTransition,
  detectExecutionTransition,
  emitExecutionTransitionNotification,
  resetExecTransitionState,
} from "../execution-transition-notifier.js";

type EmitExecutionTransitionParams = Parameters<typeof emitExecutionTransitionNotification>[0];
type RunCommandSpy = MockInstance<typeof import("../../resolve/env.js").runCommand>;
type ReplaySpy = MockInstance<typeof import("../../replay/replay.js").recordPolicyReplay>;

describe("execution transition notifier", () => {
  beforeEach(() => {
    resetExecTransitionState();
    vi.restoreAllMocks();
  });

  it("dispatchExecuted=true/spawnExecuted=false emits queued/materialized text, not running", async () => {
    const { runCommandSpy, replaySpy } = await mockDelivery();

    const result = await emitExecutionTransitionNotification(notification({
      transitionKind: "dispatch_materialized",
      projection: projection({
        dispatchExecuted: true,
        spawnExecuted: false,
        status: "queued",
        statusReason: "dispatch_executed_without_spawn_evidence",
      }),
    }));

    expectNotificationResult(result);
    expect(result.sent).toBe(true);
    expect(result.transitionKind).toBe("dispatch_materialized");
    expect(runCommandSpy).toHaveBeenCalledOnce();

    const replayPayload = findReplayPayload(replaySpy);
    expect(replayPayload).toEqual(expect.objectContaining({
      transitionKind: "dispatch_materialized",
      dispatchExecuted: true,
      spawnExecuted: false,
    }));

    const text = deliveredText(runCommandSpy, replayPayload);
    expect(text).not.toMatch(/running|运行|启动/i);
    expect(text).toMatch(/排队|派发/);
  });

  it("emits spawn failure notification", async () => {
    const { runCommandSpy, replaySpy } = await mockDelivery();

    const result = await emitExecutionTransitionNotification(notification({
      transitionKind: "spawn_failed",
      projection: projection({ status: "failed", spawnExecuted: false }),
    }));

    expect(result.sent).toBe(true);
    expect(result.transitionKind).toBe("spawn_failed");
    expect(deliveredText(runCommandSpy, findReplayPayload(replaySpy))).toMatch(/失败|恢复/);
  });

  it("emits stale heartbeat notification before final timeout", async () => {
    const { runCommandSpy, replaySpy } = await mockDelivery();

    const result = await emitExecutionTransitionNotification(notification({
      transitionKind: "heartbeat_stale",
      projection: projection({
        status: "timed_out",
        dispatchExecuted: true,
        spawnExecuted: true,
      }),
    }));

    expect(result.sent).toBe(true);
    expect(result.transitionKind).toBe("heartbeat_stale");
    expect(deliveredText(runCommandSpy, findReplayPayload(replaySpy))).toMatch(/停滞|超时/);
  });

  it("emits result ready / delivery pending notification", async () => {
    const { runCommandSpy, replaySpy } = await mockDelivery();

    const result = await emitExecutionTransitionNotification(notification({
      transitionKind: "result_ready",
      projection: projection({
        status: "deliverable_ready",
        dispatchExecuted: true,
        spawnExecuted: true,
        resultMaterialized: true,
      }),
    }));

    expect(result.sent).toBe(true);
    expect(result.transitionKind).toBe("result_ready");
    expect(deliveredText(runCommandSpy, findReplayPayload(replaySpy))).toMatch(/完成|投递/);
  });

  it("processes delivery_failed notification", async () => {
    const { replaySpy } = await mockDelivery();

    const result = await emitExecutionTransitionNotification(notification({
      transitionKind: "delivery_failed",
      projection: projection({
        status: "deliverable_ready",
        dispatchExecuted: true,
        spawnExecuted: true,
        resultMaterialized: true,
      }),
    }));

    expect(result.sent).toBe(true);
    expect(result.transitionKind).toBe("delivery_failed");
    expect(findReplayPayload(replaySpy)).toEqual(expect.objectContaining({
      transitionKind: "delivery_failed",
    }));
  });

  it("dedupes transition notification", async () => {
    await mockDelivery();
    const params = notification({ transitionKind: "result_ready" });

    const first = await emitExecutionTransitionNotification(params);
    const second = await emitExecutionTransitionNotification(params);
    resetExecTransitionState();
    const third = await emitExecutionTransitionNotification(params);

    expect(first.sent).toBe(true);
    expect(second).toEqual(expect.objectContaining({
      skipped: true,
      reason: "skipped_duplicate",
    }));
    expect(third.sent).toBe(true);
  });

  it("CompactParentPacket has no transcript field", () => {
    const packet = buildCompactParentPacket(projection());

    expect("transcript" in packet).toBe(false);
    expect(packet).toEqual(expect.objectContaining({
      taskId: "task-1",
      status: "queued",
      backend: "octoclaw.delegate",
      artifactRefIds: [],
    }));
    expect(noTranscriptKeys(packet)).toBe(true);
  });

  it("detects execution transition edges", () => {
    expect(detectExecutionTransition(null, projection({
      dispatchExecuted: true,
      spawnExecuted: false,
      resultMaterialized: false,
    }))).toBe("dispatch_materialized");

    expect(detectExecutionTransition(
      projection({ dispatchExecuted: true, spawnExecuted: false, resultMaterialized: false }),
      projection({ dispatchExecuted: true, spawnExecuted: true, resultMaterialized: false }),
    )).toBe("spawn_started");

    expect(detectExecutionTransition(
      projection({ dispatchExecuted: true, spawnExecuted: true, resultMaterialized: false }),
      projection({ dispatchExecuted: true, spawnExecuted: true, resultMaterialized: true }),
    )).toBe("result_ready");

    expect(detectExecutionTransition(
      projection({ dispatchExecuted: true, spawnExecuted: true, resultMaterialized: true }),
      projection({ dispatchExecuted: true, spawnExecuted: true, resultMaterialized: true }),
    )).toBeNull();
  });

  it("skips notification with replay when there is no valid target", async () => {
    const { replaySpy } = await mockDelivery();

    const result = await emitExecutionTransitionNotification(notification({
      sessionKey: "bogus-no-colon",
      replyToMessageId: "1700000000.000100",
    }));

    expect(result.sent).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/^(target_resolution_failed|no_valid_target)$/);
    expect(replaySpy).toHaveBeenCalled();
  });

  it("CompactParentPacket uses explicit field selection", () => {
    const packet = buildCompactParentPacket(projectionWithExtraFields({
      childSessionKey: "child-key-1",
      runId: "run-1",
    }));
    const allowedFields = new Set([
      "schemaVersion",
      "projectionId",
      "generatedAt",
      "requestId",
      "flowId",
      "taskId",
      "workContractId",
      "title",
      "summary",
      "taskSummary",
      "route",
      "role",
      "coordinationMode",
      "backend",
      "modelProfile",
      "status",
      "statusReason",
      "success",
      "elapsedMs",
      "dispatchExecuted",
      "spawnExecuted",
      "resultMaterialized",
      "artifactRefs",
      "artifactRefIds",
      "actions",
      "parentThreadKey",
      "childSessionKey",
      "runId",
      "childRunId",
      "nativeFlowRevision",
      "nativeFlowExpectedRevision",
      "estimatedCostUsd",
      "actualCostUsd",
    ]);

    expect(packet.childSessionKey).toBe("child-key-1");
    expect(packet.runId).toBe("run-1");
    expect(Object.keys(packet).every((key) => allowedFields.has(key))).toBe(true);
    expect(packet).not.toHaveProperty("internalOnly");
    expect(packet).not.toHaveProperty("transcript");
    expect(packet).not.toHaveProperty("rawTranscript");
    expect(packet).not.toHaveProperty("childTranscript");
    expect(noTranscriptKeys(packet)).toBe(true);
  });

  it("builds and claims execution transition keys", () => {
    const key = buildExecTransitionKey({
      taskId: "task-1",
      attemptId: "attempt-1",
      transitionKind: "result_ready",
    });

    expect(key).toContain("task-1");
    expect(key).toContain("attempt-1");
    expect(key).toContain("result_ready");
    expect(checkAndSetExecTransition(key, "result_ready")).toEqual({ allowed: true });
    expect(checkAndSetExecTransition(key, "result_ready")).toEqual(expect.objectContaining({
      allowed: false,
    }));
  });
});

async function mockDelivery(): Promise<{ runCommandSpy: RunCommandSpy; replaySpy: ReplaySpy }> {
  const envModule = await import("../../resolve/env.js");
  const runCommandSpy = vi.spyOn(envModule, "runCommand").mockResolvedValue({
    code: 0,
    stdout: JSON.stringify({ ok: true }),
    stderr: "",
    timedOut: false,
  });
  const replaySpy = vi.spyOn(
    await import("../../replay/replay.js"),
    "recordPolicyReplay",
  );

  return { runCommandSpy, replaySpy };
}

function projection(overrides: Partial<TaskStatusProjection> = {}): TaskStatusProjection {
  return {
    schemaVersion: "octoclaw.task_status_projection/v1",
    projectionId: "test-proj-1",
    generatedAt: new Date().toISOString(),
    requestId: "req-1",
    flowId: "flow-1",
    taskId: "task-1",
    workContractId: "wc-1",
    title: "Test task",
    summary: "Test summary",
    taskSummary: "Test task",
    route: "delegate",
    role: "default",
    backend: "octoclaw.delegate",
    modelProfile: "coding",
    status: "queued",
    statusReason: "dispatch_executed_without_spawn_evidence",
    success: false,
    createdAt: "2026-04-26T00:00:00.000Z",
    elapsedMs: 5000,
    dispatchExecuted: true,
    spawnExecuted: false,
    resultMaterialized: false,
    artifactRefs: [],
    artifactRefIds: [],
    actions: ["details", "copy_ref"],
    ...overrides,
  };
}

function projectionWithExtraFields(overrides: Partial<TaskStatusProjection> = {}): TaskStatusProjection {
  const base = projection(overrides);
  const extra: Record<string, unknown> = {
    ...base,
    internalOnly: "must not leak",
    transcript: "full transcript",
    rawTranscript: "raw transcript",
    childTranscript: "child transcript",
    worker_transcript_excerpt: "transcript excerpt",
  };

  return extra as unknown as TaskStatusProjection;
}

function notification(overrides: Partial<EmitExecutionTransitionParams> = {}): EmitExecutionTransitionParams {
  return {
    sessionKey: "slack:channel:C1",
    replyToMessageId: "1700000000.000100",
    stateKey: "state-1",
    attemptId: "attempt-1",
    workContractId: "wc-1",
    transitionKind: "dispatch_materialized",
    projection: projection(),
    ...overrides,
  };
}

function findReplayPayload(replaySpy: ReplaySpy): Record<string, unknown> {
  const call = replaySpy.mock.calls.find((entry) => String(entry[0]).includes("exec"));
  expect(call).toBeDefined();
  return call![1] as Record<string, unknown>;
}

function deliveredText(runCommandSpy: RunCommandSpy, replayPayload: Record<string, unknown>): string {
  const replayText = String(replayPayload.ackMessage ?? replayPayload.message ?? replayPayload.text ?? "");
  if (replayText.length > 0) {
    return replayText;
  }

  return runCommandSpy.mock.calls
    .flatMap((call) => call)
    .map((value) => JSON.stringify(value))
    .join("\n");
}

function noTranscriptKeys(packet: CompactParentPacket): boolean {
  return Object.keys(packet).every((key) => !key.toLowerCase().includes("transcript"));
}

function expectNotificationResult(result: ExecutionTransitionNotification): void {
  expect(result.transitionKind).toBe("dispatch_materialized");
}
