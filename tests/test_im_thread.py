#!/usr/bin/env python3
"""Tests for lib/im_thread.py — IM thread lifecycle manager."""

import unittest
from unittest.mock import MagicMock, call, patch

from lib.im_thread import (
    _CLOSE_EVENTS,
    _EDITABLE_BACKENDS,
    _OPEN_EVENTS,
    _UPDATE_EVENTS,
    _all_session_keys,
    _fan_out,
    _push_one,
    _retry_edit,
    _retry_send,
    close_thread,
    open_thread,
    push_thread_event,
    update_thread,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _task(**kwargs):
    base = {
        "id": "t-1",
        "status": "running",
        "summary": "fix login 401",
        "route": "spawn_single",
        "session_key": "slack:channel:C100",
    }
    base.update(kwargs)
    return base


def _ok_send(message_id="msg-1"):
    return {"ok": True, "message_id": message_id}


def _ok_edit():
    return {"ok": True}


def _fail_result(error="network error"):
    return {"ok": False, "error": error}


# ---------------------------------------------------------------------------
# _all_session_keys
# ---------------------------------------------------------------------------

class AllSessionKeysTests(unittest.TestCase):
    def test_single_primary_key(self):
        task = _task(session_key="slack:channel:C1")
        self.assertEqual(_all_session_keys(task), ["slack:channel:C1"])

    def test_deduplicates_across_lists(self):
        task = _task(
            session_key="slack:channel:C1",
            extra_session_keys=["slack:channel:C1", "discord:channel:D2"],
            session_keys=["discord:channel:D2", "telegram:group:G3"],
        )
        keys = _all_session_keys(task)
        self.assertEqual(keys, ["slack:channel:C1", "discord:channel:D2", "telegram:group:G3"])

    def test_empty_values_skipped(self):
        task = _task(session_key="", extra_session_keys=[None, "", "slack:channel:C1"])
        self.assertEqual(_all_session_keys(task), ["slack:channel:C1"])

    def test_no_session_keys_returns_empty(self):
        task = {"id": "t-1"}
        self.assertEqual(_all_session_keys(task), [])


# ---------------------------------------------------------------------------
# _retry_send
# ---------------------------------------------------------------------------

class RetrySendTests(unittest.TestCase):
    @patch("lib.im_thread.send_channel_message")
    def test_succeeds_on_first_attempt(self, mock_send):
        mock_send.return_value = {"ok": True, "message_id": "m-1"}
        result = _retry_send("slack", "channel:C1", "hello")
        self.assertTrue(result["ok"])
        self.assertEqual(result["attempt"], 1)
        mock_send.assert_called_once()

    @patch("lib.im_thread.time")
    @patch("lib.im_thread.send_channel_message")
    def test_retries_on_failure_and_eventually_succeeds(self, mock_send, mock_time):
        mock_send.side_effect = [{"ok": False, "error": "timeout"}, {"ok": True, "message_id": "m-2"}]
        result = _retry_send("slack", "channel:C1", "hello")
        self.assertTrue(result["ok"])
        self.assertEqual(result["attempt"], 2)
        self.assertEqual(mock_send.call_count, 2)

    @patch("lib.im_thread.time")
    @patch("lib.im_thread.send_channel_message")
    def test_returns_last_failure_after_all_attempts_exhausted(self, mock_send, mock_time):
        mock_send.return_value = {"ok": False, "error": "server error"}
        result = _retry_send("slack", "channel:C1", "hello")
        self.assertFalse(result["ok"])
        self.assertEqual(mock_send.call_count, 3)

    @patch("lib.im_thread.time")
    @patch("lib.im_thread.send_channel_message")
    def test_handles_exception_and_retries(self, mock_send, mock_time):
        mock_send.side_effect = [RuntimeError("connection refused"), {"ok": True, "message_id": "m-3"}]
        result = _retry_send("slack", "channel:C1", "hello")
        self.assertTrue(result["ok"])
        self.assertEqual(result["attempt"], 2)


# ---------------------------------------------------------------------------
# _retry_edit
# ---------------------------------------------------------------------------

class RetryEditTests(unittest.TestCase):
    @patch("lib.im_thread.edit_channel_message")
    def test_succeeds_on_first_attempt(self, mock_edit):
        mock_edit.return_value = {"ok": True}
        result = _retry_edit("slack", "channel:C1", "msg-1", "updated text")
        self.assertTrue(result["ok"])
        self.assertEqual(result["attempt"], 1)

    @patch("lib.im_thread.time")
    @patch("lib.im_thread.edit_channel_message")
    def test_retries_up_to_three_times(self, mock_edit, mock_time):
        mock_edit.return_value = {"ok": False, "error": "rate limited"}
        result = _retry_edit("slack", "channel:C1", "msg-1", "text")
        self.assertFalse(result["ok"])
        self.assertEqual(mock_edit.call_count, 3)


# ---------------------------------------------------------------------------
# _push_one
# ---------------------------------------------------------------------------

class PushOneTests(unittest.TestCase):
    @patch("lib.im_thread.append_task_event")
    @patch("lib.im_thread.register_session_binding")
    @patch("lib.im_thread.resolve_session_binding")
    @patch("lib.im_thread.send_task_notification")
    def test_open_delegates_to_send_task_notification(self, mock_notify, mock_resolve, mock_register, mock_event):
        mock_notify.return_value = {"ok": True, "message_id": "m-1"}
        mock_resolve.return_value = {
            "origin": "slack",
            "target": "channel:C1",
            "thread_key": "slack:channel:C1:root",
        }
        result = _push_one("slack:channel:C1", _task(), "hello", action="open", config={})
        self.assertTrue(result["ok"])
        self.assertEqual(result["action"], "open")
        mock_notify.assert_called_once()
        # session_key should be injected into the sub-task passed to notify
        sub_task = mock_notify.call_args[0][0]
        self.assertEqual(sub_task["session_key"], "slack:channel:C1")

    @patch("lib.im_thread.register_session_binding")
    @patch("lib.im_thread.resolve_session_binding")
    @patch("lib.im_thread.edit_channel_message")
    def test_update_edits_anchor_on_editable_backend(self, mock_edit, mock_resolve, mock_register):
        mock_resolve.return_value = {
            "origin": "slack",
            "target": "channel:C1",
            "thread_id": "1712345.0",
            "thread_key": "slack:channel:C1:1712345.0",
            "last_message_id": "msg-anchor",
        }
        mock_edit.return_value = {"ok": True}
        result = _push_one("slack:channel:C1", _task(), "checkpoint msg", action="update", config={})
        self.assertTrue(result["ok"])
        self.assertEqual(result["action"], "edit")
        mock_edit.assert_called_once()
        args = mock_edit.call_args[0]
        self.assertEqual(args[0], "slack")
        self.assertEqual(args[1], "channel:C1")
        self.assertEqual(args[2], "msg-anchor")
        self.assertEqual(args[3], "checkpoint msg")

    @patch("lib.im_thread.register_session_binding")
    @patch("lib.im_thread.resolve_session_binding")
    @patch("lib.im_thread.send_channel_message")
    def test_update_falls_back_to_send_when_no_message_id(self, mock_send, mock_resolve, mock_register):
        mock_resolve.return_value = {
            "origin": "slack",
            "target": "channel:C1",
            "thread_id": "1712345.0",
            "thread_key": "slack:channel:C1:1712345.0",
            "last_message_id": "",
        }
        mock_send.return_value = {"ok": True, "message_id": "m-reply"}
        result = _push_one("slack:channel:C1", _task(), "progress", action="update", config={})
        self.assertTrue(result["ok"])
        self.assertEqual(result["action"], "send")

    @patch("lib.im_thread.register_session_binding")
    @patch("lib.im_thread.resolve_session_binding")
    @patch("lib.im_thread.send_channel_message")
    def test_update_uses_send_on_non_editable_backend(self, mock_send, mock_resolve, mock_register):
        mock_resolve.return_value = {
            "origin": "telegram",
            "target": "group:G1",
            "thread_id": "",
            "thread_key": "telegram:group:G1:root",
            "last_message_id": "tg-msg-1",
        }
        # telegram IS editable
        mock_send.return_value = {"ok": True, "message_id": "tg-reply"}
        # telegram in _EDITABLE_BACKENDS so it should try edit first — but
        # we only have send mocked here, so let's use whatsapp instead
        mock_resolve.return_value["origin"] = "whatsapp"
        mock_resolve.return_value["thread_key"] = "whatsapp:group:G1:root"
        result = _push_one("whatsapp:group:G1", _task(), "msg", action="update", config={})
        self.assertEqual(result["action"], "send")

    @patch("lib.im_thread.resolve_session_binding")
    def test_update_returns_error_when_no_target(self, mock_resolve):
        mock_resolve.return_value = {"origin": "slack", "target": "", "thread_key": ""}
        result = _push_one("slack:channel:C1", _task(), "msg", action="update", config={})
        self.assertFalse(result["ok"])
        self.assertIn("no IM target", result["error"])

    @patch("lib.im_thread.register_session_binding")
    @patch("lib.im_thread.resolve_session_binding")
    @patch("lib.im_thread.edit_channel_message")
    def test_close_marks_thread_state_closed(self, mock_edit, mock_resolve, mock_register):
        mock_resolve.return_value = {
            "origin": "discord",
            "target": "channel:D1",
            "thread_id": "",
            "thread_key": "discord:channel:D1:root",
            "last_message_id": "d-msg-1",
        }
        mock_edit.return_value = {"ok": True}
        _push_one("discord:channel:D1", _task(), "done!", action="close", config={})
        kwargs = mock_register.call_args[1]
        self.assertEqual(kwargs["thread_state"], "closed")


# ---------------------------------------------------------------------------
# _fan_out  (deduplication by thread_key)
# ---------------------------------------------------------------------------

class FanOutTests(unittest.TestCase):
    @patch("lib.im_thread._push_one")
    @patch("lib.im_thread.resolve_session_binding")
    def test_pushes_to_each_unique_thread_key(self, mock_resolve, mock_push):
        mock_resolve.side_effect = [
            {"thread_key": "slack:channel:C1:root"},
            {"thread_key": "discord:channel:D1:root"},
        ]
        mock_push.return_value = {"ok": True}
        task = _task(session_key="slack:channel:C1", extra_session_keys=["discord:channel:D1"])
        results = _fan_out(task, "msg", action="update", config={})
        self.assertEqual(len(results), 2)

    @patch("lib.im_thread._push_one")
    @patch("lib.im_thread.resolve_session_binding")
    def test_deduplicates_identical_thread_keys(self, mock_resolve, mock_push):
        # Both keys map to the same thread_key (e.g. same Slack channel via two paths)
        same_tk = {"thread_key": "slack:channel:C1:root"}
        mock_resolve.side_effect = [same_tk, same_tk]
        mock_push.return_value = {"ok": True}
        task = _task(session_key="slack:channel:C1", extra_session_keys=["agent:main:slack:channel:C1"])
        results = _fan_out(task, "msg", action="open", config={})
        self.assertEqual(len(results), 1)
        mock_push.assert_called_once()

    @patch("lib.im_thread._push_one")
    @patch("lib.im_thread.resolve_session_binding")
    def test_empty_session_keys_returns_empty(self, mock_resolve, mock_push):
        task = {"id": "t-x"}
        results = _fan_out(task, "msg", action="open", config={})
        self.assertEqual(results, [])
        mock_push.assert_not_called()


# ---------------------------------------------------------------------------
# open_thread / update_thread / close_thread
# ---------------------------------------------------------------------------

class OpenThreadTests(unittest.TestCase):
    @patch("lib.im_thread.append_task_event")
    @patch("lib.im_thread._fan_out")
    @patch("lib.im_thread.build_task_notification_payload")
    @patch("lib.im_thread.load_octopus_config")
    def test_calls_fan_out_with_open_action(self, mock_cfg, mock_payload, mock_fan_out, mock_event):
        mock_cfg.return_value = {}
        mock_payload.return_value = {"text": "task anchor text"}
        mock_fan_out.return_value = [{"ok": True, "session_key": "sk", "thread_key": "tk", "message_id": "m"}]

        results = open_thread(_task())

        self.assertEqual(len(results), 1)
        mock_fan_out.assert_called_once()
        _, _, kwargs = mock_fan_out.call_args[0][0], mock_fan_out.call_args[0][1], mock_fan_out.call_args[1]
        self.assertEqual(kwargs["action"], "open")

    @patch("lib.im_thread.append_task_event")
    @patch("lib.im_thread._fan_out")
    @patch("lib.im_thread.build_task_notification_payload")
    @patch("lib.im_thread.load_octopus_config")
    def test_returns_empty_when_no_message_text(self, mock_cfg, mock_payload, mock_fan_out, mock_event):
        mock_cfg.return_value = {}
        mock_payload.return_value = {"text": ""}
        results = open_thread(_task())
        self.assertEqual(results, [])
        mock_fan_out.assert_not_called()

    @patch("lib.im_thread.append_task_event")
    @patch("lib.im_thread._fan_out")
    @patch("lib.im_thread.build_task_notification_payload")
    @patch("lib.im_thread.load_octopus_config")
    def test_emits_thread_open_failed_event_on_failure(self, mock_cfg, mock_payload, mock_fan_out, mock_event):
        mock_cfg.return_value = {}
        mock_payload.return_value = {"text": "anchor"}
        mock_fan_out.return_value = [{"ok": False, "session_key": "sk", "thread_key": "tk", "error": "no target"}]

        open_thread(_task())

        events_emitted = [c.args[1] for c in mock_event.call_args_list]
        self.assertIn("thread_open_failed", events_emitted)


class UpdateThreadTests(unittest.TestCase):
    @patch("lib.im_thread.append_task_event")
    @patch("lib.im_thread._fan_out")
    @patch("lib.im_thread.load_octopus_config")
    def test_skips_low_importance_events(self, mock_cfg, mock_fan_out, mock_event):
        mock_cfg.return_value = {}
        results = update_thread(_task(), "route_selected", "msg")
        self.assertEqual(results, [])
        mock_fan_out.assert_not_called()

    @patch("lib.im_thread.append_task_event")
    @patch("lib.im_thread._fan_out")
    @patch("lib.im_thread.load_octopus_config")
    def test_pushes_normal_importance_events(self, mock_cfg, mock_fan_out, mock_event):
        mock_cfg.return_value = {}
        mock_fan_out.return_value = [{"ok": True, "session_key": "sk", "thread_key": "tk", "message_id": "m", "action": "edit"}]
        results = update_thread(_task(), "checkpoint", "progress!")
        self.assertEqual(len(results), 1)
        mock_fan_out.assert_called_once()
        self.assertEqual(mock_fan_out.call_args[1]["action"], "update")

    @patch("lib.im_thread.append_task_event")
    @patch("lib.im_thread._fan_out")
    @patch("lib.im_thread.load_octopus_config")
    def test_falls_back_to_task_summary_when_message_empty(self, mock_cfg, mock_fan_out, mock_event):
        mock_cfg.return_value = {}
        mock_fan_out.return_value = [{"ok": True, "session_key": "sk", "thread_key": "tk", "message_id": "m", "action": "edit"}]
        task = _task(summary="fix login 401")
        update_thread(task, "task_running", "")
        pushed_msg = mock_fan_out.call_args[0][1]
        self.assertEqual(pushed_msg, "fix login 401")

    @patch("lib.im_thread.append_task_event")
    @patch("lib.im_thread._fan_out")
    @patch("lib.im_thread.load_octopus_config")
    def test_emits_thread_updated_event_on_success(self, mock_cfg, mock_fan_out, mock_event):
        mock_cfg.return_value = {}
        mock_fan_out.return_value = [{"ok": True, "session_key": "sk", "thread_key": "tk", "message_id": "m", "action": "edit"}]
        update_thread(_task(), "checkpoint", "msg")
        events_emitted = [c.args[1] for c in mock_event.call_args_list]
        self.assertIn("thread_updated", events_emitted)


class CloseThreadTests(unittest.TestCase):
    @patch("lib.im_thread.append_task_event")
    @patch("lib.im_thread._fan_out")
    @patch("lib.im_thread.build_task_notification_payload")
    @patch("lib.im_thread.load_octopus_config")
    def test_passes_close_action_to_fan_out(self, mock_cfg, mock_payload, mock_fan_out, mock_event):
        mock_cfg.return_value = {}
        mock_payload.return_value = {"text": "task done"}
        mock_fan_out.return_value = [{"ok": True, "session_key": "sk", "thread_key": "tk", "message_id": "m", "action": "edit"}]
        close_thread(_task())
        self.assertEqual(mock_fan_out.call_args[1]["action"], "close")

    @patch("lib.im_thread.append_task_event")
    @patch("lib.im_thread._fan_out")
    @patch("lib.im_thread.build_task_notification_payload")
    @patch("lib.im_thread.load_octopus_config")
    def test_emits_thread_closed_event_on_success(self, mock_cfg, mock_payload, mock_fan_out, mock_event):
        mock_cfg.return_value = {}
        mock_payload.return_value = {"text": "done"}
        mock_fan_out.return_value = [{"ok": True, "session_key": "sk", "thread_key": "tk", "message_id": "m", "action": "edit"}]
        close_thread(_task())
        events_emitted = [c.args[1] for c in mock_event.call_args_list]
        self.assertIn("thread_closed", events_emitted)


# ---------------------------------------------------------------------------
# push_thread_event  (router)
# ---------------------------------------------------------------------------

class PushThreadEventTests(unittest.TestCase):
    @patch("lib.im_thread.open_thread")
    @patch("lib.im_thread.load_octopus_config")
    def test_routes_dispatch_started_to_open_thread(self, mock_cfg, mock_open):
        mock_cfg.return_value = {}
        mock_open.return_value = []
        push_thread_event(_task(), "dispatch_started")
        mock_open.assert_called_once()

    @patch("lib.im_thread.update_thread")
    @patch("lib.im_thread.load_octopus_config")
    def test_routes_checkpoint_to_update_thread(self, mock_cfg, mock_update):
        mock_cfg.return_value = {}
        mock_update.return_value = []
        push_thread_event(_task(), "checkpoint", message="50% done")
        mock_update.assert_called_once()
        self.assertEqual(mock_update.call_args[0][2], "50% done")

    @patch("lib.im_thread.close_thread")
    @patch("lib.im_thread.load_octopus_config")
    def test_routes_task_completed_to_close_thread(self, mock_cfg, mock_close):
        mock_cfg.return_value = {}
        mock_close.return_value = []
        push_thread_event(_task(), "task_completed")
        mock_close.assert_called_once()

    @patch("lib.im_thread.close_thread")
    @patch("lib.im_thread.load_octopus_config")
    def test_routes_all_close_events(self, mock_cfg, mock_close):
        mock_cfg.return_value = {}
        mock_close.return_value = []
        for event_kind in _CLOSE_EVENTS:
            with self.subTest(event_kind=event_kind):
                push_thread_event(_task(), event_kind)
        self.assertEqual(mock_close.call_count, len(_CLOSE_EVENTS))

    @patch("lib.im_thread.open_thread")
    @patch("lib.im_thread.update_thread")
    @patch("lib.im_thread.close_thread")
    @patch("lib.im_thread.load_octopus_config")
    def test_unknown_event_kind_is_no_op(self, mock_cfg, mock_close, mock_update, mock_open):
        mock_cfg.return_value = {}
        result = push_thread_event(_task(), "__totally_unknown__")
        self.assertEqual(result, [])
        mock_open.assert_not_called()
        mock_update.assert_not_called()
        mock_close.assert_not_called()


# ---------------------------------------------------------------------------
# Constant set sanity checks
# ---------------------------------------------------------------------------

class ConstantTests(unittest.TestCase):
    def test_editable_backends_contains_expected_platforms(self):
        self.assertIn("slack", _EDITABLE_BACKENDS)
        self.assertIn("discord", _EDITABLE_BACKENDS)
        self.assertIn("telegram", _EDITABLE_BACKENDS)

    def test_close_events_and_update_events_are_disjoint(self):
        self.assertEqual(_CLOSE_EVENTS & _UPDATE_EVENTS, frozenset())

    def test_open_events_and_close_events_are_disjoint(self):
        self.assertEqual(_OPEN_EVENTS & _CLOSE_EVENTS, frozenset())


if __name__ == "__main__":
    unittest.main()
