"""Helpful Guidance API."""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from api.auth import get_current_user
from db.models import AppUser
from db.session import get_db
from modules.helpful_guidance import generate_helpful_guidance

router = APIRouter(prefix="/guidance", tags=["guidance"])


@router.get("/helpful")
def get_helpful_guidance(
    months: int = Query(3, ge=1, le=12),
    days: Optional[int] = Query(
        None,
        description="Rolling days window (1/7/30/90). Overrides months when set.",
    ),
    date_from: Optional[str] = Query(None, description="YYYY-MM-DD inclusive start"),
    date_to: Optional[str] = Query(None, description="YYYY-MM-DD inclusive end"),
    channel: Optional[str] = Query(
        "calls",
        description="calls | emails | whatsapp | telegram",
    ),
    user_id: str | None = None,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    period_days = days
    if period_days is not None:
        period_days = max(1, min(int(period_days), 3650))
    try:
        return generate_helpful_guidance(
            db,
            viewer=user,
            months=months,
            user_id=user_id,
            channel=channel,
            days=period_days,
            date_from=date_from,
            date_to=date_to,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
