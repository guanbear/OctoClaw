# OctoClaw Macmini Replay Validation

Date: 2026-04-03
Environment:
- Host: `macmini`
- OpenClaw: `2026.4.1 (da64a97)`
- Python: `3.14.3`
- OctoClaw repo during validation: `17abf08` on `codex/release-v0.1.0`

## Goal

Validate the latest OctoClaw build against the recent reply-review findings before treating them as current bugs.

Primary questions:
- Is `spawn_single` still broken on the latest build?
- Is delegation route metadata still missing?

## Validation Method

### 1. Deploy latest remote to macmini

- Synced the macmini repo to `origin/codex/release-v0.1.0`
- Ran local install/update with:
  - `WORKSPACE=/Users/guanbear/.openclaw/workspace`
  - `bash ./bin/octoclaw-manage.sh update`

### 2. Replay research prompts on macmini

Prompts used:
- `请调研 OpenClaw 3.31 的 task flow，判断 OctoClaw 是否还需要 ClawTeam，并给出简洁结论。`
- `帮我调研 OpenClaw 3.31 的 task flow，并先给我一个三点总结。`

Validation was performed twice:
- once on `main`
- once on a fresh verifier agent to avoid polluted main-session history

## Findings

### A. Route metadata is no longer missing in replay logs

For the latest replay on macmini, the following events were present:

- `policy_resolved`
  - `route=spawn_single`
  - `systemPreferredRoute=spawn_single`
  - `workerPool=octoclaw-research`
- `dispatch_called`
  - `executed=true`

This means the older nightly-review claim that delegated research turns had no route metadata is **not true for the latest replay path**.

### B. `spawn_single` is still broken on the latest build

Fresh-agent validation still produced failed research tasks:

- `research-20260402230843094948`
- `research-20260402230906493329`

Final task state for both:

- `status=failed`
- `route=spawn_single`
- `worker_pool=octoclaw-research`
- `summary=spawn启动失败：native openclaw agent exited non-zero ...`

So the latest build still has a real spawn execution failure.

### C. There is now evidence of duplicate dispatch / duplicate task creation

During the fresh-agent replay of:

- `帮我调研 OpenClaw 3.31 的 task flow，并先给我一个三点总结。`

Observed:

- two `dispatch_called` events
- two research tasks created
- both failed with the same native spawn error

This is stronger than the earlier nightly report. The current issue is not just "spawn can fail"; it also appears to be able to dispatch the same delegated work more than once.

### D. `system_preferred_route` is still not fully mirrored into task-state

Replay log contains:

- `systemPreferredRoute=spawn_single`

But newly created task records still showed:

- `system_preferred_route=null`

So the metadata persistence problem is now narrower:

- replay layer: mostly fixed
- task-state layer: still incomplete

### E. Main-session replay can be contaminated by prior history

Using `main` for validation is not reliable enough because the session history is reused under:

- `sessionKey=agent:main:main`

That caused one replay to answer using previous failed task history rather than behaving like a clean first-run scenario.

Fresh verifier agents are required for trustworthy replay validation.

## Current Status Summary

### Fixed or improved

- Delegation route metadata is present again in replay logs.
- Delegated research prompts do reach `dispatch_called` on the latest build.

### Still broken

- Native spawn execution still fails on the latest build.
- Delegated research tasks can still end in:
  - `spawn启动失败：native openclaw agent exited non-zero`

### Newly clarified

- There is likely a duplicate dispatch / duplicate task creation bug on the delegated research path.
- `system_preferred_route` is still not mirrored correctly into task-state even when replay has it.

## Recommended Fix Order

1. Fix native spawn execution failure.
2. Prevent duplicate dispatch / duplicate task creation for one delegated turn.
3. Mirror `system_preferred_route` into task-state consistently.
4. Keep validation on fresh agents, not `main`, when testing delegated replay cases.

## Concrete Evidence

Replay/session ids used during validation:

- `octotest-research-1775171077`
- `octotest-research2-1775171189`
- `octoclaw-verifier-1775171313-s1`

Task ids produced during fresh-agent validation:

- `research-20260402230843094948`
- `research-20260402230906493329`

Both ended in:

- `spawn启动失败：native openclaw agent exited non-zero`
