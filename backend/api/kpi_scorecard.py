"""KPI scorecard API.

Own router, registered with a guard in main.py, so it can never affect the existing KPI routes.
* GET  /kpi/scorecard                  any signed-in user (non-admins see only themselves)
* POST /kpi/scorecard/config/unlock    admin + password: read the targets and settings
* PUT  /kpi/scorecard/config           admin + password: save the targets and settings
"""

from __future__ import annotations

from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from api.deps import get_current_user, get_db, require_admin
from db.models import AppUser, AppUserRole
from modules import kpi_scorecard as scorecard

router = APIRouter(prefix="/kpi", tags=["kpi"])


class UnlockBody(BaseModel):
    pin: str


class SaveBody(BaseModel):
    pin: str
    config: dict[str, Any]


def _check_pin(pin: str) -> None:
    if not scorecard.pin_ok(pin):
        raise HTTPException(403, "Incorrect password.")


def _config_payload(db: Session) -> dict[str, Any]:
    people = (
        db.query(AppUser)
        .filter(AppUser.is_active.is_(True))
        .order_by(AppUser.full_name.asc())
        .all()
    )
    return {
        "config": scorecard.get_config(),
        "metrics": scorecard.metric_catalogue(),
        "users": [
            {"id": u.id, "username": u.username, "full_name": u.full_name}
            for u in people
            if (u.role.value if isinstance(u.role, AppUserRole) else str(u.role)) != AppUserRole.admin.value
        ],
        "grade_order": scorecard.GRADE_ORDER,
    }


@router.get("/scorecard")
def get_scorecard(
    report_date: date = Query(..., alias="date"),
    period: str = Query("day", description="day | week | month"),
    user_id: int | None = Query(None, description="Admin only: one user. Omit for the team."),
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    try:
        return scorecard.compute_scorecard(
            db, viewer=user, report_date=report_date, period=period, user_id=user_id
        )
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.post("/scorecard/config/unlock")
def unlock_scorecard_config(
    body: UnlockBody,
    db: Session = Depends(get_db),
    _admin: AppUser = Depends(require_admin),
):
    _check_pin(body.pin)
    return _config_payload(db)


@router.put("/scorecard/config")
def save_scorecard_config(
    body: SaveBody,
    db: Session = Depends(get_db),
    _admin: AppUser = Depends(require_admin),
):
    _check_pin(body.pin)
    try:
        scorecard.save_config(body.config)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return _config_payload(db)
