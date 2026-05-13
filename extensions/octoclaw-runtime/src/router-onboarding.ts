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
const START_ACTION = "octoclaw_router_wizard_use_defaults";
const REMIND_ACTION = "octoclaw_router_wizard_remind_later";
const SKIP_ACTION = "octoclaw_router_wizard_skip";

export interface RouterWizardOnboardingState {
  schemaVersion: typeof ROUTER_ONBOARDING_SCHEMA;
  prompted: Record<string, { sentAt: string; messageId?: string; replyToMessageId?: string }>;
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
    "我可以用当前 OpenClaw 模型生成默认配置；主 agent 模型不会被自动切换，子 agent 才会按 judge 和结构化信号自动选型。",
    "也可以之后手动运行：`octoclawctl router wizard --incremental`",
  ].join("\n");
}

export function buildRouterWizardSlackBlocks(): Array<Record<string, unknown>> {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*OctoClaw Auto Router 首次配置*\n使用当前 OpenClaw 模型生成本地 router-wizard 配置。主 agent 不会被静默切换。",
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
          text: { type: "plain_text", text: "启用默认设置" },
          style: "primary",
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

export function extractRouterWizardAction(event: unknown): "use_defaults" | "remind_later" | "skip" | null {
  for (const action of collectActionCandidates(event)) {
    const actionId = stringValue(action.action_id || action.actionId);
    const value = stringValue(action.value);
    if (actionId === START_ACTION || value === "use_defaults") return "use_defaults";
    if (actionId === REMIND_ACTION || value === "remind_later") return "remind_later";
    if (actionId === SKIP_ACTION || value === "skip") return "skip";
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

async function writeWizardConfig(openclawHome: string, modelIds: string[], now: Date): Promise<string> {
  const filePath = routerWizardConfigPath(openclawHome);
  fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
  fsSync.writeFileSync(filePath, `${JSON.stringify(createWizardConfig(modelIds, { now: now.toISOString() }), null, 2)}\n`, "utf8");
  return filePath;
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
  const action = extractRouterWizardAction(input.event);
  if (!action) return { handled: false };
  const openclawHome = resolveOpenclawHome(input.openclawHome);
  const now = input.now ?? new Date();
  const state = await readOnboardingState(openclawHome);
  const sendMessage = input.sendMessage ?? ((params) => sendIMMessage(params));
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
