"""Incomplete Data from Archives — partial spreadsheet rows kept for manual / AI fill-in."""

from __future__ import annotations

import re
from typing import Any

from sqlalchemy.orm import Session

from db.models import Buyer, Contact
from modules import buyers as buyers_module
from modules.audit import log_action

INCOMPLETE_ARCHIVES_SOURCE = "incomplete_archives"
JUNK_COMPANY_NAMES = frozenset({"", "unnamed", "unknown", "n/a", "na", "-", "---"})
ZW = re.compile(r"[\u200b\u200c\u200d\ufeff]")


def _clean(value: object | None) -> str:
    if value is None:
        return ""
    return ZW.sub("", str(value)).replace("\n", " ").strip()


def primary_contact(db: Session, buyer_id: int) -> Contact | None:
    contacts = buyers_module.list_contacts_for_buyer(db, buyer_id)
    return contacts[0] if contacts else None


def has_salvage_data(buyer: Buyer, contact: Contact | None = None) -> bool:
    """True when a row has anything worth keeping (name, product, phone, email, etc.)."""
    if _clean(buyer.product_interest):
        return True
    if _clean(buyer.company_name) and _clean(buyer.company_name).lower() not in JUNK_COMPANY_NAMES:
        return True
    if _clean(buyer.remarks):
        return True
    if _clean(buyer.industry):
        return True
    if contact is None:
        return False
    for field in (
        contact.phone,
        contact.primary_phone,
        contact.secondary_phone,
        contact.secondary_mobile,
        contact.email,
        contact.secondary_email,
        contact.full_name,
    ):
        if _clean(field):
            return True
    return False


def is_incomplete_archives_source(source: str | None) -> bool:
    return (source or "").strip().lower() == INCOMPLETE_ARCHIVES_SOURCE


def should_archive_instead_of_delete(db: Session, buyer: Buyer) -> bool:
    """Partial Old clients / import rows → Incomplete Archives, not delete."""
    contact = primary_contact(db, buyer.id)
    if has_salvage_data(buyer, contact):
        return True
    # Even messy names (hypermarket-only text) — keep if any contact field exists.
    return contact is not None and has_salvage_data(buyer, contact)


def relocate_buyer_to_incomplete_archives(
    db: Session,
    buyer_id: int,
    *,
    reason: str = "relocated",
    commit: bool = True,
) -> bool:
    buyer = buyers_module.get_buyer(db, buyer_id)
    if not buyer:
        return False
    if is_incomplete_archives_source(buyer.source):
        return False
    buyer.source = INCOMPLETE_ARCHIVES_SOURCE
    buyer.intake_method = "upload"
    if commit:
        db.commit()
    return True


def relocate_buyers_to_incomplete_archives(
    db: Session,
    buyer_ids: list[int],
    *,
    reason: str = "relocated",
) -> dict[str, Any]:
    from modules.leads import invalidate_lead_table_filters_cache, invalidate_section_counts_cache

    moved: list[int] = []
    for buyer_id in buyer_ids:
        if relocate_buyer_to_incomplete_archives(db, buyer_id, reason=reason, commit=False):
            moved.append(buyer_id)
    if moved:
        db.commit()
        invalidate_lead_table_filters_cache()
        invalidate_section_counts_cache()
        log_action(
            db,
            entity_type="buyer",
            entity_id=0,
            action="relocate_incomplete_archives",
            details={"reason": reason, "moved_ids": moved, "count": len(moved)},
        )
    return {"moved_count": len(moved), "moved_ids": moved}


def promote_from_incomplete_archives(
    db: Session,
    *,
    lead_ids: list[int],
    target_source: str = "old_clients",
) -> dict[str, Any]:
    """Manual promotion only — default target is Old clients."""
    from modules.leads import invalidate_lead_table_filters_cache, invalidate_section_counts_cache

    target = target_source.strip().lower()
    if target not in {"old_clients"}:
        raise ValueError("Promotion target must be old_clients (manual only).")

    promoted: list[int] = []
    for lead_id in lead_ids:
        buyer = buyers_module.get_buyer(db, lead_id)
        if not buyer or not is_incomplete_archives_source(buyer.source):
            continue
        buyer.source = target
        promoted.append(lead_id)

    if promoted:
        invalidate_lead_table_filters_cache()
        invalidate_section_counts_cache()
        db.commit()
        log_action(
            db,
            entity_type="buyer",
            entity_id=0,
            action="promote_incomplete_archives",
            details={"target": target, "lead_ids": promoted},
        )
    return {"promoted_count": len(promoted), "promoted_ids": promoted, "target": target}


def merge_duplicate_into_keeper(
    db: Session,
    keeper: Buyer,
    loser: Buyer,
) -> dict[str, Any]:
    """Copy missing fields and extra phones/emails from duplicate loser into keeper."""
    merged: list[str] = []
    for field in (
        "website_url",
        "country",
        "city",
        "address",
        "industry",
        "product_interest",
        "remarks",
        "company_grading",
        "business_type",
    ):
        keeper_val = _clean(getattr(keeper, field, None))
        loser_val = _clean(getattr(loser, field, None))
        if not keeper_val and loser_val:
            setattr(keeper, field, loser_val)
            merged.append(field)

    keeper_contacts = buyers_module.list_contacts_for_buyer(db, keeper.id)
    loser_contacts = buyers_module.list_contacts_for_buyer(db, loser.id)
    keeper_contact = keeper_contacts[0] if keeper_contacts else None
    loser_contact = loser_contacts[0] if loser_contacts else None

    if keeper_contact and loser_contact:
        for field in (
            "full_name",
            "email",
            "secondary_email",
            "phone",
            "primary_phone",
            "secondary_phone",
            "secondary_mobile",
            "designation",
        ):
            k_val = _clean(getattr(keeper_contact, field, None))
            l_val = _clean(getattr(loser_contact, field, None))
            if not k_val and l_val:
                setattr(keeper_contact, field, l_val)
                merged.append(f"contact.{field}")
    elif not keeper_contact and loser_contact:
        loser_contact.buyer_id = keeper.id
        merged.append("contact.reassigned")

    return {"merged_fields": merged, "keeper_id": keeper.id, "loser_id": loser.id}


def should_route_to_incomplete_archives(buyer: Buyer, contact: Contact | None) -> bool:
    """Route only fragmentary rows — not normal leads missing a website or extra phone."""
    if not has_salvage_data(buyer, contact):
        return False

    name = _clean(buyer.company_name).lower()
    has_real_name = bool(name and name not in JUNK_COMPANY_NAMES and len(name) >= 3)

    # Real company name is enough — missing website/phone/email alone is not "incomplete".
    if has_real_name:
        return False

    # Salvageable fragment without a usable company name (phone-only, product-only, etc.).
    return True


def is_fragmentary_import_row(raw: dict[str, Any]) -> bool:
    """Same rules as should_route_to_incomplete_archives, applied to CSV/import dicts."""
    name = _clean(raw.get("company_name") or "").lower()
    has_real_name = bool(name and name not in JUNK_COMPANY_NAMES and len(name) >= 3)
    if has_real_name:
        return False

    from modules.field_clean import email_dedupe_key, phone_dedupe_key

    def _has_phone(*keys: str) -> bool:
        return any(phone_dedupe_key(str(raw.get(key) or "")) for key in keys)

    def _has_email(*keys: str) -> bool:
        return any(email_dedupe_key(str(raw.get(key) or "")) for key in keys)

    has_contact = _has_phone("phone", "primary_phone", "secondary_phone", "secondary_mobile") or _has_email(
        "email", "secondary_email", "contact_email"
    )
    has_product = bool(_clean(raw.get("product_interest") or ""))
    has_remarks = bool(
        _clean(raw.get("remarks") or "")
        or _clean(raw.get("remarks_03") or "")
        or _clean(raw.get("remarks_04") or "")
    )
    has_industry = bool(_clean(raw.get("industry") or ""))

    return bool(has_contact or has_product or has_remarks or has_industry)


def completeness_summary(db: Session, buyer: Buyer) -> dict[str, Any]:
    contact = primary_contact(db, buyer.id)
    score = buyers_module.buyer_data_score(db, buyer)
    filled = []
    missing = []
    checks = [
        ("company_name", _clean(buyer.company_name)),
        ("country", _clean(buyer.country)),
        ("product", _clean(buyer.product_interest)),
        ("phone", _clean(contact.phone if contact else "")),
        ("email", _clean(contact.email if contact else "")),
        ("website", _clean(buyer.website_url)),
        ("city", _clean(buyer.city)),
    ]
    for key, val in checks:
        if val and val.lower() not in JUNK_COMPANY_NAMES:
            filled.append(key)
        else:
            missing.append(key)
    return {
        "data_score": score,
        "filled": filled,
        "missing": missing,
        "salvage": has_salvage_data(buyer, contact),
    }
