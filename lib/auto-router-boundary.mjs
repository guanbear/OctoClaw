#!/usr/bin/env node

function buildBoundaryManifest() {
  return {
    schema_version: "octoclaw.auto_router.boundary/v1",
    generated_by: "octoclaw-rm4",
    extractable_readiness: {
      status: "baseline",
      summary:
        "Auto Router has a stable recommendation seam and facts plane, but runtime adapters remain internal to OctoClaw.",
      ready_now: [
        "recommendation payload contract",
        "model-intel facts plane snapshots",
        "router eval baseline",
      ],
      not_ready_yet: [
        "runtime policy adapter extraction",
        "delegated lane execution adapter extraction",
        "full standalone HTTP/proxy service",
      ],
    },
    package_boundary: {
      candidate_package: "octoclaw-auto-router",
      responsibility: [
        "signal extraction",
        "route recommendation",
        "budget recommendation",
        "model-intel facts plane",
        "router eval / replay evidence baseline",
      ],
      explicitly_out_of_scope: [
        "taskflow substrate orchestration",
        "observer/status surfaces",
        "patrol recovery/notification loops",
        "IM display / task action surfaces",
        "backend-specific execution control",
      ],
    },
    public_surface_shortlist: [
      {
        name: "recommendation_payload",
        stability: "candidate_public",
        producer: "lib/auto_router.py",
        schemas: [
          "octoclaw.auto_router.recommendation/v1",
          "octoclaw.auto_router.signal/v1",
          "octoclaw.auto_router.router_core/v1",
          "octoclaw.auto_router.budget_planner/v1",
          "octoclaw.auto_router.model_intel/v1",
          "octoclaw.auto_router.adapter/v1",
        ],
        notes: "Primary recommendation seam; adapter subobject remains runtime-aware.",
      },
      {
        name: "model_intel_facts_plane",
        stability: "candidate_public",
        producer: "lib/model-intel.py",
        files: [
          "tmp/octopus/model-catalog.json",
          "tmp/octopus/model-policy.json",
          "tmp/octopus/model-intel-source-status.json",
        ],
        notes: "Source-attributed facts plane and source precedence summary.",
      },
      {
        name: "router_eval_baseline",
        stability: "candidate_public",
        producer: "lib/router_eval.py",
        schemas: ["octoclaw.router_eval/v1"],
        notes: "Replay-driven route/budget drift baseline.",
      },
      {
        name: "model_intel_sync",
        stability: "candidate_public",
        producer: "lib/model-intel-sync.mjs",
        notes: "Online source adapter refresh, still file-based and runtime-local.",
      },
    ],
    internal_only_runtime_coupling: [
      {
        area: "policy_adapter",
        files: [
          "lib/octoclaw_policy.py",
          "extensions/octoclaw-runtime/policy/decide.js",
        ],
        reason:
          "Maps recommendation into OctoClaw runtime policy, protected lanes, tool gating, and hook semantics.",
      },
      {
        area: "delegated_lane_consumption",
        files: [
          "lib/dispatch_task.py",
          "lib/octoclaw_spawn.py",
        ],
        reason:
          "Consumes route/model/budget decisions inside runner/spawn lane execution contracts.",
      },
      {
        area: "operator_and_runtime_surfaces",
        files: [
          "lib/runtime_observer.py",
          "lib/patrol.py",
          "lib/task_display.py",
        ],
        reason:
          "Observer, patrol, and display surfaces depend on OctoClaw runtime state rather than router-only concerns.",
      },
    ],
    extraction_sequence: [
      "freeze recommendation and facts-plane schemas",
      "keep adapter/runtime hooks internal",
      "extract source adapters and router eval before runtime adapters",
      "only discuss standalone service after adapter/runtime couplings shrink further",
    ],
  };
}

function main() {
  process.stdout.write(`${JSON.stringify(buildBoundaryManifest(), null, 2)}\n`);
}

export const __autoRouterBoundaryTest = { buildBoundaryManifest };

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  main();
}
