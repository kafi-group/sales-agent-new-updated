"""Scheduled bulk email campaigns (executed via Vercel mailer SMTP)."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

import httpx
from sqlalchemy.orm import Session

from config import settings
from db.models import AppUser, BulkEmailSchedule
from modules import buyers as buyers_module
from modules.mailbox_accounts import resolve_user_mailbox

logger = logging.getLogger(__name__)


def create_schedule(
    db: Session,
    *,
    user: AppUser,
    buyer_ids: list[int],
    subject: str,
    body: str,
    scheduled_at: datetime,
    batch_size: int = 10,
    message_delay_seconds: float = 2.0,
    batch_pause_seconds: float = 45.0,
) -> BulkEmailSchedule:
    if scheduled_at.tzinfo is None:
        scheduled_at = scheduled_at.replace(tzinfo=timezone.utc)
    now = datetime.now(timezone.utc)
    if scheduled_at <= now:
        raise ValueError("Schedule time must be in the future")

    account = resolve_user_mailbox(user)
    if not account:
        raise ValueError("Your company mailbox is not configured. Ask an admin (Users page).")

    leads: list[dict[str, Any]] = []
    for buyer_id in list(dict.fromkeys(buyer_ids)):
        buyer = buyers_module.get_buyer(db, buyer_id)
        if not buyer:
            continue
        contact = buyers_module.primary_contact_with_email(db, buyer_id)
        if not contact or not (contact.email or "").strip():
            continue
        leads.append(
            {
                "buyer_id": buyer_id,
                "company_name": buyer.company_name,
                "contact_name": contact.full_name,
                "contact_email": contact.email.strip(),
            }
        )

    if not leads:
        raise ValueError("None of the selected leads have a contact email")

    row = BulkEmailSchedule(
        user_id=user.id,
        mailbox_email=account.email,
        username=user.username,
        display_name=account.display_name,
        buyer_ids=[lead["buyer_id"] for lead in leads],
        leads=leads,
        subject=subject.strip(),
        body=body,
        scheduled_at=scheduled_at,
        batch_size=max(1, min(15, batch_size)),
        message_delay_seconds=max(0.0, message_delay_seconds),
        batch_pause_seconds=max(0.0, batch_pause_seconds),
        status="pending",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _mint_handoff_token(user: AppUser, leads: list[dict[str, Any]], *, expires_in: int = 3600) -> str:
    import jwt

    secret = (settings.mailer_handoff_secret or "").strip()
    if not secret:
        raise ValueError("MAILER_HANDOFF_SECRET not configured")

    account = resolve_user_mailbox(user)
    now = datetime.now(timezone.utc)
    payload = {
        "user_id": user.id,
        "username": user.username,
        "mailbox_email": account.email if account else "",
        "display_name": account.display_name if account else None,
        "buyer_ids": [lead["buyer_id"] for lead in leads],
        "leads": leads,
        "iat": int(now.timestamp()),
        "exp": int(now.timestamp()) + expires_in,
    }
    token = jwt.encode(payload, secret, algorithm="HS256")
    return token.decode("ascii") if isinstance(token, bytes) else token


def execute_schedule(db: Session, schedule: BulkEmailSchedule) -> dict[str, Any]:
    """Run one due schedule via Vercel mailer /api/send-batch."""
    public_url = (settings.mailer_public_url or "").strip().rstrip("/")
    if not public_url:
        raise ValueError("MAILER_PUBLIC_URL not configured")

    user = db.get(AppUser, schedule.user_id)
    if not user:
        raise ValueError("Schedule owner not found")

    leads = list(schedule.leads or [])
    if not leads:
        raise ValueError("Schedule has no leads")

    token = _mint_handoff_token(user, leads, expires_in=7200)
    batch_size = max(1, min(15, schedule.batch_size or 10))
    sent_total = 0
    failed_total = 0

    for start in range(0, len(leads), batch_size):
        chunk = leads[start : start + batch_size]
        with httpx.Client(timeout=120.0) as client:
            response = client.post(
                f"{public_url}/api/send-batch",
                json={
                    "token": token,
                    "subject": schedule.subject,
                    "body": schedule.body,
                    "leads": chunk,
                    "message_delay_seconds": schedule.message_delay_seconds,
                },
            )
        if response.status_code >= 400:
            raise ValueError(response.text[:500] or f"Mailer error {response.status_code}")
        data = response.json()
        sent_total += int(data.get("sent") or 0)
        failed_total += int(data.get("failed") or 0)
        if start + batch_size < len(leads) and (schedule.batch_pause_seconds or 0) > 0:
            import time

            time.sleep(schedule.batch_pause_seconds)

    return {
        "sent": sent_total,
        "failed": failed_total,
        "recipient_count": len(leads),
    }


def process_due_schedules(db: Session, *, limit: int = 5) -> list[dict[str, Any]]:
    now = datetime.now(timezone.utc)
    due = (
        db.query(BulkEmailSchedule)
        .filter(BulkEmailSchedule.status == "pending")
        .filter(BulkEmailSchedule.scheduled_at <= now)
        .order_by(BulkEmailSchedule.scheduled_at.asc())
        .limit(limit)
        .all()
    )
    results: list[dict[str, Any]] = []
    for row in due:
        row.status = "running"
        db.commit()
        try:
            outcome = execute_schedule(db, row)
            row.status = "sent"
            row.result_message = (
                f"Sent {outcome['sent']} of {outcome['recipient_count']} "
                f"({outcome['failed']} failed)"
            )
            row.executed_at = datetime.now(timezone.utc)
            results.append({"id": row.id, "status": "sent", **outcome})
        except Exception as exc:  # noqa: BLE001
            row.status = "failed"
            row.result_message = str(exc)[:2000]
            row.executed_at = datetime.now(timezone.utc)
            logger.exception("Bulk email schedule %s failed", row.id)
            results.append({"id": row.id, "status": "failed", "error": str(exc)})
        db.commit()
    return results


def schedule_to_dict(row: BulkEmailSchedule) -> dict[str, Any]:
    return {
        "id": row.id,
        "user_id": row.user_id,
        "recipient_count": len(row.leads or []),
        "subject": row.subject,
        "scheduled_at": row.scheduled_at.isoformat() if row.scheduled_at else None,
        "status": row.status,
        "result_message": row.result_message,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "executed_at": row.executed_at.isoformat() if row.executed_at else None,
    }
