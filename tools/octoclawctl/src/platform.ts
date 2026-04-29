import path from "node:path";
import { spawn } from "node:child_process";

declare const process: { platform: string; env: Record<string, string | undefined> };

export interface ServiceRestartResult {
  success: boolean;
  error?: string;
}

function openClawStateEnv(openclawHome: string): Record<string, string | undefined> {
  return {
    OPENCLAW_STATE_DIR: openclawHome,
    OPENCLAW_CONFIG_PATH: path.join(openclawHome, "openclaw.json"),
  };
}

export async function restartService(service: "gateway" | "node", openclawHome: string): Promise<ServiceRestartResult> {
  const openclawArgs = service === "gateway" ? ["gateway", "restart"] : ["node", "restart"];
  const cliResult = await tryRun("openclaw", openclawArgs, openClawStateEnv(openclawHome));
  if (cliResult.success) return cliResult;

  if (process.platform === "darwin") {
    const uid = await captureOutput("id", ["-u"]);
    const label = service === "gateway" ? "ai.openclaw.gateway" : "ai.openclaw.node";
    const result = await tryRun("launchctl", ["kickstart", "-k", `gui/${uid}/${label}`]);
    if (result.success) return result;
  }

  if (process.platform === "linux") {
    const unit = service === "gateway" ? "openclaw-gateway" : "openclaw-node";
    const result = await tryRun("systemctl", ["--user", "restart", unit]);
    if (result.success) return result;
  }

  return { success: false, error: `Unable to restart OpenClaw ${service} on ${process.platform}: ${cliResult.error ?? "unknown"}` };
}

export async function restartOpenClawGateway(openclawHome: string): Promise<ServiceRestartResult> {
  return restartService("gateway", openclawHome);
}

export async function restartOpenClawNode(openclawHome: string): Promise<ServiceRestartResult> {
  return restartService("node", openclawHome);
}

export async function installLaunchAgent(plistPath: string): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error(`LaunchAgent install is only supported on macOS, not ${process.platform}`);
  }
  const result = await tryRun("launchctl", ["load", plistPath]);
  if (!result.success) {
    throw new Error(`LaunchAgent load failed: ${result.error ?? "unknown"}`);
  }
}

export async function uninstallLaunchAgent(plistPath: string): Promise<void> {
  if (process.platform !== "darwin") return;
  await tryRun("launchctl", ["unload", plistPath]);
}

async function tryRun(command: string, args: string[], env: Record<string, string | undefined> = {}, timeoutMs = 15_000): Promise<ServiceRestartResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
    let stderr = "";
    let settled = false;
    const settle = (result: ServiceRestartResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      (child as unknown as { kill(signal: string): void }).kill("SIGTERM");
      settle({ success: false, error: `${command} ${args.join(" ")} timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stderr?.on("data", (chunk: Uint8Array | string) => { stderr += chunk.toString(); });
    child.on("error", (error: Error) => settle({ success: false, error: error.message }));
    child.on("close", (code: number | null) => settle(code === 0 ? { success: true } : { success: false, error: stderr.trim() || `${command} exited ${code ?? 1}` }));
  });
}

async function captureOutput(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout?.on("data", (chunk: Uint8Array | string) => { stdout += chunk.toString(); });
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(stdout.trim()));
  });
}
