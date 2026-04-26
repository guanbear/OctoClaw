# OctoClaw OpenSpec-lite Workflow

This directory is a lightweight, repo-local spec-driven workflow for larger OctoClaw changes. It is not a runtime dependency and is not part of the live path.

## Roles

- **Spec** defines goals, non-goals, invariants, acceptance criteria, and required tests.
- **OpenCode** implements one bounded task slice at a time against the spec.
- **Codex** reviews architecture, truth-source alignment, scope creep, tests, commits, and deployment.

## Required Flow

1. Create or update a change under `openspec/changes/<change-id>/`.
2. Keep `proposal.md`, `design.md`, and `tasks.md` aligned before implementation.
3. For each implementation slice, map changed files and tests back to `tasks.md`.
4. Do not mark a task complete until tests prove the real live path, not only a standalone helper.
5. Do not promote recommendations or policy changes into the live path unless the spec gate says `pass`.

## Hard Invariants

- Native TaskFlow is execution lifecycle truth.
- WorkContract is semantic, delegation, handoff, and continuity truth.
- TaskFlow created does not imply `spawnExecuted`.
- ACK, status, display, grounding, and dashboard outputs are projections.
- Child continuity uses child session/run/artifact refs only; never inject raw child transcripts into parent context.
- No new task engine, no default multi-agent live path, no ClawTeam/tmux core dependency, and no online self-tuning.
