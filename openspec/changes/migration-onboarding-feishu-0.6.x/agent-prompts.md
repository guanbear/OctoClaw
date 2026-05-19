# Agent Prompts: Migration Onboarding, Judge Presets, And Feishu

Use one packet at a time. Do not skip ahead. OpenCode output is a draft; Codex must review diff and tests.

## Common Header For Every Packet

```text
ulw
OpenSpec Work Packet: migration-onboarding-feishu-0.6.x

Read first:
- openspec/changes/migration-onboarding-feishu-0.6.x/proposal.md
- openspec/changes/migration-onboarding-feishu-0.6.x/design.md
- openspec/changes/migration-onboarding-feishu-0.6.x/tasks.md
- openspec/changes/migration-onboarding-feishu-0.6.x/bdd.md

Hard constraints:
- Native TaskFlow is execution lifecycle truth.
- WorkContract is semantic/delegation/handoff/continuity truth.
- ACK/status/display/onboarding/status panel are projections, not truth.
- Do not add glm-4.7 as a preset.
- Do not silently mutate OpenClaw provider credentials or fallback order.
- Do not write Judge config from router-wizard.json.
- Do not print auth headers, API keys, or tokens.
- Do not reintroduce legacy runtime truth/outbox/heuristic dispatch authority.
- Before editing any function/class/method symbol, run GitNexus impact analysis and report direct callers/risk.
- Do not commit until Codex reviews.

Before editing: echo a 5-bullet plan and confirm allowed scope.
After editing: report changed files, BDD scenarios covered, tests run, remaining risks, and scope deviations.
```

## WP-A Packet

```text
Task: Implement WP-A only: Judge Preset And Readiness Core.

BDD: MOF-001, MOF-002, MOF-003, MOF-004, MOF-005.

Allowed scope:
- tools/octoclawctl/src/commands/init/steps/step-judge-model.ts
- tools/octoclawctl/src/commands/init/wizard-state.ts
- tools/octoclawctl/src/readiness.ts or tools/octoclawctl/src/commands/readiness.ts
- tests under tools/octoclawctl/src/__tests__/

Acceptance:
- pnpm vitest run tools/octoclawctl/src/__tests__/init/wizard-lang.test.ts
- pnpm vitest run tools/octoclawctl/src/__tests__/readiness.test.ts
- pnpm check
```

## WP-B Packet

```text
Task: Implement WP-B only: CLI Init, Doctor, Install, And Migration Guidance.

BDD: MOF-005, MOF-006, MOF-016, MOF-017, MOF-018.

Allowed scope:
- tools/octoclawctl/src/commands/init.ts
- tools/octoclawctl/src/commands/doctor.ts
- tools/octoclawctl/src/install.ts
- tools/octoclawctl/src/cli.ts
- tests under tools/octoclawctl/src/__tests__/

Acceptance:
- pnpm vitest run tools/octoclawctl/src/__tests__/doctor.test.ts tools/octoclawctl/src/__tests__/install.test.ts
- pnpm check
```

## WP-C Packet

```text
Task: Implement WP-C only: Slack Onboarding Judge Guidance.

BDD: MOF-007, MOF-008.

Allowed scope:
- extensions/octoclaw-runtime/src/router-onboarding.ts
- extensions/octoclaw-runtime/src/router-onboarding.test.ts
- optional narrow helper under extensions/octoclaw-runtime/src/

Acceptance:
- pnpm vitest run extensions/octoclaw-runtime/src/router-onboarding.test.ts
- pnpm check
```

## WP-D Packet

```text
Task: Implement WP-D only: Feishu Cards And Actions.

BDD: MOF-009, MOF-010, MOF-011, MOF-012, MOF-013, MOF-019.

Allowed scope:
- extensions/octoclaw-runtime/src/im/feishu/**
- extensions/octoclaw-runtime/src/router-onboarding.ts
- extensions/octoclaw-runtime/src/im-status-renderer.ts
- tests under extensions/octoclaw-runtime/src/im/feishu/
- extensions/octoclaw-runtime/src/router-onboarding.test.ts
- extensions/octoclaw-runtime/src/im-status-renderer.test.ts

Acceptance:
- pnpm vitest run extensions/octoclaw-runtime/src/im/feishu/feishu-adapter.test.ts extensions/octoclaw-runtime/src/router-onboarding.test.ts extensions/octoclaw-runtime/src/im-status-renderer.test.ts
- pnpm check
```

## WP-E Packet

```text
Task: Implement WP-E only: Status Panel And Packaging Closeout.

BDD: MOF-014, MOF-015, MOF-016, MOF-020.

Allowed scope:
- extensions/octoclaw-status-surface/src/**
- extensions/octoclaw-runtime/src/im-status-renderer.ts
- tools/octoclawctl/src/install.ts
- tools/octoclawctl/src/cli.ts
- docs/
- tests near touched modules

Acceptance:
- pnpm vitest run extensions/octoclaw-status-surface/src/index.test.ts extensions/octoclaw-status-surface/src/renderers/rich/index.test.ts extensions/octoclaw-runtime/src/im-status-renderer.test.ts
- pnpm check
- pnpm test
- git grep "openclaw models fallbacks add\\|openclaw models fallbacks remove" -- tools extensions packages | cat
```
