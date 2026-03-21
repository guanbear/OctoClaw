# Contributing

Thanks for considering contributing to OctoClaw.

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

## Style Notes

- Keep `AGENTS.md` rules short and constitutional
- Put workflow guidance in `SKILL.md`
- Prefer runtime-enforced behavior over prompt-only rules when possible
- Use `apply_patch` for manual edits

## Release Notes

Public release notes live in:

- [CHANGELOG.md](./CHANGELOG.md)
- [RELEASE_NOTES_v0.1.0.md](./RELEASE_NOTES_v0.1.0.md)
