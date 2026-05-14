import { describe, expect, it, vi } from "vitest";
import { DiscordAdapter } from "./discord-adapter.js";
import * as env from "../../resolve/env.js";

function mockRun(code: number, stdout: string, stderr = "") {
  return vi.spyOn(env, "runCommand").mockResolvedValueOnce({
    code,
    stdout,
    stderr,
    timedOut: false,
  });
}

describe("DiscordAdapter", () => {
  it("declares Discord as L2", () => {
    expect(new DiscordAdapter().capabilityLevel).toBe("L2");
  });

  it("canHandle matches canonical discord session keys", () => {
    const adapter = new DiscordAdapter();
    expect(adapter.canHandle("discord:guild:123:channel:456:user:789")).toBe(true);
    expect(adapter.canHandle("agent:main:discord:default:guild:123:channel:456:user:789")).toBe(true);
    expect(adapter.canHandle("telegram:chat:123")).toBe(false);
  });

  it("resolveTarget extracts channel and optional thread", () => {
    const adapter = new DiscordAdapter();
    const target = adapter.resolveTarget("discord:guild:123:channel:456:user:789:thread:999");
    expect(target.channel).toBe("discord");
    expect(target.target).toBe("456");
    expect(target.threadTs).toBe("999");
  });

  it("splits 2500 characters into 2 Discord messages", async () => {
    const adapter = new DiscordAdapter();
    const spy = vi.spyOn(env, "runCommand")
      .mockResolvedValueOnce({ code: 0, stdout: JSON.stringify({ ok: true, message_id: "m1" }), stderr: "", timedOut: false })
      .mockResolvedValueOnce({ code: 0, stdout: JSON.stringify({ ok: true, message_id: "m2" }), stderr: "", timedOut: false });

    const result = await adapter.send({
      sessionKey: "discord:guild:123:channel:456:user:789",
      message: "x".repeat(2500),
    });

    expect(result.sent).toBe(true);
    expect(result.messageId).toBe("m2");
    expect(spy).toHaveBeenCalledTimes(2);
    const firstArgs = spy.mock.calls[0]![1] as string[];
    const secondArgs = spy.mock.calls[1]![1] as string[];
    expect(firstArgs[firstArgs.indexOf("--message") + 1]?.length).toBe(2000);
    expect(secondArgs[secondArgs.indexOf("--message") + 1]?.length).toBe(500);
  });

  it("sends through openclaw CLI with thread and reply anchors", async () => {
    const adapter = new DiscordAdapter();
    const spy = mockRun(0, JSON.stringify({ ok: true, message_id: "m1" }));

    await adapter.send({
      sessionKey: "discord:guild:123:channel:456:user:789:thread:999",
      message: "hello",
      replyToMessageId: "m0",
    });

    const args = spy.mock.calls[0]![1] as string[];
    expect(args).toEqual(expect.arrayContaining([
      "message", "send",
      "--channel", "discord",
      "--target", "456",
      "--thread", "999",
      "--reply-to", "m0",
      "--json",
      "--message", "hello",
    ]));
  });

  it("send returns CLI error payload on failure", async () => {
    const adapter = new DiscordAdapter();
    mockRun(1, JSON.stringify({ ok: false, error: "channel_not_found" }));

    const result = await adapter.send({
      sessionKey: "discord:guild:123:channel:456:user:789",
      message: "hello",
    });

    expect(result.sent).toBe(false);
    expect(result.error).toBe("channel_not_found");
  });

  it("react delegates emoji reactions to openclaw CLI", async () => {
    const adapter = new DiscordAdapter();
    const spy = mockRun(0, JSON.stringify({ ok: true }));

    const result = await adapter.react({
      sessionKey: "discord:guild:123:channel:456:user:789",
      messageId: "m1",
      emoji: "thumbsup",
    });

    expect(result.ok).toBe(true);
    expect(spy.mock.calls[0]![1]).toEqual([
      "message", "react",
      "--channel", "discord",
      "--message-id", "m1",
      "--emoji", "thumbsup",
      "--json",
    ]);
  });
});
