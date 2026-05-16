import { execFile } from "node:child_process";
import type { ProviderConfig } from "./openclaw-bridge.js";
import type { HealthEventInput } from "../health/event.js";

export interface ProbeCommandResult {
  exitCode: number;
  stdout: string;
  stderr?: string;
}

export type ProbeCommandRunner = (args: string[], options: { timeoutMs: number }) => Promise<ProbeCommandResult>;

export interface ProbeRequest {
  modelKey: string;
  providerConfig: ProviderConfig;
  timeoutMs?: number;
  budgetUsdMax?: number;
  estimatedBlendedUsdPerMTok?: number;
  runOpenClaw?: ProbeCommandRunner;
  recordHealthEvent?: (event: HealthEventInput) => void;
}

export interface ProbeResult {
  modelKey: string;
  ok: boolean;
  authOk: "yes" | "no" | "unknown";
  modelExists: "yes" | "no" | "unknown";
  toolUseOk: "yes" | "no" | "unknown";
  latencyMs?: number;
  costUsd?: number;
  error?: { code: string; message: string };
  evidence: Array<{
    source: "http_status" | "response_body" | "exception";
    detail: string;
  }>;
}

const PROBE_TOKEN_BUDGET = 80;
const CANARY_PROMPT = "Reply with exactly: pong";

function estimatedCostUsd(priceUsdPerMTok: number | undefined): number | undefined {
  return priceUsdPerMTok === undefined ? undefined : (priceUsdPerMTok * PROBE_TOKEN_BUDGET) / 1_000_000;
}

function sanitizedError(code: string, message: string): ProbeResult["error"] {
  return { code, message };
}

export async function probeModel(request: ProbeRequest): Promise<ProbeResult> {
  const timeoutMs = request.timeoutMs ?? 15000;
  const budgetUsdMax = request.budgetUsdMax ?? 0.001;
  const costUsd = estimatedCostUsd(request.estimatedBlendedUsdPerMTok);
  if (costUsd !== undefined && costUsd > budgetUsdMax) {
    return {
      modelKey: request.modelKey,
      ok: false,
      authOk: "unknown",
      modelExists: "unknown",
      toolUseOk: "unknown",
      costUsd,
      error: sanitizedError("PROBE_BUDGET_EXCEEDED", "Probe estimated cost exceeds budgetUsdMax before sending."),
      evidence: [],
    };
  }

  void request.providerConfig;
  const runOpenClaw = request.runOpenClaw ?? defaultOpenClawRunner;
  const started = Date.now();
  try {
    const commandResult = await runOpenClaw([
      "infer",
      "model",
      "run",
      "--model",
      request.modelKey,
      "--prompt",
      CANARY_PROMPT,
      "--json",
    ], { timeoutMs });
    const latencyMs = Date.now() - started;
    if (commandResult.exitCode === 0) {
      const result: ProbeResult = {
        modelKey: request.modelKey,
        ok: true,
        authOk: "yes",
        modelExists: "yes",
        toolUseOk: "unknown" as const,
        latencyMs,
        ...(costUsd !== undefined ? { costUsd } : {}),
        evidence: [
          { source: "response_body" as const, detail: "openclaw_canary_response_received" },
        ],
      };
      recordProbeHealth(request, result, latencyMs);
      return result;
    }
    const classified = classifyOpenClawFailure(commandResult);
    const result: ProbeResult = {
      modelKey: request.modelKey,
      ok: false,
      authOk: classified.authOk,
      modelExists: classified.modelExists,
      toolUseOk: "unknown" as const,
      latencyMs,
      ...(costUsd !== undefined ? { costUsd } : {}),
      error: sanitizedError(classified.code, classified.message),
      evidence: [{ source: "exception" as const, detail: `openclaw_exit_${commandResult.exitCode}` }],
    };
    recordProbeHealth(request, result, latencyMs);
    return result;
  } catch (error) {
    const isAbort = error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
    const result: ProbeResult = {
      modelKey: request.modelKey,
      ok: false,
      authOk: "unknown",
      modelExists: "unknown",
      toolUseOk: "unknown",
      ...(costUsd !== undefined ? { costUsd } : {}),
      error: sanitizedError(isAbort ? "PROBE_TIMEOUT" : "PROBE_EXCEPTION", isAbort ? "Probe timed out." : "Probe request failed."),
      evidence: [{ source: "exception", detail: isAbort ? "AbortError" : "request_failed" }],
    };
    recordProbeHealth(request, result, Date.now() - started);
    return result;
  }
}

function defaultOpenClawRunner(args: string[], options: { timeoutMs: number }): Promise<ProbeCommandResult> {
  return new Promise((resolve, reject) => {
    execFile("openclaw", args, { timeout: options.timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && error.code === "ETIMEDOUT") {
        const timeoutError = new Error("OpenClaw probe timed out.");
        timeoutError.name = "TimeoutError";
        reject(timeoutError);
        return;
      }
      resolve({
        exitCode: typeof error?.code === "number" ? error.code : 0,
        stdout,
        stderr,
      });
    });
  });
}

function classifyOpenClawFailure(result: ProbeCommandResult): {
  code: string;
  message: string;
  authOk: ProbeResult["authOk"];
  modelExists: ProbeResult["modelExists"];
} {
  const text = `${result.stdout}\n${result.stderr ?? ""}`.toLowerCase();
  if (text.includes("401") || text.includes("403") || text.includes("unauthorized") || text.includes("auth") || text.includes("api key") || text.includes("bad key")) {
    return {
      code: "PROBE_AUTH_FAILED",
      message: "OpenClaw infer rejected provider authentication.",
      authOk: "no",
      modelExists: "unknown",
    };
  }
  if (text.includes("404") || text.includes("not found") || text.includes("unknown model")) {
    return {
      code: "PROBE_MODEL_NOT_FOUND",
      message: "OpenClaw infer reported the model is unavailable.",
      authOk: "yes",
      modelExists: "no",
    };
  }
  if (text.includes("429") || text.includes("rate limit")) {
    return {
      code: "429",
      message: "OpenClaw infer reported a rate limit.",
      authOk: "yes",
      modelExists: "yes",
    };
  }
  if (text.includes("no text output returned")) {
    return {
      code: "PROBE_NO_TEXT_OUTPUT",
      message: "OpenClaw infer reached the model but did not return usable text.",
      authOk: "yes",
      modelExists: "yes",
    };
  }
  return {
    code: "PROBE_HTTP_ERROR",
    message: "OpenClaw infer canary failed.",
    authOk: "unknown",
    modelExists: "unknown",
  };
}

function recordProbeHealth(request: ProbeRequest, result: ProbeResult, latencyMs: number | undefined): void {
  try {
    request.recordHealthEvent?.({
      modelKey: request.modelKey,
      source: "probe",
      success: result.ok,
      latencyMs,
      errorCode: result.error?.code,
      timeout: result.error?.code === "PROBE_TIMEOUT",
      evidence: { command: "openclaw infer model run" },
    });
  } catch {
    // Probe health recording must not change probe semantics.
  }
}
