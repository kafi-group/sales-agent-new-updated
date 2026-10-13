"""Outbound email open tracking — signed pixel tokens + HTML wrapper."""

from __future__ import annotations

import base64
import hashlib
import hmac
import html
import logging
import os
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from config import settings
from db.models import Contact, Interaction

logger = logging.getLogger(__name__)

# 1x1 transparent GIF
_PIXEL_GIF = base64.b64decode(
    "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
)


def _track_secret() -> bytes:
    raw = (
        (settings.email_track_secret or "").strip()
        or (settings.mailbox_password or "").strip()
        or (settings.mailbox_email or "kafi-sales-agent")
    )
    return raw.encode("utf-8")


def _normalize_public_base(raw: str) -> str | None:
    """Normalize env host to https origin without a trailing /api segment."""
    value = (raw or "").strip().rstrip("/")
    if not value:
        return None
    lower = value.lower()
    if lower.endswith("/api"):
        value = value[:-4].rstrip("/")
    if value.startswith("http://") or value.startswith("https://"):
        return value
    return f"https://{value}"


def public_api_base() -> str | None:
    """Public HTTPS origin of this API — required for open-tracking pixels.

    Order: TWILIO_WEBHOOK_BASE_URL (live Railway host) → PUBLIC_API_BASE_URL →
    Railway auto domains. Stale PUBLIC_API_* values must not override a working Twilio URL.
    """
    candidates = [
        (settings.twilio_webhook_base_url or "").strip(),
        (settings.public_api_base_url or "").strip(),
        (os.environ.get("RAILWAY_PUBLIC_DOMAIN") or "").strip(),
        (os.environ.get("RAILWAY_STATIC_URL") or "").strip(),
    ]
    for raw in candidates:
        base = _normalize_public_base(raw)
        if base:
            return base
    return None


def make_open_token(*, interaction_id: int, send_mode: str = "individual") -> str:
    mode = "bulk" if send_mode == "bulk" else "individual"
    payload = f"{int(interaction_id)}.{mode}"
    sig = hmac.new(_track_secret(), payload.encode("utf-8"), hashlib.sha256).hexdigest()[:20]
    raw = f"{payload}.{sig}".encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def parse_open_token(token: str) -> tuple[int, str] | None:
    text = (token or "").strip()
    if not text:
        return None
    try:
        padded = text + "=" * (-len(text) % 4)
        decoded = base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")
        interaction_id_s, mode, sig = decoded.split(".", 2)
        interaction_id = int(interaction_id_s)
        mode = "bulk" if mode == "bulk" else "individual"
        payload = f"{interaction_id}.{mode}"
        expected = hmac.new(
            _track_secret(), payload.encode("utf-8"), hashlib.sha256
        ).hexdigest()[:20]
        if not hmac.compare_digest(sig, expected):
            return None
        return interaction_id, mode
    except (ValueError, TypeError, UnicodeDecodeError):
        return None


def open_pixel_url(*, interaction_id: int, send_mode: str = "individual") -> str | None:
    base = public_api_base()
    if not base:
        return None
    token = make_open_token(interaction_id=interaction_id, send_mode=send_mode)
    return f"{base}/api/track/email-open/{token}.gif"


def _looks_like_html(body: str) -> bool:
    import re

    return bool(re.search(r"</?[a-zA-Z][^>]*>", body or ""))


def _html_to_plain(body: str) -> str:
    """Best-effort strip of tags for the text/plain part."""
    import re

    text = body or ""
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"(?i)</p\s*>", "\n\n", text)
    text = re.sub(r"(?i)</div\s*>", "\n", text)
    text = re.sub(r"(?i)</li\s*>", "\n", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _wrap_email_html(content: str, *, pixel_url: str | None) -> str:
    pixel = ""
    if pixel_url:
        safe = html.escape(pixel_url, quote=True)
        # Use attributes that survive Gmail/Outlook clipping and image proxies.
        pixel = (
            f'<img src="{safe}" width="1" height="1" alt="" border="0" '
            f'style="display:block;width:1px;height:1px;border:0;opacity:0;" />'
        )
    return (
        "<!DOCTYPE html><html><body "
        'style="margin:0;padding:16px;background:#fff;'
        'font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#111">'
        f"{content}{pixel}</body></html>"
    )


def plain_to_tracked_html(body: str, *, pixel_url: str | None) -> str:
    escaped = html.escape(body or "")
    paragraphs = [
        f"<p style=\"margin:0 0 12px;white-space:pre-wrap;\">"
        f"{p.replace(chr(10), '<br>')}</p>"
        for p in escaped.split("\n\n")
    ]
    content = "".join(paragraphs) or (
        f"<p style=\"margin:0\">{escaped.replace(chr(10), '<br>')}</p>"
    )
    return _wrap_email_html(content, pixel_url=pixel_url)


def rich_html_to_tracked_html(body: str, *, pixel_url: str | None) -> str:
    """Wrap editor HTML (already tagged) and append open pixel."""
    content = (body or "").strip()
    if not content:
        content = "<p></p>"
    return _wrap_email_html(content, pixel_url=pixel_url)


_DATA_URI_IMG_RE = None


def _data_uri_img_re():
    global _DATA_URI_IMG_RE
    if _DATA_URI_IMG_RE is None:
        import re

        # src='data:image/png;base64,...' or src="data:image/jpeg;base64,..."
        _DATA_URI_IMG_RE = re.compile(
            r"""(?is)(\bsrc\s*=\s*)(['"])(data:image/([a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+))\2"""
        )
    return _DATA_URI_IMG_RE


def extract_data_uri_images(html: str) -> tuple[str, list[dict[str, Any]]]:
    """Convert inline ``data:image/...;base64,...`` srcs into CID MIME parts.

    Gmail (and many clients) strip or show raw text for huge data-URI images in HTML.
    Sales Agent's browser preview still works with data URIs; conversion happens at send.
    """
    import re

    if not html or "data:image/" not in html.lower():
        return html, []

    parts: list[dict[str, Any]] = []
    counter = 0

    def _repl(match: re.Match[str]) -> str:
        nonlocal counter
        prefix, quote, _full, subtype_raw, b64 = match.groups()
        subtype = (subtype_raw or "png").lower().split("+", 1)[0].split(";", 1)[0]
        if subtype == "jpg":
            subtype = "jpeg"
        try:
            cleaned = re.sub(r"\s+", "", b64)
            data = base64.b64decode(cleaned, validate=False)
        except Exception:  # noqa: BLE001
            return match.group(0)
        if not data:
            return match.group(0)
        counter += 1
        cid = f"kafiimg{counter}@kafi-group.com"
        ext = "jpg" if subtype == "jpeg" else subtype
        parts.append(
            {
                "cid": cid,
                "content_type": f"image/{subtype}",
                "filename": f"inline-{counter}.{ext}",
                "data": data,
            }
        )
        return f"{prefix}{quote}cid:{cid}{quote}"

    new_html = _data_uri_img_re().sub(_repl, html)
    return new_html, parts


def host_data_uri_images_as_public_urls(html: str) -> str:
    """Replace data-URI images with public HTTPS URLs (Gmail-safe).

    Prefer this over leaving ``data:image`` in the message body. Gmail often
    blanks those images or, when the MIME part is forced to text/plain, shows
    the raw ``<img src="data:...">`` source to the recipient.
    """
    import re

    from modules.email_attachments import register_attachment_from_bytes

    if not html or "data:image/" not in html.lower():
        return html
    base = public_api_base()
    if not base:
        logger.warning("Cannot host inline email images — PUBLIC_API_BASE_URL unset")
        return html

    def _repl(match: re.Match[str]) -> str:
        prefix, quote, _full, subtype_raw, b64 = match.groups()
        subtype = (subtype_raw or "png").lower().split("+", 1)[0].split(";", 1)[0]
        if subtype == "jpg":
            subtype = "jpeg"
        try:
            cleaned = re.sub(r"\s+", "", b64)
            data = base64.b64decode(cleaned, validate=False)
        except Exception:  # noqa: BLE001
            return match.group(0)
        if not data:
            return match.group(0)
        # Cap single inline image at 8 MB decoded.
        if len(data) > 8 * 1024 * 1024:
            logger.warning("Skipping oversized inline email image (%s bytes)", len(data))
            return match.group(0)
        ext = "jpg" if subtype == "jpeg" else subtype
        try:
            meta = register_attachment_from_bytes(
                data,
                filename=f"inline.{ext}",
                content_type=f"image/{subtype}",
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("Failed to store inline email image: %s", exc)
            return match.group(0)
        url = f"{base}/api/mailer/inline-media/{meta['id']}"
        return f"{prefix}{quote}{url}{quote}"

    return _data_uri_img_re().sub(_repl, html)


def build_tracked_bodies(
    body: str,
    *,
    interaction_id: int | None,
    send_mode: str = "individual",
) -> tuple[str, str | None]:
    """Return (plain_text, html_or_none). HTML includes open pixel when public base URL is set."""
    raw = body or ""
    # Host data-URI images first so Gmail gets https:// links, not base64 blobs.
    if "data:image/" in raw.lower():
        raw = host_data_uri_images_as_public_urls(raw)
    is_html = _looks_like_html(raw)
    plain = _html_to_plain(raw) if is_html else raw
    pixel = (
        open_pixel_url(interaction_id=interaction_id, send_mode=send_mode)
        if interaction_id
        else None
    )
    if is_html:
        return plain, rich_html_to_tracked_html(raw, pixel_url=pixel)
    # Always prefer an HTML part when we can track — many clients only load pixels from HTML.
    if pixel:
        return plain, plain_to_tracked_html(plain, pixel_url=pixel)
    return plain, None


def build_tracked_bodies_with_inline(
    body: str,
    *,
    interaction_id: int | None,
    send_mode: str = "individual",
) -> tuple[str, str | None, list[dict[str, Any]]]:
    """Like :func:`build_tracked_bodies` plus CID inline image parts for SMTP/Resend."""
    plain, html_body = build_tracked_bodies(
        body, interaction_id=interaction_id, send_mode=send_mode
    )
    if not html_body:
        return plain, None, []
    html_out, inline = extract_data_uri_images(html_body)
    return plain, html_out, inline


def pixel_gif_bytes() -> bytes:
    return _PIXEL_GIF


def ensure_outbound_tracking_interaction(
    db: Session,
    *,
    user_id: int | None,
    to_email: str,
    subject: str,
    body: str,
    buyer_id: int | None = None,
    contact_id: int | None = None,
    approved_by: str | None = None,
) -> Interaction | None:
    """Create a lightweight outbound Interaction so open pixels can be attached.

    Used for inbox compose/reply and Vercel mailer sends that otherwise have no draft id.
    """
    from db.models import (
        AppUser,
        Buyer,
        Channel,
        Direction,
        HandledBy,
        InteractionStatus,
    )

    email = (to_email or "").strip().lower()
    if not email or "@" not in email:
        return None

    contact: Contact | None = None
    if contact_id is not None:
        contact = db.get(Contact, contact_id)
    if contact is None and buyer_id is not None:
        contact = (
            db.query(Contact)
            .filter(Contact.buyer_id == buyer_id, Contact.email.isnot(None))
            .order_by(Contact.id.asc())
            .first()
        )
    if contact is None:
        contact = (
            db.query(Contact)
            .filter(Contact.email.ilike(email))
            .order_by(Contact.id.asc())
            .first()
        )

    if contact is None:
        local = email.split("@")[0] or "Contact"
        company = email.split("@")[-1] or email
        buyer = Buyer(
            company_name=f"Email · {company}",
            source="email_tracking",
            assigned_to_user_id=user_id,
        )
        db.add(buyer)
        db.flush()
        contact = Contact(
            buyer_id=buyer.id,
            full_name=local.replace(".", " ").replace("_", " ").title() or "Contact",
            email=email,
        )
        db.add(contact)
        db.flush()

    actor = (approved_by or "").strip() or None
    if not actor and user_id:
        user = db.get(AppUser, user_id)
        if user:
            actor = user.username

    draft = Interaction(
        contact_id=contact.id,
        channel=Channel.email,
        direction=Direction.outbound,
        subject=(subject or "").strip() or "(no subject)",
        content=(body or "").strip() or "(empty)",
        language="en",
        handled_by=HandledBy.human,
        status=InteractionStatus.draft,
        approved_by=actor,
        attachments=[],
    )
    db.add(draft)
    db.commit()
    db.refresh(draft)
    return draft


def mark_tracking_interaction_sent(db: Session, interaction_id: int | None) -> None:
    if not interaction_id:
        return
    from db.models import InteractionStatus

    interaction = db.get(Interaction, interaction_id)
    if not interaction:
        return
    interaction.status = InteractionStatus.sent
    db.commit()


def _resolve_sender_user_id(db: Session, interaction: Interaction) -> int | None:
    """Best-effort sender attribution for Insights scoping."""
    from db.models import AppUser, Buyer, EmailActivityEvent

    prior = (
        db.query(EmailActivityEvent)
        .filter(
            EmailActivityEvent.interaction_id == interaction.id,
            EmailActivityEvent.user_id.isnot(None),
        )
        .order_by(EmailActivityEvent.created_at.desc())
        .first()
    )
    if prior and prior.user_id:
        return prior.user_id

    if interaction.approved_by:
        user = (
            db.query(AppUser)
            .filter(AppUser.username == interaction.approved_by)
            .first()
        )
        if user:
            return user.id

    contact = db.get(Contact, interaction.contact_id)
    if contact:
        buyer = db.get(Buyer, contact.buyer_id)
        if buyer and buyer.assigned_to_user_id:
            return buyer.assigned_to_user_id

    return None


def record_open(
    db: Session,
    *,
    interaction_id: int,
    send_mode: str = "individual",
) -> dict[str, Any]:
    """Record a first-open engagement event for an outbound email interaction."""
    from datetime import timedelta

    from db.models import Buyer, EmailActivityEvent
    from modules import email_activity

    interaction = db.get(Interaction, interaction_id)
    if not interaction:
        logger.info("Open ignored: unknown interaction_id=%s", interaction_id)
        return {"status": "ignored", "reason": "unknown_interaction"}

    # Gmail (and some hosts) prefetch tracking pixels shortly after delivery via
    # an image proxy — that fires before a human opens. Ignore very early hits.
    OPEN_PREFETCH_GRACE_SECONDS = 90
    sent_at = interaction.created_at
    if sent_at is not None:
        if sent_at.tzinfo is None:
            sent_at = sent_at.replace(tzinfo=timezone.utc)
        age = datetime.now(timezone.utc) - sent_at
        if age < timedelta(seconds=OPEN_PREFETCH_GRACE_SECONDS):
            logger.info(
                "Open ignored (prefetch grace): interaction_id=%s age_s=%.1f",
                interaction_id,
                age.total_seconds(),
            )
            return {"status": "ignored", "reason": "prefetch_grace"}

    already = (
        db.query(EmailActivityEvent)
        .filter(
            EmailActivityEvent.event_type == "opened",
            EmailActivityEvent.interaction_id == interaction_id,
        )
        .first()
    )
    if already:
        # Backfill user_id if an earlier open was stored without attribution.
        if already.user_id is None:
            sender_user_id = _resolve_sender_user_id(db, interaction)
            if sender_user_id:
                already.user_id = sender_user_id
                db.commit()
        return {"status": "already_opened", "event_id": already.id}

    contact = db.get(Contact, interaction.contact_id)
    buyer_id = contact.buyer_id if contact else None
    company = "lead"
    to_email = contact.email if contact else None
    if buyer_id:
        buyer = db.get(Buyer, buyer_id)
        if buyer:
            company = buyer.company_name

    mode = "bulk" if send_mode == "bulk" else "individual"
    sender_user_id = _resolve_sender_user_id(db, interaction)

    event = email_activity.record_event(
        db,
        event_type="opened",
        title=f"Opened — {company}",
        message=(
            f"Recipient opened “{interaction.subject or 'email'}”"
            f"{f' ({to_email})' if to_email else ''}."
        ),
        user_id=sender_user_id,
        buyer_id=buyer_id,
        contact_id=interaction.contact_id,
        interaction_id=interaction_id,
        details={
            "send_mode": mode,
            "to_email": to_email,
            "subject": interaction.subject,
            "company_name": company,
        },
    )
    logger.info(
        "Open recorded interaction_id=%s user_id=%s mode=%s",
        interaction_id,
        sender_user_id,
        mode,
    )
    return {"status": "recorded", "event_id": event.id, "send_mode": mode}
