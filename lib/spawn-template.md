# OctoClaw Worker Contract v2

This file documents the runtime contract that delegated OctoClaw workers should follow.
It is intentionally aligned with the live `task-state-update.py` and `runtime_protocol.py`
behavior rather than older tier- or label-based conventions.

## 1. Entry Contract

Before doing real work, the worker should register itself as `running` and preserve
the runtime truth fields:

- `task_id`
- `route`
- `runtime`
- `worker_pool`
- `work_type`
- `phase`
- `profile`
- `protocol`
- `report_path`
- `expected_done`

Use `task-state-update.py upsert` for the entry write.

## 2. Execution Discipline

- Read only the minimum context needed.
- Prefer shared files and artifacts over dumping long content into chat context.
- Treat the task brief as the contract source of truth.
- If the task is long-running, emit periodic progress events instead of silently running.

Recommended event kinds:

- `checkpoint`
- `progress_note`
- `artifact_ready`
- `handoff_ready`

Use `task-state-update.py event --kind <kind>` for those writes.

## 3. Checklist Discipline

Long-running or multi-step work should keep checklist truth in sync.

Use:

```bash
python3 /workspace/openclaw/skills/octopus/lib/task-state-update.py checklist \
  --id <TASK_ID> \
  --checklist-json '{"kind":"explicit","items":[...]}'
```

Checklist updates should reflect:

- what is already done
- what remains open
- what is blocked

## 4. Artifact-First Contract

Large outputs should be persisted as artifacts first.

Prefer:

- reports in shared markdown files
- changed file paths
- structured worker results

Do not return a long answer that only says “see report”; the final summary still needs to be self-contained.

## 5. Blocked vs Failed

Use `blocked` when:

- execution cannot continue right now
- but there is still a user-safe explanation or partial deliverable

Use `failed` when:

- the work did not produce a reliable deliverable
- or the runtime itself failed before a usable result was created

That distinction matters for:

- task state
- patrol / notifier wording
- follow-up routing

## 6. Result Contract

The worker should end with a structured `---RESULT---` payload compatible with
`octoclaw.worker_result/v1`.

Example:

```json
{
  "schema_version": "octoclaw.worker_result/v1",
  "task_id": "<TASK_ID>",
  "status": "done",
  "summary": "Concise self-contained result summary.",
  "artifacts": ["/workspace/tmp/octopus/shared/<TASK_ID>.md"],
  "files": [],
  "report": "/workspace/tmp/octopus/shared/<TASK_ID>.md",
  "risks": [],
  "next_step": "none"
}
```

Allowed final `status` values:

- `done`
- `blocked`
- `failed`

## 7. Exit Contract

Recommended closing flow:

1. persist final artifact(s)
2. emit `artifact_ready` if useful
3. update checklist
4. finish with `done`, `blocked`, or `failed`
5. return the final structured `---RESULT---`

This contract exists to support:

- reliable patrol and recovery
- artifact retrieval
- long-running follow-ups
- compact context handoff
