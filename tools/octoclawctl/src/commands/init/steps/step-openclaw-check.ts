import { spawnSync } from "node:child_process";
import type { WizardState } from "../wizard-state.js";
import type { WizardOpts } from "../wizard-opts.js";

export interface StepOpenClawResult {
  version: string;
}

export async function runStepOpenClawCheck(
  state: WizardState,
  opts: WizardOpts,
): Promise<StepOpenClawResult> {
  const result = spawnSync("openclaw", ["--version"], {
    timeout: 3000,
    encoding: "utf8",
  });

  if (result.error || result.status !== 0) {
    const msg = opts.lang === "zh"
      ? "未检测到 OpenClaw。OctoClaw 需要 OpenClaw 才能运行。"
      : "OpenClaw not found. OctoClaw requires OpenClaw to run.";
    const hint = "https://github.com/openclaw/openclaw#installation";
    throw Object.assign(new Error(`${msg}\n→ ${hint}`), { code: "OPENCLAW_NOT_FOUND", exitCode: 1 });
  }

  const version = (result.stdout || "").trim();
  state.openclawVersion = version;
  return { version };
}
