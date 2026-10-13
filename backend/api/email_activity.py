from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from api.deps import get_current_user, get_db
from api.schemas import (
    EmailActivityAiResponse,
    EmailActivityCatalogItem,
    EmailActivityInsights,
    EmailActivityListResponse,
    EmailActivityMarkReadRequest,
)
from db.models import AppUser, AppUserRole
from modules import email_activity

router = APIRouter(prefix="/email-activity", tags=["email-activity"])

ChannelParam = Literal["email", "whatsapp"]


def _is_admin(user: AppUser) -> bool:
    role = user.role.value if isinstance(user.role, AppUserRole) else str(user.role)
    return role == AppUserRole.admin.value


def _parse_channel(channel: Optional[str]) -> Optional[email_activity.ActivityChannel]:
    if channel is None or not str(channel).strip():
        return "email"
    key = str(channel).strip().lower()
    if key not in {"email", "whatsapp"}:
        raise HTTPException(400, "channel must be 'email' or 'whatsapp'")
    return key  # type: ignore[return-value]


def _ai_period_args(
    days: int | None,
    date_from: Optional[str],
    date_to: Optional[str],
) -> tuple[int | None, Optional[str], Optional[str]]:
    period: int | None
    if days is not None and int(days) <= 0:
        period = None
    elif days is not None:
        period = max(1, min(int(days), 3650))
    else:
        period = 30
    if date_from or date_to:
        period = None
    return period, date_from, date_to


@router.get("", response_model=EmailActivityListResponse)
def list_email_activity(
    page: int = 1,
    page_size: int = email_activity.DEFAULT_PAGE_SIZE,
    unread_only: bool = False,
    channel: Optional[ChannelParam] = Query("email"),
    event_type: Optional[str] = Query(
        None, description="Filter: sent | opened | failed | replied | send_failed | …"
    ),
    send_mode: Optional[str] = Query(None, description="individual | bulk"),
    days: Optional[int] = Query(
        None, description="Insights window (rolling days) when drilling down"
    ),
    date_from: Optional[str] = Query(None, description="YYYY-MM-DD inclusive start"),
    date_to: Optional[str] = Query(None, description="YYYY-MM-DD inclusive end"),
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    is_admin = _is_admin(user)
    ch = _parse_channel(channel)
    try:
        rows, total, unread = email_activity.list_events(
            db,
            page=page,
            page_size=page_size,
            unread_only=unread_only,
            user_id=user.id,
            is_admin=is_admin,
            channel=ch,
            event_type=event_type,
            send_mode=send_mode,
            days=days,
            date_from=date_from,
            date_to=date_to,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    page = max(1, page)
    page_size = min(max(1, page_size), 100)
    total_pages = max(1, (total + page_size - 1) // page_size) if total else 1
    actors = email_activity.actors_for_events(db, rows)
    return EmailActivityListResponse(
        total=total,
        unread_count=unread,
        page=page,
        page_size=page_size,
        total_pages=total_pages,
        rows=[
            email_activity.event_to_dict(
                row,
                actor=actors.get(row.user_id) if row.user_id else None,
                channel=ch,
            )
            for row in rows
        ],
    )


@router.get("/insights", response_model=EmailActivityInsights)
def email_activity_insights(
    days: int | None = 30,
    date_from: Optional[str] = Query(None, description="YYYY-MM-DD inclusive start"),
    date_to: Optional[str] = Query(None, description="YYYY-MM-DD inclusive end"),
    channel: Optional[ChannelParam] = Query("email"),
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    """Aggregate send / open / bulk vs individual stats for the Insights panel."""
    period = None if days is not None and int(days) <= 0 else (days if days is not None else 30)
    if period is not None:
        period = max(1, min(int(period), 3650))
    # Custom range overrides rolling `days` window.
    if date_from or date_to:
        period = None
    try:
        return email_activity.insights_stats(
            db,
            days=period,
            date_from=date_from,
            date_to=date_to,
            user_id=user.id,
            is_admin=_is_admin(user),
            channel=_parse_channel(channel),
            sync_user=user,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/ai-analysis", response_model=EmailActivityAiResponse)
def email_activity_ai_analysis(
    days: int | None = Query(30),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    period, df, dt = _ai_period_args(days, date_from, date_to)
    try:
        return email_activity.analyze_email_activity(
            db,
            days=period,
            date_from=df,
            date_to=dt,
            user_id=user.id,
            is_admin=_is_admin(user),
            sync_user=user,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/improve-suggestions", response_model=EmailActivityAiResponse)
def email_activity_improve_suggestions(
    days: int | None = Query(30),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    period, df, dt = _ai_period_args(days, date_from, date_to)
    try:
        return email_activity.suggest_email_improvements(
            db,
            days=period,
            date_from=df,
            date_to=dt,
            user_id=user.id,
            is_admin=_is_admin(user),
            sync_user=user,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("/catalog", response_model=list[EmailActivityCatalogItem])
def list_email_activity_catalog(_: AppUser = Depends(get_current_user)):
    return email_activity.catalog_list()


@router.get("/unread-count")
def email_activity_unread_count(
    channel: Optional[ChannelParam] = Query("email"),
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    _, _, unread = email_activity.list_events(
        db,
        page=1,
        page_size=1,
        user_id=user.id,
        is_admin=_is_admin(user),
        channel=_parse_channel(channel),
    )
    return {"unread_count": unread}


@router.post("/mark-read")
def mark_email_activity_read(
    payload: EmailActivityMarkReadRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    if not payload.mark_all and not payload.event_ids:
        raise HTTPException(400, "Provide event_ids or set mark_all=true")
    ch = None
    if payload.channel:
        ch = _parse_channel(payload.channel)
    updated = email_activity.mark_read(
        db,
        payload.event_ids,
        mark_all=payload.mark_all,
        user_id=user.id,
        is_admin=_is_admin(user),
        channel=ch,
    )
    return {"updated": updated}


@router.get("/events/{event_id}/results")
def email_activity_bulk_results(
    event_id: int,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    """Per-contact sent / failed / skipped list for a bulk campaign summary event."""
    result = email_activity.bulk_results_for_event(
        db,
        event_id=event_id,
        viewer_id=user.id,
        is_admin=_is_admin(user),
    )
    if result is None:
        raise HTTPException(404, "Event not found")
    return result
