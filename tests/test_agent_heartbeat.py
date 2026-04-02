#!/usr/bin/env python3
import json
import tempfile
import unittest
from pathlib import Path

from lib.agent_heartbeat import is_agent_alive, read_heartbeats, write_heartbeat


class AgentHeartbeatTests(unittest.TestCase):
    def test_write_and_read_heartbeat(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-heartbeats-") as tmpdir:
            record = write_heartbeat("agent-1", tmpdir)
            heartbeats = read_heartbeats(tmpdir)
            alive = is_agent_alive("agent-1", tmpdir, stale_after_seconds=60)

        self.assertTrue(record["healthy"])
        self.assertEqual(heartbeats["agent-1"]["pid"], record["pid"])
        self.assertTrue(alive)

    def test_is_agent_alive_returns_false_for_stale_record(self) -> None:
        with tempfile.TemporaryDirectory(prefix="octoclaw-heartbeats-") as tmpdir:
            write_heartbeat("agent-2", tmpdir)
            heartbeat_path = Path(tmpdir) / "tmp" / "octopus" / "agent-heartbeats.json"
            payload = json.loads(heartbeat_path.read_text(encoding="utf-8"))
            payload["agent-2"]["last_beat_at"] = "2020-01-01T00:00:00+00:00"
            heartbeat_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

            self.assertFalse(is_agent_alive("agent-2", tmpdir, stale_after_seconds=60))


if __name__ == "__main__":
    unittest.main()
