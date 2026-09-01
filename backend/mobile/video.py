"""
Screen recording via `adb shell screenrecord` (section 52). No FFmpeg
dependency — Android's own encoder produces an .mp4 directly on-device.

Stopping is the tricky part: killing the local `adb shell screenrecord`
wrapper process does not gracefully finalize the remote .mp4 (its moov
atom never gets written, so most players can't open it). The reliable
approach is to send SIGINT to the *remote* screenrecord process via
`adb shell pkill`, which lets it finalize the file, then pull it.
"""
from __future__ import annotations

import subprocess
import time
import uuid
from pathlib import Path
from typing import Optional

from mobile.device_manager import ADB_PATH
from utils.logger import get_logger

logger = get_logger("mobile.video")


class ScreenRecorder:
    def __init__(self, serial: str):
        self.serial = serial
        self.remote_path = f"/sdcard/apptesting_rec_{uuid.uuid4().hex[:8]}.mp4"
        self._process: Optional[subprocess.Popen] = None
        self._started = False

    def start(self, bitrate: int = 4_000_000) -> bool:
        try:
            self._process = subprocess.Popen(
                [ADB_PATH, "-s", self.serial, "shell", "screenrecord", "--bit-rate", str(bitrate), self.remote_path],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            self._started = True
            return True
        except Exception as exc:
            logger.warning("Failed to start screenrecord on %s: %s", self.serial, exc)
            return False

    def stop_and_pull(self, local_path: Path) -> bool:
        if not self._started:
            return False

        # Gracefully stop the *remote* recorder so the mp4 gets finalized.
        stopped_cleanly = False
        try:
            result = subprocess.run(
                [ADB_PATH, "-s", self.serial, "shell", "pkill", "-l", "SIGINT", "screenrecord"],
                capture_output=True, timeout=10,
            )
            stopped_cleanly = result.returncode == 0
        except Exception as exc:
            logger.debug("pkill screenrecord failed: %s", exc)

        time.sleep(1.5)  # give the encoder a moment to flush/finalize

        if self._process is not None:
            try:
                self._process.wait(timeout=5)
            except Exception:
                try:
                    self._process.terminate()
                except Exception:
                    pass

        local_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            pull = subprocess.run(
                [ADB_PATH, "-s", self.serial, "pull", self.remote_path, str(local_path)],
                capture_output=True, timeout=30,
            )
        except Exception as exc:
            logger.warning("Failed to pull recording from device: %s", exc)
            return False

        try:
            subprocess.run([ADB_PATH, "-s", self.serial, "shell", "rm", "-f", self.remote_path], capture_output=True, timeout=10)
        except Exception:
            pass

        ok = pull.returncode == 0 and local_path.exists() and local_path.stat().st_size > 1024
        if not ok:
            logger.warning("Screen recording pull produced no usable file (stopped_cleanly=%s).", stopped_cleanly)
        return ok
