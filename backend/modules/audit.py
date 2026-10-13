from sqlalchemy.orm import Session

from db.models import AuditLog


def log_action(
    db: Session,
    *,
    entity_type: str,
    entity_id: int,
    action: str,
    actor: str | None = None,
    details: dict | None = None,
) -> AuditLog:
    entry = AuditLog(
        entity_type=entity_type,
        entity_id=entity_id,
        action=action,
        actor=actor,
        details=details,
    )
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return entry
