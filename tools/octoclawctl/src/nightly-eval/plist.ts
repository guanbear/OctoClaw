import os from "node:os";
import type { LaunchAgentConfig } from "./types.js";

export function generateLaunchAgentPlist(config: LaunchAgentConfig): string {
  validateScheduleHour(config.scheduleHour);
  const stdoutPath = `${config.logDir}/nightly-eval-stdout.log`;
  const stderrPath = `${config.logDir}/nightly-eval-stderr.log`;
  const args = [config.programPath, "nightly-eval", "run", "--config", config.configPath, "--output-dir", config.outputDir];

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(config.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${escapeXml(arg)}</string>`).join("\n")}
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${config.scheduleHour}</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stderrPath)}</string>
  <key>RunAtLoad</key>
  <false/>
  <key>KeepAlive</key>
  <false/>
</dict>
</plist>
`;
}

export function defaultLabel(): string {
  return "ai.octoclaw.nightly-eval";
}

export function defaultPlistPath(): string {
  return `${os.homedir()}/Library/LaunchAgents/ai.octoclaw.nightly-eval.plist`;
}

export function validateScheduleHour(hour: number): void {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error("scheduleHour must be an integer from 0 to 23");
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
