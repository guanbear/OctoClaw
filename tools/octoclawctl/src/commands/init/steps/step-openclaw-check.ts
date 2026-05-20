import { spawnSync } from "node:child_process";
import type { WizardState } from "../wizard-state.js";
import type { WizardOpts } from "../wizard-opts.js";
import { isOpenClawVersionSupported, MIN_OPENCLAW_VERSION } from "../../../readiness.js";

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
  if (!isOpenClawVersionSupported(version)) {
    const msg = opts.lang === "zh"
      ? `OpenClaw 版本过旧。OctoClaw 需要 OpenClaw >= ${MIN_OPENCLAW_VERSION}。`
      : `OpenClaw is too old. OctoClaw requires OpenClaw >= ${MIN_OPENCLAW_VERSION}.`;
    throw Object.assign(new Error(`${msg}\n→ ${version || "unknown version"}`), {
      code: "OPENCLAW_UNSUPPORTED_VERSION",
      exitCode: 1,
    });
  }

  state.openclawVersion = version;
  return { version };
}
