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

  it("send truncates message to 40000 chars", async () => {
    const adapter = new FeishuAdapter();
    const spy = mockRun(0, JSON.stringify({ ok: true }));
    const longMsg = "x".repeat(50000);
    await adapter.send({
      sessionKey: "agent:main:feishu:default:direct:ou_user1",
      message: longMsg,
    });
    const args = spy.mock.calls[0][1] as string[];
    const msgIndex = args.indexOf("--message");
    expect(args[msgIndex + 1]?.length).toBe(40000);
  });

  it("react returns not_supported (L1 capability)", async () => {
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
