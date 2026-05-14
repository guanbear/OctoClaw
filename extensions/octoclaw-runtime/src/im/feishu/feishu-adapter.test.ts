import { describe, expect, it, vi } from "vitest";
import { FeishuAdapter } from "./feishu-adapter.js";
import * as env from "../../resolve/env.js";

function mockRun(code: number, stdout: string, stderr = "") {
  return vi.spyOn(env, "runCommand").mockResolvedValueOnce({
    code,
    stdout,
    stderr,
    timedOut: false,
  });
}

describe("FeishuAdapter", () => {
  it("declares Feishu as L2", () => {
    expect(new FeishuAdapter().capabilityLevel).toBe("L2");
  });

  it("canHandle matches feishu session keys", () => {
    const adapter = new FeishuAdapter();
    expect(adapter.canHandle("agent:main:feishu:default:direct:ou_abc123")).toBe(true);
    expect(adapter.canHandle("feishu:direct:ou_abc")).toBe(true);
    expect(adapter.canHandle("agent:main:slack:default:direct:U123")).toBe(false);
    expect(adapter.canHandle("agent:main:wechat:default:direct:wxid_abc")).toBe(false);
  });

  it("resolveTarget extracts ou_xxx user ID", () => {
    const adapter = new FeishuAdapter();
    const target = adapter.resolveTarget("agent:main:feishu:default:direct:ou_abc123");
    expect(target.channel).toBe("feishu");
    expect(target.target).toBe("ou_abc123");
  });

  it("resolveTarget does NOT uppercase feishu user IDs", () => {
    const adapter = new FeishuAdapter();
    const target = adapter.resolveTarget("agent:main:feishu:default:direct:ou_AbCdEf");
    expect(target.target).toBe("ou_AbCdEf"); // case preserved
  });

  it("resolveTarget handles 'user' kind in session key (ou_xxx as target)", () => {
    const adapter = new FeishuAdapter();
    const target = adapter.resolveTarget("agent:main:feishu:default:user:ou_xyz");
    expect(target.target).toBe("ou_xyz");
  });

  it("send succeeds and extracts message_id from JSON response", async () => {
    const adapter = new FeishuAdapter();
    mockRun(0, JSON.stringify({ ok: true, message_id: "om_abc123", root_id: "om_root" }));
    const result = await adapter.send({
      sessionKey: "agent:main:feishu:default:direct:ou_user1",
      message: "hello",
    });
    expect(result.sent).toBe(true);
    expect(result.delivered).toBe(true);
    expect(result.messageId).toBe("om_abc123");
    expect(result.threadTs).toBe("om_root");
  });

  it("send succeeds with exit code 0 even without JSON payload", async () => {
    const adapter = new FeishuAdapter();
    mockRun(0, "ok");
    const result = await adapter.send({
      sessionKey: "agent:main:feishu:default:direct:ou_user1",
      message: "hello",
    });
    expect(result.sent).toBe(true);
    expect(result.delivered).toBe(true);
  });

  it("send fails on non-zero exit code", async () => {
    const adapter = new FeishuAdapter();
    mockRun(1, "", "channel_not_found");
    const result = await adapter.send({
      sessionKey: "agent:main:feishu:default:direct:ou_user1",
      message: "hello",
    });
    expect(result.sent).toBe(false);
    expect(result.error).toMatch(/channel_not_found/);
  });

  it("send returns error for unresolvable session key", async () => {
    const adapter = new FeishuAdapter();
    const result = await adapter.send({
      sessionKey: "agent:main:slack:default:direct:U123", // wrong channel
      message: "hello",
    });
    expect(result.sent).toBe(false);
    expect(result.error).toBe("unresolvable_session_target");
  });

  it("send passes --reply-to when replyToMessageId provided and replyToMode is 'first'", async () => {
    const adapter = new FeishuAdapter({ replyToMode: "first" });
    const spy = mockRun(0, JSON.stringify({ ok: true, message_id: "om_new" }));
    await adapter.send({
      sessionKey: "agent:main:feishu:default:direct:ou_user1",
      message: "reply msg",
      replyToMessageId: "om_root123",
    });
    const args = spy.mock.calls[0][1] as string[];
    expect(args).toContain("--reply-to");
    expect(args).toContain("om_root123");
  });

  it("send does NOT pass --reply-to when replyToMode is 'off'", async () => {
    const adapter = new FeishuAdapter({ replyToMode: "off" });
    const spy = mockRun(0, JSON.stringify({ ok: true, message_id: "om_new" }));
    await adapter.send({
      sessionKey: "agent:main:feishu:default:direct:ou_user1",
      message: "hello",
      replyToMessageId: "om_root123",
    });
    const args = spy.mock.calls[0][1] as string[];
    expect(args).not.toContain("--reply-to");
  });

  it("splits 5000 characters into 2 Feishu messages", async () => {
    const adapter = new FeishuAdapter();
    const spy = vi.spyOn(env, "runCommand")
      .mockResolvedValueOnce({ code: 0, stdout: JSON.stringify({ ok: true, message_id: "om_1" }), stderr: "", timedOut: false })
      .mockResolvedValueOnce({ code: 0, stdout: JSON.stringify({ ok: true, message_id: "om_2" }), stderr: "", timedOut: false });

    const result = await adapter.send({
      sessionKey: "agent:main:feishu:default:direct:ou_user1",
      message: "x".repeat(5000),
    });

    expect(result.sent).toBe(true);
    expect(result.messageId).toBe("om_2");
    expect(spy).toHaveBeenCalledTimes(2);
    const firstArgs = spy.mock.calls[0]![1] as string[];
    const secondArgs = spy.mock.calls[1]![1] as string[];
    expect(firstArgs[firstArgs.indexOf("--message") + 1]?.length).toBeLessThanOrEqual(4000);
    expect(secondArgs[secondArgs.indexOf("--message") + 1]?.length).toBeLessThanOrEqual(4000);
    expect(firstArgs[firstArgs.indexOf("--message") + 1]).toContain("(1/2)");
    expect(secondArgs[secondArgs.indexOf("--message") + 1]).toContain("(2/2)");
  });

  it("returns IM_SEND_FAILED when any Feishu segment fails", async () => {
    const adapter = new FeishuAdapter();
    vi.spyOn(env, "runCommand")
      .mockResolvedValueOnce({ code: 0, stdout: JSON.stringify({ ok: true, message_id: "om_1" }), stderr: "", timedOut: false })
      .mockResolvedValueOnce({ code: 1, stdout: JSON.stringify({ ok: false, error: "rate_limited" }), stderr: "", timedOut: false });

    const result = await adapter.send({
      sessionKey: "agent:main:feishu:default:direct:ou_user1",
      message: "x".repeat(5000),
    });

    expect(result.sent).toBe(false);
    expect(result.error).toBe("IM_SEND_FAILED");
  });

  it("sends image and file attachments after text", async () => {
    const adapter = new FeishuAdapter();
    const spy = vi.spyOn(env, "runCommand")
      .mockResolvedValueOnce({ code: 0, stdout: JSON.stringify({ ok: true, message_id: "om_text" }), stderr: "", timedOut: false })
      .mockResolvedValueOnce({ code: 0, stdout: JSON.stringify({ ok: true, message_id: "om_image" }), stderr: "", timedOut: false })
      .mockResolvedValueOnce({ code: 0, stdout: JSON.stringify({ ok: true, message_id: "om_file" }), stderr: "", timedOut: false });

    const result = await adapter.send({
      sessionKey: "agent:main:feishu:default:direct:ou_user1",
      message: "see attached",
      interactiveBlocks: [
        { type: "image", url: "https://example.com/image.png" },
        { type: "file", url: "https://example.com/report.pdf", name: "report.pdf" },
      ],
    });

    expect(result.sent).toBe(true);
    expect(result.messageId).toBe("om_file");
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls[1]![1]).toEqual(expect.arrayContaining([
      "message", "send",
      "--channel", "feishu",
      "--target", "ou_user1",
      "--type", "image",
      "--url", "https://example.com/image.png",
      "--json",
    ]));
    expect(spy.mock.calls[2]![1]).toEqual(expect.arrayContaining([
      "message", "send",
      "--channel", "feishu",
      "--target", "ou_user1",
      "--type", "file",
      "--url", "https://example.com/report.pdf",
      "--name", "report.pdf",
      "--json",
    ]));
  });

  it("sends Feishu card blocks as card messages", async () => {
    const adapter = new FeishuAdapter();
    const spy = vi.spyOn(env, "runCommand")
      .mockResolvedValueOnce({ code: 0, stdout: JSON.stringify({ ok: true, message_id: "om_card" }), stderr: "", timedOut: false });

    const card = {
      schema: "2.0",
      header: { title: { tag: "plain_text", content: "status" }, template: "blue" },
      body: { elements: [{ tag: "markdown", content: "running" }] },
    };
    const result = await adapter.send({
      sessionKey: "agent:main:feishu:default:direct:ou_user1",
      message: "status fallback",
      interactiveBlocks: [{ type: "feishu_card", card }],
    });

    expect(result.sent).toBe(true);
    const args = spy.mock.calls[0]![1] as string[];
    expect(args).toEqual(expect.arrayContaining([
      "message", "send",
      "--channel", "feishu",
      "--target", "ou_user1",
      "--type", "card",
      "--card", JSON.stringify(card),
      "--json",
    ]));
    expect(args).not.toContain("--message");
  });

  it("react returns not_supported (L2 without emoji reactions)", async () => {
    const adapter = new FeishuAdapter();
    const result = await adapter.react({
      sessionKey: "agent:main:feishu:default:direct:ou_user1",
      messageId: "om_abc",
      emoji: "thumbsup",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("not_supported");
  });

  it("shouldUseThread returns false by default", () => {
    const adapter = new FeishuAdapter();
    expect(adapter.shouldUseThread()).toBe(false);
  });

  it("shouldUseThread returns true when replyToMode is 'all'", () => {
    const adapter = new FeishuAdapter({ replyToMode: "all" });
    expect(adapter.shouldUseThread()).toBe(true);
  });
});
