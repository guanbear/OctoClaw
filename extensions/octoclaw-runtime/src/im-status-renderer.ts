/**
 * IM-specific status panel renderers.
 *
 * The status panel needs to look different in different IM channels:
 *   - Slack:  mrkdwn formatting (*bold*, `code`, emoji) — implemented here
 *   - Feishu: interactive card (card JSON via OpenClaw card send)
 *   - Discord: embed payload
 *   - Telegram: Markdown text + reply markup
 *   - Plain:  existing dense text format for agent context / CLI
 *
 * Architecture note:
 *   The `text` field returned by octoclaw_status is what the agent sends back
 *   to the user. Making it IM-native means no reformatting needed.
 */

export type IMType = "slack" | "feishu" | "discord" | "telegram" | "dingtalk" | "wechat" | "plain";

export function detectIMType(sessionKey: string): IMType {
  const lower = sessionKey.toLowerCase();
  if (lower.includes("slack")) return "slack";
  if (lower.includes("feishu") || lower.includes("lark")) return "feishu";
  if (lower.includes("discord")) return "discord";
  if (lower.includes("telegram")) return "telegram";
  if (lower.includes("dingtalk") || lower.includes("dingding")) return "dingtalk";
  if (lower.includes("wechat") || lower.includes("weixin")) return "wechat";
  return "plain";
}

// ─── Status view type (subset of RuntimeStatusTaskView needed for rendering) ──

export interface StatusTaskSummary {
  taskId: string;
  status: string;
  rawStatus: string;
  title: string;
  summary: string;
  model: string;
  complexityBand: string;
  elapsedText: string;
  delegatedAt: string;
  completedAt: string;
  startedAtDisplay: string;
  completedAtDisplay: string;
  statusReason: string;
  route: string;
}

// ─── Slack mrkdwn renderer ────────────────────────────────────────────────────

const STATUS_EMOJI: Record<string, string> = {
  completed:        "✅",
  failed:           "❌",
  timed_out:        "⏱️",
  running:          "⚙️",
  running_slow:     "⚠️",
  stalled:          "⏸️",
  queued:           "⏳",
  materializing:    "🔄",
  registered:       "📋",
  deliverable_ready:"📬",
  degraded:         "⚠️",
  lost:             "❓",
  canceled:         "🚫",
  blocked:          "🔒",
};

function statusEmoji(status: string): string {
  return STATUS_EMOJI[status] ?? "❓";
}

function slackTaskBlock(task: StatusTaskSummary): string {
  const emoji = statusEmoji(task.status);
  const title = task.title || task.summary || "未命名任务";
  const complexity = task.complexityBand && task.complexityBand !== "unknown" ? ` · ${task.complexityBand}` : "";
  const modelPart = task.model && task.model !== "unknown" ? ` · ${task.model}` : "";
  const elapsed = task.elapsedText && task.elapsedText !== "unknown" ? ` · ${task.elapsedText}` : "";

  const cleanTitle = title.replace(/^[✅⚠️❌]\s*/, "").slice(0, 120);
  const header = `${emoji} *${task.status}* · ${cleanTitle}${complexity}${modelPart}${elapsed}`;

  const timeLine = (() => {
    const isActive = ["running", "running_slow", "stalled", "queued", "materializing", "registered", "blocked"].includes(task.status);
    if (isActive && task.startedAtDisplay) return `\n> ⏱ ${task.startedAtDisplay}`;
    if (isActive && task.delegatedAt) return `\n> ⏱ 委派：${task.delegatedAt}`;
    if (task.completedAtDisplay) return `\n> ⏱ 完成：${task.completedAtDisplay}`;
    return "";
  })();

  const cleanSummary = task.summary
    .replace(/^[✅⚠️❌]\s*/, "")
    .slice(0, 180);

  if (!cleanSummary || cleanSummary === cleanTitle) return `${header}${timeLine}`;
  return `${header}${timeLine}\n> ${cleanSummary}`;
}

export interface SlackStatusOutput {
  /** mrkdwn text to display in Slack */
  text: string;
  /** Instruction for the agent about how to forward this */
  agentInstruction: string;
}

export function buildSlackStatusOutput(
  tasks: StatusTaskSummary[],
  options: {
    totalCount?: number;
    hiddenCount?: number;
    format?: string;
  } = {},
): SlackStatusOutput {
  const visible = tasks.length;
  const total = options.totalCount ?? visible;
  const hidden = options.hiddenCount ?? 0;

  // Group by status for header summary
  const counts: Record<string, number> = {};
  for (const t of tasks) {
    counts[t.status] = (counts[t.status] ?? 0) + 1;
  }
  const countParts = Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([status, n]) => `${statusEmoji(status)} ${n}×${status}`)
    .join("  ");

  const lines: string[] = [];
  lines.push(`🐙 *八爪鱼状态*${visible > 0 ? ` · ${countParts}` : " · 暂无任务"}`);

  if (tasks.length === 0) {
    lines.push("_当前没有活跃或近期任务。_");
  } else {
    for (const task of tasks) {
      lines.push("");
      lines.push(slackTaskBlock(task));
    }
  }

  if (hidden > 0) {
    lines.push("");
    lines.push(`_另有 ${hidden} 个已过期记录被隐藏，使用 \`octoclaw_status format=table\` 查看完整历史。_`);
  }

  if (total > visible && hidden === 0) {
    lines.push("");
    lines.push(`_共 ${total} 条记录，显示前 ${visible} 条。_`);
  }

  return {
    text: lines.join("\n"),
    agentInstruction:
      "Forward the status panel below to the user as-is. Do NOT wrap in a code block or reformat.",
  };
}

export interface PlainTextStatusOutput {
  text: string;
  agentInstruction: string;
}

export function buildPlainTextStatusOutput(
  tasks: StatusTaskSummary[],
  options: {
    totalCount?: number;
    hiddenCount?: number;
  } = {},
): PlainTextStatusOutput {
  const visible = tasks.length;
  const total = options.totalCount ?? visible;
  const lines: string[] = [`OctoClaw Status: ${visible}/${total} task${total === 1 ? "" : "s"}`];

  if (tasks.length === 0) {
    lines.push("No active or recent tasks.");
  } else {
    for (const task of tasks) {
      const title = task.title || task.summary || "untitled task";
      const fields = [
        `status=${task.status}`,
        task.route && task.route !== "unknown" ? `route=${task.route}` : "",
        task.model && task.model !== "unknown" ? `model=${task.model}` : "",
        task.complexityBand && task.complexityBand !== "unknown" ? `complexity=${task.complexityBand}` : "",
        task.elapsedText && task.elapsedText !== "unknown" ? `elapsed=${task.elapsedText}` : "",
      ].filter(Boolean);
      lines.push(`- ${task.taskId.slice(-8)} ${title.slice(0, 100)} (${fields.join(", ")})`);
      if (task.summary && task.summary !== title) lines.push(`  ${task.summary.slice(0, 180)}`);
    }
  }

  if (options.hiddenCount && options.hiddenCount > 0) {
    lines.push(`${options.hiddenCount} expired records hidden. Run octoclawctl status --format table for more detail.`);
  }

  return {
    text: lines.join("\n"),
    agentInstruction:
      "Forward the status panel below to the user as plain text. Do not add claims beyond the shown projection fields.",
  };
}

// ─── Native card/block builders ───────────────────────────────────────────────

export interface FeishuCardElement {
  tag: string;
  [key: string]: unknown;
}

export interface FeishuCard {
  schema: "2.0";
  header: { title: { tag: "plain_text"; content: string }; template: string };
  body: { elements: FeishuCardElement[] };
}

export function buildFeishuStatusCard(
  tasks: StatusTaskSummary[],
): FeishuCard {
  const elements: FeishuCardElement[] = tasks.map((task) => ({
    tag: "markdown",
    content: [
      `**${statusEmoji(task.status)} ${task.status}** \`${task.taskId.slice(-8)}\``,
      task.title ? `标题：${task.title.slice(0, 120)}` : "",
      task.route && task.route !== "reply" && task.route !== "unknown" ? `路由：${task.route}` : "",
      task.complexityBand !== "unknown" ? `复杂度：${task.complexityBand}` : "",
      task.model !== "unknown" ? `模型：${task.model}` : "",
      task.elapsedText !== "unknown" ? `耗时：${task.elapsedText}` : "",
      task.startedAtDisplay && (task.status === "running" || task.status === "queued") ? `启动：${task.startedAtDisplay}` : "",
      task.completedAtDisplay ? `完成：${task.completedAtDisplay}` : "",
      task.summary ? `\n${task.summary.slice(0, 150)}` : "",
    ].filter(Boolean).join(" · "),
  }));

  return {
    schema: "2.0",
    header: {
      title: { tag: "plain_text", content: `🐙 八爪鱼状态 · ${tasks.length} 任务` },
      template: tasks.some((t) => t.status === "failed" || t.status === "timed_out")
        ? "red" : tasks.some((t) => t.status === "running") ? "blue" : "green",
    },
    body: { elements },
  };
}

export interface StatusInteractiveBlockOptions {
  totalCount?: number;
  hiddenCount?: number;
}

function compactTaskLine(task: StatusTaskSummary): string {
  const title = task.title || task.summary || "未命名任务";
  const meta = [
    task.elapsedText && task.elapsedText !== "unknown" ? task.elapsedText : "",
    task.model && task.model !== "unknown" ? task.model : "",
    task.complexityBand && task.complexityBand !== "unknown" ? task.complexityBand : "",
  ].filter(Boolean).join(" · ");
  return `${statusEmoji(task.status)} ${task.status} · ${title.slice(0, 90)}${meta ? ` · ${meta}` : ""}`;
}

function buildSlackStatusBlocks(tasks: StatusTaskSummary[], options: StatusInteractiveBlockOptions): Array<Record<string, unknown>> {
  const total = options.totalCount ?? tasks.length;
  const blocks: Array<Record<string, unknown>> = [
    {
      type: "header",
      text: { type: "plain_text", text: `OctoClaw status · ${tasks.length}/${total}` },
    },
  ];
  if (tasks.length === 0) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "_No active delegated tasks._" } });
  } else {
    for (const task of tasks.slice(0, 8)) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `*${compactTaskLine(task)}*\n${task.summary ? task.summary.slice(0, 160) : ""}`.trim() },
      });
    }
  }
  if (options.hiddenCount && options.hiddenCount > 0) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `${options.hiddenCount} expired records hidden.` }] });
  }
  return blocks;
}

function buildDiscordStatusEmbed(tasks: StatusTaskSummary[], options: StatusInteractiveBlockOptions): Record<string, unknown> {
  const failed = tasks.some((task) => ["failed", "timed_out", "lost", "degraded"].includes(task.status));
  const running = tasks.some((task) => ["running", "running_slow", "queued", "materializing"].includes(task.status));
  return {
    title: `OctoClaw status · ${tasks.length}/${options.totalCount ?? tasks.length}`,
    color: failed ? 0xd92d20 : running ? 0x2e90fa : 0x12b76a,
    fields: tasks.slice(0, 10).map((task) => ({
      name: `${statusEmoji(task.status)} ${task.status} · ${(task.title || task.summary || task.taskId).slice(0, 80)}`,
      value: [
        task.elapsedText && task.elapsedText !== "unknown" ? `elapsed: ${task.elapsedText}` : "",
        task.model && task.model !== "unknown" ? `model: ${task.model}` : "",
        task.summary ? task.summary.slice(0, 180) : "",
      ].filter(Boolean).join("\n") || task.taskId,
      inline: false,
    })),
    footer: options.hiddenCount && options.hiddenCount > 0 ? { text: `${options.hiddenCount} expired records hidden` } : undefined,
  };
}

function buildTelegramReplyMarkup(): Record<string, unknown> {
  return {
    inline_keyboard: [
      [
        { text: "Refresh", callback_data: "octoclaw_status_refresh" },
        { text: "Details", callback_data: "octoclaw_status_table" },
      ],
    ],
  };
}

export function buildStatusInteractiveBlocks(
  imType: IMType,
  tasks: StatusTaskSummary[],
  options: StatusInteractiveBlockOptions = {},
): Array<Record<string, unknown>> {
  if (imType === "slack") {
    return buildSlackStatusBlocks(tasks, options);
  }
  if (imType === "feishu") {
    return [{ type: "feishu_card", card: buildFeishuStatusCard(tasks) }];
  }
  if (imType === "discord") {
    return [{ type: "discord_embed", embed: buildDiscordStatusEmbed(tasks, options) }];
  }
  if (imType === "telegram") {
    return [{
      type: "telegram_reply_markup",
      parse_mode: "Markdown",
      reply_markup: buildTelegramReplyMarkup(),
    }];
  }
  return [];
}
