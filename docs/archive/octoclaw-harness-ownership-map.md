# OctoClaw Harness Ownership Map

Status: canonical P5F artifact  
Updated: 2026-04-08

This document makes the layered harness split concrete. It is intentionally
non-disruptive: it names ownership for the files that already exist instead of
introducing a new runtime or forcing a directory migration.

## Runtime Harness

Purpose:

- own workflow-first runtime truth
- classify requests into direct / runner / delegated lanes
- build compact brief/context packets
- coordinate dispatch, task substrate, and state normalization

Core modules:

| Area | Canonical files | Responsibility |
| --- | --- | --- |
| Route and protected lanes | `lib/octoclaw_route.py`, `extensions/octoclaw-runtime/policy/route.js` | classify route, task class, protected lane, workflow-first direct vs delegated boundaries |
| Policy and recommendation | `lib/octoclaw_policy.py`, `lib/route_recommendation.py`, `extensions/octoclaw-runtime/policy/decide.js`, `extensions/octoclaw-runtime/policy/recommendation.js`, `extensions/octoclaw-runtime/policy/config.js` | compute work contract, dispatch requirement, runtime policy, recommendation/arbitration seam |
| Runtime entrypoint | `extensions/octoclaw-runtime/index.js` | attach policy hooks, dispatch logging, replay events, guarded tool routing |
| Dispatch and substrate | `lib/dispatch_task.py`, `lib/openclaw_taskflow_adapter.py` | execute dispatch, bind to OpenClaw managed TaskFlow, coordinate native task substrate |
| Context and protocol | `lib/context_pack.py`, `lib/runtime_protocol.py`, `schemas/runtime-brief-v1.schema.json`, `schemas/worker-result-v1.schema.json` | define compact brief/result contract, context pack, retrieval hints, result normalization |
| Runtime state normalization | `lib/runtime_task_record.py`, `lib/task-state-update.py` | normalize worker results, task truth, operator surface, parent/child lineage |

## Workflow Harness

Purpose:

- own reusable workflow-specific execution skeletons
- prefer playbook/report workflows over generic `spawn_single` when the task is inspect/benchmark/report shaped
- keep agent use bounded and artifact-first

Core modules:

| Area | Canonical files | Responsibility |
| --- | --- | --- |
| Runner workflow inference | `lib/runner_playbooks.py` | infer standardized runner playbooks for logs, inspect, cron, benchmark, telemetry tasks |
| Model telemetry workflow | `lib/model_telemetry_report.py` | emit model-speed/model-health/model-benchmark report workflow results instead of generic agent prose |

Current baseline workflows owned here:

- model speed / TTFT / throughput inspection
- benchmark / inspect report tasks
- log/status diagnosis that benefits from a report workflow more than delegated reasoning

## Evaluation Harness

Purpose:

- own replay, review, nightly analysis, and failure surfacing
- convert direct-path and delegated-path behavior into durable feedback artifacts
- expose regression cases before users have to ask twice

Core modules:

| Area | Canonical files | Responsibility |
| --- | --- | --- |
| Offline evaluation | `lib/eval_suite.py` | evaluation harness entry for curated replay/eval runs |
| Replay selection and validation | `lib/replay_validation.py` | select turns, score risk, surface replay-worthy sessions, direct-path coverage |
| Review packet | `lib/reply_review_packet.py` | build packet-level review input from transcript + replay events |
| Review analysis | `lib/replay_review.py`, `lib/replay_summary.py` | analyze reply quality and summarize replay signal |
| Nightly review | `lib/nightly_reply_review.py` | nightly semantic/packet review workflow |
| Nightly failure surfacing | `lib/nightly_failure_summary.py`, `bin/nightly-analysis-slack.sh` | summarize failures and push analysis-only nightly output |

## Ownership Rules

When adding a new capability:

1. Classify it into `runtime`, `workflow`, or `evaluation` harness before implementation.
2. Reuse an existing contract if one already exists for `brief`, `result`, `artifact`, `event`, or `eval outcome`.
3. Prefer extending an existing harness owner over creating an ad hoc side script.

Typical classification examples:

- “What route/tool/policy/session am I on?” -> runtime harness
- “Benchmark MiniMax and GLM-5.1 TTFT/throughput” -> workflow harness
- “Did nightly catch this protected-lane bad case?” -> evaluation harness

## Explicit Non-Goals

- no new always-on runtime
- no second task engine alongside OpenClaw substrate
- no monolithic super-agent harness
- no forced directory migration before ownership and contract boundaries are clear
