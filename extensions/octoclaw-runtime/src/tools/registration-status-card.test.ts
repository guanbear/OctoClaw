import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSendIMMessage } = vi.hoisted(() => ({
  mockSendIMMessage: vi.fn(),
}));
const { mockRecordPolicyReplay } = vi.hoisted(() => ({
  mockRecordPolicyReplay: vi.fn(),
}));

vi.mock("../im/send.js", () => ({
  sendIMMessage: mockSendIMMessage,
}));

vi.mock("../replay/replay.js", () => ({
  recordPolicyReplay: mockRecordPolicyReplay,
}));

import { deliverStatusPanelToIM, getToolRegistrations, statusToolResponse } from "./registration.js";

beforeEach(() => {
  mockSendIMMessage.mockReset();
  mockRecordPolicyReplay.mockReset();
  mockRecordPolicyReplay.mockResolvedValue(undefined);
});

describe("statusToolResponse native IM cards", () => {
  it("returns native card metadata and unwrapped fallback text", () => {
    const interactiveBlocks = [
      {
        type: "discord_embed",
        embed: { title: "OctoClaw status" },
      },
    ];

    const response = statusToolResponse("OctoClaw status (anchors)", "anchors", "discord", interactiveBlocks);

    expect(response.text).toContain("Return it to the user as-is");
    expect(response.text).not.toContain("```text");
    expect(response.json).toMatchObject({
      format: "anchors",
      im_native_card: true,
      interactive_blocks: interactiveBlocks,
    });
  });

  it("RSC-STATUS-001: directly delivers IM status panels without relying on model copy", async () => {
    mockSendIMMessage.mockResolvedValue({
      sent: true,
      messageId: "1779347730.652849",
      transport: "slack_api",
      targetSource: "inbound_anchor",
    });

    const result = await deliverStatusPanelToIM({
      rawOutput: "任务 task-1\n状态 running\n模型 zhipu/GLM-5.1\n耗时 12s\n结果 pending",
      imType: "slack",
      sessionKey: "slack:C123:U456:1779347730.652849",
      replyToMessageId: "1779347730.652849",
      cwd: "/tmp/octoclaw-status-test",
    });

    expect(result.delivered).toBe(true);
    expect(mockSendIMMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: "slack:C123:U456:1779347730.652849",
      message: expect.stringContaining("任务 task-1"),
      replyToMessageId: "1779347730.652849",
      deliveryKind: "status_reply",
      deliveryTargetSource: "inbound_anchor",
      footerMode: "off",
      suppressProjectionFooter: true,
    }));
  });

  it("RSC-STATUS-002: direct status delivery failure falls back to model-visible output", async () => {
    mockSendIMMessage.mockResolvedValue({
      sent: false,
      error: "channel_not_found",
    });

    const result = await deliverStatusPanelToIM({
      rawOutput: "任务 task-1\n状态 running\n模型 zhipu/GLM-5.1\n耗时 12s\n结果 pending",
      imType: "slack",
      sessionKey: "slack:C123:U456:1779347730.652849",
      replyToMessageId: "1779347730.652849",
      cwd: "/tmp/octoclaw-status-test",
    });

    expect(result.delivered).toBe(false);
    expect(result.fallbackResponse.text).toContain("Return it to the user as-is");
    expect(result.fallbackResponse.text).toContain("任务 task-1");
    expect(result.error).toBe("channel_not_found");
  });

  it("RSC-STATUS-003: plain status panels do not attempt IM delivery", async () => {
    const result = await deliverStatusPanelToIM({
      rawOutput: "plain status",
      imType: "plain",
      sessionKey: "",
      replyToMessageId: "",
      cwd: "/tmp/octoclaw-status-test",
    });

    expect(result.delivered).toBe(false);
    expect(result.skipped).toBe("non_im_session");
    expect(mockSendIMMessage).not.toHaveBeenCalled();
  });

  it("RSC-STATUS-001: octoclaw_status directly delivers panels for IM sessions", async () => {
    mockSendIMMessage.mockResolvedValue({
      sent: true,
      messageId: "1779347730.652849",
      transport: "slack_api",
      targetSource: "inbound_anchor",
    });
    const statusTool = getToolRegistrations().find((registration) => registration.name === "octoclaw_status");
    if (!statusTool) throw new Error("octoclaw_status tool not registered");

    const response = await statusTool.execute({ format: "anchors" }, {
      sessionKey: "slack:C123:U456:1779347730.652849",
      thread_ts: "1779347730.652849",
      cwd: "/tmp/octoclaw-status-test",
    });

    expect(mockSendIMMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: "slack:C123:U456:1779347730.652849",
      replyToMessageId: "1779347730.652849",
      deliveryKind: "status_reply",
      footerMode: "off",
    }));
    expect(response.json).toMatchObject({
      direct_delivered: true,
      transport: "slack_api",
      target_source: "inbound_anchor",
    });
    expect(mockRecordPolicyReplay).toHaveBeenCalledWith(
      "status_panel_direct_delivery",
      expect.objectContaining({
        sent: true,
        imType: "slack",
        transport: "slack_api",
        targetSource: "inbound_anchor",
      }),
      expect.anything(),
      null,
    );
  });
});
