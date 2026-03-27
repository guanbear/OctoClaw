import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveOctoClawRoot() {
  return process.env.OCTOCLAW_ROOT || path.resolve(__dirname, "..", "..");
}

function resolveScript(...parts) {
  return path.join(resolveOctoClawRoot(), "lib", ...parts);
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

const POLICY_STATE_TTL_MS = 30 * 60 * 1000;
const policyStateBySession = new Map();
const DELEGATED_ROUTE_NAMES = new Set(["runner", "spawn_single", "spawn_multi"]);
const OCTOCLAW_DELEGATION_SYSTEM_CONTEXT = [
  "OctoClaw runtime policy is authoritative for this run.",
  "When route is delegated, the main agent is a coordinator and must use OctoClaw control tools instead of doing the work directly.",
  "Do not hand-write session or subagent spawning commands.",
].join("\n");

function prunePolicyState() {
  const now = Date.now();
  for (const [key, value] of policyStateBySession.entries()) {
    if (!value || now - Number(value.updatedAt || value.createdAt || 0) > POLICY_STATE_TTL_MS) {
      policyStateBySession.delete(key);
    }
  }
}

function resolvePolicyStateKey(ctx = {}) {
  const value = String(ctx.sessionId || ctx.sessionKey || "").trim();
  return value;
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
  if (ctx.channelId) metadata.channel = ctx.channelId;
  if (ctx.sessionKey) metadata.session_key = ctx.sessionKey;
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
  const existing = stateKey ? policyStateBySession.get(stateKey) : null;
  if (!options.force && existing?.prompt === prompt && existing?.decision) {
    existing.updatedAt = Date.now();
    if (stateKey) {
      policyStateBySession.set(stateKey, existing);
    }
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
      blockedTools: Array.isArray(existing?.blockedTools) ? existing.blockedTools : [],
    };
    if (stateKey) {
      policyStateBySession.set(stateKey, nextState);
    }
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
  const routeSummary = [
    `route=${route}`,
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

export default function (pi) {
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
    const resolved = await resolvePolicyDecisionForContext(
      event?.prompt || "",
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
    const resolved = await resolvePolicyDecisionForContext(
      event?.prompt || "",
      ctx,
      process.cwd(),
      pi.logger,
    );
    const decision = resolved?.decision;
    const hookConfig = decision?.hook_interface?.before_prompt_build;
    if (!hookConfig?.enabled || !isDelegatedRoute(decision)) return;
    return {
      prependSystemContext: OCTOCLAW_DELEGATION_SYSTEM_CONTEXT,
      prependContext: compactPolicyPrompt(decision),
    };
  });

  registerLifecycleHook("before_tool_call", async (event, ctx) => {
    if (!isManagedAgentContext(ctx)) return;
    const stateKey = resolvePolicyStateKey(ctx);
    const state = stateKey ? policyStateBySession.get(stateKey) : null;
    const decision = state?.decision;
    const hookConfig = decision?.hook_interface?.before_tool_call;
    if (!hookConfig?.enabled) return;

    const toolName = String(event?.toolName || ctx?.toolName || "").trim();
    const toolPolicy = decision?.tool_policy || {};
    const blockedPatterns = Array.isArray(toolPolicy.block_tool_patterns) ? toolPolicy.block_tool_patterns : [];
    if (matchesBlockedPattern(stringifyParamsForPolicy(event?.params), blockedPatterns)) {
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
    return {
      block: true,
      blockReason: `OctoClaw runtime policy route=${decision?.route_decision?.route || "direct"} requires delegation. Use ${toolPolicy.must_delegate_via || "octoclaw_dispatch"} first. Allowed control tools: ${[...allowedControlTools].join(", ") || "octoclaw_dispatch"}.`,
    };
  });

  registerLifecycleHook("agent_end", async (_event, ctx) => {
    const stateKey = resolvePolicyStateKey(ctx);
    if (!stateKey) return;
    policyStateBySession.delete(stateKey);
  }, 50);

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
        return toolResponse(`OctoClaw route: ${payload.route} (confidence ${payload.confidence ?? "n/a"})`, payload);
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
          timeoutSeconds: { type: "number", description: "Runner timeout in seconds." }
        },
        required: ["task"]
      },
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const args = ["--task", params.task];
        if (params.command) args.push("--command", params.command);
        if (params.cwd) args.push("--cwd", params.cwd);
        if (typeof params.timeoutSeconds === "number") args.push("--timeout-seconds", String(params.timeoutSeconds));
        if (params.forceRoute) args.push("--force-route", params.forceRoute);
        args.push("--wait", "--wait-timeout-seconds", "12");
        const payload = await runJsonScript("dispatch_task.py", args, ctx.cwd || process.cwd());
        const summary = await userFacingHandoff(
          payload,
          `OctoClaw dispatch: ${payload.route}${payload.executed ? " (executed)" : " (planned)"}`,
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

  pi.registerCommand("octostatus", {
    description: "Show OctoClaw status; default compact dashboard, table/lanes only when explicitly requested",
    handler: async (args, ctx) => {
      const format = (args || "").trim() || "compact";
      const output = await runStatus(format, ctx.cwd || process.cwd());
      if (ctx.hasUI) {
        ctx.ui.notify(`OctoClaw status (${format})`);
        ctx.ui.setEditorText(output);
      }
    },
  });

  pi.registerCommand("octoroute", {
    description: "Run OctoClaw route decision for a task",
    handler: async (args, ctx) => {
      const task = (args || "").trim();
      if (!task) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /octoroute <task>", "error");
        return;
      }
      const payload = await runJsonScript("octoclaw_route.py", ["--task", task], ctx.cwd || process.cwd());
      if (ctx.hasUI) {
        ctx.ui.setEditorText(JSON.stringify(payload, null, 2));
        ctx.ui.notify(`OctoClaw route: ${payload.route}`);
      }
    },
  });

  pi.registerCommand("octopolicy", {
    description: "Show the structured OctoClaw runtime policy decision for a task",
    handler: async (args, ctx) => {
      const task = (args || "").trim();
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

  pi.registerCommand("octospawn", {
    description: "Register a validated OctoClaw spawn task",
    handler: async (args, ctx) => {
      const task = (args || "").trim();
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
}
