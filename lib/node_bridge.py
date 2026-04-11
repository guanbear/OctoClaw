#!/usr/bin/env python3
"""Persistent Node.js bridge using stdio pipe for low-latency calls.

Instead of spawning a new ``node`` process for every invocation, this module
keeps a single long-lived Node.js child alive and communicates over stdin /
stdout using newline-delimited JSON.
"""

from __future__ import annotations

import json
import subprocess
import threading
from typing import Any


class NodeBridge:

    def __init__(self, bridge_script_path: str, node_bin: str = "node", env: dict | None = None):
        self._bridge_script_path = bridge_script_path
        self._node_bin = node_bin
        self._env = env
        self._proc: subprocess.Popen | None = None
        self._lock = threading.Lock()
        self._id_counter = 0
        self._pending: dict[int, threading.Event] = {}
        self._results: dict[int, dict] = {}
        self._reader_thread: threading.Thread | None = None
        self._dead = False

    def start(self) -> None:
        if self.is_alive():
            return
        self._dead = False
        self._proc = subprocess.Popen(
            [self._node_bin, self._bridge_script_path],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=self._env,
        )
        self._reader_thread = threading.Thread(target=self._reader_loop, daemon=True)
        self._reader_thread.start()

    def stop(self) -> None:
        proc = self._proc
        self._dead = True
        self._proc = None
        if proc is None:
            return
        try:
            if proc.stdin is not None:
                proc.stdin.close()
        except Exception:
            pass
        if proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=5)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass

    def is_alive(self) -> bool:
        return not self._dead and self._proc is not None and self._proc.poll() is None

    def call(self, method: str, **kwargs: Any) -> dict:
        """Protocol: stdin {"id":N,"method":"...","args":{...}} -> stdout {"id":N,"result":{...}|error}"""
        if self._dead:
            raise RuntimeError("Node bridge process has died")
        if not self.is_alive():
            raise RuntimeError("Node bridge is not running")
        with self._lock:
            self._id_counter += 1
            call_id = self._id_counter
        event = threading.Event()
        with self._lock:
            self._pending[call_id] = event
        request_line = json.dumps(
            {"id": call_id, "method": method, "args": kwargs},
            ensure_ascii=False,
        ) + "\n"
        try:
            proc = self._proc
            if proc is None or proc.stdin is None:
                raise RuntimeError("Node bridge process is gone")
            proc.stdin.write(request_line.encode("utf-8"))
            proc.stdin.flush()
        except Exception:
            with self._lock:
                self._pending.pop(call_id, None)
            raise
        if not event.wait(timeout=30):
            with self._lock:
                self._pending.pop(call_id, None)
            raise TimeoutError(f"Node bridge call '{method}' timed out after 30s")
        with self._lock:
            self._pending.pop(call_id, None)
            result = self._results.pop(call_id, None)
        if result is None:
            raise RuntimeError(f"Node bridge call '{method}' lost result")
        if "error" in result:
            raise RuntimeError(result["error"])
        return result.get("result", {})

    def __enter__(self) -> "NodeBridge":
        self.start()
        return self

    def __exit__(self, *args: Any) -> None:
        self.stop()

    def _reader_loop(self) -> None:
        proc = self._proc
        if proc is None or proc.stdout is None:
            self._dead = True
            return
        try:
            for raw_line in proc.stdout:
                line = raw_line.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue
                call_id = msg.get("id")
                if call_id is not None:
                    with self._lock:
                        self._results[call_id] = msg
                        event = self._pending.get(call_id)
                    if event is not None:
                        event.set()
        except Exception:
            pass
        finally:
            self._dead = True
            with self._lock:
                pending = list(self._pending.values())
            for ev in pending:
                ev.set()
