import { describe, expect, it } from "vitest";
import type { ContextCoverageSnapshot, WorkContract } from "@octoclaw/contracts/work-contract";
import { buildExecutionCoverageLayer } from "./execution-coverage-precheck.js";
import { buildMemoryCoverageLayer } from "./memory-coverage-precheck.js";
import { deliverNativeAnnounceCompletion } from "./native-announce-delivery.js";
import { buildWorkContractFromPolicy, buildWorkDecisionSeal } from "../work-contract/builders.js";

function coverageSnapshot(): ContextCoverageSnapshot {
  const execution = buildExecutionCoverageLayer(["missing"]);
  const memory = buildMemoryCoverageLayer();
  return {
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
    execution,
    memory,
    conflict: false,
    authority: "none",
  };
}

function delegateContract(input: { workContractId?: string; sessionKey: string }): WorkContract {
  const contract = buildWorkContractFromPolicy(
    input.sessionKey,
    "Review current changes",
    "delegated_work",
    coverageSnapshot(),
    buildWorkDecisionSeal("local_judge", "delegate", ["needs_execution"]),
    { status: "sealed" },
  );
  return input.workContractId
    ? { ...contract, workContractId: input.workContractId }
    : contract;
}

describe("native announce delivery anchors", () => {
  it("does not use a stale DM policy-state anchor from a different work contract", async () => {
    const sentMessages: Array<{ replyToMessageId?: string }> = [];
    const parentKey = "agent:main:slack:default:direct:u0al9t5u89z";
    const contract = delegateContract({ workContractId: "wc-original", sessionKey: parentKey });

    const result = await deliverNativeAnnounceCompletion({
      contract,
      completion: {
        sourceSessionKey: "agent:main:subagent:child",
        sourceSessionId: "child-session",
        sourceTool: "subagent_announce",
        status: "completed successfully",
        resultText: "Review completed.",
        resultHash: "hash-original",
      },
      state: {
        workContractId: "wc-later-message",
        work_contract_id: "wc-later-message",
        deliveryTarget: {
          replyToMessageId: "1780384318.416829",
          threadTs: "1780384318.416829",
          immutable: true,
        },
        inboundMessageTs: "1780384318.416829",
      },
      ctx: { sessionKey: parentKey, channelId: "slack" },
      sendMessage: async (params) => {
        sentMessages.push(params);
        return { sent: true, messageId: "1780384390.308789", threadTs: params.replyToMessageId };
      },
      resolveReplyToMessageId: async () => {
        throw new Error("latest DM history must not be used for a stale work contract");
      },
    });

    expect(result.sent).toBe(true);
    expect(result.replyToMessageId).toBe("");
    expect(sentMessages[0]?.replyToMessageId).toBeUndefined();
  });

  it("does not trust mutable DM policy-state anchors without an explicit work contract match", async () => {
    const sentMessages: Array<{ replyToMessageId?: string }> = [];
    const parentKey = "agent:main:slack:default:direct:u0al9t5u89z";
    const contract = delegateContract({ workContractId: "wc-original", sessionKey: parentKey });

    const result = await deliverNativeAnnounceCompletion({
      contract,
      completion: {
        sourceSessionKey: "agent:main:subagent:child",
        sourceSessionId: "child-session",
        sourceTool: "subagent_announce",
        status: "completed successfully",
        resultText: "Review completed.",
        resultHash: "hash-original",
      },
      state: {
        deliveryTarget: {
          replyToMessageId: "1780384318.416829",
          threadTs: "1780384318.416829",
          immutable: true,
        },
        inboundMessageTs: "1780384318.416829",
      },
      ctx: { sessionKey: parentKey, channelId: "slack" },
      sendMessage: async (params) => {
        sentMessages.push(params);
        return { sent: true, messageId: "1780384390.308789", threadTs: params.replyToMessageId };
      },
      resolveReplyToMessageId: async () => {
        throw new Error("latest DM history must not be used when mutable state has an unbound anchor");
      },
    });

    expect(result.sent).toBe(true);
    expect(result.replyToMessageId).toBe("");
    expect(sentMessages[0]?.replyToMessageId).toBeUndefined();
  });
});
