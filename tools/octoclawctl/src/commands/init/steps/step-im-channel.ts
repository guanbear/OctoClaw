import { checkbox } from "@inquirer/prompts";
import type { WizardState } from "../wizard-state.js";
import type { WizardOpts } from "../wizard-opts.js";

type ImChannel = WizardState["imChannels"][number];
type ChannelChoice = ImChannel | "skip";

export async function runStepImChannel(state: WizardState, opts: WizardOpts): Promise<void> {
  if (opts.nonInteractive) {
    state.imChannels = [];
    return;
  }

  const selected = await checkbox<ChannelChoice>({
    message: opts.lang === "zh" ? "选择 IM 通知渠道" : "Choose IM notification channels",
    choices: [
      { value: "slack", name: "Slack" },
      { value: "feishu", name: opts.lang === "zh" ? "飞书" : "Feishu" },
      { value: "discord", name: "Discord" },
      { value: "telegram", name: "Telegram" },
      { value: "wechat", name: opts.lang === "zh" ? "微信" : "WeChat" },
      { value: "skip", name: opts.lang === "zh" ? "跳过" : "Skip" },
    ],
  });

  state.imChannels = selected.includes("skip")
    ? []
    : selected.filter((channel): channel is ImChannel => channel !== "skip");
}
