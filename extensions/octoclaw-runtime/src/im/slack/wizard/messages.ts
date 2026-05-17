import { encodeWizardButtonId } from "./buttons.js";
import type { RouterWizardState, RouterWizardMessage } from "./flow.js";

type Lang = "zh" | "en";

function button(text: string, step: 1 | 2 | 3 | 4 | 5 | 6 | 7, value: string): Record<string, unknown> {
  return {
    type: "button",
    text: { type: "plain_text", text },
    action_id: encodeWizardButtonId(step, value),
    value,
  };
}

function actions(elements: Record<string, unknown>[]): Array<Record<string, unknown>> {
  return [{ type: "actions", elements }];
}

function truncateButtonText(text: string): string {
  return text.length <= 72 ? text : `${text.slice(0, 69)}...`;
}

function currentModel(state: RouterWizardState): string {
  return state.remainingModels[0] ?? state.configuredModels[0] ?? "(none)";
}

function modelPlanProgress(state: RouterWizardState): string {
  const total = Math.max(state.configuredModels.length, 1);
  const current = Math.min(state.configuredModels.length - state.remainingModels.length + 1, total);
  return `${current}/${total}`;
}

function budgetSummary(state: RouterWizardState): string {
  if (!state.answers.budget) return "不设上限";
  return `$${state.answers.budget.monthlyUsd ?? 0}/月`;
}

export function renderWizardMessage(state: RouterWizardState, options: { lang?: Lang } = {}): RouterWizardMessage {
  const lang = options.lang ?? "zh";
  if (state.step === "step-1-greeting") {
    const list = state.configuredModels.map((model) => ` • \`${model}\``).join("\n") || " • (none)";
    const text = lang === "en"
      ? `OctoClaw configuration wizard\nI found ${state.configuredModels.length} configured models:\n${list}\nEach step can be skipped and resumed with /octoclaw wizard.`
      : `OctoClaw 配置向导\n我从你的 OpenClaw 配置里看到 ${state.configuredModels.length} 个模型：\n${list}\n我会一步步问你怎么用它们。每一步都可以跳过，之后用 \`/octoclaw wizard\` 接着配。`;
    return {
      text,
      blocks: actions([
        button(lang === "en" ? "Start" : "开始 ->", 1, "start"),
        button(lang === "en" ? "CLI mode" : "换 CLI 模式", 1, "cli"),
        button(lang === "en" ? "Cancel" : "取消", 1, "cancel"),
      ]),
    };
  }
  if (state.step === "step-2-models") {
    const model = currentModel(state);
    const progress = modelPlanProgress(state);
    const remainingCount = state.remainingModels.length;
    const allRemainingButtons = remainingCount > 1
      ? [
          button(lang === "en" ? "All remaining: subscription" : "剩余全部订阅", 2, "all_remaining:subscription"),
          button(lang === "en" ? "All remaining: pay-as-you-go" : "剩余全部按量", 2, "all_remaining:pay_as_you_go"),
          button(lang === "en" ? "All remaining: not sure" : "剩余全部不确定", 2, "all_remaining:unknown"),
        ]
      : [];
    return {
      text: lang === "en"
        ? `Plan type ${progress}\nIs \`${model}\` billed as subscription or pay-as-you-go?`
        : `Plan 类型 ${progress}\n\`${model}\` 是按订阅计费还是按用量计费？订阅 / 套餐内请选择订阅。`,
      blocks: actions([
        button(lang === "en" ? "Subscription" : "订阅 / 套餐", 2, "subscription"),
        button(lang === "en" ? "Pay as you go" : "按量付费", 2, "pay_as_you_go"),
        button(lang === "en" ? "Not sure" : "不确定", 2, "unknown"),
        ...allRemainingButtons,
        button(lang === "en" ? "Skip" : "跳过", 2, "skip"),
      ]),
    };
  }
  if (state.step === "step-3-budget") {
    return {
      text: lang === "en" ? "What is your total monthly budget limit in USD?" : "你这个月的总预算上限是多少（美元）？",
      blocks: actions(["<20", "20-100", "100-500", "500+", "unlimited", "skip"].map((value) => button(value, 3, value))),
    };
  }
  if (state.step === "step-4-privacy") {
    return {
      text: lang === "en" ? "Can child tasks use cloud models?" : "子任务能不能用云端模型？",
      blocks: actions([
        button(lang === "en" ? "All cloud OK" : "都可以", 4, "cloud_ok"),
        button(lang === "en" ? "Local only" : "只能本地 / on-prem", 4, "local_only"),
        button(lang === "en" ? "Let me choose" : "我来挑", 4, "pick"),
        button(lang === "en" ? "Skip" : "跳过", 4, "skip"),
      ]),
    };
  }
  if (state.step === "step-5-restricted-models") {
    const models = state.configuredModels.map((model) => ` • \`${model}\``).join("\n") || " • (none)";
    const restricted = new Set(state.answers.restrictedModels);
    const selected = state.answers.restrictedModels.map((model) => ` • \`${model}\``).join("\n") || " • 无";
    const modelButtons = state.configuredModels.slice(0, 20).map((model) => {
      const label = restricted.has(model)
        ? lang === "en" ? `Allow ${model}` : `取消 ${model}`
        : lang === "en" ? `Disable ${model}` : `禁用 ${model}`;
      return button(truncateButtonText(label), 5, `toggle:${model}`);
    });
    return {
      text: lang === "en"
        ? `Which models must be disabled?\nCurrent selection:\n${selected}\nModels:\n${models}`
        : `哪些模型必须禁用？（合规 / 测试隔离）\n当前选择：\n${selected}\n当前模型：\n${models}`,
      blocks: actions([
        ...modelButtons,
        button(lang === "en" ? "Done" : "完成", 5, "done"),
        button(lang === "en" ? "Clear all" : "确认无禁用", 5, "clear"),
        button(lang === "en" ? "Skip" : "跳过", 5, "skip"),
      ]),
    };
  }
  if (state.step === "step-6-same-provider") {
    const candidates = state.sameProviderCandidates.map((model) => ` • \`${model}\``).join("\n") || " • (none)";
    const candidateButtons = state.sameProviderCandidates.slice(0, 20).map((model) => {
      const label = lang === "en" ? `Only ${model}` : `只加 ${model}`;
      return button(truncateButtonText(label), 6, `only:${model}`);
    });
    return {
      text: lang === "en"
        ? `Same-provider shadow candidates:\n${candidates}\nAdd them as shadow candidates?`
        : `我在你已经配置的供应商下面发现了：\n${candidates}\n加进 shadow 候选？（不会影响 live 路由）`,
      blocks: actions([
        button(lang === "en" ? "Add all" : "全部加", 6, "all"),
        ...candidateButtons,
        button(lang === "en" ? "Skip" : "跳过", 6, "skip"),
      ]),
    };
  }
  return {
    text: lang === "en"
      ? `Configuration complete\nModels: ${state.configuredModels.length} configured + ${state.answers.sameProviderCandidates.length} shadow proposal\nBudget: ${budgetSummary(state)}\nPrivacy: ${state.answers.privacy ?? "standard"}\nRestricted: ${state.answers.restrictedModels.join(", ") || "none"}`
      : `配置完成\n • 模型: ${state.configuredModels.length} 个 configured + ${state.answers.sameProviderCandidates.length} 个 shadow proposal\n • 预算: ${budgetSummary(state)}\n • 隐私: ${state.answers.privacy === "local_only" ? "只能本地" : "都可以"}\n • 禁用: ${state.answers.restrictedModels.join(", ") || "无"}\n之后用 \`/octoclaw wizard\` 调整，或 \`octoclawctl router wizard --incremental\` 加新模型。`,
  };
}
