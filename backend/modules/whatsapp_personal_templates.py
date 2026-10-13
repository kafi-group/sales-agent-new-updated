"""Personal WhatsApp free-text templates (QR / Baileys) — not Meta WABA templates."""

from __future__ import annotations

from sqlalchemy.orm import Session

from db.models import WhatsAppPersonalTemplate


def list_templates(db: Session) -> list[WhatsAppPersonalTemplate]:
    return (
        db.query(WhatsAppPersonalTemplate)
        .order_by(WhatsAppPersonalTemplate.updated_at.desc())
        .all()
    )


def get_template(db: Session, template_id: int) -> WhatsAppPersonalTemplate | None:
    return db.get(WhatsAppPersonalTemplate, template_id)


def create_template(
    db: Session,
    *,
    name: str,
    body: str,
    created_by_user_id: int | None = None,
) -> WhatsAppPersonalTemplate:
    record = WhatsAppPersonalTemplate(
        name=(name or "").strip()[:255] or "Untitled",
        body=(body or "").strip(),
        created_by_user_id=created_by_user_id,
    )
    if not record.body:
        raise ValueError("Template body is required")
    db.add(record)
    db.commit()
    db.refresh(record)
    return record


def update_template(
    db: Session,
    template_id: int,
    *,
    name: str | None = None,
    body: str | None = None,
) -> WhatsAppPersonalTemplate | None:
    record = get_template(db, template_id)
    if not record:
        return None
    if name is not None:
        record.name = name.strip()[:255] or record.name
    if body is not None:
        cleaned = body.strip()
        if not cleaned:
            raise ValueError("Template body is required")
        record.body = cleaned
    db.commit()
    db.refresh(record)
    return record


def delete_template(db: Session, template_id: int) -> bool:
    record = get_template(db, template_id)
    if not record:
        return False
    db.delete(record)
    db.commit()
    return True
