import { spawnSync } from "node:child_process";

import { asString } from "../util/type-coercion.js";

export interface TmuxEvidenceSnapshot {
  enabled: boolean;
  available: boolean;
  session?: string;
  window?: string;
  pane?: string;
  alive: boolean;
  command?: string;
  cwd?: string;
  lastOutputHash?: string;
  outputChangedSinceLastCheck?: boolean;
  lastOutputAt?: string;
  recentOutputExcerpt?: string;
  capturedAt: string;
  error?: string;
}

export interface TmuxPaneMapping {
  session?: string;
  window?: string;
  pane?: string;
}

const TMUX_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_LINES = 80;
const DEFAULT_MAX_CHARS = 1_200;
const REDACTED_LINE_PATTERN = /password|secret|token|key|credential/iu;

export const lastSnapshots = new Map<string, TmuxEvidenceSnapshot>();

function capturedAtNow(): string {
  return new Date().toISOString();
}

function boundedPositiveInteger(value: unknown, fallback: number, max: number): number {
  const parsed = Number.parseInt(asString(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || String(error);
  return asString(error, "tmux evidence capture failed");
}

function tmuxTarget(mapping: TmuxPaneMapping): string {
  const session = asString(mapping.session);
  const window = asString(mapping.window);
  const pane = asString(mapping.pane);
  if (session && window && pane) return `${session}:${window}.${pane}`;
  if (session && window) return `${session}:${window}`;
  if (session && pane) return `${session}.${pane}`;
  if (session) return session;
  if (pane) return pane;
  return "";
}

function mappingHasTarget(mapping: TmuxPaneMapping): boolean {
  return Boolean(asString(mapping.session) || asString(mapping.pane));
}

function parsePaneInfo(output: string): { command?: string; cwd?: string } {
  const line = output.split("\n").find((entry) => entry.trim());
  if (!line) return {};

  const match = /^(\S+)\s+(\S+)(?:\s+(.*))?$/u.exec(line.trim());
  if (!match) return {};

  return {
    command: asString(match[2]) || undefined,
    cwd: asString(match[3]) || undefined,
  };
}

function simpleOutputHash(output: string): string {
  return `${output.length.toString(36)}:${output.split("\n").length}`;
}

function redactOutput(output: string): string {
  return output
    .split("\n")
    .map((line) => (REDACTED_LINE_PATTERN.test(line) ? "[REDACTED]" : line))
    .join("\n");
}

function truncateExcerpt(output: string): string {
  const maxChars = boundedPositiveInteger(process.env.OCTOCLAW_TMUX_EVIDENCE_MAX_CHARS, DEFAULT_MAX_CHARS, 20_000);
  if (output.length <= maxChars) return output;
  return output.slice(output.length - maxChars);
}

function runTmux(args: string[]): string {
  const result = spawnSync("tmux", args, {
    encoding: "utf8",
    timeout: TMUX_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(asString(result.stderr, `tmux exited with status ${result.status}`));
  return result.stdout;
}

export function isTmuxEvidenceEnabled(): boolean {
  return process.env.OCTOCLAW_TMUX_EVIDENCE === "1";
}

export function captureTmuxEvidence(mapping: TmuxPaneMapping): TmuxEvidenceSnapshot {
  const capturedAt = capturedAtNow();
  if (!isTmuxEvidenceEnabled()) {
    return { enabled: false, available: false, alive: false, capturedAt };
  }

  if (!mappingHasTarget(mapping)) {
    return { enabled: true, available: false, alive: false, capturedAt };
  }

  const session = asString(mapping.session) || undefined;
  const window = asString(mapping.window) || undefined;
  const pane = asString(mapping.pane) || undefined;
  const target = tmuxTarget(mapping);

  try {
    const paneInfo = runTmux(["list-panes", "-t", target, "-F", "#{pane_pid} #{pane_current_command} #{pane_current_path}"]);
    const { command, cwd } = parsePaneInfo(paneInfo);
    const maxLines = boundedPositiveInteger(process.env.OCTOCLAW_TMUX_EVIDENCE_MAX_LINES, DEFAULT_MAX_LINES, 2_000);
    const output = runTmux(["capture-pane", "-t", target, "-p", "-S", `-${maxLines}`]);
    const outputHash = simpleOutputHash(output);
    const previous = lastSnapshots.get(target);
    const redactedExcerpt = truncateExcerpt(redactOutput(output));
    const snapshot: TmuxEvidenceSnapshot = {
      enabled: true,
      available: true,
      session,
      window,
      pane,
      alive: true,
      command,
      cwd,
      lastOutputHash: outputHash,
      outputChangedSinceLastCheck: previous?.lastOutputHash !== outputHash,
      lastOutputAt: capturedAt,
      recentOutputExcerpt: redactedExcerpt,
      capturedAt,
    };
    lastSnapshots.set(target, snapshot);
    return snapshot;
  } catch (error) {
    return {
      enabled: true,
      available: false,
      session,
      window,
      pane,
      alive: false,
      capturedAt,
      error: errorMessage(error),
    };
  }
}
