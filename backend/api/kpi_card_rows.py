"""KPI boxes -> one row per contact (personal / bulk email & WhatsApp, leads imported).

Kept in its own router (registered with a guard in main.py) so it can never affect the existing
KPI routes.
"""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from api.deps import get_current_user, get_db
from db.models import AppUser
from modules import kpi_card_rows as kpi_card_rows_module

router = APIRouter(prefix="/kpi", tags=["kpi"])


@router.get("/card-rows")
def get_kpi_card_rows(
    card: str = Query(..., description="KPI box key, e.g. bulk_whatsapp_sent"),
    report_date: date = Query(..., alias="date"),
    period: str = Query("day", description="day | week | month | custom"),
    date_from: date | None = Query(None, description="Custom period: inclusive start"),
    date_to: date | None = Query(None, description="Custom period: inclusive end"),
    user_id: int | None = Query(None, description="Admin only: one user. Omit for the team."),
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    try:
        rows = kpi_card_rows_module.get_card_rows(
            db,
            card=card,
            report_date=report_date,
            viewer=user,
            user_id=user_id,
            period=period,
            date_from=date_from,
            date_to=date_to,
        )
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    return {"card": card, "total": len(rows), "rows": rows}
