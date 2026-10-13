"""Keep Email and WhatsApp customer messages synchronized (same information)."""

from __future__ import annotations

WHATSAPP_MAX_LEN = 2000


def derive_whatsapp_from_email(email_body: str, *, max_len: int = WHATSAPP_MAX_LEN) -> str:
    """
    Build the WhatsApp text from the email body so both channels carry the same facts.

    Email remains the source of truth. WhatsApp gets the same plain-text content
    (trimmed / length-capped for Meta free-form messages).
    """
    text = (email_body or "").replace("\r\n", "\n").strip()
    if not text:
        return ""
    # Collapse extreme blank runs; keep paragraph breaks for readability.
    while "\n\n\n" in text:
        text = text.replace("\n\n\n", "\n\n")
    if len(text) > max_len:
        cut = text[: max_len - 1].rsplit(" ", 1)[0].rstrip()
        text = (cut or text[: max_len - 1]).rstrip() + "…"
    return text


def sync_whatsapp_with_email(email_body: str, whatsapp_body: str | None = None) -> str:
    """
    Prefer a derived WhatsApp body from email.

    `whatsapp_body` is ignored when email is present so channels cannot drift apart.
    """
    email = (email_body or "").strip()
    if email:
        return derive_whatsapp_from_email(email)
    return (whatsapp_body or "").strip()[:WHATSAPP_MAX_LEN]
