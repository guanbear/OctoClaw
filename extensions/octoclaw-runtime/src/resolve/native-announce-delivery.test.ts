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

    expect(result.sent).toBe(false);
    expect(result.error).toBe("native_announce_missing_inbound_anchor");
    expect(result.replyToMessageId).toBe("");
    expect(sentMessages).toHaveLength(0);
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

    expect(result.sent).toBe(false);
    expect(result.error).toBe("native_announce_missing_inbound_anchor");
    expect(result.replyToMessageId).toBe("");
    expect(sentMessages).toHaveLength(0);
  });

  it("does not resolve a latest Slack DM anchor when the contract has no frozen delivery target", async () => {
    const sentMessages: Array<{ replyToMessageId?: string }> = [];
    const parentKey = "agent:main:slack:default:direct:u0al9t5u89z";
    const contract = delegateContract({ workContractId: "wc-no-frozen-target", sessionKey: parentKey });
    let latestLookupCalled = false;

    const result = await deliverNativeAnnounceCompletion({
      contract,
      completion: {
        sourceSessionKey: "agent:main:subagent:child",
        sourceSessionId: "child-session",
        sourceTool: "subagent_announce",
        status: "completed successfully",
        resultText: "Review completed.",
        resultHash: "hash-no-frozen-target",
      },
      state: {},
      ctx: { sessionKey: parentKey, channelId: "slack" },
      sendMessage: async (params) => {
        sentMessages.push(params);
        return { sent: true, messageId: "1780384390.308789", threadTs: params.replyToMessageId };
      },
      resolveReplyToMessageId: async () => {
        latestLookupCalled = true;
        return "1780384318.416829";
      },
    });

    expect(latestLookupCalled).toBe(false);
    expect(result.sent).toBe(false);
    expect(result.error).toBe("native_announce_missing_inbound_anchor");
    expect(result.replyToMessageId).toBe("");
    expect(sentMessages).toHaveLength(0);
  });

  it("uses the frozen delivery target session for delegated Slack completions", async () => {
    const sentMessages: Array<{ sessionKey: string; replyToMessageId?: string }> = [];
    const frozenSlackKey = "agent:main:slack:default:direct:u0al9t5u89z";
    const parentRunKey = "e0966c86-14c6-4923-98f7-e1167b40b852";
    const contract = {
      ...delegateContract({ workContractId: "wc-frozen-target", sessionKey: parentRunKey }),
      deliveryTarget: {
        surface: "slack",
        sessionKey: frozenSlackKey,
        replyToMessageId: "1780466905.694059",
        threadTs: "1780466905.694059",
        immutable: true,
      },
    };

    const result = await deliverNativeAnnounceCompletion({
      contract,
      completion: {
        sourceSessionKey: "agent:main:subagent:child",
        sourceSessionId: "child-session",
        sourceTool: "subagent_announce",
        status: "completed successfully",
        resultText: "Review completed.",
        resultHash: "hash-frozen-target",
      },
      state: {
        workContractId: "wc-frozen-target",
        work_contract_id: "wc-frozen-target",
      },
      ctx: { sessionKey: parentRunKey, channelId: "slack" },
      sendMessage: async (params) => {
        sentMessages.push(params);
        return { sent: true, messageId: "1780467000.000001", threadTs: params.replyToMessageId };
      },
    });

    expect(result.sent).toBe(true);
    expect(result.sessionKey).toBe(frozenSlackKey);
    expect(result.replyToMessageId).toBe("1780466905.694059");
    expect(sentMessages[0]).toMatchObject({
      sessionKey: frozenSlackKey,
      replyToMessageId: "1780466905.694059",
    });
  });
});
