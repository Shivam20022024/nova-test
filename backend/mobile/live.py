"""
Live execution streaming — a per-execution pub/sub event bus over native
FastAPI WebSockets (section 90/53), plus a background frame streamer that
polls the device screen via ADB so the frontend can show what's happening
on the device while a test runs.

The execution engine (mobile/engine.py) runs synchronously in a worker
thread (FastAPI BackgroundTasks), not on the asyncio event loop — so
`emit()` is a plain, thread-safe, non-blocking call that hands the actual
WebSocket send off to the main event loop via run_coroutine_threadsafe.
"""
from __future__ import annotations

import asyncio
import base64
import collections
import datetime
import subprocess
import threading
from typing import Dict, List, Optional, Set

from mobile.device_manager import ADB_PATH
from utils.logger import get_logger

logger = get_logger("mobile.live")

HISTORY_LIMIT = 500


class MobileEventBus:
    def __init__(self) -> None:
        self._clients: Dict[int, Set] = collections.defaultdict(set)
        self._history: Dict[int, List[dict]] = collections.defaultdict(list)
        self._loop: Optional[asyncio.AbstractEventLoop] = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    async def connect(self, execution_id: int, websocket) -> None:
        await websocket.accept()
        self._clients[execution_id].add(websocket)
        for evt in list(self._history.get(execution_id, [])):
            try:
                await websocket.send_json(evt)
            except Exception:
                break

    def disconnect(self, execution_id: int, websocket) -> None:
        self._clients.get(execution_id, set()).discard(websocket)

    async def _emit_async(self, execution_id: int, payload: dict) -> None:
        stamped = {"timestamp": datetime.datetime.utcnow().isoformat(), **payload}
        hist = self._history[execution_id]
        hist.append(stamped)
        if len(hist) > HISTORY_LIMIT:
            del hist[: len(hist) - HISTORY_LIMIT]

        dead = []
        for ws in list(self._clients.get(execution_id, [])):
            try:
                await ws.send_json(stamped)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self._clients[execution_id].discard(ws)

    def emit(self, execution_id: int, payload: dict) -> None:
        """Thread-safe: safe to call from the synchronous engine worker thread."""
        if self._loop is None:
            return
        try:
            asyncio.run_coroutine_threadsafe(self._emit_async(execution_id, payload), self._loop)
        except RuntimeError:
            pass  # event loop already shut down (e.g. during process exit)

    def clear(self, execution_id: int) -> None:
        self._history.pop(execution_id, None)


event_bus = MobileEventBus()


class FrameStreamer:
    """Polls the device screen via `adb exec-out screencap -p` on its own
    thread, independent of the Appium/Selenium session (which is not
    safe to share across threads), and emits `frame` events."""

    def __init__(self, execution_id: int, serial: str, interval_s: float = 0.7):
        self.execution_id = execution_id
        self.serial = serial
        self.interval_s = interval_s
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name=f"frame-streamer-{self.execution_id}", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=3)

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                result = subprocess.run(
                    [ADB_PATH, "-s", self.serial, "exec-out", "screencap", "-p"],
                    capture_output=True, timeout=5,
                )
                if result.returncode == 0 and result.stdout:
                    frame_b64 = base64.b64encode(result.stdout).decode("ascii")
                    event_bus.emit(self.execution_id, {"event": "frame", "mime_type": "image/png", "frame_b64": frame_b64})
            except Exception as exc:
                logger.debug("Frame capture failed (execution %s): %s", self.execution_id, exc)
            self._stop.wait(self.interval_s)
