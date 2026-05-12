import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { RouterLiteShadowEvent } from "./contracts.js";

export type { RouterLiteShadowEvent } from "./contracts.js";

export interface ShadowEventWriteOptions {
  onError?: (error: unknown) => void;
}

export interface ShadowReportSummary {
  totalEvents: number;
  uniqueModelsRecommended: string[];
  uniqueModelsActual: string[];
  ignoredReasonCounts: Record<string, number>;
  estimatedCostDeltaTotalUsd: number;
  modeCounts: Record<string, number>;
  scenarioCounts: Record<string, number>;
  qualityGatePass: number;
  qualityGateFail: number;
  qualityGateUnknown: number;
  timeRange?: { first: string; last: string };
}

export function writeShadowEvent(event: RouterLiteShadowEvent, jsonlPath: string, options: ShadowEventWriteOptions = {}): void {
  try {
    mkdirSync(dirname(jsonlPath), { recursive: true });
    const jsonLine = JSON.stringify(event);
    appendFileSync(jsonlPath, jsonLine + "\n");
  } catch (error) {
    options.onError?.(error);
  }
}

export function generateShadowReport(jsonlPath: string): ShadowReportSummary {
  const summary = emptyShadowReport();

  if (!existsSync(jsonlPath)) {
    return summary;
  }

  try {
    const content = readFileSync(jsonlPath, "utf-8");
    const lines = content.split("\n").filter((line) => line.trim() !== "");

    const uniqueModelsRecommended = new Set<string>();
    const uniqueModelsActual = new Set<string>();
    const ignoredReasonCounts: Record<string, number> = {};
    const modeCounts: Record<string, number> = {};
    const scenarioCounts: Record<string, number> = {};

    let turnIds: string[] = [];

    for (const line of lines) {
      try {
        const event: RouterLiteShadowEvent = JSON.parse(line);

        summary.totalEvents++;

        if (event.recommendation.recommendedModel) {
          uniqueModelsRecommended.add(event.recommendation.recommendedModel);
        }

        if (event.actualModel) {
          uniqueModelsActual.add(event.actualModel);
        }

        if (event.recommendation.ignoredReason) {
          ignoredReasonCounts[event.recommendation.ignoredReason] = (ignoredReasonCounts[event.recommendation.ignoredReason] ?? 0) + 1;
        }

        if (event.estimatedCostDeltaUsd !== undefined) {
          summary.estimatedCostDeltaTotalUsd += event.estimatedCostDeltaUsd;
        }

        const mode = event.recommendation.scoringMode ?? "unknown";
        modeCounts[mode] = (modeCounts[mode] ?? 0) + 1;

        const scenario = event.scenario ?? "unknown";
        scenarioCounts[scenario] = (scenarioCounts[scenario] ?? 0) + 1;

        if (event.qualityGate === "pass") {
          summary.qualityGatePass++;
        } else if (event.qualityGate === "fail") {
          summary.qualityGateFail++;
        } else {
          summary.qualityGateUnknown++;
        }

        if (event.turnId) {
          turnIds.push(event.turnId);
        }
      } catch {
        // Skip corrupt lines
        continue;
      }
    }

    summary.uniqueModelsRecommended = Array.from(uniqueModelsRecommended).sort();
    summary.uniqueModelsActual = Array.from(uniqueModelsActual).sort();
    summary.ignoredReasonCounts = ignoredReasonCounts;
    summary.modeCounts = modeCounts;
    summary.scenarioCounts = scenarioCounts;

    // Use turnIds as a proxy for time range (first and last turn)
    if (turnIds.length > 0) {
      summary.timeRange = {
        first: turnIds[0],
        last: turnIds[turnIds.length - 1],
      };
    }
  } catch {
    // Fail-open: return empty summary on any error
  }

  return summary;
}

export function emptyShadowReport(): ShadowReportSummary {
  return {
    totalEvents: 0,
    uniqueModelsRecommended: [],
    uniqueModelsActual: [],
    ignoredReasonCounts: {},
    estimatedCostDeltaTotalUsd: 0,
    modeCounts: {},
    scenarioCounts: {},
    qualityGatePass: 0,
    qualityGateFail: 0,
    qualityGateUnknown: 0,
  };
}
