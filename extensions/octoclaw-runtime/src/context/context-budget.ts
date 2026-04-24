import type { ContextBudgetReport } from "@octoclaw/contracts/delegate-context";

export const DEFAULT_CONTEXT_BUDGETS = {
  worker_handoff_max_tokens: 1800,
  worker_result_packet_max_tokens: 900,
  main_resume_packet_max_tokens: 700,
  artifact_summary_max_tokens: 250,
} as const;

export interface ContextBudgetLimit {
  maxTokens: number;
}

export interface ContextBudgetCheck {
  ok: boolean;
  estimatedTokens: number;
  maxTokens: number;
  overByTokens: number;
}

export interface ArtifactGateRequest {
  userAsk?: string;
  needsFinalAnswer?: boolean;
  summaryInsufficient?: boolean;
  recoveryOrDebug?: boolean;
  reviewerNeedsEvidence?: boolean;
}

const budgetReports: ContextBudgetReport[] = [];

function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Math.ceil((text ?? "").length / 4);
}

function removeForbiddenText(text: string): string {
  return text
    .replace(/\[Thread history - for context\][\s\S]*?(?=(User-visible:|$))/gi, "")
    .replace(/internal route\/delegation rationale:[\s\S]*?(?=(User-visible:|\n|$))/gi, "")
    .replace(/internal route rationale:[\s\S]*?(?=(User-visible:|\n|$))/gi, "")
    .replace(/delegation rationale:[\s\S]*?(?=(User-visible:|\n|$))/gi, "")
    .replace(/contamination guard(?: text)?:[\s\S]*?(?=(User-visible:|\n|$))/gi, "")
    .replace(/worker chain-of-thought:[\s\S]*?(?=(User-visible:|$))/gi, "")
    .replace(/execution log:[\s\S]*?(?=(User-visible:|$))/gi, "")
    .trim();
}

function compactPacket(packet: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: packet.schemaVersion,
    status: packet.status ?? (packet.statusPacket as { status?: unknown } | undefined)?.status,
    statusPacket: packet.statusPacket,
    artifactRefs: packet.artifactRefs ?? (packet.statusPacket as { artifactRefs?: unknown } | undefined)?.artifactRefs ?? [],
  };
}

export function checkContextBudget(packet: unknown, budget: ContextBudgetLimit): ContextBudgetCheck {
  const estimatedTokens = estimateTokens(packet);
  return {
    ok: estimatedTokens <= budget.maxTokens,
    estimatedTokens,
    maxTokens: budget.maxTokens,
    overByTokens: Math.max(0, estimatedTokens - budget.maxTokens),
  };
}

export function recordContextBudgetReport(report: ContextBudgetReport): ContextBudgetReport {
  budgetReports.push(report);
  return report;
}

export function getContextBudgetReports(): ContextBudgetReport[] {
  return [...budgetReports];
}

export function clearContextBudgetReports(): void {
  budgetReports.length = 0;
}

export function sanitizeMainContextInjection<TPacket>(packet: TPacket): TPacket | Record<string, unknown> {
  const sanitized = JSON.parse(JSON.stringify(packet)) as unknown;

  function visit(value: unknown): unknown {
    if (typeof value === "string") {
      return removeForbiddenText(value);
    }
    if (Array.isArray(value)) {
      return value.map(visit).filter((item) => item !== "");
    }
    if (value && typeof value === "object") {
      const output: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(value)) {
        if (["chainOfThought", "executionLog", "internalRationale", "contaminationGuard"].includes(key)) {
          continue;
        }
        output[key] = visit(nested);
      }
      return output;
    }
    return value;
  }

  const cleaned = visit(sanitized) as TPacket;
  const check = checkContextBudget(cleaned, { maxTokens: DEFAULT_CONTEXT_BUDGETS.main_resume_packet_max_tokens });
  if (!check.ok && cleaned && typeof cleaned === "object") {
    return compactPacket(cleaned as Record<string, unknown>);
  }
  return cleaned;
}

export function shouldOpenArtifactForMainAgent(request: ArtifactGateRequest): boolean {
  const ask = request.userAsk?.toLowerCase() ?? "";
  if (/full report|完整报告|evidence|证据|log|日志/.test(ask)) {
    return true;
  }
  if (request.needsFinalAnswer && request.summaryInsufficient) {
    return true;
  }
  if (request.recoveryOrDebug) {
    return true;
  }
  if (request.reviewerNeedsEvidence) {
    return true;
  }
  return false;
}
