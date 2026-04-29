import { readConfig, setConfigField, syncToOpenClawPluginConfig, writeConfig, getConfigField } from "./config.js";
import { restartOpenClawGateway, restartOpenClawNode } from "./platform.js";

export async function enablePlugin(openclawHome: string): Promise<string> {
  const config = await readConfig(openclawHome);
  config.enabled = true;
  await syncToOpenClawPluginConfig(openclawHome, config);
  await writeConfig(openclawHome, config);
  await restartOpenClawGateway(openclawHome);
  await restartOpenClawNode(openclawHome);
  return "✅ OctoClaw enabled and OpenClaw restarted";
}

export async function disablePlugin(openclawHome: string): Promise<string> {
  const config = await readConfig(openclawHome);
  config.enabled = false;
  await syncToOpenClawPluginConfig(openclawHome, config);
  await writeConfig(openclawHome, config);
  await restartOpenClawGateway(openclawHome);
  await restartOpenClawNode(openclawHome);
  return "✅ OctoClaw disabled and OpenClaw restarted (install preserved)";
}

export async function showStatus(openclawHome: string): Promise<string> {
  const config = await readConfig(openclawHome);
  return [
    `enabled: ${config.enabled}`,
    "version: unknown (?)",
    `installed_at: ${config._updatedAt ?? "unknown"}`,
    `judge: ${config.judge.enabled ? `enabled (${config.judge.modelId || "unknown"})` : "disabled"}`,
    `delegation: ${config.features.delegation}`,
    `im_notifications: ${config.features.imNotifications}`,
  ].join("\n");
}

export async function setConfigValue(openclawHome: string, key: string, value: string): Promise<string> {
  await setConfigField(openclawHome, key, value);
  return `set ${key}`;
}

export async function getConfigValue(openclawHome: string, key?: string): Promise<string> {
  const config = await readConfig(openclawHome);
  if (!key) return JSON.stringify(config, null, 2);
  const value = getConfigField(config, key);
  return typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);
}

export async function restartAll(openclawHome: string): Promise<string> {
  const gateway = await restartOpenClawGateway(openclawHome);
  const node = await restartOpenClawNode(openclawHome);
  return [`gateway: ${gateway.success ? "restarted" : gateway.error}`, `node: ${node.success ? "restarted" : node.error}`].join("\n");
}
