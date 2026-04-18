export enum AckStage {
  PreRouteSoftAck = "pre_route_soft_ack",
  DelegateStarted = "delegate_started",
  ObserveStarted = "observe_started",
  ReplySoftAck = "reply_soft_ack",
  Queued = "queued",
  Blocked = "blocked",
  ProgressNudge = "progress_nudge",
}

export interface AckTemplateEntry {
  stage: AckStage;
  text: string;
  direction: string;
  defaultAction: string;
  preferredChannels: string[];
}

export interface TemplateSelectionInputs {
  route?: string;
  queueState?: string;
  blockedReason?: string;
  channelCapability?: "update" | "text_only";
  burstState?: "active" | "cooldown" | "idle";
  anchorExists?: boolean;
  userInputActive?: boolean;
  stageHint?: string;
}

function interpolateTemplate(text: string, vars?: Record<string, string>): string {
  if (!vars) {
    return text;
  }
  return text.replace(/\{([^{}]+)\}/g, (match, key: string) => {
    const value = vars[key];
    return value === undefined ? match : value;
  });
}

function normalizeValue(value: string | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function buildTemplateEntry(
  stage: AckStage,
  text: string,
  direction: string,
  defaultAction: string,
  preferredChannels: string[],
): AckTemplateEntry {
  return {
    stage,
    text,
    direction,
    defaultAction,
    preferredChannels,
  };
}

export const ACK_TEMPLATE_POOL: Map<AckStage, AckTemplateEntry[]> = new Map([
  [
    AckStage.PreRouteSoftAck,
    [
      buildTemplateEntry(AckStage.PreRouteSoftAck, "收到，看下怎么处理", "自然确认", "优先短提示", ["聊天渠道优先"]),
      buildTemplateEntry(AckStage.PreRouteSoftAck, "收到，稍等", "简短安抚", "优先短提示", ["聊天渠道优先"]),
      buildTemplateEntry(AckStage.PreRouteSoftAck, "看到了", "最短确认", "优先短提示", ["聊天渠道优先"]),
      buildTemplateEntry(AckStage.PreRouteSoftAck, "嗯，稍等我看看", "口语化", "优先短提示", ["聊天渠道优先"]),
    ],
  ],
  [
    AckStage.DelegateStarted,
    [
      buildTemplateEntry(AckStage.DelegateStarted, "收到，开始处理", "自然确认", "优先新发", ["全渠道"]),
      buildTemplateEntry(AckStage.DelegateStarted, "好的，我来处理", "口语化", "优先新发", ["全渠道"]),
      buildTemplateEntry(AckStage.DelegateStarted, "着手处理中", "简洁", "优先新发", ["全渠道"]),
      buildTemplateEntry(AckStage.DelegateStarted, "了解了，正在跟进", "正式", "优先新发", ["全渠道"]),
    ],
  ],
  [
    AckStage.ObserveStarted,
    [
      buildTemplateEntry(AckStage.ObserveStarted, "正在查看", "简洁", "可新发", ["全渠道"]),
      buildTemplateEntry(AckStage.ObserveStarted, "看下情况", "口语化", "可新发", ["全渠道"]),
      buildTemplateEntry(AckStage.ObserveStarted, "在查了", "最短", "可新发", ["全渠道"]),
      buildTemplateEntry(AckStage.ObserveStarted, "检查中", "中性", "可新发", ["全渠道"]),
    ],
  ],
  [
    AckStage.ReplySoftAck,
    [
      buildTemplateEntry(AckStage.ReplySoftAck, "收到，想一下", "自然思考", "优先短提示", ["聊天渠道优先"]),
      buildTemplateEntry(AckStage.ReplySoftAck, "收到，稍等", "简短安抚", "优先短提示", ["聊天渠道优先"]),
      buildTemplateEntry(AckStage.ReplySoftAck, "看到了，我回你", "口语化", "优先短提示", ["聊天渠道优先"]),
      buildTemplateEntry(AckStage.ReplySoftAck, "嗯，稍等", "最短", "优先短提示", ["聊天渠道优先"]),
      buildTemplateEntry(AckStage.ReplySoftAck, "好的，马上回", "积极", "优先短提示", ["聊天渠道优先"]),
      buildTemplateEntry(AckStage.ReplySoftAck, "在写了", "轻松", "优先短提示", ["聊天渠道优先"]),
    ],
  ],
  [
    AckStage.Queued,
    [
      buildTemplateEntry(AckStage.Queued, "排队中，稍等一下", "自然", "优先更新", ["全渠道"]),
      buildTemplateEntry(AckStage.Queued, "收到了，前面还有任务在跑", "具体说明", "优先更新", ["全渠道"]),
      buildTemplateEntry(AckStage.Queued, "等一下，马上到你", "口语化", "优先更新", ["全渠道"]),
    ],
  ],
  [
    AckStage.Blocked,
    [
      buildTemplateEntry(AckStage.Blocked, "处理受阻：{reason}", "带原因", "优先新发", ["全渠道"]),
      buildTemplateEntry(AckStage.Blocked, "卡了一下，需要多点信息才能继续", "口语化", "优先新发", ["全渠道"]),
      buildTemplateEntry(AckStage.Blocked, "遇到点问题，我处理一下", "积极", "优先新发", ["全渠道"]),
    ],
  ],
  [
    AckStage.ProgressNudge,
    [
      buildTemplateEntry(AckStage.ProgressNudge, "还在处理，当前：{stage_hint}", "带阶段", "优先更新", ["支持 update 的渠道优先"]),
      buildTemplateEntry(AckStage.ProgressNudge, "还没好，再等等", "简短", "优先更新", ["支持 update 的渠道优先"]),
      buildTemplateEntry(AckStage.ProgressNudge, "还在跑，稍等", "口语化", "优先更新", ["支持 update 的渠道优先"]),
      buildTemplateEntry(AckStage.ProgressNudge, "快好了", "积极", "优先更新", ["支持 update 的渠道优先"]),
    ],
  ],
]);

function prefersShortForm(inputs: TemplateSelectionInputs): boolean {
  return inputs.channelCapability === "text_only"
    || inputs.burstState === "active"
    || inputs.userInputActive === true;
}

function selectPreRouteSoftAckTemplate(entries: AckTemplateEntry[], inputs: TemplateSelectionInputs): AckTemplateEntry {
  return prefersShortForm(inputs) ? (entries[1] ?? entries[0]) : entries[0];
}

function selectDelegateStartedTemplate(entries: AckTemplateEntry[], inputs: TemplateSelectionInputs): AckTemplateEntry {
  if (prefersShortForm(inputs) && !inputs.anchorExists) {
    return entries[1] ?? entries[0];
  }
  return entries[0];
}

function selectObserveStartedTemplate(entries: AckTemplateEntry[], inputs: TemplateSelectionInputs): AckTemplateEntry {
  const route = normalizeValue(inputs.route);
  if (route.includes("probe") || route.includes("detect") || route.includes("scan")) {
    return entries[1] ?? entries[0];
  }
  return entries[0];
}

function selectReplySoftAckTemplate(entries: AckTemplateEntry[], inputs: TemplateSelectionInputs): AckTemplateEntry {
  return prefersShortForm(inputs) ? (entries[1] ?? entries[0]) : entries[0];
}

function selectQueuedTemplate(entries: AckTemplateEntry[], inputs: TemplateSelectionInputs): AckTemplateEntry {
  const queueState = normalizeValue(inputs.queueState);
  if (prefersShortForm(inputs) || queueState === "queued" || queueState === "waiting") {
    return entries[1] ?? entries[0];
  }
  return entries[0];
}

function selectBlockedTemplate(entries: AckTemplateEntry[], inputs: TemplateSelectionInputs): AckTemplateEntry {
  return inputs.blockedReason ? entries[0] : (entries[1] ?? entries[0]);
}

function selectProgressNudgeTemplate(entries: AckTemplateEntry[], inputs: TemplateSelectionInputs): AckTemplateEntry {
  if (inputs.stageHint && (inputs.anchorExists || inputs.channelCapability === "update")) {
    return entries[0];
  }
  return entries[1] ?? entries[0];
}

export function selectAckTemplate(stage: AckStage, inputs: TemplateSelectionInputs): AckTemplateEntry | null {
  const entries = ACK_TEMPLATE_POOL.get(stage);
  if (!entries || entries.length === 0) {
    return null;
  }

  switch (stage) {
    case AckStage.PreRouteSoftAck:
      return selectPreRouteSoftAckTemplate(entries, inputs);
    case AckStage.DelegateStarted:
      return selectDelegateStartedTemplate(entries, inputs);
    case AckStage.ObserveStarted:
      return selectObserveStartedTemplate(entries, inputs);
    case AckStage.ReplySoftAck:
      return selectReplySoftAckTemplate(entries, inputs);
    case AckStage.Queued:
      return selectQueuedTemplate(entries, inputs);
    case AckStage.Blocked:
      return selectBlockedTemplate(entries, inputs);
    case AckStage.ProgressNudge:
      return selectProgressNudgeTemplate(entries, inputs);
    default:
      return entries[0] ?? null;
  }
}

export function ackStageText(stage: AckStage, vars?: Record<string, string>): string {
  const entries = ACK_TEMPLATE_POOL.get(stage);
  if (!entries || entries.length === 0) {
    return "";
  }
  const entry = entries[Math.floor(Math.random() * entries.length)];
  return interpolateTemplate(entry.text, vars);
}
