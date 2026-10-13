"""Shared mailer picture library — groups of hosted images for compose/bulk.

Metadata lives in Postgres (mailer_picture_library_state) so every browser /
incognito session sees the same library. Image bytes use email attachment
storage (prefer Railway /data volume). Save / publish materializes data-URL
fallbacks into hosted URLs.
"""

from __future__ import annotations

import base64
import json
import re
import threading
import uuid
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy.orm import attributes

from db.models import MailerPictureLibraryState
from db.session import SessionLocal

_DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "mailer_picture_library.json"
_LOCK = threading.RLock()
_STATE_ID = 1
_LEGACY_SEEDED = False


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _slug(raw: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", (raw or "").strip().lower()).strip("_")
    return (s or "group")[:48]


def _default() -> dict[str, Any]:
    return {"groups": []}


def _normalize_groups(groups_raw: Any) -> list[dict[str, Any]]:
    groups: list[dict[str, Any]] = []
    if not isinstance(groups_raw, list):
        return groups
    for g in groups_raw:
        if not isinstance(g, dict):
            continue
        gid = str(g.get("id") or "").strip() or str(uuid.uuid4())
        images: list[dict[str, Any]] = []
        for img in g.get("images") or []:
            if not isinstance(img, dict):
                continue
            mid = str(img.get("id") or "").strip()
            url = str(img.get("url") or "").strip()
            if not mid or not url:
                continue
            images.append(
                {
                    "id": mid,
                    "url": url,
                    "filename": str(img.get("filename") or f"{mid}.png"),
                    "content_type": str(img.get("content_type") or "image/png"),
                    "size": int(img.get("size") or 0),
                    "caption": str(img.get("caption") or ""),
                    "uploaded_by": str(img.get("uploaded_by") or ""),
                    "created_at": str(img.get("created_at") or ""),
                }
            )
        groups.append(
            {
                "id": gid,
                "name": str(g.get("name") or gid).strip() or gid,
                "created_at": str(g.get("created_at") or ""),
                "created_by": str(g.get("created_by") or ""),
                "images": images,
            }
        )
    return groups


def _read_legacy_file() -> dict[str, Any]:
    try:
        if not _DATA_PATH.exists():
            return _default()
        raw = json.loads(_DATA_PATH.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return _default()
        return {"groups": _normalize_groups(raw.get("groups"))}
    except (OSError, json.JSONDecodeError):
        return _default()


def ensure_state_table() -> None:
    """Create singleton row if migration has not run yet."""
    db = SessionLocal()
    try:
        MailerPictureLibraryState.__table__.create(bind=db.get_bind(), checkfirst=True)
        if db.get(MailerPictureLibraryState, _STATE_ID) is None:
            db.add(
                MailerPictureLibraryState(
                    id=_STATE_ID,
                    groups=[],
                    updated_at=datetime.now(timezone.utc),
                )
            )
            db.commit()
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        print(f"Mailer picture library table ensure failed: {exc}", flush=True)
    finally:
        db.close()


def _load() -> dict[str, Any]:
    global _LEGACY_SEEDED
    ensure_state_table()
    db = SessionLocal()
    try:
        row = db.get(MailerPictureLibraryState, _STATE_ID)
        if row is None:
            legacy = _read_legacy_file()
            row = MailerPictureLibraryState(
                id=_STATE_ID,
                groups=legacy.get("groups") or [],
                updated_at=datetime.now(timezone.utc),
            )
            db.add(row)
            db.commit()
            db.refresh(row)
            return {"groups": _normalize_groups(row.groups)}

        groups = _normalize_groups(row.groups)
        # One-time seed from old JSON file if DB is empty.
        if not groups and not _LEGACY_SEEDED:
            _LEGACY_SEEDED = True
            legacy = _read_legacy_file()
            if legacy.get("groups"):
                row.groups = legacy["groups"]
                row.updated_at = datetime.now(timezone.utc)
                attributes.flag_modified(row, "groups")
                db.commit()
                return {"groups": _normalize_groups(legacy["groups"])}
        return {"groups": groups}
    except Exception as exc:  # noqa: BLE001
        print(f"Mailer picture library DB load failed: {exc}", flush=True)
        return _read_legacy_file()
    finally:
        db.close()


def _save(data: dict[str, Any]) -> None:
    groups = _normalize_groups(data.get("groups"))
    with _LOCK:
        ensure_state_table()
        db = SessionLocal()
        try:
            row = db.get(MailerPictureLibraryState, _STATE_ID)
            if row is None:
                row = MailerPictureLibraryState(
                    id=_STATE_ID,
                    groups=groups,
                    updated_at=datetime.now(timezone.utc),
                )
                db.add(row)
            else:
                row.groups = groups
                row.updated_at = datetime.now(timezone.utc)
                attributes.flag_modified(row, "groups")
            db.commit()
            # Best-effort mirror for local/dev inspection.
            try:
                _DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
                _DATA_PATH.write_text(
                    json.dumps({"groups": groups}, indent=2),
                    encoding="utf-8",
                )
            except OSError:
                pass
        except Exception as exc:  # noqa: BLE001
            db.rollback()
            print(f"Mailer picture library DB save failed: {exc}", flush=True)
            raise
        finally:
            db.close()


def list_library() -> dict[str, Any]:
    data = _load()
    return {"groups": list(data.get("groups") or [])}


def create_group(*, name: str, created_by: str = "") -> dict[str, Any]:
    label = (name or "").strip()
    if not label:
        raise ValueError("Group name is required")
    with _LOCK:
        data = _load()
        groups = list(data.get("groups") or [])
        base = _slug(label)
        gid = base
        n = 2
        existing = {str(g.get("id")) for g in groups}
        while gid in existing:
            gid = f"{base}_{n}"
            n += 1
        row = {
            "id": gid,
            "name": label,
            "created_at": _now(),
            "created_by": (created_by or "").strip(),
            "images": [],
        }
        groups.append(row)
        data["groups"] = groups
        _save(data)
        return row


def rename_group(group_id: str, name: str) -> dict[str, Any]:
    label = (name or "").strip()
    if not label:
        raise ValueError("Group name is required")
    with _LOCK:
        data = _load()
        for g in data.get("groups") or []:
            if g.get("id") == group_id:
                g["name"] = label
                _save(data)
                return g
    raise ValueError("Group not found")


def delete_group(group_id: str) -> None:
    with _LOCK:
        data = _load()
        before = list(data.get("groups") or [])
        after = [g for g in before if g.get("id") != group_id]
        if len(after) == len(before):
            raise ValueError("Group not found")
        data["groups"] = after
        _save(data)


def add_image(
    group_id: str,
    *,
    media_id: str,
    url: str,
    filename: str,
    content_type: str = "image/png",
    size: int = 0,
    uploaded_by: str = "",
    caption: str = "",
) -> dict[str, Any]:
    mid = str(media_id or "").strip()
    href = str(url or "").strip()
    if not mid or not href:
        raise ValueError("Image id and url are required")
    with _LOCK:
        data = _load()
        for g in data.get("groups") or []:
            if g.get("id") != group_id:
                continue
            images = list(g.get("images") or [])
            images = [i for i in images if i.get("id") != mid]
            row = {
                "id": mid,
                "url": href,
                "filename": (filename or f"{mid}.png").strip(),
                "content_type": content_type or "image/png",
                "size": int(size or 0),
                "caption": (caption or "").strip(),
                "uploaded_by": (uploaded_by or "").strip(),
                "created_at": _now(),
            }
            images.append(row)
            g["images"] = images
            _save(data)
            return row
    raise ValueError("Group not found")


def set_image_caption(group_id: str, media_id: str, caption: str) -> dict[str, Any]:
    text = (caption or "").strip()
    with _LOCK:
        data = _load()
        for g in data.get("groups") or []:
            if g.get("id") != group_id:
                continue
            for img in g.get("images") or []:
                if img.get("id") != media_id:
                    continue
                img["caption"] = text
                _save(data)
                return img
    raise ValueError("Image not found")


def delete_image(group_id: str, media_id: str) -> None:
    with _LOCK:
        data = _load()
        for g in data.get("groups") or []:
            if g.get("id") != group_id:
                continue
            before = list(g.get("images") or [])
            after = [i for i in before if i.get("id") != media_id]
            if len(after) == len(before):
                raise ValueError("Image not found")
            g["images"] = after
            _save(data)
            return
    raise ValueError("Group not found")


_DATA_URL_RE = re.compile(
    r"^data:(?P<ctype>[^;]+);base64,(?P<b64>.+)$",
    re.IGNORECASE | re.DOTALL,
)


def _materialize_data_url(
    url: str,
    *,
    filename: str,
    content_type: str,
) -> dict[str, Any]:
    """Turn a data: URL into a hosted attachment; return image meta fields."""
    from modules import email_tracking
    from modules.email_attachments import register_attachment_from_bytes

    match = _DATA_URL_RE.match((url or "").strip())
    if not match:
        raise ValueError("Not a data URL")
    ctype = (match.group("ctype") or content_type or "image/png").split(";")[0].strip().lower()
    if not ctype.startswith("image/"):
        raise ValueError("Only image data URLs are allowed")
    try:
        raw = base64.b64decode(match.group("b64"), validate=False)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("Invalid image data") from exc
    if not raw:
        raise ValueError("Empty image data")
    if len(raw) > 8 * 1024 * 1024:
        raise ValueError("Image exceeds 8 MB")

    base = email_tracking.public_api_base()
    if not base:
        raise ValueError("PUBLIC_API_BASE_URL is not configured — cannot host library images.")

    meta = register_attachment_from_bytes(
        raw,
        filename=filename or "picture.png",
        content_type=ctype,
    )
    return {
        "id": str(meta["id"]),
        "url": f"{base}/api/mailer/inline-media/{meta['id']}",
        "filename": str(meta["filename"]),
        "content_type": ctype,
        "size": int(meta["size"]),
    }


def replace_library(
    groups_in: list[dict[str, Any]] | None,
    *,
    uploaded_by: str = "",
) -> dict[str, Any]:
    """Replace the shared library. Materializes any data: URLs into hosted files."""
    with _LOCK:
        incoming = _normalize_groups(groups_in or [])
        out_groups: list[dict[str, Any]] = []
        for g in incoming:
            images_out: list[dict[str, Any]] = []
            for img in g.get("images") or []:
                url = str(img.get("url") or "").strip()
                caption = str(img.get("caption") or "")
                if url.lower().startswith("data:"):
                    hosted = _materialize_data_url(
                        url,
                        filename=str(img.get("filename") or "picture.png"),
                        content_type=str(img.get("content_type") or "image/png"),
                    )
                    images_out.append(
                        {
                            **hosted,
                            "caption": caption,
                            "uploaded_by": (uploaded_by or img.get("uploaded_by") or "").strip(),
                            "created_at": str(img.get("created_at") or _now()),
                        }
                    )
                else:
                    images_out.append(
                        {
                            "id": str(img.get("id")),
                            "url": url,
                            "filename": str(img.get("filename") or "picture.png"),
                            "content_type": str(img.get("content_type") or "image/png"),
                            "size": int(img.get("size") or 0),
                            "caption": caption,
                            "uploaded_by": str(img.get("uploaded_by") or uploaded_by or ""),
                            "created_at": str(img.get("created_at") or ""),
                        }
                    )
            out_groups.append(
                {
                    "id": str(g.get("id")),
                    "name": str(g.get("name") or g.get("id")),
                    "created_at": str(g.get("created_at") or _now()),
                    "created_by": str(g.get("created_by") or uploaded_by or ""),
                    "images": images_out,
                }
            )
        payload = {"groups": out_groups}
        _save(payload)
        return payload
