/**
 * Baseline storage for nightly-eval.
 *
 * The "stored baseline" is a pointer (file path) to the most recently promoted
 * nightly-eval report. When running `nightly-eval run`, if a stored baseline
 * exists, the calibration gate runs automatically against it.
 *
 * File: {openclawHome}/workspace/tmp/octopus/nightly-eval-baseline.json
 * Format: { reportPath: string; promotedAt: string; overallGate: string }
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export interface StoredBaseline {
  reportPath: string;
  promotedAt: string;
  overallGate: string;
}

function baselineFilePath(openclawHome?: string): string {
  const home = openclawHome ?? path.join(os.homedir(), ".openclaw");
  return path.join(home, "workspace", "tmp", "octopus", "nightly-eval-baseline.json");
}

export async function readStoredBaseline(openclawHome?: string): Promise<StoredBaseline | null> {
  const filePath = baselineFilePath(openclawHome);
  try {
    const raw = JSON.parse(await fs.readFile(filePath, "utf-8")) as unknown;
    if (!raw || typeof raw !== "object") return null;
    const record = raw as Record<string, unknown>;
    if (typeof record.reportPath !== "string" || !record.reportPath) return null;
    // Verify the referenced report still exists
    try { await fs.readFile(record.reportPath, "utf-8"); } catch { return null; }
    return {
      reportPath: record.reportPath,
      promotedAt: typeof record.promotedAt === "string" ? record.promotedAt : "",
      overallGate: typeof record.overallGate === "string" ? record.overallGate : "unknown",
    };
  } catch {
    return null;
  }
}

export async function writeStoredBaseline(reportPath: string, overallGate: string, openclawHome?: string): Promise<void> {
  const filePath = baselineFilePath(openclawHome);
  const absReportPath = reportPath.startsWith("/") || reportPath.startsWith("\\")
    ? reportPath
    : path.join(path.dirname(path.join(".", reportPath)), path.basename(reportPath));
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    JSON.stringify({ reportPath: absReportPath, promotedAt: new Date().toISOString(), overallGate }, null, 2),
    "utf-8",
  );
}

export async function clearStoredBaseline(openclawHome?: string): Promise<void> {
  const filePath = baselineFilePath(openclawHome);
  try { await fs.rm(filePath, { force: true }); } catch { /* ignore if not found */ }
}
