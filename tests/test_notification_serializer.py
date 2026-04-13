#!/usr/bin/env python3
import json
import os
import tempfile
import threading
import unittest

from lib.notification_serializer import (
    NOTIFICATION_SERIALIZER_SCHEMA_VERSION,
    NotificationSerializer,
    get_notification_serializer,
)


class NotificationSerializerTests(unittest.TestCase):
    def test_register_pending_child(self):
        with tempfile.TemporaryDirectory() as tmp:
            ns = NotificationSerializer(workspace=tmp)
            ns.register_pending_child("parent-1", "child-a", total_expected=3)
            ns.register_pending_child("parent-1", "child-b", total_expected=3)

            state = ns._load_state()
            group = state["parent:parent-1"]
            self.assertEqual(group["pending_children"], ["child-a", "child-b"])
            self.assertEqual(group["total_expected"], 3)

    def test_record_child_notification_sent(self):
        with tempfile.TemporaryDirectory() as tmp:
            ns = NotificationSerializer(workspace=tmp)
            ns.register_pending_child("parent-1", "child-a", total_expected=2)
            ns.register_pending_child("parent-1", "child-b", total_expected=2)

            ns.record_child_notification_sent("parent-1", "child-a")

            state = ns._load_state()
            group = state["parent:parent-1"]
            self.assertIn("child-a", group["notified_children"])
            self.assertNotIn("child-a", group["pending_children"])
            self.assertIn("child-b", group["pending_children"])

    def test_flush_parent_notification_all_complete(self):
        with tempfile.TemporaryDirectory() as tmp:
            ns = NotificationSerializer(workspace=tmp)
            ns.register_pending_child("parent-1", "child-a", total_expected=2)
            ns.register_pending_child("parent-1", "child-b", total_expected=2)
            ns.record_child_notification_sent("parent-1", "child-a")
            ns.record_child_notification_sent("parent-1", "child-b")

            result = ns.flush_parent_notification("parent-1")
            self.assertIsNotNone(result)
            self.assertEqual(result["parent_id"], "parent-1")
            self.assertEqual(result["total_children"], 2)
            self.assertEqual(result["status"], "all_children_notified")
            self.assertEqual(sorted(result["notified_children"]), ["child-a", "child-b"])

    def test_flush_parent_notification_incomplete(self):
        with tempfile.TemporaryDirectory() as tmp:
            ns = NotificationSerializer(workspace=tmp)
            ns.register_pending_child("parent-1", "child-a", total_expected=3)
            ns.record_child_notification_sent("parent-1", "child-a")

            result = ns.flush_parent_notification("parent-1")
            self.assertIsNone(result)

    def test_should_serialize_notification_team_parent(self):
        with tempfile.TemporaryDirectory() as tmp:
            ns = NotificationSerializer(workspace=tmp)
            ns.register_pending_child("parent-1", "child-a", total_expected=2)
            ns.register_pending_child("parent-1", "child-b", total_expected=2)

            task = {"task_kind": "team_parent", "parent_id": "parent-1"}
            self.assertTrue(ns.should_serialize_notification(task))

    def test_should_serialize_notification_non_team_parent(self):
        with tempfile.TemporaryDirectory() as tmp:
            ns = NotificationSerializer(workspace=tmp)
            ns.register_pending_child("parent-1", "child-a", total_expected=1)

            task = {"task_kind": "spawn_single", "parent_id": "parent-1"}
            self.assertFalse(ns.should_serialize_notification(task))

    def test_notification_group_key_uses_parent_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            ns = NotificationSerializer(workspace=tmp)

            task = {"task_kind": "team_parent", "parent_id": "p-42"}
            self.assertEqual(ns._notification_group_key(task), "parent:p-42")

            task_no_kind = {"parent_id": "p-42"}
            self.assertEqual(ns._notification_group_key(task_no_kind), "")

            task_no_parent = {"task_kind": "team_parent"}
            self.assertEqual(ns._notification_group_key(task_no_parent), "")

            self.assertEqual(ns._notification_group_key({"task_kind": "team_parent"}, parent_id="p-override"), "parent:p-override")

    def test_state_survives_across_instances(self):
        with tempfile.TemporaryDirectory() as tmp:
            ns1 = NotificationSerializer(workspace=tmp)
            ns1.register_pending_child("parent-x", "child-1", total_expected=1)

            ns2 = NotificationSerializer(workspace=tmp)
            state = ns2._load_state()
            self.assertIn("parent:parent-x", state)
            self.assertEqual(state["parent:parent-x"]["pending_children"], ["child-1"])

    def test_concurrent_write_safety(self):
        with tempfile.TemporaryDirectory() as tmp:
            errors = []

            def writer(parent_suffix):
                try:
                    ns = NotificationSerializer(workspace=tmp)
                    for i in range(20):
                        ns.register_pending_child(f"concurrent-parent-{parent_suffix}", f"child-{parent_suffix}-{i}", total_expected=20)
                except Exception as e:
                    errors.append(e)

            threads = [threading.Thread(target=writer, args=(s,)) for s in range(4)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()

            self.assertEqual(errors, [], f"Concurrent writes caused errors: {errors}")

            ns = NotificationSerializer(workspace=tmp)
            state = ns._load_state()
            for s in range(4):
                key = f"parent:concurrent-parent-{s}"
                self.assertIn(key, state)
                self.assertEqual(len(state[key]["pending_children"]), 20)

    def test_schema_version_value(self):
        self.assertEqual(NOTIFICATION_SERIALIZER_SCHEMA_VERSION, "octoclaw.notification_serializer/v1")

    def test_get_notification_serializer_returns_instance(self):
        with tempfile.TemporaryDirectory() as tmp:
            import lib.notification_serializer as mod
            mod._default_serializer = None
            ns = get_notification_serializer(workspace=tmp)
            self.assertIsInstance(ns, NotificationSerializer)
            ns2 = get_notification_serializer(workspace=tmp)
            self.assertIs(ns, ns2)
            mod._default_serializer = None


if __name__ == "__main__":
    unittest.main()
