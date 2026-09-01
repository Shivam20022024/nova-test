"""
Logging utilities for the AI Test Execution Platform.

Provides:
- A module-level logger for the application.
- A RunLogger that captures per-run logs in memory while also
  writing to a rotating file under storage/logs/.
"""
from __future__ import annotations

import logging
import logging.handlers
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import List


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

_BASE_DIR = Path(__file__).resolve().parent.parent
LOGS_DIR = _BASE_DIR / "storage" / "logs"
LOGS_DIR.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# Root / application logger (rotating file + coloured console)
# ---------------------------------------------------------------------------

_FMT = "%(asctime)s | %(levelname)-8s | %(name)s | %(message)s"
_DATE_FMT = "%Y-%m-%dT%H:%M:%S"


def _configure_root_logger() -> logging.Logger:
    root = logging.getLogger("ai_test_platform")
    if root.handlers:
        return root  # already configured (e.g. on reload)

    root.setLevel(logging.DEBUG)

    # Console handler
    ch = logging.StreamHandler()
    ch.setLevel(logging.INFO)
    ch.setFormatter(logging.Formatter(_FMT, datefmt=_DATE_FMT))
    root.addHandler(ch)

    # Rotating file handler  (10 MB × 5 files)
    log_file = LOGS_DIR / "app.log"
    fh = logging.handlers.RotatingFileHandler(
        log_file, maxBytes=10 * 1024 * 1024, backupCount=5, encoding="utf-8"
    )
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(logging.Formatter(_FMT, datefmt=_DATE_FMT))
    root.addHandler(fh)

    return root


app_logger = _configure_root_logger()


def get_logger(name: str) -> logging.Logger:
    """Return a child logger namespaced under ai_test_platform."""
    return app_logger.getChild(name)


# ---------------------------------------------------------------------------
# Per-run in-memory logger
# ---------------------------------------------------------------------------

class RunLogger:
    """
    Captures log lines for a single test run in memory and optionally
    writes them to a dedicated run log file.

    Usage::

        rl = RunLogger(test_name="Login Test")
        rl.info("Starting step 1")
        rl.error("Step 2 failed: timeout")
        lines: List[str] = rl.get_logs()
        rl.flush_to_file()
    """

    def __init__(self, test_name: str) -> None:
        self._test_name = test_name
        self._lines: List[str] = []
        self._started_at = datetime.now(timezone.utc)
        self._logger = get_logger(f"run.{test_name.replace(' ', '_')}")

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _record(self, level: str, message: str) -> None:
        ts = datetime.now(timezone.utc).strftime("%H:%M:%S.%f")[:-3]
        line = f"[{ts}] {level:7s} | {message}"
        self._lines.append(line)
        # Mirror to the application logger at the same level
        lvl = getattr(logging, level.strip(), logging.DEBUG)
        self._logger.log(lvl, message)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def debug(self, message: str) -> None:
        self._record("DEBUG", message)

    def info(self, message: str) -> None:
        self._record("INFO", message)

    def warning(self, message: str) -> None:
        self._record("WARNING", message)

    def error(self, message: str) -> None:
        self._record("ERROR", message)

    def get_logs(self) -> List[str]:
        return list(self._lines)

    def get_logs_slice(self, start_index: int) -> List[str]:
        return list(self._lines[start_index:])

    def flush_to_file(self) -> Path:
        """Write captured logs to storage/logs/<timestamp>_<test_name>.log."""
        safe_name = "".join(
            c if c.isalnum() or c in "-_" else "_"
            for c in self._test_name
        )
        ts = self._started_at.strftime("%Y%m%dT%H%M%S")
        log_file = LOGS_DIR / f"{ts}_{safe_name}.log"

        with log_file.open("w", encoding="utf-8") as fh:
            fh.write(f"# Test Run: {self._test_name}\n")
            fh.write(f"# Started : {self._started_at.isoformat()}\n\n")
            fh.write("\n".join(self._lines))
            fh.write("\n")

        app_logger.info("Run log written to %s", log_file)
        return log_file
