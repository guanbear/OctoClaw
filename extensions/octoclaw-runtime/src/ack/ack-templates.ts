export const ACK_TEMPLATES = {
  pre_route: ["收到，看下", "稍等", "收到", "在", "好", "马上看"],
  reply: ["想一下", "稍等我回你", "在想", "马上", "收到，组织下", "让我想想"],
  delegate: ["收到，开始处理", "好的，处理中", "在跑了", "开工", "这就安排", "着手处理中"],
  observe: ["看下情况", "查一下", "在看了", "扫一眼", "检查中", "在查了"],
  queued: ["排队中，稍等", "前面有任务在跑", "等一下马上到"],
  blocked: ["卡了，需要点信息", "处理受阻：{reason}", "遇到点问题"],
  stale: ["还在跑，稍等", "还没好，再等等", "处理中..."],
  timeout: ["超时了，要继续吗？", "跑的时间有点长，要不要停掉？"],
} as const;

export type AckStageKey = keyof typeof ACK_TEMPLATES;
export type AckTemplateStage = "ack0" | "tier1" | "tier2" | "tier3";
export type AckTemplateChannel = "chat" | "work" | "cli" | "unknown";
export type AckTemplateTone = "neutral" | "warm" | "terse";
export type AckTemplateTaskClass = "lookup" | "coding" | "review" | "writing" | "status" | "long_running" | "unknown";
export type AckTemplateModality = "reaction" | "text" | "unknown";

export interface TemplateSelectionInputs { route?: string; queueState?: string; blockedReason?: string; channelCapability?: "update" | "text_only"; burstState?: "active" | "cooldown" | "idle"; anchorExists?: boolean; userInputActive?: boolean; stageHint?: string; }
type TemplateSelectionResult = { key: string; stage: AckTemplateStage; channel: AckTemplateChannel; tone: AckTemplateTone; taskClass: AckTemplateTaskClass; modality: AckTemplateModality; semanticKey?: string; text: string; };

export const AckStage = {
  PreRouteSoftAck: "pre_route_soft_ack",
  DelegateStarted: "delegate_started",
  ObserveStarted: "observe_started",
  ReplySoftAck: "reply_soft_ack",
  Queued: "queued",
  Blocked: "blocked",
  ProgressNudge: "progress_nudge",
  ToolStillWorking: "tool_still_working",
  ToolComplexTask: "tool_complex_task",
  ToolAskContinue: "tool_ask_continue",
  ToolSuggestStop: "tool_suggest_stop",
} as const;
export type AckStage = typeof AckStage[keyof typeof AckStage];

const ACK_STAGE_TO_TEMPLATE_STAGE: Record<AckStage, AckStageKey> = { [AckStage.PreRouteSoftAck]: "pre_route", [AckStage.DelegateStarted]: "delegate", [AckStage.ObserveStarted]: "observe", [AckStage.ReplySoftAck]: "reply", [AckStage.Queued]: "queued", [AckStage.Blocked]: "blocked", [AckStage.ProgressNudge]: "stale", [AckStage.ToolStillWorking]: "stale", [AckStage.ToolComplexTask]: "stale", [AckStage.ToolAskContinue]: "timeout", [AckStage.ToolSuggestStop]: "timeout" };

function render(text: string, vars?: Record<string, string>): string {
  return vars ? text.replace(/\{(\w+)\}/g, (match, key: string) => vars[key] ?? match) : text;
}

function hash(value: string): number {
  let acc = 0;
  for (let index = 0; index < value.length; index += 1) acc = (acc * 31 + value.charCodeAt(index)) >>> 0;
  return acc;
}

function poolForStage(stage: AckTemplateStage): readonly string[] {
  if (stage === "ack0") return ACK_TEMPLATES.pre_route;
  return stage === "tier3" ? ACK_TEMPLATES.timeout : ACK_TEMPLATES.stale;
}

export function pickAckText(stage: AckStageKey, vars?: Record<string, string>): string {
  const pool = ACK_TEMPLATES[stage];
  return render(pool[Math.floor(Math.random() * pool.length)] ?? pool[0], vars);
}

export function ackStageText(stage: string, vars?: Record<string, string>): string {
  return pickAckText(ACK_STAGE_TO_TEMPLATE_STAGE[stage as AckStage] ?? "stale", vars);
}

export function selectAckTemplate(input: { stage: AckTemplateStage; channel: AckTemplateChannel; tone: AckTemplateTone; taskClass: AckTemplateTaskClass; modality: AckTemplateModality; semanticKey?: string; threadBindingKey: string; turnId: string; recentKeys: string[] }): TemplateSelectionResult;
export function selectAckTemplate(stage: string, _inputs?: TemplateSelectionInputs): { text: string } | null;
export function selectAckTemplate(input: string | { stage: AckTemplateStage; channel: AckTemplateChannel; tone: AckTemplateTone; taskClass: AckTemplateTaskClass; modality: AckTemplateModality; semanticKey?: string; threadBindingKey: string; turnId: string; recentKeys: string[] }): TemplateSelectionResult | { text: string } | null {
  if (typeof input === "string") return { text: ackStageText(input) };
  const pool = poolForStage(input.stage);
  const text = pool[hash(`${input.stage}:${input.threadBindingKey}:${input.turnId}`) % pool.length] ?? pool[0] ?? "收到。";
  return { key: `${input.stage}-${input.channel}-${input.tone}-${input.taskClass}-${hash(text)}`, stage: input.stage, channel: input.channel, tone: input.tone, taskClass: input.taskClass, modality: input.modality, semanticKey: input.semanticKey, text };
}
