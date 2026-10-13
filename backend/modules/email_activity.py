"""Email activity notifications — outbound send lifecycle events for the dashboard."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from sqlalchemy import or_
from sqlalchemy.orm import Session

from db.models import AppUser, EmailActivityEvent

DEFAULT_PAGE_SIZE = 25

ActivityChannel = Literal["email", "whatsapp"]


def _is_whatsapp_event_clause():
    """Match WhatsApp activity rows (details.channel or title prefix for legacy rows)."""
    return or_(
        EmailActivityEvent.details.op("->>")("channel") == "whatsapp",
        EmailActivityEvent.title.ilike("WhatsApp%"),
    )


def _is_email_event_clause():
    """Email activity rows — NULL-safe inverse of WhatsApp filter.

    Plain ``~whatsapp_clause`` wrongly drops rows where details.channel is NULL
    because ``NOT (NULL OR false)`` is NULL in SQL three-valued logic. Open
    events from the tracking pixel have no details.channel set.
    """
    from sqlalchemy import func as sa_func

    channel = sa_func.coalesce(EmailActivityEvent.details.op("->>")("channel"), "")
    return sa_func.lower(channel) != "whatsapp", ~EmailActivityEvent.title.ilike("WhatsApp%")


def _scoped_query(
    db: Session,
    *,
    user_id: int | None,
    is_admin: bool,
    channel: ActivityChannel | None = None,
):
    """Admins see all events; other users only see their own."""
    query = db.query(EmailActivityEvent)
    if not is_admin:
        if user_id is None:
            return query.filter(EmailActivityEvent.id < 0)
        query = query.filter(EmailActivityEvent.user_id == user_id)
    if channel == "whatsapp":
        query = query.filter(_is_whatsapp_event_clause())
    elif channel == "email":
        query = query.filter(*_is_email_event_clause())
    return query


def _actor_user_id(mailbox_user) -> int | None:
    if mailbox_user is None:
        return None
    return getattr(mailbox_user, "id", None)

# Canonical event types. Some are emitted today; others are reserved for ESP/webhook tracking.
EVENT_CATALOG: dict[str, dict[str, str]] = {
    "send_started": {
        "label": "Send started",
        "description": "Outbound send was initiated for one or more recipients.",
    },
    "sent": {
        "label": "Email sent",
        "description": "SMTP accepted the message and the send completed successfully.",
    },
    "send_failed": {
        "label": "Send failed",
        "description": "The provider rejected the send or an unexpected error occurred.",
    },
    "mailbox_not_configured": {
        "label": "Mailbox not configured",
        "description": "Outbound email credentials are missing or incomplete.",
    },
    "invalid_recipient": {
        "label": "Invalid recipient",
        "description": "No usable email address was found for the contact.",
    },
    "authentication_failed": {
        "label": "Authentication failed",
        "description": "SMTP/OAuth login to the mailbox failed.",
    },
    "network_error": {
        "label": "Network error",
        "description": "Could not reach the mail server (timeout, DNS, connection).",
    },
    "attachment_rejected": {
        "label": "Attachment rejected",
        "description": "An attachment was too large, blocked, or unreadable.",
    },
    "rate_limited": {
        "label": "Rate limited",
        "description": "Sending paused or blocked by provider daily/hourly limits.",
    },
    "bulk_started": {
        "label": "Bulk send started",
        "description": "A multi-recipient outbound batch began.",
    },
    "bulk_progress": {
        "label": "Bulk send progress",
        "description": "Intermediate status while a bulk batch is running.",
    },
    "bulk_completed": {
        "label": "Bulk send completed",
        "description": "All messages in a bulk batch finished (success and/or failure).",
    },
    "bulk_partial": {
        "label": "Bulk campaign partial",
        "description": "Bulk campaign finished with some sends successful and some failed. Includes From mailbox and failed recipients when available.",
    },
    "skipped_no_email": {
        "label": "Skipped — no email",
        "description": "Lead was skipped because no contact email was on file.",
    },
    "delivered": {
        "label": "Delivered",
        "description": "Provider confirmed delivery to the recipient mailbox (ESP webhook).",
    },
    "deferred": {
        "label": "Deferred",
        "description": "Temporary delivery delay; provider will retry.",
    },
    "bounced_soft": {
        "label": "Soft bounce",
        "description": "Temporary bounce (full mailbox, greylist) — may succeed on retry.",
    },
    "bounced_hard": {
        "label": "Hard bounce",
        "description": "Permanent bounce (invalid address, domain does not exist).",
    },
    "opened": {
        "label": "Opened",
        "description": "Recipient opened the email (tracking pixel / ESP event).",
    },
    "clicked": {
        "label": "Link clicked",
        "description": "Recipient clicked a tracked link in the email.",
    },
    "replied": {
        "label": "Reply received",
        "description": "Recipient replied to the outbound thread.",
    },
    "unsubscribed": {
        "label": "Unsubscribed",
        "description": "Recipient opted out of further outreach.",
    },
    "spam_complaint": {
        "label": "Spam complaint",
        "description": "Recipient marked the message as spam.",
    },
    "blocked": {
        "label": "Blocked",
        "description": "Message blocked by policy, denylist, or content filters.",
    },
}

SEVERITY_BY_TYPE: dict[str, str] = {
    "send_started": "info",
    "sent": "success",
    "send_failed": "error",
    "mailbox_not_configured": "warning",
    "invalid_recipient": "warning",
    "authentication_failed": "error",
    "network_error": "error",
    "attachment_rejected": "warning",
    "rate_limited": "warning",
    "bulk_started": "info",
    "bulk_progress": "info",
    "bulk_completed": "success",
    "bulk_partial": "warning",
    "skipped_no_email": "warning",
    "delivered": "success",
    "deferred": "warning",
    "bounced_soft": "warning",
    "bounced_hard": "error",
    "opened": "success",
    "clicked": "success",
    "replied": "success",
    "unsubscribed": "warning",
    "spam_complaint": "error",
    "blocked": "error",
}


_INVALID_RECIPIENT_HINTS = (
    "invalid recipient",
    "invalid address",
    "recipient rejected",
    "recipient address rejected",
    "address rejected",
    "user unknown",
    "unknown user",
    "mailbox unavailable",
    "mailbox not found",
    "does not exist",
    "no such user",
    "no such mailbox",
    "undeliverable",
    "not found",
    "no longer",
    "relay access denied",
    "550 ",
    "551 ",
    "552 ",
    "553 ",
    "5.1.1",
    "5.1.10",
    "5.2.1",
    "5.4.1",
)


def is_invalid_recipient_message(message: str | None) -> bool:
    """True when SMTP/Graph wording indicates the destination address is bad."""
    text = (message or "").lower()
    if not text:
        return False
    if any(hint in text for hint in _INVALID_RECIPIENT_HINTS):
        return True
    # Broad but common: "recipient" + (invalid|reject|fail|unknown)
    if "recipient" in text and any(
        w in text for w in ("invalid", "reject", "fail", "unknown", "refus")
    ):
        return True
    if "address" in text and any(w in text for w in ("invalid", "reject", "unknown", "refus")):
        return True
    return False


def classify_send_result(send_result: dict | None) -> str:
    """Map mail_client/outlook status payloads to a canonical event type."""
    if not send_result:
        return "send_failed"
    status = str(send_result.get("status") or "").lower()
    message = str(send_result.get("message") or "").lower()
    if status == "sent":
        return "sent"
    if status == "not_configured":
        return "mailbox_not_configured"
    if send_result.get("error_type") == "invalid_recipient" or is_invalid_recipient_message(
        message
    ):
        return "invalid_recipient"
    if "auth" in message or "login" in message or "credential" in message:
        return "authentication_failed"
    if "timeout" in message or "connection" in message or "network" in message:
        return "network_error"
    if "attachment" in message or "too large" in message:
        return "attachment_rejected"
    if "rate" in message or "limit" in message or "throttle" in message:
        return "rate_limited"
    if "block" in message or "spam" in message or "policy" in message:
        return "blocked"
    return "send_failed"


def record_event(
    db: Session,
    *,
    event_type: str,
    title: str,
    message: str,
    user_id: int | None = None,
    buyer_id: int | None = None,
    contact_id: int | None = None,
    interaction_id: int | None = None,
    details: dict[str, Any] | None = None,
    severity: str | None = None,
    mailbox_user=None,
) -> EmailActivityEvent:
    actor_id = user_id if user_id is not None else _actor_user_id(mailbox_user)
    event = EmailActivityEvent(
        event_type=event_type,
        severity=severity or SEVERITY_BY_TYPE.get(event_type, "info"),
        title=title,
        message=message,
        user_id=actor_id,
        buyer_id=buyer_id,
        contact_id=contact_id,
        interaction_id=interaction_id,
        details=details or {},
    )
    db.add(event)
    db.commit()
    db.refresh(event)
    return event


def record_send_result(
    db: Session,
    *,
    send_result: dict | None,
    company_name: str,
    to_email: str | None,
    user_id: int | None = None,
    buyer_id: int | None = None,
    contact_id: int | None = None,
    interaction_id: int | None = None,
    subject: str | None = None,
    send_mode: str = "individual",
    mailbox_user=None,
) -> EmailActivityEvent:
    event_type = classify_send_result(send_result)
    catalog = EVENT_CATALOG.get(event_type, {})
    provider_message = (send_result or {}).get("message") or catalog.get("description", "")
    mode = "bulk" if send_mode == "bulk" else "individual"
    if event_type == "sent":
        title = f"Sent to {company_name}"
        message = f"Email delivered to outbound queue for {to_email or 'recipient'}."
        if subject:
            message = f"“{subject}” sent to {to_email or 'recipient'}."
    elif event_type == "mailbox_not_configured":
        title = "Mailbox not configured"
        message = str(provider_message)
    else:
        title = f"Send failed — {company_name}"
        message = str(provider_message) or f"Could not send to {to_email or company_name}."

    return record_event(
        db,
        event_type=event_type,
        title=title,
        message=message,
        user_id=user_id,
        buyer_id=buyer_id,
        contact_id=contact_id,
        interaction_id=interaction_id,
        mailbox_user=mailbox_user,
        details={
            "company_name": company_name,
            "to_email": to_email,
            "subject": subject,
            "send_result": send_result,
            "send_mode": mode,
        },
    )


def list_events(
    db: Session,
    *,
    page: int = 1,
    page_size: int = DEFAULT_PAGE_SIZE,
    unread_only: bool = False,
    user_id: int | None = None,
    is_admin: bool = False,
    channel: ActivityChannel | None = "email",
    event_type: str | None = None,
    send_mode: str | None = None,
    days: int | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
) -> tuple[list[EmailActivityEvent], int, int]:
    """List activity rows.

    When ``event_type`` + ``send_mode`` come from Insights drill-down, event matching
    mirrors ``insights_stats`` (bulk sent/failed include batch summary events).
    Optional ``days`` / ``date_from`` / ``date_to`` keep the feed in the same window
    as the Insights cards.
    """
    from datetime import date, time, timedelta

    page = max(1, page)
    page_size = min(max(1, page_size), 100)
    query = _scoped_query(db, user_id=user_id, is_admin=is_admin, channel=channel)
    if unread_only:
        query = query.filter(EmailActivityEvent.read_at.is_(None))

    def _parse_day(value: str | None, *, end_of_day: bool) -> datetime | None:
        if not value:
            return None
        raw = value.strip()
        if not raw:
            return None
        try:
            day = date.fromisoformat(raw[:10])
        except ValueError as exc:
            raise ValueError(f"Invalid date '{value}'. Use YYYY-MM-DD.") from exc
        if end_of_day:
            return datetime.combine(day, time(23, 59, 59, 999999), tzinfo=timezone.utc)
        return datetime.combine(day, time.min, tzinfo=timezone.utc)

    if date_from or date_to:
        since = _parse_day(date_from, end_of_day=False)
        until = _parse_day(date_to, end_of_day=True)
        if since and until and until < since:
            raise ValueError("date_to must be on or after date_from")
        if since is not None:
            query = query.filter(EmailActivityEvent.created_at >= since)
        if until is not None:
            query = query.filter(EmailActivityEvent.created_at <= until)
    elif days is not None and int(days) > 0:
        since = datetime.now(timezone.utc) - timedelta(days=max(1, min(int(days), 3650)))
        query = query.filter(EmailActivityEvent.created_at >= since)

    event_key = (event_type or "").strip().lower()
    mode_key = (send_mode or "").strip().lower()
    drill = mode_key in {"individual", "bulk"} and bool(event_key)

    if event_key and not drill:
        # Plain feed filter (sidebar / catalog) — not Insights drill.
        if event_key in {"failed", "send_failed"}:
            query = query.filter(EmailActivityEvent.event_type.in_(tuple(_FAIL_TYPES)))
        else:
            query = query.filter(EmailActivityEvent.event_type == event_key)

    unread = (
        _scoped_query(db, user_id=user_id, is_admin=is_admin, channel=channel)
        .filter(EmailActivityEvent.read_at.is_(None))
        .count()
    )

    if drill and event_key == "replied":
        # Match Insights Replies card: replied events + inbound email interactions
        # for contacts we emailed in this mode/window.
        filtered = _replied_drill_rows(
            db,
            user_id=user_id,
            is_admin=is_admin,
            channel=channel,
            mode_key=mode_key,
            days=days if not (date_from or date_to) else None,
            date_from=date_from,
            date_to=date_to,
        )
        total = len(filtered)
        start = (page - 1) * page_size
        rows = filtered[start : start + page_size]
        return rows, total, unread

    if drill:
        # Match Insights card semantics: bulk totals come from batch events.
        if event_key in {"failed", "send_failed"}:
            query = query.filter(
                EmailActivityEvent.event_type.in_(
                    tuple(_FAIL_TYPES) + ("bulk_completed", "bulk_partial")
                )
            )
        elif event_key == "sent":
            query = query.filter(
                EmailActivityEvent.event_type.in_(
                    ("sent", "bulk_completed", "bulk_partial")
                )
            )
        elif event_key == "opened":
            query = query.filter(EmailActivityEvent.event_type == "opened")
        else:
            query = query.filter(EmailActivityEvent.event_type == event_key)

        candidates = query.order_by(EmailActivityEvent.created_at.desc()).all()

        def _row_mode(event: EmailActivityEvent) -> str:
            details = event.details if isinstance(event.details, dict) else {}
            raw = str(details.get("send_mode") or "individual").strip().lower()
            return "bulk" if raw == "bulk" else "individual"

        def _failed_count(details: dict) -> int:
            try:
                return int(details.get("failed_count") or 0)
            except (TypeError, ValueError):
                return 0

        def _is_batch_failure(event: EmailActivityEvent) -> bool:
            details = event.details if isinstance(event.details, dict) else {}
            if event.event_type == "send_failed" and (
                "sent_count" in details
                or "failed_count" in details
                or "interaction_ids" in details
            ):
                return True
            if event.event_type in ("bulk_completed", "bulk_partial"):
                return _failed_count(details) > 0
            return False

        def _matches(event: EmailActivityEvent) -> bool:
            details = event.details if isinstance(event.details, dict) else {}
            et = event.event_type
            mode = _row_mode(event)

            if event_key == "opened":
                return et == "opened" and mode == mode_key

            if event_key == "sent":
                if mode_key == "bulk":
                    # Per-recipient bulk sent OR campaign batch summaries (insights source).
                    if et == "sent" and mode == "bulk":
                        return True
                    return et in ("bulk_completed", "bulk_partial")
                # individual
                if et != "sent":
                    return False
                return mode == "individual"

            if event_key in {"failed", "send_failed"}:
                if mode_key == "bulk":
                    if et in ("bulk_completed", "bulk_partial"):
                        return _failed_count(details) > 0
                    if _is_batch_failure(event):
                        return True
                    return et in _FAIL_TYPES and mode == "bulk"
                # individual — exclude batch rollups and bulk-tagged failures
                if et in ("bulk_completed", "bulk_partial"):
                    return False
                if _is_batch_failure(event):
                    return False
                return et in _FAIL_TYPES and mode == "individual"

            return mode == mode_key

        filtered = [row for row in candidates if _matches(row)]

        # Bulk Failed drill: expand campaign summaries into one row per failed recipient
        # when details.failures includes addresses (new mailer payloads).
        if event_key in {"failed", "send_failed"} and mode_key == "bulk":
            filtered = _expand_bulk_failure_rows(filtered)

        total = len(filtered)
        start = (page - 1) * page_size
        rows = filtered[start : start + page_size]
        return rows, total, unread

    if mode_key in {"individual", "bulk"}:
        candidates = query.order_by(EmailActivityEvent.created_at.desc()).all()

        def _row_mode(event: EmailActivityEvent) -> str:
            details = event.details if isinstance(event.details, dict) else {}
            raw = str(details.get("send_mode") or "individual").strip().lower()
            return "bulk" if raw == "bulk" else "individual"

        filtered = [row for row in candidates if _row_mode(row) == mode_key]
        total = len(filtered)
        start = (page - 1) * page_size
        rows = filtered[start : start + page_size]
        return rows, total, unread

    total = query.count()
    rows = (
        query.order_by(EmailActivityEvent.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return rows, total, unread


def _expand_bulk_failure_rows(
    events: list[EmailActivityEvent],
) -> list[EmailActivityEvent]:
    """Turn bulk_partial summaries with failures[] into per-recipient failed rows."""
    expanded: list[EmailActivityEvent] = []
    for event in events:
        details = event.details if isinstance(event.details, dict) else {}
        failures = details.get("failures")
        is_batch = event.event_type in ("bulk_partial", "bulk_completed") or (
            event.event_type == "send_failed"
            and (
                "sent_count" in details
                or "failed_count" in details
                or "selected_count" in details
            )
        )
        if not is_batch or not isinstance(failures, list) or not failures:
            expanded.append(event)
            continue

        mailbox = details.get("mailbox_email")
        subject = details.get("subject")
        source = details.get("source") or details.get("mode") or "bulk"
        made = 0
        for idx, raw in enumerate(failures):
            if not isinstance(raw, dict):
                continue
            to_email = (
                (raw.get("to_email") or raw.get("email") or "").strip() or None
            )
            company = (raw.get("company_name") or "").strip() or None
            error = (
                (raw.get("error") or raw.get("send_message") or raw.get("message") or "")
                .strip()
                or "Send failed"
            )
            if not to_email and not company:
                continue
            label = company or to_email or "recipient"
            synthetic = EmailActivityEvent(
                event_type="send_failed",
                severity="error",
                title=f"Send failed — {label}",
                message=error,
                user_id=event.user_id,
                buyer_id=raw.get("buyer_id") or event.buyer_id,
                contact_id=event.contact_id,
                interaction_id=event.interaction_id,
                details={
                    "send_mode": "bulk",
                    "company_name": company,
                    "to_email": to_email,
                    "subject": subject,
                    "mailbox_email": mailbox,
                    "source": source,
                    "parent_event_id": event.id,
                    "batch_summary": False,
                },
                read_at=event.read_at or datetime.now(timezone.utc),
                created_at=event.created_at,
            )
            # Unique negative id derived from parent + index.
            parent_id = int(event.id or 0)
            object.__setattr__(synthetic, "id", -(parent_id * 1000 + idx + 1))
            expanded.append(synthetic)
            made += 1
        if made == 0:
            expanded.append(event)
    return expanded


def mark_read(
    db: Session,
    event_ids: list[int] | None = None,
    *,
    mark_all: bool = False,
    user_id: int | None = None,
    is_admin: bool = False,
    channel: ActivityChannel | None = None,
) -> int:
    now = datetime.now(timezone.utc)
    query = _scoped_query(db, user_id=user_id, is_admin=is_admin, channel=channel).filter(
        EmailActivityEvent.read_at.is_(None)
    )
    if mark_all:
        updated = query.update({EmailActivityEvent.read_at: now}, synchronize_session=False)
    elif event_ids:
        updated = query.filter(EmailActivityEvent.id.in_(event_ids)).update(
            {EmailActivityEvent.read_at: now},
            synchronize_session=False,
        )
    else:
        return 0
    db.commit()
    return int(updated or 0)


WHATSAPP_EVENT_LABELS: dict[str, str] = {
    "sent": "Sent",
    "send_failed": "Failed",
    "bulk_started": "Bulk started",
    "bulk_completed": "Bulk completed",
    "bulk_partial": "Bulk partial",
    "invalid_recipient": "Invalid recipient",
}


def _is_whatsapp_event(event: EmailActivityEvent) -> bool:
    details = event.details if isinstance(event.details, dict) else {}
    title = event.title or ""
    channel = str(details.get("channel") or "").lower()
    return (
        channel == "whatsapp"
        or title.startswith("WhatsApp")
        or title.startswith("Bulk WhatsApp")
        or "WhatsApp" in title
    )


def _whatsapp_event_label(event: EmailActivityEvent) -> str:
    if event.event_type in WHATSAPP_EVENT_LABELS:
        return WHATSAPP_EVENT_LABELS[event.event_type]
    return event.event_type.replace("_", " ").title()


def _event_label(
    event: EmailActivityEvent,
    *,
    channel: ActivityChannel | None = None,
) -> str:
    if channel == "whatsapp" or _is_whatsapp_event(event):
        return _whatsapp_event_label(event)
    catalog = EVENT_CATALOG.get(event.event_type, {})
    return catalog.get("label", event.event_type.replace("_", " ").title())


def event_to_dict(
    event: EmailActivityEvent,
    *,
    actor: AppUser | None = None,
    channel: ActivityChannel | None = None,
) -> dict[str, Any]:
    return {
        "id": event.id,
        "event_type": event.event_type,
        "event_label": _event_label(event, channel=channel),
        "severity": event.severity,
        "title": event.title,
        "message": event.message,
        "user_id": event.user_id,
        "user_username": actor.username if actor else None,
        "user_full_name": (actor.full_name if actor else None) or None,
        "buyer_id": event.buyer_id,
        "contact_id": event.contact_id,
        "interaction_id": event.interaction_id,
        "details": event.details or {},
        "read_at": event.read_at.isoformat() if event.read_at else None,
        "created_at": event.created_at.isoformat() if event.created_at else None,
    }


def actors_for_events(db: Session, events: list[EmailActivityEvent]) -> dict[int, AppUser]:
    user_ids = {e.user_id for e in events if e.user_id is not None}
    if not user_ids:
        return {}
    rows = db.query(AppUser).filter(AppUser.id.in_(user_ids)).all()
    return {row.id: row for row in rows}


def catalog_list() -> list[dict[str, str]]:
    return [
        {
            "event_type": key,
            "label": meta["label"],
            "description": meta["description"],
            "severity": SEVERITY_BY_TYPE.get(key, "info"),
        }
        for key, meta in EVENT_CATALOG.items()
    ]


_FAIL_TYPES = {
    "send_failed",
    "mailbox_not_configured",
    "invalid_recipient",
    "authentication_failed",
    "network_error",
    "attachment_rejected",
    "rate_limited",
    "blocked",
}


def _activity_window_bounds(
    *,
    days: int | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
) -> tuple[datetime | None, datetime | None]:
    from datetime import date, time, timedelta

    def _parse_day(value: str | None, *, end_of_day: bool) -> datetime | None:
        if not value:
            return None
        raw = value.strip()
        if not raw:
            return None
        try:
            day = date.fromisoformat(raw[:10])
        except ValueError as exc:
            raise ValueError(f"Invalid date '{value}'. Use YYYY-MM-DD.") from exc
        if end_of_day:
            return datetime.combine(day, time(23, 59, 59, 999999), tzinfo=timezone.utc)
        return datetime.combine(day, time.min, tzinfo=timezone.utc)

    if date_from or date_to:
        since = _parse_day(date_from, end_of_day=False)
        until = _parse_day(date_to, end_of_day=True)
        if since and until and until < since:
            raise ValueError("date_to must be on or after date_from")
        return since, until
    if days is not None and int(days) > 0:
        since = datetime.now(timezone.utc) - timedelta(days=max(1, min(int(days), 3650)))
        return since, None
    return None, None


def _replied_drill_rows(
    db: Session,
    *,
    user_id: int | None,
    is_admin: bool,
    channel: ActivityChannel | None,
    mode_key: str,
    days: int | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
) -> list[EmailActivityEvent]:
    """Build Replies drill list matching Insights (events + inbound interactions)."""
    from db.models import Buyer, Channel, Contact, Direction, Interaction

    since, until = _activity_window_bounds(days=days, date_from=date_from, date_to=date_to)
    base = _scoped_query(db, user_id=user_id, is_admin=is_admin, channel=channel)
    if since is not None:
        base = base.filter(EmailActivityEvent.created_at >= since)
    if until is not None:
        base = base.filter(EmailActivityEvent.created_at <= until)

    def _row_mode(event: EmailActivityEvent) -> str:
        details = event.details if isinstance(event.details, dict) else {}
        raw = str(details.get("send_mode") or "individual").strip().lower()
        return "bulk" if raw == "bulk" else "individual"

    sent_contacts: set[int] = set()
    for event in base.filter(EmailActivityEvent.event_type == "sent").all():
        if _row_mode(event) != mode_key:
            continue
        if event.contact_id:
            sent_contacts.add(int(event.contact_id))

    seen_contacts: set[int] = set()
    merged: list[EmailActivityEvent] = []

    for event in (
        base.filter(EmailActivityEvent.event_type == "replied")
        .order_by(EmailActivityEvent.created_at.desc())
        .all()
    ):
        if _row_mode(event) != mode_key:
            continue
        if event.contact_id:
            seen_contacts.add(int(event.contact_id))
        merged.append(event)

    if channel != "whatsapp" and sent_contacts:
        inbound_q = (
            db.query(Interaction, Contact, Buyer)
            .join(Contact, Contact.id == Interaction.contact_id)
            .join(Buyer, Buyer.id == Contact.buyer_id)
            .filter(
                Interaction.channel == Channel.email,
                Interaction.direction == Direction.inbound,
                Interaction.contact_id.in_(sent_contacts),
            )
        )
        if since is not None:
            inbound_q = inbound_q.filter(Interaction.created_at >= since)
        if until is not None:
            inbound_q = inbound_q.filter(Interaction.created_at <= until)
        inbound_rows = inbound_q.order_by(Interaction.created_at.desc()).all()

        for interaction, contact, buyer in inbound_rows:
            cid = int(contact.id)
            if cid in seen_contacts:
                continue
            seen_contacts.add(cid)
            preview = (interaction.content or "").strip().replace("\n", " ")
            if len(preview) > 220:
                preview = preview[:217] + "…"
            company = buyer.company_name or contact.full_name or "Contact"
            synthetic = EmailActivityEvent(
                event_type="replied",
                severity="success",
                title=f"Reply — {company}",
                message=preview or "Inbound reply recorded for this contact.",
                user_id=user_id,
                buyer_id=buyer.id,
                contact_id=contact.id,
                interaction_id=interaction.id,
                details={
                    "send_mode": mode_key,
                    "company_name": company,
                    "to_email": contact.email,
                    "subject": interaction.subject,
                    "source": "inbound_interaction",
                },
                read_at=datetime.now(timezone.utc),
                created_at=interaction.created_at or datetime.now(timezone.utc),
            )
            # Ephemeral row for the feed — negative id avoids colliding with DB rows.
            object.__setattr__(synthetic, "id", -int(interaction.id))
            merged.append(synthetic)

    merged.sort(
        key=lambda e: e.created_at or datetime.min.replace(tzinfo=timezone.utc),
        reverse=True,
    )
    return merged


def sync_replies_from_mailbox(
    db: Session,
    *,
    user: AppUser,
    days: int | None = 7,
) -> int:
    """Match recent IMAP inbox messages to outbound sends and record `replied` events.

    Email Activity Replies previously only counted CRM Interaction inbound rows
    (WhatsApp-style). Real email replies live in IMAP and never created those rows.
    """
    from datetime import timedelta

    from modules import inbox as inbox_module
    from modules.mailbox_accounts import resolve_user_mailbox

    account = resolve_user_mailbox(user)
    if not account:
        return 0

    window_days = max(1, min(int(days or 7), 90))
    since = datetime.now(timezone.utc) - timedelta(days=window_days)

    sent_rows = (
        db.query(EmailActivityEvent)
        .filter(
            EmailActivityEvent.event_type == "sent",
            EmailActivityEvent.created_at >= since,
            EmailActivityEvent.user_id == user.id,
        )
        .order_by(EmailActivityEvent.created_at.desc())
        .limit(400)
        .all()
    )
    if not sent_rows:
        return 0

    # Map recipient email → most recent matching sent event.
    outbound_by_email: dict[str, EmailActivityEvent] = {}
    for event in sent_rows:
        details = event.details if isinstance(event.details, dict) else {}
        to_email = str(details.get("to_email") or details.get("recipient") or "").strip().lower()
        if not to_email or "@" not in to_email:
            continue
        if to_email not in outbound_by_email:
            outbound_by_email[to_email] = event

    if not outbound_by_email:
        return 0

    try:
        inbox_msgs = inbox_module.list_messages(
            user, limit=80, offset=0, folder="inbox", unread_only=False
        )
    except Exception:  # noqa: BLE001
        return 0

    mailbox = (account.email or "").strip().lower()
    recorded = 0
    for msg in inbox_msgs:
        if not inbox_module._message_is_inbound(msg, mailbox):  # noqa: SLF001
            continue
        from_email = str(msg.get("from_email") or "").strip().lower()
        if not from_email or from_email not in outbound_by_email:
            continue
        sent_event = outbound_by_email[from_email]
        details = sent_event.details if isinstance(sent_event.details, dict) else {}
        mode = str(details.get("send_mode") or "individual").strip().lower()
        if mode != "bulk":
            mode = "individual"

        contact_id = sent_event.contact_id
        already = False
        if contact_id:
            already = (
                db.query(EmailActivityEvent)
                .filter(
                    EmailActivityEvent.event_type == "replied",
                    EmailActivityEvent.created_at >= since,
                    EmailActivityEvent.user_id == user.id,
                    EmailActivityEvent.contact_id == contact_id,
                )
                .first()
                is not None
            )
        else:
            for e in (
                db.query(EmailActivityEvent)
                .filter(
                    EmailActivityEvent.event_type == "replied",
                    EmailActivityEvent.created_at >= since,
                    EmailActivityEvent.user_id == user.id,
                )
                .all()
            ):
                if str((e.details or {}).get("to_email") or "").strip().lower() == from_email:
                    already = True
                    break
        if already:
            continue

        subject = str(msg.get("subject") or details.get("subject") or "").strip()
        preview = str(msg.get("preview") or "").strip()
        company = str(details.get("company_name") or from_email)
        record_event(
            db,
            event_type="replied",
            title=f"Reply — {company}",
            message=preview or f"Inbound reply from {from_email}.",
            user_id=user.id,
            buyer_id=sent_event.buyer_id,
            contact_id=contact_id,
            interaction_id=sent_event.interaction_id,
            details={
                "send_mode": mode,
                "to_email": from_email,
                "subject": subject,
                "company_name": company,
                "source": "imap_inbox",
                "mailbox_email": mailbox or None,
            },
        )
        recorded += 1

    return recorded


def insights_stats(
    db: Session,
    *,
    days: int | None = 30,
    date_from: str | None = None,
    date_to: str | None = None,
    user_id: int | None = None,
    is_admin: bool = False,
    channel: ActivityChannel | None = "email",
    sync_user: AppUser | None = None,
) -> dict[str, Any]:
    """Aggregate outbound activity into bulk vs individual insight cards."""
    from datetime import date, time, timedelta

    # Pull IMAP replies into activity events so Replies cards are accurate.
    if channel != "whatsapp" and sync_user is not None:
        try:
            sync_window = days if days and days > 0 else 7
            if date_from or date_to:
                sync_window = 30
            sync_replies_from_mailbox(db, user=sync_user, days=min(int(sync_window), 30))
        except Exception:  # noqa: BLE001
            pass

    query = _scoped_query(db, user_id=user_id, is_admin=is_admin, channel=channel)
    since = None
    until = None
    period_days = days

    def _parse_day(value: str | None, *, end_of_day: bool) -> datetime | None:
        if not value:
            return None
        raw = value.strip()
        if not raw:
            return None
        try:
            day = date.fromisoformat(raw[:10])
        except ValueError as exc:
            raise ValueError(f"Invalid date '{value}'. Use YYYY-MM-DD.") from exc
        if end_of_day:
            return datetime.combine(day, time(23, 59, 59, 999999), tzinfo=timezone.utc)
        return datetime.combine(day, time.min, tzinfo=timezone.utc)

    if date_from or date_to:
        since = _parse_day(date_from, end_of_day=False)
        until = _parse_day(date_to, end_of_day=True)
        if since and until and until < since:
            raise ValueError("date_to must be on or after date_from")
        if since is not None:
            query = query.filter(EmailActivityEvent.created_at >= since)
        if until is not None:
            query = query.filter(EmailActivityEvent.created_at <= until)
        if since and until:
            period_days = max(1, (until.date() - since.date()).days + 1)
        else:
            period_days = None
    elif days and days > 0:
        since = datetime.now(timezone.utc) - timedelta(days=days)
        query = query.filter(EmailActivityEvent.created_at >= since)
        period_days = days
    else:
        period_days = None

    rows = list(query.all())

    # Include opens that were stored without user_id but belong to this user's sends
    # (older bulk/mailer paths). Admins already see all rows via _scoped_query.
    if user_id is not None and not is_admin:
        sent_interaction_ids = {
            e.interaction_id
            for e in rows
            if e.event_type == "sent" and e.interaction_id is not None
        }
        if sent_interaction_ids:
            seen_open_ids = {e.id for e in rows if e.event_type == "opened"}
            orphan_q = db.query(EmailActivityEvent).filter(
                EmailActivityEvent.event_type == "opened",
                EmailActivityEvent.interaction_id.in_(sent_interaction_ids),
                EmailActivityEvent.user_id.is_(None),
            )
            if since is not None:
                orphan_q = orphan_q.filter(EmailActivityEvent.created_at >= since)
            if until is not None:
                orphan_q = orphan_q.filter(EmailActivityEvent.created_at <= until)
            for orphan in orphan_q.all():
                if orphan.id not in seen_open_ids:
                    rows.append(orphan)

    individual_sent = 0
    individual_failed = 0
    individual_opened = 0
    individual_replied = 0
    bulk_sent = 0
    bulk_failed = 0
    bulk_opened = 0
    bulk_replied = 0
    bulk_batches = 0
    bulk_batches_partial = 0
    bulk_batches_failed = 0
    individual_sent_contacts: set[int] = set()
    bulk_sent_contacts: set[int] = set()
    replied_contacts_seen: set[int] = set()

    for event in rows:
        details = event.details or {}
        mode = str(details.get("send_mode") or "").lower()
        et = event.event_type
        contact_id = event.contact_id

        if et == "opened":
            if mode == "bulk":
                bulk_opened += 1
            else:
                individual_opened += 1
            continue

        if et == "replied":
            if mode == "bulk":
                bulk_replied += 1
            else:
                individual_replied += 1
            if contact_id:
                replied_contacts_seen.add(int(contact_id))
            continue

        if et in ("bulk_completed", "bulk_partial"):
            bulk_batches += 1
            if et == "bulk_partial":
                bulk_batches_partial += 1
            try:
                bulk_sent += int(details.get("sent_count") or 0)
            except (TypeError, ValueError):
                pass
            try:
                bulk_failed += int(details.get("failed_count") or 0)
            except (TypeError, ValueError):
                pass
            continue

        if et == "bulk_started":
            continue

        if et == "sent":
            if mode == "bulk":
                bulk_sent += 1
                if contact_id:
                    bulk_sent_contacts.add(int(contact_id))
            else:
                individual_sent += 1
                if contact_id:
                    individual_sent_contacts.add(int(contact_id))
            continue

        if et in _FAIL_TYPES:
            # Bulk batch-level total failure (0 sent)
            if et == "send_failed" and (
                "sent_count" in details or "failed_count" in details or "interaction_ids" in details
            ):
                bulk_batches += 1
                bulk_batches_failed += 1
                try:
                    bulk_failed += int(details.get("failed_count") or 0)
                except (TypeError, ValueError):
                    pass
            elif mode == "bulk":
                bulk_failed += 1
            else:
                individual_failed += 1

    # Supplement replies: inbound email interactions to contacts we emailed in-window.
    # Does not touch IMAP — uses Interaction rows already stored by the app.
    try:
        from db.models import Channel, Direction, Interaction

        outbound_contacts = individual_sent_contacts | bulk_sent_contacts
        if outbound_contacts and channel != "whatsapp":
            inbound_q = db.query(Interaction.contact_id).filter(
                Interaction.channel == Channel.email,
                Interaction.direction == Direction.inbound,
                Interaction.contact_id.in_(outbound_contacts),
            )
            if since is not None:
                inbound_q = inbound_q.filter(Interaction.created_at >= since)
            if until is not None:
                inbound_q = inbound_q.filter(Interaction.created_at <= until)
            for (cid,) in inbound_q.distinct().all():
                if cid is None or int(cid) in replied_contacts_seen:
                    continue
                replied_contacts_seen.add(int(cid))
                if int(cid) in bulk_sent_contacts and int(cid) not in individual_sent_contacts:
                    bulk_replied += 1
                elif int(cid) in individual_sent_contacts:
                    individual_replied += 1
                elif int(cid) in bulk_sent_contacts:
                    bulk_replied += 1
    except Exception:  # noqa: BLE001
        pass

    individual_total = individual_sent + individual_failed
    bulk_total = bulk_sent + bulk_failed
    total_sent = individual_sent + bulk_sent
    total_failed = individual_failed + bulk_failed
    total_opened = individual_opened + bulk_opened
    total_replied = individual_replied + bulk_replied
    total_attempted = total_sent + total_failed
    not_opened = max(0, total_sent - total_opened)

    def _rate(part: int, whole: int) -> float:
        if whole <= 0:
            return 0.0
        return round((part / whole) * 100.0, 1)

    from modules.email_tracking import public_api_base

    tracking_base = public_api_base()

    return {
        "period_days": period_days,
        "since": since.isoformat() if since else None,
        "until": until.isoformat() if until else None,
        "tracking_enabled": bool(tracking_base),
        "tracking_base_url": tracking_base,
        "tracking_pixel_path": "/api/track/email-open/{token}.gif",
        "totals": {
            "attempted": total_attempted,
            "sent": total_sent,
            "failed": total_failed,
            "opened": total_opened,
            "replied": total_replied,
            "not_opened": not_opened,
            "open_rate_pct": _rate(total_opened, total_sent),
            "reply_rate_pct": _rate(total_replied, total_sent),
            "success_rate_pct": _rate(total_sent, total_attempted),
        },
        "individual": {
            "attempted": individual_total,
            "sent": individual_sent,
            "failed": individual_failed,
            "opened": individual_opened,
            "replied": individual_replied,
            "not_opened": max(0, individual_sent - individual_opened),
            "open_rate_pct": _rate(individual_opened, individual_sent),
            "reply_rate_pct": _rate(individual_replied, individual_sent),
            "success_rate_pct": _rate(individual_sent, individual_total),
        },
        "bulk": {
            "batches": bulk_batches,
            "batches_partial": bulk_batches_partial,
            "batches_failed": bulk_batches_failed,
            "attempted": bulk_total,
            "sent": bulk_sent,
            "failed": bulk_failed,
            "opened": bulk_opened,
            "replied": bulk_replied,
            "not_opened": max(0, bulk_sent - bulk_opened),
            "open_rate_pct": _rate(bulk_opened, bulk_sent),
            "reply_rate_pct": _rate(bulk_replied, bulk_sent),
            "success_rate_pct": _rate(bulk_sent, bulk_total),
        },
        "event_count": len(rows),
    }


def _insights_context_blob(stats: dict[str, Any]) -> str:
    totals = stats.get("totals") or {}
    individual = stats.get("individual") or {}
    bulk = stats.get("bulk") or {}
    period = stats.get("period_days")
    since = stats.get("since") or "n/a"
    until = stats.get("until") or "now"
    period_label = f"last {period} days" if period else f"{since} → {until}"
    return (
        f"Period: {period_label}\n"
        f"Tracking enabled: {stats.get('tracking_enabled')}\n\n"
        f"TOTALS — sent={totals.get('sent')}, failed={totals.get('failed')}, "
        f"opened={totals.get('opened')}, replied={totals.get('replied')}, "
        f"not_opened={totals.get('not_opened')}, open_rate={totals.get('open_rate_pct')}%, "
        f"reply_rate={totals.get('reply_rate_pct')}%, success_rate={totals.get('success_rate_pct')}%\n\n"
        f"INDIVIDUAL — sent={individual.get('sent')}, failed={individual.get('failed')}, "
        f"opened={individual.get('opened')}, replied={individual.get('replied')}, "
        f"open_rate={individual.get('open_rate_pct')}%, reply_rate={individual.get('reply_rate_pct')}%\n\n"
        f"BULK — batches={bulk.get('batches')}, sent={bulk.get('sent')}, failed={bulk.get('failed')}, "
        f"opened={bulk.get('opened')}, replied={bulk.get('replied')}, "
        f"open_rate={bulk.get('open_rate_pct')}%, reply_rate={bulk.get('reply_rate_pct')}%"
    )


def analyze_email_activity(
    db: Session,
    *,
    days: int | None = 30,
    date_from: str | None = None,
    date_to: str | None = None,
    user_id: int | None = None,
    is_admin: bool = False,
    sync_user: AppUser | None = None,
) -> dict[str, Any]:
    """LLM summary of Email Activity insights for the selected window."""
    from modules.llm_client import llm_client

    period = None if days is not None and int(days) <= 0 else (days if days is not None else 30)
    if date_from or date_to:
        period = None
    stats = insights_stats(
        db,
        days=period,
        date_from=date_from,
        date_to=date_to,
        user_id=user_id,
        is_admin=is_admin,
        channel="email",
        sync_user=sync_user,
    )
    blob = _insights_context_blob(stats)
    system = (
        "You are a sales email performance analyst for Kafi Commodities, a Pakistani food exporter "
        "(rice, chutney, sauces, pickles, Himalayan pink salt, spices). "
        "Write a clear, practical analysis for a sales rep — not marketing fluff."
    )
    prompt = (
        "Analyze this outbound email activity. Cover:\n"
        "1) Overall health (send success, opens, replies)\n"
        "2) Individual vs bulk differences\n"
        "3) Likely causes of weak opens/replies or high failures\n"
        "4) 3–5 prioritized next actions\n\n"
        "Use short paragraphs and bullet points. No markdown tables.\n\n"
        f"DATA:\n{blob}"
    )
    if not llm_client.enabled:
        return {
            "kind": "analysis",
            "title": "AI analysis",
            "content": (
                "LLM is not configured. Add GEMINI_API_KEY to enable AI analysis.\n\n"
                f"Snapshot:\n{blob}"
            ),
            "stats": stats,
        }
    try:
        content = llm_client.generate(prompt, system=system).strip()
    except Exception as exc:  # noqa: BLE001
        content = f"AI analysis failed: {exc}\n\nSnapshot:\n{blob}"
    return {
        "kind": "analysis",
        "title": "AI analysis",
        "content": content,
        "stats": stats,
    }


def suggest_email_improvements(
    db: Session,
    *,
    days: int | None = 30,
    date_from: str | None = None,
    date_to: str | None = None,
    user_id: int | None = None,
    is_admin: bool = False,
    sync_user: AppUser | None = None,
) -> dict[str, Any]:
    """LLM suggestions to improve outbound email performance."""
    from modules.llm_client import llm_client

    period = None if days is not None and int(days) <= 0 else (days if days is not None else 30)
    if date_from or date_to:
        period = None
    stats = insights_stats(
        db,
        days=period,
        date_from=date_from,
        date_to=date_to,
        user_id=user_id,
        is_admin=is_admin,
        channel="email",
        sync_user=sync_user,
    )
    blob = _insights_context_blob(stats)
    system = (
        "You are an outbound email coach for Kafi Commodities (B2B food export: rice, sauces, "
        "pickles, Himalayan salt, spices). Suggest concrete copy and process improvements. "
        "Every message remains a draft until a human approves — never imply auto-send."
    )
    prompt = (
        "Based on these Email Activity stats, give practical suggestions to improve email results.\n"
        "Include:\n"
        "- Subject line ideas (3–5)\n"
        "- Opening line / value-prop tips for importers and distributors\n"
        "- When to prefer individual vs bulk\n"
        "- Follow-up timing after opens with no reply\n"
        "- How to reduce failures (list hygiene, mailbox setup)\n\n"
        "Keep it actionable and short. Bullet points preferred.\n\n"
        f"DATA:\n{blob}"
    )
    if not llm_client.enabled:
        return {
            "kind": "suggestions",
            "title": "Suggestion to improve email",
            "content": (
                "LLM is not configured. Add GEMINI_API_KEY to enable suggestions.\n\n"
                "Quick checklist without AI:\n"
                "- Personalize individual emails for HOT/AAAA leads; use bulk for nurture lists\n"
                "- Lead with product fit (rice / salt / sauces) and certifications (Halal, ISO, HACCP)\n"
                "- Follow up 3–5 days after an open with no reply\n"
                "- Fix mailbox auth and invalid recipients to cut failures\n"
                f"\nSnapshot:\n{blob}"
            ),
            "stats": stats,
        }
    try:
        content = llm_client.generate(prompt, system=system).strip()
    except Exception as exc:  # noqa: BLE001
        content = f"Suggestions failed: {exc}\n\nSnapshot:\n{blob}"
    return {
        "kind": "suggestions",
        "title": "Suggestion to improve email",
        "content": content,
        "stats": stats,
    }


# --------------------------------------------------------------------------- bulk results (per contact)


def _reconstruct_whatsapp_bulk(db: Session, event: EmailActivityEvent) -> list[dict[str, Any]]:
    """Older WhatsApp bulk summaries stored only counts. Rebuild per-contact results from the
    matching "bulk started" event (the selected buyer ids) and the messages created in that window."""
    from datetime import timedelta

    from db.models import Buyer, Channel, Contact, Direction, Interaction
    from modules.email_attachments import whatsapp_send_error

    details = event.details if isinstance(event.details, dict) else {}
    started = (
        db.query(EmailActivityEvent)
        .filter(
            EmailActivityEvent.event_type == "bulk_started",
            EmailActivityEvent.user_id == event.user_id,
            EmailActivityEvent.created_at <= event.created_at,
            _is_whatsapp_event_clause(),
        )
        .order_by(EmailActivityEvent.created_at.desc())
        .first()
    )
    started_details = started.details if started is not None and isinstance(started.details, dict) else {}
    buyer_ids = [int(b) for b in (started_details.get("buyer_ids") or []) if str(b).isdigit()]
    if started is None or not buyer_ids:
        return []
    window_start = started.created_at
    window_end = event.created_at + timedelta(minutes=2)

    skipped_by_buyer: dict[int, dict[str, Any]] = {}
    for sk in details.get("skipped") or []:
        if isinstance(sk, dict) and sk.get("buyer_id") is not None:
            skipped_by_buyer[int(sk["buyer_id"])] = sk

    rows = (
        db.query(Interaction, Contact)
        .join(Contact, Interaction.contact_id == Contact.id)
        .filter(
            Contact.buyer_id.in_(buyer_ids),
            Interaction.channel == Channel.whatsapp,
            Interaction.direction == Direction.outbound,
            Interaction.created_at >= window_start,
            Interaction.created_at <= window_end,
        )
        .order_by(Interaction.created_at.desc())
        .all()
    )
    latest: dict[int, tuple[Any, Any]] = {}
    for ix, contact in rows:
        latest.setdefault(int(contact.buyer_id), (ix, contact))

    buyers = {b.id: b for b in db.query(Buyer).filter(Buyer.id.in_(buyer_ids)).all()}
    out: list[dict[str, Any]] = []
    for bid in buyer_ids:
        buyer = buyers.get(bid)
        company = buyer.company_name if buyer is not None else None
        if bid in latest:
            ix, contact = latest[bid]
            wa = str(ix.wa_status or "").lower()
            status_value = getattr(ix.status, "value", str(ix.status))
            sent = wa in {"sent", "delivered", "read"} or (status_value == "sent" and wa != "failed")
            out.append(
                {
                    "buyer_id": bid,
                    "company_name": company,
                    "contact_name": contact.full_name,
                    "phone": (
                        contact.phone
                        or contact.primary_phone
                        or contact.secondary_mobile
                        or contact.secondary_phone
                    ),
                    "status": "sent" if sent else "failed",
                    "message": "" if sent else (whatsapp_send_error(ix.attachments) or "Not delivered"),
                }
            )
        elif bid in skipped_by_buyer:
            out.append(
                {
                    "buyer_id": bid,
                    "company_name": company or skipped_by_buyer[bid].get("company_name"),
                    "contact_name": None,
                    "phone": None,
                    "status": "skipped",
                    "message": str(skipped_by_buyer[bid].get("reason") or "Skipped"),
                }
            )
        else:
            out.append(
                {
                    "buyer_id": bid,
                    "company_name": company,
                    "contact_name": None,
                    "phone": None,
                    "status": "unknown",
                    "message": "No message record was found for this contact.",
                }
            )
    return out


def bulk_results_for_event(
    db: Session,
    *,
    event_id: int,
    viewer_id: int | None,
    is_admin: bool,
) -> dict[str, Any] | None:
    """Per-contact sent / failed / skipped list for a bulk campaign summary event."""
    event = db.get(EmailActivityEvent, event_id)
    if event is None:
        return None
    if not is_admin and event.user_id != viewer_id:
        return None

    details = event.details if isinstance(event.details, dict) else {}
    channel = "whatsapp" if _is_whatsapp_event(event) else "email"
    results = details.get("results")
    reconstructed = False
    if not isinstance(results, list) or not results:
        results = []
        if channel == "whatsapp" and event.event_type in ("bulk_partial", "bulk_completed", "send_failed"):
            try:
                results = _reconstruct_whatsapp_bulk(db, event)
                reconstructed = True
            except Exception:  # noqa: BLE001
                results = []
        elif channel == "email":
            for raw in details.get("failures") or []:
                if not isinstance(raw, dict):
                    continue
                results.append(
                    {
                        "buyer_id": raw.get("buyer_id"),
                        "company_name": raw.get("company_name"),
                        "contact_name": None,
                        "phone": None,
                        "email": raw.get("to_email") or raw.get("email"),
                        "status": "failed",
                        "message": raw.get("error") or raw.get("send_message") or raw.get("message") or "Send failed",
                    }
                )

    counts = {
        s: sum(1 for r in results if isinstance(r, dict) and r.get("status") == s)
        for s in ("sent", "failed", "skipped", "unknown")
    }
    return {
        "event_id": event.id,
        "title": event.title,
        "channel": channel,
        "created_at": event.created_at.isoformat() if event.created_at else None,
        "selected_count": details.get("selected_count"),
        "reconstructed": reconstructed,
        "counts": counts,
        "results": results,
    }
