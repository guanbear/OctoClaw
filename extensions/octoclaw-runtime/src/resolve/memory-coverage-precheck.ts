import type { JudgeMemoryLayer } from "@octoclaw/policy/judge";

export function buildMemoryCoverageLayer(): JudgeMemoryLayer {
  return {
    coverage: "none",
    freshness_risk: "high",
    supports_direct_reply: false,
    supports_fresh_lookup: false,
    evidence_summary: "no memory layer configured in v1",
  };
}
