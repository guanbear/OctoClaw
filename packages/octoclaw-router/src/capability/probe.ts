import type { ProviderConfig } from "./openclaw-bridge.js";

export type ProbeFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ProbeRequest {
  modelKey: string;
  providerConfig: ProviderConfig;
  timeoutMs?: number;
  budgetUsdMax?: number;
  estimatedBlendedUsdPerMTok?: number;
  fetch?: ProbeFetch;
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

function probeUrl(config: ProviderConfig): string {
  const base = config.baseUrl.replace(/\/+$/u, "");
  if (config.format === "ollama") return `${base}/api/chat`;
  if (base.endsWith("/chat/completions") || base.endsWith("/messages")) return base;
  return config.format === "anthropic_messages" ? `${base}/messages` : `${base}/chat/completions`;
}

function canaryBody(modelKey: string, config: ProviderConfig): unknown {
  const model = modelKey.includes("/") ? modelKey.slice(modelKey.indexOf("/") + 1) : modelKey;
  if (config.format === "anthropic_messages") {
    return {
      model,
      messages: [{ role: "user", content: "Reply with exactly: pong" }],
      max_tokens: 16,
      temperature: 0,
    };
  }
  if (config.format === "ollama") {
    return {
      model,
      messages: [{ role: "user", content: "Reply with exactly: pong" }],
      stream: false,
      options: { temperature: 0, num_predict: 16 },
    };
  }
  return {
    model,
    messages: [{ role: "user", content: "Reply with exactly: pong" }],
    tools: [{
      type: "function",
      function: {
        name: "echo",
        description: "echo input",
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
      },
    }],
    tool_choice: { type: "function", function: { name: "echo" } },
    max_tokens: 16,
    temperature: 0,
  };
}

function estimatedCostUsd(priceUsdPerMTok: number | undefined): number | undefined {
  return priceUsdPerMTok === undefined ? undefined : (priceUsdPerMTok * PROBE_TOKEN_BUDGET) / 1_000_000;
}

function sanitizedError(code: string, message: string): ProbeResult["error"] {
  return { code, message };
}

function toolUseStatus(body: unknown): "yes" | "no" | "unknown" {
  const text = JSON.stringify(body);
  if (text.includes("tool_calls") || text.includes("\"echo\"")) return "yes";
  return "unknown";
}

export async function probeModel(request: ProbeRequest): Promise<ProbeResult> {
  const timeoutMs = request.timeoutMs ?? 5000;
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

  const fetchImpl = request.fetch ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetchImpl(probeUrl(request.providerConfig), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [request.providerConfig.authHeader.name]: request.providerConfig.authHeader.value,
      },
      body: JSON.stringify(canaryBody(request.modelKey, request.providerConfig)),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    const body = await response.json().catch(() => ({})) as unknown;
    if (response.ok) {
      return {
        modelKey: request.modelKey,
        ok: true,
        authOk: "yes",
        modelExists: "yes",
        toolUseOk: toolUseStatus(body),
        latencyMs,
        ...(costUsd !== undefined ? { costUsd } : {}),
        evidence: [
          { source: "http_status", detail: `HTTP ${response.status}` },
          { source: "response_body", detail: "canary_response_received" },
        ],
      };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        modelKey: request.modelKey,
        ok: false,
        authOk: "no",
        modelExists: "unknown",
        toolUseOk: "unknown",
        latencyMs,
        ...(costUsd !== undefined ? { costUsd } : {}),
        error: sanitizedError("PROBE_AUTH_FAILED", `Provider returned HTTP ${response.status}.`),
        evidence: [{ source: "http_status", detail: `HTTP ${response.status}` }],
      };
    }
    if (response.status === 404) {
      return {
        modelKey: request.modelKey,
        ok: false,
        authOk: "yes",
        modelExists: "no",
        toolUseOk: "unknown",
        latencyMs,
        ...(costUsd !== undefined ? { costUsd } : {}),
        error: sanitizedError("PROBE_MODEL_NOT_FOUND", "Provider returned HTTP 404."),
        evidence: [{ source: "http_status", detail: "HTTP 404" }],
      };
    }
    return {
      modelKey: request.modelKey,
      ok: false,
      authOk: "unknown",
      modelExists: "unknown",
      toolUseOk: "unknown",
      latencyMs,
      ...(costUsd !== undefined ? { costUsd } : {}),
      error: sanitizedError("PROBE_HTTP_ERROR", `Provider returned HTTP ${response.status}.`),
      evidence: [{ source: "http_status", detail: `HTTP ${response.status}` }],
    };
  } catch (error) {
    const isAbort = error instanceof DOMException && error.name === "AbortError";
    return {
      modelKey: request.modelKey,
      ok: false,
      authOk: "unknown",
      modelExists: "unknown",
      toolUseOk: "unknown",
      ...(costUsd !== undefined ? { costUsd } : {}),
      error: sanitizedError(isAbort ? "PROBE_TIMEOUT" : "PROBE_EXCEPTION", isAbort ? "Probe timed out." : "Probe request failed."),
      evidence: [{ source: "exception", detail: isAbort ? "AbortError" : "request_failed" }],
    };
  } finally {
    clearTimeout(timeout);
  }
}
