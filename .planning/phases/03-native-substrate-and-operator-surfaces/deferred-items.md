# Deferred Items

## 2026-04-16 — 03-01 Task 2 out-of-scope runtime policy regressions

- `tests/test_octoclaw_runtime_extension.py::test_execution_followup_prompt_prefers_control_observer_without_replay_context`
- `tests/test_octoclaw_runtime_extension.py::test_fresh_update_lookup_is_not_reclassified_as_task_followup`
- `tests/test_octoclaw_runtime_extension.py::test_resolve_policy_records_normalized_replay_events_and_cache_hit`
- `tests/test_octoclaw_runtime_extension.py::test_short_single_followup_uses_recent_execution_facts`
- `tests/test_octoclaw_runtime_extension.py::test_stateless_policy_judge_result_overrides_legacy_route_when_valid`
- `tests/test_octoclaw_runtime_extension.py::test_versioned_openclaw_features_prompt_prefers_fresh_live_lookup`

Reason: These failures exercise broader route-policy behavior already present in `extensions/octoclaw-runtime/index.js` and are not caused by the new TS-native truth delegation seam added for Phase 03 Plan 01 Task 2. The new targeted truth delegation assertions pass.

## 2026-04-16 — 03-03 plan-level runtime policy regressions remain out of scope

- `tests/test_octoclaw_runtime_extension.py::test_execution_followup_prompt_prefers_control_observer_without_replay_context`
- `tests/test_octoclaw_runtime_extension.py::test_fresh_update_lookup_is_not_reclassified_as_task_followup`
- `tests/test_octoclaw_runtime_extension.py::test_resolve_policy_records_normalized_replay_events_and_cache_hit`
- `tests/test_octoclaw_runtime_extension.py::test_short_single_followup_uses_recent_execution_facts`
- `tests/test_octoclaw_runtime_extension.py::test_stateless_policy_judge_result_overrides_legacy_route_when_valid`
- `tests/test_octoclaw_runtime_extension.py::test_versioned_openclaw_features_prompt_prefers_fresh_live_lookup`

Reason: Plan 03-03 rebinding work changed IM/display projection consumption and grounded follow-up fact presentation, but these six failures still originate from broader route-policy behavior in `extensions/octoclaw-runtime/index.js` outside the task-touched acceptance path. The new shared-projection grounding assertions pass, so the failures remain deferred rather than auto-fixed out of scope.
