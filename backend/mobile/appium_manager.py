"""
AppiumManager — starts/stops Appium 2 (UiAutomator2 driver) on demand and
creates/tears down WebDriver sessions. Appium is never left running when it
isn't needed (rule 38, 105): start on demand, quit session, stop server.

An externally-managed Appium server can be used instead by setting
APPIUM_HOST / APPIUM_START_ON_DEMAND=false in the environment.
"""
from __future__ import annotations

import datetime
import os
import shutil
import socket
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import httpx

from utils.logger import get_logger

logger = get_logger("mobile.appium_manager")

APPIUM_BIN = os.environ.get("APPIUM_BIN") or shutil.which("appium.cmd") or shutil.which("appium") or "appium"
APPIUM_START_ON_DEMAND = os.environ.get("APPIUM_START_ON_DEMAND", "true").lower() != "false"
EXTERNAL_APPIUM_HOST = os.environ.get("APPIUM_HOST")  # e.g. http://127.0.0.1:4723 — used if set
PORT_RANGE = (4723, 4823)

LOG_DIR = Path(__file__).resolve().parent.parent / "storage" / "mobile" / "appium_logs"

# Parallel compatibility runs start several Appium servers concurrently from
# this same process. A plain "is anything listening on this port" TCP probe
# is racy: two threads can both see a port as free and both spawn a server
# there before either one actually binds it. Tracking claimed-but-not-yet-
# bound ports under a lock closes that race for the case that actually
# matters here — concurrent start_server() calls within this process.
_port_lock = threading.Lock()
_claimed_ports: set[int] = set()


def _free_port() -> int:
    start, end = PORT_RANGE
    with _port_lock:
        for port in range(start, end):
            if port in _claimed_ports:
                continue
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.settimeout(0.2)
                if s.connect_ex(("127.0.0.1", port)) != 0:
                    _claimed_ports.add(port)
                    return port
    raise RuntimeError("No free port available for Appium server in configured range.")


def _release_port(port: int) -> None:
    with _port_lock:
        _claimed_ports.discard(port)


@dataclass
class AppiumServerHandle:
    base_url: str
    port: int
    process: Optional[subprocess.Popen]
    owned: bool  # True if we started it and must stop it ourselves
    log_path: Optional[Path] = None  # None for an externally-managed server — nothing to capture


def _drain_to_file(process: subprocess.Popen, log_path: Path) -> None:
    """Continuously read the server's stdout/stderr into a file.

    Two reasons this has to run for the whole life of the process, not just
    read-on-demand at failure time: (1) `stdout=PIPE` has a bounded OS buffer
    — nothing was draining it during normal operation before this, so a
    long-running test could fill it and deadlock the Appium process; (2) it's
    what makes the server's log linkable to an execution afterward instead of
    only being visible when the process crashes."""
    try:
        with open(log_path, "w", encoding="utf-8", errors="replace") as f:
            for line in process.stdout:
                f.write(line)
                f.flush()
    except Exception:
        pass  # process died / handle closed — nothing more to drain


def start_server(timeout_s: int = 120, attempts: int = 3) -> AppiumServerHandle:
    """Appium's first boot after a cold machine / right after a previous
    server was killed can take well over the old 45s ceiling, and a single
    slow boot should never be able to fail a whole suite. Retry a couple of
    times with a generous per-attempt timeout before giving up."""
    if EXTERNAL_APPIUM_HOST:
        return AppiumServerHandle(base_url=EXTERNAL_APPIUM_HOST.rstrip("/"), port=0, process=None, owned=False)

    if not APPIUM_START_ON_DEMAND:
        raise RuntimeError("APPIUM_START_ON_DEMAND=false but no APPIUM_HOST configured.")

    last_exc: Optional[Exception] = None
    for attempt in range(1, attempts + 1):
        try:
            return _start_server_once(timeout_s)
        except Exception as exc:
            last_exc = exc
            logger.warning("Appium server start attempt %d/%d failed: %s", attempt, attempts, exc)
            time.sleep(3)
    raise RuntimeError(f"Appium server failed to start after {attempts} attempts: {last_exc}")


def _start_server_once(timeout_s: int) -> AppiumServerHandle:
    port = _free_port()
    cmd = [APPIUM_BIN, "--address", "127.0.0.1", "--port", str(port), "--base-path", "/",
           "--log-level", "info", "--log-no-colors"]
    logger.info("Starting Appium server on port %d", port)

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.datetime.utcnow().strftime("%Y%m%d%H%M%S%f")
    log_path = LOG_DIR / f"appium_{port}_{ts}.log"

    # APPIUM_BIN is a Windows .cmd shim (a batch file) — since Python 3.8 it
    # can be launched directly, but ONLY reliably via the shell on Windows.
    # Spawning the .cmd through cmd.exe (shell=True) is what actually produced
    # output/started up consistently here; a bare Popen of the .cmd with a
    # redirected stdout intermittently spawned a process that wrote nothing
    # and never became ready.
    use_shell = os.name == "nt" and str(APPIUM_BIN).lower().endswith((".cmd", ".bat"))
    popen_cmd = subprocess.list2cmdline(cmd) if use_shell else cmd
    process = subprocess.Popen(
        popen_cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        shell=use_shell,
        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
    )

    drain_thread = threading.Thread(target=_drain_to_file, args=(process, log_path), daemon=True)
    drain_thread.start()

    base_url = f"http://127.0.0.1:{port}"
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if process.poll() is not None:
            _kill_process_tree(process)
            _release_port(port)
            drain_thread.join(timeout=2)
            tail = log_path.read_text(encoding="utf-8", errors="replace")[-2000:] if log_path.exists() else ""
            raise RuntimeError(f"Appium server process exited early (code {process.returncode}): {tail}")
        try:
            resp = httpx.get(f"{base_url}/status", timeout=2.0)
            if resp.status_code == 200:
                logger.info("Appium server ready at %s", base_url)
                return AppiumServerHandle(base_url=base_url, port=port, process=process, owned=True, log_path=log_path)
        except httpx.HTTPError:
            pass
        time.sleep(0.5)

    _kill_process_tree(process)
    _release_port(port)
    raise RuntimeError(f"Appium server did not become ready within {timeout_s}s on port {port}.")


def _kill_process_tree(process: subprocess.Popen) -> None:
    """appium.cmd is a wrapper batch script whose real work happens in a
    child node.exe — Popen.terminate()/kill() only kills the wrapper on
    Windows, leaving the actual server process (and the port it holds)
    orphaned. Kill the whole tree explicitly instead (rule 25/96 — no
    orphaned processes), on every exit path: clean stop AND startup failure."""
    if os.name == "nt":
        try:
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(process.pid)],
                capture_output=True, timeout=10,
            )
        except Exception as exc:
            logger.warning("taskkill failed for Appium process tree (pid %s): %s", process.pid, exc)
        return

    try:
        process.terminate()
        process.wait(timeout=10)
    except Exception:
        try:
            process.kill()
        except Exception:
            pass


def stop_server(handle: AppiumServerHandle) -> None:
    if not handle.owned or handle.process is None:
        return
    logger.info("Stopping Appium server on port %d", handle.port)
    _kill_process_tree(handle.process)
    _release_port(handle.port)


def create_uiautomator2_session(
    appium_base_url: str,
    device_serial: str,
    app_path: Optional[str] = None,
    app_package: Optional[str] = None,
    app_activity: Optional[str] = None,
    no_reset: bool = False,
    new_command_timeout: int = 120,
):
    """Returns an Appium-Python-Client `webdriver.Remote` driver instance."""
    from appium import webdriver
    from appium.options.android import UiAutomator2Options

    options = UiAutomator2Options()
    options.platform_name = "Android"
    options.automation_name = "UiAutomator2"
    options.udid = device_serial
    options.new_command_timeout = new_command_timeout
    options.no_reset = no_reset
    options.auto_grant_permissions = True
    # Slow / loaded emulators routinely blow past UiAutomator2's default 30s
    # instrumentation-launch ceiling ("The instrumentation process cannot be
    # initialized within 30000ms"), which then fails the whole session. Give
    # the on-device server generous time to install and come up — this only
    # affects how long we *wait*, not steady-state speed.
    options.set_capability("appium:uiautomator2ServerLaunchTimeout", 90000)
    options.set_capability("appium:uiautomator2ServerInstallTimeout", 120000)
    options.set_capability("appium:uiautomator2ServerReadTimeout", 60000)
    options.set_capability("appium:adbExecTimeout", 60000)
    options.set_capability("appium:androidInstallTimeout", 120000)
    if app_path:
        options.app = app_path
    if app_package:
        options.app_package = app_package
    if app_activity:
        options.app_activity = app_activity

    # The UiAutomator2 server on the device occasionally fails the first
    # `POST /session` (stale instrumentation from a previous run, a slow cold
    # emulator, "Session ID is not set") and then succeeds on a clean retry.
    # One bad session create should not be able to fail a whole 124-test
    # suite, so retry a couple of times before surfacing the error.
    last_exc: Optional[Exception] = None
    for attempt in range(1, 4):
        try:
            return webdriver.Remote(appium_base_url, options=options)
        except Exception as exc:
            last_exc = exc
            logger.warning("UiAutomator2 session create attempt %d/3 failed: %s", attempt, str(exc)[:300])
            time.sleep(5)
    raise RuntimeError(f"UiAutomator2 session could not be created after 3 attempts: {last_exc}")


def create_xcuitest_session(
    appium_base_url: str,
    device_udid: str,
    bundle_id: Optional[str] = None,
    no_reset: bool = False,
    new_command_timeout: int = 120,
):
    """iOS/XCUITest adapter — SHAPE ONLY (integration plan Phase 6).

    This builds valid XCUITestOptions capabilities and would create a real
    Appium session against a Mac host running Xcode + the XCUITest driver —
    but nothing in this codebase has been exercised against real iOS
    hardware or a simulator, because no macOS host exists in this
    environment (XCUITest execution is only possible from a Mac). This
    matches exactly what the mobile sprint plan asked for at this stage:
    "adapter + simulator path... real device validation after hardware
    availability." A successful call here proves the capability shape is
    correct, not that iOS execution works end-to-end — that still needs a
    real Mac-hosted Appium server to point `appium_base_url` at.

    Real-device signing (xcodeOrgId/xcodeSigningId) is deliberately left
    unset — it only makes sense once real Apple Developer credentials exist
    to configure it with, and guessing a value would be worse than omitting
    it.
    """
    from appium import webdriver
    from appium.options.ios import XCUITestOptions

    options = XCUITestOptions()
    options.platform_name = "iOS"
    options.automation_name = "XCUITest"
    options.udid = device_udid
    options.new_command_timeout = new_command_timeout
    options.no_reset = no_reset
    if bundle_id:
        options.bundle_id = bundle_id

    last_exc: Optional[Exception] = None
    for attempt in range(1, 4):
        try:
            return webdriver.Remote(appium_base_url, options=options)
        except Exception as exc:
            last_exc = exc
            logger.warning("XCUITest session create attempt %d/3 failed: %s", attempt, str(exc)[:300])
            time.sleep(5)
    raise RuntimeError(f"XCUITest session could not be created after 3 attempts: {last_exc}")


def create_session(
    platform: Optional[str],
    appium_base_url: str,
    device_serial: str,
    app_path: Optional[str] = None,
    app_package: Optional[str] = None,
    app_activity: Optional[str] = None,
    no_reset: bool = False,
    new_command_timeout: int = 120,
):
    """Platform dispatcher: Android (UiAutomator2) is the proven, real path
    this whole engine has run on all along; iOS (XCUITest) is the adapter
    shape described in create_xcuitest_session's docstring above. `platform`
    is expected to be MobileApplication.platform ("android" | "ios"), which
    already exists as a column with an "android" default — every existing
    caller that doesn't pass a platform, or passes "android", is completely
    unaffected by this function existing."""
    if (platform or "android").strip().lower() == "ios":
        return create_xcuitest_session(
            appium_base_url, device_serial, bundle_id=app_package,
            no_reset=no_reset, new_command_timeout=new_command_timeout,
        )
    return create_uiautomator2_session(
        appium_base_url, device_serial, app_path=app_path, app_package=app_package,
        app_activity=app_activity, no_reset=no_reset, new_command_timeout=new_command_timeout,
    )


def quit_session(driver) -> None:
    if driver is None:
        return
    try:
        driver.quit()
    except Exception as exc:
        logger.warning("Error quitting Appium session (continuing cleanup): %s", exc)
