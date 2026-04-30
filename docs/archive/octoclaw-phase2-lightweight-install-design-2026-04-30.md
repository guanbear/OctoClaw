# OctoClaw Phase 2 Lightweight Install Design (2026-04-30)

Status: completed snapshot. The package consolidation described here has landed: `tools/octoclawctl` is the only tool workspace package, `tools/install` and `tools/manage` are deprecated stubs, and the former runtime core has been merged into `extensions/octoclaw-runtime/src/core/*`. Use `../octoclaw-ts-rebuild-design-v2.md` as the current entry point.

## Source Contract

- Primary reference: `docs/archive/octoclaw-architecture-diagnosis-and-refactor-plan-2026-04-29.md` Phase 2.
- Implementation guide reference: `docs/archive/octoclaw-refactor-impl-guide-2026-04-29.md` P2-T9, P2-T10, P2-T11.
- Required order: P2-T10 plugin switch and config cleanup, P2-T11 unified install tool, then P2-T9 package merge.

## Design Goals

1. `~/.octoclaw/config.json` is the source of truth for OctoClaw feature config.
2. `octoclawctl install/update/deploy` creates or updates that config, syncs the deployed runtime manifest, and syncs the OpenClaw plugin entry from the same config.
3. `octoclawctl disable` and `octoclawctl enable` preserve installation, flip only the unified config source of truth, sync deployed plugin config, and restart OpenClaw through the platform abstraction.
4. Runtime can be installed by a single package/bin, `octoclawctl`; legacy `tools/install` and `tools/manage` stop being workspace packages.
5. Runtime implementation owns its former core directly; package/extension units under `packages/` and `extensions/` converge to `contracts`, `policy`, `runtime`, and `status-surface`.
6. CLI command code must not call `launchctl` directly; service-specific process managers live behind `platform.ts`.

## Implementation Plan

### P2-T10: Config and Plugin Switch

- Keep the existing runtime early-return guard: `pluginConfig.enabled === false` registers no hooks, tools, commands, or detached runtime.
- Make `syncToOpenClawPluginConfig()` project unified config into both deployed `openclaw.plugin.json` and existing `~/.openclaw/openclaw.json` plugin entry config.
- Make install/deploy write a config file even when the user has never run `octoclawctl config set`.
- Make `syncOpenClawPluginEntry()` accept the projected plugin config and write `enabled`, `delegationEnabled`, and `judgeFast` into the OpenClaw plugin entry config while preserving `octoclawRoot` and `workspaceRoot`.

### P2-T11: Unified Tooling

- Rename the publishable tool package to `octoclawctl` so `npx octoclawctl install` resolves to the intended bin name.
- Keep `tools/octoclawctl` as the only tool workspace package.
- Convert `tools/install` and `tools/manage` into non-package deprecation stubs instead of buildable workspace packages.
- Move nightly LaunchAgent load/unload calls behind `platform.ts`; CLI remains platform-neutral.
- Prune stale deployed `octoclaw-*` package/extension directories during deploy so removed packages do not survive locally.

### P2-T9: Runtime Core Merge

- Move `packages/octoclaw-runtime-core/src/*` into `extensions/octoclaw-runtime/src/core/*`.
- Replace imports from the package name with relative internal runtime imports.
- Remove `@octoclaw/runtime-core` dependencies, tsconfig references, vitest aliases, and lockfile entries.
- Remove the `packages/octoclaw-runtime-core` package directory after migration.

## Acceptance Gates

- `find packages extensions -maxdepth 2 -name package.json` lists exactly four package/extension units.
- `find tools -maxdepth 2 -name package.json` lists only `tools/octoclawctl/package.json`.
- `rg "@octoclaw/runtime-core|octoclaw-runtime-core"` has no live code/package/lock references.
- `rg "launchctl" tools/octoclawctl/src/cli.ts` returns no direct CLI calls.
- Focused tests cover config set/get, install/deploy config creation/sync, enable/disable source-of-truth sync, runtime disabled guard, and migrated core tests.
- Clean build is required before deploy so deleted package artifacts do not remain in `dist`.

## Non-goals

- Do not change TaskFlow/WorkContract truth ownership.
- Do not reintroduce delivery relay, replay-log truth, ClawTeam/tmux dependencies, or remote judge paths.
- Do not make OpenClaw plugin entry `enabled: false`; OctoClaw disable is runtime config based so the installed plugin remains visible and reversible.
