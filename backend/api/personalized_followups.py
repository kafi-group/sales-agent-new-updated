"""Personalized post-call follow-up drafts (Mail → Personalized Emails)."""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from api.deps import get_current_user, get_db
from db.models import AppUser, PersonalizedFollowupDraft
from modules import personalized_followups as pf_module

router = APIRouter(prefix="/personalized-followups", tags=["personalized-followups"])


class PersonalizedFollowupUpdate(BaseModel):
    subject: Optional[str] = Field(default=None, max_length=500)
    email_body: Optional[str] = None
    whatsapp_body: Optional[str] = None


class PersonalizedFollowupTranslate(BaseModel):
    language: str = Field(..., min_length=2, max_length=16)
    subject: Optional[str] = None
    email_body: Optional[str] = None
    whatsapp_body: Optional[str] = None


class PersonalizedFollowupSend(BaseModel):
    """Send one or both channels. Use template_* when outside the 24h WA window."""

    channels: str = Field(
        default="both",
        description="email | whatsapp | both",
    )
    target_phone: Optional[str] = Field(
        default=None,
        description="Specific recipient phone number for WhatsApp (Meta / Mobile). Defaults to dialed or primary contact phone.",
    )
    target_email: Optional[str] = Field(
        default=None,
        description="Specific recipient email. Defaults to primary/secondary emails on the contact.",
    )
    subject: Optional[str] = None
    email_body: Optional[str] = None
    whatsapp_body: Optional[str] = None
    template_name: Optional[str] = None
    template_language: str = "en_US"
    template_variables: list[str] = Field(default_factory=list)
    attachments: list[dict[str, Any]] = Field(default_factory=list)


def _generate_in_background(draft_id: int) -> None:
    from db.session import SessionLocal

    db = SessionLocal()
    try:
        pf_module.generate_draft_content(db, draft_id)
    except Exception:  # noqa: BLE001
        pass
    finally:
        db.close()


@router.get("")
def list_personalized_followups(
    status: Optional[str] = None,
    limit: int = Query(100, ge=1, le=200),
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    return pf_module.list_drafts(db, viewer=user, status=status, limit=limit)


@router.get("/languages")
def list_followup_languages(
    _user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    from modules.followup_languages import list_followup_languages as _list

    return {"languages": _list()}


@router.get("/by-interaction/{interaction_id}")
def get_personalized_followup_by_interaction(
    interaction_id: int,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    row = pf_module.get_draft_for_interaction(db, interaction_id=interaction_id)
    if not row:
        raise HTTPException(404, "Personalized draft not found for this call")
    return row


@router.post("/{draft_id}/generate")
def trigger_generation(
    draft_id: int,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    _user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    draft = db.get(PersonalizedFollowupDraft, draft_id)
    if not draft:
        raise HTTPException(404, "Personalized draft not found")
    background_tasks.add_task(_generate_in_background, draft_id)
    return {"status": "generating", "draft_id": draft_id}


@router.get("/{draft_id}")
def get_personalized_followup(
    draft_id: int,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    draft = db.get(PersonalizedFollowupDraft, draft_id)
    if not draft:
        raise HTTPException(404, "Personalized draft not found")
    return pf_module.draft_to_dict(db, draft)


@router.patch("/{draft_id}")
def update_personalized_followup(
    draft_id: int,
    payload: PersonalizedFollowupUpdate,
    db: Session = Depends(get_db),
    _user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    try:
        draft = pf_module.update_draft(
            db,
            draft_id,
            subject=payload.subject,
            email_body=payload.email_body,
            whatsapp_body=payload.whatsapp_body,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return pf_module.draft_to_dict(db, draft)


@router.post("/{draft_id}/translate")
def translate_personalized_followup(
    draft_id: int,
    payload: PersonalizedFollowupTranslate,
    db: Session = Depends(get_db),
    _user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Translate draft subject/bodies into a local language (does not auto-save)."""
    draft = db.get(PersonalizedFollowupDraft, draft_id)
    if not draft:
        raise HTTPException(404, "Personalized draft not found")
    result = pf_module.translate_draft_content(
        language=payload.language,
        subject=payload.subject if payload.subject is not None else (draft.subject or ""),
        email_body=payload.email_body
        if payload.email_body is not None
        else (draft.email_body or ""),
        whatsapp_body=payload.whatsapp_body
        if payload.whatsapp_body is not None
        else (draft.whatsapp_body or ""),
    )
    return result


@router.post("/{draft_id}/regenerate")
def regenerate_personalized_followup(
    draft_id: int,
    db: Session = Depends(get_db),
    _user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    try:
        draft = pf_module.generate_draft_content(db, draft_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return pf_module.draft_to_dict(db, draft)


@router.post("/{draft_id}/send")
def send_personalized_followup(
    draft_id: int,
    payload: PersonalizedFollowupSend | None = None,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    body = payload or PersonalizedFollowupSend()
    try:
        return pf_module.send_draft(
            db,
            draft_id,
            user=user,
            channels=body.channels,
            target_phone=body.target_phone,
            target_email=body.target_email,
            subject=body.subject,
            email_body=body.email_body,
            whatsapp_body=body.whatsapp_body,
            template_name=body.template_name,
            template_language=body.template_language,
            template_variables=body.template_variables,
            attachments=body.attachments or None,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/{draft_id}/dismiss")
def dismiss_personalized_followup(
    draft_id: int,
    db: Session = Depends(get_db),
    _user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    try:
        draft = pf_module.dismiss_draft(db, draft_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return pf_module.draft_to_dict(db, draft)
