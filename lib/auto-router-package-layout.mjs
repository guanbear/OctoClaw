#!/usr/bin/env node

export function buildPackageLayoutManifest() {
  return {
    schema_version: "octoclaw.auto_router.package_layout/v1",
    package_name: "octoclaw-auto-router",
    status: "prep_baseline",
    summary:
      "Defines the future package-owned surfaces and migration order without extracting runtime adapters yet.",
    public_entries: [
      {
        name: "manifest",
        command: "node lib/auto-router-surface.mjs manifest",
        surface: "boundary manifest",
        owner: "node_runtime_shell",
      },
      {
        name: "layout",
        command: "node lib/auto-router-surface.mjs layout",
        surface: "package layout manifest",
        owner: "node_runtime_shell",
      },
      {
        name: "facts",
        command: "node lib/auto-router-surface.mjs facts",
        surface: "model-intel facts plane",
        owner: "node_runtime_shell",
      },
      {
        name: "recommend",
        command: "node lib/auto-router-surface.mjs recommend --task ...",
        surface: "recommendation payload",
        owner: "python_router_core",
      },
      {
        name: "eval",
        command: "node lib/auto-router-surface.mjs eval --events ...",
        surface: "router eval baseline",
        owner: "python_router_eval",
      },
      {
        name: "sync",
        command: "node lib/model-intel-sync.mjs refresh",
        surface: "model-intel online source sync",
        owner: "node_source_adapters",
      },
    ],
    ownership_groups: [
      {
        name: "python_router_core",
        files: ["lib/auto_router.py"],
        exports: [
          "octoclaw.auto_router.recommendation/v1",
          "octoclaw.auto_router.signal/v1",
          "octoclaw.auto_router.router_core/v1",
          "octoclaw.auto_router.budget_planner/v1",
          "octoclaw.auto_router.model_intel/v1",
        ],
      },
      {
        name: "python_router_eval",
        files: ["lib/router_eval.py", "lib/replay_review.py", "lib/replay_curate.py"],
        exports: ["octoclaw.router_eval/v1"],
      },
      {
        name: "node_source_adapters",
        files: ["lib/model-intel-sync.mjs"],
        exports: [
          "octoclaw.model_intel.models_dev/v1",
          "octoclaw.model_intel.openrouter_catalog/v1",
          "octoclaw.model_intel.openrouter_rankings/v1",
        ],
      },
      {
        name: "node_runtime_shell",
        files: ["lib/auto-router-boundary.mjs", "lib/auto-router-surface.mjs", "lib/auto-router-package-layout.mjs"],
        exports: [
          "octoclaw.auto_router.boundary/v1",
          "octoclaw.auto_router.package_layout/v1",
          "octoclaw.auto_router.surface_facts/v1",
        ],
      },
    ],
    explicit_runtime_exclusions: [
      "lib/octoclaw_policy.py",
      "extensions/octoclaw-runtime/policy/decide.js",
      "lib/dispatch_task.py",
      "lib/octoclaw_spawn.py",
      "lib/runtime_observer.py",
      "lib/patrol.py",
      "lib/task_display.py",
    ],
    migration_order: [
      "freeze schemas and public entry commands",
      "keep runtime policy adapter internal",
      "treat source adapters and router eval as first extraction candidates",
      "only consider package split after runtime adapter couplings shrink further",
    ],
    future_layout: {
      root: "packages/octoclaw-auto-router",
      suggested_paths: [
        "packages/octoclaw-auto-router/src/python/auto_router.py",
        "packages/octoclaw-auto-router/src/python/router_eval.py",
        "packages/octoclaw-auto-router/src/node/model-intel-sync.mjs",
        "packages/octoclaw-auto-router/src/node/auto-router-surface.mjs",
        "packages/octoclaw-auto-router/src/node/auto-router-boundary.mjs",
        "packages/octoclaw-auto-router/docs/",
        "packages/octoclaw-auto-router/tests/",
      ],
    },
  };
}

function main() {
  process.stdout.write(`${JSON.stringify(buildPackageLayoutManifest(), null, 2)}\n`);
}

export const __autoRouterPackageLayoutTest = { buildPackageLayoutManifest };

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  main();
}
