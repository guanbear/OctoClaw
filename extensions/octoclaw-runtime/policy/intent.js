import fsSync from "node:fs";
import path from "node:path";

export const INTENT_PACKET_SCHEMA_VERSION = "octoclaw.intent_packet/v1";

export const INTENT_CLASSES = Object.freeze({
  PLAIN_CHAT: "plain_chat",
  EXECUTION_FOLLOWUP: "execution_followup",
  LOCAL_SURFACE_LOOKUP: "local_surface_lookup",
  FRESH_LIVE_LOOKUP: "fresh_live_lookup",
  DELEGATED_WORK: "delegated_work",
  UNDETERMINED: "undetermined",
});

const META_PROMPT_PATTERNS = [
  /(你是怎么查的|咋查的|如何查的|怎么查到的|用什么查的)/iu,
  /(刚才那个任务.*判定是啥|刚才.*不是\s*runner|是不是\s*runner|是不是\s*spawn_single|是不是\s*single)/iu,
  /(刚才.*(?:single|spawn|runner)\s*成功了吗|(?:single|spawn|runner)\s*成功了吗|那个\s*(?:single|spawn|runner)怎么样了|那个任务怎么样了)/iu,
  /\b(how did you check|how was this checked|was this runner|was this spawn(?:_single)?|did the single succeed)\b/iu,
];

const PROVENANCE_PROMPT_PATTERNS = [
  /(谁查的|谁做的|谁处理的|谁执行的|是不是子任务做的|是不是主agent自己查的)/iu,
  /\b(who handled this|who answered this|was this delegated|was this a subtask)\b/iu,
];

const TASK_PROGRESS_PROMPT_PATTERNS = [
  /((?:single|spawn|runner)\s*成功了吗|任务怎样了|任务怎么样了|现在什么状态|还在\s*queued\s*吗|还在排队吗)/iu,
  /\b(single succeeded|spawn succeeded|runner succeeded|task status|still queued|still running)\b/iu,
];

const SHORT_EXECUTION_FOLLOWUP_SHAPE_RE = /([?？]|吗|么|啥|谁|哪|怎么|如何|状态|进度|成功|完成|判定|查的|做的|处理的|执行的)/iu;
const EXECUTION_REFERENCE_PATTERNS = [
  /(刚才|刚刚|上次|上一条|上一个|前一个|这次|那次).{0,12}(任务|查询|问题|single|spawn|runner|结果|状态|进度|判定|路由|dispatch)/iu,
  /((这个|那个).{0,8}(任务|查询|single|spawn|runner|结果|状态|进度|判定)|才那个任务)/iu,
  /((它|这事|那事).{0,8}(怎么样|状态|进度|成功|完成))/iu,
  /\b(this|that|previous|last)\b.{0,12}\b(task|lookup|query|run|result|status|progress|route|dispatch)\b/iu,
];

const OPERATOR_SURFACE_REGISTRY = [
  {
    surface_id: "runtime_version",
    lane_hint: "runner",
    scope: "local_surface_lookup",
    patterns: [
      /(你现在啥版本|你现在是什么版本|你现在的版本是啥|现在啥版本|现在什么版本|当前.*版本|本机.*版本|openclaw.*版本|版本号)/iu,
      /\b(current version|what version are you|openclaw version|runtime version)\b/iu,
    ],
  },
  {
    surface_id: "control_ui",
    lane_hint: "runner",
    scope: "local_surface_lookup",
    patterns: [
      /(control\s*ui|controlui)/iu,
      /(gateway\s*(ui|status|web)?|网关界面|控制台|web\s*ui|web界面)/iu,
      /((访问|入口|打开|查看).*(地址|url|界面)|(?:地址|url).*(control\s*ui|controlui|gateway|控制台))/iu,
    ],
  },
];

const FRESH_LIVE_LOOKUP_PATTERNS = [
  /(查|查下|查一下|再查|再看|看下|看一下|看看|确认|确认下|确认一下).{0,16}(openclaw|octoclaw).{0,20}(更新|发版|release|版本|changelog|memory|dream)/iu,
  /(openclaw|octoclaw).{0,20}(有啥更新|有什么更新|有没有新的发版|有没有新发版|有没有新的release|有没有新release|最近.*更新|最新.*更新|最近.*发版|最近.*release|新版本)/iu,
  /\b(check|look up|see|verify|confirm)\b.{0,18}\b(openclaw|octoclaw)\b.{0,24}\b(update|updates|release|version|changelog|memory|dream)\b/iu,
  /\b(openclaw|octoclaw)\b.{0,24}\b(new release|latest release|recent updates?|latest updates?|what'?s new|changelog)\b/iu,
];

const DELEGATED_WORK_PATTERNS = [
  /(实现|落地|重构|修复|改代码|写代码|部署|提交|push|测试|回归|设计下.*再做|一口气完成|系统性修复)/iu,
  /\b(implement|refactor|fix|patch|deploy|push|commit|test|regression|systematically fix)\b/iu,
];

const PLAIN_CHAT_PATTERNS = [
  /(是什么|什么意思|怎么理解|简单说说|解释一下|为啥|为什么|目的是什么)/iu,
  /\b(what is|what does|explain|why|meaning|purpose)\b/iu,
];

const EXPLICIT_COMMAND_PATTERNS = [
  /^\s*(?:queue|inbox|status)\s*$/iu,
  /^\s*(?:details?|view|retrieve|result|graph|timeline|artifacts?|stop|retry|approve|reject)\s+[A-Za-z0-9._:/-]+\s*$/iu,
  /^\s*(?:任务详情|任务时间线|任务图|任务结果|任务产物|任务报告|任务停止|任务重试|任务批准|任务拒绝)\s+[A-Za-z0-9._:/-]+\s*$/iu,
];

const TASK_ID_PATTERN = /\b(?:research|runner|spawn|task)-[0-9A-Za-z._:-]+\b/iu;

function normalizeText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function parseTimestamp(value = "") {
  const parsed = new Date(String(value || "").trim());
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

export function readJsonFile(pathname, fallback = {}) {
  try {
    return JSON.parse(fsSync.readFileSync(pathname, "utf8"));
  } catch {
    return fallback;
  }
}

export function readJsonl(pathname) {
  try {
    const raw = fsSync.readFileSync(pathname, "utf8");
    return String(raw || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((item) => item && typeof item === "object");
  } catch {
    return [];
  }
}

export function isMetaPrompt(prompt = "") {
  const text = String(prompt || "").trim();
  if (!text) return false;
  return META_PROMPT_PATTERNS.some((pattern) => pattern.test(text))
    || PROVENANCE_PROMPT_PATTERNS.some((pattern) => pattern.test(text))
    || TASK_PROGRESS_PROMPT_PATTERNS.some((pattern) => pattern.test(text));
}

export function isTaskProgressPrompt(prompt = "") {
  const text = String(prompt || "").trim();
  if (!text) return false;
  return TASK_PROGRESS_PROMPT_PATTERNS.some((pattern) => pattern.test(text));
}

export function isProvenancePrompt(prompt = "") {
  const text = String(prompt || "").trim();
  if (!text) return false;
  return PROVENANCE_PROMPT_PATTERNS.some((pattern) => pattern.test(text))
    || /怎么查/u.test(text)
    || /\bhow did you check\b/iu.test(text);
}

export function isFreshLiveLookupPrompt(prompt = "") {
  const text = String(prompt || "").trim();
  if (!text) return false;
  if (isMetaPrompt(text) || isTaskProgressPrompt(text) || isProvenancePrompt(text)) return false;
  if (/(模型|model)/iu.test(text) && /(版本|version)/iu.test(text) && !/(openclaw|octoclaw)/iu.test(text)) return false;
  return FRESH_LIVE_LOOKUP_PATTERNS.some((pattern) => pattern.test(text));
}

export function inferFreshLookupProject(prompt = "") {
  const text = String(prompt || "").trim();
  if (!text) return "";
  if (/(openclaw)/iu.test(text)) return "openclaw";
  if (/(octoclaw)/iu.test(text)) return "octoclaw";
  return "";
}

export function inferFreshLookupFocus(prompt = "") {
  const text = String(prompt || "").trim();
  if (!text) return "";
  if (/(memory|dream|diary|rem)/iu.test(text)) return "memory";
  if (/(release|发版|版本|更新|changelog|特性|变化|what'?s new)/iu.test(text)) return "release_updates";
  return "latest_updates";
}

export function detectOperatorSurface(prompt = "") {
  const text = String(prompt || "").trim();
  if (!text) return null;
  for (const surface of OPERATOR_SURFACE_REGISTRY) {
    if (surface.surface_id === "runtime_version") {
      if (/(模型|model)/iu.test(text)) continue;
      if (/(新版本|更新|发版|release|changelog|新特性|特性|变化|memory|dream|what'?s new|latest|recent)/iu.test(text)) {
        continue;
      }
    }
    const patterns = Array.isArray(surface?.patterns) ? surface.patterns : [];
    if (patterns.some((pattern) => pattern.test(text))) {
      return {
        surface_id: String(surface.surface_id || "").trim(),
        lane_hint: String(surface.lane_hint || "").trim() || "runner",
        scope: String(surface.scope || "").trim() || "local_surface_lookup",
      };
    }
  }
  return null;
}

export function buildTaskIndex(taskStatePath = "") {
  const payload = readJsonFile(taskStatePath, {});
  const tasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
  const index = new Map();
  for (const task of tasks) {
    const taskId = String(task?.id || "").trim();
    if (taskId) index.set(taskId, task);
  }
  return index;
}

export function deriveTaskEventsPath(taskStatePath = "") {
  const normalized = String(taskStatePath || "").trim();
  if (!normalized) return "";
  return path.join(path.dirname(normalized), "task-events.jsonl");
}

export function deriveDeliveryRelayPath(taskStatePath = "") {
  const normalized = String(taskStatePath || "").trim();
  if (!normalized) return "";
  return path.join(path.dirname(normalized), "delivery-relay.jsonl");
}

export function buildTaskEventIndex(taskEventsPath = "") {
  const events = readJsonl(taskEventsPath);
  const index = new Map();
  for (const event of events) {
    const taskId = String(event?.task_id || "").trim();
    if (!taskId) continue;
    const current = index.get(taskId) || [];
    current.push(event);
    index.set(taskId, current);
  }
  return index;
}

export function buildDeliveryRelayIndex(deliveryRelayPath = "") {
  const events = readJsonl(deliveryRelayPath);
  const index = new Map();
  for (const event of events) {
    const sessionKey = String(event?.sessionKey || "").trim();
    const taskId = String(event?.taskId || "").trim();
    const runnerJobId = String(event?.runnerJobId || "").trim();
    const keys = [
      sessionKey ? `session:${sessionKey}` : "",
      taskId ? `task:${taskId}` : "",
      runnerJobId ? `runner:${runnerJobId}` : "",
    ].filter(Boolean);
    for (const key of keys) {
      const current = index.get(key) || [];
      current.push(event);
      index.set(key, current);
    }
  }
  return index;
}

export function groupedReplayTurns(events = []) {
  const ordered = [...events].sort((left, right) => parseTimestamp(left?.at) - parseTimestamp(right?.at));
  const activeBySession = new Map();
  const turns = [];
  for (const event of ordered) {
    const sessionKey = String(event?.sessionKey || "").trim();
    if (!sessionKey) continue;
    if (String(event?.event || "") === "policy_resolved") {
      const turn = {
        sessionKey,
        sessionId: String(event?.sessionId || "").trim(),
        at: String(event?.at || "").trim(),
        prompt: String(event?.prompt || "").trim(),
        route: String(event?.route || "").trim(),
        taskClass: String(event?.taskClass || "").trim(),
        protectedLane: String(event?.protectedLane || "").trim(),
        events: [event],
      };
      activeBySession.set(sessionKey, turn);
      turns.push(turn);
      continue;
    }
    const current = activeBySession.get(sessionKey);
    if (!current) continue;
    current.events.push(event);
    if (!current.route && event?.route) current.route = String(event.route || "").trim();
    if (!current.taskClass && event?.taskClass) current.taskClass = String(event.taskClass || "").trim();
    if (!current.protectedLane && event?.protectedLane) current.protectedLane = String(event.protectedLane || "").trim();
  }
  return turns;
}

export function latestEvent(turn, eventName) {
  const events = Array.isArray(turn?.events) ? turn.events : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (String(event?.event || "").trim() === eventName) return event;
  }
  return null;
}

export function buildTurnFacts(turn, taskIndex, taskEventIndex = new Map(), deliveryRelayIndex = new Map()) {
  const policyResolved = latestEvent(turn, "policy_resolved");
  const policyJudged = latestEvent(turn, "policy_judged");
  const routeValidated = latestEvent(turn, "route_validated");
  const ackEvent = latestEvent(turn, "ack_sent");
  const cacheHitEvent = latestEvent(turn, "decision_cache_hit");
  const cacheMissEvent = latestEvent(turn, "decision_cache_miss");
  const dispatch = latestEvent(turn, "dispatch_called");
  const agentEnd = latestEvent(turn, "agent_end");
  const directToolEvents = (Array.isArray(turn?.events) ? turn.events : []).filter(
    (event) => ["direct_tool_called", "tool_used"].includes(String(event?.event || "").trim()),
  );
  const materialization = dispatch?.materialization && typeof dispatch.materialization === "object"
    ? dispatch.materialization
    : {};
  const capabilityFailure = dispatch?.capability_failure && typeof dispatch.capability_failure === "object"
    ? dispatch.capability_failure
    : (materialization?.capability_failure && typeof materialization.capability_failure === "object" ? materialization.capability_failure : {});
  const taskId = String(
    dispatch?.taskId
      || materialization?.task_id
      || materialization?.child_spec_id
      || "",
  ).trim();
  const runnerJobId = String(
    dispatch?.runnerJobId
      || materialization?.runner_job_id
      || "",
  ).trim();
  const taskRecordId = String(taskId || runnerJobId || "").trim();
  const task = taskRecordId ? taskIndex.get(taskRecordId) || null : null;
  const artifacts = task?.artifacts && typeof task.artifacts === "object" && !Array.isArray(task.artifacts)
    ? task.artifacts
    : {};
  const runnerPlan = artifacts.runner_plan && typeof artifacts.runner_plan === "object" && !Array.isArray(artifacts.runner_plan)
    ? artifacts.runner_plan
    : {};
  const probeSpec = runnerPlan.probe_spec && typeof runnerPlan.probe_spec === "object" && !Array.isArray(runnerPlan.probe_spec)
    ? runnerPlan.probe_spec
    : {};
  const workerResult = artifacts.worker_result && typeof artifacts.worker_result === "object" && !Array.isArray(artifacts.worker_result)
    ? artifacts.worker_result
    : {};
  const taskEvents = taskRecordId ? (taskEventIndex.get(taskRecordId) || []) : [];
  const latestTaskEvent = taskEvents.length > 0 ? (taskEvents.at(-1) || {}) : {};
  const taskBoundEvent = [...taskEvents].reverse().find((event) => String(event?.kind || "").trim() === "task_bound") || {};
  const runnerStartedEvent = [...taskEvents].reverse().find((event) => String(event?.kind || "").trim() === "runner_started") || {};
  const dispositionEvent = [...taskEvents].reverse().find((event) => ["job_cancelled", "job_superseded"].includes(String(event?.kind || "").trim())) || {};
  const deliveryEvent = [...taskEvents].reverse().find((event) => [
    "delivery_sent",
    "delivery_failed",
    "completion_relay_sent",
    "completion_relay_failed",
    "completion_relay_resolution_failed",
    "user_notified",
  ].includes(String(event?.kind || "").trim())) || {};
  const goalContract = artifacts.goal_contract && typeof artifacts.goal_contract === "object" && !Array.isArray(artifacts.goal_contract)
    ? artifacts.goal_contract
    : (taskBoundEvent?.goal_contract && typeof taskBoundEvent.goal_contract === "object" && !Array.isArray(taskBoundEvent.goal_contract)
      ? taskBoundEvent.goal_contract
      : {});
  const nativeTaskBinding = artifacts.openclaw_taskflow && typeof artifacts.openclaw_taskflow === "object" && !Array.isArray(artifacts.openclaw_taskflow)
    ? artifacts.openclaw_taskflow
    : (taskBoundEvent?.taskflow_binding && typeof taskBoundEvent.taskflow_binding === "object" && !Array.isArray(taskBoundEvent.taskflow_binding)
      ? taskBoundEvent.taskflow_binding
      : {});
  const routeOutcome = dispatch?.routeOutcome && typeof dispatch.routeOutcome === "object" && !Array.isArray(dispatch.routeOutcome)
    ? dispatch.routeOutcome
    : (agentEnd?.routeOutcome && typeof agentEnd.routeOutcome === "object" && !Array.isArray(agentEnd.routeOutcome)
      ? agentEnd.routeOutcome
      : (policyResolved?.routeOutcome && typeof policyResolved.routeOutcome === "object" && !Array.isArray(policyResolved.routeOutcome)
        ? policyResolved.routeOutcome
        : {}));
  const runtimeResolution = dispatch?.runner_runtime_resolution && typeof dispatch.runner_runtime_resolution === "object" && !Array.isArray(dispatch.runner_runtime_resolution)
    ? dispatch.runner_runtime_resolution
    : {};
  const runnerHealthSnapshot = routeOutcome?.runner_health_snapshot && typeof routeOutcome.runner_health_snapshot === "object" && !Array.isArray(routeOutcome.runner_health_snapshot)
    ? routeOutcome.runner_health_snapshot
    : (runtimeResolution?.runner_health_snapshot && typeof runtimeResolution.runner_health_snapshot === "object" && !Array.isArray(runtimeResolution.runner_health_snapshot)
      ? runtimeResolution.runner_health_snapshot
      : {});
  const decisionCacheEvent = cacheHitEvent || cacheMissEvent || null;
  const deliveryRelayEvents = Array.from(
    new Set(
      [
        ...(taskId ? (deliveryRelayIndex.get(`task:${taskId}`) || []) : []),
        ...(runnerJobId ? (deliveryRelayIndex.get(`runner:${runnerJobId}`) || []) : []),
        ...((!taskId && !runnerJobId && turn?.sessionKey) ? (deliveryRelayIndex.get(`session:${String(turn.sessionKey || "").trim()}`) || []) : []),
      ],
    ),
  ).sort((left, right) => parseTimestamp(left?.at) - parseTimestamp(right?.at));
  const finalDeliveryRelayEvent = deliveryRelayEvents.length > 0 ? (deliveryRelayEvents.at(-1) || {}) : {};
  return {
    policyJudgedSeen: Boolean(policyJudged),
    policyJudgeSelected: String(policyJudged?.policyJudgeSelected || policyResolved?.policyJudgeSelected || "").trim(),
    policyJudgeApplied: Boolean(policyJudged?.policyJudgeApplied ?? policyResolved?.policyJudgeApplied),
    policyJudgeInvocationState: String(policyJudged?.policyJudgeInvocationState || policyResolved?.policyJudgeInvocationState || "").trim(),
    policyJudgeConfidence: Number(policyJudged?.policyJudgeConfidence ?? policyResolved?.policyJudgeConfidence ?? 0),
    routeValidatedSeen: Boolean(routeValidated),
    routerDecisionValid: Boolean(routeValidated?.routerDecisionValid ?? policyResolved?.routerDecisionValid),
    routerDecisionSource: String(routeValidated?.routerDecisionSource || policyResolved?.routerDecisionSource || "").trim(),
    validationOutcome: String(routeValidated?.validationOutcome || "").trim(),
    ackSeen: Boolean(ackEvent),
    ackKind: String(ackEvent?.ackKind || "").trim(),
    ackMode: String(ackEvent?.ackMode || "").trim(),
    ackSent: Boolean(ackEvent?.ackSent),
    ackReason: String(ackEvent?.reason || "").trim(),
    decisionCacheState: String(decisionCacheEvent?.decisionCacheState || policyResolved?.decisionCacheState || "").trim(),
    decisionCacheUsed: Boolean(decisionCacheEvent?.usedCachedPolicy ?? policyResolved?.usedCachedPolicy),
    dispatchSeen: Boolean(dispatch),
    dispatchExecuted: Boolean(dispatch?.executed),
    dispatchMode: String(dispatch?.runnerExecutionMode || dispatch?.runner_execution_mode || runtimeResolution?.dispatch_mode || "").trim(),
    delegated: Boolean(agentEnd?.delegated || dispatch?.executed),
    delegationTool: String(agentEnd?.delegationTool || "").trim(),
    materializationStatus: String(materialization?.status || "").trim(),
    executionKind: String(materialization?.kind || "").trim(),
    taskId,
    runnerJobId,
    capabilityFailure,
    capabilityFailureDetail: String(capabilityFailure?.detail || "").trim(),
    taskRecordId,
    directTools: Array.from(
      new Set(
        [
          ...directToolEvents
            .map((event) => String(event?.toolName || "").trim())
            .filter(Boolean),
          ...(Array.isArray(agentEnd?.directToolsSeen)
            ? agentEnd.directToolsSeen.map((item) => String(item || "").trim()).filter(Boolean)
            : []),
        ],
      ),
    ),
    currentTaskStatus: String(task?.status || "").trim(),
    currentTaskSummary: String(task?.summary || "").trim(),
    currentTaskExecutor: String(task?.executor || "").trim(),
    currentTaskRoute: String(task?.route || "").trim(),
    currentTaskRuntime: String(task?.runtime || "").trim(),
    currentTaskReportPath: String(task?.report_path || artifacts.report_path || workerResult.report || "").trim(),
    jobDispositionKind: String(dispositionEvent?.kind || "").trim(),
    jobDispositionMessage: String(dispositionEvent?.message || "").trim(),
    taskBoundSeen: Boolean(taskBoundEvent && Object.keys(taskBoundEvent).length > 0),
    runnerStartedSeen: Boolean(runnerStartedEvent && Object.keys(runnerStartedEvent).length > 0),
    latestTaskEventKind: String(latestTaskEvent?.kind || "").trim(),
    latestTaskEventMessage: String(latestTaskEvent?.message || "").trim(),
    deliveryEventKind: String(deliveryEvent?.kind || "").trim(),
    finalDeliveryRelayEvent: String(finalDeliveryRelayEvent?.event || "").trim(),
    finalDeliveryRelayState: String(finalDeliveryRelayEvent?.state || "").trim(),
    goalExecutionContract: String(goalContract?.execution_contract || "").trim(),
    goalAccessMode: String(goalContract?.access_mode || "").trim(),
    nativeTaskBackend: String(nativeTaskBinding?.backend || goalContract?.native_task_binding?.backend || "").trim(),
    queuePressureBand: String(routeOutcome?.queue_pressure_band || runtimeResolution?.queue_pressure_band || "").trim(),
    runnerHealthReason: String(runnerHealthSnapshot?.reason || "").trim(),
    runnerWorkerId: String(runnerHealthSnapshot?.worker_id || "").trim(),
    runnerPlanKind: String(runnerPlan.kind || "").trim(),
    runnerPlanSummary: String(runnerPlan.summary || "").trim(),
    delegatedProbeKind: String(probeSpec.kind || "").trim(),
    delegatedProbeSource: String(probeSpec.source || "").trim(),
    delegatedProbeProject: String(probeSpec.project || "").trim(),
    delegatedProbeFocus: String(probeSpec.focus || "").trim(),
    task,
  };
}

export function selectSubjectTurn(turns, prompt = "", sessionKeys = []) {
  const normalizedPrompt = normalizeText(prompt);
  const preferredSessionSet = new Set(
    (Array.isArray(sessionKeys) ? sessionKeys : [])
      .map((item) => String(item || "").trim())
      .filter(Boolean),
  );
  const scopedTurns = preferredSessionSet.size > 0
    ? turns.filter((turn) => preferredSessionSet.has(String(turn?.sessionKey || "").trim()))
    : turns;
  const olderTurns = scopedTurns.filter((turn) => normalizeText(turn?.prompt || "") !== normalizedPrompt);
  const nonMetaTurns = olderTurns.filter((turn) => !isMetaPrompt(turn?.prompt || ""));
  const progressPrompt = isTaskProgressPrompt(prompt);
  const provenancePrompt = isProvenancePrompt(prompt);

  if (progressPrompt) {
    const delegatedTurns = nonMetaTurns.filter((turn) => {
      const facts = turn?.facts || {};
      return Boolean(
        facts.dispatchSeen
          || facts.taskId
          || facts.runnerJobId
          || ["runner", "spawn_single", "spawn_multi"].includes(String(turn?.route || "").trim()),
      );
    });
    if (delegatedTurns.length > 0) return delegatedTurns.at(-1) || null;
  }

  if (provenancePrompt) {
    const factualTurns = nonMetaTurns.filter((turn) => {
      const facts = turn?.facts || {};
      return Boolean(facts.dispatchSeen || (facts.directTools || []).length > 0 || turn?.route);
    });
    if (factualTurns.length > 0) return factualTurns.at(-1) || null;
  }

  if (nonMetaTurns.length > 0) return nonMetaTurns.at(-1) || null;
  if (olderTurns.length > 0) return olderTurns.at(-1) || null;
  return null;
}

export function looksLikeShortExecutionFollowup(prompt = "", subjectTurn = null) {
  const text = String(prompt || "").trim();
  if (!text || !subjectTurn) return false;
  if (text.length > 48) return false;
  if (/\r?\n/u.test(text)) return false;
  if (isMetaPrompt(text) || isTaskProgressPrompt(text) || isProvenancePrompt(text)) return true;
  const facts = subjectTurn?.facts || {};
  const hasRecentExecutionContext = Boolean(
    facts.dispatchSeen
      || facts.taskId
      || facts.runnerJobId
      || (facts.directTools || []).length > 0
      || String(subjectTurn?.route || "").trim(),
  );
  return (
    hasRecentExecutionContext
    && SHORT_EXECUTION_FOLLOWUP_SHAPE_RE.test(text)
    && EXECUTION_REFERENCE_PATTERNS.some((pattern) => pattern.test(text))
  );
}

function baseIntentPacket(promptText, overrides = {}) {
  const intentClass = String(overrides.intent_class || INTENT_CLASSES.UNDETERMINED).trim() || INTENT_CLASSES.UNDETERMINED;
  const confidence = Number.isFinite(Number(overrides.confidence))
    ? Math.max(0, Math.min(1, Number(overrides.confidence)))
    : 0;
  return {
    schema_version: INTENT_PACKET_SCHEMA_VERSION,
    available: true,
    intent_class: intentClass,
    confidence,
    source: String(overrides.source || "deterministic_front_gate").trim(),
    reason_codes: Array.isArray(overrides.reason_codes) ? overrides.reason_codes.filter(Boolean) : [],
    prompt_shape: {
      chars: promptText.length,
      has_newline: /\r?\n/u.test(promptText),
    },
    ack: {
      required: Boolean(overrides.ack_required),
      timing: overrides.ack_required ? "pre_dispatch" : "none",
      text: String(overrides.ack_text || "").trim(),
    },
    lane: {
      route_hint: String(overrides.route_hint || "").trim(),
      lane_hint: String(overrides.lane_hint || "").trim(),
      protected_lane: String(overrides.protected_lane || "").trim(),
      grounding_required: Boolean(overrides.grounding_required),
    },
    lookup: {
      scope: String(overrides.lookup_scope || "").trim(),
      project: String(overrides.lookup_project || "").trim(),
      focus: String(overrides.lookup_focus || "").trim(),
      surface_id: String(overrides.surface_id || "").trim(),
      require_fresh_lookup: Boolean(overrides.require_fresh_lookup),
    },
    signals: overrides.signals && typeof overrides.signals === "object" && !Array.isArray(overrides.signals)
      ? { ...overrides.signals }
      : {},
    judge: {
      eligible: Boolean(overrides.judge_eligible),
      reason: String(overrides.judge_reason || "").trim(),
    },
    subject: overrides.subject && typeof overrides.subject === "object" ? { ...overrides.subject } : {},
  };
}

function uniqueMatches(promptText, patterns = [], label = "") {
  const hits = [];
  for (const pattern of patterns) {
    if (pattern.test(promptText)) hits.push(label || String(pattern));
  }
  return [...new Set(hits)];
}

export function buildSignalPacket(prompt = "") {
  const promptText = String(prompt || "").trim();
  const operatorSurface = detectOperatorSurface(promptText);
  const taskIdMatch = promptText.match(TASK_ID_PATTERN);
  const possibleFreshLookup = isFreshLiveLookupPrompt(promptText);
  return {
    schema_version: "octoclaw.signal_packet/v1",
    prompt_shape: {
      chars: promptText.length,
      has_newline: /\r?\n/u.test(promptText),
    },
    explicit_command: EXPLICIT_COMMAND_PATTERNS.some((pattern) => pattern.test(promptText)),
    task_id: taskIdMatch ? String(taskIdMatch[0] || "").trim() : "",
    surface_mentions: operatorSurface ? [operatorSurface.surface_id] : [],
    target_mentions: [
      /mac\s*mini|macmini/iu.test(promptText) ? "macmini" : "",
      /ai\.guanbear\.com/iu.test(promptText) ? "ai.guanbear.com" : "",
      /(远程|远端|remote)/iu.test(promptText) ? "remote" : "",
      /(本机|本地|当前机器|local)/iu.test(promptText) ? "local" : "",
    ].filter(Boolean),
    lookup_mentions: possibleFreshLookup ? [{
      project: inferFreshLookupProject(promptText),
      focus: inferFreshLookupFocus(promptText),
      source_hint: "natural_language_live_lookup",
    }] : [],
    work_shape_mentions: uniqueMatches(promptText, DELEGATED_WORK_PATTERNS, "delegated_work_shape"),
    chat_shape_mentions: uniqueMatches(promptText, PLAIN_CHAT_PATTERNS, "plain_chat_shape"),
    needs_semantic_judge: true,
  };
}

function buildExecutionFollowupPacket(promptText, subjectTurn) {
  const facts = subjectTurn?.facts || {};
  return baseIntentPacket(promptText, {
    intent_class: INTENT_CLASSES.EXECUTION_FOLLOWUP,
    confidence: 0.92,
    reason_codes: ["recent_execution_followup"],
    route_hint: "direct",
    lane_hint: "control_observer",
    protected_lane: "control_observer",
    grounding_required: true,
    subject: {
      prompt: String(subjectTurn?.prompt || "").trim(),
      route: String(subjectTurn?.route || "").trim(),
      task_class: String(subjectTurn?.taskClass || "").trim(),
      preferred_task_id: String(facts.taskId || "").trim(),
      runner_job_id: String(facts.runnerJobId || "").trim(),
    },
  });
}

export function buildIntentPacket({
  prompt = "",
  replayLogPath = "",
  taskStatePath = "",
  sessionKeys = [],
} = {}) {
  const promptText = String(prompt || "").trim();
  if (!promptText) {
    return {
      schema_version: INTENT_PACKET_SCHEMA_VERSION,
      available: false,
      intent_class: INTENT_CLASSES.UNDETERMINED,
      confidence: 0,
      source: "deterministic_front_gate",
      reason_codes: ["empty_prompt"],
    };
  }
  const signals = buildSignalPacket(promptText);

  const turns = groupedReplayTurns(readJsonl(replayLogPath));
  const taskIndex = buildTaskIndex(taskStatePath);
  const taskEventIndex = buildTaskEventIndex(deriveTaskEventsPath(taskStatePath));
  const deliveryRelayIndex = buildDeliveryRelayIndex(deriveDeliveryRelayPath(taskStatePath));
  const enrichedTurns = turns.map((turn) => ({ ...turn, facts: buildTurnFacts(turn, taskIndex, taskEventIndex, deliveryRelayIndex) }));
  const subjectTurn = selectSubjectTurn(enrichedTurns, promptText, sessionKeys);
  if (subjectTurn && looksLikeShortExecutionFollowup(promptText, subjectTurn)) {
    return buildExecutionFollowupPacket(promptText, subjectTurn);
  }

  return baseIntentPacket(promptText, {
    intent_class: INTENT_CLASSES.UNDETERMINED,
    confidence: 0.3,
    reason_codes: signals.explicit_command ? ["explicit_command_needs_router_decision"] : ["semantic_judge_required"],
    signals,
    judge_eligible: true,
    judge_reason: signals.explicit_command ? "explicit_command_scope_validation" : "natural_language_semantic_scope_route_required",
  });
}

export function conversationControlFromIntentPacket(intentPacket = {}) {
  const intentClass = String(intentPacket?.intent_class || "").trim();
  const reason = Array.isArray(intentPacket?.reason_codes) && intentPacket.reason_codes.length > 0
    ? String(intentPacket.reason_codes[0] || "").trim()
    : "intent_packet";
  const lookup = intentPacket?.lookup && typeof intentPacket.lookup === "object" ? intentPacket.lookup : {};
  const lane = intentPacket?.lane && typeof intentPacket.lane === "object" ? intentPacket.lane : {};
  const subject = intentPacket?.subject && typeof intentPacket.subject === "object" ? intentPacket.subject : {};
  const base = {
    available: true,
    kind: intentClass,
    intent_class: intentClass,
    reason,
    intent_packet: intentPacket,
  };

  if (intentClass === INTENT_CLASSES.EXECUTION_FOLLOWUP) {
    return {
      ...base,
      protected_lane: "control_observer",
      route_hint: "direct",
      require_state_grounding: true,
      subject_prompt: String(subject.prompt || "").trim(),
      subject_route: String(subject.route || "").trim(),
      subject_task_class: String(subject.task_class || "").trim(),
      preferred_task_id: String(subject.preferred_task_id || "").trim(),
    };
  }

  return {
    available: false,
    reason: reason || "intent_not_projected_to_conversation_control",
    intent_packet: intentPacket,
  };
}
