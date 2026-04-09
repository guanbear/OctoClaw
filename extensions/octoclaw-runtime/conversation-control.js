import fsSync from "node:fs";

const META_PROMPT_PATTERNS = [
  /(你是怎么查的|咋查的|如何查的|怎么查到的|用什么查的)/iu,
  /(刚才那个任务.*判定是啥|刚才.*不是\s*runner|是不是\s*runner|是不是\s*spawn_single|是不是\s*single)/iu,
  /(刚才.*single成功了吗|spawn成功了吗|runner成功了吗|那个single怎么样了|那个任务怎么样了)/iu,
  /\b(how did you check|how was this checked|was this runner|was this spawn(?:_single)?|did the single succeed)\b/iu,
];

const PROVENANCE_PROMPT_PATTERNS = [
  /(谁查的|谁做的|谁处理的|谁执行的|是不是子任务做的|是不是主agent自己查的)/iu,
  /\b(who handled this|who answered this|was this delegated|was this a subtask)\b/iu,
];

const TASK_PROGRESS_PROMPT_PATTERNS = [
  /(single成功了吗|spawn成功了吗|runner成功了吗|任务怎样了|任务怎么样了|现在什么状态|还在queued吗|还在排队吗)/iu,
  /\b(single succeeded|spawn succeeded|runner succeeded|task status|still queued|still running)\b/iu,
];

const SHORT_EXECUTION_FOLLOWUP_SHAPE_RE = /([?？]|吗|么|啥|谁|哪|怎么|如何|状态|进度|成功|完成|判定|查的|做的|处理的|执行的)/iu;

const OPERATOR_SURFACE_REGISTRY = [
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

function normalizeText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function parseTimestamp(value = "") {
  const parsed = new Date(String(value || "").trim());
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

function readJsonFile(pathname, fallback = {}) {
  try {
    return JSON.parse(fsSync.readFileSync(pathname, "utf8"));
  } catch {
    return fallback;
  }
}

function readJsonl(pathname) {
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

function isMetaPrompt(prompt = "") {
  const text = String(prompt || "").trim();
  if (!text) return false;
  return META_PROMPT_PATTERNS.some((pattern) => pattern.test(text))
    || PROVENANCE_PROMPT_PATTERNS.some((pattern) => pattern.test(text))
    || TASK_PROGRESS_PROMPT_PATTERNS.some((pattern) => pattern.test(text));
}

function isTaskProgressPrompt(prompt = "") {
  const text = String(prompt || "").trim();
  if (!text) return false;
  return TASK_PROGRESS_PROMPT_PATTERNS.some((pattern) => pattern.test(text));
}

function isProvenancePrompt(prompt = "") {
  const text = String(prompt || "").trim();
  if (!text) return false;
  return PROVENANCE_PROMPT_PATTERNS.some((pattern) => pattern.test(text))
    || /怎么查/u.test(text)
    || /\bhow did you check\b/iu.test(text);
}

function detectOperatorSurface(prompt = "") {
  const text = String(prompt || "").trim();
  if (!text) return null;
  for (const surface of OPERATOR_SURFACE_REGISTRY) {
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

function buildTaskIndex(taskStatePath = "") {
  const payload = readJsonFile(taskStatePath, {});
  const tasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
  const index = new Map();
  for (const task of tasks) {
    const taskId = String(task?.id || "").trim();
    if (taskId) {
      index.set(taskId, task);
    }
  }
  return index;
}

function groupedReplayTurns(events = []) {
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

function latestEvent(turn, eventName) {
  const events = Array.isArray(turn?.events) ? turn.events : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (String(event?.event || "").trim() === eventName) {
      return event;
    }
  }
  return null;
}

function buildTurnFacts(turn, taskIndex) {
  const dispatch = latestEvent(turn, "dispatch_called");
  const agentEnd = latestEvent(turn, "agent_end");
  const directToolEvents = (Array.isArray(turn?.events) ? turn.events : []).filter(
    (event) => String(event?.event || "").trim() === "direct_tool_called",
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
  const task = taskId ? taskIndex.get(taskId) || null : null;
  return {
    dispatchSeen: Boolean(dispatch),
    dispatchExecuted: Boolean(dispatch?.executed),
    delegated: Boolean(agentEnd?.delegated || dispatch?.executed),
    delegationTool: String(agentEnd?.delegationTool || "").trim(),
    materializationStatus: String(materialization?.status || "").trim(),
    executionKind: String(materialization?.kind || "").trim(),
    taskId,
    runnerJobId,
    capabilityFailure,
    directTools: Array.from(
      new Set(
        directToolEvents
          .map((event) => String(event?.toolName || "").trim())
          .filter(Boolean),
      ),
    ),
    currentTaskStatus: String(task?.status || "").trim(),
    currentTaskSummary: String(task?.summary || "").trim(),
    currentTaskExecutor: String(task?.executor || "").trim(),
    currentTaskRoute: String(task?.route || "").trim(),
    currentTaskRuntime: String(task?.runtime || "").trim(),
    task,
  };
}

function selectSubjectTurn(turns, prompt = "", sessionKeys = []) {
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

function looksLikeShortExecutionFollowup(prompt = "", subjectTurn = null) {
  const text = String(prompt || "").trim();
  if (!text || !subjectTurn) return false;
  if (text.length > 48) return false;
  if (/\r?\n/u.test(text)) return false;
  if (isMetaPrompt(text) || isTaskProgressPrompt(text) || isProvenancePrompt(text)) {
    return true;
  }
  const facts = subjectTurn?.facts || {};
  const hasRecentExecutionContext = Boolean(
    facts.dispatchSeen
      || facts.taskId
      || facts.runnerJobId
      || (facts.directTools || []).length > 0
      || String(subjectTurn?.route || "").trim(),
  );
  return hasRecentExecutionContext && SHORT_EXECUTION_FOLLOWUP_SHAPE_RE.test(text);
}

export function buildConversationControlHints({
  prompt = "",
  replayLogPath = "",
  taskStatePath = "",
  sessionKeys = [],
} = {}) {
  const promptText = String(prompt || "").trim();
  if (!promptText) {
    return { available: false, reason: "empty_prompt" };
  }

  const operatorSurface = detectOperatorSurface(promptText);
  if (operatorSurface) {
    return {
      available: true,
      kind: "local_surface_lookup",
      reason: "operator_surface_registry",
      surface_id: operatorSurface.surface_id,
      lane_hint: operatorSurface.lane_hint,
      scope: operatorSurface.scope,
      require_fresh_lookup: true,
    };
  }

  const turns = groupedReplayTurns(readJsonl(replayLogPath));
  const taskIndex = buildTaskIndex(taskStatePath);
  const enrichedTurns = turns.map((turn) => ({ ...turn, facts: buildTurnFacts(turn, taskIndex) }));
  const subjectTurn = selectSubjectTurn(enrichedTurns, promptText, sessionKeys);
  if (!subjectTurn) {
    return { available: false, reason: "no_recent_subject_turn" };
  }
  if (!looksLikeShortExecutionFollowup(promptText, subjectTurn)) {
    return { available: false, reason: "no_followup_signal" };
  }

  const facts = subjectTurn.facts || {};
  const preferredTaskId = String(facts.taskId || "").trim();
  return {
    available: true,
    kind: "task_followup",
    reason: "recent_execution_followup",
    protected_lane: "control_observer",
    route_hint: "direct",
    require_state_grounding: true,
    subject_prompt: String(subjectTurn.prompt || "").trim(),
    subject_route: String(subjectTurn.route || "").trim(),
    subject_task_class: String(subjectTurn.taskClass || "").trim(),
    preferred_task_id: preferredTaskId,
  };
}

export function buildConversationGrounding({
  prompt = "",
  replayLogPath = "",
  taskStatePath = "",
  sessionKeys = [],
} = {}) {
  const turns = groupedReplayTurns(readJsonl(replayLogPath));
  const taskIndex = buildTaskIndex(taskStatePath);
  const enrichedTurns = turns.map((turn) => ({ ...turn, facts: buildTurnFacts(turn, taskIndex) }));
  const subjectTurn = selectSubjectTurn(enrichedTurns, prompt, sessionKeys);
  if (!subjectTurn) {
    return {
      available: false,
      reason: "no_recent_subject_turn",
      context: [
        "[OctoClaw grounded follow-up]",
        "No reliable execution facts were recovered for this follow-up.",
        "Do not answer from memory. Use octoclaw_status / octoclaw_task_action to refresh facts first, or state that the fact is unavailable.",
      ].join("\n"),
    };
  }
  const facts = subjectTurn.facts || {};
  const lines = [
    "[OctoClaw grounded follow-up]",
    "Answer only from these execution facts. Do not guess from memory.",
    `- Subject prompt: ${String(subjectTurn.prompt || "").trim() || "(unknown)"}`,
    `- Route decision: ${String(subjectTurn.route || "").trim() || "(unknown)"}`,
  ];
  if (subjectTurn.taskClass) {
    lines.push(`- Task class: ${subjectTurn.taskClass}`);
  }
  if (subjectTurn.protectedLane) {
    lines.push(`- Protected lane: ${subjectTurn.protectedLane}`);
  }
  lines.push(`- Dispatch called: ${facts.dispatchSeen ? "yes" : "no"}`);
  lines.push(`- Dispatch executed: ${facts.dispatchExecuted ? "yes" : "no"}`);
  lines.push(`- Delegated: ${facts.delegated ? "yes" : "no"}`);
  if (facts.delegationTool) {
    lines.push(`- Delegation tool: ${facts.delegationTool}`);
  }
  if (facts.materializationStatus) {
    lines.push(`- Materialization: ${facts.executionKind || "delegated"} · ${facts.materializationStatus}`);
  }
  if ((facts.directTools || []).length > 0) {
    lines.push(`- Direct tools used: ${facts.directTools.join(", ")}`);
  } else if (isProvenancePrompt(prompt)) {
    lines.push("- Direct tools used: unavailable");
  }
  if (facts.runnerJobId) {
    lines.push(`- Runner job id: ${facts.runnerJobId}`);
  }
  if (facts.taskId) {
    lines.push(`- Task id: ${facts.taskId}`);
  }
  if (facts.currentTaskStatus) {
    lines.push(`- Current task status: ${facts.currentTaskStatus}`);
  }
  if (facts.currentTaskSummary) {
    lines.push(`- Current task summary: ${facts.currentTaskSummary}`);
  }
  if (facts.capabilityFailure && Object.keys(facts.capabilityFailure).length > 0) {
    lines.push(`- Capability failure: ${String(facts.capabilityFailure.reason || facts.capabilityFailure.code || "unknown").trim()}`);
  }
  lines.push("If the user asks how it was checked, only mention tools listed above. If the fact is unavailable, say so plainly.");
  return {
    available: true,
    subjectPrompt: String(subjectTurn.prompt || "").trim(),
    route: String(subjectTurn.route || "").trim(),
    taskClass: String(subjectTurn.taskClass || "").trim(),
    protectedLane: String(subjectTurn.protectedLane || "").trim(),
    facts,
    context: lines.join("\n"),
  };
}

export function buildDirectLookupGuard(decision = {}) {
  if (!decision?.latency_ack?.required) {
    return "";
  }
  return [
    "[OctoClaw live lookup guard]",
    "This is a bounded live lookup. Do not answer from memory.",
    "Use a small number of tools to verify the latest facts first, then answer concisely.",
  ].join("\n");
}

export const __conversationControlTest = {
  groupedReplayTurns,
  buildConversationGrounding,
  buildConversationControlHints,
  isMetaPrompt,
  isTaskProgressPrompt,
  isProvenancePrompt,
  detectOperatorSurface,
};
