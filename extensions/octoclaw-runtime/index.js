import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let OCTOCLAW_ROOT_OVERRIDE = "";

function resolveOctoClawRoot() {
  return OCTOCLAW_ROOT_OVERRIDE || process.env.OCTOCLAW_ROOT || path.resolve(__dirname, "..", "..");
}

function resolveScript(...parts) {
  return path.join(resolveOctoClawRoot(), "lib", ...parts);
}

function resolveWorkspaceRoot() {
  return process.env.WORKSPACE || "/workspace";
}

function resolveReplayLogPath() {
  return path.join(resolveWorkspaceRoot(), "tmp", "octopus", "runtime-policy-replay.jsonl");
}

function resolveRouteStickinessPath() {
  return path.join(resolveWorkspaceRoot(), "tmp", "octopus", "route-stickiness.json");
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...(options.env || {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

async function runJsonScript(scriptName, args, cwd) {
  const result = await runCommand("python3", [resolveScript(scriptName), ...args], { cwd });
  if (result.code !== 0) {
    throw new Error(result.stderr || `${scriptName} failed`);
  }
  try {
    return JSON.parse(result.stdout || "{}");
  } catch {
    throw new Error(`${scriptName} returned invalid JSON: ${result.stdout}`);
  }
}

async function runStatus(format, cwd) {
  const result = await runCommand("bash", [resolveScript("status.sh"), "--format", format], { cwd });
  if (result.code !== 0) {
    throw new Error(result.stderr || "status.sh failed");
  }
  return result.stdout;
}

async function readReportExcerpt(reportPath, cwd) {
  const result = await runCommand(
    "python3",
    [resolveScript("report_excerpt.py"), "--path", reportPath, "--max-lines", "20", "--max-chars", "1800"],
    { cwd },
  );
  if (result.code !== 0) {
    throw new Error(result.stderr || "report_excerpt.py failed");
  }
  try {
    return JSON.parse(result.stdout || "{}");
  } catch {
    throw new Error(`report_excerpt.py returned invalid JSON: ${result.stdout}`);
  }
}

function toolResponse(summary, details = {}) {
  return {
    content: [{ type: "text", text: summary }],
    details,
  };
}

async function appendJsonl(pathname, payload) {
  await fs.mkdir(path.dirname(pathname), { recursive: true });
  await fs.appendFile(pathname, `${JSON.stringify(payload)}\n`, "utf8");
}

async function readJsonFile(pathname, fallback = {}) {
  try {
    const raw = await fs.readFile(pathname, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJsonFile(pathname, payload) {
  await fs.mkdir(path.dirname(pathname), { recursive: true });
  const tempPath = `${pathname}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tempPath, pathname);
}

function truncateText(value, limit = 320) {
  const text = String(value || "").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

const POLICY_STATE_TTL_MS = 30 * 60 * 1000;
const policyStateBySession = new Map();
const DELEGATED_ROUTE_NAMES = new Set(["runner", "spawn_single", "spawn_multi"]);
const OCTOCLAW_DELEGATION_SYSTEM_CONTEXT = [
  "OctoClaw runtime policy is authoritative for this run.",
  "When route is delegated, the main agent is a coordinator and must use OctoClaw control tools instead of doing the work directly.",
  "Do not hand-write session or subagent spawning commands.",
].join("\n");
const OCTOCLAW_ROUTE_HINT_SYSTEM_CONTEXT = [
  "For non-hard-runner requests, submit a structured route hint before answering or dispatching.",
  "Use octoclaw_route_hint to state whether this should be direct, spawn_single, or spawn_multi.",
  "After route_hint merge: direct may answer directly; delegated routes must go through octoclaw_dispatch.",
].join("\n");

function prunePolicyState() {
  const now = Date.now();
  for (const [key, value] of policyStateBySession.entries()) {
    if (!value || now - Number(value.updatedAt || value.createdAt || 0) > POLICY_STATE_TTL_MS) {
      policyStateBySession.delete(key);
    }
  }
}

function resolvePolicyStateKeys(ctx = {}) {
  const keys = [];
  for (const raw of [ctx.sessionId, ctx.sessionKey]) {
    const value = String(raw || "").trim();
    if (value && !keys.includes(value)) {
      keys.push(value);
    }
  }
  return keys;
}

function resolvePolicyStateKey(ctx = {}) {
  return resolvePolicyStateKeys(ctx)[0] || "";
}

function getPolicyStateForContext(ctx = {}) {
  for (const key of resolvePolicyStateKeys(ctx)) {
    const state = policyStateBySession.get(key);
    if (state) {
      return { key, state };
    }
  }
  return { key: "", state: null };
}

function setPolicyStateForContext(ctx = {}, payload) {
  for (const key of resolvePolicyStateKeys(ctx)) {
    policyStateBySession.set(key, payload);
  }
}

function clearPolicyStateForContext(ctx = {}) {
  for (const key of resolvePolicyStateKeys(ctx)) {
    policyStateBySession.delete(key);
  }
}

function extractMessageText(content) {
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof part.text === "string") {
          return String(part.text);
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (content && typeof content === "object" && typeof content.text === "string") {
    return String(content.text).trim();
  }
  return "";
}

function extractPromptText(event = {}) {
  const prompt = String(event?.prompt || "").trim();
  if (prompt) {
    return prompt;
  }
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (String(message?.role || "").trim().toLowerCase() !== "user") {
      continue;
    }
    const text = extractMessageText(message?.content);
    if (text) {
      return text;
    }
  }
  return "";
}

function delegatedStickyRoute(decision) {
  const route = String(decision?.route_decision?.route || "").trim();
  if (route === "spawn_single" || route === "spawn_multi") {
    return route;
  }
  return "";
}

function parsePolicyDecisionJson(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function runtimeSwitches(decision) {
  return decision?.runtime_switches || {};
}

async function persistStickyLane(sessionKey, decision, logger, options = {}) {
  if (!runtimeSwitches(decision).sticky_lane_enabled) {
    return false;
  }
  const stickyRoute = delegatedStickyRoute(decision);
  if (!sessionKey || !stickyRoute) {
    return false;
  }
  try {
    const pathname = resolveRouteStickinessPath();
    const current = await readJsonFile(pathname, {});
    const next = current && typeof current === "object" ? { ...current } : {};
    next[sessionKey] = {
      route: stickyRoute,
      work_type: String(decision?.route_decision?.work_type || "").trim(),
      phase: String(decision?.route_decision?.phase || "").trim(),
      protocol: String(decision?.route_decision?.protocol || "").trim(),
      system_preferred_route: String(decision?.route_decision?.system_preferred_route || "").trim(),
      updated_at: new Date().toISOString(),
      source: String(options.source || "runtime_policy").trim() || "runtime_policy",
      reason_codes: Array.isArray(decision?.route_decision?.reason_codes)
        ? decision.route_decision.reason_codes.slice(0, 8)
        : [],
    };
    await writeJsonFile(pathname, next);
    return true;
  } catch (err) {
    logger?.warn?.(`octoclaw sticky lane persist failed: ${String(err)}`);
    return false;
  }
}

async function recordPolicyReplay(eventType, payload = {}, logger, decision = null) {
  if (decision && !runtimeSwitches(decision).replay_logging_enabled) {
    return;
  }
  try {
    await appendJsonl(resolveReplayLogPath(), {
      schema_version: "octoclaw.runtime_policy.replay_event/v1",
      event: eventType,
      at: new Date().toISOString(),
      ...payload,
    });
  } catch (err) {
    logger?.warn?.(`octoclaw runtime replay log failed: ${String(err)}`);
  }
}

function isManagedAgentContext(ctx = {}) {
  const trigger = String(ctx.trigger || "").trim().toLowerCase();
  if (trigger && ["heartbeat", "cron", "memory"].includes(trigger)) {
    return false;
  }
  const sessionKey = String(ctx.sessionKey || "");
  const agentId = String(ctx.agentId || "");
  if (/subagent/i.test(sessionKey) || /subagent/i.test(agentId)) {
    return false;
  }
  return true;
}

function buildPolicyMetadata(ctx = {}) {
  const metadata = {};
  const stableSessionKey = resolvePolicyStateKey(ctx);
  if (ctx.channelId) metadata.channel = ctx.channelId;
  if (stableSessionKey) metadata.session_key = stableSessionKey;
  if (ctx.trigger) metadata.trigger = ctx.trigger;
  if (ctx.agentId) metadata.agent_id = ctx.agentId;
  if (ctx.sessionId) metadata.session_id = ctx.sessionId;
  if (ctx.messageProvider) metadata.message_provider = ctx.messageProvider;
  return metadata;
}

async function resolvePolicyDecisionForContext(prompt, ctx, cwd, logger, options = {}) {
  if (!prompt || !isManagedAgentContext(ctx)) {
    return null;
  }
  prunePolicyState();
  const stateKey = resolvePolicyStateKey(ctx);
  const existing = getPolicyStateForContext(ctx).state;
  if (!options.force && existing?.prompt === prompt && existing?.decision) {
    existing.updatedAt = Date.now();
    setPolicyStateForContext(ctx, existing);
    return { stateKey, state: existing, decision: existing.decision };
  }
  const metadata = { ...buildPolicyMetadata(ctx), ...(options.metadata || {}) };
  const args = ["--task", prompt];
  if (metadata.channel) args.push("--channel", String(metadata.channel));
  if (metadata.session_key) args.push("--session-key", String(metadata.session_key));
  if (Object.keys(metadata).length > 0) args.push("--metadata-json", JSON.stringify(metadata));
  try {
    const decision = await runJsonScript("octoclaw_policy.py", args, cwd);
    const nextState = {
      prompt,
      decision,
      createdAt: existing?.createdAt || Date.now(),
      updatedAt: Date.now(),
      delegated: Boolean(existing?.delegated),
      delegationTool: existing?.delegationTool || "",
      routeHintSubmitted: Boolean(existing?.routeHintSubmitted),
      routeHintPayload: existing?.routeHintPayload || null,
      blockedTools: Array.isArray(existing?.blockedTools) ? existing.blockedTools : [],
    };
    setPolicyStateForContext(ctx, nextState);
    await recordPolicyReplay(
      "policy_resolved",
      {
        sessionKey: stateKey || "",
        sessionId: String(ctx?.sessionId || ""),
        trigger: String(ctx?.trigger || ""),
        route: String(decision?.route_decision?.route || ""),
        systemPreferredRoute: String(decision?.route_decision?.system_preferred_route || ""),
        workerPool: String(decision?.route_decision?.worker_pool || ""),
        routeHintRequired: Boolean(decision?.route_hint_policy?.required),
        routeHintSubmitted: Boolean(nextState.routeHintSubmitted),
        stickyApplied: Boolean(decision?.route_hint_policy?.sticky_applied),
        prompt: truncateText(prompt),
      },
      logger,
      decision,
    );
    return { stateKey, state: nextState, decision };
  } catch (err) {
    logger?.warn?.(`octoclaw runtime policy resolve failed: ${String(err)}`);
    return null;
  }
}

function updatePolicyState(stateKey, mutator) {
  if (!stateKey) return null;
  const current = policyStateBySession.get(stateKey);
  if (!current) return null;
  const next = typeof mutator === "function" ? mutator(current) : { ...current, ...mutator };
  next.updatedAt = Date.now();
  policyStateBySession.set(stateKey, next);
  return next;
}

function compactPolicyPrompt(decision) {
  const route = decision?.route_decision?.route || "direct";
  const systemPreferredRoute = decision?.route_decision?.system_preferred_route || route;
  const routeHintPolicy = decision?.route_hint_policy || {};
  const routeSummary = [
    `route=${route}`,
    `system_preferred_route=${systemPreferredRoute}`,
    `worker_pool=${decision?.route_decision?.worker_pool || "octoclaw-main"}`,
    `work_type=${decision?.route_decision?.work_type || ""}`,
    `phase=${decision?.route_decision?.phase || ""}`,
    `protocol=${decision?.route_decision?.protocol || "normal"}`,
    `review_required=${decision?.review_policy?.required ? "true" : "false"}`,
  ].join(" ; ");
  const lines = [`[OctoClaw runtime policy] ${routeSummary}`];
  const skillBundle = Array.isArray(decision?.skill_policy?.default_skill_bundle)
    ? decision.skill_policy.default_skill_bundle
    : [];
  const toolPolicy = decision?.tool_policy || {};
  if (DELEGATED_ROUTE_NAMES.has(route)) {
    const controlTools = Array.isArray(toolPolicy.allowed_control_tools) ? toolPolicy.allowed_control_tools : [];
    lines.push("Delegated run: do not solve the task directly and do not use non-OctoClaw tools.");
    if (toolPolicy.must_delegate_via) {
      lines.push(`Call ${toolPolicy.must_delegate_via} first with the user's task, then answer from its handoff/report.`);
    }
    if (controlTools.length > 0) {
      lines.push(`Allowed control tools: ${controlTools.join(", ")}`);
    }
    if (decision?.prompt_contract?.artifact_first) {
      lines.push("Prefer report/artifact summaries over redoing the work in the main context.");
    }
  }
  if (routeHintPolicy?.required) {
    lines.push("Before answering or dispatching, call octoclaw_route_hint with your structured route suggestion.");
    lines.push(`System preferred route right now: ${routeHintPolicy.system_preferred_route || route}`);
  }
  if (routeHintPolicy?.sticky_applied && routeHintPolicy?.sticky_route) {
    lines.push(`Sticky lane is active for this session follow-up: ${routeHintPolicy.sticky_route}`);
  }
  if (skillBundle.length > 0) {
    lines.push(`Preferred skill bundle: ${skillBundle.join(", ")}`);
  }
  return lines.join("\n");
}

function stringifyParamsForPolicy(value) {
  try {
    return JSON.stringify(value || {});
  } catch {
    return String(value || "");
  }
}

function matchesBlockedPattern(text, patterns = []) {
  const haystack = String(text || "").toLowerCase();
  return patterns.some((pattern) => {
    const needle = String(pattern || "").trim().toLowerCase();
    return needle && haystack.includes(needle);
  });
}

function isDelegatedRoute(decision) {
  return DELEGATED_ROUTE_NAMES.has(String(decision?.route_decision?.route || ""));
}

function routeHintRequired(decision) {
  return Boolean(decision?.route_hint_policy?.required);
}

function policySummaryText(payload) {
  if (payload?.summary) {
    return payload.summary;
  }
  const route = payload?.route_decision?.route || "direct";
  const workerPool = payload?.route_decision?.worker_pool || "octoclaw-main";
  const profile = payload?.model_policy?.profile || "";
  const model = payload?.model_policy?.selected_model || "";
  const protocol = payload?.route_decision?.protocol || "normal";
  const review = payload?.review_policy?.required ? " / review" : "";
  const suffix = model ? ` / ${model}` : "";
  return `policy=${route} -> ${workerPool} / profile=${profile} / protocol=${protocol}${review}${suffix}`;
}

function statusToolResponse(rawOutput, format) {
  const text = [
    "OctoClaw raw status panel below. Return it verbatim to the user without summarizing or rewriting.",
    "```text",
    rawOutput,
    "```",
  ].join("\n");
  return {
    content: [{ type: "text", text }],
    details: {
      format,
      source: "status.sh",
      raw_output: rawOutput,
      return_verbatim: true,
    },
  };
}

function handoffText(payload, fallback) {
  const handoff = payload?.handoff;
  if (handoff?.user_safe && handoff?.reply_text) {
    return handoff.reply_text;
  }
  if (handoff?.summary) {
    return handoff.summary;
  }
  return fallback;
}

async function userFacingHandoff(payload, fallback, cwd) {
  const base = handoffText(payload, fallback);
  const handoff = payload?.handoff || {};
  const reportPath = handoff?.report_path || payload?.report_path || "";
  if (!reportPath) {
    return base;
  }
  try {
    const preview = await readReportExcerpt(reportPath, cwd);
    if (preview?.exists && preview?.excerpt) {
      return `${base}\n\n报告摘录：\n${preview.excerpt}\n\n完整报告：${reportPath}`;
    }
  } catch {
    // Fall back to the base handoff text when report preview fails.
  }
  return `${base}\n\n完整报告：${reportPath}`;
}

const plugin = {
  id: "octoclaw-runtime",
  name: "OctoClaw Runtime",
  description: "Runtime policy hooks, dispatch tools, and replay logging for OctoClaw",
  register(pi) {
  OCTOCLAW_ROOT_OVERRIDE = String(pi?.pluginConfig?.octoclawRoot || "").trim();
  const registerLifecycleHook = (hookName, handler, priority = 180) => {
    if (typeof pi.on === "function") {
      pi.on(hookName, handler, { priority });
      return true;
    }
    if (typeof pi.registerHook === "function") {
      pi.registerHook(hookName, handler, { priority });
      return true;
    }
    return false;
  };

  registerLifecycleHook("before_model_resolve", async (event, ctx) => {
    if (!isManagedAgentContext(ctx)) return;
    const prompt = extractPromptText(event);
    const resolved = await resolvePolicyDecisionForContext(
      prompt,
      ctx,
      process.cwd(),
      pi.logger,
    );
    const decision = resolved?.decision;
    const hookConfig = decision?.hook_interface?.before_model_resolve;
    if (!hookConfig?.enabled) return;
    if (String(decision?.route_decision?.route || "direct") !== "direct") return;
    const modelOverride = String(hookConfig.selected_model || "").trim();
    if (!modelOverride) return;
    pi.logger?.debug?.(`octoclaw before_model_resolve modelOverride=${modelOverride}`);
    return { modelOverride };
  });

  registerLifecycleHook("before_prompt_build", async (event, ctx) => {
    if (!isManagedAgentContext(ctx)) return;
    const prompt = extractPromptText(event);
    const resolved = await resolvePolicyDecisionForContext(
      prompt,
      ctx,
      process.cwd(),
      pi.logger,
    );
    const decision = resolved?.decision;
    const hookConfig = decision?.hook_interface?.before_prompt_build;
    if (!hookConfig?.enabled) return;
    const prependSystem = [];
    if (routeHintRequired(decision)) {
      prependSystem.push(OCTOCLAW_ROUTE_HINT_SYSTEM_CONTEXT);
    }
    if (isDelegatedRoute(decision)) {
      prependSystem.push(OCTOCLAW_DELEGATION_SYSTEM_CONTEXT);
    }
    if (prependSystem.length === 0) return;
    return {
      prependSystemContext: prependSystem.join("\n\n"),
      prependContext: compactPolicyPrompt(decision),
    };
  });

  registerLifecycleHook("before_tool_call", async (event, ctx) => {
    if (!isManagedAgentContext(ctx)) return;
    const { key: stateKey, state } = getPolicyStateForContext(ctx);
    const decision = state?.decision;
    const hookConfig = decision?.hook_interface?.before_tool_call;
    if (!hookConfig?.enabled) return;

    const toolName = String(event?.toolName || ctx?.toolName || "").trim();
    const routeHintTool = String(hookConfig?.route_hint_tool || "octoclaw_route_hint").trim();
    const routeHintIsRequired = Boolean(hookConfig?.route_hint_required);
    const routeHintAlreadySubmitted = Boolean(state?.routeHintSubmitted);
    const allowedPreHintTools = new Set([routeHintTool, "octoclaw_policy_decide", "octoclaw_status"]);
    if (routeHintIsRequired && !routeHintAlreadySubmitted && !allowedPreHintTools.has(toolName)) {
      updatePolicyState(stateKey, (current) => ({
        ...current,
        blockedTools: [...(Array.isArray(current.blockedTools) ? current.blockedTools.slice(-7) : []), toolName].filter(Boolean),
      }));
      await recordPolicyReplay(
        "tool_blocked_before_route_hint",
        {
          sessionKey: stateKey || "",
          sessionId: String(ctx?.sessionId || ""),
          route: String(decision?.route_decision?.route || ""),
          toolName,
          requiredTool: routeHintTool,
        },
        pi.logger,
        decision,
      );
      return {
        block: true,
        blockReason: `OctoClaw runtime policy requires ${routeHintTool} before using other tools.`,
      };
    }
    const toolPolicy = decision?.tool_policy || {};
    const blockedPatterns = Array.isArray(toolPolicy.block_tool_patterns) ? toolPolicy.block_tool_patterns : [];
    if (matchesBlockedPattern(stringifyParamsForPolicy(event?.params), blockedPatterns)) {
      await recordPolicyReplay(
        "tool_blocked_manual_delegation",
        {
          sessionKey: stateKey || "",
          sessionId: String(ctx?.sessionId || ""),
          route: String(decision?.route_decision?.route || ""),
          toolName,
        },
        pi.logger,
        decision,
      );
      return {
        block: true,
        blockReason: `OctoClaw runtime policy blocked a manual delegation pattern. Use ${toolPolicy.must_delegate_via || "octoclaw_dispatch"} instead.`,
      };
    }

    if (!isDelegatedRoute(decision)) {
      return;
    }

    const allowedControlTools = new Set(
      Array.isArray(toolPolicy.allowed_control_tools) ? toolPolicy.allowed_control_tools : [],
    );
    if (toolName === String(toolPolicy.must_delegate_via || "").trim()) {
      updatePolicyState(stateKey, (current) => ({
        ...current,
        delegated: true,
        delegationTool: toolName,
      }));
      return;
    }

    if (allowedControlTools.has(toolName)) {
      return;
    }

    updatePolicyState(stateKey, (current) => ({
      ...current,
      blockedTools: [...(Array.isArray(current.blockedTools) ? current.blockedTools.slice(-7) : []), toolName].filter(Boolean),
    }));
    await recordPolicyReplay(
      "tool_blocked_delegation_policy",
      {
        sessionKey: stateKey || "",
        sessionId: String(ctx?.sessionId || ""),
        route: String(decision?.route_decision?.route || ""),
        toolName,
      },
      pi.logger,
      state?.decision || null,
    );
    return {
      block: true,
      blockReason: `OctoClaw runtime policy route=${decision?.route_decision?.route || "direct"} requires delegation. Use ${toolPolicy.must_delegate_via || "octoclaw_dispatch"} first. Allowed control tools: ${[...allowedControlTools].join(", ") || "octoclaw_dispatch"}.`,
    };
  });

  registerLifecycleHook("agent_end", async (_event, ctx) => {
    const { key: stateKey, state } = getPolicyStateForContext(ctx);
    if (!stateKey) return;
    await recordPolicyReplay(
      "agent_end",
      {
        sessionKey: stateKey,
        sessionId: String(ctx?.sessionId || ""),
        route: String(state?.decision?.route_decision?.route || ""),
        systemPreferredRoute: String(state?.decision?.route_decision?.system_preferred_route || ""),
        workerPool: String(state?.decision?.route_decision?.worker_pool || ""),
        routeHintRequired: Boolean(state?.decision?.route_hint_policy?.required),
        routeHintSubmitted: Boolean(state?.routeHintSubmitted),
        delegated: Boolean(state?.delegated),
        delegationTool: String(state?.delegationTool || ""),
        blockedTools: Array.isArray(state?.blockedTools) ? state.blockedTools : [],
      },
      pi.logger,
      state?.decision || null,
    );
    clearPolicyStateForContext(ctx);
  }, 50);

  pi.registerTool(
    {
      name: "octoclaw_route_hint",
      label: "OctoClaw Route Hint",
      description: "Submit a structured main-brain route hint so OctoClaw can merge it with system policy and return the final decision.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          task: { type: "string", description: "Optional task override. Defaults to the current prompt for this session." },
          command: { type: "string", description: "Optional shell command context." },
          routeHint: { type: "string", enum: ["direct", "spawn_single", "spawn_multi"] },
          workType: { type: "string", enum: ["ops", "research", "code", "review"] },
          phase: { type: "string", description: "Optional phase hint such as inspect, implement, collect, report, verify." },
          reviewRequired: { type: "boolean", description: "Whether review should be required after merge." },
          confidence: { type: "number", description: "Confidence from 0 to 1." },
          reason: { type: "string", description: "Short explanation for the route hint." }
        },
        required: ["routeHint"]
      },
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const stateKey = resolvePolicyStateKey(ctx);
        const existing = getPolicyStateForContext(ctx).state;
        const task = String(params.task || existing?.prompt || "").trim();
        if (!task) {
          throw new Error("octoclaw_route_hint requires task context");
        }
        const metadata = buildPolicyMetadata(ctx);
        const routeHintPayload = {
          route_hint: params.routeHint,
          work_type: params.workType || "",
          phase: params.phase || "",
          review_required: Boolean(params.reviewRequired),
          confidence: typeof params.confidence === "number" ? params.confidence : 0.0,
          reason: params.reason || "",
          source: "main_agent",
        };
        const args = ["--task", task];
        if (params.command) args.push("--command", params.command);
        if (Object.keys(metadata).length > 0) args.push("--metadata-json", JSON.stringify(metadata));
        args.push("--route-hint-json", JSON.stringify(routeHintPayload));
        const payload = await runJsonScript("octoclaw_policy.py", args, ctx.cwd || process.cwd());
        const stickyPersisted = await persistStickyLane(stateKey, payload, pi.logger, { source: "route_hint" });
        setPolicyStateForContext(ctx, {
          ...(existing || {}),
          prompt: task,
          decision: payload,
          createdAt: existing?.createdAt || Date.now(),
          updatedAt: Date.now(),
          delegated: Boolean(existing?.delegated),
          delegationTool: existing?.delegationTool || "",
          blockedTools: Array.isArray(existing?.blockedTools) ? existing.blockedTools : [],
          routeHintSubmitted: true,
          routeHintPayload,
        });
        await recordPolicyReplay(
          "route_hint_submitted",
          {
            sessionKey: stateKey || "",
            sessionId: String(ctx?.sessionId || ""),
            routeHint: params.routeHint,
            workType: params.workType || "",
            phase: params.phase || "",
            reviewRequired: Boolean(params.reviewRequired),
            confidence: typeof params.confidence === "number" ? params.confidence : 0.0,
            reason: truncateText(params.reason || "", 180),
            systemPreferredRoute: String(payload?.route_decision?.system_preferred_route || ""),
            finalRoute: String(payload?.route_decision?.route || ""),
            workerPool: String(payload?.route_decision?.worker_pool || ""),
            stickyApplied: Boolean(payload?.route_hint_policy?.sticky_applied),
            stickyPersisted,
          },
          pi.logger,
          payload,
        );
        const nextSummary = payload?.route_decision?.route === "direct"
          ? `route_hint merged: final route is direct. You may answer directly.`
          : `route_hint merged: final route is ${payload?.route_decision?.route || "spawn_single"}. Next call octoclaw_dispatch.`;
        return toolResponse(nextSummary, payload);
      },
    },
    { source: "octoclaw-runtime" },
  );

  pi.registerTool(
    {
      name: "octoclaw_policy_decide",
      label: "OctoClaw Policy Decide",
      description: "Return the structured OctoClaw runtime policy decision object, including route, model/profile, skill bundle, review policy, and hook interface hints.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          task: { type: "string", description: "The user task to classify and route." },
          command: { type: "string", description: "Optional shell command if one already exists." },
          channel: { type: "string", description: "Optional channel hint such as feishu, slack, discord, telegram, or wechat." },
          sessionKey: { type: "string", description: "Optional main session key." },
          forceRoute: { type: "string", enum: ["direct", "runner", "spawn_single", "spawn_multi"] },
          metadataJson: { type: "string", description: "Optional JSON object with extra routing metadata." }
        },
        required: ["task"]
      },
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const args = ["--task", params.task];
        if (params.command) args.push("--command", params.command);
        if (params.channel) args.push("--channel", params.channel);
        if (params.sessionKey) args.push("--session-key", params.sessionKey);
        if (params.forceRoute) args.push("--force-route", params.forceRoute);
        if (params.metadataJson) args.push("--metadata-json", params.metadataJson);
        const payload = await runJsonScript("octoclaw_policy.py", args, ctx.cwd || process.cwd());
        return toolResponse(policySummaryText(payload), payload);
      },
    },
    { source: "octoclaw-runtime" },
  );

  pi.registerTool(
    {
      name: "octoclaw_route",
      label: "OctoClaw Route",
      description: "Decide whether a task should be handled directly, by runner, or by one or more subagents.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          task: { type: "string", description: "The user task to classify." },
          command: { type: "string", description: "Optional shell command if the task already includes one." }
        },
        required: ["task"]
      },
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const payload = await runJsonScript(
          "octoclaw_route.py",
          ["--task", params.task, ...(params.command ? ["--command", params.command] : [])],
          ctx.cwd || process.cwd(),
        );
        return toolResponse(
          `OctoClaw system preferred route: ${payload.system_preferred_route || payload.route} (confidence ${payload.confidence ?? "n/a"})`,
          payload,
        );
      },
    },
    { source: "octoclaw-runtime" },
  );

  pi.registerTool(
    {
      name: "octoclaw_dispatch",
      label: "OctoClaw Dispatch",
      description: "Run OctoClaw dispatch so lightweight tasks use runner and larger tasks return a subagent execution plan.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          task: { type: "string", description: "The task to dispatch." },
          command: { type: "string", description: "Optional shell command for runner tasks." },
          cwd: { type: "string", description: "Optional working directory override." },
          forceRoute: { type: "string", enum: ["auto", "direct", "runner", "spawn_single", "spawn_multi"] },
          timeoutSeconds: { type: "number", description: "Runner timeout in seconds." },
          policyJson: { type: "string", description: "Optional precomputed runtime policy decision JSON." }
        },
        required: ["task"]
      },
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const args = ["--task", params.task];
        if (params.command) args.push("--command", params.command);
        if (params.cwd) args.push("--cwd", params.cwd);
        if (typeof params.timeoutSeconds === "number") args.push("--timeout-seconds", String(params.timeoutSeconds));
        if (params.forceRoute) args.push("--force-route", params.forceRoute);
        const { key: stateKey, state } = getPolicyStateForContext(ctx);
        const policyDecisionJson = params.policyJson || (state?.decision ? JSON.stringify(state.decision) : "");
        const cachedDecision = state?.decision || parsePolicyDecisionJson(params.policyJson || "");
        if (policyDecisionJson) args.push("--policy-json", policyDecisionJson);
        args.push("--wait", "--wait-timeout-seconds", "12");
        const payload = await runJsonScript("dispatch_task.py", args, ctx.cwd || process.cwd());
        const stickyDecision = delegatedStickyRoute(cachedDecision)
          ? cachedDecision
          : {
              route_decision: {
                route: String(payload?.route || ""),
                system_preferred_route: String(payload?.system_preferred_route || payload?.route || ""),
                work_type: String(payload?.work_type || ""),
                phase: String(payload?.phase || ""),
                protocol: String(payload?.protocol || ""),
                reason_codes: Array.isArray(payload?.reason_codes) ? payload.reason_codes : [],
              },
            };
        const stickyPersisted = await persistStickyLane(stateKey, stickyDecision, pi.logger, { source: "dispatch" });
        const summary = await userFacingHandoff(
          payload,
          `OctoClaw dispatch: ${payload.route}${payload.executed ? " (executed)" : " (planned)"}`,
          ctx.cwd || process.cwd(),
        );
        await recordPolicyReplay(
          "dispatch_called",
          {
            sessionKey: stateKey || "",
            sessionId: String(ctx?.sessionId || ""),
            route: String(payload?.route || ""),
            systemPreferredRoute: String(cachedDecision?.route_decision?.system_preferred_route || payload?.system_preferred_route || ""),
            executed: Boolean(payload?.executed),
            usedCachedPolicy: Boolean(!params.policyJson && state?.decision),
            stickyPersisted,
          },
          pi.logger,
          cachedDecision,
        );
        return toolResponse(
          summary,
          payload,
        );
      },
    },
    { source: "octoclaw-runtime" },
  );

  pi.registerTool(
    {
      name: "octoclaw_spawn",
      label: "OctoClaw Spawn",
      description: "Generate and register a validated OctoClaw spawn task. Use this instead of hand-writing sessions_spawn arguments.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          task: { type: "string", description: "The task to run in a subagent." },
          route: { type: "string", enum: ["spawn_single", "spawn_multi"] },
          label: { type: "string", description: "Optional OctoClaw role label override." },
          tier: { type: "string", description: "Optional tier override." },
          model: { type: "string", description: "Optional model override." },
          runtime: { type: "string", enum: ["subagent", "acp"] },
          streamTo: { type: "string", description: "Only valid when runtime=acp." },
          parentId: { type: "string", description: "Optional parent task id." },
          execute: { type: "boolean", description: "Whether to immediately execute spawn via ClawTeam when enabled." }
        },
        required: ["task"]
      },
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const args = ["--task", params.task, "--register"];
        if (params.route) args.push("--route", params.route);
        if (params.label) args.push("--label", params.label);
        if (params.tier) args.push("--tier", params.tier);
        if (params.model) args.push("--model", params.model);
        if (params.runtime) args.push("--runtime", params.runtime);
        if (params.streamTo) args.push("--stream-to", params.streamTo);
        if (params.parentId) args.push("--parent-id", params.parentId);
        if (typeof params.execute === "boolean") args.push(params.execute ? "--execute" : "--no-execute");
        const payload = await runJsonScript("octoclaw_spawn.py", args, ctx.cwd || process.cwd());
        const summary = await userFacingHandoff(
          payload,
          `OctoClaw spawn registered: ${payload.label} / ${payload.model}`,
          ctx.cwd || process.cwd(),
        );
        return toolResponse(
          summary,
          payload,
        );
      },
    },
    { source: "octoclaw-runtime" },
  );

  pi.registerTool(
    {
      name: "octoclaw_status",
      label: "OctoClaw Status",
      description: "Show current OctoClaw runner and task state. Default to compact dashboard; use table/lanes only when the user explicitly asks for those views.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          format: { type: "string", enum: ["compact", "table", "lanes"] }
        }
      },
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const format = params.format || "compact";
        const output = await runStatus(format, ctx.cwd || process.cwd());
        return statusToolResponse(output, format);
      },
    },
    { source: "octoclaw-runtime" },
  );

  pi.registerCommand({
    name: "octostatus",
    description: "Show OctoClaw status; default compact dashboard, table/lanes only when explicitly requested",
    acceptsArgs: true,
    handler: async (ctx) => {
      const format = String(ctx.args || "").trim() || "compact";
      const output = await runStatus(format, ctx.cwd || process.cwd());
      if (ctx.hasUI) {
        ctx.ui.notify(`OctoClaw status (${format})`);
        ctx.ui.setEditorText(output);
      }
    },
  });

  pi.registerCommand({
    name: "octoroute",
    description: "Run OctoClaw route decision for a task",
    acceptsArgs: true,
    handler: async (ctx) => {
      const task = String(ctx.args || "").trim();
      if (!task) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /octoroute <task>", "error");
        return;
      }
      const payload = await runJsonScript("octoclaw_route.py", ["--task", task], ctx.cwd || process.cwd());
      if (ctx.hasUI) {
        ctx.ui.setEditorText(JSON.stringify(payload, null, 2));
        ctx.ui.notify(`OctoClaw system preferred route: ${payload.system_preferred_route || payload.route}`);
      }
    },
  });

  pi.registerCommand({
    name: "octopolicy",
    description: "Show the structured OctoClaw runtime policy decision for a task",
    acceptsArgs: true,
    handler: async (ctx) => {
      const task = String(ctx.args || "").trim();
      if (!task) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /octopolicy <task>", "error");
        return;
      }
      const payload = await runJsonScript("octoclaw_policy.py", ["--task", task], ctx.cwd || process.cwd());
      if (ctx.hasUI) {
        ctx.ui.setEditorText(JSON.stringify(payload, null, 2));
        ctx.ui.notify(policySummaryText(payload));
      }
    },
  });

  pi.registerCommand({
    name: "octospawn",
    description: "Register a validated OctoClaw spawn task",
    acceptsArgs: true,
    handler: async (ctx) => {
      const task = String(ctx.args || "").trim();
      if (!task) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /octospawn <task>", "error");
        return;
      }
      const payload = await runJsonScript("octoclaw_spawn.py", ["--task", task, "--register"], ctx.cwd || process.cwd());
      if (ctx.hasUI) {
        ctx.ui.setEditorText(JSON.stringify(payload, null, 2));
        ctx.ui.notify(`OctoClaw spawn registered: ${payload.task_id}`);
      }
    },
  });
  },
};

export default plugin;
