"""API router for Catalogues management, download, attachment, and client dispatch."""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from api.deps import get_current_user
from api.schemas import EmailAttachmentRead
from db.models import AppUser
from db.session import get_db
from modules.catalogues import attach_catalogues_as_attachments, get_catalogue_by_id, list_catalogues
from modules.catalogue_overrides import list_sandbox_catalogue_slots, sandbox_file
from modules.sandbox import is_sandbox_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/catalogues", tags=["catalogues"])


class AttachCataloguesRequest(BaseModel):
    catalogue_ids: list[str]


class SendCataloguesRequest(BaseModel):
    catalogue_ids: list[str]
    buyer_ids: list[int]
    channel: str = "email"  # "email" or "whatsapp"
    subject: Optional[str] = None
    custom_message: Optional[str] = None


@router.get("", response_model=list[dict[str, Any]])
def get_all_catalogues(user: AppUser = Depends(get_current_user)):
    """List catalogues. Sandbox accounts only see PDFs they uploaded."""
    if is_sandbox_user(user):
        return list_sandbox_catalogue_slots(user.id)
    return list_catalogues()


@router.get("/{cat_id}/download")
def download_catalogue(cat_id: str, user: AppUser = Depends(get_current_user)):
    """Download or view a specific catalogue PDF."""
    if is_sandbox_user(user):
        from modules.catalogue_overrides import find_catalogue_def

        try:
            meta = find_catalogue_def(cat_id)
        except ValueError as exc:
            raise HTTPException(404, str(exc)) from exc
        path = sandbox_file(user.id, meta["filename"])
        if path is None:
            raise HTTPException(404, "Catalogue file not found")
        return FileResponse(
            path=path,
            filename=meta["filename"],
            media_type="application/pdf",
            headers={"Content-Disposition": f'inline; filename="{meta["filename"]}"'},
        )
    try:
        path, meta = get_catalogue_by_id(cat_id)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc

    return FileResponse(
        path=path,
        filename=meta["filename"],
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{meta["filename"]}"'},
    )


@router.post("/attach", response_model=list[EmailAttachmentRead])
def attach_catalogues(req: AttachCataloguesRequest, user: AppUser = Depends(get_current_user)):
    """Convert chosen catalogue(s) into EmailAttachment objects for mail composer."""
    if not req.catalogue_ids:
        return []
    if is_sandbox_user(user):
        from modules.catalogue_overrides import find_catalogue_def
        from modules.email_attachments import public_attachment, register_attachment_from_path

        attachments = []
        for cat_id in req.catalogue_ids:
            try:
                meta = find_catalogue_def(cat_id)
            except ValueError as exc:
                raise HTTPException(404, str(exc)) from exc
            path = sandbox_file(user.id, meta["filename"])
            if path is None:
                raise HTTPException(404, "Upload a catalogue PDF before attaching it")
            registered = register_attachment_from_path(
                path, filename=meta["filename"], content_type="application/pdf"
            )
            attachments.append(public_attachment(registered))
        return [EmailAttachmentRead(**a) for a in attachments]
    attachments = attach_catalogues_as_attachments(req.catalogue_ids)
    return [EmailAttachmentRead(**a) for a in attachments]
