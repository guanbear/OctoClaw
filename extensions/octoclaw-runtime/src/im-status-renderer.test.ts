import { describe, expect, it } from "vitest";
import {
  buildPlainTextStatusOutput,
  buildStatusInteractiveBlocks,
  buildFeishuStatusCard,
  detectIMType,
  type StatusTaskSummary,
  type FeishuCard,
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

  it("MOF-019: Feishu status card is non-streaming and returns feishu_card type", () => {
    const card = buildFeishuStatusCard([task]) as FeishuCard;
    expect(card.schema).toBe("2.0");
    expect(card.header.title.content).toContain("八爪鱼状态");
    expect(card.body.elements.length).toBe(1);
    expect(card.body.elements[0].tag).toBe("markdown");
  });

  it("MOF-019: Feishu status card header turns red on failure", () => {
    const failedTask: StatusTaskSummary = { ...task, status: "failed", rawStatus: "failed" };
    const card = buildFeishuStatusCard([failedTask]) as FeishuCard;
    expect(card.header.template).toBe("red");
  });

  it("MOF-019: Feishu status card header turns blue on running", () => {
    const card = buildFeishuStatusCard([task]) as FeishuCard;
    expect(card.header.template).toBe("blue");
  });

  it("MOF-019: Feishu status card header turns green when all completed", () => {
    const completedTask: StatusTaskSummary = { ...task, status: "completed", rawStatus: "completed" };
    const card = buildFeishuStatusCard([completedTask]) as FeishuCard;
    expect(card.header.template).toBe("green");
  });

  it("MOF-019: Feishu status interactive blocks use feishu_card type (no streaming)", () => {
    const blocks = buildStatusInteractiveBlocks("feishu", [task], { totalCount: 1 });
    expect(blocks.every((b) => b.type === "feishu_card")).toBe(true);
  });

  it("Feishu status card text fallback works", () => {
    const blocks = buildStatusInteractiveBlocks("feishu", [task], { totalCount: 1, hiddenCount: 5 });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "feishu_card" });
  });

  it("MOF-014: Feishu status card shows state, route, and model without inventing truth", () => {
    const card = buildFeishuStatusCard([task]) as FeishuCard;
    const content = String(card.body.elements[0].content);
    expect(content).toContain("running");
    expect(content).toContain("路由：delegate");
    expect(content).toContain("模型：codex");

    const minimalTask: StatusTaskSummary = {
      ...task,
      status: "queued",
      rawStatus: "queued",
      model: "unknown",
      complexityBand: "unknown",
      elapsedText: "unknown",
      route: "",
      summary: "",
      title: "",
    };
    const minimalCard = buildFeishuStatusCard([minimalTask]) as FeishuCard;
    const minimalContent = String(minimalCard.body.elements[0].content);
    expect(minimalContent).toContain("queued");
    expect(minimalContent).not.toContain("running");
    expect(minimalContent).not.toContain("模型：");
  });

  it("MOF-014: Feishu status card suppresses reply route noise", () => {
    const replyTask: StatusTaskSummary = { ...task, route: "reply" };
    const card = buildFeishuStatusCard([replyTask]) as FeishuCard;
    expect(String(card.body.elements[0].content)).not.toContain("路由：reply");
  });

  it("MOF-015: plain text fallback preserves status semantics", () => {
    const output = buildPlainTextStatusOutput([task], { totalCount: 1 });
    expect(output.text).toContain("OctoClaw Status");
    expect(output.text).toContain("status=running");
    expect(output.text).toContain("route=delegate");
    expect(output.text).toContain("model=codex");
    expect(output.text).toContain(task.title);
    expect(output.text).not.toContain("*");
    expect(output.agentInstruction).toContain("plain text");
  });

  it("MOF-015: plain text fallback handles empty task list and plain blocks", () => {
    const output = buildPlainTextStatusOutput([]);
    expect(output.text).toContain("0 tasks");
    expect(output.text).toContain("No active or recent tasks");
    expect(buildStatusInteractiveBlocks("plain", [task], { totalCount: 1 })).toEqual([]);
  });
});
