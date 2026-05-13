import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWizardConfig } from "@octoclaw/router";
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

type RouterWizardStep = "privacy" | "budget" | "budget_custom" | "restricted_models" | "restricted_models_text" | "confirm";
type RouterWizardAction =
  | "start_questions"
  | "use_defaults"
  | "remind_later"
  | "skip"
  | "privacy_standard"
  | "privacy_local_only"
  | "budget_none"
  | "budget_50"
  | "budget_100"
  | "budget_200"
  | "budget_custom"
  | "budget_text"
  | "restricted_none"
  | "restricted_text"
  | "restricted_models_text"
  | "confirm";

interface RouterWizardAnswers {
  privacy?: "standard" | "local_only";
  monthlyBudget?: number;
  restrictedModels?: string[];
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
    return raw.schemaVersion === ROUTER_WIZARD_SCHEMA && Object.keys(asRecord(raw.models)).length > 0;
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
  if (!["privacy", "budget", "budget_custom", "restricted_models", "restricted_models_text", "confirm"].includes(step)) return undefined;
  const answers = asRecord(record.answers);
  const monthlyBudget = Number(answers.monthlyBudget);
  return {
    sessionKey: stringValue(record.sessionKey),
    step,
    startedAt: stringValue(record.startedAt),
    updatedAt: stringValue(record.updatedAt),
    answers: {
      privacy: answers.privacy === "local_only" ? "local_only" : answers.privacy === "standard" ? "standard" : undefined,
      ...(Number.isFinite(monthlyBudget) ? { monthlyBudget } : {}),
      restrictedModels: Array.isArray(answers.restrictedModels) ? answers.restrictedModels.map(stringValue).filter(Boolean) : undefined,
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
  for (const action of collectActionCandidates(event)) {
    const actionId = stringValue(action.action_id || action.actionId);
    const value = stringValue(action.value);
    if (actionId === QUESTION_ACTION || value === "start_questions") return "start_questions";
    if (actionId === START_ACTION || value === "use_defaults") return "use_defaults";
    if (actionId === REMIND_ACTION || value === "remind_later") return "remind_later";
    if (actionId === SKIP_ACTION || value === "skip") return "skip";
    if (actionId === "octoclaw_router_wizard_privacy_standard" || value === "privacy_standard") return "privacy_standard";
    if (actionId === "octoclaw_router_wizard_privacy_local_only" || value === "privacy_local_only") return "privacy_local_only";
    if (actionId === "octoclaw_router_wizard_budget_none" || value === "budget_none") return "budget_none";
    if (actionId === "octoclaw_router_wizard_budget_50" || value === "budget_50") return "budget_50";
    if (actionId === "octoclaw_router_wizard_budget_100" || value === "budget_100") return "budget_100";
    if (actionId === "octoclaw_router_wizard_budget_200" || value === "budget_200") return "budget_200";
    if (actionId === "octoclaw_router_wizard_budget_custom" || value === "budget_custom") return "budget_custom";
    if (actionId === "octoclaw_router_wizard_restricted_none" || value === "restricted_none") return "restricted_none";
    if (actionId === "octoclaw_router_wizard_restricted_text" || value === "restricted_text") return "restricted_text";
    if (actionId === CONFIRM_ACTION || value === "confirm") return "confirm";
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
    restrictedModels: answers.restrictedModels,
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

function privacyQuestion(): { message: string; blocks: Array<Record<string, unknown>> } {
  const message = "Auto Router 向导 1/4：选择隐私模式。";
  return {
    message,
    blocks: questionBlocks("*1/4 隐私模式*\n`standard` 会允许使用云端模型能力数据；`local_only` 只考虑本地/私有模型。", [
      actionButton("标准", "octoclaw_router_wizard_privacy_standard", "privacy_standard", "primary"),
      actionButton("仅本地", "octoclaw_router_wizard_privacy_local_only", "privacy_local_only"),
    ]),
  };
}

function budgetQuestion(): { message: string; blocks: Array<Record<string, unknown>> } {
  const message = "Auto Router 向导 2/4：选择月预算。";
  return {
    message,
    blocks: questionBlocks("*2/4 月预算*\n用于成本报告和预算保护；可以不设置。", [
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

function restrictedModelsQuestion(models: string[]): { message: string; blocks: Array<Record<string, unknown>> } {
  const modelText = models.length ? models.map((model) => `- \`${model}\``).join("\n") : "未发现 OpenClaw 模型。";
  return {
    message: `Auto Router 向导 3/4：禁用模型设置。\n${modelText}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*3/4 禁用模型*\n当前模型：\n${modelText}` } },
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

function confirmQuestion(answers: RouterWizardAnswers, models: string[]): { message: string; blocks: Array<Record<string, unknown>> } {
  const budget = answers.monthlyBudget === undefined ? "不设置" : `$${answers.monthlyBudget} USD/月`;
  const restricted = answers.restrictedModels?.length ? answers.restrictedModels.join(", ") : "无";
  const message = [
    "Auto Router 向导 4/4：确认写入配置。",
    `隐私模式：${answers.privacy ?? "standard"}`,
    `月预算：${budget}`,
    `禁用模型：${restricted}`,
    `识别模型数：${models.length}`,
  ].join("\n");
  return {
    message,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*4/4 确认写入*\n隐私模式：\`${answers.privacy ?? "standard"}\`\n月预算：${budget}\n禁用模型：${restricted}\n识别模型数：${models.length}` } },
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
  let action = extractRouterWizardAction(input.event);
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
    state.active = upsertActiveSession(state, input.sessionKey, "privacy", now, {});
    await writeOnboardingState(openclawHome, state);
    await sendWizardQuestion({ sendMessage, sessionKey: input.sessionKey, replyToMessageId: input.replyToMessageId, cwd: input.cwd, question: privacyQuestion() });
    return { handled: true, action };
  }
  if (action === "privacy_standard" || action === "privacy_local_only") {
    const answers = { ...(active?.answers ?? {}), privacy: action === "privacy_local_only" ? "local_only" as const : "standard" as const };
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
    state.active = upsertActiveSession(state, input.sessionKey, "confirm", now, answers);
    await writeOnboardingState(openclawHome, state);
    await sendWizardQuestion({
      sendMessage,
      sessionKey: input.sessionKey,
      replyToMessageId: input.replyToMessageId,
      cwd: input.cwd,
      question: confirmQuestion(answers, discoverConfiguredRouterModels(openclawHome)),
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
