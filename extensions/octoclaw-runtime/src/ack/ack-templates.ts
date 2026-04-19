export enum AckStage {
  PreRouteSoftAck = "pre_route_soft_ack",
  DelegateStarted = "delegate_started",
  ObserveStarted = "observe_started",
  ReplySoftAck = "reply_soft_ack",
  Queued = "queued",
  Blocked = "blocked",
  ProgressNudge = "progress_nudge",
  ToolStillWorking = "tool_still_working",
  ToolComplexTask = "tool_complex_task",
  ToolAskContinue = "tool_ask_continue",
  ToolSuggestStop = "tool_suggest_stop",
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
      buildTemplateEntry(AckStage.PreRouteSoftAck, "来了", "极简", "优先短提示", ["聊天渠道优先"]),
      buildTemplateEntry(AckStage.PreRouteSoftAck, "稍等我瞅瞅", "随意", "优先短提示", ["聊天渠道优先"]),
      buildTemplateEntry(AckStage.PreRouteSoftAck, "我看下", "简短", "优先短提示", ["聊天渠道优先"]),
      buildTemplateEntry(AckStage.PreRouteSoftAck, "马上看", "积极", "优先短提示", ["聊天渠道优先"]),
      buildTemplateEntry(AckStage.PreRouteSoftAck, "嗯", "极简", "优先短提示", ["聊天渠道优先"]),
      buildTemplateEntry(AckStage.PreRouteSoftAck, "好", "极简", "优先短提示", ["聊天渠道优先"]),
      buildTemplateEntry(AckStage.PreRouteSoftAck, "在", "极简", "优先短提示", ["聊天渠道优先"]),
      buildTemplateEntry(AckStage.PreRouteSoftAck, "收到", "简洁", "优先短提示", ["聊天渠道优先"]),
      buildTemplateEntry(AckStage.PreRouteSoftAck, "明白", "确认", "优先短提示", ["聊天渠道优先"]),
      buildTemplateEntry(AckStage.PreRouteSoftAck, "知道啦", "口语", "优先短提示", ["聊天渠道优先"]),
      buildTemplateEntry(AckStage.PreRouteSoftAck, "看了", "简洁", "优先短提示", ["聊天渠道优先"]),
      buildTemplateEntry(AckStage.PreRouteSoftAck, "哦", "极简", "优先短提示", ["聊天渠道优先"]),
      buildTemplateEntry(AckStage.PreRouteSoftAck, "咋了", "口语", "优先短提示", ["聊天渠道优先"]),
    ],
  ],
  [
    AckStage.DelegateStarted,
    [
      buildTemplateEntry(AckStage.DelegateStarted, "收到，开始处理", "自然确认", "优先新发", ["全渠道"]),
      buildTemplateEntry(AckStage.DelegateStarted, "好的，我来处理", "口语化", "优先新发", ["全渠道"]),
      buildTemplateEntry(AckStage.DelegateStarted, "着手处理中", "简洁", "优先新发", ["全渠道"]),
      buildTemplateEntry(AckStage.DelegateStarted, "了解了，正在跟进", "正式", "优先新发", ["全渠道"]),
      buildTemplateEntry(AckStage.DelegateStarted, "好嘞，搞起来", "轻松", "优先新发", ["全渠道"]),
      buildTemplateEntry(AckStage.DelegateStarted, "在跑了", "简短", "优先新发", ["全渠道"]),
      buildTemplateEntry(AckStage.DelegateStarted, "这就去", "积极", "优先新发", ["全渠道"]),
      buildTemplateEntry(AckStage.DelegateStarted, "开始搞了", "口语", "优先新发", ["全渠道"]),
      buildTemplateEntry(AckStage.DelegateStarted, "在处理了", "简洁", "优先新发", ["全渠道"]),
      buildTemplateEntry(AckStage.DelegateStarted, "分配下去了", "正式", "优先新发", ["全渠道"]),
      buildTemplateEntry(AckStage.DelegateStarted, "在跑了，稍等结果", "口语", "优先新发", ["全渠道"]),
      buildTemplateEntry(AckStage.DelegateStarted, "搞起来", "轻松", "优先新发", ["全渠道"]),
      buildTemplateEntry(AckStage.DelegateStarted, "开工", "简洁", "优先新发", ["全渠道"]),
      buildTemplateEntry(AckStage.DelegateStarted, "这就安排", "积极", "优先新发", ["全渠道"]),
      buildTemplateEntry(AckStage.DelegateStarted, "在弄了，放心", "安抚", "优先新发", ["全渠道"]),
      buildTemplateEntry(AckStage.DelegateStarted, "已经开始", "中性", "优先新发", ["全渠道"]),
    ],
  ],
  [
    AckStage.ObserveStarted,
    [
      buildTemplateEntry(AckStage.ObserveStarted, "正在查看", "简洁", "可新发", ["全渠道"]),
      buildTemplateEntry(AckStage.ObserveStarted, "看下情况", "口语化", "可新发", ["全渠道"]),
      buildTemplateEntry(AckStage.ObserveStarted, "在查了", "最短", "可新发", ["全渠道"]),
      buildTemplateEntry(AckStage.ObserveStarted, "检查中", "中性", "可新发", ["全渠道"]),
      buildTemplateEntry(AckStage.ObserveStarted, "扫一眼", "随意", "可新发", ["全渠道"]),
      buildTemplateEntry(AckStage.ObserveStarted, "看下", "极简", "可新发", ["全渠道"]),
      buildTemplateEntry(AckStage.ObserveStarted, "查一下", "简洁", "可新发", ["全渠道"]),
      buildTemplateEntry(AckStage.ObserveStarted, "在扫了", "口语", "可新发", ["全渠道"]),
      buildTemplateEntry(AckStage.ObserveStarted, "探测中", "中性", "可新发", ["全渠道"]),
      buildTemplateEntry(AckStage.ObserveStarted, "看看啥情况", "口语", "可新发", ["全渠道"]),
      buildTemplateEntry(AckStage.ObserveStarted, "排查中", "正式", "可新发", ["全渠道"]),
      buildTemplateEntry(AckStage.ObserveStarted, "扫一眼就回", "轻松", "可新发", ["全渠道"]),
      buildTemplateEntry(AckStage.ObserveStarted, "查收中", "中性", "可新发", ["全渠道"]),
      buildTemplateEntry(AckStage.ObserveStarted, "在看了，马上", "积极", "可新发", ["全渠道"]),
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
      buildTemplateEntry(AckStage.ReplySoftAck, "来了，我组织一下", "自然", "优先短提示", ["聊天渠道优先"]),
      buildTemplateEntry(AckStage.ReplySoftAck, "看到", "极简", "优先短提示", ["聊天渠道优先"]),
      buildTemplateEntry(AckStage.ReplySoftAck, "等我一下", "口语", "优先短提示", ["聊天渠道优先"]),
      buildTemplateEntry(AckStage.ReplySoftAck, "马上", "简洁积极", "优先短提示", ["聊天渠道优先"]),
      buildTemplateEntry(AckStage.ReplySoftAck, "在想，稍等", "说明状态", "优先短提示", ["聊天渠道优先"]),
      buildTemplateEntry(AckStage.ReplySoftAck, "好的我看看", "随和", "优先短提示", ["聊天渠道优先"]),
      buildTemplateEntry(AckStage.ReplySoftAck, "嗯嗯", "极简", "优先短提示", ["聊天渠道优先"]),
      buildTemplateEntry(AckStage.ReplySoftAck, "在呢", "极简", "优先短提示", ["聊天渠道优先"]),
      buildTemplateEntry(AckStage.ReplySoftAck, "好，想一下", "口语", "优先短提示", ["聊天渠道优先"]),
      buildTemplateEntry(AckStage.ReplySoftAck, "收到收到", "热情", "优先短提示", ["聊天渠道优先"]),
      buildTemplateEntry(AckStage.ReplySoftAck, "稍等哈", "口语", "优先短提示", ["聊天渠道优先"]),
      buildTemplateEntry(AckStage.ReplySoftAck, "来了来了", "轻松", "优先短提示", ["聊天渠道优先"]),
      buildTemplateEntry(AckStage.ReplySoftAck, "让我想想", "自然", "优先短提示", ["聊天渠道优先"]),
      buildTemplateEntry(AckStage.ReplySoftAck, "好滴", "可爱", "优先短提示", ["聊天渠道优先"]),
      buildTemplateEntry(AckStage.ReplySoftAck, "马上回你", "积极", "优先短提示", ["聊天渠道优先"]),
      buildTemplateEntry(AckStage.ReplySoftAck, "在想", "简洁", "优先短提示", ["聊天渠道优先"]),
      buildTemplateEntry(AckStage.ReplySoftAck, "看下怎么回你", "口语", "优先短提示", ["聊天渠道优先"]),
      buildTemplateEntry(AckStage.ReplySoftAck, "稍等，组织下语言", "说明状态", "优先短提示", ["聊天渠道优先"]),
      buildTemplateEntry(AckStage.ReplySoftAck, "哦？让我看看", "好奇", "优先短提示", ["聊天渠道优先"]),
      buildTemplateEntry(AckStage.ReplySoftAck, "有意思，想一下", "兴趣", "优先短提示", ["聊天渠道优先"]),
      buildTemplateEntry(AckStage.ReplySoftAck, "好嘞，等我一下", "轻松", "优先短提示", ["聊天渠道优先"]),
      buildTemplateEntry(AckStage.ReplySoftAck, "嗯，在想了", "说明状态", "优先短提示", ["聊天渠道优先"]),
      buildTemplateEntry(AckStage.ReplySoftAck, "在看", "简洁", "优先短提示", ["聊天渠道优先"]),
      buildTemplateEntry(AckStage.ReplySoftAck, "稍后回你", "中性", "优先短提示", ["聊天渠道优先"]),
      buildTemplateEntry(AckStage.ReplySoftAck, "等一下下", "口语", "优先短提示", ["聊天渠道优先"]),
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
  [
    AckStage.ToolStillWorking,
    [
      buildTemplateEntry(AckStage.ToolStillWorking, "还在处理中，快了", "安慰", "优先更新", ["全渠道"]),
      buildTemplateEntry(AckStage.ToolStillWorking, "还在跑，别急", "口语安慰", "优先更新", ["全渠道"]),
      buildTemplateEntry(AckStage.ToolStillWorking, "处理中，稍等一下", "中性", "优先更新", ["全渠道"]),
      buildTemplateEntry(AckStage.ToolStillWorking, "在干活了，马上好", "积极", "优先更新", ["全渠道"]),
      buildTemplateEntry(AckStage.ToolStillWorking, "还在弄，别走开", "轻松", "优先更新", ["全渠道"]),
      buildTemplateEntry(AckStage.ToolStillWorking, "还在跑，快了快了", "安慰", "优先更新", ["全渠道"]),
      buildTemplateEntry(AckStage.ToolStillWorking, "别急，马上好", "口语", "优先更新", ["全渠道"]),
      buildTemplateEntry(AckStage.ToolStillWorking, "处理中...", "中性", "优先更新", ["全渠道"]),
      buildTemplateEntry(AckStage.ToolStillWorking, "再等一下", "简洁", "优先更新", ["全渠道"]),
      buildTemplateEntry(AckStage.ToolStillWorking, "耐心等一下哈", "口语", "优先更新", ["全渠道"]),
      buildTemplateEntry(AckStage.ToolStillWorking, "还在弄", "简洁", "优先更新", ["全渠道"]),
    ],
  ],
  [
    AckStage.ToolComplexTask,
    [
      buildTemplateEntry(AckStage.ToolComplexTask, "这个任务有点复杂，需要多一点时间", "说明情况", "优先更新", ["全渠道"]),
      buildTemplateEntry(AckStage.ToolComplexTask, "任务比预期复杂，再等等", "口语", "优先更新", ["全渠道"]),
      buildTemplateEntry(AckStage.ToolComplexTask, "内容比较多，还在处理", "中性", "优先更新", ["全渠道"]),
      buildTemplateEntry(AckStage.ToolComplexTask, "比较复杂，多给我一点时间", "请求理解", "优先更新", ["全渠道"]),
      buildTemplateEntry(AckStage.ToolComplexTask, "这活儿有点多，多等我一会儿", "口语", "优先更新", ["全渠道"]),
      buildTemplateEntry(AckStage.ToolComplexTask, "量有点大，慢慢来", "轻松", "优先更新", ["全渠道"]),
      buildTemplateEntry(AckStage.ToolComplexTask, "内容多，处理中", "中性", "优先更新", ["全渠道"]),
      buildTemplateEntry(AckStage.ToolComplexTask, "复杂任务，需要点时间", "说明情况", "优先更新", ["全渠道"]),
    ],
  ],
  [
    AckStage.ToolAskContinue,
    [
      buildTemplateEntry(AckStage.ToolAskContinue, "已经处理挺久了，要继续等吗？", "询问", "优先更新", ["全渠道"]),
      buildTemplateEntry(AckStage.ToolAskContinue, "跑的时间有点长了，要不要我先停了？", "口语询问", "优先更新", ["全渠道"]),
      buildTemplateEntry(AckStage.ToolAskContinue, "处理超时了，需要我继续还是停掉？", "直接选择", "优先更新", ["全渠道"]),
    ],
  ],
  [
    AckStage.ToolSuggestStop,
    [
      buildTemplateEntry(AckStage.ToolSuggestStop, "可能卡住了，建议我先停掉这个任务", "建议停止", "优先更新", ["全渠道"]),
      buildTemplateEntry(AckStage.ToolSuggestStop, "处理太久了，大概率遇到问题，建议停掉", "明确建议", "优先更新", ["全渠道"]),
      buildTemplateEntry(AckStage.ToolSuggestStop, "严重超时，建议放弃当前操作重新来", "强烈建议", "优先更新", ["全渠道"]),
    ],
  ],
]);

function randomFrom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function selectPreRouteSoftAckTemplate(entries: AckTemplateEntry[], _inputs: TemplateSelectionInputs): AckTemplateEntry {
  return randomFrom(entries);
}

function selectDelegateStartedTemplate(entries: AckTemplateEntry[], _inputs: TemplateSelectionInputs): AckTemplateEntry {
  return randomFrom(entries);
}

function selectObserveStartedTemplate(entries: AckTemplateEntry[], _inputs: TemplateSelectionInputs): AckTemplateEntry {
  return randomFrom(entries);
}

function selectReplySoftAckTemplate(entries: AckTemplateEntry[], _inputs: TemplateSelectionInputs): AckTemplateEntry {
  return randomFrom(entries);
}

function selectQueuedTemplate(entries: AckTemplateEntry[], _inputs: TemplateSelectionInputs): AckTemplateEntry {
  return randomFrom(entries);
}

function selectBlockedTemplate(entries: AckTemplateEntry[], inputs: TemplateSelectionInputs): AckTemplateEntry {
  if (inputs.blockedReason) {
    const withReason = entries.filter((e) => e.text.includes("{reason}"));
    return withReason.length > 0 ? randomFrom(withReason) : randomFrom(entries);
  }
  const withoutReason = entries.filter((e) => !e.text.includes("{reason}"));
  return withoutReason.length > 0 ? randomFrom(withoutReason) : randomFrom(entries);
}

function selectProgressNudgeTemplate(entries: AckTemplateEntry[], inputs: TemplateSelectionInputs): AckTemplateEntry {
  if (inputs.stageHint && (inputs.anchorExists || inputs.channelCapability === "update")) {
    const withHint = entries.filter((e) => e.text.includes("{stage_hint}"));
    return withHint.length > 0 ? randomFrom(withHint) : randomFrom(entries);
  }
  return randomFrom(entries);
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
    case AckStage.ToolStillWorking:
    case AckStage.ToolComplexTask:
    case AckStage.ToolAskContinue:
    case AckStage.ToolSuggestStop:
      return randomFrom(entries);
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
