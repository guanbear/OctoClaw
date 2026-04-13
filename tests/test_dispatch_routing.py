"""Tests for dispatch_routing module."""

import unittest
from lib.dispatch_routing import (
    CAPACITY_GROUPS,
    DISPATCH_ROUTING_SCHEMA_VERSION,
    build_dispatch_routing_payload,
    generate_dispatch_key,
    generate_lane_key,
    normalize_capacity_group,
    normalize_dispatch_key,
    normalize_lane_key,
    normalize_task_text_for_key,
    resolve_capacity_group,
)


class TestGenerateDispatchKey(unittest.TestCase):
    def test_determinism_same_inputs_produce_same_key(self):
        key1 = generate_dispatch_key(
            parent_session_key="session123",
            parent_turn_id="turn456",
            normalized_task_text="Test task",
            route="runner",
            worker_pool="default-pool",
            model_lane="standard",
        )
        key2 = generate_dispatch_key(
            parent_session_key="session123",
            parent_turn_id="turn456",
            normalized_task_text="Test task",
            route="runner",
            worker_pool="default-pool",
            model_lane="standard",
        )
        self.assertEqual(key1, key2)

    def test_different_task_text_produces_different_key(self):
        key1 = generate_dispatch_key(
            parent_session_key="session123",
            parent_turn_id="turn456",
            normalized_task_text="Task A",
            route="runner",
            worker_pool="default-pool",
            model_lane="standard",
        )
        key2 = generate_dispatch_key(
            parent_session_key="session123",
            parent_turn_id="turn456",
            normalized_task_text="Task B",
            route="runner",
            worker_pool="default-pool",
            model_lane="standard",
        )
        self.assertNotEqual(key1, key2)

    def test_case_insensitive_normalization(self):
        key1 = generate_dispatch_key(
            parent_session_key="Session123",
            parent_turn_id="Turn456",
            normalized_task_text="Test Task",
            route="Runner",
            worker_pool="Default-Pool",
            model_lane="Standard",
        )
        key2 = generate_dispatch_key(
            parent_session_key="session123",
            parent_turn_id="turn456",
            normalized_task_text="test task",
            route="runner",
            worker_pool="default-pool",
            model_lane="standard",
        )
        self.assertEqual(key1, key2)

    def test_whitespace_collapsed(self):
        key1 = generate_dispatch_key(
            parent_session_key="session123",
            parent_turn_id="turn456",
            normalized_task_text="Test    task",
            route="runner",
            worker_pool="default-pool",
            model_lane="standard",
        )
        key2 = generate_dispatch_key(
            parent_session_key="session123",
            parent_turn_id="turn456",
            normalized_task_text="Test task",
            route="runner",
            worker_pool="default-pool",
            model_lane="standard",
        )
        self.assertEqual(key1, key2)

    def test_empty_inputs_produce_consistent_key(self):
        key = generate_dispatch_key(
            parent_session_key="",
            parent_turn_id="",
            normalized_task_text="",
            route="",
            worker_pool="",
            model_lane="",
        )
        self.assertEqual(len(key), 16)
        self.assertTrue(all(c in '0123456789abcdef' for c in key))

    def test_key_is_16_hex_chars(self):
        key = generate_dispatch_key(
            parent_session_key="session123",
            parent_turn_id="turn456",
            normalized_task_text="Test task",
            route="runner",
            worker_pool="default-pool",
            model_lane="standard",
        )
        self.assertEqual(len(key), 16)
        self.assertTrue(all(c in '0123456789abcdef' for c in key))


class TestGenerateLaneKey(unittest.TestCase):
    def test_correct_format(self):
        lane_key = generate_lane_key("Runner", "Default-Pool", "Lightweight")
        self.assertEqual(lane_key, "runner:default-pool:lightweight")

    def test_lowercased(self):
        lane_key = generate_lane_key("RUNNER", "OCTOCLAW-POOL", "HEAVY")
        self.assertEqual(lane_key, "runner:octoclaw-pool:heavy")

    def test_stripped(self):
        lane_key = generate_lane_key("  runner  ", "  pool  ", "  standard  ")
        self.assertEqual(lane_key, "runner:pool:standard")

    def test_format_with_known_routes(self):
        for route, expected_group in CAPACITY_GROUPS.items():
            lane_key = generate_lane_key(route, "test-pool", expected_group)
            parts = lane_key.split(":")
            self.assertEqual(len(parts), 3)
            self.assertEqual(parts[0], route)
            self.assertEqual(parts[1], "test-pool")
            self.assertEqual(parts[2], expected_group)


class TestResolveCapacityGroup(unittest.TestCase):
    def test_known_routes(self):
        self.assertEqual(resolve_capacity_group("runner"), "lightweight")
        self.assertEqual(resolve_capacity_group("spawn_single"), "standard")
        self.assertEqual(resolve_capacity_group("spawn_multi"), "heavy")
        self.assertEqual(resolve_capacity_group("direct"), "none")

    def test_unknown_route_octoclaw_runner_pool(self):
        result = resolve_capacity_group("unknown-route", worker_pool="octoclaw-runner")
        self.assertEqual(result, "lightweight")

    def test_unknown_route_fast_model_band(self):
        result = resolve_capacity_group("unknown-route", model_band="fast")
        self.assertEqual(result, "lightweight")

    def test_unknown_route_heavy_model_band(self):
        result = resolve_capacity_group("unknown-route", model_band="heavy")
        self.assertEqual(result, "heavy")

    def test_unknown_route_default(self):
        result = resolve_capacity_group("unknown-route")
        self.assertEqual(result, "standard")

    def test_case_insensitive_route(self):
        self.assertEqual(resolve_capacity_group("RUNNER"), "lightweight")
        self.assertEqual(resolve_capacity_group("Runner"), "lightweight")


class TestNormalizeDispatchKey(unittest.TestCase):
    def test_valid_16_hex_chars(self):
        result = normalize_dispatch_key("a1b2c3d4e5f61234")
        self.assertEqual(result, "a1b2c3d4e5f61234")

    def test_uppercase_converted_to_lowercase(self):
        result = normalize_dispatch_key("A1B2C3D4E5F61234")
        self.assertEqual(result, "a1b2c3d4e5f61234")

    def test_invalid_length(self):
        result = normalize_dispatch_key("a1b2c3")
        self.assertEqual(result, "")

    def test_invalid_chars(self):
        result = normalize_dispatch_key("g1h2i3j4k5l61234")
        self.assertEqual(result, "")

    def test_empty_string(self):
        result = normalize_dispatch_key("")
        self.assertEqual(result, "")

    def test_non_string(self):
        result = normalize_dispatch_key(1234567890123456)
        self.assertEqual(result, "")


class TestNormalizeLaneKey(unittest.TestCase):
    def test_valid_lane_key(self):
        result = normalize_lane_key("runner:pool:lightweight")
        self.assertEqual(result, "runner:pool:lightweight")

    def test_uppercase_converted(self):
        result = normalize_lane_key("RUNNER:POOL:LIGHTWEIGHT")
        self.assertEqual(result, "runner:pool:lightweight")

    def test_invalid_format_missing_parts(self):
        result = normalize_lane_key("runner:pool")
        self.assertEqual(result, "")

    def test_invalid_format_empty_part(self):
        result = normalize_lane_key("runner::lightweight")
        self.assertEqual(result, "")

    def test_empty_string(self):
        result = normalize_lane_key("")
        self.assertEqual(result, "")


class TestNormalizeCapacityGroup(unittest.TestCase):
    def test_valid_groups(self):
        self.assertEqual(normalize_capacity_group("lightweight"), "lightweight")
        self.assertEqual(normalize_capacity_group("standard"), "standard")
        self.assertEqual(normalize_capacity_group("heavy"), "heavy")
        self.assertEqual(normalize_capacity_group("none"), "none")

    def test_uppercase_converted(self):
        self.assertEqual(normalize_capacity_group("LIGHTWEIGHT"), "lightweight")
        self.assertEqual(normalize_capacity_group("Standard"), "standard")

    def test_invalid_group(self):
        result = normalize_capacity_group("unknown")
        self.assertEqual(result, "")

    def test_empty_string(self):
        result = normalize_capacity_group("")
        self.assertEqual(result, "")


class TestNormalizeTaskTextForKey(unittest.TestCase):
    def test_lowercased(self):
        result = normalize_task_text_for_key("TEST TASK")
        self.assertEqual(result, "test task")

    def test_whitespace_collapsed(self):
        result = normalize_task_text_for_key("test    task   with   spaces")
        self.assertEqual(result, "test task with spaces")

    def test_stripped(self):
        result = normalize_task_text_for_key("  test task  ")
        self.assertEqual(result, "test task")

    def test_truncated_to_500_chars(self):
        long_text = "a" * 1000
        result = normalize_task_text_for_key(long_text)
        self.assertEqual(len(result), 500)


class TestBuildDispatchRoutingPayload(unittest.TestCase):
    def test_has_all_required_fields(self):
        payload = build_dispatch_routing_payload("key123", "lane:pool:group", "standard")
        self.assertIn("schema_version", payload)
        self.assertIn("dispatch_key", payload)
        self.assertIn("lane_key", payload)
        self.assertIn("capacity_group", payload)

    def test_schema_version(self):
        payload = build_dispatch_routing_payload("key123", "lane:pool:group", "standard")
        self.assertEqual(payload["schema_version"], DISPATCH_ROUTING_SCHEMA_VERSION)
        self.assertEqual(payload["schema_version"], "octoclaw.dispatch_routing/v1")

    def test_field_values(self):
        payload = build_dispatch_routing_payload("abc123def456", "runner:pool:light", "lightweight")
        self.assertEqual(payload["dispatch_key"], "abc123def456")
        self.assertEqual(payload["lane_key"], "runner:pool:light")
        self.assertEqual(payload["capacity_group"], "lightweight")


class TestEdgeCases(unittest.TestCase):
    def test_all_empty_inputs(self):
        key = generate_dispatch_key("", "", "", "", "", "")
        self.assertEqual(len(key), 16)
        self.assertTrue(key.isalnum() and key.islower())

    def test_very_long_task_text_truncated(self):
        long_task = "a" * 10000
        key = generate_dispatch_key("session", "turn", long_task, "runner", "pool", "lane")
        self.assertEqual(len(key), 16)

    def test_special_characters_in_inputs(self):
        key1 = generate_dispatch_key("session", "turn", "task with $ymböl§", "runner", "pool", "lane")
        key2 = generate_dispatch_key("session", "turn", "task with $ymböl§", "runner", "pool", "lane")
        self.assertEqual(key1, key2)


if __name__ == "__main__":
    unittest.main()