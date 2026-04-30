import { describe, expect, it, vi } from "vitest";
import { WeChatAdapter } from "./wechat-adapter.js";
import * as env from "../../resolve/env.js";

function mockRun(code: number, stdout: string, stderr = "") {
  return vi.spyOn(env, "runCommand").mockResolvedValueOnce({
    code,
    stdout,
    stderr,
    timedOut: false,
  });
}

describe("WeChatAdapter", () => {
  it("declares WeChat as L0", () => {
    expect(new WeChatAdapter().capabilityLevel).toBe("L0");
  });

  it("canHandle matches wechat session keys", () => {
    const adapter = new WeChatAdapter();
    expect(adapter.canHandle("agent:main:wechat:default:direct:wxid_abc")).toBe(true);
    expect(adapter.canHandle("wechat:direct:wxid_xyz")).toBe(true);
    expect(adapter.canHandle("agent:main:slack:default:direct:U123")).toBe(false);
    expect(adapter.canHandle("agent:main:feishu:default:direct:ou_abc")).toBe(false);
  });

  it("resolveTarget extracts wxid_xxx user ID", () => {
    const adapter = new WeChatAdapter();
    const target = adapter.resolveTarget("agent:main:wechat:default:direct:wxid_abc123");
    expect(target.channel).toBe("wechat");
    expect(target.target).toBe("wxid_abc123");
  });

  it("resolveTarget handles 'user' kind in session key (wxid as target)", () => {
    const adapter = new WeChatAdapter();
    const target = adapter.resolveTarget("agent:main:wechat:default:user:wxid_xyz");
    expect(target.target).toBe("wxid_xyz");
  });

  it("resolveTarget returns no threadTs (L0 — no threading)", () => {
    const adapter = new WeChatAdapter();
    const target = adapter.resolveTarget("agent:main:wechat:default:direct:wxid_abc");
    expect(target.threadTs).toBeUndefined();
  });

  it("send succeeds and extracts message_id", async () => {
    const adapter = new WeChatAdapter();
    mockRun(0, JSON.stringify({ ok: true, message_id: "msg_001" }));
    const result = await adapter.send({
      sessionKey: "agent:main:wechat:default:direct:wxid_user1",
      message: "hello",
    });
    expect(result.sent).toBe(true);
    expect(result.delivered).toBe(true);
    expect(result.messageId).toBe("msg_001");
  });

  it("send succeeds with exit code 0 even without JSON payload", async () => {
    const adapter = new WeChatAdapter();
    mockRun(0, "ok");
    const result = await adapter.send({
      sessionKey: "agent:main:wechat:default:direct:wxid_user1",
      message: "hello",
    });
    expect(result.sent).toBe(true);
    expect(result.delivered).toBe(true);
  });

  it("send fails on non-zero exit code", async () => {
    const adapter = new WeChatAdapter();
    mockRun(1, "", "user_not_found");
    const result = await adapter.send({
      sessionKey: "agent:main:wechat:default:direct:wxid_user1",
      message: "hello",
    });
    expect(result.sent).toBe(false);
    expect(result.error).toMatch(/user_not_found/);
  });

  it("send returns error for unresolvable session key", async () => {
    const adapter = new WeChatAdapter();
    const result = await adapter.send({
      sessionKey: "agent:main:slack:default:direct:U123",
      message: "hello",
    });
    expect(result.sent).toBe(false);
    expect(result.error).toBe("unresolvable_session_target");
  });

  it("send ignores replyToMessageId — WeChat has no threading", async () => {
    const adapter = new WeChatAdapter();
    const spy = mockRun(0, JSON.stringify({ ok: true }));
    await adapter.send({
      sessionKey: "agent:main:wechat:default:direct:wxid_user1",
      message: "hello",
      replyToMessageId: "some_parent_id",
    });
    const args = spy.mock.calls[0][1] as string[];
    expect(args).not.toContain("--reply-to");
    expect(args).not.toContain("--thread-id");
  });

  it("send truncates message to 2048 chars (WeChat limit)", async () => {
    const adapter = new WeChatAdapter();
    const spy = mockRun(0, JSON.stringify({ ok: true }));
    const longMsg = "x".repeat(5000);
    await adapter.send({
      sessionKey: "agent:main:wechat:default:direct:wxid_user1",
      message: longMsg,
    });
    const args = spy.mock.calls[0][1] as string[];
    const msgIndex = args.indexOf("--message");
    expect(args[msgIndex + 1]?.length).toBe(2048);
  });

  it("react returns not_supported (L0 capability)", async () => {
    const adapter = new WeChatAdapter();
    const result = await adapter.react({
      sessionKey: "agent:main:wechat:default:direct:wxid_user1",
      messageId: "msg_001",
      emoji: "thumbsup",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("not_supported");
  });

  it("extracts msgid as fallback field name", async () => {
    const adapter = new WeChatAdapter();
    mockRun(0, JSON.stringify({ ok: true, msgid: "wx_msg_abc" }));
    const result = await adapter.send({
      sessionKey: "agent:main:wechat:default:direct:wxid_user1",
      message: "test",
    });
    expect(result.sent).toBe(true);
    expect(result.messageId).toBe("wx_msg_abc");
  });
});
