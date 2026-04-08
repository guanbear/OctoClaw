#!/usr/bin/env python3
import unittest

from lib.feedback_loop import (
    MANIFEST_SCHEMA_VERSION,
    VALIDATION_SCHEMA_VERSION,
    build_feedback_manifest,
    build_phase_record,
    build_validation_summary,
    normalize_prompt,
    prompt_hash,
    shared_case_fields,
)


class FeedbackLoopTests(unittest.TestCase):
    def test_prompt_normalization_and_hash_are_stable(self) -> None:
        self.assertEqual(normalize_prompt("  Hello   World "), "hello world")
        self.assertEqual(prompt_hash("Hello World"), prompt_hash("  hello   world "))

    def test_shared_case_fields_assigns_high_severity_for_blocked_cases(self) -> None:
        payload = shared_case_fields(
            prompt="check nginx logs",
            route="runner",
            worker_pool="octoclaw-runner",
            route_language_packs=["zh", "en"],
            tags=["blocked", "runner"],
            blocked_events=["tool_blocked_before_route_hint"],
            review_required=False,
        )
        self.assertEqual(payload["candidate_severity"], "high")
        self.assertEqual(payload["route_language_packs"], ["zh", "en"])
        self.assertTrue(payload["prompt_hash"])

    def test_build_feedback_manifest_tracks_phase_records(self) -> None:
        manifest = build_feedback_manifest(
            run_id="feedback-1",
            source_inputs={"events_path": "/tmp/replay.jsonl"},
            phase_records=[
                build_phase_record(phase="observe", status="completed"),
                build_phase_record(phase="summarize", status="completed", upstream_phases=["observe"]),
            ],
            generated_artifacts={"summary_json": "/tmp/summary.json"},
            output_dir="/tmp/nightly",
            validation_status="pending_validation",
            promotion_eligibility="operator-review-only",
            learning_written=False,
            validation_artifacts={"validation_summary_json": "/tmp/validation-summary.json"},
            route_outcome_metrics={"coverage_complete": True},
        )
        self.assertEqual(manifest["schema_version"], MANIFEST_SCHEMA_VERSION)
        self.assertEqual(manifest["phase_records"][1]["upstream_phases"], ["observe"])
        self.assertEqual(manifest["promotion_eligibility"], "operator-review-only")
        self.assertEqual(manifest["validation_artifacts"]["validation_summary_json"], "/tmp/validation-summary.json")
        self.assertTrue(manifest["route_outcome_metrics"]["coverage_complete"])

    def test_build_validation_summary_marks_passed(self) -> None:
        payload = build_validation_summary(
            source_run_id="feedback-1",
            source_label="nightly",
            report_path="/tmp/report.md",
            cases_total=4,
            cases_passed=4,
            cases_failed=0,
            findings=[],
            passed=True,
            route_outcome_metrics={"coverage_complete": True, "route_correctness_rate": 1.0},
            generated_artifacts={"validation_report_md": "/tmp/report.md"},
        )
        self.assertEqual(payload["schema_version"], VALIDATION_SCHEMA_VERSION)
        self.assertTrue(payload["passed"])
        self.assertEqual(payload["cases_total"], 4)
        self.assertTrue(payload["route_outcome_metrics"]["coverage_complete"])
        self.assertEqual(payload["generated_artifacts"]["validation_report_md"], "/tmp/report.md")


if __name__ == "__main__":
    unittest.main()
