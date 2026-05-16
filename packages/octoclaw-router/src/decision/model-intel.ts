import type { ModelIntelSnapshot } from "./contracts.js";
import {
  buildModelIntelFactsPlane,
  type BuildModelIntelFactsPlaneInput,
} from "./model-intel-facts.js";

export type BuildModelIntelSnapshotInput = BuildModelIntelFactsPlaneInput;

export function buildModelIntelSnapshot(input: BuildModelIntelSnapshotInput): ModelIntelSnapshot {
  const facts = buildModelIntelFactsPlane(input);
  return {
    schemaVersion: "octoclaw.router_lite.model_intel_snapshot/v1",
    snapshotId: `model-intel:${Date.parse(facts.generatedAt) || Date.now()}`,
    generatedAt: facts.generatedAt,
    nativeFallbackOrder: facts.nativeFallbackOrder,
    sourceStatus: facts.sourceStatus,
    models: facts.models,
  };
}
