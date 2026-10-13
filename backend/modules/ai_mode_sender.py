"""Resolve sender greeting names and finalize AI Mode reply bodies."""

from __future__ import annotations

import re
from typing import Any

_GENERIC_EMAIL_LOCALS = frozenset(
    {
        "info",
        "sales",
        "contact",
        "hello",
        "admin",
        "support",
        "enquiry",
        "inquiry",
        "mail",
        "office",
        "team",
        "service",
        "help",
        "noreply",
        "no-reply",
    }
)

_COMPANY_MARKERS = re.compile(
    r"\b("
    r"llc|ltd|limited|inc|corp|corporation|company|co\.|group|trading|"
    r"imports?|exports?|foods?|distributors?|wholesale|enterprises?"
    r")\b",
    re.I,
)


def _title_words(parts: list[str]) -> str:
    out: list[str] = []
    for part in parts:
        token = (part or "").strip()
        if not token or token.isdigit():
            continue
        if len(token) == 1:
            out.append(token.upper())
        else:
            out.append(token[:1].upper() + token[1:].lower())
    return " ".join(out).strip()


def parse_person_name(from_name: str | None) -> str | None:
    """Best-effort person name from the From display name."""
    raw = (from_name or "").strip().strip('"').strip("'")
    if not raw or "@" in raw:
        return None
    lower = raw.lower()
    if any(
        marker in lower
        for marker in (
            "noreply",
            "no-reply",
            "mailer-daemon",
            "notification",
            "do not reply",
        )
    ):
        return None
    if _COMPANY_MARKERS.search(raw):
        return None
    # "Izaan Mujeeb" / "Mr John Smith"
    cleaned = re.sub(r"^(mr|mrs|ms|dr|prof)\.?\s+", "", raw, flags=re.I).strip()
    parts = re.split(r"\s+", cleaned)
    if len(parts) >= 2:
        return _title_words(parts[:4])
    if len(parts) == 1 and len(parts[0]) >= 2:
        return _title_words(parts)
    return None


def parse_name_from_email_address(from_email: str | None) -> str | None:
    """Parse izaan.mujeeb@domain.com → Izaan Mujeeb."""
    addr = (from_email or "").strip().lower()
    if "@" not in addr:
        return None
    local = addr.split("@", 1)[0]
    local = re.sub(r"[._+\-]+", " ", local)
    local = re.sub(r"\d+", " ", local)
    parts = [p for p in local.split() if len(p) >= 2]
    if not parts:
        return None
    if len(parts) == 1 and parts[0] in _GENERIC_EMAIL_LOCALS:
        return None
    if all(p in _GENERIC_EMAIL_LOCALS for p in parts):
        return None
    if len(parts) >= 2:
        return _title_words(parts[:3])
    if len(parts) == 1:
        return _title_words(parts)
    return None


def extract_company_hint(
    *,
    subject: str | None = None,
    inbound_body: str | None = None,
    company_research: str | None = None,
) -> str | None:
    """Company name only when clearly present — never guess."""
    research = (company_research or "").strip()
    for line in research.splitlines():
        if line.lower().startswith("company:"):
            name = line.split(":", 1)[1].strip()
            if name and len(name) >= 3:
                return name

    blob = f"{subject or ''}\n{inbound_body or ''}"
    patterns = [
        r"(?:from|at|for|regards,?)\s+([A-Z][A-Za-z0-9&\.\-\s]{2,60}(?:LLC|Ltd|Inc|Company|Co\.|Trading|Imports?|Foods?))",
        r"^([A-Z][A-Za-z0-9&\.\-\s]{2,60}(?:LLC|Ltd|Inc|Company|Co\.|Trading|Imports?|Foods?))",
    ]
    for pattern in patterns:
        match = re.search(pattern, blob, re.I | re.M)
        if match:
            candidate = match.group(1).strip(" .,-")
            if candidate and len(candidate) >= 4:
                return candidate
    return None


def resolve_sender_context(
    *,
    from_name: str | None,
    from_email: str | None,
    subject: str | None = None,
    inbound_body: str | None = None,
    company_research: str | None = None,
) -> dict[str, str]:
    """Person-first greeting; company only when known."""
    person = parse_person_name(from_name)
    person_source = "from_name" if person else ""
    if not person:
        person = parse_name_from_email_address(from_email)
        person_source = "email_address" if person else ""

    company = extract_company_hint(
        subject=subject,
        inbound_body=inbound_body,
        company_research=company_research,
    )

    greeting = person or "Sir/Madam"
    return {
        "greeting_name": greeting,
        "person_name": person or "",
        "company_name": company or "",
        "person_source": person_source or "fallback",
    }


def finalize_reply_body(
    body: str,
    *,
    form_url: str | None,
    greeting_name: str | None = None,
) -> str:
    """Fix common LLM placeholders and weak form-link wording."""
    text = (body or "").strip()
    if not text:
        return text

    url = (form_url or "").strip()
    no_url_phrase = "our team will share the form link with you shortly"
    placeholder_patterns = [
        r"\[Insert Form URL\]",
        r"\[form url\]",
        r"\[Form URL\]",
        r"\{form_url\}",
    ]
    for pattern in placeholder_patterns:
        if url:
            text = re.sub(pattern, url, text, flags=re.I)
        else:
            text = re.sub(
                rf"(?:please\s+)?fill\s+(?:out\s+)?(?:this\s+form\s*:?\s*)?{pattern}",
                no_url_phrase,
                text,
                flags=re.I,
            )
            text = re.sub(pattern, no_url_phrase, text, flags=re.I)

    if greeting_name and greeting_name != "Sir/Madam":
        # Replace generic "Dear Team," when we know the person.
        text = re.sub(
            r"Dear\s+[A-Za-z0-9&\.\-\s]{3,80}\s+Team,",
            f"Dear {greeting_name},",
            text,
            count=1,
        )

    return text.strip()
