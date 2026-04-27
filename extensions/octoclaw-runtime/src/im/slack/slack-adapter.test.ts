import { describe, expect, it, vi } from "vitest";

type MockRunCommand = (command: string, args: string[], options: unknown) => Promise<{ code: number; stdout: string; stderr: string }>;

let mockRunCommand = vi.hoisted<MockRunCommand>(() => async () => ({ code: 0, stdout: "", stderr: "" }));
vi.mock("../../resolve/env.js", () => ({
  runCommand: (...args: unknown[]) => mockRunCommand(...(args as [string, string[], unknown])),
  resolveWorkspaceRoot: () => "/workspace",
}));

import {
  SlackAdapter,
  auditSlackFacingToolExposure,
  isSlackTargetAllowed,
} from "./slack-adapter.js";

describe("SlackAdapter", () => {
  it("resolveTarget parses Slack channel+thread session keys", () => {
    const adapter = new SlackAdapter();

    expect(adapter.resolveTarget("slack:default:channel:C123abc:thread:171.22")).toEqual({
      channel: "slack",
      target: "C123ABC",
      threadTs: "171.22",
    });
  });

  it("resolveTarget parses Slack DM session keys", () => {
    const adapter = new SlackAdapter();

    expect(adapter.resolveTarget("agent:main:slack:default:dm:u123abc")).toEqual({
      channel: "slack",
      target: "U123ABC",
    });
  });

  it("resolveTarget returns empty target for non-Slack keys", () => {
    const adapter = new SlackAdapter();

    expect(adapter.resolveTarget("agent:main:main")).toEqual({
      channel: "slack",
      target: "",
    });
  });

  it("normalizeUserId strips user: prefix and uppercases", () => {
    const adapter = new SlackAdapter();

    expect(adapter.normalizeUserId("user:u123abc")).toBe("U123ABC");
  });

  it("extractMessageTs reads ts/messageTs/messageId", () => {
    const adapter = new SlackAdapter();

    expect(adapter.extractMessageTs({ ts: "111.222" })).toBe("111.222");
    expect(adapter.extractMessageTs({ messageTs: "333.444" })).toBe("333.444");
    expect(adapter.extractMessageTs({ messageId: "555.666" })).toBe("555.666");
  });

  it("treats stdout ok as delivered even when stderr logs make command nonzero", async () => {
    const adapter = new SlackAdapter();
    mockRunCommand = async () => ({
      code: 1,
      stdout: JSON.stringify({ ok: true, ts: "1700000000.000200", thread_ts: "1700000000.000100" }),
      stderr: "[octoclaw-judge] noisy stderr",
    });

    const result = await adapter.send({
      sessionKey: "agent:main:slack:channel:C123abc",
      message: "ack",
      replyToMessageId: "1700000000.000100",
    });

    expect(result).toEqual({
      sent: true,
      delivered: true,
      messageId: "1700000000.000200",
      threadTs: "1700000000.000100",
    });
  });

  it("shouldUseThread respects replyToMode config", () => {
    expect(new SlackAdapter({ replyToMode: "off" }).shouldUseThread()).toBe(false);
    expect(new SlackAdapter({ replyToMode: "first" }).shouldUseThread()).toBe(true);
    expect(new SlackAdapter({ replyToMode: "all" }).shouldUseThread()).toBe(true);
  });

  it("isStreamingAvailable checks nativeTransport and streamingMode", () => {
    expect(new SlackAdapter({ nativeTransport: true, streamingMode: "partial" }).isStreamingAvailable()).toBe(true);
    expect(new SlackAdapter({ nativeTransport: false, streamingMode: "partial" }).isStreamingAvailable()).toBe(false);
    expect(new SlackAdapter({ nativeTransport: true, streamingMode: "off" }).isStreamingAvailable()).toBe(false);
  });
});

describe("Slack adapter acceptance", () => {
  it("enforces groupPolicy allowlist for Slack channel/group delivery", () => {
    expect(isSlackTargetAllowed("slack:default:dm:U123", { allowDms: true })).toBe(true);
    expect(isSlackTargetAllowed("slack:default:dm:U123", { allowDms: false })).toBe(false);
    expect(isSlackTargetAllowed("slack:default:channel:C_ALLOWED", { allowlist: ["C_ALLOWED"] })).toBe(true);
    expect(isSlackTargetAllowed("slack:default:channel:C_BLOCKED", { allowlist: ["C_ALLOWED"] })).toBe(false);
  });

  it("audits Slack-facing tool exposure to safe message operations only", () => {
    expect(auditSlackFacingToolExposure(["message.send", "message.react"])).toEqual({
      allowed: true,
      exposedTools: ["message.send", "message.react"],
      blockedTools: [],
    });
    expect(auditSlackFacingToolExposure(["message.send", "shell.exec"])).toEqual({
      allowed: false,
      exposedTools: ["message.send", "shell.exec"],
      blockedTools: ["shell.exec"],
    });
  });
});
