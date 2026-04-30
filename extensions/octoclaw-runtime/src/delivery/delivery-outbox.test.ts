import fsSync from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendToDeliveryOutbox, flushDeliveryOutbox, readDeliveryOutbox } from "./delivery-outbox.js";

const fs = fsSync as unknown as { mkdtempSync(prefix: string): string; mkdirSync(pathname: string, options?: { recursive?: boolean }): void; readFileSync(pathname: string, encoding: string): string; writeFileSync(pathname: string, data: string, encoding: string): void };

function paths(): { dir: string; outboxPath: string; taskStatePath: string } {
  const dir = fs.mkdtempSync(path.join("/tmp", "octoclaw-delivery-outbox-"));
  return {
    dir,
    outboxPath: path.join(dir, ".octoclaw", "delivery-outbox.json"),
    taskStatePath: path.join(dir, "tmp", "octopus", "task-state.json"),
  };
}

function writeOpenClawSessionRegistry(openclawHome: string, sessionId: string, controlKey: string): void {
  fs.mkdirSync(path.join(openclawHome, "agents", "main", "sessions"), { recursive: true });
  fs.writeFileSync(path.join(openclawHome, "openclaw.json"), "{}", "utf-8");
  fs.writeFileSync(path.join(openclawHome, "agents", "main", "sessions", "sessions.json"), JSON.stringify({
    [controlKey]: {
      sessionId,
      origin: { provider: "slack", surface: "slack", chatType: "direct", to: "user:U123", nativeChannelId: "D123", threadId: "1777556160.478629" },
      deliveryContext: { channel: "slack", to: "user:U123", threadId: "1777556160.478629" },
      updatedAt: 1777557114934,
    },
  }, null, 2), "utf-8");
}

describe("delivery outbox", () => {
  const priorOpenClawHome = process.env.OPENCLAW_HOME;

  afterEach(() => {
    if (priorOpenClawHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = priorOpenClawHome;
  });
  it("appends entries with stable ids and dedupes", () => {
    const { outboxPath } = paths();
    const now = new Date("2026-04-29T00:00:00.000Z");

    const first = appendToDeliveryOutbox({
      workContractId: "wc-1",
      kind: "final_result",
      parentSessionKey: "slack:channel:C123",
      replyToMessageId: "171.1",
      message: "done",
      now,
    }, outboxPath);
    const second = appendToDeliveryOutbox({
      workContractId: "wc-1",
      kind: "final_result",
      parentSessionKey: "slack:channel:C123",
      replyToMessageId: "171.1",
      message: "done",
      now,
    }, outboxPath);

    expect(second.id).toBe(first.id);
    expect(readDeliveryOutbox(outboxPath)).toHaveLength(1);
    expect(readDeliveryOutbox(outboxPath)[0]).toMatchObject({
      workContractId: "wc-1",
      kind: "final_result",
      attempts: 0,
      nextRetryAt: "2026-04-29T00:00:30.000Z",
    });
  });

  it("flushes due entries and updates task-state delivery", async () => {
    const { outboxPath, taskStatePath } = paths();
    appendToDeliveryOutbox({
      workContractId: "wc-2",
      kind: "final_result",
      parentSessionKey: "slack:channel:C123",
      message: "done",
      now: new Date("2026-04-29T00:00:00.000Z"),
    }, outboxPath);

    const result = await flushDeliveryOutbox({
      outboxPath,
      taskStatePath,
      now: new Date("2026-04-29T00:00:31.000Z"),
      sendMessage: async () => ({ sent: true, messageId: "m-1" }),
    });

    expect(result).toMatchObject({ attempted: 1, delivered: 1, remaining: 0 });
    expect(readDeliveryOutbox(outboxPath)).toHaveLength(0);
    const taskState = JSON.parse(fs.readFileSync(taskStatePath, "utf-8"));
    expect(taskState.tasks[0]).toMatchObject({
      workContractId: "wc-2",
      delivery_status: "delivered",
      delivery: { status: "delivered", messageId: "m-1", deliveredAt: "2026-04-29T00:00:31.000Z" },
    });
  });

  it("resolves internal parent session ids before retry delivery", async () => {
    const { dir, outboxPath, taskStatePath } = paths();
    const openclawHome = path.join(dir, "openclaw-home");
    const controlKey = "agent:main:slack:default:direct:u123:thread:1777556160.478629";
    writeOpenClawSessionRegistry(openclawHome, "b36be030-16a2-41f6-aa78-cd3bb6c3a288", controlKey);
    process.env.OPENCLAW_HOME = openclawHome;
    appendToDeliveryOutbox({
      workContractId: "wc-retry-map",
      kind: "final_result",
      parentSessionKey: "b36be030-16a2-41f6-aa78-cd3bb6c3a288",
      message: "done",
      now: new Date("2026-04-29T00:00:00.000Z"),
    }, outboxPath);

    let deliveredSessionKey = "";
    const result = await flushDeliveryOutbox({
      outboxPath,
      taskStatePath,
      now: new Date("2026-04-29T00:00:31.000Z"),
      sendMessage: async ({ sessionKey }) => {
        deliveredSessionKey = sessionKey;
        return { sent: true, messageId: "m-retry-map" };
      },
    });

    expect(result).toMatchObject({ attempted: 1, delivered: 1, remaining: 0 });
    expect(deliveredSessionKey).toBe(controlKey);
  });

  it("keeps failed sends for retry with backoff", async () => {
    const { outboxPath, taskStatePath } = paths();
    appendToDeliveryOutbox({
      workContractId: "wc-3",
      kind: "progress",
      parentSessionKey: "slack:channel:C123",
      message: "started",
      now: new Date("2026-04-29T00:00:00.000Z"),
    }, outboxPath);

    const result = await flushDeliveryOutbox({
      outboxPath,
      taskStatePath,
      now: new Date("2026-04-29T00:00:31.000Z"),
      sendMessage: async () => ({ sent: false, error: "temporary" }),
    });

    expect(result).toMatchObject({ attempted: 1, retryPending: 1, remaining: 1 });
    expect(readDeliveryOutbox(outboxPath)[0]).toMatchObject({ attempts: 1, nextRetryAt: "2026-04-29T00:01:31.000Z", lastError: "temporary" });
    const taskState = JSON.parse(fs.readFileSync(taskStatePath, "utf-8"));
    expect(taskState.tasks[0]).toMatchObject({ workContractId: "wc-3", delivery_status: "retry_pending" });
  });
});
