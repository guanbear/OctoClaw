import fsSync from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendToDeliveryOutbox, flushDeliveryOutbox, readDeliveryOutbox } from "./delivery-outbox.js";

const fs = fsSync as unknown as { mkdtempSync(prefix: string): string; readFileSync(pathname: string, encoding: string): string };

function paths(): { dir: string; outboxPath: string; taskStatePath: string } {
  const dir = fs.mkdtempSync(path.join("/tmp", "octoclaw-delivery-outbox-"));
  return {
    dir,
    outboxPath: path.join(dir, ".octoclaw", "delivery-outbox.json"),
    taskStatePath: path.join(dir, "tmp", "octopus", "task-state.json"),
  };
}

describe("delivery outbox", () => {
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
