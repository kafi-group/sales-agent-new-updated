"""Route lead-table phone columns: WhatsApp-capable numbers in primary fields, landlines in secondary."""

from __future__ import annotations

import re
from typing import Any

from db.models import Contact


def _digits(value: str | None) -> str:
    return re.sub(r"\D", "", value or "")


def _looks_like_mobile(phone: str) -> bool:
    """Heuristic when country-specific rules do not classify the number."""
    digits = _digits(phone)
    if digits.startswith("00"):
        digits = digits[2:]
    if 11 <= len(digits) <= 13:
        return True
    if phone.strip().startswith("+") and len(digits) >= 10:
        return True
    return False


def _matches_wa_id(normalized: str, wa_id: str | None) -> bool:
    if not wa_id or not normalized:
        return False
    wa = _digits(wa_id)
    num = _digits(normalized)
    if not wa or not num:
        return False
    return num == wa or num.endswith(wa) or wa.endswith(num)


def is_whatsapp_primary_column_number(
    raw: str | None,
    *,
    country_hint: str | None = None,
    wa_id: str | None = None,
    label: str = "",
) -> bool:
    """True when the number belongs in Primary Mobile / Primary Phone (WhatsApp-capable)."""
    from integrations.voice_client import normalize_e164
    from modules.personalized_followups import _classify_phone_type

    text = (raw or "").strip()
    if not text:
        return False
    normalized = normalize_e164(text, country_hint) or text
    if _matches_wa_id(normalized, wa_id):
        return True
    _ptype, is_landline, wa_supported = _classify_phone_type(normalized, label)
    if is_landline or not wa_supported:
        return False
    if _ptype == "mobile":
        return True
    return _looks_like_mobile(normalized)


def _normalize_display(raw: str, country_hint: str | None) -> str:
    from integrations.voice_client import normalize_e164

    text = (raw or "").strip()
    if not text:
        return ""
    return normalize_e164(text, country_hint) or text


def route_contact_phones(
    *,
    phone: str | None = None,
    primary_phone: str | None = None,
    secondary_mobile: str | None = None,
    secondary_phone: str | None = None,
    country_hint: str | None = None,
    wa_id: str | None = None,
) -> dict[str, str | None]:
    """Assign phones to lead-table columns (primary slots = WhatsApp-capable only)."""
    raw_values: list[str] = []
    for value in (phone, primary_phone, secondary_mobile, secondary_phone):
        if not value:
            continue
        for part in re.split(r"[;|/]", str(value)):
            text = part.strip()
            if text:
                raw_values.append(text)

    seen: set[str] = set()
    ordered: list[str] = []
    for raw in raw_values:
        key = _digits(raw)
        if len(key) < 8 or key in seen:
            continue
        seen.add(key)
        ordered.append(raw)

    wa_unique: list[str] = []
    land_unique: list[str] = []
    wa_seen: set[str] = set()
    land_seen: set[str] = set()
    for raw in ordered:
        display = _normalize_display(raw, country_hint) or raw
        key = _digits(display)
        if is_whatsapp_primary_column_number(
            display,
            country_hint=country_hint,
            wa_id=wa_id,
        ):
            if key not in wa_seen:
                wa_seen.add(key)
                wa_unique.append(display)
        elif key not in land_seen:
            land_seen.add(key)
            land_unique.append(display)

    return {
        "phone": wa_unique[0] if len(wa_unique) > 0 else None,
        "primary_phone": wa_unique[1] if len(wa_unique) > 1 else None,
        "secondary_mobile": wa_unique[2] if len(wa_unique) > 2 else None,
        "secondary_phone": "; ".join(land_unique) if land_unique else None,
    }


def route_contact_model(contact: Contact, country_hint: str | None = None) -> bool:
    """Rewrite contact phone columns in place. Returns True if anything changed."""
    routed = route_contact_phones(
        phone=contact.phone,
        primary_phone=contact.primary_phone,
        secondary_mobile=contact.secondary_mobile,
        secondary_phone=contact.secondary_phone,
        country_hint=country_hint,
        wa_id=contact.wa_id,
    )
    changed = False
    for key, value in routed.items():
        cur = (getattr(contact, key, None) or "").strip() or None
        new_val = (value or "").strip() or None
        if cur != new_val:
            setattr(contact, key, new_val)
            changed = True
    return changed


def contact_fields_for_lead_table(
    contact: Contact | None,
    country_hint: str | None,
) -> dict[str, Any]:
    """Phone columns as they should appear on the leads table (display routing)."""
    if contact is None:
        return {
            "contact_phone": None,
            "contact_primary_phone": None,
            "contact_secondary_mobile": None,
            "contact_secondary_phone": None,
        }
    routed = route_contact_phones(
        phone=contact.phone,
        primary_phone=contact.primary_phone,
        secondary_mobile=contact.secondary_mobile,
        secondary_phone=contact.secondary_phone,
        country_hint=country_hint,
        wa_id=contact.wa_id,
    )
    return {
        "contact_phone": routed["phone"],
        "contact_primary_phone": routed["primary_phone"],
        "contact_secondary_mobile": routed["secondary_mobile"],
        "contact_secondary_phone": routed["secondary_phone"],
    }
