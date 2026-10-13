"""KPI Generation API — day / week / month activity reports + shareable summaries."""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.orm import Session

from api.deps import get_current_user, get_db
from api.schemas import (
    DailyKpiReportRead,
    KpiSummaryRequest,
    KpiSummaryResponse,
    ManualKpiEntryCreate,
    ManualKpiEntryRead,
    ManualKpiEntryUpdate,
    ManualKpiListResponse,
)
from db.models import AppUser
from modules import activity as activity_module
from modules import manual_kpi as manual_kpi_module

router = APIRouter(prefix="/kpi", tags=["kpi"])


@router.get("/daily", response_model=DailyKpiReportRead)
def get_kpi_report(
    report_date: date = Query(
        ...,
        alias="date",
        description="Anchor date in Asia/Karachi (day itself, or any day in week/month)",
    ),
    period: str = Query(
        "day",
        description="Report range: day | week | month",
    ),
    user_id: int | None = Query(
        None,
        description="Admin only: filter to one user. Omit for team rollup.",
    ),
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    try:
        result = activity_module.get_kpi_report(
            db,
            report_date=report_date,
            viewer=user,
            user_id=user_id,
            period=period,
        )
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    return DailyKpiReportRead(**result)


@router.post("/summary", response_model=KpiSummaryResponse)
def create_kpi_summary(
    payload: KpiSummaryRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    try:
        result = activity_module.generate_kpi_summary(
            db,
            report_date=payload.date,
            viewer=user,
            user_id=payload.user_id,
            period=payload.period,
        )
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    return KpiSummaryResponse(
        summary=result["summary"],
        source=result["source"],
        subject=result["subject"],
        report=DailyKpiReportRead(**result["report"]),
    )


@router.get("/manual", response_model=ManualKpiListResponse)
def list_manual_kpi(
    report_date: date = Query(..., alias="date"),
    period: str = Query("day", description="day | week | month | year"),
    user_id: int | None = Query(None, description="Admin only: filter by user"),
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    try:
        result = manual_kpi_module.list_manual_kpi_entries(
            db,
            viewer=user,
            report_date=report_date,
            period=period,
            user_id=user_id,
        )
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    return ManualKpiListResponse(**result)


@router.post("/manual", response_model=ManualKpiEntryRead, status_code=201)
def create_manual_kpi(
    payload: ManualKpiEntryCreate,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    result = manual_kpi_module.create_manual_kpi_entry(
        db,
        user=user,
        activity_date=payload.activity_date,
        person_name=payload.person_name,
        company=payload.company,
        country=payload.country,
        contact_type=payload.contact_type,
        follow_up_type=payload.follow_up_type,
        wechat_contacts=payload.wechat_contacts,
        remarks=payload.remarks,
    )
    return ManualKpiEntryRead(**result)


@router.patch("/manual/{entry_id}", response_model=ManualKpiEntryRead)
def update_manual_kpi(
    entry_id: int,
    payload: ManualKpiEntryUpdate,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    try:
        result = manual_kpi_module.update_manual_kpi_entry(
            db,
            entry_id=entry_id,
            viewer=user,
            **payload.model_dump(exclude_unset=True),
        )
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    return ManualKpiEntryRead(**result)


@router.delete("/manual/{entry_id}", status_code=204)
def delete_manual_kpi(
    entry_id: int,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    try:
        manual_kpi_module.delete_manual_kpi_entry(db, entry_id=entry_id, viewer=user)
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    return Response(status_code=204)
