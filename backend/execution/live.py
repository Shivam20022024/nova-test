from __future__ import annotations

import asyncio
import base64
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set

from fastapi import WebSocket


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class ExecutionEventBus:
    def __init__(self) -> None:
        self._clients: Dict[str, Set[WebSocket]] = defaultdict(set)
        self._history: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
        self._lock = asyncio.Lock()

    async def connect(self, execution_id: str, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self._clients[execution_id].add(websocket)
            history = list(self._history.get(execution_id, []))
        for event in history[-200:]:
            await self._safe_send(websocket, event)

    async def disconnect(self, execution_id: str, websocket: WebSocket) -> None:
        async with self._lock:
            self._clients[execution_id].discard(websocket)

    async def emit(self, execution_id: str, payload: Dict[str, Any]) -> None:
        event = {"execution_id": execution_id, "timestamp": utc_now_iso(), **payload}
        async with self._lock:
            self._history[execution_id].append(event)
            clients = list(self._clients.get(execution_id, set()))
        for client in clients:
            await self._safe_send(client, event)

    async def _safe_send(self, websocket: WebSocket, payload: Dict[str, Any]) -> None:
        try:
            await websocket.send_json(payload)
        except Exception:
            pass

    def history(self, execution_id: str) -> List[Dict[str, Any]]:
        return list(self._history.get(execution_id, []))


event_bus = ExecutionEventBus()


async def stream_page_frame(page: Any) -> Optional[str]:
    try:
        if hasattr(page, "is_closed") and page.is_closed():
            return None
        data = await page.screenshot(type="jpeg", quality=45, full_page=False)
        return base64.b64encode(data).decode("ascii")
    except Exception:
        return None


@dataclass
class StreamController:
    execution_id: str
    page: Any
    interval_seconds: float = 0.5
    channel_ids: Optional[List[str]] = None
    _task: Optional[asyncio.Task] = None
    _running: bool = False

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                # Expected when shutting down the background streamer.
                pass
            except Exception:
                pass

    async def _loop(self) -> None:
        try:
            while self._running:
                frame = await stream_page_frame(self.page)
                if frame:
                    targets = self.channel_ids or [self.execution_id]
                    for channel_id in targets:
                        await event_bus.emit(
                            channel_id,
                            {
                                "event": "frame",
                                "mime_type": "image/jpeg",
                                "frame_b64": frame,
                                "source_execution_id": self.execution_id,
                            },
                        )
                await asyncio.sleep(self.interval_seconds)
        except asyncio.CancelledError:
            # Normal task cancellation during execution teardown.
            return
