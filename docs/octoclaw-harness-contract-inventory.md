# OctoClaw Harness Contract Inventory

Status: canonical P5F artifact  
Updated: 2026-04-08

This document names the canonical contracts shared across runtime, workflow,
and evaluation harnesses. The goal is to stop adjacent systems from inventing
slightly different payloads for the same job.

## Contract Summary

| Contract | Canonical shape | Canonical producers | Canonical consumers | Storage / surface |
| --- | --- | --- | --- | --- |
| `brief` | `octoclaw.brief/v1` | `lib/runtime_protocol.py::build_task_brief`, `lib/octoclaw_spawn.py` | workers, runner loop, dispatch/runtime policy | in-memory dispatch payload; persisted alongside context/report expectations |
| `result` | `octoclaw.worker_result/v1` | workers, runner loop, native spawn finalize, `lib/runtime_protocol.py::normalize_worker_result` | `dispatch_task.py`, `runtime_task_record.py`, `task-state-update.py`, `patrol.py` | `task-state.json`, operator surface, user handoff summary |
| `artifact` | report/context/taskflow/operator payloads rooted under `artifacts` | dispatch/runtime writers, workflow reports, task-state update | task display, explorer, retrieve/details, replay/review follow-up | `task-state.json`, shared report/context files, artifact index rows |
| `event` | replay/runtime event objects such as `policy_resolved`, `dispatch_called`, `agent_end` | runtime extension, dispatch/runtime hooks, replay loggers | `reply_review_packet.py`, `replay_validation.py`, `replay_summary.py` | replay JSONL / summary payloads |
| `eval outcome` | review/replay/nightly packet and summary payloads | `eval_suite.py`, `reply_review_packet.py`, `replay_review.py`, `replay_summary.py`, `nightly_reply_review.py`, `nightly_failure_summary.py` | nightly analysis, operator review, follow-up prioritization | packet JSON, markdown summary, Slack nightly push |

## Brief Contract

Canonical shape:

- schema: `octoclaw.brief/v1`
- schema file: `schemas/runtime-brief-v1.schema.json`
- canonical helper: `lib/runtime_protocol.py::build_task_brief`

Owned fields include:

- route / worker pool / work type / phase / protocol
- work contract and review requirement
- allowed tools
- context summary and retrieval hints
- expected artifacts
- expected output contract

Primary producers:

- `lib/octoclaw_spawn.py`
- any future workflow entry that needs to hand off compact work to a bounded executor

Primary consumers:

- worker runtime / runner loop
- delegated execution paths

## Result Contract

Canonical shape:

- schema: `octoclaw.worker_result/v1`
- schema file: `schemas/worker-result-v1.schema.json`
- canonical helpers:
  - `lib/runtime_protocol.py::build_result_contract`
  - `lib/runtime_protocol.py::normalize_worker_result`

Owned fields include:

- status
- summary / user_safe_summary
- deliverable kind
- artifacts / files / report
- risks / verification / next_step

Primary producers:

- native spawn result parser
- runner loop
- workflow harness reports

Primary consumers:

- `lib/dispatch_task.py`
- `lib/runtime_task_record.py`
- `lib/task-state-update.py`
- `lib/patrol.py`

## Artifact Contract

Canonical representation:

- `artifacts` object embedded in task truth
- shared files such as report, context pack, operator surface payloads
- artifact index rows consumed by task display surfaces

Canonical producers:

- `lib/task-state-update.py`
- `lib/runtime_task_record.py`
- workflow-specific report writers
- `lib/context_pack.py`

Canonical consumers:

- `lib/task_display.py`
- `lib/task_display_cli.py`
- retrieve/details/explorer flows
- follow-up/review tooling

Canonical examples:

- `report_path`
- `context_pack_path`
- `worker_result`
- `openclaw_taskflow`
- `operator_surface`

## Event Contract

Canonical representation:

- replay/runtime events emitted by the runtime extension and replay loggers

Canonical producers:

- `extensions/octoclaw-runtime/index.js`
- dispatch/runtime policy hooks

Canonical consumers:

- `lib/reply_review_packet.py`
- `lib/replay_validation.py`
- `lib/replay_summary.py`
- downstream nightly review/failure summarization

Canonical event examples:

- `policy_resolved`
- `dispatch_called`
- `route_hint_submitted`
- `agent_end`

## Eval Outcome Contract

Canonical representation:

- packet / review / nightly summary payloads used for operator feedback and regression tracking

Canonical producers:

- `lib/eval_suite.py`
- `lib/reply_review_packet.py`
- `lib/replay_review.py`
- `lib/replay_summary.py`
- `lib/nightly_reply_review.py`
- `lib/nightly_failure_summary.py`

Canonical consumers:

- nightly analysis
- Slack summary push
- future calibration / cheap-judge training set selection

Canonical examples:

- `octoclaw.reply_review_packet/v1`
- replay summary JSON
- nightly failure markdown

## Contract Rules

1. New workflows should reuse the canonical `brief` and `result` contracts instead of inventing workflow-local alternatives.
2. New task truth should extend the `artifacts` surface rather than creating parallel storage fields without lineage.
3. New replay/nightly outputs should land as `eval outcome` rather than raw one-off markdown-only outputs.
4. Any new event intended for review/nightly use should be emitted into the replay event stream instead of being hidden in prose logs only.
