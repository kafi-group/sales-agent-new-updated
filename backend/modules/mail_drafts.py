"""Compose drafts for the Mail UI (auto-saved on close / tab-away)."""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy.orm import Session

from db.models import MailComposeDraft


def list_drafts(db: Session, user_id: int) -> list[MailComposeDraft]:
    return (
        db.query(MailComposeDraft)
        .filter(MailComposeDraft.user_id == user_id)
        .order_by(MailComposeDraft.updated_at.desc())
        .all()
    )


def get_draft(db: Session, user_id: int, draft_id: int) -> MailComposeDraft | None:
    return (
        db.query(MailComposeDraft)
        .filter(MailComposeDraft.id == draft_id, MailComposeDraft.user_id == user_id)
        .first()
    )


def upsert_draft(
    db: Session,
    user_id: int,
    *,
    draft_id: int | None = None,
    to_addrs: str = "",
    cc_addrs: str = "",
    subject: str = "",
    body: str = "",
) -> MailComposeDraft:
    to_addrs = (to_addrs or "").strip()
    cc_addrs = (cc_addrs or "").strip()
    subject = (subject or "").strip()
    body = body or ""

    if draft_id is not None:
        draft = get_draft(db, user_id, draft_id)
        if draft:
            draft.to_addrs = to_addrs
            draft.cc_addrs = cc_addrs
            draft.subject = subject
            draft.body = body
            draft.updated_at = datetime.now(timezone.utc)
            db.commit()
            db.refresh(draft)
            return draft

    draft = MailComposeDraft(
        user_id=user_id,
        to_addrs=to_addrs,
        cc_addrs=cc_addrs,
        subject=subject,
        body=body,
    )
    db.add(draft)
    db.commit()
    db.refresh(draft)
    return draft


def delete_draft(db: Session, user_id: int, draft_id: int) -> bool:
    draft = get_draft(db, user_id, draft_id)
    if not draft:
        return False
    db.delete(draft)
    db.commit()
    return True


def draft_count(db: Session, user_id: int) -> int:
    return db.query(MailComposeDraft).filter(MailComposeDraft.user_id == user_id).count()
