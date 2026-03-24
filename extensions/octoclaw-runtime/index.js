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

function toolResponse(summary, details = {}) {
  return {
    content: [{ type: "text", text: summary }],
    details,
  };
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

export default function (pi) {
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
        return toolResponse(
          handoffText(payload, `OctoClaw dispatch: ${payload.route}${payload.executed ? " (executed)" : " (planned)"}`),
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
          parentId: { type: "string", description: "Optional parent task id." }
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
        const payload = await runJsonScript("octoclaw_spawn.py", args, ctx.cwd || process.cwd());
        return toolResponse(
          handoffText(payload, `OctoClaw spawn registered: ${payload.label} / ${payload.model}`),
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
