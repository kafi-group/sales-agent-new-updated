"""AI Mode API — toggle, auto-reply templates, process, company lifecycle."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from api.deps import get_current_user, get_db
from db.models import AppUser, AppUserRole
from modules import ai_mode as ai_mode_module

router = APIRouter(prefix="/ai-mode", tags=["ai-mode"])


def _is_admin(user: AppUser) -> bool:
    role = user.role.value if isinstance(user.role, AppUserRole) else str(user.role)
    return role == AppUserRole.admin.value


def _require_admin(user: AppUser) -> None:
    if not _is_admin(user):
        raise HTTPException(403, "Only an admin can use AI Mode auto-reply and query AI replies.")


class AiModeSettingsUpdate(BaseModel):
    enabled: Optional[bool] = None
    email_auto_reply_enabled: Optional[bool] = None
    whatsapp_auto_reply_enabled: Optional[bool] = None
    form_url: Optional[str] = None
    email_subject_template: Optional[str] = None
    email_body_template: Optional[str] = None
    whatsapp_body_template: Optional[str] = None
    query_keywords: Optional[list[str] | str] = None


class LifecycleUpdateRequest(BaseModel):
    stage: str
    notes: Optional[str] = None


class LifecycleEnsureRequest(BaseModel):
    buyer_id: int = Field(..., ge=1)


class QuotationMeetingUpdateRequest(BaseModel):
    meeting_status: str = Field(
        ...,
        description="not_scheduled, scheduled, or done (done moves client to Negotiation)",
    )
    meeting_at: Optional[str] = Field(
        None,
        description="ISO-8601 datetime (required when meeting_status is scheduled)",
    )


@router.get("/settings")
def get_settings(
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    row = ai_mode_module.get_or_create_settings(db, user.id)
    return ai_mode_module.settings_to_dict(row)


@router.patch("/settings")
def patch_settings(
    payload: AiModeSettingsUpdate,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    data = payload.model_dump(exclude_unset=True)
    if any(
        key in data
        for key in (
            "enabled",
            "email_auto_reply_enabled",
            "whatsapp_auto_reply_enabled",
            "form_url",
            "email_subject_template",
            "email_body_template",
            "whatsapp_body_template",
            "query_keywords",
        )
    ):
        _require_admin(user)
    try:
        return ai_mode_module.update_settings(
            db, user.id, data, actor=user
        )
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc


@router.post("/process-emails")
def process_emails(
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Manually scan mailbox and auto-reply to query emails (when AI Mode is on)."""
    _require_admin(user)
    return ai_mode_module.process_email_auto_replies_for_user(db, user)


@router.get("/auto-replies")
def list_auto_replies(
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    _require_admin(user)
    return {"rows": ai_mode_module.list_auto_reply_log(db, user.id, limit=limit)}


@router.get("/queries")
def list_queries(
    limit: int = Query(100, ge=1, le=500),
    refresh: bool = Query(
        False,
        description="If true, scan mailbox for new keyword matches before listing",
    ),
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    scan: dict[str, Any] | None = None
    if refresh:
        scan = ai_mode_module.scan_queries_for_user(
            db, user, deep=True, limit=10
        )
    result = ai_mode_module.list_queries(db, user.id, limit=limit)
    if scan is not None:
        result["scan"] = scan
    return result


@router.post("/queries/scan")
def scan_queries(
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Live IMAP inbox scan — latest 10 emails (read or unread) with bodies."""
    scan = ai_mode_module.scan_queries_for_user(db, user, deep=True, limit=10)
    listed = ai_mode_module.list_queries(db, user.id, limit=100)
    return {**listed, "scan": scan}


@router.get("/queries/{query_id}")
def get_query_message(
    query_id: int,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    try:
        return ai_mode_module.fetch_query_message(db, user, query_id)
    except ValueError as exc:
        raise HTTPException(404 if "not found" in str(exc).lower() else 400, str(exc)) from exc


@router.post("/queries/{query_id}/generate-reply")
def generate_query_reply(
    query_id: int,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    """LLM draft for Company lifecycle → New Lead query reply."""
    _require_admin(user)
    try:
        return ai_mode_module.generate_query_reply_draft(db, user, query_id)
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(404 if "not found" in str(exc).lower() else 400, str(exc)) from exc


@router.get("/lifecycle/stages")
def lifecycle_stages(
    _user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    return {"stages": ai_mode_module.LIFECYCLE_STAGES}


@router.get("/lifecycle")
def list_lifecycle(
    stage: Optional[str] = None,
    search: Optional[str] = None,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    light: bool = Query(
        False,
        description="Target Workspace / fast refresh: rows + stage counts only (skip activity feeds).",
    ),
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    assignee_scope = ai_mode_module.lifecycle_assignee_scope(user)
    result = ai_mode_module.list_lifecycle(
        db,
        stage=stage,
        search=search,
        limit=limit,
        offset=offset,
        assigned_to_user_id=assignee_scope,
    )
    if light:
        # Used by Target and Workspace inbound pipeline — must stay fast.
        result["pipeline"] = ai_mode_module.lifecycle_stage_counts(
            db, assigned_to_user_id=assignee_scope
        )
        return result

    result["pipeline"] = ai_mode_module.lifecycle_pipeline_counts(
        db, assigned_to_user_id=assignee_scope, viewer=user
    )
    result["assignments"] = ai_mode_module.list_lead_transfers(
        db, limit=100, assigned_to_user_id=assignee_scope
    )
    result["call_activities"] = ai_mode_module.list_call_activities(
        db, limit=100, viewer=user
    )
    result["follow_up_activities"] = ai_mode_module.list_follow_up_activities(
        db, limit=100, viewer=user
    )
    result["interested_activities"] = ai_mode_module.list_interested_activities(
        db, viewer=user, limit=100, assigned_to_user_id=assignee_scope
    )
    result["not_interested_activities"] = ai_mode_module.list_not_interested_activities(
        db, viewer=user, limit=100, assigned_to_user_id=assignee_scope
    )
    result["potential_clients"] = ai_mode_module.list_potential_clients(
        db,
        search=search if stage == "potential_clients" else None,
        limit=100,
        assigned_to_user_id=assignee_scope,
    )
    result["interested_clients"] = ai_mode_module.list_interested_clients_for_lifecycle(
        db,
        search=search if stage == "interested" else None,
        limit=100,
        assigned_to_user_id=assignee_scope,
    )
    result["quotation_sent_clients"] = (
        ai_mode_module.list_quotation_sent_clients_for_lifecycle(
            db,
            search=search if stage == "quotation_sent" else None,
            limit=100,
            assigned_to_user_id=assignee_scope,
        )
    )
    result["negotiation_clients"] = ai_mode_module.list_negotiation_clients_for_lifecycle(
        db,
        search=search if stage == "negotiation" else None,
        limit=100,
        assigned_to_user_id=assignee_scope,
    )
    # Back-compat for older frontends.
    result["interested_leads"] = result["potential_clients"]
    return result


@router.get("/assignments")
def list_assignments(
    limit: int = Query(100, ge=1, le=500),
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Lead transfer messages for Company lifecycle → Assigned."""
    return ai_mode_module.list_lead_transfers(
        db,
        limit=limit,
        assigned_to_user_id=ai_mode_module.lifecycle_assignee_scope(user),
    )


@router.get("/call-activities")
def list_call_activities(
    limit: int = Query(100, ge=1, le=500),
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Call statements for Company lifecycle → Calling."""
    return ai_mode_module.list_call_activities(db, limit=limit, viewer=user)


@router.get("/follow-up-activities")
def list_follow_up_activities(
    limit: int = Query(100, ge=1, le=500),
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Follow up clients statements for Company lifecycle → Follow-up."""
    return ai_mode_module.list_follow_up_activities(db, limit=limit, viewer=user)


@router.get("/interested-activities")
def list_interested_activities(
    limit: int = Query(100, ge=1, le=500),
    after_id: Optional[int] = Query(None, ge=0),
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Interested Clients activity for Company lifecycle → Interested."""
    return ai_mode_module.list_interested_activities(
        db,
        viewer=user,
        limit=limit,
        after_id=after_id,
        assigned_to_user_id=ai_mode_module.lifecycle_assignee_scope(user),
    )


@router.get("/not-interested-activities")
def list_not_interested_activities(
    limit: int = Query(100, ge=1, le=500),
    after_id: Optional[int] = Query(None, ge=0),
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Not interested clients activity for Company lifecycle → Not Interested."""
    return ai_mode_module.list_not_interested_activities(
        db,
        viewer=user,
        limit=limit,
        after_id=after_id,
        assigned_to_user_id=ai_mode_module.lifecycle_assignee_scope(user),
    )


@router.get("/potential-clients")
def list_potential_clients(
    search: Optional[str] = None,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Scrapped Leads with company grading + AI grade both AA or AAA."""
    return ai_mode_module.list_potential_clients(
        db,
        search=search,
        limit=limit,
        offset=offset,
        assigned_to_user_id=ai_mode_module.lifecycle_assignee_scope(user),
    )


@router.get("/interested-leads")
def list_interested_leads(
    search: Optional[str] = None,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Back-compat alias for Potential Clients (AA/AAA Scrapped Leads)."""
    return ai_mode_module.list_potential_clients(
        db,
        search=search,
        limit=limit,
        offset=offset,
        assigned_to_user_id=ai_mode_module.lifecycle_assignee_scope(user),
    )


@router.post("/lifecycle/ensure")
def ensure_lifecycle(
    payload: LifecycleEnsureRequest,
    db: Session = Depends(get_db),
    _user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    from db.models import Buyer

    buyer = db.get(Buyer, payload.buyer_id)
    if not buyer:
        raise HTTPException(404, "Buyer not found")
    row = ai_mode_module.ensure_lifecycle(db, payload.buyer_id)
    return ai_mode_module._lifecycle_to_dict(row, buyer)


@router.patch("/lifecycle/{buyer_id}")
def patch_lifecycle(
    buyer_id: int,
    payload: LifecycleUpdateRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    try:
        return ai_mode_module.update_lifecycle(
            db,
            buyer_id,
            stage=payload.stage,
            notes=payload.notes,
            user_id=user.id,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.patch("/quotation-sent/{buyer_id}/meeting")
def patch_quotation_meeting(
    buyer_id: int,
    payload: QuotationMeetingUpdateRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Schedule or clear a meeting for a Quotation Sent client."""
    meeting_at = None
    if payload.meeting_at:
        raw = payload.meeting_at.strip()
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        try:
            meeting_at = datetime.fromisoformat(raw)
        except ValueError as exc:
            raise HTTPException(400, "Invalid meeting_at datetime") from exc
    try:
        return ai_mode_module.update_quotation_meeting_schedule(
            db,
            buyer_id,
            meeting_status=payload.meeting_status,
            meeting_at=meeting_at,
            user_id=user.id,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("/meeting-alerts")
def list_meeting_alerts(
    db: Session = Depends(get_db),
    _user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Upcoming meeting reminders for scheduled Quotation Sent clients."""
    return ai_mode_module.process_quotation_meeting_alerts(db)
