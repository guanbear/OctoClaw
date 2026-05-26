import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkContract } from "@octoclaw/contracts/work-contract";
import { envOverrides } from "./env.js";
import { createDeliveryOutbox } from "./delivery-outbox.js";
import { handleNativeAnnounceCompletion } from "./native-announce.js";
import { saveWorkContract } from "../work-contract/store.js";

describe("handleNativeAnnounceCompletion delivery outbox", () => {
  const previousWorkspaceRoot = envOverrides.workspaceRoot;

  afterEach(() => {
    envOverrides.workspaceRoot = previousWorkspaceRoot;
  });

  it("persists a matched result before delivery when direct delivery is pending", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "octoclaw-native-announce-"));
    envOverrides.workspaceRoot = workspace;
    const childSessionKey = "agent:main:subagent:child";
    const parentSessionKey = "agent:main:slack:default:direct:user:thread:1";
    const contract = minimalWorkContract({
      workContractId: "wc-1",
      childSessionKey,
      parentSessionKey,
      runId: "run-1",
    });
    expect(saveWorkContract(contract)).toBe(true);
    const outbox = createDeliveryOutbox();

    const result = await handleNativeAnnounceCompletion({
      event: {
        provenance: {
          kind: "inter_session",
          sourceSessionKey: childSessionKey,
          sourceTool: "subagent_announce",
        },
      },
      ctx: { sessionKey: parentSessionKey, sessionId: "parent-session" },
      prompt: [
        "sourceTool=subagent_announce",
        `sourceSession=${childSessionKey}`,
        "status: completed successfully",
        "<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>",
        "完成：key 有效。",
        "<<<END_UNTRUSTED_CHILD_RESULT>>>",
      ].join("\n"),
      pluginConfig: { nativeAnnounceDirectDelivery: false },
      deliveryOutbox: outbox,
    });

    expect(result?.matched).toBe(true);
    expect(result?.delivered).toBe(false);
    expect(outbox.listPending()).toMatchObject([{
      taskId: "run-1",
      runId: "run-1",
      childSessionKey,
      requesterSessionKey: parentSessionKey,
      workContractId: "wc-1",
      resultText: "完成：key 有效。",
      status: "pending",
    }]);
  });
});

function minimalWorkContract(input: {
  workContractId: string;
  childSessionKey: string;
  parentSessionKey: string;
  runId: string;
}): WorkContract {
  const now = "2026-05-26T05:40:44.000Z";
  return ({
    workContractId: input.workContractId,
    route: "delegate",
    intentClass: "delegated_work",
    status: "running",
    sessionKey: input.parentSessionKey,
    turnId: "turn-1",
    userAsk: "check key",
    createdAt: now,
    updatedAt: now,
    decision: { source: "local_judge", route: "delegate", reasonCodes: [], sealedAt: now },
    reply: { replyMode: "status_summary", grounding: "control_plane_status", allowedTools: [], forbiddenTools: [], evidenceRefs: [] },
    delegate: {
      delegateTaskId: "delegate-1",
      currentAttemptId: "attempt-1",
      role: "research",
      coordinationMode: "single_agent",
      acceptanceCriteria: [],
      scope: { read: [], write: [], workspaceMode: "read_only", scopeFingerprint: "scope-1" },
      modelProfile: "worker_research",
      nativeBinding: {
        flowId: "flow-1",
        runId: input.runId,
        childRunId: input.runId,
        childSessionKey: input.childSessionKey,
        status: "running",
        mutation: "runTask",
        currentStep: "running",
      },
      childSessions: [],
      artifactRefs: [],
      nextAction: "wait",
    },
    nativeSpawnRefs: {
      openclawRunId: input.runId,
      openclawTaskId: input.runId,
      childSessionKey: input.childSessionKey,
      requesterSessionKey: input.parentSessionKey,
      spawnIntentId: "spawn-1",
      spawnBackend: "sessions_spawn_planner",
      spawnMode: "run",
    },
    continuity: {
      preferredChildSessionKey: input.childSessionKey,
      preferredRunId: input.runId,
    },
    mainContext: {
      summary: "check key",
      statusLine: "running",
      nextAction: "wait",
      visibleIds: {
        childSessionKey: input.childSessionKey,
        openclawRunId: input.runId,
        spawnIntentId: "spawn-1",
      },
    },
    telemetry: {
      childSessionKey: input.childSessionKey,
      childRunId: input.runId,
    },
  } as unknown) as WorkContract;
}
