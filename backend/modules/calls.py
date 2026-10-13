"""Outbound call orchestration — human-initiated, logged as interactions."""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy.orm import Session

from db.models import Buyer, Channel, Contact, Direction, HandledBy, Interaction, InteractionStatus
from integrations.voice_client import mask_phone, normalize_e164, voice_client
from modules import buyers as buyers_module
from modules.audit import log_action
from modules.comms_generator import get_comms
from modules.countries import resolve_country_name

_CALL_SID_RE = re.compile(r"(?:Call SID:|\(SID)\s*(\S+?)(?:\)|\.|$)")
_LEAD_PHONE_RE = re.compile(
    r"(?:Manual\s+)?Outbound call(?:\s+initiated)?\s+to\s+(\+\d+)",
    re.IGNORECASE,
)
_DURATION_RE = re.compile(r"duration\s+(\d+)m\s+(\d+)s|duration\s+(\d+)s")
_DIAL_TARGET_ATTACHMENT = "dial_target"
_NOTES_MARKER = "\n\nNOTES:"
_OUTCOME_MARKER = "\n\nOUTCOME:"
_VALID_CALL_OUTCOMES = frozenset(
    {"interested", "follow_up", "not_interested", "not_received_call", "closed_business"}
)
# Recent Calls keeps ~1 rolling month of logs, then they may be purged.
CALL_HISTORY_RETENTION_DAYS = 30


def _contact_country_dedupe_key(contact_name: str | None, country: str | None) -> str | None:
    name = re.sub(r"[^a-z]", "", (contact_name or "").strip().lower())
    if len(name) < 3:
        return None
    country_key = re.sub(r"[^a-z]", "", (country or "").strip().lower())
    if not country_key:
        return None
    return f"{name}|{country_key}"


def _split_metadata(content: str | None) -> tuple[str, str | None, str | None]:
    base = (content or "").strip()
    notes: str | None = None
    outcome: str | None = None

    if _NOTES_MARKER in base:
        base, rest = base.split(_NOTES_MARKER, 1)
        if _OUTCOME_MARKER in rest:
            notes_part, outcome_part = rest.split(_OUTCOME_MARKER, 1)
            notes = notes_part.strip() or None
            outcome = outcome_part.strip() or None
        else:
            notes = rest.strip() or None
    elif _OUTCOME_MARKER in base:
        base, outcome_part = base.split(_OUTCOME_MARKER, 1)
        outcome = outcome_part.strip() or None

    return base.strip(), notes, outcome


def _build_content(base: str, notes: str | None, outcome: str | None) -> str:
    content = base.strip()
    if notes:
        content = f"{content}{_NOTES_MARKER} {notes.strip()}"
    if outcome:
        content = f"{content}{_OUTCOME_MARKER} {outcome.strip()}"
    return content


def _normalize_outcome(value: str | None) -> str | None:
    if value is None:
        return None
    trimmed = value.strip().lower()
    if not trimmed:
        return None
    if trimmed not in _VALID_CALL_OUTCOMES:
        allowed = ", ".join(sorted(_VALID_CALL_OUTCOMES))
        raise ValueError(f"Invalid call outcome. Choose one of: {allowed}")
    return trimmed


def parse_call_fields(content: str | None) -> dict:
    if not content:
        return {}

    base, notes, outcome = _split_metadata(content)
    fields: dict = {}

    if match := _CALL_SID_RE.search(base):
        fields["call_sid"] = match.group(1).rstrip(".")

    if match := _LEAD_PHONE_RE.search(base):
        fields["lead_phone"] = match.group(1)

    if " — " in base:
        tail = base.split(" — ", 1)[1]
        status_part = tail.split(",")[0].split("(")[0].strip().rstrip(".")
        if status_part and status_part not in {"Call SID:"}:
            fields["call_status"] = status_part

    if match := _DURATION_RE.search(base):
        if match.group(1) and match.group(2):
            fields["call_duration_seconds"] = int(match.group(1)) * 60 + int(match.group(2))
        elif match.group(3):
            fields["call_duration_seconds"] = int(match.group(3))

    if notes:
        fields["notes"] = notes
    if outcome:
        fields["call_outcome"] = outcome

    return fields


def _content_without_notes(content: str | None) -> str:
    base, _, _ = _split_metadata(content)
    return base


def _latest_call_fields_by_buyer(
    db: Session, *, buyer_ids: set[int] | None = None
) -> dict[int, dict[str, str | None]]:
    """Latest phone-call outcome + notes per buyer (one row each via window function)."""
    from sqlalchemy import func as sa_func

    if buyer_ids is not None and not buyer_ids:
        return {}

    row_number = (
        sa_func.row_number()
        .over(partition_by=Contact.buyer_id, order_by=Interaction.created_at.desc())
        .label("rn")
    )
    ranked = (
        db.query(
            Contact.buyer_id.label("buyer_id"),
            Interaction.content.label("content"),
            row_number,
        )
        .join(Contact, Interaction.contact_id == Contact.id)
        .filter(Interaction.channel == Channel.phone)
    )
    if buyer_ids is not None:
        ranked = ranked.filter(Contact.buyer_id.in_(buyer_ids))
    ranked = ranked.subquery()

    latest_rows = (
        db.query(ranked.c.buyer_id, ranked.c.content).filter(ranked.c.rn == 1).all()
    )

    latest_by_buyer: dict[int, dict[str, str | None]] = {}
    for buyer_id, content in latest_rows:
        fields = parse_call_fields(content)
        notes = fields.get("notes")
        outcome = fields.get("call_outcome")
        latest_by_buyer[int(buyer_id)] = {
            "call_outcome": str(outcome) if outcome else None,
            "notes": str(notes).strip() if notes else None,
        }
    return latest_by_buyer


def _latest_call_outcomes_by_buyer(
    db: Session, *, buyer_ids: set[int] | None = None
) -> dict[int, str | None]:
    """Latest phone-call outcome per buyer."""
    return {
        bid: fields.get("call_outcome")
        for bid, fields in _latest_call_fields_by_buyer(db, buyer_ids=buyer_ids).items()
    }


def latest_call_outcomes_by_buyer(
    db: Session, *, buyer_ids: set[int] | None = None
) -> dict[int, str | None]:
    """Public accessor — latest phone-call outcome per buyer (see helper above)."""
    return _latest_call_outcomes_by_buyer(db, buyer_ids=buyer_ids)


def latest_call_notes_by_buyer(
    db: Session, *, buyer_ids: set[int] | None = None
) -> dict[int, str | None]:
    """Latest post-call remarks/notes per buyer."""
    return {
        bid: fields.get("notes")
        for bid, fields in _latest_call_fields_by_buyer(db, buyer_ids=buyer_ids).items()
        if fields.get("notes")
    }


def buyer_ids_with_latest_call_outcome(
    db: Session, outcome: str, *, buyer_ids: set[int] | None = None
) -> set[int]:
    """Buyers whose most recent phone call has the given outcome label."""
    wanted = outcome.strip().lower()
    return {
        bid
        for bid, value in _latest_call_outcomes_by_buyer(db, buyer_ids=buyer_ids).items()
        if value and str(value).lower() == wanted
    }


def buyer_ids_with_placed_call_outcome(
    db: Session, *, buyer_ids: set[int] | None = None
) -> set[int]:
    """Buyers whose latest call placed them in a follow-up outcome list."""
    return {
        bid
        for bid, value in _latest_call_outcomes_by_buyer(db, buyer_ids=buyer_ids).items()
        if value and str(value).lower() in _VALID_CALL_OUTCOMES
    }


def twilio_balance() -> dict:
    """Admin-only Twilio prepaid balance snapshot."""
    from config import settings

    cfg = call_config()
    result = voice_client.fetch_account_balance()
    ring_seconds = int(getattr(settings, "ring_timeout_seconds", 16) or 16)
    return {
        "configured": bool(cfg.get("configured")),
        "caller_id_masked": cfg.get("caller_id_masked"),
        "twilio_account_sid": cfg.get("twilio_account_sid"),
        "ok": bool(result.get("ok")),
        "balance": result.get("balance"),
        "currency": result.get("currency"),
        "message": result.get("message"),
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "hangup_after_fourth_ring": bool(getattr(settings, "hangup_after_fourth_ring", True)),
        "ring_timeout_seconds": ring_seconds,
        "max_ring_attempts": int(getattr(settings, "max_ring_attempts", 10) or 10),
    }


def call_config() -> dict:
    from config import settings

    hints = voice_client.setup_hints()
    setup_message: str | None = None
    if not voice_client.is_configured:
        setup_message = (
            "Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER to backend/.env"
        )
    elif not voice_client.webhooks_ready:
        setup_message = (
            "Set TWILIO_WEBHOOK_BASE_URL to your public API URL "
            "(run: ngrok http 8000 for local dev)"
        )
    elif not voice_client.browser_ready:
        setup_message = (
            "Create a Twilio API Key + TwiML App, then set TWILIO_API_KEY_SID, "
            "TWILIO_API_KEY_SECRET, and TWILIO_TWIML_APP_SID in backend/.env"
        )

    account_sid = (settings.twilio_account_sid or "").strip()
    return {
        "configured": voice_client.is_configured,
        "webhooks_ready": voice_client.webhooks_ready,
        "browser_ready": voice_client.browser_ready,
        "caller_id_masked": mask_phone(settings.twilio_phone_number),
        "setup_message": setup_message,
        "missing_env": hints["missing"],
        # Public diagnostics so Console vs Railway mismatches are obvious.
        "twilio_account_sid": account_sid or None,
        "twilio_twiml_app_sid": (settings.twilio_twiml_app_sid or "").strip() or None,
        "twilio_webhook_base_url": (settings.twilio_webhook_base_url or "").strip() or None,
        "twilio_validate_webhooks": bool(settings.twilio_validate_webhooks),
    }


def voice_access_token() -> dict:
    if not voice_client.browser_ready:
        raise ValueError(call_config().get("setup_message") or "Twilio browser calling not configured")
    return {
        "token": voice_client.create_access_token(),
        "identity": "sales-agent",
    }


def get_call_history_item(db: Session, *, interaction_id: int) -> dict | None:
    interaction = db.get(Interaction, interaction_id)
    if not interaction or interaction.channel != Channel.phone:
        return None
    return call_interaction_to_dict(db, interaction)


def call_interaction_to_dict(db: Session, interaction: Interaction) -> dict:
    from modules.call_media import (
        get_ai_training_selected,
        get_call_media,
        maybe_backfill_ai_call_media,
        public_call_media,
    )

    contact = db.get(Contact, interaction.contact_id) if interaction.contact_id else None
    buyer = db.get(Buyer, contact.buyer_id) if contact else None
    parsed = parse_call_fields(interaction.content)
    media = public_call_media(get_call_media(interaction), interaction_id=interaction.id)

    company = (buyer.company_name if buyer else None) or parsed.get("company_name") or interaction.subject or "Direct AI Call"
    contact_nm = (contact.full_name if contact else None) or parsed.get("contact_name")
    contact_ph = (contact.phone if contact else None) or parsed.get("lead_phone")

    return {
        "id": interaction.id,
        "contact_id": interaction.contact_id,
        "buyer_id": buyer.id if buyer else None,
        "company_name": company,
        "contact_name": contact_nm,
        "contact_phone": contact_ph,
        "channel": interaction.channel.value,
        "direction": interaction.direction.value,
        "subject": interaction.subject,
        "content": interaction.content,
        "status": interaction.status.value,
        "created_at": interaction.created_at,
        "ai_training_selected": get_ai_training_selected(interaction),
        **parsed,
        **media,
    }


def list_call_history(
    db: Session,
    *,
    buyer_id: int | None = None,
    assigned_to_user_id: int | None = None,
    limit: int = 50,
    page: int | None = None,
    page_size: int | None = None,
    since_days: int | None = CALL_HISTORY_RETENTION_DAYS,
) -> dict[str, object]:
    """List phone call interactions, optionally paginated and limited to a recent window."""
    query = (
        db.query(Interaction)
        .outerjoin(Contact, Interaction.contact_id == Contact.id)
        .filter(Interaction.channel == Channel.phone)
    )
    if buyer_id is not None:
        query = query.filter(Contact.buyer_id == buyer_id)

    if assigned_to_user_id is not None:
        from sqlalchemy import or_
        query = query.outerjoin(Buyer, Contact.buyer_id == Buyer.id).filter(
            or_(
                Buyer.assigned_to_user_id == assigned_to_user_id,
                Interaction.contact_id.is_(None),
            )
        )

    if since_days is not None and since_days > 0:
        cutoff = datetime.now(timezone.utc) - timedelta(days=since_days)
        query = query.filter(Interaction.created_at >= cutoff)

    total = query.count()
    ordered = query.order_by(Interaction.created_at.desc())

    if page is None and page_size is None:
        rows = ordered.limit(max(1, min(limit, 200))).all()
        return {
            "total": total,
            "page": 1,
            "page_size": len(rows) or limit,
            "total_pages": 1,
            "since_days": since_days,
            "rows": [call_interaction_to_dict(db, row) for row in rows],
        }

    size = min(max(1, page_size or 5), 50)
    current = max(1, page or 1)
    total_pages = max(1, (total + size - 1) // size) if total else 1
    if current > total_pages:
        current = total_pages
    rows = ordered.offset((current - 1) * size).limit(size).all()
    return {
        "total": total,
        "page": current,
        "page_size": size,
        "total_pages": total_pages,
        "since_days": since_days,
        "rows": [call_interaction_to_dict(db, row) for row in rows],
    }


def purge_old_call_logs(
    db: Session,
    *,
    older_than_days: int = CALL_HISTORY_RETENTION_DAYS,
) -> int:
    """Delete call logs older than the Recent Calls retention window."""
    if older_than_days < 1:
        return 0
    cutoff = datetime.now(timezone.utc) - timedelta(days=older_than_days)
    stale = (
        db.query(Interaction)
        .filter(
            Interaction.channel == Channel.phone,
            Interaction.created_at < cutoff,
        )
        .all()
    )
    deleted = 0
    for interaction in stale:
        if delete_call_log(db, interaction_id=interaction.id):
            deleted += 1
    return deleted


def _primary_contact_for_call(db: Session, buyer_id: int) -> Contact | None:
    contact = buyers_module.primary_contact_with_email(db, buyer_id)
    if contact and contact.phone and contact.phone.strip():
        return contact
    for row in buyers_module.list_contacts_for_buyer(db, buyer_id):
        if row.phone and row.phone.strip():
            return row
    return None


def _contact_phones_normalized(contact: Contact) -> set[str]:
    phones: set[str] = set()
    for raw in (
        contact.phone,
        contact.primary_phone,
        contact.secondary_phone,
        contact.secondary_mobile,
    ):
        normalized = normalize_e164(raw or "")
        if normalized:
            phones.add(normalized)
    return phones


def _find_contact_by_phone(db: Session, phone: str) -> Contact | None:
    target = normalize_e164(phone)
    if not target:
        return None
    for contact in buyers_module.list_contacts(db):
        if target in _contact_phones_normalized(contact):
            return contact
    return None


def _prepare_call_interaction(
    db: Session,
    *,
    buyer: Buyer,
    contact: Contact,
    lead_phone: str,
    subject: str,
    content: str,
) -> dict:
    interaction = Interaction(
        contact_id=contact.id,
        channel=Channel.phone,
        direction=Direction.outbound,
        subject=subject,
        content=content,
        handled_by=HandledBy.human,
        status=InteractionStatus.sent,
        approved_by="dashboard",
        attachments=[{"type": _DIAL_TARGET_ATTACHMENT, "phone": lead_phone}],
    )
    db.add(interaction)
    db.commit()
    db.refresh(interaction)

    log_action(
        db,
        entity_type="interaction",
        entity_id=interaction.id,
        action="call_prepared",
        actor="dashboard",
        details={
            "buyer_id": buyer.id,
            "contact_id": contact.id,
            "lead_phone": lead_phone,
        },
    )

    payload = get_comms().interaction_to_dict(db, interaction)
    payload.update(
        {
            "lead_phone": lead_phone,
            "message": f"Calling {contact.full_name} at {lead_phone}…",
        }
    )
    return payload


def get_prepared_dial_phone(db: Session, interaction_id: int) -> str | None:
    """Phone number prepared for a browser dial — source of truth for TwiML Dial."""
    interaction = db.get(Interaction, interaction_id)
    if not interaction:
        return None
    for item in interaction.attachments or []:
        if not isinstance(item, dict):
            continue
        if str(item.get("type") or "") != _DIAL_TARGET_ATTACHMENT:
            continue
        phone = normalize_e164(str(item.get("phone") or ""))
        if phone:
            return phone
    parsed = parse_call_fields(interaction.content)
    phone = normalize_e164(str(parsed.get("lead_phone") or ""))
    if phone:
        return phone
    if match := _LEAD_PHONE_RE.search(interaction.content or ""):
        return normalize_e164(match.group(1))
    return None


def _lead_phone_from_contact(contact: Contact, *, preferred: str | None = None) -> str:
    if preferred and preferred.strip():
        lead_phone = normalize_e164(preferred.strip())
        if lead_phone:
            return lead_phone
        raise ValueError(
            f"Phone '{preferred}' is not valid E.164. Use international format: +971501234567"
        )
    for raw in (
        contact.phone,
        contact.primary_phone,
        contact.secondary_mobile,
        contact.secondary_phone,
    ):
        lead_phone = normalize_e164(raw or "")
        if lead_phone:
            return lead_phone
    raise ValueError("Contact has no dialable phone number")


def initiate_lead_call(
    db: Session,
    *,
    buyer_id: int,
    contact_id: int | None = None,
    phone: str | None = None,
) -> dict:
    """Prepare a browser call — creates interaction; frontend dials via Twilio Voice SDK."""
    buyer = buyers_module.get_buyer(db, buyer_id)
    if not buyer:
        raise ValueError("Lead not found")

    if not voice_client.browser_ready:
        cfg = call_config()
        raise ValueError(cfg.get("setup_message") or "Twilio browser calling is not configured")

    contact: Contact | None = None
    if contact_id:
        contact = buyers_module.get_contact(db, contact_id)
        if not contact or contact.buyer_id != buyer_id:
            raise ValueError("Contact not found for this lead")
    elif phone and phone.strip():
        contact = _find_contact_by_phone(db, phone.strip())
        if not contact or contact.buyer_id != buyer_id:
            contact = _primary_contact_for_call(db, buyer_id)
    else:
        contact = _primary_contact_for_call(db, buyer_id)

    if not contact:
        raise ValueError("No contact with a phone number on this lead")

    lead_phone = _lead_phone_from_contact(contact, preferred=phone)

    return _prepare_call_interaction(
        db,
        buyer=buyer,
        contact=contact,
        lead_phone=lead_phone,
        subject=f"Call to {buyer.company_name}",
        content=f"Outbound call to {lead_phone} ({contact.full_name}). Connecting from dashboard…",
    )


def initiate_manual_call(
    db: Session,
    *,
    phone: str,
    contact_name: str | None = None,
    country: str | None = None,
) -> dict:
    """Prepare a browser call to any E.164 number — links to an existing lead when possible."""
    if not voice_client.browser_ready:
        cfg = call_config()
        raise ValueError(cfg.get("setup_message") or "Twilio browser calling is not configured")

    lead_phone = normalize_e164(phone)
    if not lead_phone:
        raise ValueError(
            "Phone number is not valid. Use international format, e.g. +971501234567"
        )

    resolved_country = resolve_country_name(country) if country else None
    contact = _find_contact_by_phone(db, lead_phone)
    if contact:
        buyer = buyers_module.get_buyer(db, contact.buyer_id)
        if not buyer:
            raise ValueError("Contact lead not found")
    else:
        display_name = (contact_name or "").strip() or lead_phone
        buyer = buyers_module.create_buyer(
            db,
            {
                "company_name": display_name,
                "country": resolved_country,
                "source": "manual_dial",
            },
            commit=False,
        )
        contact = buyers_module.create_contact(
            db,
            {
                "buyer_id": buyer.id,
                "full_name": (contact_name or "").strip() or "Manual dial",
                "phone": lead_phone,
                "data_source": "manual_dial",
                "consent_status": "unknown",
            },
            commit=False,
        )
        db.commit()
        db.refresh(buyer)
        db.refresh(contact)

    return _prepare_call_interaction(
        db,
        buyer=buyer,
        contact=contact,
        lead_phone=lead_phone,
        subject=f"Manual call to {lead_phone}",
        content=f"Manual outbound call to {lead_phone} ({contact.full_name}). Connecting from dashboard…",
    )


def update_call_status(
    db: Session,
    *,
    interaction_id: int,
    call_status: str,
    call_duration: str | None = None,
    call_sid: str | None = None,
) -> None:
    interaction = db.get(Interaction, interaction_id)
    if not interaction:
        return

    notes = parse_call_fields(interaction.content).get("notes")
    outcome = parse_call_fields(interaction.content).get("call_outcome")
    body = _content_without_notes(interaction.content)

    duration_text = ""
    if call_duration and call_duration.isdigit():
        seconds = int(call_duration)
        mins, secs = divmod(seconds, 60)
        duration_text = f", duration {mins}m {secs}s" if mins else f", duration {secs}s"

    sid_text = f" (Call SID: {call_sid})" if call_sid else ""
    if "Call SID:" in body:
        prefix = body.split("Call SID:")[0].strip().rstrip("(").strip()
    elif " — " in body:
        prefix = body.split(" — ", 1)[0].strip()
    else:
        prefix = body.strip()

    duration_sec = int(call_duration) if (call_duration and call_duration.isdigit()) else 0
    is_answered = call_status.strip().lower() in ("completed", "answered", "in-progress")
    # A short drop is an unanswered call that ended in < 15 seconds (before 3rd ring bell) without positive outcome
    is_short_drop = (not is_answered) and (duration_sec < 15) and (not outcome or outcome == "not_received_call")

    interaction.content = f"{prefix} — {call_status}{duration_text}{sid_text}.".strip()
    interaction.content = _build_content(interaction.content, notes, outcome)

    try:
        from db.models import UserActivityEvent

        event = (
            db.query(UserActivityEvent)
            .filter(
                UserActivityEvent.entity_type == "interaction",
                UserActivityEvent.entity_id == interaction_id,
                UserActivityEvent.activity_type == "call_logged",
            )
            .first()
        )
        if event:
            det = dict(event.details or {})
            det["call_duration"] = duration_sec
            det["call_status"] = call_status
            det["is_short_drop"] = is_short_drop
            det["min_rings_met"] = not is_short_drop
            event.details = det
    except Exception:  # noqa: BLE001
        pass

    db.commit()


def save_call_recording(
    db: Session,
    *,
    interaction_id: int,
    recording_sid: str,
    recording_url: str,
    recording_status: str,
    recording_duration: str | None = None,
) -> dict | None:
    from modules.call_media import save_recording_from_webhook

    return save_recording_from_webhook(
        db,
        interaction_id=interaction_id,
        recording_sid=recording_sid,
        recording_url=recording_url,
        recording_status=recording_status,
        recording_duration=recording_duration,
    )


def get_call_recording_file(db: Session, *, interaction_id: int) -> tuple[Path, str, str]:
    from modules.call_media import (
        attach_local_recording,
        download_twilio_recording,
        get_call_media,
        resolve_local_recording,
    )

    interaction = db.get(Interaction, interaction_id)
    if not interaction or interaction.channel != Channel.phone:
        raise ValueError("Call not found")
    media = get_call_media(interaction)
    if not media:
        raise ValueError("No recording for this call")

    path = resolve_local_recording(media)
    if not path and media.get("recording_url") and media.get("recording_sid"):
        rec_url = str(media["recording_url"])
        rec_sid = str(media["recording_sid"])
        if "api.twilio.com" in rec_url.lower():
            path, content_type = download_twilio_recording(rec_url, rec_sid)
        else:
            from modules.call_media import download_public_recording

            path, content_type = download_public_recording(rec_url, rec_sid)
        attach_local_recording(
            db,
            interaction_id=interaction_id,
            local_path=f"call_recordings/{path.name}",
            content_type=content_type,
        )
        media = get_call_media(interaction) or media

    if not path or not path.is_file():
        raise ValueError("Recording file is not available yet")

    content_type = str(media.get("content_type") or "audio/mpeg")
    filename = path.name
    return path, content_type, filename


def transcribe_call(db: Session, *, interaction_id: int) -> dict:
    from modules.call_media import transcribe_call_recording

    transcribe_call_recording(db, interaction_id=interaction_id)
    interaction = db.get(Interaction, interaction_id)
    if not interaction:
        raise ValueError("Call not found")
    return call_interaction_to_dict(db, interaction)


def update_call_followup(
    db: Session,
    *,
    interaction_id: int,
    notes: str | None = None,
    call_outcome: str | None = None,
    app_user_id: int | None = None,
) -> dict:
    interaction = db.get(Interaction, interaction_id)
    if not interaction or interaction.channel != Channel.phone:
        raise ValueError("Call not found")

    base, existing_notes, existing_outcome = _split_metadata(interaction.content)
    new_notes = existing_notes if notes is None else notes.strip()
    new_outcome = existing_outcome
    if call_outcome is not None:
        trimmed = call_outcome.strip()
        new_outcome = None if not trimmed else _normalize_outcome(trimmed)

    notes_changed = notes is not None and (new_notes or "") != (existing_notes or "")
    outcome_changed = call_outcome is not None and new_outcome != existing_outcome

    interaction.content = _build_content(
        base,
        new_notes or None,
        new_outcome,
    )

    from modules.interested_follow_ups import sync_buyer_interested_status

    sync_buyer_interested_status(
        db,
        buyer_id=interaction.contact.buyer_id,
        new_outcome=new_outcome,
        previous_outcome=existing_outcome,
        user_id=app_user_id,
    )

    db.commit()
    db.refresh(interaction)

    if outcome_changed:
        from modules.leads import invalidate_section_counts_cache

        invalidate_section_counts_cache()

    if app_user_id:
        from modules import activity as activity_module

        contact = interaction.contact
        buyer = contact.buyer if contact else None
        company = buyer.company_name if buyer else "Unknown"
        contact_name = contact.full_name if contact else "contact"

        if outcome_changed and new_outcome:
            activity_module.log_activity(
                db,
                user_id=app_user_id,
                activity_type=activity_module.CALL_OUTCOME,
                title=activity_module.outcome_label(new_outcome),
                summary=f"Marked {company} ({contact_name}) as {activity_module.outcome_label(new_outcome).lower()}",
                entity_type="interaction",
                entity_id=interaction.id,
                details={
                    "outcome": new_outcome,
                    "buyer_id": buyer.id if buyer else None,
                    "company_name": company,
                },
            )
            if new_outcome == "follow_up" and buyer:
                from modules import ai_mode as ai_mode_module

                ai_mode_module.record_follow_up_activity(
                    db,
                    user_id=app_user_id,
                    company_name=company,
                    buyer_id=buyer.id,
                    event_type="placed",
                )
        if notes_changed and (new_notes or "").strip() and buyer:
            from modules.client_history import append_client_history, username_for_user

            note_text = (new_notes or "").strip()
            append_client_history(
                buyer,
                text=note_text,
                by_username=username_for_user(db, app_user_id),
                source="call",
            )
            # Keep the single client-remarks box on the latest note.
            buyer.remarks = note_text
            preview = (new_notes or "").strip()
            if len(preview) > 160:
                preview = preview[:157] + "…"
            activity_module.log_activity(
                db,
                user_id=app_user_id,
                activity_type=activity_module.CALL_REMARKS,
                title="Call remarks added",
                summary=f"Remarks on call with {company}: {preview}",
                entity_type="interaction",
                entity_id=interaction.id,
                details={
                    "buyer_id": buyer.id if buyer else None,
                    "company_name": company,
                },
            )

    # Call confirmation drafts — email + WhatsApp ready after any call with remarks/outcome.
    has_content = bool((new_notes or "").strip()) or bool(new_outcome)
    if (outcome_changed or notes_changed) and has_content:
        from modules import personalized_followups as pf_module

        pf_module.ensure_draft_for_call(
            db,
            interaction_id=interaction.id,
            call_outcome=str(new_outcome) if new_outcome else "follow_up",
            user_id=app_user_id,
            generate_now=True,
        )
    elif outcome_changed and not has_content:
        from modules import personalized_followups as pf_module

        pf_module.dismiss_draft_for_ineligible_outcome(
            db,
            interaction_id=interaction.id,
            call_outcome=new_outcome,
        )

    return call_interaction_to_dict(db, interaction)


def set_ai_training_selected(
    db: Session,
    *,
    interaction_id: int,
    selected: bool,
) -> dict:
    """Flag a call for Sara & Rayan curated training (attachments JSON — no ALTER)."""
    from modules.call_media import set_ai_training_selected_flag

    interaction = db.get(Interaction, interaction_id)
    if not interaction or interaction.channel != Channel.phone:
        raise ValueError("Call not found")
    set_ai_training_selected_flag(interaction, bool(selected))
    db.commit()
    db.refresh(interaction)
    return call_interaction_to_dict(db, interaction)


def _latest_call_outcome_for_buyer(db: Session, buyer_id: int) -> str | None:
    interaction = (
        db.query(Interaction)
        .join(Contact, Interaction.contact_id == Contact.id)
        .filter(Contact.buyer_id == buyer_id, Interaction.channel == Channel.phone)
        .order_by(Interaction.created_at.desc())
        .first()
    )
    if not interaction:
        return None
    return parse_call_fields(interaction.content).get("call_outcome")


def delete_call_log(db: Session, *, interaction_id: int) -> bool:
    interaction = db.get(Interaction, interaction_id)
    if not interaction or interaction.channel != Channel.phone:
        return False

    contact = db.get(Contact, interaction.contact_id)
    buyer_id = contact.buyer_id if contact else None
    deleted_outcome = parse_call_fields(interaction.content).get("call_outcome")

    from modules.call_media import get_call_media, resolve_local_recording

    media = get_call_media(interaction)
    if media:
        path = resolve_local_recording(media)
        if path and path.is_file():
            try:
                path.unlink()
            except OSError:
                pass

    db.delete(interaction)
    db.commit()

    if buyer_id and (deleted_outcome or "").strip().lower() in {
        "interested",
        "follow_up",
        "not_received_call",
        "not_interested",
        "closed_business",
    }:
        from modules.interested_follow_ups import sync_buyer_interested_status

        sync_buyer_interested_status(
            db,
            buyer_id=buyer_id,
            new_outcome=_latest_call_outcome_for_buyer(db, buyer_id),
            previous_outcome=(deleted_outcome or "").strip().lower(),
        )

    return True


def update_call_notes(db: Session, *, interaction_id: int, notes: str) -> dict:
    return update_call_followup(db, interaction_id=interaction_id, notes=notes)


def _contact_has_dialable_phone(contact: Contact) -> bool:
    for value in (
        contact.phone,
        contact.primary_phone,
        contact.secondary_mobile,
        contact.secondary_phone,
    ):
        if (value or "").strip():
            return True
    return False


def _dial_phone_for_contact(contact: Contact) -> str | None:
    options = _dial_phone_options_for_contact(contact)
    return options[0]["phone"] if options else None


def _dial_phone_options_for_contact(contact: Contact) -> list[dict[str, object]]:
    """Numbered dial options for one contact (deduped)."""
    seen: set[str] = set()
    options: list[dict[str, object]] = []
    field_labels = (
        ("phone", "Main"),
        ("primary_phone", "Primary"),
        ("secondary_mobile", "Mobile 2"),
        ("secondary_phone", "Phone 2"),
    )
    for field, label in field_labels:
        raw = (getattr(contact, field, None) or "").strip()
        if not raw:
            continue
        normalized = normalize_e164(raw) or raw
        key = "".join(ch for ch in normalized if ch.isdigit())
        if not key or key in seen:
            continue
        seen.add(key)
        options.append(
            {
                "index": len(options) + 1,
                "label": label,
                "phone": raw,
                "contact_id": contact.id,
            }
        )
    return options


def dial_phone_options_for_buyer(db: Session, buyer_id: int) -> list[dict[str, object]]:
    """Public wrapper for dial options (used by leads API and call center)."""
    return _dial_phone_options_for_buyer(db, buyer_id)


def _dial_phone_options_for_buyer(db: Session, buyer_id: int) -> list[dict[str, object]]:
    """All dialable numbers for a lead across contacts."""
    contacts = (
        db.query(Contact)
        .filter(Contact.buyer_id == buyer_id)
        .order_by(Contact.id.asc())
        .all()
    )
    seen: set[str] = set()
    options: list[dict[str, object]] = []
    for contact in contacts:
        for opt in _dial_phone_options_for_contact(contact):
            key = "".join(ch for ch in str(opt["phone"]) if ch.isdigit())
            if key in seen:
                continue
            seen.add(key)
            options.append({**opt, "index": len(options) + 1})
    return options


def list_dialable_leads(
    db: Session,
    *,
    assigned_to_user_id: int | None = None,
    unassigned_only: bool = False,
    country: str | None = None,
    valid_now: str | None = None,
    page: int = 1,
    page_size: int = 25,
) -> dict[str, object]:
    """Leads that have at least one contact phone number — for Quick Dial.

    ``valid_now``: ``yes`` / ``no`` / empty (all). Uses the same 10 AM–5 PM
    country window as the leads table call badges.
    """
    from sqlalchemy import func as sa_func, or_

    from modules.call_timing import countries_valid_to_call_now, get_call_recommendation
    from modules.leads import _apply_lead_table_scope

    page = max(1, page)
    page_size = min(max(1, page_size), 100)

    phone_contacts = (
        db.query(Contact)
        .filter(
            or_(
                sa_func.trim(sa_func.coalesce(Contact.phone, "")) != "",
                sa_func.trim(sa_func.coalesce(Contact.primary_phone, "")) != "",
                sa_func.trim(sa_func.coalesce(Contact.secondary_mobile, "")) != "",
            )
        )
        .order_by(Contact.buyer_id.asc(), Contact.id.asc())
        .all()
    )
    phone_by_buyer: dict[int, Contact] = {}
    for contact in phone_contacts:
        if contact.buyer_id not in phone_by_buyer and _contact_has_dialable_phone(contact):
            phone_by_buyer[contact.buyer_id] = contact

    if not phone_by_buyer:
        return {
            "total": 0,
            "page": 1,
            "page_size": page_size,
            "total_pages": 1,
            "rows": [],
            "countries": [],
            "countries_valid_now": countries_valid_to_call_now(),
        }

    buyer_query = _apply_lead_table_scope(
        db.query(Buyer),
        source=None,
        exclude_source=None,
        assigned_to_user_id=assigned_to_user_id,
        unassigned_only=unassigned_only,
        pool_for_user_id=None,
    ).filter(Buyer.id.in_(list(phone_by_buyer.keys())))

    if country:
        from modules.countries import country_search_terms

        terms = [term for term in country_search_terms(country) if term]
        if terms:
            buyer_query = buyer_query.filter(
                or_(
                    *[
                        sa_func.lower(sa_func.coalesce(Buyer.country, "")).like(f"%{term}%")
                        for term in terms
                    ]
                )
            )

    light_rows = buyer_query.with_entities(
        Buyer.id, Buyer.company_name, Buyer.country, Buyer.created_at
    ).all()

    want = (valid_now or "").strip().lower()
    filtered: list[tuple[int, str, str | None, object]] = []
    country_set: set[str] = set()
    for buyer_id, company_name, country_val, created_at in light_rows:
        timing = get_call_recommendation(country_val)
        recommended = timing["call_recommended"]
        if want in {"yes", "true", "recommended", "valid"}:
            if recommended is not True:
                continue
        elif want in {"no", "false", "not_now", "not-now"}:
            if recommended is not False:
                continue
        filtered.append((buyer_id, company_name, country_val, created_at))
        if country_val and str(country_val).strip():
            country_set.add(str(country_val).strip())

    filtered.sort(key=lambda row: ((row[1] or "").lower(), row[0]))
    total = len(filtered)

    duplicate_ids: set[int] = set()
    key_to_ids: dict[str, list[int]] = {}
    for buyer_id, _company_name, country_val, _created_at in filtered:
        contact = phone_by_buyer.get(buyer_id)
        key = _contact_country_dedupe_key(contact.full_name if contact else None, country_val)
        if key:
            key_to_ids.setdefault(key, []).append(buyer_id)
    for ids in key_to_ids.values():
        if len(ids) > 1:
            duplicate_ids.update(ids)

    total_pages = max(1, (total + page_size - 1) // page_size) if total else 1
    if page > total_pages:
        page = total_pages
    start = (page - 1) * page_size
    page_rows = filtered[start : start + page_size]

    rows: list[dict[str, object]] = []
    for buyer_id, company_name, country_val, _created_at in page_rows:
        contact = phone_by_buyer.get(buyer_id)
        phone_options = _dial_phone_options_for_buyer(db, buyer_id)
        timing = get_call_recommendation(country_val)
        primary_phone = phone_options[0]["phone"] if phone_options else None
        contact_name = (contact.full_name if contact else None) or None
        rows.append(
            {
                "id": buyer_id,
                "company_name": company_name,
                "country": country_val,
                "call_recommended": timing["call_recommended"],
                "call_local_time": timing["call_local_time"],
                "call_timezone": timing["call_timezone"],
                "call_reason": timing["call_reason"],
                "contact_id": (
                    phone_options[0].get("contact_id") if phone_options else (contact.id if contact else None)
                ),
                "contact_name": contact_name,
                "contact_phone": primary_phone,
                "phones": phone_options,
                "possible_duplicate": buyer_id in duplicate_ids,
                "missing_contact_name": not (contact_name or "").strip(),
            }
        )

    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "total_pages": total_pages,
        "rows": rows,
        "countries": sorted(country_set, key=lambda c: c.lower()),
        "countries_valid_now": countries_valid_to_call_now(),
    }


def suggest_dialable_contacts(
    db: Session,
    *,
    q: str = "",
    section: str | None = None,
    country: str | None = None,
    grade: str | None = None,
    designation: str | None = None,
    limit: int = 25,
    assigned_to_user_id: int | None = None,
) -> list[dict[str, object]]:
    """Search/filter dialable contacts with phone numbers by section/pool, query, country, grade, and designation."""
    from sqlalchemy import or_, func as sa_func

    query_str = (q or "").strip()
    section_str = (section or "").strip().lower()
    country_str = (country or "").strip()
    grade_str = (grade or "").strip()
    desig_str = (designation or "").strip()

    limit = max(1, min(int(limit or 25), 80))

    b_query = db.query(Buyer).join(Contact, Contact.buyer_id == Buyer.id)
    if assigned_to_user_id is not None:
        b_query = b_query.filter(Buyer.assigned_to_user_id == assigned_to_user_id)

    # Must have a dialable phone
    b_query = b_query.filter(
        or_(
            sa_func.trim(sa_func.coalesce(Contact.phone, "")) != "",
            sa_func.trim(sa_func.coalesce(Contact.primary_phone, "")) != "",
            sa_func.trim(sa_func.coalesce(Contact.secondary_mobile, "")) != "",
            sa_func.trim(sa_func.coalesce(Contact.secondary_phone, "")) != "",
        )
    )

    # Section / Pool filter
    if section_str and section_str not in ("master", "all_sections", ""):
        if section_str == "targeted_distributor":
            b_query = b_query.filter(sa_func.lower(Buyer.source) == "targeted_distributor")
        elif section_str == "old_clients":
            b_query = b_query.filter(sa_func.lower(Buyer.source) == "old_clients")
        elif section_str == "hyperstore_targeted":
            b_query = b_query.filter(sa_func.lower(Buyer.source) == "hyperstore_targeted")
        elif section_str == "targeted_client":
            b_query = b_query.filter(sa_func.lower(Buyer.source) == "targeted_client")
        elif section_str == "khalid_focused_sales":
            b_query = b_query.filter(sa_func.lower(Buyer.source) == "khalid_focused_sales")
        elif section_str == "incomplete_archives":
            b_query = b_query.filter(sa_func.lower(Buyer.source) == "incomplete_archives")
        elif section_str in ("all", "new_search_lead"):
            from modules.lead_sources import SCRAPED_LEAD_SOURCES

            b_query = b_query.filter(
                sa_func.lower(sa_func.coalesce(Buyer.source, "")).in_(
                    [s.lower() for s in SCRAPED_LEAD_SOURCES]
                )
            )
        elif section_str == "sales_interested_clients":
            b_query = b_query.filter(Buyer.interested_clients_list_at.isnot(None))
        elif section_str == "interested_clients":
            from modules.calls import buyer_ids_with_latest_call_outcome

            matched = buyer_ids_with_latest_call_outcome(db, "follow_up")
            b_query = b_query.filter(Buyer.id.in_(matched) if matched else Buyer.id == -1)
        elif section_str == "not_interested_clients":
            from modules.calls import buyer_ids_with_latest_call_outcome

            matched = buyer_ids_with_latest_call_outcome(db, "not_interested")
            b_query = b_query.filter(Buyer.id.in_(matched) if matched else Buyer.id == -1)
        elif section_str == "not_received_call_clients":
            from modules.calls import buyer_ids_with_latest_call_outcome

            matched = buyer_ids_with_latest_call_outcome(db, "not_received_call")
            b_query = b_query.filter(Buyer.id.in_(matched) if matched else Buyer.id == -1)
        elif section_str == "my_assigned" and assigned_to_user_id is not None:
            b_query = b_query.filter(Buyer.assigned_to_user_id == assigned_to_user_id)

    if country_str:
        from modules.countries import country_search_terms

        terms = [term for term in country_search_terms(country_str) if term]
        if terms:
            b_query = b_query.filter(
                or_(
                    *[
                        sa_func.lower(sa_func.coalesce(Buyer.country, "")).like(f"%{term}%")
                        for term in terms
                    ]
                )
            )
        else:
            b_query = b_query.filter(
                sa_func.lower(sa_func.coalesce(Buyer.country, "")).like(f"%{country_str.lower()}%")
            )

    if grade_str:
        if grade_str.lower() == "ungraded":
            b_query = b_query.filter(
                or_(
                    Buyer.company_grading.is_(None),
                    sa_func.trim(sa_func.coalesce(Buyer.company_grading, "")) == "",
                    sa_func.lower(Buyer.company_grading) == "ungraded",
                )
            )
        else:
            b_query = b_query.filter(
                sa_func.lower(sa_func.coalesce(Buyer.company_grading, "")) == grade_str.lower()
            )

    if desig_str:
        b_query = b_query.filter(
            sa_func.lower(sa_func.coalesce(Contact.designation, "")).like(f"%{desig_str.lower()}%")
        )

    if query_str:
        safe = (
            query_str.replace("\\", "\\\\")
            .replace("%", "\\%")
            .replace("_", "\\_")
        )
        pattern = f"%{safe}%"
        b_query = b_query.filter(
            or_(
                Buyer.company_name.ilike(pattern, escape="\\"),
                Contact.full_name.ilike(pattern, escape="\\"),
                Contact.designation.ilike(pattern, escape="\\"),
                Contact.phone.ilike(pattern, escape="\\"),
                Contact.primary_phone.ilike(pattern, escape="\\"),
                Contact.secondary_mobile.ilike(pattern, escape="\\"),
                Contact.secondary_phone.ilike(pattern, escape="\\"),
            )
        )

    matching_buyers = (
        b_query.order_by(sa_func.lower(sa_func.coalesce(Buyer.company_name, "")).asc())
        .limit(limit * 3)
        .all()
    )

    items: list[dict[str, object]] = []
    seen_keys: set[str] = set()

    for buyer in matching_buyers:
        phone_opts = _dial_phone_options_for_buyer(db, buyer.id)
        if not phone_opts:
            continue
        primary_phone = str(phone_opts[0]["phone"])
        contact_id = phone_opts[0].get("contact_id")
        contact_obj = db.get(Contact, contact_id) if contact_id else None

        contact_name = (contact_obj.full_name if contact_obj else None) or buyer.company_name or "Contact"
        company_name = buyer.company_name or ""
        designation_val = (contact_obj.designation if contact_obj else None) or ""
        grading_val = buyer.company_grading or ""
        country_val = buyer.country or (contact_obj.nationality if contact_obj else None) or ""

        key = f"{buyer.id}:{primary_phone}"
        if key in seen_keys:
            continue
        seen_keys.add(key)

        parts = [company_name]
        if contact_name and contact_name != company_name:
            parts.append(contact_name)
        if designation_val:
            parts.append(f"({designation_val})")
        parts.append(f"[{primary_phone}]")
        label = " — ".join(p for p in parts if p)

        items.append(
            {
                "buyer_id": buyer.id,
                "contact_id": contact_id,
                "company_name": company_name,
                "contact_name": contact_name,
                "phone": primary_phone,
                "country": country_val,
                "designation": designation_val or None,
                "grading": grading_val or None,
                "label": label,
            }
        )
        if len(items) >= limit:
            break

    return items


def get_call_filter_options(
    db: Session,
    *,
    assigned_to_user_id: int | None = None,
) -> dict[str, object]:
    """Return distinct countries, gradings, common designations, and section pools for dialer filters."""
    from sqlalchemy import func as sa_func, or_
    from modules import leads as leads_module

    b_query = db.query(Buyer).join(Contact, Contact.buyer_id == Buyer.id)
    if assigned_to_user_id is not None:
        b_query = b_query.filter(Buyer.assigned_to_user_id == assigned_to_user_id)

    b_query = b_query.filter(
        or_(
            sa_func.trim(sa_func.coalesce(Contact.phone, "")) != "",
            sa_func.trim(sa_func.coalesce(Contact.primary_phone, "")) != "",
            sa_func.trim(sa_func.coalesce(Contact.secondary_mobile, "")) != "",
            sa_func.trim(sa_func.coalesce(Contact.secondary_phone, "")) != "",
        )
    )

    # Distinct countries
    raw_countries = (
        b_query.with_entities(sa_func.trim(Buyer.country))
        .filter(Buyer.country.isnot(None), sa_func.trim(Buyer.country) != "")
        .distinct()
        .all()
    )
    countries = sorted([r[0] for r in raw_countries if r[0]])

    # Distinct grades
    raw_grades = (
        b_query.with_entities(sa_func.trim(Buyer.company_grading))
        .filter(Buyer.company_grading.isnot(None), sa_func.trim(Buyer.company_grading) != "")
        .distinct()
        .all()
    )
    grades = sorted([r[0] for r in raw_grades if r[0]])

    # Distinct common designations
    raw_desigs = (
        b_query.with_entities(sa_func.trim(Contact.designation), sa_func.count(Contact.id))
        .filter(Contact.designation.isnot(None), sa_func.trim(Contact.designation) != "")
        .group_by(sa_func.trim(Contact.designation))
        .order_by(sa_func.count(Contact.id).desc())
        .limit(25)
        .all()
    )
    designations = [r[0] for r in raw_desigs if r[0]]

    # Sections / Pools
    try:
        counts = leads_module.count_leads_table_sections(db, assigned_to_user_id=assigned_to_user_id)
    except Exception:
        counts = {}
    sections = [
        {"id": "", "label": "All Sections / Master", "icon": "🌐", "count": int(counts.get("master") or counts.get("all") or 0)},
        {"id": "targeted_distributor", "label": "Targeted Distributors", "icon": "🎯", "count": int(counts.get("targeted_distributor") or 0)},
        {"id": "old_clients", "label": "Old clients", "icon": "👥", "count": int(counts.get("old_clients") or 0)},
        {"id": "hyperstore_targeted", "label": "Hyperstore Target", "icon": "🛒", "count": int(counts.get("hyperstore_targeted") or 0)},
        {"id": "all", "label": "New search lead", "icon": "🆕", "count": int(counts.get("all") or 0)},
        {"id": "interested_clients", "label": "Follow up clients", "icon": "⏰", "count": int(counts.get("interested_clients") or 0)},
        {"id": "sales_interested_clients", "label": "Interested Clients", "icon": "⭐", "count": int(counts.get("sales_interested_clients") or 0)},
        {"id": "not_received_call_clients", "label": "Did not receive call", "icon": "📞", "count": int(counts.get("not_received_call_clients") or 0)},
        {"id": "not_interested_clients", "label": "Not interested", "icon": "🚫", "count": int(counts.get("not_interested_clients") or 0)},
        {"id": "khalid_focused_sales", "label": "Khalid Focused Sales", "icon": "💼", "count": int(counts.get("khalid_focused_sales") or 0)},
        {"id": "targeted_client", "label": "Targeted Client", "icon": "🎯", "count": int(counts.get("targeted_client") or 0)},
        {"id": "incomplete_archives", "label": "Incomplete Archives", "icon": "📦", "count": int(counts.get("incomplete_archives") or 0)},
    ]

    return {
        "sections": sections,
        "countries": countries,
        "grades": grades,
        "designations": designations,
    }
