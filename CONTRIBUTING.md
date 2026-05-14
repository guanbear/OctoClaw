# Contributing

Thanks for considering contributing to OctoClaw.

## Development Setup / 开发环境搭建

Use Node.js 22.14 or newer and pnpm 10. This repository is an ESM TypeScript
workspace, so install dependencies from the repository root:

```bash
pnpm install
pnpm build
```

If you are working against a local OpenClaw checkout, keep the OpenClaw baseline
explicit and run the baseline verifier when changing integration assumptions:

```bash
pnpm verify:openclaw-baseline
```

## Scope

This project focuses on:

- cost-sensitive multi-agent orchestration for OpenClaw
- role-aware model routing
- runner-based acceleration for lightweight tasks
- patrol and recovery for long-running workflows

## Recommended Workflow

1. Keep changes small and focused
2. Prefer improving runtime reliability over adding more personas
3. Run the minimal eval before and after meaningful changes:

```bash
python3 /workspace/openclaw/skills/octopus/lib/eval_suite.py
```

4. When touching routing logic, explain:
   - why this should reduce cost or improve speed
   - what task family it affects
   - how it changes failure or recovery behavior

## Running Tests / 运行测试

Run the broad check before sending a PR:

```bash
pnpm check
```

Run the full Vitest suite when behavior changes:

```bash
pnpm test
```

For package-scoped work, prefer the narrowest relevant command first:

```bash
pnpm --filter <pkg> test
pnpm --filter <pkg> run check
```

For docs-only changes, at minimum run:

```bash
git diff --check
```

## Pull Requests / 提 PR

- Branch names should describe the lane and topic, for example
  `feat/router-shadow-report`, `fix/runtime-ledger-recovery`, or
  `docs/github-presence`.
- Use concise conventional commit messages such as `feat: add router shadow
  report`, `fix: preserve taskflow evidence`, or `docs: refresh GitHub
  templates`.
- Keep PRs small enough to review. Aim for less than 400 changed lines when the
  change is not a generated artifact or mechanical docs update.
- Link the related issue or OpenSpec change when one exists.
- Include the commands you ran and any known limitations in the PR body.
- Larger changes go through `openspec/changes/` before implementation.

## Code Style / 代码风格

- Keep `AGENTS.md` rules short and constitutional
- Put workflow guidance in `SKILL.md`
- Prefer runtime-enforced behavior over prompt-only rules when possible
- Use `apply_patch` for manual edits
- Keep TypeScript strict and avoid widening public contracts without tests
- Use ESM imports and include `.js` suffixes for local runtime imports
- Prefer bilingual user-facing errors or pair an English machine-readable code
  with a clear Chinese/English explanation where the surface already supports it
- Do not add prompt-only behavior when a runtime contract can enforce the rule

## Release Notes

Public release notes live in:

- [CHANGELOG.md](./CHANGELOG.md)
- [RELEASE_NOTES_v0.1.0.md](./RELEASE_NOTES_v0.1.0.md)
