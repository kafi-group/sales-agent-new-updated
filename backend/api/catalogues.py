"""API router for Catalogues management, download, attachment, and client dispatch."""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from api.schemas import EmailAttachmentRead
from db.session import get_db
from modules.catalogues import attach_catalogues_as_attachments, get_catalogue_by_id, list_catalogues

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
def get_all_catalogues():
    """List all 4 official Kafi FMCG & Himalayan Salt PDF catalogues."""
    return list_catalogues()


@router.get("/{cat_id}/download")
def download_catalogue(cat_id: str):
    """Download or view a specific catalogue PDF."""
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
def attach_catalogues(req: AttachCataloguesRequest):
    """Convert chosen catalogue(s) into EmailAttachment objects for mail composer."""
    if not req.catalogue_ids:
        return []
    attachments = attach_catalogues_as_attachments(req.catalogue_ids)
    return [EmailAttachmentRead(**a) for a in attachments]
