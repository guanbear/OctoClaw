import { describe, expect, it } from "vitest";
import {
  buildStatusInteractiveBlocks,
  detectIMType,
  type StatusTaskSummary,
} from "./im-status-renderer.js";

const task: StatusTaskSummary = {
  taskId: "task-status-card-1234567890",
  status: "running",
  rawStatus: "running",
  title: "实现状态面板卡片",
  summary: "正在生成 IM 原生卡片",
  model: "codex",
  complexityBand: "medium",
  elapsedText: "2m",
  delegatedAt: "2026-05-14T08:00:00.000Z",
  completedAt: "",
  startedAtDisplay: "2m ago",
  completedAtDisplay: "",
  statusReason: "active",
  route: "delegate",
};

describe("IM status renderer cards", () => {
  it("detects discord and telegram session keys", () => {
    expect(detectIMType("discord:guild:123:channel:456:user:789")).toBe("discord");
    expect(detectIMType("telegram:chat:12345")).toBe("telegram");
  });

  it("builds Feishu card blocks for status panels", () => {
    const blocks = buildStatusInteractiveBlocks("feishu", [task], { totalCount: 1 });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "feishu_card",
      card: {
        schema: "2.0",
        header: { title: { content: expect.stringContaining("八爪鱼状态") } },
      },
    });
  });

  it("builds Discord embed blocks for status panels", () => {
    const blocks = buildStatusInteractiveBlocks("discord", [task], { totalCount: 1 });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "discord_embed",
      embed: {
        title: expect.stringContaining("OctoClaw status"),
        fields: expect.arrayContaining([
          expect.objectContaining({ name: expect.stringContaining("running") }),
        ]),
      },
    });
  });

  it("builds Telegram reply markup blocks for status panels", () => {
    const blocks = buildStatusInteractiveBlocks("telegram", [task], { totalCount: 1 });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "telegram_reply_markup",
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: expect.any(Array),
      },
    });
  });
});
