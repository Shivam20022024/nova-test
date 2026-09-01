"""
DeviceManager — ADB-based Android device discovery, health checks, and
reservation. No Docker/Kubernetes/Redis required for local dev: reservation
is a simple DB-backed lock (rule 37 — shared lock in integrated platform
mode is a future extension, not required today).
"""
from __future__ import annotations

import datetime
import os
import re
import shutil
import subprocess
from typing import Dict, List, Optional

from sqlalchemy.orm import Session

from mobile.models import MobileDevice
from utils.logger import get_logger

logger = get_logger("mobile.device_manager")

ADB_PATH = os.environ.get("ADB_PATH") or shutil.which("adb") or "adb"


class DeviceUnavailableError(Exception):
    pass


def _adb(args: List[str], serial: Optional[str] = None, timeout: int = 15) -> subprocess.CompletedProcess:
    cmd = [ADB_PATH]
    if serial:
        cmd += ["-s", serial]
    cmd += args
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def list_adb_devices() -> List[Dict[str, str]]:
    """Raw `adb devices -l` discovery. Never assumes a specific device is present."""
    try:
        result = _adb(["devices", "-l"], timeout=10)
    except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
        logger.error("ADB discovery failed: %s", exc)
        return []

    devices = []
    for line in result.stdout.splitlines()[1:]:
        line = line.strip()
        if not line:
            continue
        parts = line.split()
        serial, state = parts[0], parts[1]
        extra = {}
        for tok in parts[2:]:
            if ":" in tok:
                k, v = tok.split(":", 1)
                extra[k] = v
        devices.append({"serial": serial, "state": state, **extra})
    return devices


def _getprop(serial: str, prop: str) -> Optional[str]:
    try:
        result = _adb(["shell", "getprop", prop], serial=serial, timeout=10)
        val = result.stdout.strip()
        return val or None
    except subprocess.TimeoutExpired:
        return None


_BATTERY_STATUS_CODES = {
    "1": "unknown", "2": "charging", "3": "discharging", "4": "not_charging", "5": "full",
}


def _battery_info(serial: str) -> Dict[str, Optional[object]]:
    """`adb shell dumpsys battery` — works on real devices and emulators alike,
    no app-under-test permissions needed. Never guesses: a device that's
    unreachable or returns unparseable output gets nulls, not a stale value."""
    try:
        out = _adb(["shell", "dumpsys", "battery"], serial=serial, timeout=10).stdout
    except subprocess.TimeoutExpired:
        return {"battery_level": None, "battery_status": None}

    level_m = re.search(r"^\s*level:\s*(\d+)", out, re.MULTILINE)
    status_m = re.search(r"^\s*status:\s*(\d+)", out, re.MULTILINE)
    level = int(level_m.group(1)) if level_m else None
    status = _BATTERY_STATUS_CODES.get(status_m.group(1)) if status_m else None
    return {"battery_level": level, "battery_status": status}


def get_device_properties(serial: str) -> Dict[str, Optional[str]]:
    props = {
        "manufacturer": _getprop(serial, "ro.product.manufacturer"),
        "model": _getprop(serial, "ro.product.model"),
        "android_version": _getprop(serial, "ro.build.version.release"),
        "api_level": _getprop(serial, "ro.build.version.sdk"),
        "architecture": _getprop(serial, "ro.product.cpu.abi"),
        "is_emulator": (_getprop(serial, "ro.kernel.qemu") == "1") or serial.startswith("emulator-"),
    }
    props.update(_battery_info(serial))
    try:
        size_out = _adb(["shell", "wm", "size"], serial=serial, timeout=10).stdout
        m = re.search(r"(\d+x\d+)", size_out)
        props["resolution"] = m.group(1) if m else None
    except subprocess.TimeoutExpired:
        props["resolution"] = None
    try:
        density_out = _adb(["shell", "wm", "density"], serial=serial, timeout=10).stdout
        m = re.search(r"(\d+)", density_out)
        props["density"] = m.group(1) if m else None
    except subprocess.TimeoutExpired:
        props["density"] = None
    return props


def health_check(serial: str) -> Dict[str, object]:
    """Section 36: gate execution on device health. Never returns "healthy" on a guess."""
    checks: Dict[str, object] = {}
    devices = {d["serial"]: d for d in list_adb_devices()}
    dev = devices.get(serial)
    checks["adb_connected"] = dev is not None and dev.get("state") == "device"
    if not checks["adb_connected"]:
        checks["reason"] = f"Device '{serial}' not connected or not in 'device' state (adb state: {dev.get('state') if dev else 'absent'})."
        return {"healthy": False, "checks": checks}

    boot_completed = _getprop(serial, "sys.boot_completed")
    checks["boot_completed"] = boot_completed == "1"

    try:
        pm_out = _adb(["shell", "pm", "path", "android"], serial=serial, timeout=10)
        checks["package_manager_responsive"] = pm_out.returncode == 0
    except subprocess.TimeoutExpired:
        checks["package_manager_responsive"] = False

    try:
        df_out = _adb(["shell", "df", "/data"], serial=serial, timeout=10).stdout
        checks["storage_available"] = "/data" in df_out or len(df_out.strip()) > 0
    except subprocess.TimeoutExpired:
        checks["storage_available"] = False

    healthy = all([
        checks["adb_connected"],
        checks["boot_completed"],
        checks["package_manager_responsive"],
        checks["storage_available"],
    ])
    return {"healthy": healthy, "checks": checks}


def sync_devices(db: Session) -> List[MobileDevice]:
    """Discover connected devices and upsert MobileDevice rows. Offline rows that
    are no longer reported by adb are marked OFFLINE rather than deleted (evidence
    linkage on past executions must survive)."""
    discovered = list_adb_devices()
    seen_serials = set()
    result: List[MobileDevice] = []

    for d in discovered:
        if d.get("state") != "device":
            continue
        serial = d["serial"]
        seen_serials.add(serial)
        props = get_device_properties(serial)
        row = db.query(MobileDevice).filter(MobileDevice.serial == serial).first()
        if row is None:
            row = MobileDevice(serial=serial, status="AVAILABLE")
            db.add(row)
        for k, v in props.items():
            setattr(row, k, v)
        if row.status not in ("RESERVED",):
            row.status = "AVAILABLE"
        result.append(row)

    stale = db.query(MobileDevice).filter(
        MobileDevice.serial.notin_(seen_serials) if seen_serials else True
    ).all()
    for row in stale:
        if row.status != "RESERVED":
            row.status = "OFFLINE"

    db.commit()
    for row in result:
        db.refresh(row)
    return result


def reserve_device(db: Session, device_id: int, execution_uid: str) -> MobileDevice:
    device = db.query(MobileDevice).filter(MobileDevice.id == device_id).with_for_update(nowait=False).first()
    if device is None:
        raise DeviceUnavailableError(f"Device {device_id} not found.")
    if device.status == "RESERVED" and device.reserved_by_execution != execution_uid:
        raise DeviceUnavailableError(f"Device {device.serial} is already reserved by another execution.")
    device.status = "RESERVED"
    device.reserved_by_execution = execution_uid
    db.commit()
    db.refresh(device)
    return device


def release_device(db: Session, device_id: int) -> None:
    device = db.query(MobileDevice).filter(MobileDevice.id == device_id).first()
    if device is None:
        return
    device.status = "AVAILABLE"
    device.reserved_by_execution = None
    db.commit()
