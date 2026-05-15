import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

import type { RouterWizardState } from "./flow.js";

export function routerWizardStatePath(openclawHome = path.join(os.homedir(), ".openclaw")): string {
  return path.join(openclawHome, "octoclaw", "router-wizard.state.json");
}

function isRouterWizardState(value: unknown): value is RouterWizardState {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as { schemaVersion?: unknown }).schemaVersion === "octoclaw.router_wizard_state/v1";
}

async function fsyncFile(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fsyncDirectory(dirPath: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fs.open(dirPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function saveRouterWizardState(
  state: RouterWizardState,
  options: { openclawHome?: string } = {},
): Promise<string> {
  const filePath = routerWizardStatePath(options.openclawHome);
  const dirPath = path.dirname(filePath);
  const tmpPath = `${filePath}.tmp`;
  await fs.mkdir(dirPath, { recursive: true });
  await fs.writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fsyncFile(tmpPath);
  await fs.rename(tmpPath, filePath);
  await fsyncDirectory(dirPath);
  return filePath;
}

export async function loadRouterWizardState(
  options: { openclawHome?: string; now?: string } = {},
): Promise<{ state: RouterWizardState | null; recovered: boolean; error?: string }> {
  const filePath = routerWizardStatePath(options.openclawHome);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRouterWizardState(parsed)) {
      throw new Error(`Invalid router wizard state schema: ${filePath}`);
    }
    return { state: parsed, recovered: false };
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT") {
      return { state: null, recovered: false };
    }
    const suffix = (options.now ?? new Date().toISOString()).replace(/[:.]/gu, "-");
    const corruptPath = `${filePath}.corrupt-${suffix}`;
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      if (fsSync.existsSync(filePath)) await fs.rename(filePath, corruptPath);
    } catch {}
    return { state: null, recovered: true, error: error instanceof Error ? error.message : String(error) };
  }
}
