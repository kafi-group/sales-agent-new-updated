"""FastAPI router for Target and Workspace module."""

from __future__ import annotations

from typing import Any, Optional
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from api.deps import get_current_user, get_db
from db.models import AppUser, AppUserRole
from modules import target_workspace as tw_module

router = APIRouter(prefix="/target-workspace", tags=["target-workspace"])


# ── Schemas ─────────────────────────────────────────────────────────────

class AddTargetRequest(BaseModel):
    day_of_week: str
    country: str
    assigned_user_id: Optional[int] = None


class UpdateLeadStatusRequest(BaseModel):
    buyer_id: int
    stage: str  # "fresh", "needs_follow_up", "not_interested", "no_response", "interested"
    not_interested_reason: Optional[str] = None
    not_interested_remarks: Optional[str] = None
    follow_up_reason: Optional[str] = None
    follow_up_action: Optional[str] = None
    follow_up_date: Optional[datetime] = None
    whatsapp_call_tried: Optional[bool] = None
    whatsapp_call_proof: Optional[str] = None
    searched_internet_email: Optional[bool] = None
    searched_internet_phone: Optional[bool] = None
    linkedin_request_sent: Optional[bool] = None
    linkedin_msg_sent: Optional[bool] = None


class ReplaceContactDripRequest(BaseModel):
    buyer_id: int
    new_contact_name: str
    new_email: str
    new_phone: Optional[str] = None
    new_designation: Optional[str] = None
    product_type: Optional[str] = "FMCG / Food & Beverage"
    notes: Optional[str] = None


class AddReviewOptionRequest(BaseModel):
    category: str
    label: str
    action_hint: Optional[str] = None


# ── Endpoints ───────────────────────────────────────────────────────────

@router.get("/targets")
def get_targets(
    day: Optional[str] = Query(None, description="Day of week (e.g. 'friday')"),
    user_id: Optional[int] = Query(None, description="Assigned user id"),
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    """List target countries for a given day."""
    target_user = user_id if (user.role == AppUserRole.admin and user_id is not None) else None
    targets = tw_module.get_day_country_targets(db, day_of_week=day, user_id=target_user)
    return {"day_of_week": day or tw_module.get_current_day_name(), "targets": targets}


@router.post("/targets")
def add_target(
    payload: AddTargetRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    """Add a target country for a day."""
    try:
        res = tw_module.add_day_country_target(
            db,
            day_of_week=payload.day_of_week,
            country=payload.country,
            assigned_user_id=payload.assigned_user_id,
            created_by_user_id=user.id,
        )
        return {"success": True, "target": res}
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.delete("/targets/{target_id}")
def remove_target(
    target_id: int,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    """Remove target country."""
    ok = tw_module.remove_day_country_target(db, target_id=target_id)
    if not ok:
        raise HTTPException(404, "Target country not found")
    return {"success": True}


@router.get("/workspace")
def get_workspace_leads(
    day: Optional[str] = Query(None),
    country: Optional[str] = Query(None),
    stage: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    master_type: Optional[str] = Query("fmcg"),
    user_id: Optional[int] = Query(None),
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    """Fetch outreach leads filtered by target countries and 4 funnel stages.

    Sales users always get their own assigned leads only (My Assigned Leads pool).
    Admins default to team view; pass user_id to preview one rep's assigned pool.
    Scoped to Active Master List (``master_type``, default ``fmcg``).
    """
    target_user = user_id if (user.role == AppUserRole.admin and user_id is not None) else user.id
    if user.role == AppUserRole.admin and user_id is None:
        target_user = None  # Admin team view

    return tw_module.list_workspace_leads(
        db,
        day_of_week=day,
        country=country,
        stage=stage,
        user_id=target_user,
        search=search,
        master_type=master_type or "fmcg",
        page=page,
        limit=limit,
    )


@router.post("/lead-status")
def update_lead_status(
    payload: UpdateLeadStatusRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    """Update lead outreach stage, follow-up, objection reasons, or WhatsApp proof."""
    try:
        return tw_module.update_workspace_lead_stage(
            db,
            buyer_id=payload.buyer_id,
            user=user,
            stage=payload.stage,
            not_interested_reason=payload.not_interested_reason,
            not_interested_remarks=payload.not_interested_remarks,
            follow_up_reason=payload.follow_up_reason,
            follow_up_action=payload.follow_up_action,
            follow_up_date=payload.follow_up_date,
            whatsapp_call_tried=payload.whatsapp_call_tried,
            whatsapp_call_proof=payload.whatsapp_call_proof,
            searched_internet_email=payload.searched_internet_email,
            searched_internet_phone=payload.searched_internet_phone,
            linkedin_request_sent=payload.linkedin_request_sent,
            linkedin_msg_sent=payload.linkedin_msg_sent,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/replace-and-drip")
def replace_and_drip(
    payload: ReplaceContactDripRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    """Replace dead contact email and enroll old email in 15-day Drip Campaign table."""
    try:
        return tw_module.replace_contact_and_shift_to_drip(
            db,
            buyer_id=payload.buyer_id,
            user=user,
            new_contact_name=payload.new_contact_name,
            new_email=payload.new_email,
            new_phone=payload.new_phone,
            new_designation=payload.new_designation,
            product_type=payload.product_type or "FMCG / Food & Beverage",
            notes=payload.notes,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("/drip-campaign")
def get_drip_campaign_leads(
    search: Optional[str] = Query(None),
    user_id: Optional[int] = Query(None),
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    """List replaced / dead emails enrolled in separate Drip Campaign table."""
    target_user = user_id if (user.role == AppUserRole.admin and user_id is not None) else None
    return tw_module.list_drip_campaign_leads(
        db,
        user_id=target_user,
        search=search,
        page=page,
        limit=limit,
    )


@router.get("/review-options")
def get_review_options(
    category: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    """List customizable review options."""
    return {"options": tw_module.list_review_options(db, category=category)}


@router.post("/review-options")
def add_review_option(
    payload: AddReviewOptionRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    """Add custom review dropdown option."""
    return tw_module.add_review_option(
        db,
        category=payload.category,
        label=payload.label,
        action_hint=payload.action_hint,
        user_id=user.id,
    )


@router.delete("/review-options/{option_id}")
def delete_review_option(
    option_id: int,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    """Delete custom review dropdown option."""
    ok = tw_module.delete_review_option(db, option_id=option_id)
    if not ok:
        raise HTTPException(400, "Cannot delete system default option or option not found")
    return {"success": True}


# ── AI Conclusion ───────────────────────────────────────────────────────


@router.get("/ai-conclusions/buyer/{buyer_id}")
def get_buyer_ai_conclusion(
    buyer_id: int,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    """Engagement (7/30/90) + AI conclusion fields for one company."""
    from modules import ai_conclusion as ac_module

    _ = user
    item = ac_module.build_buyer_conclusion(db, buyer_id)
    if not item:
        raise HTTPException(404, "Buyer not found")
    return item


@router.get("/ai-conclusions")
def list_ai_conclusions(
    user_id: Optional[int] = Query(None),
    buyer_id: Optional[int] = Query(None),
    company: Optional[str] = Query(None),
    day: Optional[str] = Query(None, description="Day of week filter for target countries"),
    attention: Optional[str] = Query(None, description="required | not_required"),
    limit: int = Query(40, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    """List AI conclusions. Non-admins are scoped to their own assigned leads."""
    from modules import ai_conclusion as ac_module

    scoped_user = user_id
    if user.role != AppUserRole.admin:
        scoped_user = user.id
    return ac_module.list_conclusions(
        db,
        user_id=scoped_user,
        buyer_id=buyer_id,
        company_query=company,
        day_of_week=day,
        attention=attention,
        limit=limit,
        offset=offset,
    )


@router.get("/ai-conclusions/overview")
def ai_conclusions_admin_overview(
    day: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    """Admin roll-up: attention required by sales person / company list."""
    from modules import ai_conclusion as ac_module

    if user.role != AppUserRole.admin:
        raise HTTPException(403, "Admin only")
    return ac_module.summarize_admin_overview(db, day_of_week=day)
