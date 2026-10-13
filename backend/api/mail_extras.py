"""Mail labels + compose drafts API (nested under /inbox)."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from api.deps import get_current_user, get_db
from db.models import AppUser, AppUserRole
from db.session import SessionLocal
from modules import mail_drafts as drafts_module
from modules import mail_labels as labels_module

router = APIRouter(prefix="/inbox", tags=["inbox"])

_ASIM_SHARED_MAILBOX_EMAILS = frozenset(
    {
        "marketing@kafi-group.com",
        "info@kafi-group.com",
        "essence@kafi-group.com",
    }
)


def _norm_mailbox_email(value: str | None) -> str:
    return (value or "").strip().lower()


def _is_asim(user: AppUser) -> bool:
    uname = _norm_mailbox_email(user.username)
    fname = _norm_mailbox_email(getattr(user, "full_name", None))
    return uname == "asim" or uname.startswith("asim") or "asim" in fname


def _resolve_mailbox_user(acting: AppUser, mailbox_user_id: int | None) -> AppUser:
    """Same switcher rules as inbox API (Asim shared mailboxes / admin)."""
    if not mailbox_user_id or int(mailbox_user_id) == int(acting.id):
        return acting
    role = acting.role.value if isinstance(acting.role, AppUserRole) else str(acting.role)
    db = SessionLocal()
    try:
        other = db.get(AppUser, int(mailbox_user_id))
        if not other:
            return acting
        if role == AppUserRole.admin.value or _is_asim(acting):
            if role != AppUserRole.admin.value:
                email = _norm_mailbox_email(other.mailbox_email)
                if email not in _ASIM_SHARED_MAILBOX_EMAILS:
                    raise HTTPException(
                        403,
                        "You can only switch to marketing@, info@, or essence@ mailboxes",
                    )
            db.expunge(other)
            return other
        raise HTTPException(403, "Only admin can open another mailbox")
    finally:
        db.close()


class MailLabelRead(BaseModel):
    id: int
    name: str
    color: str
    match_query: Optional[str] = None
    match_keyword: Optional[str] = None
    count: int = 0
    is_system: bool = False

    model_config = {"from_attributes": True}


def _mail_label_read(label: Any, *, count: int = 0) -> MailLabelRead:
    return MailLabelRead(
        id=label.id,
        name=label.name,
        color=label.color,
        match_query=label.match_query,
        match_keyword=label.match_keyword,
        count=count,
        is_system=labels_module.is_flagged_label(label),
    )


class MailLabelCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    color: str = Field(default="#34d399", max_length=32)
    match_query: Optional[str] = Field(
        default=None,
        max_length=255,
        description="Domain or full email — routes by sender/recipient address only",
    )
    match_keyword: Optional[str] = Field(
        default=None,
        max_length=255,
        description="Keyword — routes when found in subject, preview, or body",
    )


class MailLabelAssignRequest(BaseModel):
    label_id: int
    folder: str = "inbox"
    message_uid: str
    message_id: Optional[str] = None
    thread_id: Optional[str] = None
    from_email: Optional[str] = None
    subject: Optional[str] = None
    apply_similar: bool = False
    mailbox_user_id: Optional[int] = None


class MailLabelUnassignRequest(BaseModel):
    label_id: int
    folder: str = "inbox"
    message_uid: str
    mailbox_user_id: Optional[int] = None


class MailDraftRead(BaseModel):
    id: int
    to_addrs: str
    cc_addrs: str
    subject: str
    body: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class MailDraftUpsert(BaseModel):
    id: Optional[int] = None
    to_addrs: str = ""
    cc_addrs: str = ""
    subject: str = ""
    body: str = ""


@router.get("/labels", response_model=list[MailLabelRead])
def list_mail_labels(
    mailbox_user_id: int | None = Query(default=None),
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> Any:
    mailbox = _resolve_mailbox_user(user, mailbox_user_id)
    # DB assignment counts only — never live IMAP here. Label polls run often and
    # IMAP scans hang Emails / WhatsApp / contacts. Flagged + labels hydrate on open.
    counts = labels_module.label_counts(
        db, user.id, mailbox_user_id=int(mailbox.id)
    )
    return [
        _mail_label_read(label, count=counts.get(label.id, 0))
        for label in labels_module.list_labels(db, user.id)
    ]


@router.post("/labels", response_model=MailLabelRead, status_code=201)
def create_mail_label(
    body: MailLabelCreate,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> Any:
    try:
        label = labels_module.create_label(
            db,
            user.id,
            name=body.name,
            color=body.color,
            match_query=body.match_query,
            match_keyword=body.match_keyword,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return _mail_label_read(label, count=0)


class MailLabelUpdateRequest(BaseModel):
    name: str
    color: str | None = None


@router.patch("/labels/{label_id}", response_model=MailLabelRead)
def update_mail_label(
    label_id: int,
    body: MailLabelUpdateRequest,
    mailbox_user_id: int | None = Query(default=None),
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> MailLabelRead:
    try:
        label = labels_module.rename_label(
            db,
            user.id,
            label_id=label_id,
            new_name=body.name,
            new_color=body.color,
        )
        mailbox = _resolve_mailbox_user(user, mailbox_user_id)
        count = labels_module.label_counts(
            db, user.id, mailbox_user_id=int(mailbox.id)
        ).get(label.id, 0)
        return _mail_label_read(label, count=count)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.delete("/labels/{label_id}", status_code=204)
def delete_mail_label(
    label_id: int,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> None:
    try:
        if not labels_module.delete_label(db, user.id, label_id):
            raise HTTPException(404, "Label not found")
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/labels/assign")
def assign_mail_label(
    body: MailLabelAssignRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> Any:
    mailbox = _resolve_mailbox_user(user, body.mailbox_user_id)
    try:
        return labels_module.assign_label(
            db,
            user.id,
            label_id=body.label_id,
            folder=body.folder,
            message_uid=body.message_uid,
            message_id=body.message_id,
            thread_id=body.thread_id,
            from_email=body.from_email,
            subject=body.subject,
            apply_similar=body.apply_similar,
            mailbox_user_id=int(mailbox.id),
            mailbox_user=mailbox,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/labels/unassign")
def unassign_mail_label(
    body: MailLabelUnassignRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> Any:
    mailbox = _resolve_mailbox_user(user, body.mailbox_user_id)
    ok = labels_module.unassign_label(
        db,
        user.id,
        label_id=body.label_id,
        folder=body.folder,
        message_uid=body.message_uid,
        mailbox_user_id=int(mailbox.id),
    )
    return {"removed": ok}


@router.get("/labels/map/by-uids")
def map_labels_by_uids(
    folder: str = "inbox",
    uids: str = "",
    mailbox_user_id: int | None = Query(default=None),
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> Any:
    uid_list = [u.strip() for u in (uids or "").split(",") if u.strip()]
    mailbox = _resolve_mailbox_user(user, mailbox_user_id)
    return labels_module.labels_for_messages(
        db,
        user.id,
        folder=folder,
        message_uids=uid_list,
        mailbox_user_id=int(mailbox.id),
    )


@router.get("/labels/{label_id}/messages")
def list_label_messages(
    label_id: int,
    mailbox_user_id: int | None = Query(default=None),
    resolve: bool = Query(
        default=False,
        description="When true, return message summaries via one IMAP batch (Flagged).",
    ),
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> Any:
    mailbox = _resolve_mailbox_user(user, mailbox_user_id)
    try:
        keys = labels_module.message_keys_for_label(
            db,
            user.id,
            label_id,
            mailbox_user_id=int(mailbox.id),
        )
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    if not resolve:
        return keys
    from modules import inbox as inbox_module

    items = inbox_module.list_messages_by_folder_uids(
        mailbox,
        keys,
        limit=80,
        headers_only=True,
    )
    return {"items": items, "total": len(items), "keys": keys}


@router.get("/drafts", response_model=list[MailDraftRead])
def list_compose_drafts(
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> Any:
    return drafts_module.list_drafts(db, user.id)


@router.get("/drafts/count")
def compose_draft_count(
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> Any:
    return {"count": drafts_module.draft_count(db, user.id)}


@router.post("/drafts", response_model=MailDraftRead)
def upsert_compose_draft(
    body: MailDraftUpsert,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> Any:
    # Skip empty drafts
    if not any(
        [
            (body.to_addrs or "").strip(),
            (body.cc_addrs or "").strip(),
            (body.subject or "").strip(),
            (body.body or "").strip(),
        ]
    ):
        raise HTTPException(400, "Draft is empty")
    draft = drafts_module.upsert_draft(
        db,
        user.id,
        draft_id=body.id,
        to_addrs=body.to_addrs,
        cc_addrs=body.cc_addrs,
        subject=body.subject,
        body=body.body,
    )
    return draft


@router.delete("/drafts/{draft_id}", status_code=204)
def delete_compose_draft(
    draft_id: int,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> None:
    if not drafts_module.delete_draft(db, user.id, draft_id):
        raise HTTPException(404, "Draft not found")
