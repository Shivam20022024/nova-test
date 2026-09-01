"""
On-demand Android emulator lifecycle.

**Opt-in.** Everything here is inert unless `EMULATOR_AUTO_START=1`. With it
set: when a test run needs a device and none is connected / free, the
platform boots a headless AVD itself, waits for it to come online, hands it
to the run, keeps it warm for a short idle window (so back-to-back runs
don't each pay a cold boot), then shuts it down. Emulators the platform
started are tracked and are the ONLY ones it will ever kill — a physical
device or an externally-managed emulator is never touched.

Config (env):
  EMULATOR_AUTO_START        "1" to enable (default off)
  EMULATOR_AVD               AVD name to launch (default: first of `emulator -list-avds`)
  EMULATOR_POOL_MAX          max concurrently-managed emulators (default 1)
  EMULATOR_HEADLESS          "0" to show a window (default headless)
  EMULATOR_IDLE_SHUTDOWN_SEC idle seconds before auto-kill; 0 = never (default 600)
  EMULATOR_BOOT_TIMEOUT_SEC  seconds to wait for boot (default 240)
  EMULATOR_ACQUIRE_TIMEOUT_SEC  seconds to wait for a free device when pool is full (default 300)
  EMULATOR_EXTRA_ARGS        extra space-separated args passed to `emulator`
"""
from __future__ import annotations

import os
import shutil
import socket
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional

from sqlalchemy.orm import Session

from mobile import device_manager
from mobile.models import MobileDevice
from utils.logger import get_logger

logger = get_logger("mobile.emulator_manager")


def _env_bool(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    if v is None:
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "").strip())
    except (TypeError, ValueError):
        return default


def is_enabled() -> bool:
    return _env_bool("EMULATOR_AUTO_START", False)


POOL_MAX = _env_int("EMULATOR_POOL_MAX", 1)
HEADLESS = _env_bool("EMULATOR_HEADLESS", True)
IDLE_SHUTDOWN_SEC = _env_int("EMULATOR_IDLE_SHUTDOWN_SEC", 600)
BOOT_TIMEOUT_SEC = _env_int("EMULATOR_BOOT_TIMEOUT_SEC", 240)
ACQUIRE_TIMEOUT_SEC = _env_int("EMULATOR_ACQUIRE_TIMEOUT_SEC", 300)


def _sdk_root() -> Optional[Path]:
    for var in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        p = os.environ.get(var)
        if p and Path(p).is_dir():
            return Path(p)
    return None


def _emulator_bin() -> str:
    override = os.environ.get("EMULATOR_BIN")
    if override:
        return override
    sdk = _sdk_root()
    if sdk:
        for name in ("emulator.exe", "emulator"):
            cand = sdk / "emulator" / name
            if cand.exists():
                return str(cand)
    found = shutil.which("emulator")
    if found:
        return found
    raise RuntimeError("Android emulator binary not found — set ANDROID_HOME or EMULATOR_BIN.")


def list_avds() -> List[str]:
    try:
        out = subprocess.run([_emulator_bin(), "-list-avds"], capture_output=True, text=True, timeout=20)
    except Exception as exc:
        logger.warning("emulator -list-avds failed: %s", exc)
        return []
    return [ln.strip() for ln in out.stdout.splitlines() if ln.strip() and not ln.startswith("INFO")]


def _default_avd() -> str:
    configured = os.environ.get("EMULATOR_AVD", "").strip()
    if configured:
        return configured
    avds = list_avds()
    if not avds:
        raise RuntimeError("No AVDs found. Create one with `avdmanager create avd`, or set EMULATOR_AVD.")
    return avds[0]


# ── Managed-emulator registry ─────────────────────────────────────────────

@dataclass
class ManagedEmulator:
    serial: str
    avd: str
    process: Optional[subprocess.Popen]
    launched_at: float = field(default_factory=time.time)
    last_used: float = field(default_factory=time.time)


_managed: Dict[str, ManagedEmulator] = {}
_lock = threading.RLock()
_reaper_started = False


def managed_serials() -> List[str]:
    with _lock:
        return list(_managed)


def touch(serial: str) -> None:
    with _lock:
        m = _managed.get(serial)
        if m:
            m.last_used = time.time()


def release(serial: str) -> None:
    """Mark a managed emulator idle — starts its idle-shutdown clock. No-op
    for a device the platform didn't launch."""
    touch(serial)


# ── Console-port allocation ───────────────────────────────────────────────

_CONSOLE_PORT_RANGE = range(5554, 5682, 2)  # even ports; adb serial = emulator-<port>


def _port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.2)
        return s.connect_ex(("127.0.0.1", port)) == 0


def _free_console_port() -> int:
    adb_serials = {d["serial"] for d in device_manager.list_adb_devices()}
    with _lock:
        claimed = set(_managed)
        for port in _CONSOLE_PORT_RANGE:
            serial = f"emulator-{port}"
            if serial in adb_serials or serial in claimed:
                continue
            if _port_in_use(port) or _port_in_use(port + 1):
                continue
            return port
    raise RuntimeError("No free emulator console port available.")


# ── Launch / shutdown ─────────────────────────────────────────────────────

def _adb(args: List[str], serial: Optional[str] = None, timeout: int = 20) -> subprocess.CompletedProcess:
    cmd = [device_manager.ADB_PATH]
    if serial:
        cmd += ["-s", serial]
    return subprocess.run(cmd + args, capture_output=True, text=True, timeout=timeout)


def launch(avd: Optional[str] = None) -> str:
    """Boot a headless AVD and return its adb serial once it is fully booted.
    Raises on any failure (and cleans up the half-started process)."""
    avd = avd or _default_avd()
    port = _free_console_port()
    serial = f"emulator-{port}"

    args = [_emulator_bin(), "-avd", avd, "-port", str(port),
            "-no-boot-anim", "-no-audio", "-no-snapshot", "-accel", "auto"]
    if HEADLESS:
        args.append("-no-window")
    extra = os.environ.get("EMULATOR_EXTRA_ARGS", "").strip()
    if extra:
        args += extra.split()

    logger.info("Launching emulator: avd=%s serial=%s headless=%s", avd, serial, HEADLESS)
    try:
        _adb(["start-server"], timeout=20)
    except Exception:
        pass

    proc = subprocess.Popen(
        args,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
    )

    deadline = time.time() + BOOT_TIMEOUT_SEC
    booted = False
    try:
        # 1) wait for the device to register with adb
        while time.time() < deadline:
            if proc.poll() is not None:
                raise RuntimeError(f"emulator process exited early (code {proc.returncode})")
            serials = {d["serial"]: d for d in device_manager.list_adb_devices()}
            if serial in serials and serials[serial].get("state") == "device":
                break
            time.sleep(2)
        # 2) wait for Android to finish booting
        while time.time() < deadline:
            try:
                out = _adb(["shell", "getprop", "sys.boot_completed"], serial=serial, timeout=10).stdout.strip()
            except Exception:
                out = ""
            if out == "1":
                booted = True
                break
            time.sleep(3)

        if not booted:
            raise RuntimeError(f"emulator {serial} did not finish booting within {BOOT_TIMEOUT_SEC}s")

        for extra_cmd in (["shell", "input", "keyevent", "82"], ["shell", "wm", "dismiss-keyguard"]):
            try:
                _adb(extra_cmd, serial=serial, timeout=10)
            except Exception:
                pass

        with _lock:
            _managed[serial] = ManagedEmulator(serial=serial, avd=avd, process=proc)
        logger.info("Emulator %s is booted and ready.", serial)
        return serial
    except Exception:
        _kill_process_tree(proc)
        raise


def _kill_process_tree(proc: subprocess.Popen) -> None:
    if proc is None:
        return
    if os.name == "nt":
        try:
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True, timeout=15)
        except Exception:
            pass
    else:
        try:
            proc.terminate()
            proc.wait(timeout=10)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass


def shutdown(serial: str) -> None:
    with _lock:
        m = _managed.pop(serial, None)
    if m is None:
        return
    logger.info("Shutting down managed emulator %s", serial)
    try:
        _adb(["-s", serial, "emu", "kill"], timeout=15)
    except Exception:
        pass
    time.sleep(2)
    _kill_process_tree(m.process)


def shutdown_all() -> None:
    for serial in managed_serials():
        try:
            shutdown(serial)
        except Exception:
            logger.warning("Error shutting down emulator %s", serial, exc_info=True)


# ── Acquire a device for a run ────────────────────────────────────────────

def _first_available(db: Session) -> Optional[MobileDevice]:
    device_manager.sync_devices(db)
    return (
        db.query(MobileDevice)
        .filter(MobileDevice.status == "AVAILABLE")
        .order_by(MobileDevice.id)
        .first()
    )


def acquire_device(db: Session) -> MobileDevice:
    """Return a healthy, AVAILABLE MobileDevice for a run to reserve.

    Order of preference: (1) any device already connected and free — physical
    or an emulator someone else started; (2) boot a new managed emulator if
    under the pool cap; (3) wait for one to free up. The caller is still
    responsible for reserving it (device_manager.reserve_device)."""
    if not is_enabled():
        raise device_manager.DeviceUnavailableError(
            "No device available and EMULATOR_AUTO_START is not enabled."
        )

    with _lock:
        existing = _first_available(db)
        if existing is not None:
            touch(existing.serial)
            return existing

        if len(_managed) < max(1, POOL_MAX):
            serial = launch()
            device_manager.sync_devices(db)
            row = db.query(MobileDevice).filter(MobileDevice.serial == serial).first()
            if row is None:
                raise device_manager.DeviceUnavailableError(
                    f"Emulator {serial} booted but did not register as a device."
                )
            return row

    # Pool is full — wait (outside the lock) for something to become AVAILABLE.
    deadline = time.time() + ACQUIRE_TIMEOUT_SEC
    while time.time() < deadline:
        time.sleep(5)
        with _lock:
            free = _first_available(db)
            if free is not None:
                touch(free.serial)
                return free
    raise device_manager.DeviceUnavailableError(
        f"No device became available within {ACQUIRE_TIMEOUT_SEC}s (pool cap {POOL_MAX} reached)."
    )


# ── Idle reaper ──────────────────────────────────────────────────────────

def _idle_reaper_loop() -> None:
    from mobile.database import SessionLocal
    while True:
        time.sleep(60)
        if IDLE_SHUTDOWN_SEC <= 0:
            continue
        now = time.time()
        candidates = []
        with _lock:
            for serial, m in list(_managed.items()):
                if now - m.last_used >= IDLE_SHUTDOWN_SEC:
                    candidates.append(serial)
        if not candidates:
            continue
        db = SessionLocal()
        try:
            for serial in candidates:
                row = db.query(MobileDevice).filter(MobileDevice.serial == serial).first()
                if row is not None and row.status == "RESERVED":
                    touch(serial)  # in use again — reset the clock
                    continue
                logger.info("Emulator %s idle for >%ds — shutting it down.", serial, IDLE_SHUTDOWN_SEC)
                shutdown(serial)
                if row is not None:
                    row.status = "OFFLINE"
                    db.commit()
        finally:
            db.close()


def start_idle_reaper() -> None:
    global _reaper_started
    if not is_enabled() or _reaper_started:
        return
    _reaper_started = True
    threading.Thread(target=_idle_reaper_loop, name="emulator-idle-reaper", daemon=True).start()
    logger.info("Emulator on-demand lifecycle enabled (pool max %d, idle shutdown %ds).", POOL_MAX, IDLE_SHUTDOWN_SEC)
