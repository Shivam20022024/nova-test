from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

from playwright.async_api import Page

_BASE_DIR = Path(__file__).resolve().parent.parent
ARTIFACTS_DIR = _BASE_DIR / "storage" / "artifacts"
ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)


def _safe_name(value: str) -> str:
    safe = "".join(c if c.isalnum() or c in "-_." else "_" for c in (value or "").strip())
    return safe or "unknown"


def artifact_dir(suite_id: Optional[str], test_name: Optional[str]) -> Path:
    suite = _safe_name(suite_id or "standalone")
    test = _safe_name(test_name or "test_case")
    target = ARTIFACTS_DIR / suite / test
    target.mkdir(parents=True, exist_ok=True)
    return target


def artifact_path(suite_id: Optional[str], test_name: Optional[str], filename: str) -> Path:
    target = artifact_dir(suite_id, test_name)
    return target / _safe_name(filename)


def to_storage_url(path: Path) -> Optional[str]:
    try:
        rel = path.relative_to(_BASE_DIR).as_posix()
        return f"/{rel}"
    except Exception:
        return None


async def save_page_html(page: Page, suite_id: Optional[str], test_name: Optional[str], filename: str) -> Optional[str]:
    try:
        html = await page.content()
        path = artifact_path(suite_id, test_name, filename)
        path.write_text(html, encoding="utf-8")
        return to_storage_url(path) or str(path)
    except Exception:
        return None


async def save_dom_snapshot(page: Page, suite_id: Optional[str], test_name: Optional[str], filename: str) -> Optional[str]:
    script = """
    () => Array.from(document.querySelectorAll('input,button,select,textarea,a,[role],[aria-label],[data-testid]'))
      .slice(0, 150)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        name: el.getAttribute('name'),
        role: el.getAttribute('role'),
        text: (el.innerText || el.textContent || '').trim().slice(0, 120),
        placeholder: el.getAttribute('placeholder'),
        ariaLabel: el.getAttribute('aria-label'),
        dataTestId: el.getAttribute('data-testid'),
        type: el.getAttribute('type'),
        href: el.getAttribute('href')
      }));
    """
    try:
        data: Any = await page.evaluate(script)
        path = artifact_path(suite_id, test_name, filename)
        path.write_text(json.dumps(data, indent=2), encoding="utf-8")
        return to_storage_url(path) or str(path)
    except Exception:
        return None


def save_json_artifact(data: Any, suite_id: Optional[str], test_name: Optional[str], filename: str) -> Optional[str]:
    try:
        path = artifact_path(suite_id, test_name, filename)
        path.write_text(json.dumps(data, indent=2), encoding="utf-8")
        return to_storage_url(path) or str(path)
    except Exception:
        return None
