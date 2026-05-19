import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { WizardState } from "../wizard-state.js";
import type { WizardOpts } from "../wizard-opts.js";

declare const process: { version: string };

export async function runStepDoctorVerify(state: WizardState, opts: WizardOpts): Promise<string[]> {
  const results: WizardState["doctorResults"] = [];
  const lines: string[] = [];

  add(results, lines, "OpenClaw", "pass", state.openclawVersion
    ? (opts.lang === "zh" ? `${state.openclawVersion} — OK` : `${state.openclawVersion} — OK`)
    : (opts.lang === "zh" ? "未检测" : "not detected"));
  add(results, lines, "Node.js", "pass", `${process.version} — OK`);

  const configDir = path.basename(opts.openclawHome) === ".octoclaw"
    ? opts.openclawHome
    : path.join(path.dirname(opts.openclawHome), ".octoclaw");
  try {
    await fs.mkdir(configDir, { recursive: true });
    const descriptor = fsSync.openSync(path.join(configDir, ".octoclaw-write-test"), "w");
    fsSync.closeSync(descriptor);
    await fs.rm(path.join(configDir, ".octoclaw-write-test"), { force: true });
    add(results, lines, "Config", "pass", opts.lang === "zh" ? "配置目录可写" : "config directory is writable");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    add(results, lines, "Config", "fail", opts.lang === "zh" ? `配置目录不可写：${message}` : `config directory is not writable: ${message}`);
  }

  if (state.judgeModel) {
    add(results, lines, "Judge", "pass", opts.lang === "zh" ? `${judgeLabel(state)} — 已配置` : `${judgeLabel(state)} — configured`);
  } else {
    add(results, lines, "Judge", "warn", opts.lang === "zh" ? "未配置（可稍后配置）" : "not configured (configure later)");
  }

  for (const channel of ["slack", "feishu", "discord", "telegram", "wechat"] as const) {
    if (!state.imChannels.includes(channel)) continue;
    const configured = Object.keys(state.imTokens[channel] ?? {}).length > 0;
    add(results, lines, `${channelLabel(channel, opts.lang)} token`, configured ? "pass" : "warn", configured
      ? (opts.lang === "zh" ? "已配置" : "configured")
      : (opts.lang === "zh" ? "未配置（可稍后配置）" : "not configured (configure later)"));
  }

  state.doctorResults = results;
  lines.push("");
  lines.push(opts.lang === "zh"
    ? "初始化完成。运行 octoclawctl deploy 部署到 OpenClaw。"
    : "Initialization complete. Run octoclawctl deploy to deploy to OpenClaw.");
  return lines;
}

function add(results: WizardState["doctorResults"], lines: string[], name: string, status: "pass" | "warn" | "fail", message: string): void {
  results.push({ name, status, message });
  const icon = status === "pass" ? "✅" : status === "warn" ? "⚠️" : "❌";
  lines.push(`${icon} ${name}: ${message}`);
}

function judgeLabel(state: WizardState): string {
  if (!state.judgeModel) return "Judge";
  if (state.judgeModel.type === "ollama-qwen3") return "Ollama Qwen3 0.6B";
  if (state.judgeModel.type === "remote-groq") return "Groq";
  if (state.judgeModel.type === "remote-gpt-5-4-mini") return "gpt-5.4-mini (remote)";
  return state.judgeModel.modelId || state.judgeModel.type;
}

function channelLabel(channel: WizardState["imChannels"][number], lang: WizardOpts["lang"]): string {
  if (channel === "feishu") return lang === "zh" ? "飞书" : "Feishu";
  if (channel === "wechat") return lang === "zh" ? "微信" : "WeChat";
  return channel[0].toUpperCase() + channel.slice(1);
}
