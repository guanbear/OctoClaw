import { describe, expect, it, vi } from "vitest";
import { TelegramAdapter } from "./telegram-adapter.js";
import * as env from "../../resolve/env.js";

function mockRun(code: number, stdout: string, stderr = "") {
  return vi.spyOn(env, "runCommand").mockResolvedValueOnce({
    code,
    stdout,
    stderr,
    timedOut: false,
  });
}

describe("TelegramAdapter", () => {
  it("declares Telegram as L1", () => {
    expect(new TelegramAdapter().capabilityLevel).toBe("L1");
  });

  it("canHandle matches telegram chat session keys", () => {
    const adapter = new TelegramAdapter();
    expect(adapter.canHandle("telegram:chat:12345")).toBe(true);
    expect(adapter.canHandle("telegram:chat:-10012345:user:789")).toBe(true);
    expect(adapter.canHandle("agent:main:telegram:default:chat:12345")).toBe(true);
    expect(adapter.canHandle("discord:guild:123:channel:456:user:789")).toBe(false);
  });

  it("resolveTarget extracts chat id", () => {
    const adapter = new TelegramAdapter();
    const target = adapter.resolveTarget("telegram:chat:-10012345:user:789");
    expect(target.channel).toBe("telegram");
    expect(target.target).toBe("-10012345");
  });

  it("splits 5000 characters into 2 Telegram messages", async () => {
    const adapter = new TelegramAdapter();
    const spy = vi.spyOn(env, "runCommand")
      .mockResolvedValueOnce({ code: 0, stdout: JSON.stringify({ ok: true, result: { message_id: 11 } }), stderr: "", timedOut: false })
      .mockResolvedValueOnce({ code: 0, stdout: JSON.stringify({ ok: true, result: { message_id: 12 } }), stderr: "", timedOut: false });

    const result = await adapter.send({
      sessionKey: "telegram:chat:12345",
      message: "x".repeat(5000),
    });

    expect(result.sent).toBe(true);
    expect(result.messageId).toBe("12");
    expect(spy).toHaveBeenCalledTimes(2);
    const firstArgs = spy.mock.calls[0]![1] as string[];
    const secondArgs = spy.mock.calls[1]![1] as string[];
    expect(firstArgs[firstArgs.indexOf("--message") + 1]?.length).toBe(4096);
    expect(secondArgs[secondArgs.indexOf("--message") + 1]?.length).toBe(904);
  });

  it("passes replyToMessageId to openclaw CLI", async () => {
    const adapter = new TelegramAdapter();
    const spy = mockRun(0, JSON.stringify({ ok: true, message_id: 12 }));

    await adapter.send({
      sessionKey: "telegram:chat:12345",
      message: "reply",
      replyToMessageId: "11",
    });

    const args = spy.mock.calls[0]![1] as string[];
    expect(args).toEqual(expect.arrayContaining([
      "message", "send",
      "--channel", "telegram",
      "--target", "12345",
      "--reply-to", "11",
      "--json",
      "--message", "reply",
    ]));
  });

  it("send returns CLI error payload on failure", async () => {
    const adapter = new TelegramAdapter();
    mockRun(1, JSON.stringify({ ok: false, description: "chat_not_found" }));

    const result = await adapter.send({
      sessionKey: "telegram:chat:12345",
      message: "hello",
    });

    expect(result.sent).toBe(false);
    expect(result.error).toBe("chat_not_found");
  });

  it("react returns not_supported", async () => {
    const adapter = new TelegramAdapter();
    const result = await adapter.react({
      sessionKey: "telegram:chat:12345",
      messageId: "11",
      emoji: "thumbsup",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("not_supported");
  });
});
