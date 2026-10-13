"""Usman-style Old Clients company-field cleaning (pass 1).

Moves address/email/placeholder values out of Company Name into Address or
Primary Email. Fast, no web lookup — complements Fix names (buyer_name_repair).
"""
from __future__ import annotations

import re
from typing import Any

from sqlalchemy.orm import Session

from db.models import Buyer, Contact
from modules.audit import log_action

UK_PC = re.compile(r"\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b", re.I)
CITY_PC = re.compile(
    r"^(?P<body>[A-Za-z][A-Za-z .'\-]{1,40}?)[,\s]+(?P<pc>[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})$",
    re.I,
)
STREET_START = re.compile(
    r"^(?:\d{1,5}[A-Za-z]?\s+|[A-Z]?\d{1,5}\s+).+\b(street|st\.?|road|rd\.?|avenue|ave\.?|"
    r"lane|ln\.?|drive|dr\.?|close|court|ct\.?|place|pl\.?|way|boulevard|blvd|centre|center|"
    r"estate|industrial|park)\b",
    re.I,
)
BARE_LOCATION = re.compile(
    r"^(Middlesex|London|Manchester|Birmingham|Leeds|Glasgow|Edinburgh|Cardiff|Bristol|"
    r"Weston Centre|Industrial Estate|Trading Estate|Business Park)(\b|$).*",
    re.I,
)
EMAILISH = re.compile(r"(?i)^(?:email\s*[·\-:.]?\s*)?.+@.+\..+")
EMAIL_LABEL = re.compile(r"(?i)^email\s*[·\-:]")
ONLY_DASH = re.compile(r"^[\-\—–_./\s]+$")
COMPANYISH = re.compile(
    r"(?i)\b(ltd|limited|llc|inc|corp|company|co\.|plc|pvt|gmbh|sarl|bv|oy|ab|"
    r"trading|foods|distributors?|importers?|exporters?|group|enterprises?|mill|mills)\b"
)
ZW = re.compile(r"[\u200b\u200c\u200d\ufeff]")
EMAIL_EXTRACT = re.compile(r"[\w.+-]+@[\w.-]+\.\w+")


def clean_text(value: object | None) -> str:
    if value is None:
        return ""
    return ZW.sub("", str(value)).replace("\n", " ").strip()


def classify_company(co: str) -> str | None:
    """Return a rule id when company_name looks like junk / address / email."""
    s = co.strip()
    if not s:
        return None
    if ONLY_DASH.match(s) or s in {"---", "N/A", "n/a", "NA", ".", "null", "None"}:
        return "dash_placeholder"
    if EMAIL_LABEL.search(s) or EMAILISH.search(s):
        return "email_as_company"
    if re.fullmatch(r"[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}", s, re.I):
        return "postcode_only"
    if UK_PC.search(s) and not COMPANYISH.search(s):
        return "uk_postcode_as_company"
    if CITY_PC.match(s) and not COMPANYISH.search(s):
        return "city_postcode_as_company"
    if STREET_START.search(s) and not COMPANYISH.search(s):
        return "street_address_as_company"
    if BARE_LOCATION.match(s) and not COMPANYISH.search(s):
        return "location_as_company"
    return None


def _primary_contact(db: Session, buyer_id: int) -> Contact | None:
    return (
        db.query(Contact)
        .filter(Contact.buyer_id == buyer_id)
        .order_by(Contact.id.asc())
        .first()
    )


def plan_clean_for_buyer(buyer: Buyer, contact: Contact | None) -> dict[str, Any] | None:
    """Return a change plan or None if no clean needed."""
    company = clean_text(buyer.company_name)
    address = clean_text(buyer.address)
    reason = classify_company(company)
    zw_only = clean_text(buyer.company_name) != (buyer.company_name or "").strip() or (
        buyer.address is not None and clean_text(buyer.address) != str(buyer.address).strip()
    )

    if not reason and not zw_only:
        # Still normalize ZW / newlines if present in raw fields
        raw_co = buyer.company_name or ""
        raw_ad = buyer.address or ""
        if ZW.search(raw_co) or "\n" in raw_co or ZW.search(raw_ad) or "\n" in raw_ad:
            return {
                "buyer_id": buyer.id,
                "rule": "normalize_whitespace",
                "old_company_name": buyer.company_name,
                "new_company_name": company or None,
                "old_address": buyer.address,
                "new_address": address or None,
                "email_set": None,
                "notes": "Stripped zero-width / newline characters",
            }
        return None

    if not reason:
        return None

    new_company = company
    new_address = address
    email_set: str | None = None
    notes = ""

    if reason == "dash_placeholder":
        new_company = ""
        notes = "Cleared placeholder company"
    elif reason == "email_as_company":
        m = EMAIL_EXTRACT.search(company)
        extracted = m.group(0) if m else ""
        existing_email = clean_text(contact.email) if contact else ""
        if extracted and not existing_email:
            email_set = extracted
            notes = f"Moved email to Primary Email ({extracted})"
        else:
            notes = "Cleared email-like company"
        new_company = ""
    else:
        if not address:
            new_address = company
            notes = "Moved address-like Company Name → Address"
        else:
            notes = "Address already filled; cleared address-like Company Name"
        new_company = ""

    return {
        "buyer_id": buyer.id,
        "rule": reason,
        "old_company_name": buyer.company_name,
        "new_company_name": new_company or None,
        "old_address": buyer.address,
        "new_address": new_address or None,
        "email_set": email_set,
        "notes": notes,
    }


def clean_old_clients_company_fields(
    db: Session,
    *,
    source: str | None = "old_clients",
    exclude_source: str | None = None,
    assigned_to_user_id: int | None = None,
    unassigned_only: bool = False,
    dry_run: bool = False,
    limit: int | None = None,
) -> dict[str, Any]:
    """Apply Usman pass-1 cleaning to scoped buyers (default: old_clients)."""
    from modules.leads import _apply_lead_table_scope

    query = _apply_lead_table_scope(
        db.query(Buyer),
        source=source,
        exclude_source=exclude_source,
        assigned_to_user_id=assigned_to_user_id,
        unassigned_only=unassigned_only,
    ).order_by(Buyer.id.asc())

    buyers = query.all()
    scanned = 0
    changed = 0
    by_rule: dict[str, int] = {}
    samples: list[dict[str, Any]] = []

    for buyer in buyers:
        scanned += 1
        contact = _primary_contact(db, buyer.id)
        plan = plan_clean_for_buyer(buyer, contact)
        if not plan:
            continue
        if limit is not None and changed >= limit:
            continue

        changed += 1
        rule = str(plan["rule"])
        by_rule[rule] = by_rule.get(rule, 0) + 1
        if len(samples) < 40:
            samples.append(plan)

        if dry_run:
            continue

        buyer.company_name = plan["new_company_name"] or ""
        buyer.address = plan["new_address"]
        if plan.get("email_set"):
            if contact:
                contact.email = plan["email_set"]
            else:
                db.add(
                    Contact(
                        buyer_id=buyer.id,
                        full_name="General contact",
                        email=plan["email_set"],
                    )
                )
    if not dry_run and changed:
        db.commit()
        log_action(
            db,
            entity_type="buyer",
            entity_id=0,
            action="old_clients_company_cleaned",
            details={
                "scanned": scanned,
                "changed": changed,
                "by_rule": by_rule,
                "source": source,
            },
        )

    return {
        "scanned": scanned,
        "changed": changed,
        "by_rule": by_rule,
        "dry_run": dry_run,
        "samples": samples,
    }
