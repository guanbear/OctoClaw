import fsSync from "node:fs";
import path from "node:path";

const fs = fsSync as unknown as { existsSync(pathname: string): boolean; mkdtempSync(prefix: string): string };
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
  projectTransitionText,
  resetExecTransitionState,
} from "../execution-transition-notifier.js";

type EmitExecutionTransitionParams = Parameters<typeof emitExecutionTransitionNotification>[0];
type ReplaySpy = MockInstance<typeof import("../../replay/replay.js").recordPolicyReplay>;
const mockSendIMMessage = vi.hoisted(() => vi.fn());
const mockFetchLatestUserMessageTsForSessionKey = vi.hoisted(() => vi.fn());

vi.mock("../../im/send.js", () => ({
  sendIMMessage: mockSendIMMessage,
}));

vi.mock("../../im/slack-thread-anchor.js", () => ({
  fetchLatestUserMessageTsForSessionKey: mockFetchLatestUserMessageTsForSessionKey,
}));

describe("execution transition notifier", () => {
  beforeEach(async () => {
    resetExecTransitionState();
    vi.restoreAllMocks();
    mockSendIMMessage.mockReset();
    mockSendIMMessage.mockResolvedValue({ sent: true, threadTs: "1700000000.000100" });
    mockFetchLatestUserMessageTsForSessionKey.mockReset();
    mockFetchLatestUserMessageTsForSessionKey.mockResolvedValue("1779106321.001122");
    const { envOverrides } = await import("../../resolve/env.js");
    envOverrides.workspaceRoot = "";
  });

  it("dispatchExecuted=true/spawnExecuted=false emits queued/materialized text, not running", async () => {
    const { sendSpy, replaySpy } = await mockDelivery();

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
    expect(sendSpy).toHaveBeenCalledOnce();

    const replayPayload = findReplayPayload(replaySpy);
    expect(replayPayload).toEqual(expect.objectContaining({
      transitionKind: "dispatch_materialized",
      dispatchExecuted: true,
      spawnExecuted: false,
    }));

    const text = deliveredText(replayPayload);
    expect(text).not.toMatch(/running|运行|启动/i);
    expect(text).toMatch(/排队|派发/);
  });

  it("emits spawn failure notification", async () => {
    const { replaySpy } = await mockDelivery();

    const result = await emitExecutionTransitionNotification(notification({
      transitionKind: "spawn_failed",
      projection: projection({ status: "failed", spawnExecuted: false }),
    }));

    expect(result.sent).toBe(true);
    expect(result.transitionKind).toBe("spawn_failed");
    expect(deliveredText(findReplayPayload(replaySpy))).toMatch(/失败|恢复/);
  });

  it("labels spawn_started ACK as a child task start", () => {
    expect(projectTransitionText("spawn_started", projection({
      status: "running",
      dispatchExecuted: true,
      spawnExecuted: true,
    }))).toContain("子任务");
  });

  it("emits stale heartbeat notification before final timeout", async () => {
    const { replaySpy } = await mockDelivery();

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
    expect(deliveredText(findReplayPayload(replaySpy))).toMatch(/停滞|超时/);
  });

  it("emits result ready / delivery pending notification", async () => {
    const { replaySpy } = await mockDelivery();

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
    expect(deliveredText(findReplayPayload(replaySpy))).toMatch(/完成|投递/);
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

  it("does not persist delivery_failed notification retries when the notification send fails", async () => {
    const { envOverrides } = await import("../../resolve/env.js");
    const tmpDir = fs.mkdtempSync(path.join("/tmp", "octoclaw-exec-transition-"));
    envOverrides.workspaceRoot = tmpDir;
    vi.spyOn(await import("../../replay/replay.js"), "recordPolicyReplay").mockResolvedValue(undefined);
    mockSendIMMessage.mockResolvedValueOnce({ sent: false, error: "timeout" });

    const result = await emitExecutionTransitionNotification(notification({
      transitionKind: "delivery_failed",
      projection: projection({
        status: "deliverable_ready",
        dispatchExecuted: true,
        spawnExecuted: true,
        resultMaterialized: true,
      }),
    }));

    expect(result.sent).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, ".octoclaw", "delivery-outbox.json"))).toBe(false);
  });

  it("records notification send exceptions without leaking unhandled rejections", async () => {
    const replaySpy = vi.spyOn(await import("../../replay/replay.js"), "recordPolicyReplay").mockResolvedValue(undefined);
    mockSendIMMessage.mockRejectedValueOnce(new DOMException("This operation was aborted", "AbortError"));

    const result = await emitExecutionTransitionNotification(notification({
      transitionKind: "spawn_started",
      projection: projection({
        status: "running",
        dispatchExecuted: true,
        spawnExecuted: true,
      }),
    }));

    expect(result).toEqual(expect.objectContaining({
      sent: false,
      skipped: false,
      reason: "channel_message_failed",
      ack_target_resolution_state: "resolved_send_failed",
      ack_delivery_state: "failed",
    }));
    expect(findReplayPayload(replaySpy)).toEqual(expect.objectContaining({
      sent: false,
      reason: "channel_message_failed",
    }));
  });

  it("anchors spawn_started ACK to the Slack thread encoded in the session key", async () => {
    await mockDelivery();

    const result = await emitExecutionTransitionNotification(notification({
      sessionKey: "agent:main:slack:default:direct:u0al9t5u89z:thread:1779106347.154489",
      replyToMessageId: "",
      transitionKind: "spawn_started",
      projection: projection({
        status: "running",
        dispatchExecuted: true,
        spawnExecuted: true,
      }),
    }));

    expect(result.sent).toBe(true);
    expect(mockSendIMMessage).toHaveBeenCalledWith(expect.objectContaining({
      replyToMessageId: "1779106347.154489",
      deliveryTargetSource: "inbound_anchor",
    }));
  });

  it("anchors Slack DM spawn_started ACK to the latest user message when OpenClaw omits thread metadata", async () => {
    await mockDelivery();

    const result = await emitExecutionTransitionNotification(notification({
      sessionKey: "agent:main:slack:default:direct:u0al9t5u89z",
      replyToMessageId: "",
      transitionKind: "spawn_started",
      projection: projection({
        status: "running",
        dispatchExecuted: true,
        spawnExecuted: true,
      }),
    }));

    expect(result.sent).toBe(true);
    expect(mockFetchLatestUserMessageTsForSessionKey).toHaveBeenCalledWith(
      "agent:main:slack:default:direct:u0al9t5u89z",
      1200,
    );
    expect(mockSendIMMessage).toHaveBeenCalledWith(expect.objectContaining({
      replyToMessageId: "1779106321.001122",
      deliveryTargetSource: "inbound_anchor",
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

  it("dedupes delivery failure by WorkContract across native and delegate attempts", async () => {
    await mockDelivery();

    const first = await emitExecutionTransitionNotification(notification({
      transitionKind: "delivery_failed",
      attemptId: "native-task-1",
      workContractId: "wc-terminal-1",
      projection: projection({ taskId: "native-task-1", workContractId: "wc-terminal-1" }),
    }));
    const second = await emitExecutionTransitionNotification(notification({
      transitionKind: "delivery_failed",
      attemptId: "delegate-task-1",
      workContractId: "wc-terminal-1",
      projection: projection({ taskId: "native-task-1", workContractId: "wc-terminal-1" }),
    }));

    expect(first.sent).toBe(true);
    expect(second).toEqual(expect.objectContaining({
      skipped: true,
      reason: "skipped_duplicate",
    }));
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

async function mockDelivery(): Promise<{ sendSpy: typeof mockSendIMMessage; replaySpy: ReplaySpy }> {
  const replaySpy = vi.spyOn(
    await import("../../replay/replay.js"),
    "recordPolicyReplay",
  ).mockResolvedValue(undefined);

  return { sendSpy: mockSendIMMessage, replaySpy };
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

function deliveredText(replayPayload: Record<string, unknown>): string {
  return String(replayPayload.ackMessage ?? replayPayload.message ?? replayPayload.text ?? "");
}

function noTranscriptKeys(packet: CompactParentPacket): boolean {
  return Object.keys(packet).every((key) => !key.toLowerCase().includes("transcript"));
}

function expectNotificationResult(result: ExecutionTransitionNotification): void {
  expect(result.transitionKind).toBe("dispatch_materialized");
}
