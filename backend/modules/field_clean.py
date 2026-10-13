"""Shared normalization for emails and phones on import / synthesis / post-clean."""

from __future__ import annotations

import re

EMAIL_WRAP_QUOTES = re.compile(r"^['\"`]+|['\"`]+$")
EMAIL_RE = re.compile(r"[\w.+-]+@[\w.-]+\.\w+", re.I)
ZW = re.compile(r"[\u200b\u200c\u200d\ufeff]")
PHONE_DIGITS_RE = re.compile(r"\D")


def clean_scalar(value: object | None) -> str:
    if value is None:
        return ""
    text = ZW.sub("", str(value)).replace("\n", " ").strip()
    if re.fullmatch(r"\d+\.0+", text):
        return text.split(".", 1)[0]
    return text


def normalize_email(value: str | None) -> tuple[str, bool]:
    """Strip Excel apostrophes/quotes and return (email, changed)."""
    raw = clean_scalar(value)
    if not raw or raw in {"-", "—", "N/A", "n/a"}:
        return "", raw != (value or "").strip()
    stripped = EMAIL_WRAP_QUOTES.sub("", raw).strip().strip("'\"`")
    match = EMAIL_RE.search(stripped)
    if not match:
        return "", raw != (value or "").strip()
    email = match.group(0).lower()
    original = clean_scalar(value).lower()
    return email, email != original


def normalize_email_or_empty(value: str | None) -> str:
    email, _ = normalize_email(value)
    return email


def email_dedupe_key(value: str | None) -> str | None:
    email = normalize_email_or_empty(value)
    return email or None


def phone_dedupe_key(value: str | None) -> str | None:
    digits = PHONE_DIGITS_RE.sub("", value or "")
    if len(digits) < 8 or len(digits) > 15:
        return None
    if len(set(digits)) <= 2:
        return None
    return digits


def contact_name_dedupe_key(value: str | None) -> str | None:
    """Normalize a person name for import/table dedupe (letters only, lowercased)."""
    import re

    name = re.sub(r"[^a-z]", "", (value or "").strip().lower())
    if len(name) < 2:
        return None
    return name


def person_email_dedupe_key(contact_name: str | None, email: str | None) -> str | None:
    """Contact person + email — primary identity for spreadsheet imports."""
    person = contact_name_dedupe_key(contact_name)
    email_key = email_dedupe_key(email)
    if not person or not email_key:
        return None
    return f"{person}|{email_key}"


def person_phone_dedupe_key(contact_name: str | None, phone: str | None) -> str | None:
    """Contact person + phone — same person on a shared company line stays distinct from others."""
    person = contact_name_dedupe_key(contact_name)
    phone_key = phone_dedupe_key(phone)
    if not person or not phone_key:
        return None
    return f"{person}|{phone_key}"
