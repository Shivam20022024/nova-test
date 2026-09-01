"""
Uploads mobile evidence to Supabase Storage.

Why this exists: the engine was built standalone and writes every artifact —
screenshots, hierarchy dumps, recordings, Appium logs — to local disk, serving
them back as repo-relative `/storage/mobile/...` paths. That was fine as its own
product. Inside this platform it is not: the rest of the system already keeps
web/API artifacts in Supabase Storage buckets, and a container restart or a
second backend instance loses anything that only exists on one machine's disk.

Design constraints this follows:

  * Local disk stays the source of truth during a run. The engine reads files
    back mid-run (video stitching, hierarchy re-parsing for AI grounding), so
    uploading INSTEAD of writing would break those paths.
  * Upload failure is never fatal. A run that produced real results must not be
    failed because object storage was briefly unavailable — the caller keeps the
    local path and the evidence is still there.
  * Uses httpx, already a dependency, against Supabase's Storage REST API rather
    than adding supabase-py for four calls.
"""
from __future__ import annotations

import os
from typing import Optional

import httpx

from utils.logger import get_logger

logger = get_logger("mobile.artifact_store")

BUCKET = os.environ.get("MOBILE_EVIDENCE_BUCKET", "mobile-evidence")
_TIMEOUT = httpx.Timeout(30.0, connect=10.0)


def is_enabled() -> bool:
    """Off unless Supabase is configured. Unset credentials mean local-only
    behaviour identical to before this module existed."""
    return bool(os.environ.get("SUPABASE_URL") and os.environ.get("SUPABASE_SERVICE_ROLE_KEY"))


def _base() -> tuple[str, str]:
    return os.environ["SUPABASE_URL"].rstrip("/"), os.environ["SUPABASE_SERVICE_ROLE_KEY"]


def public_url(key: str) -> str:
    url, _ = _base()
    return f"{url}/storage/v1/object/public/{BUCKET}/{key}"


def upload(key: str, data: bytes, content_type: str) -> Optional[str]:
    """Store `data` at `key` and return its public URL, or None on any failure.

    Returning None rather than raising is the whole contract: every caller is in
    the middle of recording what happened during a test, and losing the upload
    must not also lose the observation.
    """
    if not is_enabled():
        return None

    url, service_key = _base()
    endpoint = f"{url}/storage/v1/object/{BUCKET}/{key}"
    headers = {
        "Authorization": f"Bearer {service_key}",
        "apikey": service_key,
        "Content-Type": content_type,
        # Artifacts are immutable and keyed by execution + timestamp, so a
        # collision means a retry of the same upload — overwrite rather than 409.
        "x-upsert": "true",
        "cache-control": "public, max-age=31536000, immutable",
    }

    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            response = client.post(endpoint, content=data, headers=headers)
            if response.status_code in (200, 201):
                return public_url(key)
            if response.status_code == 404:
                # Bucket missing. Create it once, then retry — this is the
                # first-run path on a fresh Supabase project.
                if _ensure_bucket(client, url, service_key):
                    retry = client.post(endpoint, content=data, headers=headers)
                    if retry.status_code in (200, 201):
                        return public_url(key)
                    logger.warning("Evidence upload retry failed (%s): %s", retry.status_code, retry.text[:200])
                    return None
            logger.warning("Evidence upload failed (%s): %s", response.status_code, response.text[:200])
            return None
    except Exception as exc:  # noqa: BLE001 — never propagate into a run
        logger.warning("Evidence upload error for %s: %s", key, exc)
        return None


def _ensure_bucket(client: httpx.Client, url: str, service_key: str) -> bool:
    """Create the evidence bucket, public-read like the platform's existing
    screenshot/video buckets so <img>/<video> can load an artifact directly."""
    try:
        response = client.post(
            f"{url}/storage/v1/bucket",
            json={"id": BUCKET, "name": BUCKET, "public": True},
            headers={"Authorization": f"Bearer {service_key}", "apikey": service_key},
        )
        if response.status_code in (200, 201):
            logger.info("Created evidence bucket '%s'.", BUCKET)
            return True
        # 409 = someone else created it between our 404 and this call.
        if response.status_code == 409:
            return True
        logger.warning("Could not create bucket '%s' (%s): %s", BUCKET, response.status_code, response.text[:200])
        return False
    except Exception as exc:  # noqa: BLE001
        logger.warning("Bucket creation error: %s", exc)
        return False
