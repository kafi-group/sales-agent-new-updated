"""Row-by-row detail behind the KPI boxes that open onto a single summary line.

The KPI drill-down list is built from the work log (``user_activity_events``), but the personal and
bulk email / WhatsApp numbers are counted from ``email_activity_events`` (see
``modules.activity._email_send_counts_by_user``). A bulk campaign is ONE log row for many contacts,
so a box could say "2" and open onto one line. This module lists one row per contact instead,
using the same rules the counts use, in the shape the drill-down table already renders.
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone
from typing import Any

from sqlalchemy.orm import Session, joinedload

from db.models import (
    AppUser,
    AppUserRole,
    Buyer,
    Channel,
    Contact,
    Direction,
    EmailActivityEvent,
    Interaction,
    InteractionStatus,
    UserActivityEvent,
)
from modules import activity as activity_module

logger = logging.getLogger(__name__)

SUPPORTED_CARDS = {
    "personal_emails_sent",
    "bulk_emails_sent",
    "personal_whatsapp_sent",
    "bulk_whatsapp_sent",
    "leads_imported",
}
_MAX_ROWS = 1000


def _scope(db: Session, viewer: AppUser, user_id: int | None) -> int | None:
    """Same visibility rule as the KPI report: non-admins see only themselves."""
    role = viewer.role.value if isinstance(viewer.role, AppUserRole) else str(viewer.role)
    if role != AppUserRole.admin.value:
        return viewer.id
    if user_id is not None and db.get(AppUser, user_id) is None:
        raise ValueError("User not found")
    return user_id


def _row(
    *,
    row_id: int,
    agent: AppUser | None,
    created_at: Any,
    activity_type: str,
    title: str,
    summary: str,
    company_name: str | None = None,
    contact_name: str | None = None,
    designation: str | None = None,
    country: str | None = None,
    phone: str | None = None,
    remarks: str | None = None,
    details: dict | None = None,
) -> dict[str, Any]:
    return {
        "id": row_id,
        "user_id": agent.id if agent is not None else 0,
        "username": agent.username if agent is not None else None,
        "full_name": agent.full_name if agent is not None else None,
        "activity_type": activity_type,
        "title": title,
        "summary": summary,
        "quantity": 1,
        "entity_type": None,
        "entity_id": None,
        "details": details or {},
        "created_at": created_at,
        "company_name": company_name,
        "contact_name": contact_name,
        "contact_designation": designation,
        "country": country,
        "phone": phone,
        "outcome": None,
        "remarks": remarks,
        "duration_seconds": None,
    }


def _plain_text(value: Any, limit: int = 600) -> str:
    """A message body as readable text: tags removed, blank runs collapsed, cut to ``limit``."""
    import html as html_lib
    import re

    text = str(value or "")
    text = re.sub(r"(?is)<(script|style).*?</\1>", " ", text)
    text = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</li>", "\n", text)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html_lib.unescape(text)
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n", text).strip()  # no blank lines: keeps the rows short
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


NO_COMPANY_LABEL = "(no company name saved)"


def _company_label(*names: Any) -> str:
    """First non-blank company name; some imported records have an empty company and keep the
    business name only in the contact field, so say so instead of showing something unrelated."""
    for name in names:
        cleaned = str(name or "").strip()
        if cleaned:
            return cleaned
    return NO_COMPANY_LABEL


def _detail_text(*parts: str | None) -> str | None:
    joined = "\n".join(p for p in parts if p)
    return joined or None


def _contact_phone(contact: Any) -> str | None:
    if contact is None:
        return None
    return (
        getattr(contact, "phone", None)
        or getattr(contact, "primary_phone", None)
        or getattr(contact, "secondary_mobile", None)
        or getattr(contact, "secondary_phone", None)
        or None
    )


def _lookup_maps(db: Session, events: list[EmailActivityEvent]) -> tuple[dict, dict]:
    buyer_ids = {e.buyer_id for e in events if e.buyer_id}
    contact_ids = {e.contact_id for e in events if e.contact_id}
    buyers = (
        {b.id: b for b in db.query(Buyer).filter(Buyer.id.in_(buyer_ids)).all()} if buyer_ids else {}
    )
    contacts = (
        {c.id: c for c in db.query(Contact).filter(Contact.id.in_(contact_ids)).all()}
        if contact_ids
        else {}
    )
    return buyers, contacts


def _activity_events(
    db: Session,
    *,
    start_utc: datetime,
    end_utc: datetime,
    target_user_id: int | None,
    event_types: tuple[str, ...],
) -> list[EmailActivityEvent]:
    query = db.query(EmailActivityEvent).filter(
        EmailActivityEvent.created_at >= start_utc,
        EmailActivityEvent.created_at < end_utc,
        EmailActivityEvent.user_id.isnot(None),
        EmailActivityEvent.event_type.in_(event_types),
    )
    if target_user_id is not None:
        query = query.filter(EmailActivityEvent.user_id == target_user_id)
    return query.order_by(EmailActivityEvent.created_at.desc(), EmailActivityEvent.id.desc()).all()


def _logged_rows(
    db: Session,
    *,
    kind: str,
    start_utc: datetime,
    end_utc: datetime,
    target_user_id: int | None,
    users: dict[int, AppUser],
) -> list[dict[str, Any]]:
    """The work-log entries of one kind (the other half of the count, which takes the larger)."""
    query = db.query(UserActivityEvent).filter(
        UserActivityEvent.activity_type == kind,
        UserActivityEvent.created_at >= start_utc,
        UserActivityEvent.created_at < end_utc,
    )
    if target_user_id is not None:
        query = query.filter(UserActivityEvent.user_id == target_user_id)
    events = query.order_by(UserActivityEvent.created_at.desc(), UserActivityEvent.id.desc()).all()
    return [activity_module._activity_dict(ev, users.get(ev.user_id)) for ev in events]  # noqa: SLF001


def _personal_rows(
    db: Session,
    *,
    want_whatsapp: bool,
    start_utc: datetime,
    end_utc: datetime,
    target_user_id: int | None,
    users: dict[int, AppUser],
) -> list[dict[str, Any]]:
    events = []
    for event in _activity_events(
        db,
        start_utc=start_utc,
        end_utc=end_utc,
        target_user_id=target_user_id,
        event_types=("sent",),
    ):
        if bool(activity_module._is_whatsapp_activity_event(event)) != want_whatsapp:  # noqa: SLF001
            continue
        if str((event.details or {}).get("send_mode") or "").lower() == "bulk":
            continue
        events.append(event)

    kind = (
        activity_module.PERSONAL_WHATSAPP_SENT if want_whatsapp else activity_module.PERSONAL_EMAILS_SENT
    )
    rows = _send_event_rows(db, events, want_whatsapp=want_whatsapp, kind=kind, users=users)

    # The box shows the larger of this feed and the work log — list whichever is bigger.
    logged = _logged_rows(
        db,
        kind=kind,
        start_utc=start_utc,
        end_utc=end_utc,
        target_user_id=target_user_id,
        users=users,
    )
    return logged if len(logged) > len(rows) else rows


def _send_event_rows(
    db: Session,
    events: list[EmailActivityEvent],
    *,
    want_whatsapp: bool,
    kind: str,
    users: dict[int, AppUser],
) -> list[dict[str, Any]]:
    """One drill-down row per send record: company, contact, reach and the message text."""
    buyers, contacts = _lookup_maps(db, events)
    interaction_ids = {e.interaction_id for e in events if e.interaction_id}
    interactions = (
        {ix.id: ix for ix in db.query(Interaction).filter(Interaction.id.in_(interaction_ids)).all()}
        if interaction_ids
        else {}
    )
    rows: list[dict[str, Any]] = []
    for event in events:
        details = event.details or {}
        buyer = buyers.get(event.buyer_id) if event.buyer_id else None
        contact = contacts.get(event.contact_id) if event.contact_id else None
        interaction = interactions.get(event.interaction_id) if event.interaction_id else None
        body = _plain_text(interaction.content, 600) if interaction is not None else ""
        company = _company_label(
            buyer.company_name if buyer is not None else None,
            details.get("company_name"),
        )
        if want_whatsapp:
            reach = _contact_phone(contact) or details.get("phone") or details.get("to")
            template = (getattr(interaction, "template_name", None) or "") if interaction is not None else ""
            summary = f"Template: {template}" if template else (event.message or "WhatsApp message sent")
        else:
            reach = (
                details.get("to_email")
                or (getattr(contact, "email", None) if contact is not None else None)
            )
            subject = str(details.get("subject") or "").strip()
            summary = f"Subject: {subject}" if subject else (event.message or "Email sent")
            if event.interaction_id is not None:
                summary += " · sent after a call"
        rows.append(
            _row(
                row_id=int(event.id),
                agent=users.get(event.user_id),
                created_at=event.created_at,
                activity_type=kind,
                title=event.title,
                summary=summary,
                company_name=company,
                contact_name=(contact.full_name if contact is not None else None)
                or details.get("contact_name"),
                designation=getattr(contact, "designation", None) if contact is not None else None,
                country=buyer.country if buyer is not None else None,
                phone=str(reach) if reach else None,
                remarks=_detail_text(summary, body),
                details=details,
            )
        )
    return rows


def _email_bulk_from_interactions(
    db: Session, event: EmailActivityEvent, limit: int
) -> list[dict[str, Any]]:
    """Older bulk-email summaries stored only counts. Rebuild the recipients from the emails that
    were created for that campaign (same subject, inside the send window)."""
    subject = str((event.details or {}).get("subject") or "").strip()
    if not subject:
        return []
    started = (
        db.query(EmailActivityEvent)
        .filter(
            EmailActivityEvent.event_type == "bulk_started",
            EmailActivityEvent.user_id == event.user_id,
            EmailActivityEvent.created_at <= event.created_at,
        )
        .order_by(EmailActivityEvent.created_at.desc())
        .first()
    )
    window_start = (started.created_at if started is not None else event.created_at - timedelta(hours=1)) - timedelta(
        minutes=1
    )
    window_end = event.created_at + timedelta(minutes=2)
    found = (
        db.query(Interaction, Contact)
        .join(Contact, Interaction.contact_id == Contact.id)
        .filter(
            Interaction.channel == Channel.email,
            Interaction.direction == Direction.outbound,
            Interaction.status == InteractionStatus.sent,
            Interaction.subject == subject,
            Interaction.created_at >= window_start,
            Interaction.created_at <= window_end,
        )
        .order_by(Interaction.created_at.asc())
        .limit(max(1, limit))
        .all()
    )
    buyer_ids = {c.buyer_id for _, c in found if c.buyer_id}
    buyers = (
        {b.id: b for b in db.query(Buyer).filter(Buyer.id.in_(buyer_ids)).all()} if buyer_ids else {}
    )
    out: list[dict[str, Any]] = []
    for ix, contact in found:
        buyer = buyers.get(contact.buyer_id)
        out.append(
            {
                "buyer_id": contact.buyer_id,
                "company_name": buyer.company_name if buyer is not None else None,
                "contact_name": contact.full_name,
                "designation": contact.designation,
                "country": buyer.country if buyer is not None else None,
                "email": contact.email,
                "phone": None,
                "status": "sent",
                "message": "",
                "at": ix.created_at,
                "subject": subject,
                "content": _plain_text(ix.content, 600),
            }
        )
    return out


def _whatsapp_messages_for(
    db: Session, event: EmailActivityEvent, buyer_ids: set[int]
) -> dict[int, dict[str, Any]]:
    """The WhatsApp message each contact received in one bulk campaign (text, template, time)."""
    if not buyer_ids:
        return {}
    from modules.email_activity import _is_whatsapp_event_clause  # noqa: PLC2701

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
    window_start = (
        started.created_at if started is not None else event.created_at - timedelta(hours=2)
    ) - timedelta(minutes=1)
    window_end = event.created_at + timedelta(minutes=2)
    found = (
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
    latest: dict[int, dict[str, Any]] = {}
    for ix, contact in found:
        latest.setdefault(
            int(contact.buyer_id),
            {
                "content": _plain_text(ix.content, 600),
                "template": ix.template_name or "",
                "status": str(ix.wa_status or "").lower(),
                "at": ix.created_at,
            },
        )
    return latest


def _uncovered_logged_bulk_rows(
    db: Session,
    bulk_events: list[EmailActivityEvent],
    *,
    want_whatsapp: bool,
    kind: str,
    start_utc: datetime,
    end_utc: datetime,
    target_user_id: int | None,
    users: dict[int, AppUser],
) -> list[dict[str, Any]]:
    """Work-log "bulk" entries that have no campaign summary in the activity feed.

    A single-contact send made through the bulk route is logged as "bulk" in the work log but
    recorded as an individual send in the feed, so the box (which takes the larger count) includes
    it while the campaign list does not. Match each such entry to the send records just before it.
    """
    query = db.query(UserActivityEvent).filter(
        UserActivityEvent.activity_type == kind,
        UserActivityEvent.created_at >= start_utc,
        UserActivityEvent.created_at < end_utc,
    )
    if target_user_id is not None:
        query = query.filter(UserActivityEvent.user_id == target_user_id)

    rows: list[dict[str, Any]] = []
    used_event_ids: set[int] = set()
    for logged in query.order_by(UserActivityEvent.created_at.asc(), UserActivityEvent.id.asc()).all():
        covered = any(
            e.user_id == logged.user_id
            and abs((e.created_at - logged.created_at).total_seconds()) <= 300
            for e in bulk_events
        )
        if covered:
            continue
        quantity = max(1, int(logged.quantity or 1))
        singles: list[EmailActivityEvent] = []
        for candidate in _activity_events(
            db,
            start_utc=logged.created_at - timedelta(minutes=10),
            end_utc=logged.created_at + timedelta(minutes=1),
            target_user_id=logged.user_id,
            event_types=("sent",),
        ):
            if candidate.id in used_event_ids:
                continue
            if bool(activity_module._is_whatsapp_activity_event(candidate)) != want_whatsapp:  # noqa: SLF001
                continue
            singles.append(candidate)
            if len(singles) >= quantity:
                break
        if singles:
            used_event_ids.update(e.id for e in singles)
            rows.extend(
                _send_event_rows(db, singles, want_whatsapp=want_whatsapp, kind=kind, users=users)
            )
        else:
            row = activity_module._activity_dict(logged, users.get(logged.user_id))  # noqa: SLF001
            row["remarks"] = row.get("remarks") or "The individual recipients were not saved for this send."
            rows.append(row)
    return rows


def _bulk_rows(
    db: Session,
    *,
    want_whatsapp: bool,
    start_utc: datetime,
    end_utc: datetime,
    target_user_id: int | None,
    users: dict[int, AppUser],
) -> list[dict[str, Any]]:
    from modules.email_activity import bulk_results_for_event

    events = [
        e
        for e in _activity_events(
            db,
            start_utc=start_utc,
            end_utc=end_utc,
            target_user_id=target_user_id,
            event_types=("bulk_completed", "bulk_partial"),
        )
        if bool(activity_module._is_whatsapp_activity_event(e)) == want_whatsapp  # noqa: SLF001
    ]
    kind = activity_module.BULK_WHATSAPP_SENT if want_whatsapp else activity_module.BULK_EMAILS_SENT
    label = "WhatsApp" if want_whatsapp else "email"

    rows: list[dict[str, Any]] = []
    for event in events:
        details = event.details or {}
        try:
            sent_count = max(0, int(details.get("sent_count") or 0))
        except (TypeError, ValueError):
            sent_count = 0
        if sent_count == 0:
            continue
        agent = users.get(event.user_id)

        sent: list[dict[str, Any]] = []
        try:
            detail = bulk_results_for_event(db, event_id=event.id, viewer_id=None, is_admin=True)
            sent = [
                r
                for r in ((detail or {}).get("results") or [])
                if isinstance(r, dict) and r.get("status") == "sent"
            ]
            if not sent and not want_whatsapp:
                sent = _email_bulk_from_interactions(db, event, sent_count)
        except Exception:  # noqa: BLE001 - fall back to the summary line below
            logger.exception("KPI bulk detail failed for event %s", event.id)
            sent = []

        if not sent:
            rows.append(
                _row(
                    row_id=int(event.id),
                    agent=agent,
                    created_at=event.created_at,
                    activity_type=kind,
                    title=event.title,
                    summary=f"{sent_count} bulk {label} message{'s' if sent_count != 1 else ''} sent",
                    company_name=f"Bulk campaign — {sent_count} sent",
                    remarks="The individual recipients were not saved for this older send.",
                    details=details,
                )
            )
            continue

        buyer_ids = {int(r["buyer_id"]) for r in sent if str(r.get("buyer_id") or "").isdigit()}
        buyers = (
            {b.id: b for b in db.query(Buyer).filter(Buyer.id.in_(buyer_ids)).all()}
            if buyer_ids
            else {}
        )
        messages: dict[int, dict[str, Any]] = {}
        if want_whatsapp:
            try:
                messages = _whatsapp_messages_for(db, event, buyer_ids)
            except Exception:  # noqa: BLE001 - recipients still show without the message text
                logger.exception("KPI WhatsApp message lookup failed for event %s", event.id)
        for index, result in enumerate(sent):
            buyer = buyers.get(int(result["buyer_id"])) if str(result.get("buyer_id") or "").isdigit() else None
            reach = result.get("phone") if want_whatsapp else result.get("email")
            message = (
                messages.get(int(result["buyer_id"]))
                if want_whatsapp and str(result.get("buyer_id") or "").isdigit()
                else None
            ) or {}
            if want_whatsapp:
                template = message.get("template") or ""
                detail_line = f"Template: {template}" if template else "Bulk WhatsApp campaign"
                detail_body = message.get("content") or ""
            else:
                subject_line = str(result.get("subject") or details.get("subject") or "").strip()
                detail_line = f"Subject: {subject_line}" if subject_line else "Bulk email campaign"
                detail_body = str(result.get("content") or "")
            rows.append(
                _row(
                    row_id=int(event.id) * 10000 + index,
                    agent=agent,
                    created_at=message.get("at") or result.get("at") or event.created_at,
                    activity_type=kind,
                    title=event.title,
                    summary=detail_line,
                    remarks=_detail_text(detail_line, detail_body),
                    company_name=_company_label(
                        result.get("company_name"),
                        buyer.company_name if buyer is not None else None,
                    ),
                    contact_name=result.get("contact_name"),
                    designation=result.get("designation"),
                    country=result.get("country") or (buyer.country if buyer is not None else None),
                    phone=str(reach) if reach else None,
                    details={"event_id": event.id},
                )
            )

    rows.extend(
        _uncovered_logged_bulk_rows(
            db,
            events,
            want_whatsapp=want_whatsapp,
            kind=kind,
            start_utc=start_utc,
            end_utc=end_utc,
            target_user_id=target_user_id,
            users=users,
        )
    )
    return rows


def _leads_imported_rows(
    db: Session,
    *,
    start_utc: datetime,
    end_utc: datetime,
    target_user_id: int | None,
    users: dict[int, AppUser],
) -> list[dict[str, Any]]:
    query = db.query(UserActivityEvent).filter(
        UserActivityEvent.activity_type == activity_module.LEADS_IMPORTED,
        UserActivityEvent.created_at >= start_utc,
        UserActivityEvent.created_at < end_utc,
    )
    if target_user_id is not None:
        query = query.filter(UserActivityEvent.user_id == target_user_id)
    events = query.order_by(UserActivityEvent.created_at.desc(), UserActivityEvent.id.desc()).all()

    rows: list[dict[str, Any]] = []
    for event in events:
        agent = users.get(event.user_id)
        details = event.details or {}
        source = str(details.get("import_source") or "").strip()
        quantity = max(1, int(event.quantity or 1))
        buyers: list[Any] = []
        if source:
            buyers = (
                db.query(Buyer)
                .options(joinedload(Buyer.contacts))
                .filter(
                    Buyer.source == source,
                    Buyer.created_at >= event.created_at - timedelta(hours=12),
                    Buyer.created_at <= event.created_at + timedelta(minutes=2),
                )
                .order_by(Buyer.created_at.desc())
                .limit(min(quantity, _MAX_ROWS))
                .all()
            )
        if not buyers:
            rows.append(activity_module._activity_dict(event, agent))  # noqa: SLF001
            continue
        for buyer in buyers:
            contact = buyer.contacts[0] if getattr(buyer, "contacts", None) else None
            rows.append(
                _row(
                    row_id=int(event.id) * 10000 + int(buyer.id % 10000),
                    agent=agent,
                    created_at=buyer.created_at or event.created_at,
                    activity_type=activity_module.LEADS_IMPORTED,
                    title="Lead imported",
                    summary=f"Imported from {source}",
                    company_name=_company_label(buyer.company_name),
                    contact_name=contact.full_name if contact is not None else None,
                    designation=getattr(contact, "designation", None) if contact is not None else None,
                    country=buyer.country,
                    phone=_contact_phone(contact),
                    details={"buyer_id": buyer.id, "import_source": source},
                )
            )
    return rows


def get_card_rows(
    db: Session,
    *,
    card: str,
    report_date: date,
    viewer: AppUser,
    user_id: int | None = None,
    period: str = "day",
) -> list[dict[str, Any]]:
    if card not in SUPPORTED_CARDS:
        raise ValueError("This box does not have a per-contact list")
    target_user_id = _scope(db, viewer, user_id)
    normalized = activity_module._normalize_period(period)  # noqa: SLF001
    _, _, start_utc, end_utc = activity_module.period_bounds(report_date, normalized)
    users = {u.id: u for u in db.query(AppUser).all()}

    common = {
        "start_utc": start_utc,
        "end_utc": end_utc,
        "target_user_id": target_user_id,
        "users": users,
    }
    if card == "personal_emails_sent":
        rows = _personal_rows(db, want_whatsapp=False, **common)
    elif card == "personal_whatsapp_sent":
        rows = _personal_rows(db, want_whatsapp=True, **common)
    elif card == "bulk_emails_sent":
        rows = _bulk_rows(db, want_whatsapp=False, **common)
    elif card == "bulk_whatsapp_sent":
        rows = _bulk_rows(db, want_whatsapp=True, **common)
    else:
        rows = _leads_imported_rows(db, **common)

    def _sort_key(row: dict[str, Any]) -> datetime:
        value = row.get("created_at")
        if isinstance(value, datetime):
            return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return datetime.min.replace(tzinfo=timezone.utc)

    rows.sort(key=_sort_key, reverse=True)
    return rows[:_MAX_ROWS]
