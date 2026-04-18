import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeRuntimeRequest } from "./index.js";

describe("normalizeRuntimeRequest", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("produces all required fields for a normal request", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-18T10:00:00.000Z"));

    const request = normalizeRuntimeRequest({
      prompt: "  Build   runtime   tests  ",
      sessionKey: "session-1",
      channel: "slack",
      requestId: "req-1",
      taskId: "task-1",
      flowId: "flow-1",
      idempotencyKey: "idem-1",
      workspaceMode: "shared_workspace",
      readScope: [{ resource: "repo", access: "read" }],
      writeScope: [{ resource: "tmp", access: "write" }],
      writeScopeSummary: "  tmp writes only  ",
      metadata: { source: "test" },
    });

    expect(request).toEqual({
      schemaVersion: "octoclaw.contracts/v1",
      kind: "truth",
      createdAt: "2026-04-18T10:00:00.000Z",
      requestId: "req-1",
      taskId: "task-1",
      flowId: "flow-1",
      sessionKey: "session-1",
      channel: "slack",
      prompt: "Build runtime tests",
      idempotencyKey: "idem-1",
      scope: {
        workspaceMode: "shared_workspace",
        readScope: [{ resource: "repo", access: "read" }],
        writeScope: [{ resource: "tmp", access: "write" }],
        writeScopeSummary: "tmp writes only",
      },
      metadata: { source: "test" },
      ack: {
        required: true,
        mode: "pre_dispatch",
        ackKey: "req-1:ack",
        reason: "independent_ack_required",
      },
    });
  });

  it("throws when prompt is empty or nullish", () => {
    expect(() => normalizeRuntimeRequest({ prompt: "   " })).toThrow("runtime_request_prompt_missing");
    expect(() => normalizeRuntimeRequest({ prompt: null as never })).toThrow("runtime_request_prompt_missing");
  });

  it("defaults session key, channel, scope, ack requirement, and metadata", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-18T10:01:00.000Z"));

    const request = normalizeRuntimeRequest({ prompt: "hello runtime" });

    expect(request.sessionKey).toBe("session-anonymous");
    expect(request.channel).toBe("direct");
    expect(request.scope).toEqual({
      workspaceMode: "isolated_workspace",
      readScope: [],
      writeScope: [],
      writeScopeSummary: "",
    });
    expect(request.metadata).toEqual({});
    expect(request.ack.required).toBe(true);
    expect(request.ack.mode).toBe("pre_dispatch");
    expect(request.ack.ackKey).toBe(`${request.requestId}:ack`);
  });

  it("copies metadata instead of reusing input references", () => {
    const metadata = { nested: { keep: true }, tag: "origin" };
    const request = normalizeRuntimeRequest({
      prompt: "metadata handling",
      metadata,
    });

    expect(request.metadata).toEqual(metadata);
    expect(request.metadata).not.toBe(metadata);
  });

  it("is deterministic for the same input at the same time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-18T10:02:00.000Z"));

    const input = {
      prompt: "Same input same output",
      sessionKey: "session-stable",
      metadata: { a: 1 },
    };

    const first = normalizeRuntimeRequest(input);
    const second = normalizeRuntimeRequest(input);

    expect(second).toEqual(first);
  });
});
