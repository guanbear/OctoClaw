import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createWizardConfig,
  detectPlanType,
  loadPackagedModelIntelSnapshot,
  loadSnapshotFromText,
  type ModelIntelLite,
} from "@octoclaw/router";
import { sendIMMessage, type SendIMResult } from "./im/send.js";
import type { LoggerLike } from "./extension-entry-shared.js";
import { stringValue } from "./extension-entry-shared.js";
import { asRecord, type UnknownRecord } from "./util/type-coercion.js";

const ROUTER_WIZARD_SCHEMA = "octoclaw.router_wizard/v1";
const ROUTER_ONBOARDING_SCHEMA = "octoclaw.router_wizard_onboarding/v1";
const QUESTION_ACTION = "octoclaw_router_wizard_start_questions";
const START_ACTION = "octoclaw_router_wizard_use_defaults";
const REMIND_ACTION = "octoclaw_router_wizard_remind_later";
const SKIP_ACTION = "octoclaw_router_wizard_skip";
const CONFIRM_ACTION = "octoclaw_router_wizard_confirm";

type RouterWizardStep =
  | "model_scan"
  | "plan"
  | "budget"
  | "budget_custom"
  | "privacy"
  | "language"
  | "restricted_models"
  | "restricted_models_text"
  | "same_provider"
  | "confirm";
type RouterWizardAction =
  | "start_questions"
  | "use_defaults"
  | "remind_later"
  | "skip"
  | "model_scan_continue"
  | "plan_confirm"
  | "plan_all_subscription"
  | "plan_all_pay_as_you_go"
  | "plan_subscription"
  | "plan_pay_as_you_go"
  | "plan_unknown"
  | "privacy_standard"
  | "privacy_local_only"
  | "privacy_custom"
  | "budget_none"
  | "budget_50"
  | "budget_100"
  | "budget_200"
  | "budget_custom"
  | "budget_text"
  | "restricted_none"
  | "restricted_text"
  | "restricted_models_text"
  | "language_auto"
  | "language_zh"
  | "language_en"
  | "same_provider_import"
  | "same_provider_skip"
  | "same_provider_add"
  | "same_provider_skip_one"
  | "same_provider_import_all"
  | "confirm";

interface RouterWizardAnswers {
  privacy?: "standard" | "local_only";
  language?: "auto" | "zh" | "en";
  monthlyBudget?: number;
  restrictedModels?: string[];
  modelPlanTypes?: Record<string, "subscription" | "pay_as_you_go" | "unknown">;
  sameProviderModels?: string[];
  sameProviderReviewed?: string[];
}

interface RouterWizardActiveSession {
  sessionKey: string;
  step: RouterWizardStep;
  startedAt: string;
  updatedAt: string;
  answers: RouterWizardAnswers;
}

export interface RouterWizardOnboardingState {
  schemaVersion: typeof ROUTER_ONBOARDING_SCHEMA;
  prompted: Record<string, { sentAt: string; messageId?: string; replyToMessageId?: string }>;
  active?: RouterWizardActiveSession;
  completedAt?: string;
  skippedAt?: string;
  remindAfter?: string;
}

export type RouterWizardOnboardingSendMessage = (params: {
  sessionKey: string;
  message: string;
  interactiveBlocks?: Array<Record<string, unknown>>;
  replyToMessageId?: string;
  timeoutMs?: number;
  cwd?: string;
  suppressProjectionFooter?: boolean;
  deliveryKind?: "router_wizard_onboarding" | "status_reply";
  deliveryTargetSource?: "inbound_anchor" | "session_fallback";
  footerMode?: "off";
}) => Promise<SendIMResult>;

export function resolveOpenclawHome(openclawHome = ""): string {
  return stringValue(openclawHome || process.env.OPENCLAW_HOME) || path.join(os.homedir(), ".openclaw");
}

export function routerWizardConfigPath(openclawHome = ""): string {
  return path.join(resolveOpenclawHome(openclawHome), "octoclaw", "router-wizard.json");
}

export function routerWizardOnboardingStatePath(openclawHome = ""): string {
  return path.join(resolveOpenclawHome(openclawHome), "octoclaw", "router-wizard-onboarding.json");
}

export function isRouterWizardComplete(openclawHome = ""): boolean {
  try {
    const raw = JSON.parse(fsSync.readFileSync(routerWizardConfigPath(openclawHome), "utf8")) as UnknownRecord;
    const models = asRecord(raw.models);
    if (raw.schemaVersion !== ROUTER_WIZARD_SCHEMA || Object.keys(models).length === 0) return false;
    const configuredModels = discoverConfiguredRouterModels(openclawHome);
    return configuredModels.length === 0 || configuredModels.every((model) => models[model] !== undefined);
  } catch {
    return false;
  }
}

export function buildRouterWizardOnboardingMessage(): string {
  return [
    "OctoClaw Auto Router 还没完成首次配置。",
    "可以逐步配置，也可以直接使用默认设置；主 agent 模型不会被自动切换，子 agent 才会按 judge 和结构化信号自动选型。",
    "也可以之后手动运行：`octoclawctl router wizard --incremental`。",
  ].join("\n");
}

export function buildRouterWizardSlackBlocks(): Array<Record<string, unknown>> {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*OctoClaw Auto Router 首次配置*\n可以逐步回答几个问题，也可以用当前 OpenClaw 模型生成默认配置。主 agent 不会被静默切换。",
      },
    },
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: "配置只写入本机 `~/.openclaw/octoclaw/router-wizard.json`。" },
      ],
    },
    {
      type: "actions",
      block_id: "octoclaw_router_wizard_onboarding",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "开始配置" },
          style: "primary",
          action_id: QUESTION_ACTION,
          value: "start_questions",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "启用默认设置" },
          action_id: START_ACTION,
          value: "use_defaults",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "稍后提醒" },
          action_id: REMIND_ACTION,
          value: "remind_later",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "不再提醒" },
          action_id: SKIP_ACTION,
          value: "skip",
        },
      ],
    },
  ];
}

function emptyOnboardingState(): RouterWizardOnboardingState {
  return { schemaVersion: ROUTER_ONBOARDING_SCHEMA, prompted: {} };
}

async function readOnboardingState(openclawHome = ""): Promise<RouterWizardOnboardingState> {
  try {
    const raw = JSON.parse(fsSync.readFileSync(routerWizardOnboardingStatePath(openclawHome), "utf8")) as UnknownRecord;
    if (raw.schemaVersion !== ROUTER_ONBOARDING_SCHEMA) return emptyOnboardingState();
    return {
      schemaVersion: ROUTER_ONBOARDING_SCHEMA,
      prompted: asRecord(raw.prompted) as RouterWizardOnboardingState["prompted"],
      active: normalizeActiveSession(raw.active),
      completedAt: stringValue(raw.completedAt) || undefined,
      skippedAt: stringValue(raw.skippedAt) || undefined,
      remindAfter: stringValue(raw.remindAfter) || undefined,
    };
  } catch {
    return emptyOnboardingState();
  }
}

async function writeOnboardingState(openclawHome: string, state: RouterWizardOnboardingState): Promise<void> {
  const filePath = routerWizardOnboardingStatePath(openclawHome);
  fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
  fsSync.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function onboardingSessionKey(sessionKey: string): string {
  return stringValue(sessionKey).toLowerCase();
}

function shouldPrompt(state: RouterWizardOnboardingState, sessionKey: string, now: Date): boolean {
  if (state.completedAt || state.skippedAt) return false;
  if (state.remindAfter && Date.parse(state.remindAfter) > now.getTime()) return false;
  return !state.prompted[onboardingSessionKey(sessionKey)];
}

function normalizeActiveSession(value: unknown): RouterWizardActiveSession | undefined {
  const record = asRecord(value);
  const step = stringValue(record.step) as RouterWizardStep;
  if (!["model_scan", "plan", "budget", "budget_custom", "privacy", "language", "restricted_models", "restricted_models_text", "same_provider", "confirm"].includes(step)) return undefined;
  const answers = asRecord(record.answers);
  const monthlyBudget = Number(answers.monthlyBudget);
  const rawPlanTypes = asRecord(answers.modelPlanTypes);
  return {
    sessionKey: stringValue(record.sessionKey),
    step,
    startedAt: stringValue(record.startedAt),
    updatedAt: stringValue(record.updatedAt),
    answers: {
      privacy: answers.privacy === "local_only" ? "local_only" : answers.privacy === "standard" ? "standard" : undefined,
      language: answers.language === "zh" || answers.language === "en" || answers.language === "auto" ? answers.language : undefined,
      ...(Number.isFinite(monthlyBudget) ? { monthlyBudget } : {}),
      restrictedModels: Array.isArray(answers.restrictedModels) ? answers.restrictedModels.map(stringValue).filter(Boolean) : undefined,
      modelPlanTypes: Object.fromEntries(Object.entries(rawPlanTypes)
        .map(([model, planType]) => [model, planType === "subscription" || planType === "pay_as_you_go" || planType === "unknown" ? planType : "unknown"])),
      sameProviderModels: Array.isArray(answers.sameProviderModels) ? answers.sameProviderModels.map(stringValue).filter(Boolean) : undefined,
      sameProviderReviewed: Array.isArray(answers.sameProviderReviewed) ? answers.sameProviderReviewed.map(stringValue).filter(Boolean) : undefined,
    },
  };
}

export async function maybeSendRouterWizardOnboarding(input: {
  sessionKey: string;
  replyToMessageId?: string;
  openclawHome?: string;
  cwd?: string;
  now?: Date;
  sendMessage?: RouterWizardOnboardingSendMessage;
  logger?: LoggerLike;
}): Promise<{ sent: boolean; reason?: string; messageId?: string }> {
  const sessionKey = stringValue(input.sessionKey);
  if ((process.env.VITEST || process.env.VITEST_WORKER_ID) && !input.sendMessage) return { sent: false, reason: "test_env" };
  if (!/(?:^|:)slack:/u.test(sessionKey.toLowerCase())) return { sent: false, reason: "not_slack" };
  const openclawHome = resolveOpenclawHome(input.openclawHome);
  if (isRouterWizardComplete(openclawHome)) return { sent: false, reason: "wizard_complete" };
  const now = input.now ?? new Date();
  const state = await readOnboardingState(openclawHome);
  if (!shouldPrompt(state, sessionKey, now)) return { sent: false, reason: "already_prompted" };

  const sendMessage = input.sendMessage ?? ((params) => sendIMMessage(params));
  const result = await sendMessage({
    sessionKey,
    message: buildRouterWizardOnboardingMessage(),
    interactiveBlocks: buildRouterWizardSlackBlocks(),
    replyToMessageId: stringValue(input.replyToMessageId) || undefined,
    timeoutMs: 5000,
    cwd: input.cwd,
    suppressProjectionFooter: true,
    deliveryKind: "router_wizard_onboarding",
    deliveryTargetSource: input.replyToMessageId ? "inbound_anchor" : "session_fallback",
    footerMode: "off",
  });
  if (result.sent) {
    state.prompted[onboardingSessionKey(sessionKey)] = {
      sentAt: now.toISOString(),
      ...(result.messageId ? { messageId: result.messageId } : {}),
      ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
    };
    await writeOnboardingState(openclawHome, state);
  } else {
    input.logger?.warn?.(`octoclaw router wizard onboarding send failed: ${result.error || "unknown"}`);
  }
  return { sent: result.sent, messageId: result.messageId, reason: result.error };
}

function collectActionCandidates(value: unknown, depth = 0): UnknownRecord[] {
  if (!value || typeof value !== "object" || depth > 5) return [];
  const record = asRecord(value);
  const actions = Array.isArray(record.actions) ? record.actions.map(asRecord) : [];
  return [
    ("action_id" in record || "actionId" in record) ? record : {},
    ...actions,
    ...Object.values(record).flatMap((entry) => Array.isArray(entry)
      ? entry.flatMap((item) => collectActionCandidates(item, depth + 1))
      : collectActionCandidates(entry, depth + 1)),
  ].filter((entry) => Object.keys(entry).length > 0);
}

export function extractRouterWizardAction(event: unknown): RouterWizardAction | null {
  return extractRouterWizardActionDetails(event)?.action ?? null;
}

function extractRouterWizardActionDetails(event: unknown): { action: RouterWizardAction; value: string } | null {
  for (const action of collectActionCandidates(event)) {
    const actionId = stringValue(action.action_id || action.actionId);
    const value = stringValue(action.value);
    if (actionId === QUESTION_ACTION || value === "start_questions") return { action: "start_questions", value };
    if (actionId === START_ACTION || value === "use_defaults") return { action: "use_defaults", value };
    if (actionId === REMIND_ACTION || value === "remind_later") return { action: "remind_later", value };
    if (actionId === SKIP_ACTION || value === "skip") return { action: "skip", value };
    if (actionId === "octoclaw_router_wizard_model_scan_continue" || value === "model_scan_continue") return { action: "model_scan_continue", value };
    if (actionId === "octoclaw_router_wizard_plan_confirm" || value === "plan_confirm") return { action: "plan_confirm", value };
    if (actionId === "octoclaw_router_wizard_plan_all_subscription" || value === "plan_all_subscription") return { action: "plan_all_subscription", value };
    if (actionId === "octoclaw_router_wizard_plan_all_pay_as_you_go" || value === "plan_all_pay_as_you_go") return { action: "plan_all_pay_as_you_go", value };
    if (actionId === "octoclaw_router_wizard_plan_subscription" || value.startsWith("plan_subscription:")) return { action: "plan_subscription", value };
    if (actionId === "octoclaw_router_wizard_plan_pay_as_you_go" || value.startsWith("plan_pay_as_you_go:")) return { action: "plan_pay_as_you_go", value };
    if (actionId === "octoclaw_router_wizard_plan_unknown" || value.startsWith("plan_unknown:")) return { action: "plan_unknown", value };
    if (actionId === "octoclaw_router_wizard_privacy_standard" || value === "privacy_standard") return { action: "privacy_standard", value };
    if (actionId === "octoclaw_router_wizard_privacy_local_only" || value === "privacy_local_only") return { action: "privacy_local_only", value };
    if (actionId === "octoclaw_router_wizard_privacy_custom" || value === "privacy_custom") return { action: "privacy_custom", value };
    if (actionId === "octoclaw_router_wizard_budget_none" || value === "budget_none") return { action: "budget_none", value };
    if (actionId === "octoclaw_router_wizard_budget_50" || value === "budget_50") return { action: "budget_50", value };
    if (actionId === "octoclaw_router_wizard_budget_100" || value === "budget_100") return { action: "budget_100", value };
    if (actionId === "octoclaw_router_wizard_budget_200" || value === "budget_200") return { action: "budget_200", value };
    if (actionId === "octoclaw_router_wizard_budget_custom" || value === "budget_custom") return { action: "budget_custom", value };
    if (actionId === "octoclaw_router_wizard_restricted_none" || value === "restricted_none") return { action: "restricted_none", value };
    if (actionId === "octoclaw_router_wizard_restricted_text" || value === "restricted_text") return { action: "restricted_text", value };
    if (actionId === "octoclaw_router_wizard_language_auto" || value === "language_auto") return { action: "language_auto", value };
    if (actionId === "octoclaw_router_wizard_language_zh" || value === "language_zh") return { action: "language_zh", value };
    if (actionId === "octoclaw_router_wizard_language_en" || value === "language_en") return { action: "language_en", value };
    if (actionId === "octoclaw_router_wizard_same_provider_import" || value === "same_provider_import") return { action: "same_provider_import", value };
    if (actionId === "octoclaw_router_wizard_same_provider_skip" || value === "same_provider_skip") return { action: "same_provider_skip", value };
    if (actionId === "octoclaw_router_wizard_same_provider_add" || value.startsWith("same_provider_add:")) return { action: "same_provider_add", value };
    if (actionId === "octoclaw_router_wizard_same_provider_skip_one" || value.startsWith("same_provider_skip_one:")) return { action: "same_provider_skip_one", value };
    if (actionId === "octoclaw_router_wizard_same_provider_import_all" || value === "same_provider_import_all") return { action: "same_provider_import_all", value };
    if (actionId === CONFIRM_ACTION || value === "confirm") return { action: "confirm", value };
  }
  return null;
}

export function discoverConfiguredRouterModels(openclawHome = ""): string[] {
  try {
    const raw = JSON.parse(fsSync.readFileSync(path.join(resolveOpenclawHome(openclawHome), "openclaw.json"), "utf8")) as UnknownRecord;
    const providers = asRecord(asRecord(asRecord(raw).models).providers);
    const models: string[] = [];
    for (const [provider, providerConfig] of Object.entries(providers)) {
      const providerModels = asRecord(providerConfig).models;
      if (!Array.isArray(providerModels)) continue;
      for (const item of providerModels) {
        const id = stringValue(asRecord(item).id);
        if (id) models.push(`${provider}/${id}`);
      }
    }
    return [...new Set(models)];
  } catch {
    return [];
  }
}

function routerWizardSnapshotPath(openclawHome = ""): string {
  return path.join(resolveOpenclawHome(openclawHome), "octoclaw", "router-lite", "model-intel-snapshot.json");
}

function loadRouterWizardSnapshotModels(openclawHome = ""): ModelIntelLite[] {
  try {
    const raw = fsSync.readFileSync(routerWizardSnapshotPath(openclawHome), "utf8");
    return loadSnapshotFromText(raw).models;
  } catch {
    try {
      return loadPackagedModelIntelSnapshot().models;
    } catch {
      return [];
    }
  }
}

function providerForModel(modelKey: string): string {
  const slash = modelKey.indexOf("/");
  return slash > 0 ? modelKey.slice(0, slash).toLowerCase() : "";
}

function discoverSameProviderRouterModels(openclawHome = "", configuredModels = discoverConfiguredRouterModels(openclawHome)): string[] {
  const configured = new Set(configuredModels);
  const configuredProviders = new Set(configuredModels.map(providerForModel).filter(Boolean));
  return Array.from(new Set(loadRouterWizardSnapshotModels(openclawHome)
    .filter((model) => configuredProviders.has(providerForModel(model.modelKey)) && !configured.has(model.modelKey))
    .map((model) => model.modelKey)
    .filter(Boolean))).slice(0, 8);
}

function inferPlanTypes(models: string[], mode?: "subscription" | "pay_as_you_go"): Record<string, "subscription" | "pay_as_you_go" | "unknown"> {
  return Object.fromEntries(models.map((model) => [model, mode ?? detectPlanType(model)]));
}

function actionValueModel(value: string, prefix: string): string | undefined {
  const marker = `${prefix}:`;
  return value.startsWith(marker) ? value.slice(marker.length) : undefined;
}

function nextPlanModel(models: string[], answers: RouterWizardAnswers): string | undefined {
  const planTypes = answers.modelPlanTypes ?? {};
  return models.find((model) => planTypes[model] === undefined);
}

function sameProviderReviewed(answers: RouterWizardAnswers): Set<string> {
  return new Set([
    ...(answers.sameProviderReviewed ?? []),
    ...(answers.sameProviderModels ?? []),
  ]);
}

function nextSameProviderModel(models: string[], answers: RouterWizardAnswers): string | undefined {
  const reviewed = sameProviderReviewed(answers);
  return models.find((model) => !reviewed.has(model));
}

async function writeWizardConfig(
  openclawHome: string,
  modelIds: string[],
  now: Date,
  answers: RouterWizardAnswers = {},
): Promise<string> {
  const filePath = routerWizardConfigPath(openclawHome);
  const config = createWizardConfig(modelIds, {
    now: now.toISOString(),
    privacy: answers.privacy,
    language: answers.language,
    restrictedModels: answers.restrictedModels,
    modelPlanTypes: answers.modelPlanTypes,
    sameProviderModels: answers.sameProviderModels,
    ...(answers.monthlyBudget !== undefined ? { budgetInput: String(answers.monthlyBudget) } : {}),
  });
  fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
  fsSync.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return filePath;
}

function actionButton(text: string, actionId: string, value: string, style?: "primary" | "danger"): Record<string, unknown> {
  return {
    type: "button",
    text: { type: "plain_text", text },
    action_id: actionId,
    value,
    ...(style ? { style } : {}),
  };
}

function actionsBlock(elements: Record<string, unknown>[]): Record<string, unknown> {
  return { type: "actions", block_id: "octoclaw_router_wizard_question", elements };
}

function questionBlocks(text: string, elements: Record<string, unknown>[]): Array<Record<string, unknown>> {
  return [
    { type: "section", text: { type: "mrkdwn", text } },
    actionsBlock(elements),
  ];
}

function modelScanQuestion(models: string[]): { message: string; blocks: Array<Record<string, unknown>> } {
  const modelText = models.length ? models.map((model) => `- \`${model}\``).join("\n") : "未发现 OpenClaw 已配置模型。";
  const message = `Auto Router 向导 1/7：模型扫描。\n${modelText}`;
  return {
    message,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*1/7 模型扫描*\n当前 OpenClaw 已配置模型：\n${modelText}` } },
      actionsBlock([actionButton("继续", "octoclaw_router_wizard_model_scan_continue", "model_scan_continue", "primary")]),
    ],
  };
}

function planQuestion(models: string[], answers: RouterWizardAnswers = {}): { message: string; blocks: Array<Record<string, unknown>> } {
  const current = nextPlanModel(models, answers);
  const index = current ? models.indexOf(current) + 1 : models.length;
  const modelText = models.length
    ? models.map((model) => {
      const selected = answers.modelPlanTypes?.[model];
      return `- \`${model}\` → ${selected ? `已选 \`${selected}\`` : `推荐 \`${detectPlanType(model)}\``}`;
    }).join("\n")
    : "未发现 OpenClaw 已配置模型。";
  const currentText = current ? `\n当前确认：\`${current}\`（${index}/${models.length}）` : "";
  const message = `Auto Router 向导 2/7：确认 Plan 类型。\n${modelText}${currentText}`;
  const elements = current
    ? [
      actionButton("订阅/Plan", "octoclaw_router_wizard_plan_subscription", `plan_subscription:${current}`, detectPlanType(current) === "subscription" ? "primary" : undefined),
      actionButton("按量付费", "octoclaw_router_wizard_plan_pay_as_you_go", `plan_pay_as_you_go:${current}`, detectPlanType(current) === "pay_as_you_go" ? "primary" : undefined),
      actionButton("未知", "octoclaw_router_wizard_plan_unknown", `plan_unknown:${current}`),
      actionButton("全部按推荐", "octoclaw_router_wizard_plan_confirm", "plan_confirm"),
    ]
    : [actionButton("继续", "octoclaw_router_wizard_plan_confirm", "plan_confirm", "primary")];
  return {
    message,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*2/7 Plan 类型*\n用于区分订阅/额度内模型和按量付费模型。逐个确认，可随时全部按推荐。\n${modelText}${currentText}` } },
      actionsBlock(elements),
    ],
  };
}

function privacyQuestion(): { message: string; blocks: Array<Record<string, unknown>> } {
  const message = "Auto Router 向导 4/7：选择隐私模式。";
  return {
    message,
    blocks: questionBlocks("*4/7 隐私模式*\n`standard` 会允许使用云端模型能力数据；`local_only` 只考虑本地/私有模型。", [
      actionButton("标准", "octoclaw_router_wizard_privacy_standard", "privacy_standard", "primary"),
      actionButton("仅本地", "octoclaw_router_wizard_privacy_local_only", "privacy_local_only"),
      actionButton("我来挑选", "octoclaw_router_wizard_privacy_custom", "privacy_custom"),
    ]),
  };
}

function budgetQuestion(): { message: string; blocks: Array<Record<string, unknown>> } {
  const message = "Auto Router 向导 3/7：选择月预算。";
  return {
    message,
    blocks: questionBlocks("*3/7 月预算*\n用于成本报告和预算保护；可以不设置。", [
      actionButton("不设置", "octoclaw_router_wizard_budget_none", "budget_none"),
      actionButton("$50", "octoclaw_router_wizard_budget_50", "budget_50"),
      actionButton("$100", "octoclaw_router_wizard_budget_100", "budget_100", "primary"),
      actionButton("$200", "octoclaw_router_wizard_budget_200", "budget_200"),
      actionButton("自定义", "octoclaw_router_wizard_budget_custom", "budget_custom"),
    ]),
  };
}

function budgetTextQuestion(): { message: string; blocks: Array<Record<string, unknown>> } {
  return {
    message: "请回复 `budget 100` 这样的格式设置月预算，数字单位是 USD。",
    blocks: [{ type: "section", text: { type: "mrkdwn", text: "回复 `budget 100` 这样的格式设置月预算，数字单位是 USD。" } }],
  };
}

function languageQuestion(): { message: string; blocks: Array<Record<string, unknown>> } {
  const message = "Auto Router 向导 5/7：选择语言偏好。";
  return {
    message,
    blocks: questionBlocks("*5/7 语言偏好*\n用于后续提示和报告文案；`auto` 会跟随会话语言。", [
      actionButton("自动", "octoclaw_router_wizard_language_auto", "language_auto", "primary"),
      actionButton("中文", "octoclaw_router_wizard_language_zh", "language_zh"),
      actionButton("English", "octoclaw_router_wizard_language_en", "language_en"),
    ]),
  };
}

function restrictedModelsQuestion(models: string[]): { message: string; blocks: Array<Record<string, unknown>> } {
  const modelText = models.length ? models.map((model) => `- \`${model}\``).join("\n") : "未发现 OpenClaw 模型。";
  return {
    message: `Auto Router 向导 6/7：禁用模型设置。\n${modelText}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*6/7 禁用模型*\n当前模型：\n${modelText}` } },
      actionsBlock([
        actionButton("不禁用", "octoclaw_router_wizard_restricted_none", "restricted_none", "primary"),
        actionButton("我要输入", "octoclaw_router_wizard_restricted_text", "restricted_text"),
      ]),
    ],
  };
}

function restrictedTextQuestion(): { message: string; blocks: Array<Record<string, unknown>> } {
  return {
    message: "请回复 `ban model-a, model-b`，我会把这些模型加入 restrictedModels。",
    blocks: [{ type: "section", text: { type: "mrkdwn", text: "回复 `ban model-a, model-b`，我会把这些模型加入 `restrictedModels`。" } }],
  };
}

function sameProviderQuestion(models: string[], answers: RouterWizardAnswers = {}): { message: string; blocks: Array<Record<string, unknown>> } {
  const current = nextSameProviderModel(models, answers);
  const selected = new Set(answers.sameProviderModels ?? []);
  const reviewed = sameProviderReviewed(answers);
  const modelText = models.length
    ? models.map((model) => {
      const status = selected.has(model) ? "已导入" : reviewed.has(model) ? "已跳过" : "待确认";
      return `- \`${model}\` → ${status}`;
    }).join("\n")
    : "没有发现可导入的同供应商候选模型。";
  const currentText = current ? `\n当前候选：\`${current}\`` : "";
  const elements = current
    ? [
      actionButton("导入此模型", "octoclaw_router_wizard_same_provider_add", `same_provider_add:${current}`, "primary"),
      actionButton("跳过此模型", "octoclaw_router_wizard_same_provider_skip_one", `same_provider_skip_one:${current}`),
      actionButton("全部导入", "octoclaw_router_wizard_same_provider_import_all", "same_provider_import_all"),
      actionButton("全部跳过", "octoclaw_router_wizard_same_provider_skip", "same_provider_skip"),
    ]
    : [actionButton("继续", "octoclaw_router_wizard_same_provider_skip", "same_provider_skip", "primary")];
  return {
    message: `Auto Router 向导 7/7：同供应商模型发现。\n${modelText}${currentText}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*7/7 同供应商模型发现*\n${modelText}${currentText}` } },
      actionsBlock(elements),
    ],
  };
}

function confirmQuestion(answers: RouterWizardAnswers, models: string[]): { message: string; blocks: Array<Record<string, unknown>> } {
  const budget = answers.monthlyBudget === undefined ? "不设置" : `$${answers.monthlyBudget} USD/月`;
  const restricted = answers.restrictedModels?.length ? answers.restrictedModels.join(", ") : "无";
  const sameProvider = answers.sameProviderModels?.length ? answers.sameProviderModels.join(", ") : "无";
  const message = [
    "Auto Router 向导：确认写入配置。",
    `隐私模式：${answers.privacy ?? "standard"}`,
    `语言偏好：${answers.language ?? "auto"}`,
    `月预算：${budget}`,
    `禁用模型：${restricted}`,
    `导入候选模型：${sameProvider}`,
    `识别模型数：${models.length}`,
  ].join("\n");
  return {
    message,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*确认写入*\n隐私模式：\`${answers.privacy ?? "standard"}\`\n语言偏好：\`${answers.language ?? "auto"}\`\n月预算：${budget}\n禁用模型：${restricted}\n导入候选模型：${sameProvider}\n识别模型数：${models.length}` } },
      actionsBlock([actionButton("确认写入", CONFIRM_ACTION, "confirm", "primary")]),
    ],
  };
}

async function sendWizardQuestion(input: {
  sendMessage: RouterWizardOnboardingSendMessage;
  sessionKey: string;
  replyToMessageId?: string;
  cwd?: string;
  question: { message: string; blocks: Array<Record<string, unknown>> };
}): Promise<void> {
  await input.sendMessage({
    sessionKey: input.sessionKey,
    message: input.question.message,
    interactiveBlocks: input.question.blocks,
    replyToMessageId: input.replyToMessageId,
    cwd: input.cwd,
    suppressProjectionFooter: true,
    deliveryKind: "router_wizard_onboarding",
    deliveryTargetSource: input.replyToMessageId ? "inbound_anchor" : "session_fallback",
    footerMode: "off",
  });
}

function extractEventText(value: unknown): string {
  const record = asRecord(value);
  return stringValue(record.text || record.content || record.prompt || asRecord(record.message).text || asRecord(record.message).content);
}

function parseBudgetText(text: string): number | undefined {
  const match = stringValue(text).match(/(?:budget|预算)?\s*\$?\s*(\d+(?:\.\d+)?)/iu);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseRestrictedModelsText(text: string): string[] {
  const cleaned = stringValue(text)
    .replace(/^(?:ban|bans|restrict|restricted|禁用|屏蔽)\s+/iu, "")
    .replace(/^models?\s*[:：]\s*/iu, "");
  return Array.from(new Set(cleaned.split(/[,\n，、]+/u).map((item) => item.trim().replace(/^`|`$/gu, "")).filter(Boolean)));
}

function upsertActiveSession(
  state: RouterWizardOnboardingState,
  sessionKey: string,
  step: RouterWizardStep,
  now: Date,
  answers: RouterWizardAnswers,
): RouterWizardActiveSession {
  const existing = state.active && onboardingSessionKey(state.active.sessionKey) === onboardingSessionKey(sessionKey)
    ? state.active
    : undefined;
  return {
    sessionKey,
    step,
    startedAt: existing?.startedAt || now.toISOString(),
    updatedAt: now.toISOString(),
    answers,
  };
}

export async function handleRouterWizardAction(input: {
  event: unknown;
  sessionKey: string;
  replyToMessageId?: string;
  openclawHome?: string;
  cwd?: string;
  now?: Date;
  sendMessage?: RouterWizardOnboardingSendMessage;
}): Promise<{ handled: boolean; action?: string; path?: string }> {
  const openclawHome = resolveOpenclawHome(input.openclawHome);
  const now = input.now ?? new Date();
  const state = await readOnboardingState(openclawHome);
  const sendMessage = input.sendMessage ?? ((params) => sendIMMessage(params));
  const active = state.active && onboardingSessionKey(state.active.sessionKey) === onboardingSessionKey(input.sessionKey)
    ? state.active
    : undefined;
  const text = extractEventText(input.event);
  const actionDetails = extractRouterWizardActionDetails(input.event);
  let action = actionDetails?.action ?? null;
  const actionValue = actionDetails?.value ?? "";
  if (!action && active?.step === "budget_custom" && parseBudgetText(text) !== undefined) action = "budget_text";
  if (!action && (active?.step === "restricted_models" || active?.step === "restricted_models_text") && text) action = "restricted_models_text";
  if (!action) return { handled: false };
  if (action === "use_defaults") {
    const models = discoverConfiguredRouterModels(openclawHome);
    const filePath = await writeWizardConfig(openclawHome, models, now);
    state.completedAt = now.toISOString();
    await writeOnboardingState(openclawHome, state);
    await sendMessage({
      sessionKey: input.sessionKey,
      message: `Auto Router 默认配置已启用：${filePath}\n已识别模型数：${models.length}`,
      replyToMessageId: input.replyToMessageId,
      cwd: input.cwd,
      suppressProjectionFooter: true,
      deliveryKind: "status_reply",
      deliveryTargetSource: input.replyToMessageId ? "inbound_anchor" : "session_fallback",
      footerMode: "off",
    });
    return { handled: true, action, path: filePath };
  }
  if (action === "start_questions") {
    state.active = upsertActiveSession(state, input.sessionKey, "model_scan", now, {});
    await writeOnboardingState(openclawHome, state);
    await sendWizardQuestion({
      sendMessage,
      sessionKey: input.sessionKey,
      replyToMessageId: input.replyToMessageId,
      cwd: input.cwd,
      question: modelScanQuestion(discoverConfiguredRouterModels(openclawHome)),
    });
    return { handled: true, action };
  }
  if (action === "model_scan_continue") {
    const models = discoverConfiguredRouterModels(openclawHome);
    const answers = { ...(active?.answers ?? {}), modelPlanTypes: active?.answers.modelPlanTypes ?? {} };
    state.active = upsertActiveSession(state, input.sessionKey, "plan", now, answers);
    await writeOnboardingState(openclawHome, state);
    await sendWizardQuestion({
      sendMessage,
      sessionKey: input.sessionKey,
      replyToMessageId: input.replyToMessageId,
      cwd: input.cwd,
      question: planQuestion(models, answers),
    });
    return { handled: true, action };
  }
  if (action === "plan_subscription" || action === "plan_pay_as_you_go" || action === "plan_unknown") {
    const models = discoverConfiguredRouterModels(openclawHome);
    const planType = action === "plan_subscription" ? "subscription" as const : action === "plan_pay_as_you_go" ? "pay_as_you_go" as const : "unknown" as const;
    const model = actionValueModel(actionValue, action) ?? nextPlanModel(models, active?.answers ?? {});
    const answers: RouterWizardAnswers = {
      ...(active?.answers ?? {}),
      modelPlanTypes: { ...(active?.answers.modelPlanTypes ?? {}) },
    };
    if (model) answers.modelPlanTypes![model] = planType;
    state.active = upsertActiveSession(state, input.sessionKey, nextPlanModel(models, answers) ? "plan" : "budget", now, answers);
    await writeOnboardingState(openclawHome, state);
    await sendWizardQuestion({
      sendMessage,
      sessionKey: input.sessionKey,
      replyToMessageId: input.replyToMessageId,
      cwd: input.cwd,
      question: nextPlanModel(models, answers) ? planQuestion(models, answers) : budgetQuestion(),
    });
    return { handled: true, action };
  }
  if (action === "plan_confirm" || action === "plan_all_subscription" || action === "plan_all_pay_as_you_go") {
    const models = discoverConfiguredRouterModels(openclawHome);
    const forced = action === "plan_all_subscription" ? "subscription" : action === "plan_all_pay_as_you_go" ? "pay_as_you_go" : undefined;
    const modelPlanTypes = inferPlanTypes(models, forced);
    const answers = {
      ...(active?.answers ?? {}),
      modelPlanTypes: forced ? modelPlanTypes : { ...modelPlanTypes, ...(active?.answers.modelPlanTypes ?? {}) },
    };
    state.active = upsertActiveSession(state, input.sessionKey, "budget", now, answers);
    await writeOnboardingState(openclawHome, state);
    await sendWizardQuestion({ sendMessage, sessionKey: input.sessionKey, replyToMessageId: input.replyToMessageId, cwd: input.cwd, question: budgetQuestion() });
    return { handled: true, action };
  }
  if (action === "budget_custom") {
    state.active = upsertActiveSession(state, input.sessionKey, "budget_custom", now, active?.answers ?? {});
    await writeOnboardingState(openclawHome, state);
    await sendWizardQuestion({ sendMessage, sessionKey: input.sessionKey, replyToMessageId: input.replyToMessageId, cwd: input.cwd, question: budgetTextQuestion() });
    return { handled: true, action };
  }
  if (action === "budget_none" || action === "budget_50" || action === "budget_100" || action === "budget_200" || action === "budget_text") {
    const budgetFromText = action === "budget_text" ? parseBudgetText(text) : undefined;
    const budgetFromButton = action === "budget_50" ? 50 : action === "budget_100" ? 100 : action === "budget_200" ? 200 : undefined;
    const nextBudget = budgetFromText ?? budgetFromButton;
    const answers = { ...(active?.answers ?? {}) };
    if (nextBudget === undefined) delete answers.monthlyBudget;
    else answers.monthlyBudget = nextBudget;
    state.active = upsertActiveSession(state, input.sessionKey, "privacy", now, answers);
    await writeOnboardingState(openclawHome, state);
    await sendWizardQuestion({ sendMessage, sessionKey: input.sessionKey, replyToMessageId: input.replyToMessageId, cwd: input.cwd, question: privacyQuestion() });
    return { handled: true, action };
  }
  if (action === "privacy_standard" || action === "privacy_local_only" || action === "privacy_custom") {
    const answers = { ...(active?.answers ?? {}), privacy: action === "privacy_local_only" ? "local_only" as const : "standard" as const };
    state.active = upsertActiveSession(state, input.sessionKey, "language", now, answers);
    await writeOnboardingState(openclawHome, state);
    await sendWizardQuestion({ sendMessage, sessionKey: input.sessionKey, replyToMessageId: input.replyToMessageId, cwd: input.cwd, question: languageQuestion() });
    return { handled: true, action };
  }
  if (action === "language_auto" || action === "language_zh" || action === "language_en") {
    const language = action === "language_zh" ? "zh" as const : action === "language_en" ? "en" as const : "auto" as const;
    const answers = { ...(active?.answers ?? {}), language };
    state.active = upsertActiveSession(state, input.sessionKey, "restricted_models", now, answers);
    await writeOnboardingState(openclawHome, state);
    await sendWizardQuestion({
      sendMessage,
      sessionKey: input.sessionKey,
      replyToMessageId: input.replyToMessageId,
      cwd: input.cwd,
      question: restrictedModelsQuestion(discoverConfiguredRouterModels(openclawHome)),
    });
    return { handled: true, action };
  }
  if (action === "restricted_text") {
    state.active = upsertActiveSession(state, input.sessionKey, "restricted_models_text", now, active?.answers ?? {});
    await writeOnboardingState(openclawHome, state);
    await sendWizardQuestion({ sendMessage, sessionKey: input.sessionKey, replyToMessageId: input.replyToMessageId, cwd: input.cwd, question: restrictedTextQuestion() });
    return { handled: true, action };
  }
  if (action === "restricted_none" || action === "restricted_models_text") {
    const answers = { ...(active?.answers ?? {}) };
    answers.restrictedModels = action === "restricted_none" ? [] : parseRestrictedModelsText(text);
    state.active = upsertActiveSession(state, input.sessionKey, "same_provider", now, answers);
    await writeOnboardingState(openclawHome, state);
    await sendWizardQuestion({
      sendMessage,
      sessionKey: input.sessionKey,
      replyToMessageId: input.replyToMessageId,
      cwd: input.cwd,
      question: sameProviderQuestion(discoverSameProviderRouterModels(openclawHome), answers),
    });
    return { handled: true, action };
  }
  if (action === "same_provider_import" || action === "same_provider_skip" || action === "same_provider_import_all" || action === "same_provider_add" || action === "same_provider_skip_one") {
    const candidates = discoverSameProviderRouterModels(openclawHome);
    const answers = { ...(active?.answers ?? {}) };
    const selected = new Set(answers.sameProviderModels ?? []);
    const reviewed = sameProviderReviewed(answers);
    if (action === "same_provider_import" || action === "same_provider_import_all") {
      for (const model of candidates) {
        selected.add(model);
        reviewed.add(model);
      }
    } else if (action === "same_provider_skip") {
      for (const model of candidates) reviewed.add(model);
    } else {
      const model = actionValueModel(actionValue, action) ?? nextSameProviderModel(candidates, answers);
      if (model) {
        if (action === "same_provider_add") selected.add(model);
        reviewed.add(model);
      }
    }
    const sameProviderModels = [...selected].filter((model) => candidates.includes(model));
    answers.sameProviderModels = sameProviderModels;
    answers.sameProviderReviewed = [...reviewed].filter((model) => candidates.includes(model));
    answers.modelPlanTypes = {
      ...inferPlanTypes(discoverConfiguredRouterModels(openclawHome)),
      ...(answers.modelPlanTypes ?? {}),
      ...inferPlanTypes(sameProviderModels),
    };
    const hasMore = nextSameProviderModel(candidates, answers) !== undefined;
    state.active = upsertActiveSession(state, input.sessionKey, hasMore ? "same_provider" : "confirm", now, answers);
    await writeOnboardingState(openclawHome, state);
    await sendWizardQuestion({
      sendMessage,
      sessionKey: input.sessionKey,
      replyToMessageId: input.replyToMessageId,
      cwd: input.cwd,
      question: hasMore ? sameProviderQuestion(candidates, answers) : confirmQuestion(answers, discoverConfiguredRouterModels(openclawHome)),
    });
    return { handled: true, action };
  }
  if (action === "confirm") {
    const answers = active?.answers ?? {};
    const models = discoverConfiguredRouterModels(openclawHome);
    const filePath = await writeWizardConfig(openclawHome, models, now, answers);
    state.completedAt = now.toISOString();
    state.active = undefined;
    await writeOnboardingState(openclawHome, state);
    await sendMessage({
      sessionKey: input.sessionKey,
      message: `Auto Router 配置已写入：${filePath}\n已识别模型数：${models.length}`,
      replyToMessageId: input.replyToMessageId,
      cwd: input.cwd,
      suppressProjectionFooter: true,
      deliveryKind: "status_reply",
      deliveryTargetSource: input.replyToMessageId ? "inbound_anchor" : "session_fallback",
      footerMode: "off",
    });
    return { handled: true, action, path: filePath };
  }
  if (action === "remind_later") {
    state.remindAfter = new Date(now.getTime() + 24 * 60 * 60_000).toISOString();
  } else {
    state.skippedAt = now.toISOString();
  }
  await writeOnboardingState(openclawHome, state);
  await sendMessage({
    sessionKey: input.sessionKey,
    message: action === "remind_later" ? "好，明天再提醒你配置 Auto Router。" : "好，已关闭 Auto Router 首次配置提醒。之后可手动运行 `octoclawctl router wizard --incremental`。",
    replyToMessageId: input.replyToMessageId,
    cwd: input.cwd,
    suppressProjectionFooter: true,
    deliveryKind: "status_reply",
    deliveryTargetSource: input.replyToMessageId ? "inbound_anchor" : "session_fallback",
    footerMode: "off",
  });
  return { handled: true, action };
}
