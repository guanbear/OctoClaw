import { describe, expect, it } from "vitest";
import { THREAD_BINDING_SCHEMA_VERSION, type ThreadBinding } from "./thread-binding.js";

describe("thread binding contract", () => {
  it("carries requester and thread identity", () => {
    const now = new Date("2026-04-24T00:00:00.000Z").toISOString();
    const binding: ThreadBinding = {
      schemaVersion: THREAD_BINDING_SCHEMA_VERSION,
      threadBindingKey: "binding-1",
      requesterSessionKey: "session-1",
      requesterOrigin: { surface: "slack" },
      surfaceAnchorId: "anchor-1",
      channel: "C123",
      threadId: "1745452800.000000",
      createdAt: now,
      updatedAt: now,
    };

    expect(binding.schemaVersion).toBe("octoclaw.thread_binding.v1");
    expect(binding.requesterSessionKey).toBe("session-1");
    expect(binding.channel).toBe("C123");
  });
});
