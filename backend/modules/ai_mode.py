"""AI Mode — after-hours auto-reply + company lifecycle (AISOS Module 3).

When AI Mode is enabled:
- Buyer inquiries / queries (keyword matches) are logged under Company lifecycle →
  New Lead and auto-replied with a brief AI-generated answer tailored to the ask.
- Other person-to-person mail gets the static template auto-reply.
"""

from __future__ import annotations

import hashlib
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy.orm import Session

from db.models import (
    AiCallActivityLog,
    AiCompanyLifecycle,
    AiFollowUpActivityLog,
    AiInterestedActivityLog,
    AiNotInterestedActivityLog,
    AiLeadTransferLog,
    AiModeAutoReplyLog,
    AiModeQueryLog,
    AiModeSettings,
    AppUser,
    AppUserRole,
    Buyer,
    Channel,
    Contact,
    Direction,
    HandledBy,
    Interaction,
    InteractionStatus,
)

LIFECYCLE_STAGES: list[dict[str, str]] = [
    {"key": "new_lead", "label": "New Lead"},
    {"key": "potential_clients", "label": "Potential Clients"},
    {"key": "assigned", "label": "Assigned"},
    {"key": "calling", "label": "Calling"},
    {"key": "follow_up", "label": "Follow-up"},
    {"key": "interested", "label": "Interested"},
    {"key": "not_interested", "label": "Not Interested"},
    {"key": "quotation_sent", "label": "Quotation Sent"},
    {"key": "negotiation", "label": "Negotiation"},
    {"key": "won", "label": "Won"},
    {"key": "lost", "label": "Lost"},
]

LIFECYCLE_STAGE_KEYS = {s["key"] for s in LIFECYCLE_STAGES}

# Interested Clients table → move to Quotation Sent when quotation is marked sent.
_POST_QUOTATION_LIFECYCLE_STAGES = frozenset(
    {"quotation_sent", "negotiation", "won", "lost"}
)

LEAD_TRANSFER_BATCH_SIZE = 20

DEFAULT_QUERY_KEYWORDS = [
    "inquiry",
    "enquiry",
    "quote",
    "quotation",
    "rfq",
    "price list",
    "pricing",
    "interested",
    "looking for",
    "catalogue",
    "catalog",
    "sample",
    "moq",
    "specification",
    "spec sheet",
    "please quote",
    "send quote",
    "bulk supply",
    "import inquiry",
    "import enquiry",
]

# Standalone product/brand words — too weak alone (newsletters, spam, marketing).
_WEAK_ONLY_KEYWORDS = frozenset(
    {
        "product",
        "products",
        "call",
        "form",
        "meeting",
        "information",
        "kafi",
        "essence",
        "basmati",
        "rice",
        "salt",
        "chutney",
        "pickle",
        "spice",
        "import",
        "export",
        "price",  # alone matches "price" in unrelated ads; prefer "pricing" / "price list"
    }
)

_NOISE_MARKERS = (
    "***spam***",
    "[spam]",
    "unsubscribe",
    "newsletter",
    "mailer-daemon",
    "delivery status notification",
    "undeliverable",
    "out of office",
    "automatic reply",
    "auto-reply",
    "do not reply",
    "noreply",
    "no-reply",
    "donotreply",
)

# Bulk marketing / ESP blasts — excluded from auto-reply (not from query scan).
_PROMOTIONAL_MARKERS = (
    "email preferences",
    "manage your preferences",
    "manage subscription",
    "view this email in your browser",
    "view in browser",
    "view online version",
    "marketing email",
    "promotional email",
    "special offer",
    "limited time offer",
    "click here to unsubscribe",
    "you are receiving this email because",
    "you received this email because",
    "add us to your address book",
    "mailing list",
    "bulk email",
    "this is an automated message",
    "sent from mailchimp",
    "sent via mailchimp",
    "constant contact",
    "campaign monitor",
    "hubspot email",
)

# Automated transactional mail — not a person expecting a sales reply.
_TRANSACTIONAL_MARKERS = (
    "order confirmation",
    "your order has been",
    "your order has shipped",
    "shipping confirmation",
    "tracking number",
    "password reset",
    "verify your email",
    "verification code",
    "one-time passcode",
    "invoice attached",
    "payment received",
    "receipt for your",
)

_PROMOTIONAL_LOCAL_PARTS = frozenset(
    {
        "marketing",
        "newsletter",
        "newsletters",
        "promotions",
        "promo",
        "bulk",
        "campaign",
        "deals",
        "offers",
        "bounce",
    }
)

DEFAULT_EMAIL_SUBJECT = "Thank you for your interest in Kafi Commodities"

DEFAULT_EMAIL_BODY = """Dear {name},

Thank you for showing interest in Kafi Commodities.

We would like you to fill out this form{form_clause}, or please provide a suitable date/time for a virtual meeting/call and our team will get back to you.

Best regards,
Kafi Commodities Export Team
"""

DEFAULT_WHATSAPP_BODY = """Thank you for showing interest in Kafi Commodities.

Please fill out this form{form_clause}, or share a suitable date/time for a virtual meeting/call and our team will get back to you.

— Kafi Commodities Export Team"""


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _is_admin_user(user: AppUser) -> bool:
    role = user.role.value if isinstance(user.role, AppUserRole) else str(user.role)
    return role == AppUserRole.admin.value


def lifecycle_assignee_scope(user: AppUser | None) -> int | None:
    """Non-admins only see leads assigned to them in Company lifecycle."""
    if user is None:
        return None
    if _is_admin_user(user):
        return None
    return user.id


def _apply_buyer_assignee_scope(query, assigned_to_user_id: int | None):
    if assigned_to_user_id is not None:
        return query.filter(Buyer.assigned_to_user_id == assigned_to_user_id)
    return query


_AUTO_REPLY_SETTING_KEYS = frozenset(
    {
        "enabled",
        "email_auto_reply_enabled",
        "whatsapp_auto_reply_enabled",
        "form_url",
        "email_subject_template",
        "email_body_template",
        "whatsapp_body_template",
        "query_keywords",
    }
)


def require_admin_for_auto_reply(user: AppUser) -> None:
    if not _is_admin_user(user):
        raise PermissionError("Only an admin can use AI Mode auto-reply and query AI replies.")


def _message_received_at(msg: dict[str, Any]) -> datetime | None:
    from modules.inbox_cutoff import as_utc

    raw = msg.get("date")
    if raw is None:
        return None
    if isinstance(raw, datetime):
        return as_utc(raw)
    if isinstance(raw, str):
        from modules.inbox_cutoff import _parse_datetime

        return _parse_datetime(raw)
    return None


def _is_inbound_after_auto_reply_enabled(
    msg: dict[str, Any],
    enabled_at: datetime | None,
) -> bool:
    """True only for messages received after AI Mode was turned on."""
    if enabled_at is None:
        return False
    received = _message_received_at(msg)
    if received is None:
        return False
    cutoff = enabled_at
    if cutoff.tzinfo is None:
        cutoff = cutoff.replace(tzinfo=timezone.utc)
    else:
        cutoff = cutoff.astimezone(timezone.utc)
    return received >= cutoff


def _default_settings_payload() -> dict[str, Any]:
    return {
        "enabled": False,
        "email_auto_reply_enabled": True,
        "whatsapp_auto_reply_enabled": True,
        "form_url": None,
        "email_subject_template": DEFAULT_EMAIL_SUBJECT,
        "email_body_template": DEFAULT_EMAIL_BODY.strip(),
        "whatsapp_body_template": DEFAULT_WHATSAPP_BODY.strip(),
        "query_keywords": list(DEFAULT_QUERY_KEYWORDS),
        "last_email_processed_at": None,
        "updated_at": None,
    }


def get_or_create_settings(db: Session, user_id: int) -> AiModeSettings:
    row = db.get(AiModeSettings, user_id)
    if row:
        return row
    defaults = _default_settings_payload()
    row = AiModeSettings(
        user_id=user_id,
        enabled=False,
        email_auto_reply_enabled=True,
        whatsapp_auto_reply_enabled=True,
        form_url=None,
        email_subject_template=defaults["email_subject_template"],
        email_body_template=defaults["email_body_template"],
        whatsapp_body_template=defaults["whatsapp_body_template"],
        query_keywords=defaults["query_keywords"],
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def settings_to_dict(row: AiModeSettings) -> dict[str, Any]:
    from modules import ai_mode_company_research as ai_mode_research_module
    from modules import ai_mode_llm as ai_mode_llm_module

    return {
        "user_id": row.user_id,
        "enabled": bool(row.enabled),
        "email_auto_reply_enabled": bool(row.email_auto_reply_enabled),
        "whatsapp_auto_reply_enabled": bool(row.whatsapp_auto_reply_enabled),
        "form_url": row.form_url,
        "email_subject_template": row.email_subject_template or DEFAULT_EMAIL_SUBJECT,
        "email_body_template": row.email_body_template or DEFAULT_EMAIL_BODY.strip(),
        "whatsapp_body_template": row.whatsapp_body_template or DEFAULT_WHATSAPP_BODY.strip(),
        "query_keywords": resolve_query_keywords(row.query_keywords),
        "last_email_processed_at": row.last_email_processed_at.isoformat()
        if row.last_email_processed_at
        else None,
        "enabled_at": row.enabled_at.isoformat() if row.enabled_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
        "lifecycle_stages": LIFECYCLE_STAGES,
        "auto_reply_admin_only": True,
        "llm_query_enabled": ai_mode_llm_module.query_llm_enabled(),
        "llm_auto_reply_enabled": ai_mode_llm_module.auto_reply_llm_enabled(),
        "serpapi_auto_reply_enabled": ai_mode_research_module.auto_reply_serpapi_enabled(),
    }


def update_settings(
    db: Session,
    user_id: int,
    data: dict[str, Any],
    *,
    actor: AppUser | None = None,
) -> dict[str, Any]:
    if actor is not None and any(key in data for key in _AUTO_REPLY_SETTING_KEYS):
        require_admin_for_auto_reply(actor)

    row = get_or_create_settings(db, user_id)
    was_enabled = bool(row.enabled)
    if "enabled" in data and data["enabled"] is not None:
        new_enabled = bool(data["enabled"])
        if new_enabled and not was_enabled:
            row.enabled_at = _utcnow()
        elif not new_enabled and was_enabled:
            row.enabled_at = None
        row.enabled = new_enabled
    if "email_auto_reply_enabled" in data and data["email_auto_reply_enabled"] is not None:
        row.email_auto_reply_enabled = bool(data["email_auto_reply_enabled"])
    if "whatsapp_auto_reply_enabled" in data and data["whatsapp_auto_reply_enabled"] is not None:
        row.whatsapp_auto_reply_enabled = bool(data["whatsapp_auto_reply_enabled"])
    if "form_url" in data:
        url = (data["form_url"] or "").strip() or None
        row.form_url = url
    if "email_subject_template" in data and data["email_subject_template"] is not None:
        row.email_subject_template = str(data["email_subject_template"]).strip() or DEFAULT_EMAIL_SUBJECT
    if "email_body_template" in data and data["email_body_template"] is not None:
        row.email_body_template = str(data["email_body_template"]).strip() or DEFAULT_EMAIL_BODY.strip()
        # Keep WhatsApp template synchronized with email unless WhatsApp is updated in the same request.
        if "whatsapp_body_template" not in data:
            from modules.channel_sync import derive_whatsapp_from_email

            row.whatsapp_body_template = derive_whatsapp_from_email(row.email_body_template) or (
                DEFAULT_WHATSAPP_BODY.strip()
            )
    if "whatsapp_body_template" in data and data["whatsapp_body_template"] is not None:
        row.whatsapp_body_template = (
            str(data["whatsapp_body_template"]).strip() or DEFAULT_WHATSAPP_BODY.strip()
        )
    if "query_keywords" in data and data["query_keywords"] is not None:
        keywords = data["query_keywords"]
        if isinstance(keywords, str):
            keywords = [k.strip() for k in keywords.split(",") if k.strip()]
        row.query_keywords = [str(k).strip().lower() for k in keywords if str(k).strip()]
    row.updated_at = _utcnow()
    db.commit()
    db.refresh(row)
    return settings_to_dict(row)


def _form_clause(form_url: str | None) -> str:
    url = (form_url or "").strip()
    if url:
        return f": {url}"
    return " (link will be shared by our team)"


def render_template(template: str, *, name: str, form_url: str | None, subject: str = "") -> str:
    return (
        (template or "")
        .replace("{name}", name or "Sir/Madam")
        .replace("{form_clause}", _form_clause(form_url))
        .replace("{form_url}", (form_url or "").strip() or "(form link)")
        .replace("{subject}", subject or "")
    )


def _phrase_in(haystack: str, phrase: str) -> bool:
    """Word-boundary match for single tokens; substring for multi-word phrases."""
    p = (phrase or "").strip().lower()
    if not p:
        return False
    if " " in p or "-" in p:
        return p in haystack
    return re.search(rf"(?<![a-z0-9]){re.escape(p)}(?![a-z0-9])", haystack) is not None


def resolve_query_keywords(stored: list[str] | None) -> list[str]:
    """Prefer inquiry-focused keywords; drop legacy weak-only tokens from old defaults."""
    keys = [str(k).strip().lower() for k in (stored or []) if str(k).strip()]
    if not keys:
        return list(DEFAULT_QUERY_KEYWORDS)
    # Old defaults mixed intent words with brand/product noise — strip the noise.
    cleaned = [k for k in keys if k not in _WEAK_ONLY_KEYWORDS]
    return cleaned if cleaned else list(DEFAULT_QUERY_KEYWORDS)


def _is_noise_message(
    text: str,
    *,
    from_email: str | None = None,
) -> bool:
    hay = (text or "").lower()
    addr = (from_email or "").strip().lower()
    if any(m in hay for m in _NOISE_MARKERS):
        return True
    if addr:
        local = addr.split("@", 1)[0]
        if local in {
            "noreply",
            "no-reply",
            "donotreply",
            "do-not-reply",
            "mailer-daemon",
            "notifications",
        }:
            return True
        if local.startswith("noreply") or local.startswith("no-reply"):
            return True
        if "noreply@" in addr or "no-reply@" in addr:
            return True
    return False


def looks_like_query(
    text: str,
    keywords: list[str] | None,
    *,
    from_email: str | None = None,
) -> bool:
    """True only for genuine buyer-inquiry style mail — not newsletters/spam/weak hits."""
    hay = (text or "").lower()
    if not hay.strip():
        return False
    if _is_noise_message(hay, from_email=from_email):
        return False

    keys = [str(k).strip().lower() for k in (keywords or DEFAULT_QUERY_KEYWORDS) if str(k).strip()]
    if not keys:
        keys = [k.lower() for k in DEFAULT_QUERY_KEYWORDS]

    matched = [k for k in keys if _phrase_in(hay, k)]
    if not matched:
        return False

    # Reject if every hit is a weak brand/product word with no real inquiry intent.
    if all(m in _WEAK_ONLY_KEYWORDS for m in matched):
        return False

    return True


def looks_like_auto_reply_target(
    text: str,
    *,
    from_email: str | None = None,
) -> bool:
    """True for real inbound mail from a person — not newsletters, promos, or system mail."""
    hay = (text or "").lower()
    if not hay.strip():
        return False
    if _is_noise_message(hay, from_email=from_email):
        return False
    if any(m in hay for m in _PROMOTIONAL_MARKERS):
        return False
    if any(m in hay for m in _TRANSACTIONAL_MARKERS):
        return False
    addr = (from_email or "").strip().lower()
    if addr:
        local = addr.split("@", 1)[0]
        if local in _PROMOTIONAL_LOCAL_PARTS:
            return False
        if any(local.startswith(p) for p in _PROMOTIONAL_LOCAL_PARTS):
            return False
    return True


def _message_key(*parts: str) -> str:
    raw = "|".join(p.strip().lower() for p in parts if p)
    return hashlib.sha256(raw.encode("utf-8", errors="ignore")).hexdigest()[:64]


def _already_sent(db: Session, user_id: int, message_key: str) -> bool:
    """Block retries when already sent or another worker is composing a reply."""
    row = (
        db.query(AiModeAutoReplyLog)
        .filter(
            AiModeAutoReplyLog.user_id == user_id,
            AiModeAutoReplyLog.message_key == message_key,
        )
        .order_by(AiModeAutoReplyLog.id.desc())
        .first()
    )
    if not row:
        return False
    if row.status == "sent":
        return True
    if row.status == "processing":
        # Stale in-flight claim (worker crash) — allow retry after 10 minutes.
        if row.created_at is not None:
            age = (_utcnow() - row.created_at).total_seconds()
            if age > 600:
                return False
        return True
    return False


def _try_claim_auto_reply(
    db: Session,
    *,
    user_id: int,
    channel: str,
    message_key: str,
    recipient: str | None,
    subject: str | None,
    preview: str | None,
) -> bool:
    """Insert or reclaim a processing row so only one worker sends for this message."""
    from sqlalchemy.exc import IntegrityError

    existing = (
        db.query(AiModeAutoReplyLog)
        .filter(
            AiModeAutoReplyLog.user_id == user_id,
            AiModeAutoReplyLog.message_key == message_key,
        )
        .order_by(AiModeAutoReplyLog.id.desc())
        .first()
    )
    if existing:
        if existing.status == "sent":
            return False
        if existing.status == "processing":
            if existing.created_at is not None:
                age = (_utcnow() - existing.created_at).total_seconds()
                if age <= 600:
                    return False
        existing.channel = channel
        existing.recipient = recipient
        existing.subject = subject
        existing.preview = (preview or "")[:2000] or None
        existing.status = "processing"
        existing.detail = "composing"
        db.commit()
        return True

    try:
        db.add(
            AiModeAutoReplyLog(
                user_id=user_id,
                channel=channel,
                message_key=message_key,
                recipient=recipient,
                subject=subject,
                preview=(preview or "")[:2000] or None,
                status="processing",
                detail="composing",
            )
        )
        db.commit()
        return True
    except IntegrityError:
        db.rollback()
        return False


def _log_reply(
    db: Session,
    *,
    user_id: int,
    channel: str,
    message_key: str,
    recipient: str | None,
    subject: str | None,
    preview: str | None,
    status: str,
    detail: str | None = None,
) -> None:
    existing = (
        db.query(AiModeAutoReplyLog)
        .filter(
            AiModeAutoReplyLog.user_id == user_id,
            AiModeAutoReplyLog.message_key == message_key,
        )
        .order_by(AiModeAutoReplyLog.id.desc())
        .first()
    )
    if existing:
        if existing.status == "sent":
            return
        existing.recipient = recipient
        existing.subject = subject
        existing.preview = (preview or "")[:2000] or None
        existing.status = status
        existing.detail = detail
        existing.channel = channel
        db.commit()
        return
    db.add(
        AiModeAutoReplyLog(
            user_id=user_id,
            channel=channel,
            message_key=message_key,
            recipient=recipient,
            subject=subject,
            preview=(preview or "")[:2000] or None,
            status=status,
            detail=detail,
        )
    )
    db.commit()


def list_auto_reply_log(db: Session, user_id: int, *, limit: int = 50) -> list[dict[str, Any]]:
    rows = (
        db.query(AiModeAutoReplyLog)
        .filter(AiModeAutoReplyLog.user_id == user_id)
        .order_by(AiModeAutoReplyLog.created_at.desc())
        .limit(limit)
        .all()
    )
    return [
        {
            "id": r.id,
            "channel": r.channel,
            "recipient": r.recipient,
            "subject": r.subject,
            "preview": r.preview,
            "status": r.status,
            "detail": r.detail,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]


def _query_row_to_dict(row: AiModeQueryLog) -> dict[str, Any]:
    return {
        "id": row.id,
        "folder": row.folder,
        "uid": row.uid,
        "from_email": row.from_email,
        "from_name": row.from_name,
        "subject": row.subject,
        "preview": row.preview,
        "received_at": row.received_at.isoformat() if row.received_at else None,
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


def upsert_query_log(
    db: Session,
    *,
    user_id: int,
    message_key: str,
    folder: str,
    uid: str,
    from_email: str | None,
    from_name: str | None,
    subject: str | None,
    preview: str | None,
    received_at: datetime | None,
) -> tuple[AiModeQueryLog, bool]:
    """Insert or refresh a query detection. Returns (row, created)."""
    existing = (
        db.query(AiModeQueryLog)
        .filter(
            AiModeQueryLog.user_id == user_id,
            AiModeQueryLog.message_key == message_key,
        )
        .one_or_none()
    )
    if existing:
        existing.folder = folder
        existing.uid = uid
        existing.from_email = from_email
        existing.from_name = from_name
        existing.subject = subject
        existing.preview = (preview or "")[:2000] or None
        if received_at is not None:
            existing.received_at = received_at
        db.commit()
        db.refresh(existing)
        return existing, False

    row = AiModeQueryLog(
        user_id=user_id,
        message_key=message_key,
        folder=folder,
        uid=uid,
        from_email=from_email,
        from_name=from_name,
        subject=subject,
        preview=(preview or "")[:2000] or None,
        received_at=received_at,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row, True


def _purge_non_query_rows(
    db: Session,
    user_id: int,
    keywords: list[str],
) -> int:
    """Remove logged rows that no longer pass the inquiry filter."""
    rows = (
        db.query(AiModeQueryLog)
        .filter(AiModeQueryLog.user_id == user_id)
        .all()
    )
    removed = 0
    for row in rows:
        blob = f"{row.subject or ''}\n{row.preview or ''}"
        if looks_like_query(blob, keywords, from_email=row.from_email):
            continue
        db.delete(row)
        removed += 1
    if removed:
        db.commit()
    return removed


def list_queries(db: Session, user_id: int, *, limit: int = 100) -> dict[str, Any]:
    settings = get_or_create_settings(db, user_id)
    keywords = resolve_query_keywords(settings.query_keywords)
    _purge_non_query_rows(db, user_id, keywords)

    total = (
        db.query(AiModeQueryLog.id).filter(AiModeQueryLog.user_id == user_id).count()
    )
    rows = (
        db.query(AiModeQueryLog)
        .filter(AiModeQueryLog.user_id == user_id)
        .order_by(
            AiModeQueryLog.received_at.desc().nullslast(),
            AiModeQueryLog.created_at.desc(),
        )
        .limit(limit)
        .all()
    )
    return {"count": total, "rows": [_query_row_to_dict(r) for r in rows]}


def get_query(db: Session, user_id: int, query_id: int) -> AiModeQueryLog | None:
    return (
        db.query(AiModeQueryLog)
        .filter(AiModeQueryLog.id == query_id, AiModeQueryLog.user_id == user_id)
        .one_or_none()
    )


def fetch_query_message(db: Session, user: AppUser, query_id: int) -> dict[str, Any]:
    """Load full mailbox message for a logged query belonging to this user."""
    row = get_query(db, user.id, query_id)
    if not row:
        raise ValueError("Query not found")

    from modules import inbox as inbox_module
    from modules.mailbox_accounts import hosts_enabled, resolve_user_mailbox

    if not hosts_enabled() or not resolve_user_mailbox(user):
        raise ValueError("Mailbox not configured for your account")

    folder = row.folder or "INBOX"
    message = inbox_module.get_message(user, row.uid, folder=folder)
    if not message and folder.upper() != "INBOX":
        message = inbox_module.get_message(user, row.uid, folder="INBOX")
    if not message:
        raise ValueError("Original email not found in mailbox (may have been moved or deleted)")

    return {
        "query": _query_row_to_dict(row),
        "message": message,
    }


def generate_query_reply_draft(db: Session, user: AppUser, query_id: int) -> dict[str, Any]:
    """LLM-generated reply for Company lifecycle → New Lead (falls back to template)."""
    require_admin_for_auto_reply(user)
    payload = fetch_query_message(db, user, query_id)
    query = payload["query"]
    message = payload["message"] or {}
    settings = get_or_create_settings(db, user.id)

    sender_email = (message.get("from_email") or query.get("from_email") or "").strip()
    subject = (message.get("subject") or query.get("subject") or "").strip()
    inbound_body = (
        (message.get("body_text") or message.get("body") or message.get("preview") or "")
        .strip()
        or (query.get("preview") or "").strip()
    )

    from modules.ai_mode_sender import resolve_sender_context

    sender_ctx = resolve_sender_context(
        from_name=(message.get("from_name") or query.get("from_name") or "").strip() or None,
        from_email=sender_email or None,
        subject=subject,
        inbound_body=inbound_body,
    )
    greeting_name = sender_ctx["greeting_name"]
    display_name = (
        (message.get("from_name") or query.get("from_name") or "").strip()
        or greeting_name
    )

    fallback = render_template(
        settings.email_body_template,
        name=greeting_name,
        form_url=settings.form_url,
        subject=subject,
    )

    from modules import ai_mode_llm as ai_mode_llm_module

    draft = ai_mode_llm_module.draft_query_email_reply(
        sender_name=display_name,
        sender_email=sender_email,
        greeting_name=greeting_name,
        subject=subject,
        inbound_body=inbound_body,
        form_url=settings.form_url,
        template_hint=settings.email_body_template or DEFAULT_EMAIL_BODY.strip(),
        fallback_body=fallback,
    )

    reply_subject = render_template(
        settings.email_subject_template or DEFAULT_EMAIL_SUBJECT,
        name=greeting_name,
        form_url=settings.form_url,
        subject=subject,
    )
    if subject and not reply_subject.lower().startswith("re:"):
        if "{subject}" not in (settings.email_subject_template or ""):
            reply_subject = f"Re: {subject}" if subject else reply_subject

    return {
        "query_id": query_id,
        "body": draft.get("body") or fallback,
        "subject": reply_subject,
        "source": draft.get("source") or "template",
        "llm_enabled": draft.get("llm_enabled", False),
        "model": draft.get("model"),
        "error": draft.get("error"),
        "fallback_reason": draft.get("fallback_reason"),
        "greeting_name": greeting_name,
    }


def _compose_auto_reply_email_body(
    *,
    settings: AiModeSettings,
    sender_name: str,
    sender_email: str,
    subject: str,
    inbound_preview: str,
    inbound_body: str | None = None,
) -> dict[str, Any]:
    """Static template for non-inquiry after-hours auto-replies."""
    from modules.ai_mode_sender import resolve_sender_context

    body_text = inbound_body or inbound_preview
    sender_ctx = resolve_sender_context(
        from_name=sender_name or None,
        from_email=sender_email or None,
        subject=subject,
        inbound_body=body_text,
    )
    greeting_name = sender_ctx["greeting_name"]
    body = render_template(
        settings.email_body_template,
        name=greeting_name,
        form_url=settings.form_url,
        subject=subject,
    )
    return {
        "body": body,
        "source": "template",
        "llm_enabled": False,
        "greeting_name": greeting_name,
    }


def _compose_query_auto_reply_email_body(
    *,
    settings: AiModeSettings,
    sender_name: str,
    sender_email: str,
    subject: str,
    inbound_body: str,
) -> dict[str, Any]:
    """Brief AI reply for New Lead (Queries) auto-send when AI Mode is on."""
    from modules.ai_mode_sender import resolve_sender_context

    body_text = (inbound_body or subject or "").strip()
    sender_ctx = resolve_sender_context(
        from_name=sender_name or None,
        from_email=sender_email or None,
        subject=subject,
        inbound_body=body_text,
    )
    greeting_name = sender_ctx["greeting_name"]
    display_name = (sender_name or "").strip() or greeting_name
    fallback = render_template(
        settings.email_body_template,
        name=greeting_name,
        form_url=settings.form_url,
        subject=subject,
    )

    from modules import ai_mode_llm as ai_mode_llm_module

    draft = ai_mode_llm_module.draft_query_email_reply(
        sender_name=display_name,
        sender_email=sender_email,
        greeting_name=greeting_name,
        subject=subject,
        inbound_body=body_text,
        form_url=settings.form_url,
        template_hint=settings.email_body_template or DEFAULT_EMAIL_BODY.strip(),
        fallback_body=fallback,
    )
    return {
        "body": draft.get("body") or fallback,
        "source": draft.get("source") or "template",
        "llm_enabled": draft.get("llm_enabled", False),
        "model": draft.get("model"),
        "error": draft.get("error"),
        "fallback_reason": draft.get("fallback_reason"),
        "greeting_name": greeting_name,
    }


# Cap how many New Lead query emails we auto-reply per scheduler tick / process call.
_MAX_QUERY_AUTO_REPLIES_PER_RUN = 5


def _compose_auto_reply_whatsapp_body(
    *,
    settings: AiModeSettings,
    sender_name: str,
    inbound_text: str,
    sender_email: str | None = None,
) -> dict[str, Any]:
    """Static WhatsApp template — same after-hours policy as email auto-reply."""
    from modules.ai_mode_sender import resolve_sender_context
    from modules.channel_sync import derive_whatsapp_from_email

    sender_ctx = resolve_sender_context(
        from_name=sender_name or None,
        from_email=sender_email or None,
        subject="",
        inbound_body=inbound_text,
    )
    greeting_name = sender_ctx["greeting_name"]
    wa_template = (settings.whatsapp_body_template or "").strip()
    if wa_template:
        body = render_template(
            wa_template,
            name=greeting_name,
            form_url=settings.form_url,
            subject="",
        )
    else:
        email_body = render_template(
            settings.email_body_template,
            name=greeting_name,
            form_url=settings.form_url,
            subject="",
        )
        body = derive_whatsapp_from_email(email_body) or email_body
    return {
        "body": body,
        "source": "template",
        "llm_enabled": False,
        "greeting_name": greeting_name,
    }


def scan_queries_for_user(
    db: Session,
    user: AppUser,
    *,
    deep: bool = False,
    limit: int = 10,
) -> dict[str, Any]:
    """Scan inbox for real inquiry matches and upsert query log rows.

    deep=True (Scan mailbox button): fresh IMAP pull of the latest N emails
    (read + unread), with full bodies. Default N=10.
    deep=False (background job): lighter unread-only headers scan.
    """
    settings = get_or_create_settings(db, user.id)
    from modules import inbox as inbox_module
    from modules.inbox_cutoff import as_utc
    from modules.mailbox_accounts import hosts_enabled, resolve_user_mailbox

    if not hosts_enabled() or not resolve_user_mailbox(user):
        return {
            "scanned": 0,
            "matched": 0,
            "created": 0,
            "purged": 0,
            "deep": deep,
            "error": "Mailbox not configured",
        }

    keywords = resolve_query_keywords(settings.query_keywords)
    # Drop previously logged false positives (weak keyword / spam matches).
    purged = _purge_non_query_rows(db, user.id, keywords)

    created = 0
    matched = 0
    scanned = 0
    deepened = 0
    errors: list[str] = []
    fetch_limit = max(1, min(int(limit or 10), 50))

    try:
        if deep:
            messages = inbox_module.list_inbox_for_query_scan(user, limit=fetch_limit)
        else:
            messages = inbox_module.list_messages(
                user, limit=min(fetch_limit, 40), unread_only=True, folder="inbox"
            )
    except Exception as exc:  # noqa: BLE001
        return {
            "scanned": 0,
            "matched": 0,
            "created": 0,
            "purged": purged,
            "deep": deep,
            "error": str(exc),
            "errors": [str(exc)],
        }

    for msg in messages:
        scanned += 1
        if msg.get("direction") == "outbound":
            continue
        subject = (msg.get("subject") or "").strip()
        preview = (msg.get("preview") or "").strip()
        body = (
            (msg.get("body_text") or msg.get("body") or msg.get("body_html") or "")
            .strip()
        )
        from_email = (msg.get("from_email") or "").strip()
        uid = str(msg.get("uid") or "")
        if not from_email or not uid:
            continue

        blob = f"{subject}\n{preview}\n{body}"
        # Deepen with full fetch if headers-only left body empty and subject is thin.
        if deep and not body and not looks_like_query(
            f"{subject}\n{preview}", keywords, from_email=from_email
        ):
            # Still try a detail fetch — keyword may only appear in body.
            try:
                detail = inbox_module.get_message(
                    user, uid, folder=str(msg.get("folder") or "INBOX")
                )
                if detail:
                    deepened += 1
                    body = (
                        (detail.get("body_text") or detail.get("body") or "")
                        .strip()
                    )
                    preview = preview or (detail.get("preview") or "").strip()
                    blob = f"{subject}\n{preview}\n{body}"
            except Exception as exc:  # noqa: BLE001
                errors.append(f"uid {uid}: {exc}")

        if not looks_like_query(blob, keywords, from_email=from_email):
            continue

        matched += 1
        key = _message_key("email", "inbox", uid, from_email, subject)
        received = as_utc(msg.get("date")) if msg.get("date") else None
        imap_folder = str(msg.get("folder") or "INBOX")
        preview_out = (preview or body or "")[:400] or None
        _, was_created = upsert_query_log(
            db,
            user_id=user.id,
            message_key=key,
            folder=imap_folder,
            uid=uid,
            from_email=from_email,
            from_name=(msg.get("from_name") or "").strip() or None,
            subject=subject or None,
            preview=preview_out,
            received_at=received,
        )
        if was_created:
            created += 1

    return {
        "scanned": scanned,
        "matched": matched,
        "created": created,
        "purged": purged,
        "deepened": deepened,
        "deep": deep,
        "errors": errors[:5],
    }


def scan_queries_for_all_mailbox_users(db: Session | None = None) -> dict[str, Any]:
    """Scan every active user with a configured mailbox (AI Mode not required).

    Same inquiry filter for all accounts — each user's New Lead (Queries) is
    isolated to their own inbox + keywords.

    When ``db`` is omitted, opens a short-lived session per user so IMAP work
    does not pin one pool connection for the whole mailbox sweep.
    """
    from modules.mailbox_accounts import hosts_enabled, resolve_user_mailbox

    if not hosts_enabled():
        return {"users": 0, "matched": 0, "created": 0, "purged": 0, "errors": []}

    totals: dict[str, Any] = {
        "users": 0,
        "matched": 0,
        "created": 0,
        "purged": 0,
        "errors": [],
    }

    def _scan_one(session: Session, user: AppUser) -> None:
        if not resolve_user_mailbox(user):
            return
        totals["users"] += 1
        get_or_create_settings(session, user.id)
        result = scan_queries_for_user(session, user, deep=False, limit=40)
        totals["matched"] += int(result.get("matched") or 0)
        totals["created"] += int(result.get("created") or 0)
        totals["purged"] += int(result.get("purged") or 0)
        err = result.get("error")
        if err:
            totals["errors"].append(f"user {user.id}: {err}")
        for e in result.get("errors") or []:
            totals["errors"].append(f"user {user.id}: {e}")

    if db is not None:
        users = (
            db.query(AppUser)
            .filter(AppUser.is_active.is_(True))
            .order_by(AppUser.id.asc())
            .all()
        )
        for user in users:
            _scan_one(db, user)
    else:
        from db.session import SessionLocal

        list_db = SessionLocal()
        try:
            user_ids = [
                int(uid)
                for (uid,) in list_db.query(AppUser.id)
                .filter(AppUser.is_active.is_(True))
                .order_by(AppUser.id.asc())
                .all()
            ]
        finally:
            list_db.close()

        for uid in user_ids:
            session = SessionLocal()
            try:
                user = session.get(AppUser, uid)
                if user:
                    _scan_one(session, user)
            except Exception as exc:  # noqa: BLE001
                totals["errors"].append(f"user {uid}: {exc}")
            finally:
                try:
                    session.rollback()
                except Exception:  # noqa: BLE001
                    pass
                session.close()

    totals["errors"] = totals["errors"][:20]
    return totals


def _send_one_email_auto_reply(
    db: Session,
    user: AppUser,
    settings: AiModeSettings,
    *,
    folder: str,
    msg: dict[str, Any],
    is_query: bool,
) -> dict[str, Any]:
    """Claim, compose, and send one auto-reply. Returns status/detail dict."""
    from modules import inbox as inbox_module

    subject = (msg.get("subject") or "").strip()
    preview = (msg.get("preview") or msg.get("body") or "").strip()
    from_email = (msg.get("from_email") or "").strip()
    uid = str(msg.get("uid") or "")
    key = str(msg.get("_ai_key") or "")
    display_name = (msg.get("from_name") or "").strip()
    folder_name = msg.get("folder") or ("INBOX" if folder == "inbox" else folder)

    reply_subject = render_template(
        settings.email_subject_template or DEFAULT_EMAIL_SUBJECT,
        name=display_name or from_email.split("@")[0],
        form_url=settings.form_url,
        subject=subject,
    )
    if subject and not reply_subject.lower().startswith("re:"):
        if "{subject}" not in (settings.email_subject_template or ""):
            reply_subject = f"Re: {subject}" if subject else reply_subject

    if not _try_claim_auto_reply(
        db,
        user_id=user.id,
        channel="email",
        message_key=key,
        recipient=from_email,
        subject=reply_subject,
        preview=preview[:400],
    ):
        return {
            "status": "skipped",
            "reason": "already_claimed",
            "recipient": from_email,
            "subject": reply_subject,
        }

    reply_detail = "source=unknown"
    try:
        inbound_body = preview
        if is_query:
            # Pull full body so the AI answers the actual question, not just the preview.
            try:
                detail = inbox_module.get_message(user, uid, folder=folder_name)
                if detail:
                    inbound_body = (
                        (detail.get("body_text") or detail.get("body") or detail.get("preview") or "")
                        .strip()
                        or preview
                    )
                    if not display_name:
                        display_name = (detail.get("from_name") or "").strip()
            except Exception:  # noqa: BLE001
                inbound_body = preview

            draft_result = _compose_query_auto_reply_email_body(
                settings=settings,
                sender_name=display_name,
                sender_email=from_email,
                subject=subject,
                inbound_body=inbound_body,
            )
            reply_detail = "kind=query_ai"
        else:
            draft_result = _compose_auto_reply_email_body(
                settings=settings,
                sender_name=display_name,
                sender_email=from_email,
                subject=subject,
                inbound_preview=preview,
                inbound_body=preview,
            )
            reply_detail = "kind=template"

        greeting_name = (
            draft_result.get("greeting_name") or display_name or from_email.split("@")[0]
        )
        body = draft_result.get("body") or render_template(
            settings.email_body_template,
            name=greeting_name,
            form_url=settings.form_url,
            subject=subject,
        )
        reply_source = draft_result.get("source") or "template"
        reply_detail += f"; source={reply_source}"
        if draft_result.get("fallback_reason"):
            reply_detail += f"; fallback={draft_result['fallback_reason']}"
        if draft_result.get("error"):
            reply_detail += f"; error={str(draft_result['error'])[:200]}"

        if greeting_name:
            reply_subject = render_template(
                settings.email_subject_template or DEFAULT_EMAIL_SUBJECT,
                name=greeting_name,
                form_url=settings.form_url,
                subject=subject,
            )
            if subject and not reply_subject.lower().startswith("re:"):
                if "{subject}" not in (settings.email_subject_template or ""):
                    reply_subject = f"Re: {subject}" if subject else reply_subject

        result = inbox_module.reply(
            user,
            uid,
            body,
            folder=folder_name,
            to=from_email,
            subject=reply_subject,
            include_quote=False,
        )
        status = result.get("status") or "error"
        detail = result.get("message")
        _log_reply(
            db,
            user_id=user.id,
            channel="email",
            message_key=key,
            recipient=from_email,
            subject=reply_subject,
            preview=preview[:400],
            status="sent" if status == "sent" else status,
            detail=f"{detail or ''}; {reply_detail}".strip("; "),
        )
        return {
            "status": status,
            "recipient": from_email,
            "subject": reply_subject,
            "detail": detail,
            "is_query": is_query,
            "reply_source": reply_source,
        }
    except Exception as exc:  # noqa: BLE001
        _log_reply(
            db,
            user_id=user.id,
            channel="email",
            message_key=key,
            recipient=from_email,
            subject=reply_subject,
            preview=preview[:400],
            status="error",
            detail=f"{exc}; {reply_detail}".strip("; "),
        )
        return {
            "status": "error",
            "recipient": from_email,
            "subject": reply_subject,
            "detail": str(exc),
            "is_query": is_query,
        }


def process_email_auto_replies_for_user(
    db: Session,
    user: AppUser,
    *,
    scan_queries: bool = True,
) -> dict[str, Any]:
    """Auto-reply to eligible unread inbound mail when AI Mode is on.

    New Lead (query) emails get a brief AI-generated reply (up to
    ``_MAX_QUERY_AUTO_REPLIES_PER_RUN`` per tick). Other person-to-person mail
    gets one static template reply per run.

    Admin only. Only messages received after AI Mode was enabled are eligible.
    """
    if not _is_admin_user(user):
        return {
            "processed": 0,
            "replied": 0,
            "skipped": 0,
            "enabled": False,
            "error": "Admin only",
            "queries": {"skipped": True},
        }

    # Always refresh query detections first (count does not require auto-reply on).
    query_scan = (
        scan_queries_for_user(db, user, deep=False, limit=40)
        if scan_queries
        else {"skipped": True}
    )

    settings = get_or_create_settings(db, user.id)
    if not settings.enabled or not settings.email_auto_reply_enabled:
        return {
            "processed": 0,
            "replied": 0,
            "skipped": 0,
            "enabled": False,
            "queries": query_scan,
        }

    from modules import inbox as inbox_module
    from modules.inbox_cutoff import date_sort_key
    from modules.mailbox_accounts import hosts_enabled, resolve_user_mailbox

    if not hosts_enabled() or not resolve_user_mailbox(user):
        return {
            "processed": 0,
            "replied": 0,
            "skipped": 0,
            "enabled": True,
            "error": "Mailbox not configured",
            "queries": query_scan,
        }

    folders = ["inbox"]
    query_candidates: list[tuple[str, dict[str, Any]]] = []
    other_candidates: list[tuple[str, dict[str, Any]]] = []
    errors: list[str] = []
    skip_reasons: dict[str, int] = {
        "outbound": 0,
        "missing_fields": 0,
        "promotional_or_noise": 0,
        "already_sent": 0,
        "before_enabled_at": 0,
    }
    query_keywords = resolve_query_keywords(settings.query_keywords)

    enabled_at = settings.enabled_at
    if settings.enabled and enabled_at is None:
        enabled_at = _utcnow()
        settings.enabled_at = enabled_at
        db.commit()

    for folder in folders:
        try:
            messages = inbox_module.list_messages(
                user, limit=40, unread_only=True, folder=folder
            )
        except Exception as exc:  # noqa: BLE001
            if folder == "inbox":
                errors.append(str(exc))
            continue

        for msg in messages:
            if msg.get("direction") == "outbound":
                skip_reasons["outbound"] += 1
                continue
            subject = (msg.get("subject") or "").strip()
            preview = (msg.get("preview") or msg.get("body") or "").strip()
            from_email = (msg.get("from_email") or "").strip()
            uid = str(msg.get("uid") or "")
            if not from_email or not uid:
                skip_reasons["missing_fields"] += 1
                continue

            if not _is_inbound_after_auto_reply_enabled(msg, enabled_at):
                skip_reasons["before_enabled_at"] += 1
                continue

            blob = f"{subject}\n{preview}"
            if not looks_like_auto_reply_target(blob, from_email=from_email):
                skip_reasons["promotional_or_noise"] += 1
                continue

            key = _message_key("email", folder, uid, from_email, subject)
            if _already_sent(db, user.id, key):
                skip_reasons["already_sent"] += 1
                continue

            entry = (folder, {**msg, "_ai_key": key})
            if looks_like_query(blob, query_keywords, from_email=from_email):
                query_candidates.append(entry)
            else:
                other_candidates.append(entry)

    query_candidates.sort(
        key=lambda item: date_sort_key(item[1].get("date")),
        reverse=True,
    )
    other_candidates.sort(
        key=lambda item: date_sort_key(item[1].get("date")),
        reverse=True,
    )
    scanned = (
        sum(skip_reasons.values()) + len(query_candidates) + len(other_candidates)
    )

    settings.last_email_processed_at = _utcnow()
    db.commit()

    replied = 0
    reply_notes: list[str] = []
    # Prefer New Lead queries — brief AI answers for each (capped per tick).
    for folder, msg in query_candidates[:_MAX_QUERY_AUTO_REPLIES_PER_RUN]:
        outcome = _send_one_email_auto_reply(
            db, user, settings, folder=folder, msg=msg, is_query=True
        )
        if outcome.get("status") == "sent":
            replied += 1
            reply_notes.append(
                f"query→{outcome.get('recipient')} ({outcome.get('reply_source')})"
            )
        elif outcome.get("status") not in {"skipped", "already_claimed"}:
            detail = outcome.get("detail")
            if detail:
                errors.append(f"{outcome.get('recipient')}: {detail}")

    # One static template reply for non-inquiry mail (after-hours courtesy).
    if other_candidates:
        folder, msg = other_candidates[0]
        outcome = _send_one_email_auto_reply(
            db, user, settings, folder=folder, msg=msg, is_query=False
        )
        if outcome.get("status") == "sent":
            replied += 1
            reply_notes.append(f"template→{outcome.get('recipient')}")
        elif outcome.get("status") not in {"skipped", "already_claimed"}:
            detail = outcome.get("detail")
            if detail:
                errors.append(f"{outcome.get('recipient')}: {detail}")

    remaining = max(
        0,
        len(query_candidates)
        - min(len(query_candidates), _MAX_QUERY_AUTO_REPLIES_PER_RUN)
        + max(0, len(other_candidates) - 1),
    )

    if replied == 0 and not query_candidates and not other_candidates:
        message = (
            "No matching unread emails for auto-reply. "
            f"Skipped: {skip_reasons}."
        )
    elif replied == 0:
        message = (
            "Eligible emails found but none were sent this run "
            f"(claims/errors). Remaining candidates≈{remaining}."
        )
    else:
        message = (
            f"Auto-replied to {replied} message(s): " + "; ".join(reply_notes[:8])
        )

    return {
        "processed": scanned,
        "replied": replied,
        "skipped": max(0, scanned - replied),
        "enabled": True,
        "mode": "queries_ai_plus_one_template",
        "message": message,
        "skip_reasons": skip_reasons,
        "remaining_candidates": remaining,
        "query_candidates": len(query_candidates),
        "errors": errors[:8],
        "queries": query_scan,
    }


def process_all_enabled_email_users(db: Session | None = None) -> dict[str, Any]:
    # Keep New Lead (Queries) fresh for every mailbox user, not only AI Mode ON.
    # Prefer per-user sessions (db=None) so IMAP does not pin one connection.
    query_totals = scan_queries_for_all_mailbox_users(db)

    totals = {
        "users": 0,
        "processed": 0,
        "replied": 0,
        "skipped": 0,
        "queries": query_totals,
    }

    if db is not None:
        rows = (
            db.query(AiModeSettings, AppUser)
            .join(AppUser, AppUser.id == AiModeSettings.user_id)
            .filter(
                AiModeSettings.enabled.is_(True),
                AiModeSettings.email_auto_reply_enabled.is_(True),
                AppUser.is_active.is_(True),
                AppUser.role == AppUserRole.admin,
            )
            .all()
        )
        for _settings, user in rows:
            totals["users"] += 1
            result = process_email_auto_replies_for_user(
                db, user, scan_queries=False
            )
            totals["processed"] += int(result.get("processed") or 0)
            totals["replied"] += int(result.get("replied") or 0)
            totals["skipped"] += int(result.get("skipped") or 0)
        return totals

    from db.session import SessionLocal

    list_db = SessionLocal()
    try:
        admin_ids = [
            int(uid)
            for (uid,) in list_db.query(AiModeSettings.user_id)
            .join(AppUser, AppUser.id == AiModeSettings.user_id)
            .filter(
                AiModeSettings.enabled.is_(True),
                AiModeSettings.email_auto_reply_enabled.is_(True),
                AppUser.is_active.is_(True),
                AppUser.role == AppUserRole.admin,
            )
            .all()
        ]
    finally:
        list_db.close()

    for uid in admin_ids:
        session = SessionLocal()
        try:
            user = session.get(AppUser, uid)
            if not user:
                continue
            totals["users"] += 1
            result = process_email_auto_replies_for_user(
                session, user, scan_queries=False
            )
            totals["processed"] += int(result.get("processed") or 0)
            totals["replied"] += int(result.get("replied") or 0)
            totals["skipped"] += int(result.get("skipped") or 0)
        except Exception as exc:  # noqa: BLE001
            print(f"AI Mode auto-reply failed for user {uid}: {exc}", flush=True)
        finally:
            try:
                session.rollback()
            except Exception:  # noqa: BLE001
                pass
            session.close()
    return totals


def _settings_for_whatsapp_contact(db: Session, contact: Contact) -> tuple[AppUser, AiModeSettings] | None:
    buyer = db.get(Buyer, contact.buyer_id) if contact.buyer_id else None
    candidate_ids: list[int] = []
    if buyer and buyer.assigned_to_user_id:
        assignee = db.get(AppUser, buyer.assigned_to_user_id)
        if assignee and _is_admin_user(assignee):
            candidate_ids.append(buyer.assigned_to_user_id)
    # Fallback: any user with AI Mode + WhatsApp auto-reply on
    enabled_users = (
        db.query(AiModeSettings.user_id)
        .join(AppUser, AppUser.id == AiModeSettings.user_id)
        .filter(
            AiModeSettings.enabled.is_(True),
            AiModeSettings.whatsapp_auto_reply_enabled.is_(True),
            AppUser.is_active.is_(True),
            AppUser.role == AppUserRole.admin,
        )
        .all()
    )
    for (uid,) in enabled_users:
        if uid not in candidate_ids:
            candidate_ids.append(uid)

    for uid in candidate_ids:
        settings = db.get(AiModeSettings, uid)
        user = db.get(AppUser, uid)
        if (
            settings
            and user
            and settings.enabled
            and settings.whatsapp_auto_reply_enabled
            and _is_admin_user(user)
        ):
            return user, settings
    return None


def maybe_auto_reply_whatsapp(
    db: Session,
    *,
    contact: Contact,
    message_text: str,
    provider_message_id: str | None = None,
) -> dict[str, Any] | None:
    """If AI Mode is on for the assignee (or any enabled user), send WhatsApp auto-reply."""
    matched = _settings_for_whatsapp_contact(db, contact)
    if not matched:
        return None
    user, settings = matched
    if not looks_like_auto_reply_target(message_text):
        return {"status": "skipped", "reason": "promotional_or_noise"}

    is_query = looks_like_query(
        message_text,
        resolve_query_keywords(settings.query_keywords),
    )

    key = _message_key(
        "whatsapp",
        provider_message_id or "",
        contact.wa_id or contact.phone or str(contact.id),
        message_text[:200],
    )
    if _already_sent(db, user.id, key):
        return {"status": "skipped", "reason": "already_replied"}

    sender_name = (contact.full_name or "").strip()
    if not _try_claim_auto_reply(
        db,
        user_id=user.id,
        channel="whatsapp",
        message_key=key,
        recipient=contact.phone or contact.wa_id,
        subject=None,
        preview=message_text[:400],
    ):
        return {"status": "skipped", "reason": "already_replied"}

    if is_query:
        # Brief AI answer for inquiry-style WhatsApp (same model as New Lead email).
        email_draft = _compose_query_auto_reply_email_body(
            settings=settings,
            sender_name=sender_name,
            sender_email=(contact.email or "").strip(),
            subject="WhatsApp inquiry",
            inbound_body=message_text,
        )
        greeting_name = email_draft.get("greeting_name") or sender_name or "there"
        body = email_draft.get("body") or render_template(
            settings.whatsapp_body_template,
            name=greeting_name,
            form_url=settings.form_url,
        )
        reply_source = email_draft.get("source") or "template"
        reply_detail = f"kind=query_ai; source={reply_source}"
    else:
        body_result = _compose_auto_reply_whatsapp_body(
            settings=settings,
            sender_name=sender_name,
            inbound_text=message_text,
            sender_email=contact.email,
        )
        greeting_name = body_result.get("greeting_name") or sender_name or "there"
        body = body_result.get("body") or render_template(
            settings.whatsapp_body_template,
            name=greeting_name,
            form_url=settings.form_url,
        )
        reply_source = body_result.get("source") or "template"
        reply_detail = f"source={reply_source}"
    phone = contact.phone or contact.wa_id
    if not phone:
        return {"status": "error", "reason": "no_phone"}

    from integrations.whatsapp_client import whatsapp_client

    within_window = bool(
        contact.whatsapp_window_expires_at
        and contact.whatsapp_window_expires_at > _utcnow()
    )
    send_result = whatsapp_client.send_approved(
        phone=phone,
        message=body,
        within_session_window=within_window,
    )
    status = send_result.get("status") or "error"
    if status == "sent":
        db.add(
            Interaction(
                contact_id=contact.id,
                channel=Channel.whatsapp,
                direction=Direction.outbound,
                content=body,
                language=contact.preferred_language or "en",
                handled_by=HandledBy.agent,
                status=InteractionStatus.sent,
                provider_message_id=send_result.get("provider_message_id"),
            )
        )
        db.commit()

    _log_reply(
        db,
        user_id=user.id,
        channel="whatsapp",
        message_key=key,
        recipient=phone,
        subject=None,
        preview=message_text[:400],
        status=status,
        detail=f"{send_result.get('message') or ''}; {reply_detail}".strip("; "),
    )
    return {"status": status, "user_id": user.id, "send_result": send_result}


# ── Company lifecycle ─────────────────────────────────────────────────────────


def _lifecycle_to_dict(row: AiCompanyLifecycle, buyer: Buyer | None = None) -> dict[str, Any]:
    return {
        "id": row.id,
        "buyer_id": row.buyer_id,
        "company_name": buyer.company_name if buyer else None,
        "country": buyer.country if buyer else None,
        "stage": row.stage,
        "stage_label": next(
            (s["label"] for s in LIFECYCLE_STAGES if s["key"] == row.stage), row.stage
        ),
        "stage_entered_at": row.stage_entered_at.isoformat() if row.stage_entered_at else None,
        "history": row.history or [],
        "notes": row.notes,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


def ensure_lifecycle(db: Session, buyer_id: int) -> AiCompanyLifecycle:
    row = (
        db.query(AiCompanyLifecycle)
        .filter(AiCompanyLifecycle.buyer_id == buyer_id)
        .one_or_none()
    )
    if row:
        return row
    now = _utcnow()
    row = AiCompanyLifecycle(
        buyer_id=buyer_id,
        stage="new_lead",
        stage_entered_at=now,
        history=[{"stage": "new_lead", "at": now.isoformat(), "notes": None}],
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def list_lifecycle(
    db: Session,
    *,
    stage: str | None = None,
    search: str | None = None,
    limit: int = 100,
    offset: int = 0,
    assigned_to_user_id: int | None = None,
) -> dict[str, Any]:
    q = db.query(AiCompanyLifecycle, Buyer).join(Buyer, Buyer.id == AiCompanyLifecycle.buyer_id)
    q = _apply_buyer_assignee_scope(q, assigned_to_user_id)
    if stage:
        q = q.filter(AiCompanyLifecycle.stage == stage)
    if search and search.strip():
        like = f"%{search.strip()}%"
        q = q.filter(Buyer.company_name.ilike(like))
    total = q.count()
    rows = (
        q.order_by(AiCompanyLifecycle.updated_at.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    return {
        "total": total,
        "stages": LIFECYCLE_STAGES,
        "rows": [_lifecycle_to_dict(lc, buyer) for lc, buyer in rows],
    }


def update_lifecycle(
    db: Session,
    buyer_id: int,
    *,
    stage: str,
    notes: str | None = None,
    user_id: int | None = None,
) -> dict[str, Any]:
    stage_key = (stage or "").strip().lower().replace(" ", "_").replace("-", "_")
    if stage_key not in LIFECYCLE_STAGE_KEYS:
        raise ValueError(f"Invalid stage. Use one of: {', '.join(sorted(LIFECYCLE_STAGE_KEYS))}")

    buyer = db.get(Buyer, buyer_id)
    if not buyer:
        raise ValueError("Buyer not found")

    row = ensure_lifecycle(db, buyer_id)
    now = _utcnow()
    history = list(row.history or [])
    if row.stage != stage_key:
        history.append(
            {
                "stage": stage_key,
                "at": now.isoformat(),
                "notes": (notes or "").strip() or None,
                "by_user_id": user_id,
            }
        )
        _clear_meeting_schedule(row)
        row.stage = stage_key
        row.stage_entered_at = now
        row.history = history
    if notes is not None:
        row.notes = notes.strip() or None
    row.updated_by_user_id = user_id
    row.updated_at = now
    db.commit()
    db.refresh(row)
    return _lifecycle_to_dict(row, buyer)


def lifecycle_stage_counts(
    db: Session,
    *,
    assigned_to_user_id: int | None = None,
) -> dict[str, int]:
    """Fast GROUP BY counts for AiCompanyLifecycle stages only (no activity feeds)."""
    from sqlalchemy import func

    stage_q = (
        db.query(AiCompanyLifecycle.stage, func.count(AiCompanyLifecycle.id))
        .join(Buyer, Buyer.id == AiCompanyLifecycle.buyer_id)
    )
    stage_q = _apply_buyer_assignee_scope(stage_q, assigned_to_user_id)
    rows = stage_q.group_by(AiCompanyLifecycle.stage).all()
    counts = {s["key"]: 0 for s in LIFECYCLE_STAGES}
    for stage, count in rows:
        if stage in counts:
            counts[stage] = int(count)
    return counts


def lifecycle_pipeline_counts(
    db: Session,
    *,
    assigned_to_user_id: int | None = None,
    viewer: AppUser | None = None,
) -> dict[str, int]:
    from sqlalchemy import func

    counts = lifecycle_stage_counts(db, assigned_to_user_id=assigned_to_user_id)
    transfers = list_lead_transfers(
        db, limit=1, assigned_to_user_id=assigned_to_user_id
    )
    counts["assigned"] = int(transfers.get("total_leads") or 0)
    calls = list_call_activities(db, limit=1, viewer=viewer)
    counts["calling"] = int(calls.get("total_calls") or 0)
    follow_ups = list_follow_up_activities(db, limit=1, viewer=viewer)
    counts["follow_up"] = int(follow_ups.get("total_events") or 0)
    counts["interested"] = _interested_clients_list_count(
        db, assigned_to_user_id=assigned_to_user_id
    )
    counts["not_interested"] = _not_interested_clients_count(
        db, assigned_to_user_id=assigned_to_user_id
    )
    potential = list_potential_clients(
        db, limit=1, assigned_to_user_id=assigned_to_user_id
    )
    counts["potential_clients"] = int(potential.get("total") or 0)
    return counts


_POTENTIAL_GRADES = frozenset({"AAAA", "AAA", "AA"})
_POTENTIAL_GRADE_ALIASES = {
    "HOT": "AAA",
    "WARM": "AA",
    "AAAA": "AAAA",
    "AAA": "AAA",
    "AA": "AA",
}


def _normalize_potential_grade(raw: str | None) -> str | None:
    key = (raw or "").strip().upper()
    mapped = _POTENTIAL_GRADE_ALIASES.get(key)
    return mapped if mapped in _POTENTIAL_GRADES else None


def list_potential_clients(
    db: Session,
    *,
    search: str | None = None,
    limit: int = 100,
    offset: int = 0,
    assigned_to_user_id: int | None = None,
) -> dict[str, Any]:
    """Scrapped Leads (not Old clients) with company grading AND AI grade AA/AAA/AAAA."""
    from sqlalchemy import func, or_
    from db.models import LeadScore, LeadScoreLabel

    ranked = (
        db.query(
            LeadScore.buyer_id.label("buyer_id"),
            LeadScore.score.label("score"),
            LeadScore.reasoning.label("reasoning"),
            LeadScore.scored_at.label("scored_at"),
            func.row_number()
            .over(
                partition_by=LeadScore.buyer_id,
                order_by=LeadScore.scored_at.desc(),
            )
            .label("rn"),
        ).subquery()
    )
    latest = (
        db.query(
            ranked.c.buyer_id,
            ranked.c.score,
            ranked.c.reasoning,
            ranked.c.scored_at,
        )
        .filter(ranked.c.rn == 1)
        .subquery()
    )

    company_grade = func.upper(func.trim(func.coalesce(Buyer.company_grading, "")))
    q = (
        db.query(Buyer, latest.c.score, latest.c.reasoning, latest.c.scored_at)
        .join(latest, Buyer.id == latest.c.buyer_id)
        .filter(
            # Scrapped / Discover pool — never Old clients.
            ~func.lower(func.coalesce(Buyer.source, "")).in_(["old_clients"]),
            latest.c.score.in_([LeadScoreLabel.AAAA, LeadScoreLabel.AAA, LeadScoreLabel.AA]),
            or_(
                company_grade.in_(["AAAA", "AAA", "AA"]),
                company_grade.in_(["HOT", "WARM"]),  # legacy Excel labels
            ),
        )
    )
    q = _apply_buyer_assignee_scope(q, assigned_to_user_id)
    if search and search.strip():
        like = f"%{search.strip()}%"
        q = q.filter(
            or_(
                Buyer.company_name.ilike(like),
                Buyer.country.ilike(like),
            )
        )

    total = q.count()
    rows = (
        q.order_by(Buyer.company_name.asc(), Buyer.id.asc())
        .offset(offset)
        .limit(limit)
        .all()
    )

    out_rows: list[dict[str, Any]] = []
    for buyer, ai_score, reasoning, scored_at in rows:
        company_g = _normalize_potential_grade(buyer.company_grading) or (
            (buyer.company_grading or "").strip().upper() or None
        )
        ai_g = ai_score.value if hasattr(ai_score, "value") else str(ai_score)
        out_rows.append(
            {
                "buyer_id": buyer.id,
                "company_name": buyer.company_name,
                "country": buyer.country,
                "source": buyer.source,
                "company_grading": buyer.company_grading,
                "company_grade": company_g,
                "ai_grade": ai_g,
                "score_reasoning": (reasoning or "")[:500] or None,
                "scored_at": scored_at.isoformat() if scored_at else None,
                "assigned_to": buyer.assigned_to,
                "assigned_to_user_id": buyer.assigned_to_user_id,
            }
        )

    return {"total": int(total), "rows": out_rows}


# Back-compat alias (older callers / API path).
list_interested_scrapped_leads = list_potential_clients


def _mark_buyers_assigned_stage(
    db: Session,
    buyer_ids: list[int],
    *,
    user_id: int | None,
    note: str | None = None,
) -> None:
    """Move transferred buyers into lifecycle stage `assigned` (no extra commit)."""
    now = _utcnow()
    for buyer_id in buyer_ids:
        row = (
            db.query(AiCompanyLifecycle)
            .filter(AiCompanyLifecycle.buyer_id == buyer_id)
            .one_or_none()
        )
        if not row:
            row = AiCompanyLifecycle(
                buyer_id=buyer_id,
                stage="assigned",
                stage_entered_at=now,
                history=[
                    {
                        "stage": "assigned",
                        "at": now.isoformat(),
                        "notes": note,
                        "by_user_id": user_id,
                    }
                ],
                updated_by_user_id=user_id,
            )
            db.add(row)
            continue
        if row.stage == "assigned":
            continue
        history = list(row.history or [])
        history.append(
            {
                "stage": "assigned",
                "at": now.isoformat(),
                "notes": note,
                "by_user_id": user_id,
            }
        )
        row.stage = "assigned"
        row.stage_entered_at = now
        row.history = history
        row.updated_by_user_id = user_id
        row.updated_at = now


def record_lead_transfer(
    db: Session,
    *,
    buyer_ids: list[int],
    to_user_id: int,
    to_label: str,
    by_user_id: int | None = None,
    commit: bool = True,
) -> dict[str, Any] | None:
    """Log admin → sales-user lead transfers for the Assigned tab (max 20 clients per row)."""
    ids = sorted({int(b) for b in buyer_ids if b is not None})
    if not ids or to_user_id is None:
        return None

    label = (to_label or "").strip() or f"user #{to_user_id}"
    name_by_id: dict[int, str] = {
        int(row.id): (row.company_name or f"Lead #{row.id}")
        for row in db.query(Buyer.id, Buyer.company_name).filter(Buyer.id.in_(ids)).all()
    }
    ordered_ids = [bid for bid in ids if bid in name_by_id]

    _mark_buyers_assigned_stage(
        db,
        ordered_ids,
        user_id=by_user_id,
        note=f"{len(ordered_ids)} clients sent to {label}",
    )

    events: list[dict[str, Any]] = []
    created_rows: list[AiLeadTransferLog] = []
    for offset in range(0, len(ordered_ids), LEAD_TRANSFER_BATCH_SIZE):
        batch_ids = ordered_ids[offset : offset + LEAD_TRANSFER_BATCH_SIZE]
        batch_names = [name_by_id[bid] for bid in batch_ids]
        count = len(batch_ids)
        noun = "client" if count == 1 else "clients"
        message = f"{count} {noun} sent to {label}"
        row = AiLeadTransferLog(
            by_user_id=by_user_id,
            to_user_id=to_user_id,
            to_label=label,
            lead_count=count,
            buyer_ids=batch_ids,
            message=message,
        )
        db.add(row)
        created_rows.append(row)
        events.append(
            {
                "to_user_id": to_user_id,
                "to_label": label,
                "lead_count": count,
                "buyer_ids": batch_ids,
                "company_names": batch_names,
                "message": message,
            }
        )

    if commit:
        db.commit()
        for row in created_rows:
            db.refresh(row)

    total = len(ordered_ids)
    batch_count = len(events)
    summary = (
        f"{total} client sent to {label}"
        if total == 1
        else f"{total} clients sent to {label}"
    )
    if batch_count > 1:
        summary = f"{summary} ({batch_count} batches)"

    first = created_rows[0] if created_rows else None
    return {
        "id": first.id if first and commit else None,
        "by_user_id": by_user_id,
        "to_user_id": to_user_id,
        "to_label": label,
        "lead_count": total,
        "batch_count": batch_count,
        "events": events,
        "message": summary,
        "created_at": first.created_at.isoformat() if first and commit and first.created_at else None,
    }


def list_lead_transfers(
    db: Session,
    *,
    limit: int = 100,
    assigned_to_user_id: int | None = None,
) -> dict[str, Any]:
    from sqlalchemy import func

    transfer_q = db.query(AiLeadTransferLog)
    if assigned_to_user_id is not None:
        transfer_q = transfer_q.filter(
            AiLeadTransferLog.to_user_id == assigned_to_user_id
        )
    total_leads = (
        db.query(func.coalesce(func.sum(AiLeadTransferLog.lead_count), 0))
        .filter(
            *(
                [AiLeadTransferLog.to_user_id == assigned_to_user_id]
                if assigned_to_user_id is not None
                else []
            )
        )
        .scalar()
        or 0
    )
    total_events = transfer_q.with_entities(func.count(AiLeadTransferLog.id)).scalar() or 0
    rows = (
        transfer_q.order_by(AiLeadTransferLog.created_at.desc(), AiLeadTransferLog.id.desc())
        .limit(limit)
        .all()
    )
    all_ids: set[int] = set()
    for row in rows:
        for bid in row.buyer_ids or []:
            try:
                all_ids.add(int(bid))
            except (TypeError, ValueError):
                continue
    name_by_id: dict[int, str] = {}
    if all_ids:
        for bid, name in db.query(Buyer.id, Buyer.company_name).filter(Buyer.id.in_(all_ids)):
            name_by_id[int(bid)] = name or f"Lead #{bid}"

    def names_for(buyer_ids: list | None) -> list[str]:
        out: list[str] = []
        for raw in buyer_ids or []:
            try:
                bid = int(raw)
            except (TypeError, ValueError):
                continue
            out.append(name_by_id.get(bid, f"Lead #{bid}"))
        return out

    return {
        "total_leads": int(total_leads),
        "total_events": int(total_events),
        "rows": [
            {
                "id": r.id,
                "by_user_id": r.by_user_id,
                "to_user_id": r.to_user_id,
                "to_label": r.to_label,
                "lead_count": r.lead_count,
                "buyer_ids": r.buyer_ids or [],
                "company_names": names_for(r.buyer_ids),
                "message": r.message,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in rows
        ],
    }


def _caller_label(user: AppUser | None, fallback: str | None = None) -> str:
    if user is not None:
        name = (user.username or "").strip() or (user.full_name or "").strip()
        if name:
            return name
    return (fallback or "").strip() or "Someone"


def _mark_buyer_calling_stage(
    db: Session,
    buyer_id: int | None,
    *,
    user_id: int | None,
    note: str | None = None,
) -> None:
    """Advance early-stage buyers to `calling` when a call is placed (no extra commit)."""
    if not buyer_id:
        return
    now = _utcnow()
    early = {"new_lead", "assigned"}
    row = (
        db.query(AiCompanyLifecycle)
        .filter(AiCompanyLifecycle.buyer_id == buyer_id)
        .one_or_none()
    )
    if not row:
        row = AiCompanyLifecycle(
            buyer_id=buyer_id,
            stage="calling",
            stage_entered_at=now,
            history=[
                {
                    "stage": "calling",
                    "at": now.isoformat(),
                    "notes": note,
                    "by_user_id": user_id,
                }
            ],
            updated_by_user_id=user_id,
        )
        db.add(row)
        return
    if row.stage not in early:
        return
    history = list(row.history or [])
    history.append(
        {
            "stage": "calling",
            "at": now.isoformat(),
            "notes": note,
            "by_user_id": user_id,
        }
    )
    row.stage = "calling"
    row.stage_entered_at = now
    row.history = history
    row.updated_by_user_id = user_id
    row.updated_at = now


_LEAD_ID_PLACEHOLDER_RE = re.compile(r"^lead\s*#\s*\d+$", re.I)
_WEAK_CALL_COMPANY_NAMES = frozenset(
    {"", "a company", "unknown", "manual dial", "unknown client", "contact"}
)
_GENERIC_EMAIL_DOMAINS = frozenset(
    {
        "gmail.com",
        "googlemail.com",
        "yahoo.com",
        "hotmail.com",
        "outlook.com",
        "live.com",
        "icloud.com",
        "aol.com",
        "mail.com",
        "protonmail.com",
        "yandex.com",
    }
)
_GENERIC_WEBSITE_HOSTS = frozenset(
    {
        "facebook.com",
        "instagram.com",
        "linkedin.com",
        "twitter.com",
        "x.com",
        "youtube.com",
        "tiktok.com",
        "whatsapp.com",
    }
)


def _norm_label_key(text: str | None) -> str:
    return re.sub(r"\s+", " ", (text or "").strip().lower())


def _looks_like_location_label(name: str | None, *, buyer: Buyer | None = None) -> bool:
    """True when ``name`` is a country/city/address — not a company."""
    n = (name or "").strip()
    if not n:
        return True
    from modules.buyer_name_repair import classify_location_name

    if classify_location_name(n) is not None:
        return True
    if buyer:
        country = (buyer.country or "").strip()
        if country and _norm_label_key(n) == _norm_label_key(country):
            return True
        city = (buyer.city or "").strip()
        if city and _norm_label_key(n) == _norm_label_key(city):
            return True
    return False


def _brand_from_host(host: str | None) -> str | None:
    h = (host or "").strip().lower()
    if h.startswith("www."):
        h = h[4:]
    if not h or h in _GENERIC_WEBSITE_HOSTS:
        return None
    stem = h.split(".")[0]
    if len(stem) < 3:
        return None
    label = stem.replace("-", " ").replace("_", " ").strip()
    if not label or _is_weak_call_company_name(label):
        return None
    return label.title() if label.islower() else label


def _display_name_from_website(url: str | None) -> str | None:
    raw = (url or "").strip()
    if not raw:
        return None
    try:
        from urllib.parse import urlparse

        if not raw.startswith(("http://", "https://")):
            raw = f"https://{raw}"
        return _brand_from_host(urlparse(raw).hostname)
    except Exception:  # noqa: BLE001
        return None


def _display_name_from_contact_email(email: str | None) -> str | None:
    addr = (email or "").strip().lower()
    if "@" not in addr:
        return None
    domain = addr.split("@", 1)[1].strip()
    if not domain or domain in _GENERIC_EMAIL_DOMAINS:
        return None
    return _brand_from_host(domain)


def _is_weak_call_company_name(name: str | None) -> bool:
    n = (name or "").strip()
    if not n:
        return True
    if n.lower() in _WEAK_CALL_COMPANY_NAMES:
        return True
    if _LEAD_ID_PLACEHOLDER_RE.match(n):
        return True
    return False


def _buyer_call_display_name(db: Session, buyer: Buyer) -> str | None:
    """Prefer real company name — never show country/city stored in company_name."""
    company = (buyer.company_name or "").strip()
    if (
        company
        and not _is_weak_call_company_name(company)
        and not _looks_like_location_label(company, buyer=buyer)
    ):
        return company

    website_name = _display_name_from_website(buyer.website_url)
    if website_name and not _looks_like_location_label(website_name, buyer=buyer):
        return website_name

    contacts = (
        db.query(Contact)
        .filter(Contact.buyer_id == buyer.id)
        .order_by(Contact.id.asc())
        .all()
    )
    for contact in contacts:
        email_name = _display_name_from_contact_email(contact.email)
        if email_name and not _looks_like_location_label(email_name, buyer=buyer):
            return email_name

    for contact in contacts:
        person = (contact.full_name or "").strip()
        if (
            person
            and not _is_weak_call_company_name(person)
            and not _looks_like_location_label(person, buyer=buyer)
        ):
            return person

    return None


def _resolve_call_company_name(
    db: Session,
    *,
    company_name: str | None,
    buyer_id: int | None,
    interaction_id: int | None = None,
) -> str:
    buyer: Buyer | None = db.get(Buyer, buyer_id) if buyer_id else None

    if buyer:
        resolved = _buyer_call_display_name(db, buyer)
        if resolved:
            return resolved

    if interaction_id:
        interaction = db.get(Interaction, interaction_id)
        if interaction:
            subject = (interaction.subject or "").strip()
            if subject.lower().startswith("call to "):
                parsed = subject[8:].strip()
                if (
                    parsed
                    and not _is_weak_call_company_name(parsed)
                    and not _looks_like_location_label(parsed, buyer=buyer)
                ):
                    return parsed

            contact = db.get(Contact, interaction.contact_id)
            if contact:
                linked_buyer_id = contact.buyer_id
                if linked_buyer_id and (not buyer or linked_buyer_id != buyer.id):
                    linked = db.get(Buyer, linked_buyer_id)
                    if linked:
                        resolved = _buyer_call_display_name(db, linked)
                        if resolved:
                            return resolved
                person = (contact.full_name or "").strip()
                if (
                    person
                    and not _is_weak_call_company_name(person)
                    and not _looks_like_location_label(person, buyer=buyer)
                ):
                    return person

    name = (company_name or "").strip()
    if (
        name
        and not _is_weak_call_company_name(name)
        and not _looks_like_location_label(name, buyer=buyer)
    ):
        return name
    return "Unknown client"


def _call_activity_message(user_label: str, company_name: str) -> str:
    return f"{user_label} called {company_name}"


def record_call_activity(
    db: Session,
    *,
    user_id: int,
    company_name: str,
    buyer_id: int | None = None,
    interaction_id: int | None = None,
    user_label: str | None = None,
    commit: bool = True,
) -> dict[str, Any]:
    """Log a call statement for Company lifecycle → Calling."""
    user = db.get(AppUser, user_id)
    label = _caller_label(user, user_label)
    company = _resolve_call_company_name(
        db,
        company_name=company_name,
        buyer_id=buyer_id,
        interaction_id=interaction_id,
    )
    message = _call_activity_message(label, company)

    row = AiCallActivityLog(
        user_id=user_id,
        user_label=label,
        buyer_id=buyer_id,
        company_name=company[:255],
        interaction_id=interaction_id,
        message=message[:500],
    )
    db.add(row)
    _mark_buyer_calling_stage(
        db,
        buyer_id,
        user_id=user_id,
        note=message,
    )
    if commit:
        db.commit()
        db.refresh(row)
    return {
        "id": row.id if commit else None,
        "user_id": user_id,
        "user_label": label,
        "buyer_id": buyer_id,
        "company_name": company,
        "interaction_id": interaction_id,
        "message": message,
        "created_at": row.created_at.isoformat() if commit and row.created_at else None,
    }


def list_call_activities(
    db: Session,
    *,
    limit: int = 100,
    viewer: AppUser | None = None,
) -> dict[str, Any]:
    from sqlalchemy import func

    q = db.query(AiCallActivityLog)
    if viewer is not None and not _is_admin_user(viewer):
        q = q.filter(AiCallActivityLog.user_id == viewer.id)
    total_calls = q.with_entities(func.count(AiCallActivityLog.id)).scalar() or 0
    rows = (
        q.order_by(AiCallActivityLog.created_at.desc(), AiCallActivityLog.id.desc())
        .limit(limit)
        .all()
    )
    out_rows: list[dict[str, Any]] = []
    for r in rows:
        company = _resolve_call_company_name(
            db,
            company_name=r.company_name,
            buyer_id=r.buyer_id,
            interaction_id=r.interaction_id,
        )
        label = (r.user_label or "").strip() or "Someone"
        out_rows.append(
            {
                "id": r.id,
                "user_id": r.user_id,
                "user_label": label,
                "buyer_id": r.buyer_id,
                "company_name": company,
                "interaction_id": r.interaction_id,
                "message": _call_activity_message(label, company),
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
        )
    return {
        "total_calls": int(total_calls),
        "rows": out_rows,
    }


def _mark_buyer_follow_up_stage(
    db: Session,
    buyer_id: int | None,
    *,
    user_id: int | None,
    note: str | None = None,
) -> None:
    """Advance early stages to `follow_up` when a next-call follow-up is placed."""
    if not buyer_id:
        return
    now = _utcnow()
    advance_from = {"new_lead", "assigned", "calling", "potential_clients"}
    row = (
        db.query(AiCompanyLifecycle)
        .filter(AiCompanyLifecycle.buyer_id == buyer_id)
        .one_or_none()
    )
    if not row:
        row = AiCompanyLifecycle(
            buyer_id=buyer_id,
            stage="follow_up",
            stage_entered_at=now,
            history=[
                {
                    "stage": "follow_up",
                    "at": now.isoformat(),
                    "notes": note,
                    "by_user_id": user_id,
                }
            ],
            updated_by_user_id=user_id,
        )
        db.add(row)
        return
    if row.stage not in advance_from:
        return
    history = list(row.history or [])
    history.append(
        {
            "stage": "follow_up",
            "at": now.isoformat(),
            "notes": note,
            "by_user_id": user_id,
        }
    )
    row.stage = "follow_up"
    row.stage_entered_at = now
    row.history = history
    row.updated_by_user_id = user_id
    row.updated_at = now


def mark_buyer_interested_stage(
    db: Session,
    buyer_id: int | None,
    *,
    user_id: int | None,
    note: str | None = None,
    commit: bool = False,
) -> None:
    """Advance lifecycle to `interested` when call outcome is Client is Interested."""
    if not buyer_id:
        return
    now = _utcnow()
    advance_from = {
        "new_lead",
        "assigned",
        "calling",
        "follow_up",
        "potential_clients",
    }
    row = (
        db.query(AiCompanyLifecycle)
        .filter(AiCompanyLifecycle.buyer_id == buyer_id)
        .one_or_none()
    )
    if not row:
        row = AiCompanyLifecycle(
            buyer_id=buyer_id,
            stage="interested",
            stage_entered_at=now,
            history=[
                {
                    "stage": "interested",
                    "at": now.isoformat(),
                    "notes": note,
                    "by_user_id": user_id,
                }
            ],
            updated_by_user_id=user_id,
        )
        db.add(row)
        if commit:
            db.commit()
        return
    if row.stage == "interested":
        return
    if row.stage not in advance_from:
        return
    history = list(row.history or [])
    history.append(
        {
            "stage": "interested",
            "at": now.isoformat(),
            "notes": note,
            "by_user_id": user_id,
        }
    )
    row.stage = "interested"
    row.stage_entered_at = now
    row.history = history
    row.updated_by_user_id = user_id
    row.updated_at = now
    if commit:
        db.commit()


def mark_buyer_not_interested_stage(
    db: Session,
    buyer_id: int | None,
    *,
    user_id: int | None,
    note: str | None = None,
    commit: bool = False,
) -> None:
    """Advance lifecycle to `not_interested` when call outcome is Not interested."""
    if not buyer_id:
        return
    now = _utcnow()
    advance_from = {
        "new_lead",
        "assigned",
        "calling",
        "follow_up",
        "potential_clients",
        "interested",
    }
    row = (
        db.query(AiCompanyLifecycle)
        .filter(AiCompanyLifecycle.buyer_id == buyer_id)
        .one_or_none()
    )
    if not row:
        row = AiCompanyLifecycle(
            buyer_id=buyer_id,
            stage="not_interested",
            stage_entered_at=now,
            history=[
                {
                    "stage": "not_interested",
                    "at": now.isoformat(),
                    "notes": note,
                    "by_user_id": user_id,
                }
            ],
            updated_by_user_id=user_id,
        )
        db.add(row)
        if commit:
            db.commit()
        return
    if row.stage == "not_interested":
        return
    if row.stage not in advance_from:
        return
    history = list(row.history or [])
    history.append(
        {
            "stage": "not_interested",
            "at": now.isoformat(),
            "notes": note,
            "by_user_id": user_id,
        }
    )
    row.stage = "not_interested"
    row.stage_entered_at = now
    row.history = history
    row.updated_by_user_id = user_id
    row.updated_at = now
    if commit:
        db.commit()


def record_follow_up_activity(
    db: Session,
    *,
    user_id: int,
    company_name: str,
    buyer_id: int | None = None,
    event_type: str = "placed",
    follow_up_at: datetime | None = None,
    user_label: str | None = None,
    commit: bool = True,
) -> dict[str, Any]:
    """Log Follow up clients activity for Company lifecycle → Follow-up.

    Works for admin and sales users the same way.
    """
    user = db.get(AppUser, user_id)
    label = _caller_label(user, user_label)
    company = (company_name or "").strip() or "a company"
    kind = (event_type or "placed").strip().lower() or "placed"

    if kind == "scheduled" and follow_up_at is not None:
        when = follow_up_at.astimezone(timezone.utc).strftime("%Y-%m-%d")
        message = f"{label} scheduled a follow-up for {company} on {when}"
    elif kind == "scheduled":
        message = f"{label} scheduled a follow-up for {company}"
    else:
        kind = "placed"
        message = f"{label} put {company} in Follow up clients"

    row = AiFollowUpActivityLog(
        user_id=user_id,
        user_label=label,
        buyer_id=buyer_id,
        company_name=company[:255],
        event_type=kind,
        follow_up_at=follow_up_at,
        message=message[:500],
    )
    db.add(row)
    if kind == "placed":
        _mark_buyer_follow_up_stage(
            db,
            buyer_id,
            user_id=user_id,
            note=message,
        )
    if commit:
        db.commit()
        db.refresh(row)
    return {
        "id": row.id if commit else None,
        "user_id": user_id,
        "user_label": label,
        "buyer_id": buyer_id,
        "company_name": company,
        "event_type": kind,
        "follow_up_at": follow_up_at.isoformat() if follow_up_at else None,
        "message": message,
        "created_at": row.created_at.isoformat() if commit and row.created_at else None,
    }


def list_follow_up_activities(
    db: Session,
    *,
    limit: int = 100,
    viewer: AppUser | None = None,
) -> dict[str, Any]:
    from sqlalchemy import func

    q = db.query(AiFollowUpActivityLog)
    if viewer is not None and not _is_admin_user(viewer):
        q = q.filter(AiFollowUpActivityLog.user_id == viewer.id)
    total_events = q.with_entities(func.count(AiFollowUpActivityLog.id)).scalar() or 0
    rows = (
        q.order_by(
            AiFollowUpActivityLog.created_at.desc(),
            AiFollowUpActivityLog.id.desc(),
        )
        .limit(limit)
        .all()
    )
    return {
        "total_events": int(total_events),
        "rows": [
            {
                "id": r.id,
                "user_id": r.user_id,
                "user_label": r.user_label,
                "buyer_id": r.buyer_id,
                "company_name": r.company_name,
                "event_type": r.event_type,
                "follow_up_at": r.follow_up_at.isoformat() if r.follow_up_at else None,
                "message": r.message,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in rows
        ],
    }


def _interested_clients_list_count(
    db: Session,
    *,
    assigned_to_user_id: int | None = None,
) -> int:
    from sqlalchemy import func

    q = db.query(func.count(Buyer.id)).filter(Buyer.interested_clients_list_at.isnot(None))
    q = _apply_buyer_assignee_scope(q, assigned_to_user_id)
    return int(q.scalar() or 0)


def list_interested_clients_for_lifecycle(
    db: Session,
    *,
    search: str | None = None,
    limit: int = 100,
    offset: int = 0,
    assigned_to_user_id: int | None = None,
) -> dict[str, Any]:
    """Interested Clients table rows awaiting quotation (default: not sent)."""
    from sqlalchemy import or_

    q = (
        db.query(Buyer, AiCompanyLifecycle)
        .outerjoin(AiCompanyLifecycle, AiCompanyLifecycle.buyer_id == Buyer.id)
        .filter(Buyer.interested_clients_list_at.isnot(None))
        .filter(
            or_(
                AiCompanyLifecycle.id.is_(None),
                ~AiCompanyLifecycle.stage.in_(_POST_QUOTATION_LIFECYCLE_STAGES),
            )
        )
    )
    q = _apply_buyer_assignee_scope(q, assigned_to_user_id)
    if search and search.strip():
        like = f"%{search.strip()}%"
        q = q.filter(
            or_(
                Buyer.company_name.ilike(like),
                Buyer.country.ilike(like),
            )
        )

    total = q.count()
    rows = (
        q.order_by(Buyer.interested_clients_list_at.desc(), Buyer.id.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    out_rows: list[dict[str, Any]] = []
    for buyer, lifecycle in rows:
        out_rows.append(
            {
                "buyer_id": buyer.id,
                "company_name": buyer.company_name,
                "country": buyer.country,
                "interested_at": buyer.interested_clients_list_at.isoformat()
                if buyer.interested_clients_list_at
                else None,
                "lifecycle_stage": lifecycle.stage if lifecycle else "interested",
                "quotation_status": "not_sent",
            }
        )
    return {"total": total, "rows": out_rows}


def mark_buyer_quotation_sent(
    db: Session,
    buyer_id: int,
    *,
    user_id: int | None = None,
    note: str | None = None,
) -> dict[str, Any]:
    """Move an interested client to Quotation Sent after quotation is sent."""
    buyer = db.get(Buyer, buyer_id)
    if not buyer:
        raise ValueError("Buyer not found")
    if buyer.interested_clients_list_at is None:
        raise ValueError("Lead is not on the Interested Clients list")

    return update_lifecycle(
        db,
        buyer_id,
        stage="quotation_sent",
        notes=(note or "").strip() or "Quotation sent",
        user_id=user_id,
    )


def _list_lifecycle_stage_clients(
    db: Session,
    *,
    stage: str,
    search: str | None = None,
    limit: int = 100,
    offset: int = 0,
    assigned_to_user_id: int | None = None,
) -> dict[str, Any]:
    """Buyers currently at a lifecycle stage (for pipeline action tabs)."""
    from sqlalchemy import or_

    q = (
        db.query(Buyer, AiCompanyLifecycle)
        .join(AiCompanyLifecycle, AiCompanyLifecycle.buyer_id == Buyer.id)
        .filter(AiCompanyLifecycle.stage == stage)
    )
    q = _apply_buyer_assignee_scope(q, assigned_to_user_id)
    if search and search.strip():
        like = f"%{search.strip()}%"
        q = q.filter(
            or_(
                Buyer.company_name.ilike(like),
                Buyer.country.ilike(like),
            )
        )

    total = q.count()
    rows = (
        q.order_by(AiCompanyLifecycle.stage_entered_at.desc(), Buyer.id.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    out_rows: list[dict[str, Any]] = []
    for buyer, lifecycle in rows:
        out_rows.append(
            {
                "buyer_id": buyer.id,
                "company_name": buyer.company_name,
                "country": buyer.country,
                "stage_entered_at": lifecycle.stage_entered_at.isoformat()
                if lifecycle.stage_entered_at
                else None,
                "lifecycle_stage": lifecycle.stage,
            }
        )
    return {"total": total, "rows": out_rows}


def list_quotation_sent_clients_for_lifecycle(
    db: Session,
    *,
    search: str | None = None,
    limit: int = 100,
    offset: int = 0,
    assigned_to_user_id: int | None = None,
) -> dict[str, Any]:
    """Quotation Sent tab — meeting schedule per lifecycle row."""
    from sqlalchemy import or_

    q = (
        db.query(Buyer, AiCompanyLifecycle)
        .join(AiCompanyLifecycle, AiCompanyLifecycle.buyer_id == Buyer.id)
        .filter(AiCompanyLifecycle.stage == "quotation_sent")
    )
    q = _apply_buyer_assignee_scope(q, assigned_to_user_id)
    if search and search.strip():
        like = f"%{search.strip()}%"
        q = q.filter(
            or_(
                Buyer.company_name.ilike(like),
                Buyer.country.ilike(like),
            )
        )

    total = q.count()
    rows = (
        q.order_by(AiCompanyLifecycle.stage_entered_at.desc(), Buyer.id.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    out_rows: list[dict[str, Any]] = []
    for buyer, lifecycle in rows:
        out_rows.append(
            {
                "buyer_id": buyer.id,
                "company_name": buyer.company_name,
                "country": buyer.country,
                "stage_entered_at": lifecycle.stage_entered_at.isoformat()
                if lifecycle.stage_entered_at
                else None,
                "lifecycle_stage": lifecycle.stage,
                "meeting_status": lifecycle.meeting_status or "not_scheduled",
                "meeting_at": lifecycle.meeting_at.isoformat()
                if lifecycle.meeting_at
                else None,
            }
        )
    return {"total": total, "rows": out_rows}


MEETING_REMINDER_MINUTES = 15


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _clear_meeting_schedule(row: AiCompanyLifecycle) -> None:
    row.meeting_status = "not_scheduled"
    row.meeting_at = None
    row.meeting_reminder_sent_at = None


def _primary_contact_name(db: Session, buyer_id: int) -> str | None:
    contact = (
        db.query(Contact)
        .filter(Contact.buyer_id == buyer_id)
        .order_by(Contact.id.asc())
        .first()
    )
    return contact.full_name if contact else None


def update_quotation_meeting_schedule(
    db: Session,
    buyer_id: int,
    *,
    meeting_status: str,
    meeting_at: datetime | None = None,
    user_id: int | None = None,
) -> dict[str, Any]:
    """Set or clear a quotation-sent meeting schedule."""
    buyer = db.get(Buyer, buyer_id)
    if not buyer:
        raise ValueError("Buyer not found")

    row = ensure_lifecycle(db, buyer_id)
    if row.stage != "quotation_sent":
        raise ValueError("Lead must be in Quotation Sent to schedule a meeting")

    status = (meeting_status or "").strip().lower()
    if status == "done":
        mark_meeting_done(db, buyer_id, user_id=user_id)
        return {
            "buyer_id": buyer.id,
            "company_name": buyer.company_name,
            "country": buyer.country,
            "meeting_status": "done",
            "meeting_at": None,
            "lifecycle_stage": "negotiation",
            "moved_to_negotiation": True,
        }

    if status not in {"not_scheduled", "scheduled"}:
        raise ValueError("meeting_status must be not_scheduled, scheduled, or done")

    now = _utcnow()
    if status == "not_scheduled":
        _clear_meeting_schedule(row)
    else:
        if not meeting_at:
            raise ValueError("meeting_at is required when meeting is scheduled")
        at = _as_utc(meeting_at)
        if at <= now:
            raise ValueError("Meeting must be scheduled in the future")
        row.meeting_status = "scheduled"
        row.meeting_at = at
        row.meeting_reminder_sent_at = None

    row.updated_by_user_id = user_id
    row.updated_at = now
    db.commit()
    db.refresh(row)
    return {
        "buyer_id": buyer.id,
        "company_name": buyer.company_name,
        "country": buyer.country,
        "meeting_status": row.meeting_status,
        "meeting_at": row.meeting_at.isoformat() if row.meeting_at else None,
    }


def process_quotation_meeting_alerts(db: Session) -> dict[str, Any]:
    """Return upcoming-meeting alerts (15 minutes before scheduled time)."""
    now = _utcnow()
    reminder_delta = timedelta(minutes=MEETING_REMINDER_MINUTES)
    alerts: list[dict[str, Any]] = []
    dirty = False

    rows = (
        db.query(AiCompanyLifecycle, Buyer)
        .join(Buyer, Buyer.id == AiCompanyLifecycle.buyer_id)
        .filter(
            AiCompanyLifecycle.stage == "quotation_sent",
            AiCompanyLifecycle.meeting_status == "scheduled",
            AiCompanyLifecycle.meeting_at.isnot(None),
        )
        .all()
    )

    for lifecycle, buyer in rows:
        meeting_at = _as_utc(lifecycle.meeting_at)
        if now >= meeting_at:
            continue

        reminder_at = meeting_at - reminder_delta
        if now >= reminder_at and lifecycle.meeting_reminder_sent_at is None:
            stamp = meeting_at.strftime("%Y%m%d%H%M")
            minutes_until = max(0, int((meeting_at - now).total_seconds() // 60))
            alerts.append(
                {
                    "id": f"{buyer.id}-{stamp}",
                    "buyer_id": buyer.id,
                    "company_name": buyer.company_name,
                    "contact_name": _primary_contact_name(db, buyer.id),
                    "meeting_at": meeting_at.isoformat(),
                    "minutes_until": minutes_until,
                }
            )
            lifecycle.meeting_reminder_sent_at = now
            dirty = True

    if dirty:
        db.commit()

    return {"alerts": alerts, "auto_moved": []}


def mark_meeting_done(
    db: Session,
    buyer_id: int,
    *,
    user_id: int | None = None,
    note: str | None = None,
) -> dict[str, Any]:
    """Move a quotation-sent client to Negotiation after meeting is done."""
    row = ensure_lifecycle(db, buyer_id)
    if row.stage != "quotation_sent":
        raise ValueError("Lead must be in Quotation Sent before marking meeting done")
    return update_lifecycle(
        db,
        buyer_id,
        stage="negotiation",
        notes=(note or "").strip() or "Meeting done",
        user_id=user_id,
    )


def list_negotiation_clients_for_lifecycle(
    db: Session,
    *,
    search: str | None = None,
    limit: int = 100,
    offset: int = 0,
    assigned_to_user_id: int | None = None,
) -> dict[str, Any]:
    """Negotiation tab — awaiting won/lost decision."""
    return _list_lifecycle_stage_clients(
        db,
        stage="negotiation",
        search=search,
        limit=limit,
        offset=offset,
        assigned_to_user_id=assigned_to_user_id,
    )


def mark_negotiation_outcome(
    db: Session,
    buyer_id: int,
    *,
    outcome: str,
    user_id: int | None = None,
    note: str | None = None,
) -> dict[str, Any]:
    """Close negotiation as Won or Lost."""
    key = (outcome or "").strip().lower()
    if key not in {"won", "lost"}:
        raise ValueError("Outcome must be won or lost")
    row = ensure_lifecycle(db, buyer_id)
    if row.stage != "negotiation":
        raise ValueError("Lead must be in Negotiation before marking won or lost")
    default_note = "Deal won" if key == "won" else "Deal lost"
    return update_lifecycle(
        db,
        buyer_id,
        stage=key,
        notes=(note or "").strip() or default_note,
        user_id=user_id,
    )


def record_interested_activity(
    db: Session,
    *,
    user_id: int,
    company_name: str,
    buyer_id: int | None = None,
    event_type: str = "placed",
    source: str = "manual",
    user_label: str | None = None,
    note: str | None = None,
    commit: bool = True,
) -> dict[str, Any]:
    """Log Interested Clients activity for Company lifecycle → Interested."""
    user = db.get(AppUser, user_id)
    label = _caller_label(user, user_label)
    company = (company_name or "").strip() or "a company"
    kind = (event_type or "placed").strip().lower() or "placed"
    src = (source or "manual").strip().lower() or "manual"

    if kind == "placed":
        message = f"{label} added {company} to Interested Clients"
        if buyer_id:
            buyer = db.get(Buyer, buyer_id)
            if buyer and buyer.interested_clients_list_at is None:
                buyer.interested_clients_list_at = _utcnow()
            mark_buyer_interested_stage(
                db,
                buyer_id,
                user_id=user_id,
                note=note or message,
                commit=False,
            )
    else:
        kind = "removed"
        message = f"{label} removed {company} from Interested Clients"

    row = AiInterestedActivityLog(
        user_id=user_id,
        user_label=label,
        buyer_id=buyer_id,
        company_name=company[:255],
        event_type=kind,
        source=src[:50],
        message=message[:500],
    )
    db.add(row)
    if commit:
        db.commit()
        db.refresh(row)
    return {
        "id": row.id if commit else None,
        "user_id": user_id,
        "user_label": label,
        "buyer_id": buyer_id,
        "company_name": company,
        "event_type": kind,
        "source": src,
        "message": message,
        "created_at": row.created_at.isoformat() if commit and row.created_at else None,
    }


def list_interested_activities(
    db: Session,
    *,
    viewer: AppUser,
    limit: int = 100,
    after_id: int | None = None,
    assigned_to_user_id: int | None = None,
) -> dict[str, Any]:
    from sqlalchemy import func

    is_admin = _is_admin_user(viewer)
    total_in_list = _interested_clients_list_count(
        db, assigned_to_user_id=assigned_to_user_id
    )

    placed_filter = AiInterestedActivityLog.event_type == "placed"
    total_events = (
        db.query(func.count(AiInterestedActivityLog.id)).filter(placed_filter).scalar()
        or 0
    )

    by_user_rows = (
        db.query(
            AiInterestedActivityLog.user_id,
            AiInterestedActivityLog.user_label,
            func.count(AiInterestedActivityLog.id),
        )
        .filter(placed_filter)
        .group_by(AiInterestedActivityLog.user_id, AiInterestedActivityLog.user_label)
        .order_by(func.count(AiInterestedActivityLog.id).desc())
        .all()
    )
    by_user = [
        {
            "user_id": uid,
            "user_label": label,
            "placed_count": int(cnt),
        }
        for uid, label, cnt in by_user_rows
    ]
    my_placed = next(
        (item["placed_count"] for item in by_user if item["user_id"] == viewer.id),
        0,
    )

    feed_query = db.query(AiInterestedActivityLog).filter(placed_filter)
    if not is_admin:
        feed_query = feed_query.filter(AiInterestedActivityLog.user_id == viewer.id)
    if after_id is not None:
        feed_query = feed_query.filter(AiInterestedActivityLog.id > after_id).order_by(
            AiInterestedActivityLog.id.asc()
        )
    else:
        feed_query = feed_query.order_by(
            AiInterestedActivityLog.created_at.desc(),
            AiInterestedActivityLog.id.desc(),
        )

    rows = feed_query.limit(limit).all()
    latest_id = (
        db.query(func.max(AiInterestedActivityLog.id)).scalar() or 0
    )

    return {
        "total_in_list": total_in_list,
        "total_events": int(total_events),
        "my_placed_count": my_placed,
        "by_user": by_user if is_admin else [],
        "latest_id": int(latest_id),
        "rows": [
            {
                "id": r.id,
                "user_id": r.user_id,
                "user_label": r.user_label,
                "buyer_id": r.buyer_id,
                "company_name": r.company_name,
                "event_type": r.event_type,
                "source": r.source,
                "message": r.message,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in rows
        ],
    }


def _not_interested_clients_count(
    db: Session,
    *,
    assigned_to_user_id: int | None = None,
) -> int:
    from modules.calls import buyer_ids_with_latest_call_outcome

    ids = buyer_ids_with_latest_call_outcome(db, "not_interested")
    if not ids:
        return 0
    if assigned_to_user_id is None:
        return len(ids)
    return (
        db.query(Buyer.id)
        .filter(
            Buyer.id.in_(ids),
            Buyer.assigned_to_user_id == assigned_to_user_id,
        )
        .count()
    )


def record_not_interested_activity(
    db: Session,
    *,
    user_id: int,
    company_name: str,
    buyer_id: int | None = None,
    event_type: str = "placed",
    source: str = "call",
    user_label: str | None = None,
    note: str | None = None,
    commit: bool = True,
) -> dict[str, Any]:
    """Log Not interested clients activity for Company lifecycle → Not Interested."""
    user = db.get(AppUser, user_id)
    label = _caller_label(user, user_label)
    company = (company_name or "").strip() or "a company"
    kind = (event_type or "placed").strip().lower() or "placed"
    src = (source or "call").strip().lower() or "call"

    if kind == "placed":
        message = f"{label} marked {company} as Not interested"
        if buyer_id:
            mark_buyer_not_interested_stage(
                db,
                buyer_id,
                user_id=user_id,
                note=note or message,
                commit=False,
            )
    else:
        kind = "removed"
        message = f"{label} removed {company} from Not interested clients"

    row = AiNotInterestedActivityLog(
        user_id=user_id,
        user_label=label,
        buyer_id=buyer_id,
        company_name=company[:255],
        event_type=kind,
        source=src[:50],
        message=message[:500],
    )
    db.add(row)
    if commit:
        db.commit()
        db.refresh(row)
    return {
        "id": row.id if commit else None,
        "user_id": user_id,
        "user_label": label,
        "buyer_id": buyer_id,
        "company_name": company,
        "event_type": kind,
        "source": src,
        "message": message,
        "created_at": row.created_at.isoformat() if commit and row.created_at else None,
    }


def list_not_interested_activities(
    db: Session,
    *,
    viewer: AppUser,
    limit: int = 100,
    after_id: int | None = None,
    assigned_to_user_id: int | None = None,
) -> dict[str, Any]:
    from sqlalchemy import func

    is_admin = _is_admin_user(viewer)
    total_in_list = _not_interested_clients_count(
        db, assigned_to_user_id=assigned_to_user_id
    )

    placed_filter = AiNotInterestedActivityLog.event_type == "placed"
    total_events = (
        db.query(func.count(AiNotInterestedActivityLog.id)).filter(placed_filter).scalar()
        or 0
    )

    by_user_rows = (
        db.query(
            AiNotInterestedActivityLog.user_id,
            AiNotInterestedActivityLog.user_label,
            func.count(AiNotInterestedActivityLog.id),
        )
        .filter(placed_filter)
        .group_by(
            AiNotInterestedActivityLog.user_id,
            AiNotInterestedActivityLog.user_label,
        )
        .order_by(func.count(AiNotInterestedActivityLog.id).desc())
        .all()
    )
    by_user = [
        {
            "user_id": uid,
            "user_label": label,
            "placed_count": int(cnt),
        }
        for uid, label, cnt in by_user_rows
    ]
    my_placed = next(
        (item["placed_count"] for item in by_user if item["user_id"] == viewer.id),
        0,
    )

    feed_query = db.query(AiNotInterestedActivityLog).filter(placed_filter)
    if not is_admin:
        feed_query = feed_query.filter(AiNotInterestedActivityLog.user_id == viewer.id)
    if after_id is not None:
        feed_query = feed_query.filter(AiNotInterestedActivityLog.id > after_id).order_by(
            AiNotInterestedActivityLog.id.asc()
        )
    else:
        feed_query = feed_query.order_by(
            AiNotInterestedActivityLog.created_at.desc(),
            AiNotInterestedActivityLog.id.desc(),
        )

    rows = feed_query.limit(limit).all()
    latest_id = (
        db.query(func.max(AiNotInterestedActivityLog.id)).scalar() or 0
    )

    return {
        "total_in_list": total_in_list,
        "total_events": int(total_events),
        "my_placed_count": my_placed,
        "by_user": by_user if is_admin else [],
        "latest_id": int(latest_id),
        "rows": [
            {
                "id": r.id,
                "user_id": r.user_id,
                "user_label": r.user_label,
                "buyer_id": r.buyer_id,
                "company_name": r.company_name,
                "event_type": r.event_type,
                "source": r.source,
                "message": r.message,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in rows
        ],
    }
