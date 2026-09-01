#!/usr/bin/env python3
"""
AI Test Execution Platform startup script (Windows-compatible).

This script applies stable defaults so you do not need to set environment
variables manually every time.
"""

import os
import subprocess
import sys
from pathlib import Path


def main() -> None:
    backend_dir = Path(__file__).parent
    venv_python = backend_dir / ".venv" / "Scripts" / "python.exe"

    if not venv_python.exists():
        print(f"[ERROR] Virtual environment not found at: {venv_python}")
        print("Run: python -m venv .venv && .\\.venv\\Scripts\\activate && pip install -r requirements.txt")
        sys.exit(1)

    # Default runtime profile for faster and more stable executions.
    os.environ.setdefault("AI_ENABLE_TRACE", "0")
    os.environ.setdefault("AI_ENABLE_VIDEO", "0")
    os.environ.setdefault("AI_EVIDENCE_LEVEL", "minimal")

    host = os.getenv("AI_BACKEND_HOST", "127.0.0.1")
    port = os.getenv("AI_BACKEND_PORT", "8000")

    cmd = [
        str(venv_python),
        "-m",
        "uvicorn",
        "main:app",
        "--host",
        host,
        "--port",
        port,
        "--loop",
        "asyncio",
    ]

    print("[INFO] Starting AI Test Execution Platform")
    print(f"[INFO] URL: http://{host}:{port}")
    print(f"[INFO] Docs: http://{host}:{port}/docs")
    print(f"[INFO] AI_ENABLE_TRACE={os.environ.get('AI_ENABLE_TRACE')}")
    print(f"[INFO] AI_ENABLE_VIDEO={os.environ.get('AI_ENABLE_VIDEO')}")
    print(f"[INFO] AI_EVIDENCE_LEVEL={os.environ.get('AI_EVIDENCE_LEVEL')}")
    print(f"[INFO] Command: {' '.join(cmd)}")

    try:
        subprocess.run(cmd, cwd=backend_dir)
    except KeyboardInterrupt:
        print("\n[INFO] Server stopped")
    except Exception as exc:  # noqa: BLE001
        print(f"[ERROR] Failed to start server: {exc}")
        sys.exit(1)


if __name__ == "__main__":
    main()
