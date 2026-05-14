import { input } from "@inquirer/prompts";
import type { WizardState } from "../wizard-state.js";
import type { WizardOpts } from "../wizard-opts.js";

export async function runStepImToken(state: WizardState, opts: WizardOpts): Promise<void> {
  if (opts.nonInteractive) return;

  for (const channel of state.imChannels) {
    if (channel === "slack") {
      const botToken = await input({ message: "Slack Bot Token (xoxb-)" });
      if (botToken && !botToken.startsWith("xoxb-")) {
        console.warn(opts.lang === "zh" ? "⚠️ Slack Bot Token 通常以 xoxb- 开头。" : "⚠️ Slack Bot Token usually starts with xoxb-.");
      }
      const appToken = await input({ message: "Slack App Token (xapp-, optional)" });
      state.imTokens.slack = compact({ botToken, appToken });
    }
    if (channel === "feishu") {
      const appId = await input({ message: opts.lang === "zh" ? "飞书 App ID" : "Feishu App ID" });
      const appSecret = await input({ message: opts.lang === "zh" ? "飞书 App Secret" : "Feishu App Secret" });
      state.imTokens.feishu = compact({ appId, appSecret });
    }
    if (channel === "discord") {
      const botToken = await input({ message: "Discord Bot Token" });
      const applicationId = await input({ message: "Discord Application ID" });
      state.imTokens.discord = compact({ botToken, applicationId });
    }
    if (channel === "telegram") {
      const botToken = await input({ message: "Telegram Bot Token" });
      state.imTokens.telegram = compact({ botToken });
    }
    if (channel === "wechat") {
      const appId = await input({ message: opts.lang === "zh" ? "微信 App ID" : "WeChat App ID" });
      const appSecret = await input({ message: opts.lang === "zh" ? "微信 App Secret" : "WeChat App Secret" });
      state.imTokens.wechat = compact({ appId, appSecret });
    }
  }
}

function compact(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim().length > 0));
}
