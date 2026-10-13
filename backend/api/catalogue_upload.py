"""Replace a catalogue PDF from the dashboard (admin only).

Kept in its own router (registered with a guard in main.py) so it can never affect the existing
catalogue routes. The catalogue keeps its id, title and file name — only the PDF changes.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

from api.deps import require_admin
from db.models import AppUser
from modules.catalogue_overrides import (
    MAX_UPLOAD_BYTES,
    custom_catalogues_dir,
    find_catalogue_def,
    install_custom_catalogue,
    remove_custom_catalogue,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/catalogues", tags=["catalogues"])

_CHUNK = 1024 * 1024


def _catalogue_item(cat_id: str) -> dict[str, Any]:
    from modules.catalogues import list_catalogues

    return next((c for c in list_catalogues() if c["id"] == cat_id), {})


@router.post("/{cat_id}/upload")
def upload_catalogue_pdf(
    cat_id: str,
    file: UploadFile = File(...),
    user: AppUser = Depends(require_admin),
):
    """Replace this catalogue's PDF with the uploaded one."""
    try:
        meta = find_catalogue_def(cat_id)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc

    directory = custom_catalogues_dir()
    try:
        directory.mkdir(parents=True, exist_ok=True)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(500, f"Could not prepare storage for the catalogue: {exc}") from exc

    tmp = directory / f".upload-{uuid.uuid4().hex}.tmp"
    total = 0
    head = b""
    tail = b""
    try:
        with tmp.open("wb") as out:
            while True:
                chunk = file.file.read(_CHUNK)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        413,
                        f"That file is larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB. "
                        "Please upload a compressed PDF.",
                    )
                if not head:
                    head = chunk[:8]
                out.write(chunk)
                tail = (tail + chunk)[-2048:]
        if total == 0:
            raise HTTPException(400, "That file is empty.")
        if not head.startswith(b"%PDF-"):
            raise HTTPException(400, "That file is not a PDF. Please choose a .pdf file.")
        if b"%%EOF" not in tail:
            raise HTTPException(
                400,
                "That PDF looks incomplete or damaged (the upload may have been cut off). "
                "Please try again.",
            )
        install_custom_catalogue(cat_id, tmp)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.exception("Catalogue upload failed for %s", cat_id)
        raise HTTPException(500, f"Could not save the catalogue: {exc}") from exc
    finally:
        try:
            if tmp.exists():
                tmp.unlink()
        except Exception:  # noqa: BLE001
            pass

    logger.info(
        "Catalogue %s (%s) replaced by %s: %.1f MB",
        cat_id,
        meta["filename"],
        getattr(user, "username", "admin"),
        total / (1024 * 1024),
    )
    return _catalogue_item(cat_id)


@router.delete("/{cat_id}/upload")
def restore_original_catalogue(cat_id: str, user: AppUser = Depends(require_admin)):
    """Remove the uploaded replacement and go back to the original PDF."""
    try:
        removed = remove_custom_catalogue(cat_id)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(500, f"Could not restore the original catalogue: {exc}") from exc
    if removed:
        logger.info(
            "Catalogue %s restored to the original by %s",
            cat_id,
            getattr(user, "username", "admin"),
        )
    return _catalogue_item(cat_id)
