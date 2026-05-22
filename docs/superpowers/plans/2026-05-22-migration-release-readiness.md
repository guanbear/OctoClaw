# Migration Release Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make migration and release readiness AI-first: AI follows a deterministic runbook, while the human only confirms secrets, provider choices, and config writes.

**Architecture:** Keep the installed code simple. `octoclawctl init/doctor/deploy` remain the readiness authority; Slack/Feishu onboarding remains a thin confirmation surface; docs carry the full AI execution procedure and smoke interpretation rules.

**Tech Stack:** Markdown docs, existing `octoclawctl` readiness/smoke commands, existing Vitest coverage for migration-onboarding-feishu OpenSpec.

---

### Task 1: Verify Current Migration/Feishu Implementation

**Files:**
- Read: `openspec/changes/migration-onboarding-feishu-0.6.x/{proposal,design,tasks,bdd}.md`
- Read: `tools/octoclawctl/src/readiness.ts`
- Read: `extensions/octoclaw-runtime/src/router-onboarding.ts`
- Read: `extensions/octoclaw-runtime/src/im/feishu/feishu-adapter.ts`
- Read: `extensions/octoclaw-runtime/src/im-status-renderer.ts`

- [x] **Step 1: Run targeted BDD tests**

Run:

```bash
pnpm vitest run \
  tools/octoclawctl/src/__tests__/init/wizard-lang.test.ts \
  tools/octoclawctl/src/__tests__/readiness.test.ts \
  tools/octoclawctl/src/__tests__/doctor.test.ts \
  tools/octoclawctl/src/__tests__/install.test.ts \
  extensions/octoclaw-runtime/src/router-onboarding.test.ts \
  extensions/octoclaw-runtime/src/im/feishu/feishu-adapter.test.ts \
  extensions/octoclaw-runtime/src/im-status-renderer.test.ts
```

Expected: all files pass. Any failure becomes an implementation task before docs closeout.

- [x] **Step 2: Check implementation anchors**

Run:

```bash
rg -n "gpt-5.4-mini|generateReadinessReport|feishu_card|decodeFeishuCardAction|router wizard" \
  tools/octoclawctl/src extensions/octoclaw-runtime/src
```

Expected: anchors exist in CLI readiness/init, router onboarding, Feishu adapter, and status renderer.

### Task 2: Write AI-First Migration Runbook

**Files:**
- Modify: `docs/octoclaw-migration-onboarding-feishu-guide.md`
- Modify: `README.md`

- [x] **Step 1: Add operating model**

State that AI should execute the runbook and the wizard should only ask for human-confirmed inputs:

```markdown
## Operating Model: AI Runbook, Thin Wizard

Use this document as the primary migration procedure. The assistant should run checks, inspect outputs, and repair configuration drift. The interactive wizard is only for choices that require user authority: IM channel, secrets, remote Judge/provider, and explicit config writes.
```

- [x] **Step 2: Add prerequisites and version gate**

Document OpenClaw `>= 2026.5.12`, Node `>= 22`, and the no-local-judge path:

```markdown
Minimum target:
- OpenClaw >= 2026.5.12
- Node.js >= 22
- `octoclawctl` built from this repo or installed package
- At least one IM channel: Slack or Feishu
- A Judge: local Qwen3 0.6B or remote OpenAI-compatible `gpt-5.4-mini`
```

- [x] **Step 3: Add deterministic migration sequence**

Include commands for build, deploy, doctor, router wizard, model-intel refresh, smoke, and interpretation.

- [x] **Step 4: Add failure handling matrix**

Cover missing Judge, Feishu not configured, status panel missing, router wizard incomplete, 402/429 provider fallback, and live smoke failure.

- [x] **Step 5: Link from README**

Add a short release/migration pointer under Quick start:

```markdown
For migrated machines or Feishu-only installs, follow `docs/octoclaw-migration-onboarding-feishu-guide.md`.
```

### Task 3: Verify Docs And Package

**Files:**
- Read: `docs/octoclaw-migration-onboarding-feishu-guide.md`
- Read: `README.md`
- Read: `tools/octoclawctl/package.json`

- [x] **Step 1: Verify required runbook phrases**

Run:

```bash
rg -n "AI Runbook|Thin Wizard|OpenClaw >= 2026.5.12|gpt-5.4-mini|Feishu|stability full" \
  docs/octoclaw-migration-onboarding-feishu-guide.md README.md
```

Expected: all phrases are present.

- [x] **Step 2: Run targeted tests again**

Run the Task 1 test command again.

Expected: all pass.

- [x] **Step 3: Run full check**

Run:

```bash
pnpm check
```

Expected: exit 0.

- [x] **Step 4: Inspect npm package size**

Run:

```bash
mkdir -p /tmp/octoclaw-pack
pnpm --filter @octoclaw/cli pack --pack-destination /tmp/octoclaw-pack
ls -lh /tmp/octoclaw-pack/*.tgz
```

Expected: package is created and size is reported. If `README.md` is missing from the package scope, decide whether to add a package-local README or remove the package files entry in a follow-up.

### Task 4: Commit, Deploy, Smoke

**Files:**
- Commit docs and any package metadata changes from prior tasks.

- [x] **Step 1: GitNexus detect changes**

Run:

```bash
npx gitnexus detect-changes -r OctoClaw
```

Expected: only documentation/package metadata scope is reported, or no symbol changes are detected.

- [ ] **Step 2: Commit**

Run:

```bash
git add docs/octoclaw-migration-onboarding-feishu-guide.md README.md docs/superpowers/plans/2026-05-22-migration-release-readiness.md
git commit -m "docs(release): add ai-first migration readiness runbook"
```

- [ ] **Step 3: Deploy**

Run:

```bash
node tools/octoclawctl/dist/cli.js deploy --skip-build --restart
```

Expected: readiness prints OpenClaw/runtime/Judge/router/status results. Feishu may warn if not configured on this machine.

- [ ] **Step 4: Real smoke**

Run:

```bash
set -a
source ~/.openclaw/octoclaw-slack-acceptance.env >/dev/null 2>&1
set +a
node tools/octoclawctl/dist/cli.js stability full \
  --output-dir ~/.openclaw/reports \
  --config ~/.openclaw/octoclaw-slack-acceptance-config.json \
  --format json
```

Expected: `overallGate` is `pass`. If not, inspect the generated report and fix the failing lane before pushing.
