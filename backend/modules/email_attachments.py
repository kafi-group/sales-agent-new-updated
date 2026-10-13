"""Upload, store, and load email attachments for outbound Outlook sends."""

from __future__ import annotations

import os
import re
import uuid
from pathlib import Path

from fastapi import UploadFile

_BACKEND_DIR = Path(__file__).resolve().parent.parent


def _resolve_storage_dir() -> Path:
    """Prefer a persistent mount (Railway volume) over ephemeral container disk.

    Set EMAIL_ATTACHMENTS_DIR=/data/email_attachments when a volume is mounted
    at /data so inline template images survive redeploys.
    """
    override = (os.environ.get("EMAIL_ATTACHMENTS_DIR") or "").strip()
    if override:
        return Path(override)
    # Auto-detect common Railway volume mount without requiring env.
    for candidate in (Path("/data/email_attachments"), Path("/data/storage/email_attachments")):
        parent = candidate.parent
        if parent.is_dir() and os.access(parent, os.W_OK):
            return candidate
    return _BACKEND_DIR / "storage" / "email_attachments"


STORAGE_DIR = _resolve_storage_dir()

MAX_FILE_BYTES = 10 * 1024 * 1024  # ~13 MB on the wire; safer vs spam (554) + size (552)
MAX_FILES_PER_EMAIL = 8

# Block malware-prone types; allow other business files (PDF, Office, ZIP, images, …).
BLOCKED_EXTENSIONS = {
    ".exe",
    ".msi",
    ".msp",
    ".bat",
    ".cmd",
    ".com",
    ".scr",
    ".dll",
    ".sys",
    ".ps1",
    ".psd1",
    ".psm1",
    ".vbs",
    ".vbe",
    ".js",
    ".jse",
    ".wsf",
    ".wsh",
    ".hta",
    ".cpl",
    ".msc",
    ".jar",
    ".apk",
    ".dmg",
    ".app",
    ".deb",
    ".rpm",
    ".sh",
    ".bash",
    ".zsh",
    ".reg",
    ".inf",
    ".lnk",
    ".iso",
    ".img",
}

_EXTENSION_TO_TYPE = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".rtf": "application/rtf",
    ".odt": "application/vnd.oasis.opendocument.text",
    ".ods": "application/vnd.oasis.opendocument.spreadsheet",
    ".odp": "application/vnd.oasis.opendocument.presentation",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".json": "application/json",
    ".xml": "application/xml",
    ".zip": "application/zip",
    ".rar": "application/vnd.rar",
    ".7z": "application/x-7z-compressed",
    ".gz": "application/gzip",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".eml": "message/rfc822",
    ".msg": "application/vnd.ms-outlook",
}


def _sanitize_filename(name: str) -> str:
    base = Path(name).name
    cleaned = re.sub(r"[^\w.\- ]+", "_", base).strip(" .")
    return cleaned or "attachment"


def _guess_content_type(filename: str, content_type: str | None) -> str:
    ext = Path(filename).suffix.lower()
    if ext in _EXTENSION_TO_TYPE:
        return _EXTENSION_TO_TYPE[ext]
    if content_type and content_type.strip() and content_type != "application/octet-stream":
        return content_type.split(";")[0].strip().lower()
    return "application/octet-stream"


def _assert_attachment_allowed(filename: str, content_type: str | None = None) -> str:
    """Reject executables/scripts; return a safe content type for everything else."""
    clean = _sanitize_filename(filename)
    ext = Path(clean).suffix.lower()
    if ext in BLOCKED_EXTENSIONS:
        raise ValueError(
            f"File type not allowed for '{clean}'. "
            "Executables and scripts cannot be emailed — use PDF, Office, ZIP, images, etc."
        )
    # Double-extension tricks: report.evil.exe.pdf still ends with .pdf — OK.
    # report.pdf.exe is blocked via .exe.
    return _guess_content_type(clean, content_type)

def public_attachment(meta: dict) -> dict:
    res = {
        "id": meta["id"],
        "filename": meta["filename"],
        "content_type": meta["content_type"],
        "size": meta["size"],
    }
    if meta.get("storage_path"):
        res["storage_path"] = meta["storage_path"]
    return res


def public_attachments(items: list | None) -> list[dict]:
    if not items:
        return []
    return [public_attachment(item) for item in items if isinstance(item, dict) and item.get("id")]


def whatsapp_send_error(items: list | None) -> str | None:
    """Last Meta Cloud send error stored on the interaction attachments JSON."""
    for item in items or []:
        if not isinstance(item, dict) or item.get("type") != "whatsapp_send":
            continue
        err = item.get("last_send_error")
        if err:
            return str(err)
    return None


def resolve_catalogue_file(identifier: str) -> Path | None:
    if not identifier:
        return None
    try:
        from modules.catalogues import resolve_catalogue_file_path, CATALOGUES_DEF
        clean = identifier.strip().lower()
        for cat in CATALOGUES_DEF:
            if (
                cat["id"].lower() == clean
                or cat["filename"].lower() == clean
                or cat["title"].lower() == clean
            ):
                p = resolve_catalogue_file_path(cat["filename"])
                if p and p.is_file():
                    return p
        return resolve_catalogue_file_path(identifier.strip())
    except Exception:
        return None


async def save_upload(file: UploadFile) -> dict:
    filename = _sanitize_filename(file.filename or "attachment")
    content_type = _assert_attachment_allowed(filename, file.content_type)

    data = await file.read()
    if not data:
        raise ValueError(f"File '{filename}' is empty")
    if len(data) > MAX_FILE_BYTES:
        raise ValueError(
            f"File '{filename}' exceeds {MAX_FILE_BYTES // (1024 * 1024)} MB limit"
        )

    STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    att_id = str(uuid.uuid4())
    storage_name = f"{att_id}_{filename}"
    abs_path = STORAGE_DIR / storage_name
    abs_path.write_bytes(data)

    return {
        "id": att_id,
        "filename": filename,
        "content_type": content_type,
        "size": len(data),
        "storage_path": f"email_attachments/{storage_name}",
    }


# Chunked uploads — stay under Vercel/proxy ~4.5 MB body limits while assembling up to MAX_FILE_BYTES.
CHUNK_UPLOAD_DIR = STORAGE_DIR / "_chunks"
CHUNK_META_SUFFIX = "meta.json"


def init_chunked_upload(
    *,
    filename: str,
    content_type: str | None,
    size: int,
    total_chunks: int,
) -> dict:
    clean_name = _sanitize_filename(filename)
    guessed = _assert_attachment_allowed(clean_name, content_type)
    if size <= 0 or size > MAX_FILE_BYTES:
        raise ValueError(
            f"File '{clean_name}' must be between 1 byte and {MAX_FILE_BYTES // (1024 * 1024)} MB"
        )
    if total_chunks < 1 or total_chunks > 64:
        raise ValueError("Invalid chunk count")

    upload_id = str(uuid.uuid4())
    chunk_dir = CHUNK_UPLOAD_DIR / upload_id
    chunk_dir.mkdir(parents=True, exist_ok=True)
    meta = {
        "upload_id": upload_id,
        "filename": clean_name,
        "content_type": guessed,
        "size": int(size),
        "total_chunks": int(total_chunks),
        "received": [],
    }
    (chunk_dir / CHUNK_META_SUFFIX).write_text(
        __import__("json").dumps(meta), encoding="utf-8"
    )
    return {"upload_id": upload_id, "total_chunks": int(total_chunks)}


async def save_upload_chunk(upload_id: str, index: int, file: UploadFile) -> dict:
    clean_id = (upload_id or "").strip()
    if not clean_id or "/" in clean_id or "\\" in clean_id or ".." in clean_id:
        raise ValueError("Invalid upload id")
    if index < 0 or index > 63:
        raise ValueError("Invalid chunk index")

    chunk_dir = CHUNK_UPLOAD_DIR / clean_id
    meta_path = chunk_dir / CHUNK_META_SUFFIX
    if not meta_path.is_file():
        raise ValueError("Upload session not found or expired — start the upload again")

    import json

    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    total = int(meta.get("total_chunks") or 0)
    if index >= total:
        raise ValueError("Chunk index out of range")

    data = await file.read()
    if not data:
        raise ValueError(f"Chunk {index} is empty")
    # Soft per-chunk ceiling (~3 MB) so each request fits proxy limits.
    if len(data) > 3 * 1024 * 1024 + 64_000:
        raise ValueError("Chunk too large — use smaller chunks")

    (chunk_dir / f"{index:04d}.part").write_bytes(data)
    received = set(meta.get("received") or [])
    received.add(index)
    meta["received"] = sorted(received)
    meta_path.write_text(json.dumps(meta), encoding="utf-8")
    return {"upload_id": clean_id, "index": index, "received": len(received), "total_chunks": total}


def complete_chunked_upload(upload_id: str) -> dict:
    clean_id = (upload_id or "").strip()
    if not clean_id or "/" in clean_id or "\\" in clean_id or ".." in clean_id:
        raise ValueError("Invalid upload id")

    import json
    import shutil

    chunk_dir = CHUNK_UPLOAD_DIR / clean_id
    meta_path = chunk_dir / CHUNK_META_SUFFIX
    if not meta_path.is_file():
        raise ValueError("Upload session not found or expired — start the upload again")

    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    total = int(meta.get("total_chunks") or 0)
    received = set(meta.get("received") or [])
    missing = [i for i in range(total) if i not in received]
    if missing:
        raise ValueError(f"Missing chunks: {missing[:8]}")

    parts: list[bytes] = []
    for i in range(total):
        part_path = chunk_dir / f"{i:04d}.part"
        if not part_path.is_file():
            raise ValueError(f"Missing chunk file {i}")
        parts.append(part_path.read_bytes())
    data = b"".join(parts)
    expected = int(meta.get("size") or 0)
    if expected and abs(len(data) - expected) > 0:
        # Allow slight mismatch only if meta size was approximate; require exact.
        if len(data) != expected:
            raise ValueError(
                f"Assembled size {len(data)} does not match declared size {expected}"
            )
    if len(data) > MAX_FILE_BYTES:
        raise ValueError(
            f"File exceeds {MAX_FILE_BYTES // (1024 * 1024)} MB limit"
        )

    filename = str(meta.get("filename") or "attachment")
    content_type = str(meta.get("content_type") or "application/octet-stream")
    STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    att_id = str(uuid.uuid4())
    storage_name = f"{att_id}_{_sanitize_filename(filename)}"
    abs_path = STORAGE_DIR / storage_name
    abs_path.write_bytes(data)

    try:
        shutil.rmtree(chunk_dir, ignore_errors=True)
    except Exception:
        pass

    return {
        "id": att_id,
        "filename": _sanitize_filename(filename),
        "content_type": content_type,
        "size": len(data),
        "storage_path": f"email_attachments/{storage_name}",
    }


def register_attachment_from_path(
    source_path: Path, filename: str | None = None, content_type: str = "application/pdf"
) -> dict:
    STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    clean_name = _sanitize_filename(filename or source_path.name)
    att_id = str(uuid.uuid4())
    storage_name = f"{att_id}_{clean_name}"
    abs_path = STORAGE_DIR / storage_name
    abs_path.write_bytes(source_path.read_bytes())
    return {
        "id": att_id,
        "filename": clean_name,
        "content_type": content_type,
        "size": source_path.stat().st_size,
        "storage_path": f"email_attachments/{storage_name}",
    }


def register_attachment_from_bytes(
    data: bytes, filename: str, content_type: str = "application/pdf"
) -> dict:
    STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    clean_name = _sanitize_filename(filename)
    att_id = str(uuid.uuid4())
    storage_name = f"{att_id}_{clean_name}"
    abs_path = STORAGE_DIR / storage_name
    abs_path.write_bytes(data)
    return {
        "id": att_id,
        "filename": clean_name,
        "content_type": content_type,
        "size": len(data),
        "storage_path": f"email_attachments/{storage_name}",
    }


def resolve_path(storage_path: str) -> Path:
    if not storage_path:
        return STORAGE_DIR / "nonexistent"
    p = Path(storage_path)
    if p.is_file():
        return p
    rel = storage_path.replace("\\", "/").lstrip("/")
    if rel.startswith("email_attachments/"):
        name = rel.split("/", 1)[1]
        for candidate in (
            STORAGE_DIR / name,
            _BACKEND_DIR / "storage" / rel,
            _BACKEND_DIR / "storage" / name,
        ):
            if candidate.is_file():
                return candidate
        return STORAGE_DIR / name
    cand1 = STORAGE_DIR / rel
    if cand1.is_file():
        return cand1
    return _BACKEND_DIR / "storage" / rel


def find_by_id(att_id: str) -> Path | None:
    """Locate ``{uuid}_filename`` stored under email_attachments."""
    clean = (att_id or "").strip()
    if not clean or "/" in clean or "\\" in clean or ".." in clean:
        return None
    STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    matches = sorted(STORAGE_DIR.glob(f"{clean}_*"))
    for path in matches:
        if path.is_file():
            return path
    return None


def load_bytes(meta: dict) -> tuple[bytes, str, str]:
    storage_path = str(meta.get("storage_path") or "").strip()
    filename = str(meta.get("filename") or "").strip()
    content_type = str(meta.get("content_type") or "application/octet-stream").strip()
    att_id = str(meta.get("id") or "").strip()

    # 1. Try direct path or storage_path if provided
    if storage_path:
        p = Path(storage_path)
        if p.is_file():
            return p.read_bytes(), filename or p.name, content_type or _guess_content_type(p.name, None)
        path = resolve_path(storage_path)
        if path.is_file():
            return path.read_bytes(), filename or path.name, content_type or _guess_content_type(path.name, None)

    # 2. Try lookup by attachment UUID in STORAGE_DIR
    if att_id and STORAGE_DIR.is_dir():
        matches = list(STORAGE_DIR.glob(f"{att_id}_*"))
        if matches and matches[0].is_file():
            path = matches[0]
            return path.read_bytes(), filename or path.name.split("_", 1)[-1], content_type or _guess_content_type(path.name, None)

    # 3. Try lookup in static catalogues
    cat_file = resolve_catalogue_file(filename) or resolve_catalogue_file(att_id)
    if cat_file and cat_file.is_file():
        return cat_file.read_bytes(), filename or cat_file.name, "application/pdf"

    # 4. Try matching direct filename in STORAGE_DIR
    if filename and STORAGE_DIR.is_dir():
        cand = STORAGE_DIR / filename
        if cand.is_file():
            return cand.read_bytes(), filename, content_type or _guess_content_type(filename, None)

    raise FileNotFoundError(f"Attachment file missing: {filename or att_id or 'unknown'}")


def copy_attachments(items: list | None) -> list[dict]:
    """Copy attachment files so each draft owns its files (bulk sends)."""
    if not items:
        return []
    STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    copied: list[dict] = []
    missing: list[str] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        label = str(item.get("filename") or item.get("id") or "attachment")
        if not item.get("storage_path") and not item.get("id"):
            missing.append(label)
            continue
        try:
            data, filename, content_type = load_bytes(item)
        except FileNotFoundError:
            missing.append(label)
            continue
        att_id = str(uuid.uuid4())
        storage_name = f"{att_id}_{_sanitize_filename(filename)}"
        abs_path = STORAGE_DIR / storage_name
        abs_path.write_bytes(data)
        copied.append(
            {
                "id": att_id,
                "filename": filename,
                "content_type": content_type,
                "size": len(data),
                "storage_path": f"email_attachments/{storage_name}",
            }
        )
    if missing and not copied:
        raise FileNotFoundError(
            "Attachment file(s) missing on the server: "
            + ", ".join(missing[:5])
            + ". Re-attach the file on the email template and save again."
        )
    if missing:
        raise FileNotFoundError(
            "Some attachment file(s) are missing on the server: "
            + ", ".join(missing[:5])
            + ". Re-attach them on the email template and save again."
        )
    return copied


def resolve_attachment(meta: dict, existing: list | None = None) -> dict | None:
    if not isinstance(meta, dict):
        return None
    storage_path = str(meta.get("storage_path") or "").strip()
    if storage_path:
        p = Path(storage_path)
        if p.is_file():
            return meta
        resolved_p = resolve_path(storage_path)
        if resolved_p.is_file():
            return {**meta, "storage_path": f"email_attachments/{resolved_p.name}"}

    att_id = str(meta.get("id") or "").strip()
    filename = str(meta.get("filename") or "").strip()

    # Match in existing list
    for item in existing or []:
        if isinstance(item, dict) and item.get("id") == att_id and item.get("storage_path"):
            return item

    # Match in STORAGE_DIR by att_id
    if STORAGE_DIR.is_dir() and att_id:
        matches = list(STORAGE_DIR.glob(f"{att_id}_*"))
        if matches and matches[0].is_file():
            path = matches[0]
            return {
                "id": att_id,
                "filename": filename or path.name.split("_", 1)[-1],
                "content_type": meta.get("content_type") or _guess_content_type(path.name, None),
                "size": meta.get("size") or path.stat().st_size,
                "storage_path": f"email_attachments/{path.name}",
            }

    # Match in static catalogues
    cat_file = resolve_catalogue_file(filename) or resolve_catalogue_file(att_id)
    if cat_file and cat_file.is_file():
        return {
            "id": att_id or cat_file.stem,
            "filename": filename or cat_file.name,
            "content_type": "application/pdf",
            "size": cat_file.stat().st_size,
            "storage_path": str(cat_file.resolve()),
        }

    return None


def resolve_attachment_list(items: list | None, existing: list | None = None) -> list[dict]:
    resolved: list[dict] = []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        meta = resolve_attachment(item, existing)
        if meta:
            resolved.append(meta)
        if len(resolved) >= MAX_FILES_PER_EMAIL:
            break
    return resolved


def merge_attachments(*groups: list | None) -> list[dict]:
    merged: list[dict] = []
    seen: set[str] = set()
    for group in groups:
        for item in group or []:
            if not isinstance(item, dict):
                continue
            key = str(item.get("id") or item.get("storage_path") or "")
            if not key or key in seen:
                continue
            seen.add(key)
            merged.append(item)
            if len(merged) >= MAX_FILES_PER_EMAIL:
                return merged
    return merged
