"""Expand ZIP/RAR uploads into spreadsheet files for Data Synthesis."""

from __future__ import annotations

import io
import zipfile
from pathlib import PurePosixPath

from modules.file_to_csv import SUPPORTED_UPLOAD_EXTENSIONS

ARCHIVE_EXTENSIONS = {".zip", ".rar"}
SPREADSHEET_EXTENSIONS = set(SUPPORTED_UPLOAD_EXTENSIONS)

MAX_EXPANDED_FILES = 500
MAX_ARCHIVE_DEPTH = 4
MAX_SINGLE_BYTES = 80 * 1024 * 1024  # 80 MB per uploaded blob
MAX_TOTAL_BYTES = 400 * 1024 * 1024  # 400 MB combined


def _is_spreadsheet(name: str) -> bool:
    return PurePosixPath(name).suffix.lower() in SPREADSHEET_EXTENSIONS


def _is_archive(name: str) -> bool:
    return PurePosixPath(name).suffix.lower() in ARCHIVE_EXTENSIONS


def _read_bounded(raw: bytes, label: str) -> None:
    if len(raw) > MAX_SINGLE_BYTES:
        raise ValueError(f"{label} is too large (max {MAX_SINGLE_BYTES // (1024 * 1024)} MB per file).")


def _expand_zip(raw: bytes, archive_name: str, depth: int) -> list[tuple[str, bytes]]:
    if depth > MAX_ARCHIVE_DEPTH:
        raise ValueError(f"Archive nesting too deep inside {archive_name!r}.")

    out: list[tuple[str, bytes]] = []
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            for info in zf.infolist():
                if info.is_dir():
                    continue
                inner_name = PurePosixPath(info.filename).name
                if not inner_name or inner_name.startswith("."):
                    continue
                if info.file_size > MAX_SINGLE_BYTES:
                    continue
                data = zf.read(info)
                if not data:
                    continue
                label = f"{archive_name}/{info.filename}"
                if _is_spreadsheet(inner_name):
                    out.append((label, data))
                elif _is_archive(inner_name) and depth < MAX_ARCHIVE_DEPTH:
                    out.extend(_expand_archive(inner_name, data, depth + 1, label))
    except zipfile.BadZipFile as exc:
        raise ValueError(f"Could not read ZIP archive {archive_name!r}.") from exc
    return out


def _expand_rar(raw: bytes, archive_name: str, depth: int) -> list[tuple[str, bytes]]:
    if depth > MAX_ARCHIVE_DEPTH:
        raise ValueError(f"Archive nesting too deep inside {archive_name!r}.")

    try:
        import rarfile
    except ImportError as exc:
        raise ValueError(
            "RAR support is not installed on the server. Upload a ZIP instead, or upload the Excel files directly."
        ) from exc

    out: list[tuple[str, bytes]] = []
    try:
        with rarfile.RarFile(io.BytesIO(raw)) as rf:
            for info in rf.infolist():
                if info.is_dir():
                    continue
                inner_name = PurePosixPath(info.filename).name
                if not inner_name or inner_name.startswith("."):
                    continue
                if info.file_size > MAX_SINGLE_BYTES:
                    continue
                data = rf.read(info)
                if not data:
                    continue
                label = f"{archive_name}/{info.filename}"
                if _is_spreadsheet(inner_name):
                    out.append((label, data))
                elif _is_archive(inner_name) and depth < MAX_ARCHIVE_DEPTH:
                    out.extend(_expand_archive(inner_name, data, depth + 1, label))
    except rarfile.Error as exc:
        raise ValueError(
            f"Could not read RAR archive {archive_name!r}. Try ZIP, or extract and upload the Excel files."
        ) from exc
    return out


def _expand_archive(name: str, raw: bytes, depth: int, display_name: str | None = None) -> list[tuple[str, bytes]]:
    label = display_name or name
    ext = PurePosixPath(name).suffix.lower()
    if ext == ".zip":
        return _expand_zip(raw, label, depth)
    if ext == ".rar":
        return _expand_rar(raw, label, depth)
    return []


def expand_data_synthesis_uploads(
    uploads: list[tuple[str | None, bytes]],
) -> tuple[list[tuple[str | None, bytes]], list[str]]:
    """Turn direct spreadsheets + ZIP/RAR archives into a flat spreadsheet upload list."""
    expanded: list[tuple[str | None, bytes]] = []
    messages: list[str] = []
    total_bytes = 0

    for filename, raw in uploads:
        if not raw:
            continue
        name = (filename or "upload").strip() or "upload"
        _read_bounded(raw, name)
        total_bytes += len(raw)
        if total_bytes > MAX_TOTAL_BYTES:
            raise ValueError(
                f"Total upload too large (max {MAX_TOTAL_BYTES // (1024 * 1024)} MB). "
                "Split into smaller ZIP files or upload in batches."
            )

        if _is_archive(name):
            inner = _expand_archive(name, raw, depth=1)
            if not inner:
                raise ValueError(f"No Excel/CSV files found inside {name!r}.")
            expanded.extend(inner)
            messages.append(f"Opened {name!r} — {len(inner)} spreadsheet(s) inside.")
            continue

        if not _is_spreadsheet(name):
            ext_list = ", ".join(sorted(SPREADSHEET_EXTENSIONS | ARCHIVE_EXTENSIONS))
            raise ValueError(f"Unsupported file {name!r}. Upload: {ext_list}")
        expanded.append((name, raw))

    if len(expanded) > MAX_EXPANDED_FILES:
        raise ValueError(
            f"Too many spreadsheets ({len(expanded)}). Maximum is {MAX_EXPANDED_FILES} per run — split into batches."
        )

    if not expanded:
        raise ValueError("No Excel or CSV files to process.")

    if messages:
        messages.insert(0, f"Ready to process {len(expanded)} spreadsheet(s).")
    return expanded, messages
