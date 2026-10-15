"""Catalogue PDFs replaced from the dashboard.

The four official PDFs ship inside the app image (``static/catalogues``). A file saved there
would disappear on the next deploy, so a replacement is kept on the persistent volume (next to
the email attachments) under the SAME file name. ``modules.catalogues`` looks here first, so the
catalogue id, title, download link and everything that sends it (email, WhatsApp, the AI agent)
keep working and simply pick up the new file.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# A compressed catalogue should be far smaller than this; it is only a safety cap.
MAX_UPLOAD_BYTES = 60 * 1024 * 1024


def custom_catalogues_dir() -> Path:
    override = (os.environ.get("CATALOGUES_DIR") or "").strip()
    if override:
        return Path(override)
    from modules.email_attachments import STORAGE_DIR

    # /data/email_attachments -> /data/catalogues (the Railway volume)
    return STORAGE_DIR.parent / "catalogues"


def custom_file(filename: str) -> Path | None:
    """The uploaded replacement for a bundled catalogue file name, if there is one."""
    if not filename or Path(filename).name != filename:
        return None
    candidate = custom_catalogues_dir() / filename
    return candidate if candidate.is_file() else None


def custom_info(filename: str) -> dict[str, Any]:
    path = custom_file(filename)
    if path is None:
        return {"custom": False, "updated_at": None}
    return {
        "custom": True,
        "updated_at": datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat(),
    }


def find_catalogue_def(cat_id: str) -> dict[str, Any]:
    from modules.catalogues import CATALOGUES_DEF

    matched = next((c for c in CATALOGUES_DEF if c["id"] == cat_id), None)
    if not matched:
        raise ValueError(f"Catalogue not found: {cat_id}")
    return matched


def install_custom_catalogue(cat_id: str, tmp_path: Path) -> dict[str, Any]:
    """Atomically make an already-validated PDF the live file for this catalogue."""
    meta = find_catalogue_def(cat_id)
    target_dir = custom_catalogues_dir()
    target_dir.mkdir(parents=True, exist_ok=True)
    os.replace(tmp_path, target_dir / meta["filename"])
    return meta


def remove_custom_catalogue(cat_id: str) -> bool:
    """Go back to the bundled original. ``False`` when there was no replacement."""
    meta = find_catalogue_def(cat_id)
    path = custom_file(meta["filename"])
    if path is None:
        return False
    path.unlink()
    return True


def sandbox_catalogues_dir(user_id: int) -> Path:
    return custom_catalogues_dir() / "sandbox" / str(int(user_id))


def sandbox_file(user_id: int, filename: str) -> Path | None:
    if not filename or Path(filename).name != filename:
        return None
    candidate = sandbox_catalogues_dir(user_id) / filename
    return candidate if candidate.is_file() else None


def list_sandbox_catalogue_slots(user_id: int) -> list[dict[str, Any]]:
    """Catalogue cards for a sandbox user. Company PDFs are not included."""
    from modules.catalogues import CATALOGUES_DEF

    results: list[dict[str, Any]] = []
    for item in CATALOGUES_DEF:
        path = sandbox_file(user_id, item["filename"])
        size_bytes = path.stat().st_size if path is not None else 0
        results.append(
            {
                "custom": path is not None,
                "updated_at": (
                    datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat()
                    if path is not None
                    else None
                ),
                "id": item["id"],
                "title": item["title"],
                "category": item["category"],
                "description": item["description"],
                "filename": item["filename"],
                "badge": item["badge"],
                "color": item["color"],
                "size": size_bytes,
                "exists": path is not None,
                "download_url": f"/api/catalogues/{item['id']}/download",
            }
        )
    return results


def install_sandbox_catalogue(user_id: int, cat_id: str, tmp_path: Path) -> dict[str, Any]:
    meta = find_catalogue_def(cat_id)
    target_dir = sandbox_catalogues_dir(user_id)
    target_dir.mkdir(parents=True, exist_ok=True)
    os.replace(tmp_path, target_dir / meta["filename"])
    return meta


def remove_sandbox_catalogue(user_id: int, cat_id: str) -> bool:
    meta = find_catalogue_def(cat_id)
    path = sandbox_file(user_id, meta["filename"])
    if path is None:
        return False
    path.unlink()
    return True
