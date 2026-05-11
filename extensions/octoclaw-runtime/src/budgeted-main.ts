import {
  asNumber,
  asRecord,
  asString,
  type UnknownRecord,
} from "./util/type-coercion.js";

export const BUDGETED_MAIN_MAX_WALL_MS = 30_000;
export const MAIN_FAST_PATH_READ_ONLY_TOOL_LIMIT = 2;

export interface BudgetedMainState {
  active: boolean;
  startedAt: number;
  completedAt?: number;
  escalatedAt?: number;
  escalatedPending?: boolean;
  maxWallMs: number;
  budgetStartSource: string;
  reason: string;
  decisionBucket: string;
  visibleStartAt?: number;
  toolCount: number;
  readOnlyToolCount: number;
  longToolDetected: boolean;
  writeToolDetected: boolean;
  workContractId?: string;
  spawnIntentId?: string;
}

export interface BudgetedMainMetrics {
  elapsedMs: number;
  maxWallMs: number;
  max_wall_ms: number;
  reason: string;
  decision_bucket: string;
  decisionBucket: string;
  visibleElapsedMs: number;
  visible_elapsed_ms: number;
  budgetStartSource: string;
  budget_start_source: string;
  toolCount: number;
  readOnlyToolCount: number;
  longToolDetected: boolean;
  writeToolDetected: boolean;
  sessionKey: string;
  workContractId: string;
  spawnIntentId: string;
  budgetElapsedMs: number;
  budgetEscalationReason: string;
}

export interface BudgetedMainToolClassification {
  toolName: string;
  counted: boolean;
  budgetNeutral: boolean;
  readOnly: boolean;
  longToolDetected: boolean;
  writeToolDetected: boolean;
  multiStepToolDetected: boolean;
  unknownToolRiskDetected: boolean;
  escalationReason: string;
}

export function decisionBucketForBudgetedMain(decision: UnknownRecord): string {
  const routeDecision = asRecord(decision.route_decision);
  const startupCostPolicy = asRecord(routeDecision.startup_cost_policy || decision._startup_cost_policy);
  return asString(
    routeDecision.decision_bucket
    || decision._decision_bucket
    || startupCostPolicy.decision_bucket,
  );
}

export function isBudgetedMainDecision(decision: UnknownRecord): boolean {
  const route = asString(asRecord(decision.route_decision).route, "reply");
  return decisionBucketForBudgetedMain(decision) === "budgeted_main_then_delegate"
    && route !== "delegate";
}

export function readBudgetedMainState(state: UnknownRecord): BudgetedMainState | null {
  const record = asRecord(state.budgetedMain || state.budgeted_main);
  if (!record.active && !record.startedAt && !record.started_at) return null;
  const startedAt = asNumber(record.startedAt || record.started_at);
  if (!startedAt) return null;
  return {
    active: record.active !== false,
    startedAt,
    completedAt: asNumber(record.completedAt || record.completed_at) || undefined,
    escalatedAt: asNumber(record.escalatedAt || record.escalated_at) || undefined,
    escalatedPending: record.escalatedPending === true || record.escalated_pending === true,
    maxWallMs: asNumber(record.maxWallMs || record.max_wall_ms) || BUDGETED_MAIN_MAX_WALL_MS,
    budgetStartSource: asString(record.budgetStartSource || record.budget_start_source, "before_prompt_build_complete"),
    reason: asString(record.reason),
    decisionBucket: asString(record.decisionBucket || record.decision_bucket, "budgeted_main_then_delegate"),
    visibleStartAt: asNumber(record.visibleStartAt || record.visible_start_at) || undefined,
    toolCount: asNumber(record.toolCount || record.tool_count),
    readOnlyToolCount: asNumber(record.readOnlyToolCount || record.read_only_tool_count),
    longToolDetected: record.longToolDetected === true || record.long_tool_detected === true,
    writeToolDetected: record.writeToolDetected === true || record.write_tool_detected === true,
    workContractId: asString(record.workContractId || record.work_contract_id) || undefined,
    spawnIntentId: asString(record.spawnIntentId || record.spawn_intent_id) || undefined,
  };
}

export function buildBudgetedMainState(input: {
  now: number;
  decision: UnknownRecord;
  visibleStartAt?: number;
  budgetStartSource?: string;
  workContractId?: string;
  spawnIntentId?: string;
}): BudgetedMainState {
  return {
    active: true,
    startedAt: input.now,
    maxWallMs: BUDGETED_MAIN_MAX_WALL_MS,
    budgetStartSource: input.budgetStartSource || "before_prompt_build_complete",
    reason: "budgeted_main_started",
    decisionBucket: decisionBucketForBudgetedMain(input.decision) || "budgeted_main_then_delegate",
    visibleStartAt: input.visibleStartAt,
    toolCount: 0,
    readOnlyToolCount: 0,
    longToolDetected: false,
    writeToolDetected: false,
    workContractId: input.workContractId || undefined,
    spawnIntentId: input.spawnIntentId || undefined,
  };
}

export function serializeBudgetedMainState(state: BudgetedMainState): UnknownRecord {
  return {
    active: state.active,
    startedAt: state.startedAt,
    started_at: state.startedAt,
    completedAt: state.completedAt,
    completed_at: state.completedAt,
    escalatedAt: state.escalatedAt,
    escalated_at: state.escalatedAt,
    escalatedPending: state.escalatedPending,
    escalated_pending: state.escalatedPending,
    maxWallMs: state.maxWallMs,
    max_wall_ms: state.maxWallMs,
    budgetStartSource: state.budgetStartSource,
    budget_start_source: state.budgetStartSource,
    reason: state.reason,
    decisionBucket: state.decisionBucket,
    decision_bucket: state.decisionBucket,
    visibleStartAt: state.visibleStartAt,
    visible_start_at: state.visibleStartAt,
    toolCount: state.toolCount,
    tool_count: state.toolCount,
    readOnlyToolCount: state.readOnlyToolCount,
    read_only_tool_count: state.readOnlyToolCount,
    longToolDetected: state.longToolDetected,
    long_tool_detected: state.longToolDetected,
    writeToolDetected: state.writeToolDetected,
    write_tool_detected: state.writeToolDetected,
    workContractId: state.workContractId,
    work_contract_id: state.workContractId,
    spawnIntentId: state.spawnIntentId,
    spawn_intent_id: state.spawnIntentId,
  };
}

function commandText(params: UnknownRecord): string {
  return asString(params.command || params.cmd || params.shell || params.script || params.input);
}

function pathText(params: UnknownRecord): string {
  return asString(params.path || params.file || params.filePath || params.file_path || params.uri);
}

function isSkillRead(toolName: string, params: UnknownRecord): boolean {
  if (toolName !== "read") return false;
  const path = pathText(params).replace(/\\/gu, "/");
  return /(?:^|\/)skills\/[^/]+\/SKILL\.md$/u.test(path);
}

function explicitWriteSignal(params: UnknownRecord): boolean {
  const readOnlySignal = params.readOnly ?? params.read_only;
  const readOnly = typeof readOnlySignal === "boolean" ? readOnlySignal : undefined;
  if (readOnly === true) return false;
  if (readOnly === false) return true;
  const mode = asString(params.accessMode || params.access_mode || params.mode || params.operation || params.kind).toLowerCase();
  return ["write", "edit", "patch", "delete", "move", "rename", "mutate", "mutation"].includes(mode);
}

function commandLooksLongOrVerification(command: string): boolean {
  if (!command) return false;
  return /\b(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|build|lint|typecheck|check)|build|lint)\b/iu.test(command)
    || /\b(?:vitest|jest|pytest|go\s+test|cargo\s+test|mvn\s+test|gradle\s+test|tsc|eslint|ruff|mypy)\b/iu.test(command)
    || /\b(?:build|test|typecheck|lint|validate|validation|review|deploy)\b/iu.test(command);
}

function hasUnsafeWriteRedirection(command: string): boolean {
  if (!command) return false;
  const redirectionPattern = /(?:^|[\s;|&])((?:(?:\d+)?>{1,2})|&>{1,2})\s*("[^"]+"|'[^']+'|[^\s;|&]+)/gu;
  let match: RegExpExecArray | null;
  while ((match = redirectionPattern.exec(command)) !== null) {
    const rawTarget = asString(match[2]).replace(/^["']|["']$/gu, "");
    if (rawTarget === "/dev/null" || rawTarget === "&1" || rawTarget === "&2") continue;
    return true;
  }
  return false;
}

function commandLooksMutation(command: string): boolean {
  if (!command) return false;
  return /(?:^|\s)(?:rm|mv|cp|mkdir|touch|chmod|chown|git\s+(?:commit|merge|rebase|push|pull|checkout|switch|reset)|npm\s+install|pnpm\s+(?:add|install)|yarn\s+add|bun\s+add)\b/iu.test(command)
    || /\b(?:gh\s+(?:release|pr)\s+(?:create|edit|delete|close|reopen|merge)|openclaw\s+(?:update|upgrade|install|uninstall|deploy|restart))\b/iu.test(command)
    || /\b(?:find)\b[\s\S]*\s-(?:delete|exec|execdir|ok|okdir)\b/iu.test(command)
    || hasUnsafeWriteRedirection(command)
    || /\b(?:sed|perl)\s+-i\b/iu.test(command);
}

function commandLooksMultiStep(command: string): boolean {
  if (!command) return false;
  return /\n|&&|\|\||;\s*\S|\|\s*\S/iu.test(command);
}

function stripSafeShellRedirections(segment: string): string {
  return segment.replace(/(?:^|\s)((?:(?:\d+)?>{1,2})|&>{1,2})\s*(?:\/dev\/null|&[12])(?=\s|$)/gu, " ");
}

function stripShellGrouping(segment: string): string {
  let text = segment.trim();
  while (text.startsWith("(")) text = text.slice(1).trim();
  while (text.endsWith(")")) text = text.slice(0, -1).trim();
  return text;
}

function shellWords(segment: string): string[] {
  return stripShellGrouping(stripSafeShellRedirections(segment))
    .split(/\s+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function tokenHas(tokens: string[], value: string): boolean {
  return tokens.some((token) => token.toLowerCase() === value);
}

function tokenStartsWith(tokens: string[], value: string): boolean {
  return tokens.some((token) => token.toLowerCase().startsWith(value));
}

function curlLooksReadOnly(tokens: string[]): boolean {
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i].toLowerCase();
    if (["-o", "--output", "-t", "--upload-file", "-f", "--form", "--form-string", "--data", "--data-raw", "--data-binary", "--json"].includes(token)) return false;
    if (token.startsWith("-o") && token.length > 2) return false;
    if (["-x", "--request"].includes(token)) {
      const method = asString(tokens[i + 1]).toUpperCase();
      if (method && method !== "GET" && method !== "HEAD") return false;
    }
    if (token.startsWith("-x") && token.length > 2) {
      const method = token.slice(2).toUpperCase();
      if (method !== "GET" && method !== "HEAD") return false;
    }
  }
  return true;
}

function openclawLooksReadOnly(tokens: string[]): boolean {
  const action = asString(tokens[1]).toLowerCase();
  const detail = asString(tokens[2]).toLowerCase();
  if (!action || ["--version", "-v", "version", "status", "models", "tasks"].includes(action)) return true;
  if (action === "config") return !detail || ["get", "list", "show"].includes(detail);
  if (action === "plugins") return !detail || ["list", "show", "status"].includes(detail);
  if (action === "directory") return !detail || ["get", "list", "show", "pwd"].includes(detail);
  return false;
}

function segmentLooksReadOnlyShell(segment: string): boolean {
  const tokens = shellWords(segment);
  if (tokens.length === 0) return true;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[0])) tokens.shift();
  if (tokens.length === 0) return true;
  const command = tokens[0].toLowerCase();
  if (command === "set") return tokens.every((token, index) => index === 0 || /^[-+A-Za-z0-9_]+$/u.test(token));
  if (["true", "false", ":", "printf", "echo", "pwd", "date", "which", "type", "command", "ls", "cat", "head", "tail", "wc", "sort", "uniq", "cut", "tr", "jq", "awk", "grep", "egrep", "fgrep", "rg"].includes(command)) return true;
  if (command === "sed") return !tokens.some((token) => token === "-i" || token.startsWith("-i") || token === "--in-place" || token.startsWith("--in-place="));
  if (command === "find") return !tokens.some((token) => ["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(token.toLowerCase()));
  if (command === "curl") return curlLooksReadOnly(tokens);
  if (command === "crontab") return tokens.length >= 2 && tokens.slice(1).every((token) => token === "-l" || token === "-u");
  if (command === "launchctl") return ["list", "print", "print-disabled"].includes(asString(tokens[1]).toLowerCase());
  if (command === "npm" || command === "pnpm" || command === "yarn" || command === "bun") {
    return ["view", "info", "show", "search"].includes(asString(tokens[1]).toLowerCase());
  }
  if (command === "gh") {
    const subject = asString(tokens[1]).toLowerCase();
    const action = asString(tokens[2]).toLowerCase();
    return (subject === "release" && ["view", "list"].includes(action))
      || (subject === "repo" && action === "view")
      || (subject === "pr" && ["view", "list", "checks"].includes(action))
      || (subject === "search" && ["repos", "prs", "issues", "commits", "code"].includes(action));
  }
  if (command === "git") {
    const action = asString(tokens[1]).toLowerCase();
    return ["status", "log", "show", "diff", "rev-parse", "remote", "branch", "describe"].includes(action)
      && !tokenHas(tokens, "--set-upstream")
      && !tokenStartsWith(tokens, "--set-upstream=");
  }
  if (command === "openclaw") {
    return openclawLooksReadOnly(tokens);
  }
  if ((command === "python" || command === "python3") && tokens[1] === "-m" && asString(tokens[2]).toLowerCase() === "pip") {
    const action = asString(tokens[3]).toLowerCase();
    return action === "index" || action === "show" || action === "list";
  }
  return false;
}

function commandLooksReadOnlyShellChain(command: string): boolean {
  if (!command) return false;
  if (hasUnsafeWriteRedirection(command) || /[`$]\(/u.test(command)) return false;
  if (commandLooksMutation(command) || commandLooksLongOrVerification(command)) return false;
  const segments = command
    .replace(/\\\n/gu, " ")
    .split(/(?:\n|&&|\|\||;|\|)/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length === 0 || segments.length > 16) return false;
  return segments.every(segmentLooksReadOnlyShell);
}

export function classifyBudgetedMainTool(toolNameInput: unknown, paramsInput: unknown): BudgetedMainToolClassification {
  const toolName = asString(toolNameInput).toLowerCase();
  const params = asRecord(paramsInput);
  const isControl = toolName.startsWith("octoclaw_")
    || toolName === "sessions_spawn"
    || toolName === "sessions_yield"
    || toolName === "session_status";
  if (!toolName || isControl) {
    return {
      toolName,
      counted: false,
      budgetNeutral: false,
      readOnly: false,
      longToolDetected: false,
      writeToolDetected: false,
      multiStepToolDetected: false,
      unknownToolRiskDetected: false,
      escalationReason: "",
    };
  }

  if (isSkillRead(toolName, params)) {
    return {
      toolName,
      counted: false,
      budgetNeutral: true,
      readOnly: true,
      longToolDetected: false,
      writeToolDetected: false,
      multiStepToolDetected: false,
      unknownToolRiskDetected: false,
      escalationReason: "",
    };
  }

  const command = commandText(params);
  const shellLikeTool = ["exec", "shell", "bash", "process"].includes(toolName) || Boolean(command);
  const readOnlyShellChain = commandLooksReadOnlyShellChain(command);
  const writeToolDetected = explicitWriteSignal(params)
    || /(?:write|edit|patch|apply_patch|delete|remove|rename|move|create|save)/iu.test(toolName)
    || commandLooksMutation(command);
  const longToolDetected = !readOnlyShellChain && (commandLooksLongOrVerification(command)
    || /(?:test|build|lint|typecheck|review|validate|deploy)/iu.test(toolName));
  const multiStepToolDetected = !readOnlyShellChain && commandLooksMultiStep(command);
  const unknownToolRiskDetected = shellLikeTool
    && Boolean(command)
    && !readOnlyShellChain
    && !writeToolDetected
    && !longToolDetected
    && !multiStepToolDetected;
  const readOnly = readOnlyShellChain || (!writeToolDetected && !longToolDetected && !multiStepToolDetected && !unknownToolRiskDetected);
  const escalationReason = writeToolDetected
    ? "write_tool_detected"
    : longToolDetected
      ? "long_tool_detected"
      : multiStepToolDetected
        ? "multi_step_tool_chain"
        : unknownToolRiskDetected
          ? "tool_risk_unknown"
          : "";
  return {
    toolName,
    counted: true,
    budgetNeutral: false,
    readOnly,
    longToolDetected,
    writeToolDetected,
    multiStepToolDetected,
    unknownToolRiskDetected,
    escalationReason,
  };
}

export function updateBudgetedMainToolState(
  state: BudgetedMainState,
  classification: BudgetedMainToolClassification,
): BudgetedMainState {
  if (!classification.counted) return state;
  const readOnlyToolCount = state.readOnlyToolCount + (classification.readOnly ? 1 : 0);
  const toolCount = state.toolCount + 1;
  const readOnlyOverBudget = classification.readOnly && readOnlyToolCount > MAIN_FAST_PATH_READ_ONLY_TOOL_LIMIT;
  return {
    ...state,
    toolCount,
    readOnlyToolCount,
    longToolDetected: state.longToolDetected || classification.longToolDetected || classification.multiStepToolDetected || classification.unknownToolRiskDetected || readOnlyOverBudget,
    writeToolDetected: state.writeToolDetected || classification.writeToolDetected,
    reason: classification.escalationReason || (readOnlyOverBudget ? "multi_step_tool_chain" : state.reason),
  };
}

export function budgetedMainToolEscalationReason(
  updatedState: BudgetedMainState,
  classification: BudgetedMainToolClassification,
): string {
  if (classification.escalationReason) return classification.escalationReason;
  if (classification.readOnly && updatedState.readOnlyToolCount > MAIN_FAST_PATH_READ_ONLY_TOOL_LIMIT) return "multi_step_tool_chain";
  return "";
}

export function escalateBudgetedMainDecision(decision: UnknownRecord, reason: string): UnknownRecord {
  const routeDecision = asRecord(decision.route_decision);
  const toolPolicy = asRecord(decision.tool_policy);
  const routeHintPolicy = asRecord(decision.route_hint_policy);
  const reviewPolicy = asRecord(decision.review_policy);
  const routerDecision = asRecord(decision.router_decision_v2);
  const expectedDeliverable = asString(
    decision.expected_deliverable
    || decision.expectedDeliverable
    || routeDecision.expected_deliverable
    || routeDecision.expectedDeliverable,
  );
  return {
    ...decision,
    is_new_work: true,
    isNewWork: true,
    ...(expectedDeliverable ? { expected_deliverable: expectedDeliverable, expectedDeliverable } : {}),
    route_decision: {
      ...routeDecision,
      route: "delegate",
      system_preferred_route: "delegate",
      route_source: "budgeted_main_escalation",
      dispatch_required: true,
      is_new_work: true,
      isNewWork: true,
      ...(expectedDeliverable ? { expected_deliverable: expectedDeliverable, expectedDeliverable } : {}),
      task_class: "delegated_single",
      protocol: "delegated",
      reason,
      decision_bucket: "budgeted_main_then_delegate",
      reason_codes: Array.from(new Set([
        ...(Array.isArray(routeDecision.reason_codes) ? routeDecision.reason_codes.map((item) => asString(item)).filter(Boolean) : []),
        "budgeted_main_escalated",
        `budgeted_main_escalation:${reason}`,
      ])),
    },
    route_hint_policy: {
      ...routeHintPolicy,
      required: false,
      submitted: true,
      source: "budgeted_main_escalation",
    },
    review_policy: {
      ...reviewPolicy,
      required: true,
    },
    tool_policy: {
      ...toolPolicy,
      must_delegate_via: "octoclaw_dispatch",
      allow_direct_tools: false,
      delegate_first: true,
      allowed_control_tools: Array.from(new Set([
        "octoclaw_dispatch",
        "octoclaw_dispatch_confirm",
        "octoclaw_status",
        "octoclaw_task_action",
        "sessions_yield",
        ...(Array.isArray(toolPolicy.allowed_control_tools) ? toolPolicy.allowed_control_tools.map((item) => asString(item)).filter(Boolean) : []),
      ])),
    },
    router_decision_v2: {
      ...routerDecision,
      compatibility_view: true,
      request_kind: "delegated_task",
    },
    _budgeted_main_escalated: true,
    _budgeted_main_escalation_reason: reason,
  };
}

export function buildBudgetedMainMetrics(input: {
  state: BudgetedMainState;
  now: number;
  reason: string;
  sessionKey?: string;
  workContractId?: string;
  spawnIntentId?: string;
}): BudgetedMainMetrics {
  const elapsedMs = Math.max(0, input.now - input.state.startedAt);
  const visibleElapsedMs = input.state.visibleStartAt
    ? Math.max(0, input.now - input.state.visibleStartAt)
    : elapsedMs;
  return {
    elapsedMs,
    maxWallMs: input.state.maxWallMs,
    max_wall_ms: input.state.maxWallMs,
    reason: input.reason,
    decision_bucket: input.state.decisionBucket || "budgeted_main_then_delegate",
    decisionBucket: input.state.decisionBucket || "budgeted_main_then_delegate",
    visibleElapsedMs,
    visible_elapsed_ms: visibleElapsedMs,
    budgetStartSource: input.state.budgetStartSource,
    budget_start_source: input.state.budgetStartSource,
    toolCount: input.state.toolCount,
    readOnlyToolCount: input.state.readOnlyToolCount,
    longToolDetected: input.state.longToolDetected,
    writeToolDetected: input.state.writeToolDetected,
    sessionKey: input.sessionKey || "",
    workContractId: input.workContractId || input.state.workContractId || "",
    spawnIntentId: input.spawnIntentId || input.state.spawnIntentId || "",
    budgetElapsedMs: elapsedMs,
    budgetEscalationReason: input.reason.startsWith("completed") ? "" : input.reason,
  };
}
