# Official Capability Snapshot Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish OctoClaw-maintained capability snapshots to GitHub Pages and make `octoclawctl router capability refresh` consume the official snapshot by default.

**Architecture:** Keep the packaged snapshot as the offline seed. Add a static publishing workflow that builds `public/capability/*`, and add a CLI official-download path with SHA/schema validation. Preserve local source recomputation behind an explicit `--from-sources` flag for maintainers and tests.

**Tech Stack:** GitHub Actions, Node.js 22, pnpm, TypeScript CLI, existing router capability snapshot contracts.

---

### Task 1: Official Snapshot Download Path

**Files:**
- Modify: `tools/octoclawctl/src/cli.ts`
- Test: `tools/octoclawctl/src/cli.test.ts`

- [ ] Add a failing test where `router capability refresh` reads a manifest URL from `OCTOCLAW_ROUTER_CAPABILITY_MANIFEST_URL`, fetches a fixture manifest and snapshot, verifies SHA-256, and writes `model-intel-snapshot.json` plus `capability-catalog-full.json`.
- [ ] Run `pnpm vitest run tools/octoclawctl/src/cli.test.ts -t "official capability snapshot"` and confirm it fails because the official download path is not implemented.
- [ ] Add minimal CLI support for `--from-sources`, `OCTOCLAW_ROUTER_CAPABILITY_MANIFEST_URL`, manifest fetch, snapshot fetch, SHA-256 verification, and existing output summary fields.
- [ ] Re-run the targeted test and confirm it passes.

### Task 2: Preserve Maintainer Source Recompute

**Files:**
- Modify: `tools/octoclawctl/src/cli.ts`
- Test: `tools/octoclawctl/src/cli.test.ts`

- [ ] Update the existing source-adapter refresh test to pass `--from-sources`.
- [ ] Run the targeted source-adapter test and confirm it passes.
- [ ] Update help text and schedule message so normal scheduled refresh pulls the official snapshot, while `--from-sources` is documented as maintainer/debug mode.

### Task 3: GitHub Pages Publisher

**Files:**
- Create: `scripts/build-capability-site.mjs`
- Create: `.github/workflows/publish-capability-snapshot.yml`
- Test: `tests/scripts/build-capability-site.test.ts`

- [ ] Add a failing script test that builds `leaderboard-snapshot.json`, `leaderboard-summary.json`, and `leaderboard-manifest.json` under a temp public directory and verifies manifest SHA/model count.
- [ ] Implement `scripts/build-capability-site.mjs` by reading an input snapshot and writing the static `capability/` files.
- [ ] Add a GitHub Pages workflow with weekly and manual triggers, `pnpm install`, refresh to a temp snapshot, smoke tests, build site files, and `actions/deploy-pages`.
- [ ] Run the new script test.

### Task 4: Docs and Verification

**Files:**
- Modify: `docs/octoclaw-router-user-guide.md`
- Modify: `openspec/changes/router-capability-score-calibration-0.6.x/design.md`
- Modify: `openspec/changes/router-capability-score-calibration-0.6.x/tasks.md`

- [ ] Document that users consume the official snapshot and do not need benchmark API keys.
- [ ] Run `pnpm vitest run tools/octoclawctl/src/cli.test.ts tests/scripts/build-capability-site.test.ts tests/scripts/refresh-leaderboard-snapshot.test.ts`.
- [ ] Run `pnpm check`.
- [ ] Run `npx gitnexus detect-changes --repo OctoClaw`.
