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
      buildTemplateEntry(
        AckStage.PreRouteSoftAck,
        "已收到，正在判断处理方式",
        "已收到，正在判断处理方式",
        "优先短提示；后续被稳定 route 覆盖",
        ["聊天渠道优先"],
      ),
      buildTemplateEntry(
        AckStage.PreRouteSoftAck,
        "收到，稍等",
        "简短安抚",
        "优先短提示；后续被稳定 route 覆盖",
        ["聊天渠道优先"],
      ),
    ],
  ],
  [
    AckStage.DelegateStarted,
    [
      buildTemplateEntry(
        AckStage.DelegateStarted,
        "已接单，开始处理",
        "已接单，开始处理",
        "优先新发或创建 anchor",
        ["全渠道"],
      ),
      buildTemplateEntry(
        AckStage.DelegateStarted,
        "收到，正在处理",
        "简短确认已进入处理",
        "优先新发或创建 anchor",
        ["全渠道"],
      ),
    ],
  ],
  [
    AckStage.ObserveStarted,
    [
      buildTemplateEntry(
        AckStage.ObserveStarted,
        "已开始检查",
        "已开始检查",
        "可新发，也可轻量提示",
        ["全渠道"],
      ),
      buildTemplateEntry(
        AckStage.ObserveStarted,
        "已开始探测",
        "已开始探测",
        "可新发，也可轻量提示",
        ["全渠道"],
      ),
    ],
  ],
  [
    AckStage.ReplySoftAck,
    [
      buildTemplateEntry(
        AckStage.ReplySoftAck,
        "已收到，正在组织回复",
        "已收到，正在组织回复",
        "优先短提示；后续由正式回复覆盖",
        ["聊天渠道优先"],
      ),
      buildTemplateEntry(
        AckStage.ReplySoftAck,
        "收到，稍等",
        "简短安抚",
        "优先短提示；后续由正式回复覆盖",
        ["聊天渠道优先"],
      ),
    ],
  ],
  [
    AckStage.Queued,
    [
      buildTemplateEntry(
        AckStage.Queued,
        "已接单，正在等待处理容量",
        "已接单，但在等待容量",
        "优先更新已有 anchor",
        ["全渠道"],
      ),
      buildTemplateEntry(
        AckStage.Queued,
        "已收到，排队中",
        "简短提示排队中",
        "优先更新已有 anchor",
        ["全渠道"],
      ),
    ],
  ],
  [
    AckStage.Blocked,
    [
      buildTemplateEntry(
        AckStage.Blocked,
        "处理受阻：{reason}",
        "当前卡在具体阻塞原因上",
        "优先新发明确说明",
        ["全渠道"],
      ),
      buildTemplateEntry(
        AckStage.Blocked,
        "当前需要额外信息才能继续",
        "说明需要额外信息",
        "优先新发明确说明",
        ["全渠道"],
      ),
    ],
  ],
  [
    AckStage.ProgressNudge,
    [
      buildTemplateEntry(
        AckStage.ProgressNudge,
        "还在处理中，当前阶段：{stage_hint}",
        "说明仍在处理并带当前阶段",
        "优先更新已有 anchor",
        ["支持 update 的渠道优先"],
      ),
      buildTemplateEntry(
        AckStage.ProgressNudge,
        "仍在处理，请稍候",
        "简短提示仍在处理",
        "优先更新已有 anchor",
        ["支持 update 的渠道优先"],
      ),
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
  const entry = ACK_TEMPLATE_POOL.get(stage)?.[0];
  return entry ? interpolateTemplate(entry.text, vars) : "";
}
