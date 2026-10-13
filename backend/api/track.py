"""Public tracking endpoints (no auth) — email open pixels."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from api.deps import get_db
from modules import email_tracking

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/track", tags=["track"])


@router.get("/email-open/{token}")
@router.get("/email-open/{token}.gif")
def track_email_open(token: str, db: Session = Depends(get_db)):
    """1×1 GIF open pixel. Always returns the image so clients don't retry oddly."""
    cleaned = (token or "").replace(".gif", "").strip()
    parsed = email_tracking.parse_open_token(cleaned)
    if parsed:
        interaction_id, send_mode = parsed
        try:
            result = email_tracking.record_open(
                db, interaction_id=interaction_id, send_mode=send_mode
            )
            logger.info(
                "email-open token ok interaction_id=%s result=%s",
                interaction_id,
                (result or {}).get("status"),
            )
        except Exception:  # noqa: BLE001
            logger.exception(
                "email-open record failed interaction_id=%s", interaction_id
            )
    else:
        logger.warning("email-open invalid/expired token len=%s", len(cleaned))
    return Response(
        content=email_tracking.pixel_gif_bytes(),
        media_type="image/gif",
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
        },
    )
