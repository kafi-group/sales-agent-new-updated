"""Post-import cleaning pipeline for Old clients (and scoped table sections).

Runs after spreadsheet upload: fix emails, company fields, names, remove junk,
then dedupe — without touching other Master Table sections.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from db.models import Buyer, Contact
from modules.audit import log_action
from modules.field_clean import normalize_email
from modules.incomplete_archives import (
    is_incomplete_archives_source,
    primary_contact,
    relocate_buyer_to_incomplete_archives,
    should_route_to_incomplete_archives,
)
from modules.leads import (
    _apply_lead_table_scope,
    cleanup_sparse_csv_leads,
    dedupe_leads_table,
)


def normalize_countries(
    db: Session,
    *,
    source: str | None = "old_clients",
    exclude_source: str | None = None,
    assigned_to_user_id: int | None = None,
    unassigned_only: bool = False,
) -> dict[str, Any]:
    """Canonicalize country spellings (e.g. Srilanka → Sri Lanka) for filter matching."""
    from modules.countries import resolve_country_name

    buyers = _apply_lead_table_scope(
        db.query(Buyer),
        source=source,
        exclude_source=exclude_source,
        assigned_to_user_id=assigned_to_user_id,
        unassigned_only=unassigned_only,
    ).all()
    changed = 0
    samples: list[dict[str, Any]] = []
    for buyer in buyers:
        before = (buyer.country or "").strip()
        if not before:
            continue
        after = resolve_country_name(before) or before
        if after != before:
            buyer.country = after
            changed += 1
            if len(samples) < 20:
                samples.append(
                    {
                        "buyer_id": buyer.id,
                        "company_name": buyer.company_name,
                        "before": before,
                        "after": after,
                    }
                )
    if changed:
        db.commit()
    return {"scanned": len(buyers), "changed": changed, "samples": samples}


def backfill_country_from_phones(
    db: Session,
    *,
    source: str | None = "old_clients",
    exclude_source: str | None = None,
    assigned_to_user_id: int | None = None,
    unassigned_only: bool = False,
) -> dict[str, Any]:
    """Set country from international phone prefix when country is blank."""
    from modules.countries import country_from_phone

    buyers = _apply_lead_table_scope(
        db.query(Buyer),
        source=source,
        exclude_source=exclude_source,
        assigned_to_user_id=assigned_to_user_id,
        unassigned_only=unassigned_only,
    ).all()
    changed = 0
    for buyer in buyers:
        if (buyer.country or "").strip():
            continue
        contact = primary_contact(db, buyer.id)
        if not contact:
            continue
        for phone in (
            contact.phone,
            contact.primary_phone,
            contact.secondary_phone,
            contact.secondary_mobile,
        ):
            inferred = country_from_phone(phone)
            if inferred:
                buyer.country = inferred
                changed += 1
                break
    if changed:
        db.commit()
    return {"scanned": len(buyers), "changed": changed}


def _normalize_email(value: str) -> tuple[str, bool]:
    return normalize_email(value)


def clean_contact_emails(
    db: Session,
    *,
    source: str | None = "old_clients",
    exclude_source: str | None = None,
    assigned_to_user_id: int | None = None,
    unassigned_only: bool = False,
) -> dict[str, Any]:
    """Strip Excel apostrophes and normalize Primary/Secondary Email on contacts."""
    buyers = _apply_lead_table_scope(
        db.query(Buyer),
        source=source,
        exclude_source=exclude_source,
        assigned_to_user_id=assigned_to_user_id,
        unassigned_only=unassigned_only,
    ).all()
    scanned = 0
    changed = 0
    samples: list[dict[str, Any]] = []

    for buyer in buyers:
        contacts = (
            db.query(Contact)
            .filter(Contact.buyer_id == buyer.id)
            .order_by(Contact.id.asc())
            .all()
        )
        if not contacts:
            continue
        contact = contacts[0]
        scanned += 1
        row_changed = False
        for field in ("email", "secondary_email"):
            before = getattr(contact, field) or ""
            after, fixed = _normalize_email(before)
            if fixed:
                setattr(contact, field, after or None)
                row_changed = True
                if len(samples) < 20:
                    samples.append(
                        {
                            "buyer_id": buyer.id,
                            "field": field,
                            "before": before,
                            "after": after,
                        }
                    )
        if row_changed:
            changed += 1

    if changed:
        db.commit()
    return {"scanned": scanned, "changed": changed, "samples": samples}


def remove_junk_old_client_rows(
    db: Session,
    *,
    source: str | None = "old_clients",
    exclude_source: str | None = None,
    assigned_to_user_id: int | None = None,
    unassigned_only: bool = False,
) -> dict[str, Any]:
    """Move fragmentary rows to Incomplete Data from Archives — never delete salvage rows."""
    buyers = _apply_lead_table_scope(
        db.query(Buyer),
        source=source,
        exclude_source=exclude_source,
        assigned_to_user_id=assigned_to_user_id,
        unassigned_only=unassigned_only,
    ).all()
    relocated: list[dict[str, Any]] = []

    for buyer in buyers:
        if is_incomplete_archives_source(buyer.source):
            continue
        contact = primary_contact(db, buyer.id)
        if not should_route_to_incomplete_archives(buyer, contact):
            continue
        if relocate_buyer_to_incomplete_archives(
            db, buyer.id, reason="fragmentary_import", commit=False
        ):
            relocated.append({"id": buyer.id, "company_name": buyer.company_name})

    if relocated:
        db.commit()
    return {"removed_count": 0, "relocated_count": len(relocated), "relocated": relocated[:40]}


def clean_contacts_for_buyer_ids(db: Session, buyer_ids: list[int]) -> dict[str, Any]:
    """Normalize emails on specific imported rows (fast post-upload pass)."""
    if not buyer_ids:
        return {"scanned": 0, "changed": 0, "samples": []}
    scanned = 0
    changed = 0
    samples: list[dict[str, Any]] = []
    for buyer_id in buyer_ids:
        contacts = (
            db.query(Contact)
            .filter(Contact.buyer_id == buyer_id)
            .order_by(Contact.id.asc())
            .all()
        )
        if not contacts:
            continue
        contact = contacts[0]
        scanned += 1
        row_changed = False
        for field in ("email", "secondary_email"):
            before = getattr(contact, field) or ""
            after, fixed = normalize_email(before)
            if fixed:
                setattr(contact, field, after or None)
                row_changed = True
                if len(samples) < 20:
                    samples.append(
                        {"buyer_id": buyer_id, "field": field, "before": before, "after": after}
                    )
        if row_changed:
            changed += 1
    if changed:
        db.commit()
    return {"scanned": scanned, "changed": changed, "samples": samples}


def normalize_countries_for_buyer_ids(db: Session, buyer_ids: list[int]) -> dict[str, Any]:
    """Fix country spellings on freshly imported rows only."""
    from modules.countries import resolve_country_name

    if not buyer_ids:
        return {"changed": 0}
    changed = 0
    for buyer_id in buyer_ids:
        buyer = db.get(Buyer, buyer_id)
        if not buyer or not (buyer.country or "").strip():
            continue
        before = buyer.country.strip()
        after = resolve_country_name(before) or before
        if after != before:
            buyer.country = after
            changed += 1
    if changed:
        db.commit()
    return {"changed": changed}


def run_post_import_clean(
    db: Session,
    *,
    source: str | None = "old_clients",
    exclude_source: str | None = None,
    assigned_to_user_id: int | None = None,
    unassigned_only: bool = False,
) -> dict[str, Any]:
    """Full post-upload clean for Old clients — safe for existing rows in same section."""
    from modules.buyer_name_repair import repair_location_company_names  # noqa: F401 — optional manual step
    from modules.old_clients_clean import clean_old_clients_company_fields

    scope = {
        "source": source,
        "exclude_source": exclude_source,
        "assigned_to_user_id": assigned_to_user_id,
        "unassigned_only": unassigned_only,
    }

    emails = clean_contact_emails(db, **scope)
    countries = normalize_countries(db, **scope)
    company = clean_old_clients_company_fields(db, **scope)
    # Skip repair_location here — it can web-lookup per row and takes hours on 8k+ Old clients.
    # Use Master Table → Fix names for location-as-company rows in smaller batches.
    names: dict[str, Any] = {
        "skipped": True,
        "reason": "bulk_post_import_skip_web_name_repair",
        "repaired_with_name": 0,
        "relocated_name_empty": 0,
    }
    junk = remove_junk_old_client_rows(db, **scope)
    sparse = cleanup_sparse_csv_leads(db, **scope)
    dedupe = dedupe_leads_table(db, **scope)

    names_fixed = int(names.get("repaired_with_name") or 0) + int(
        names.get("relocated_name_empty") or 0
    )

    summary = {
        "emails_fixed": emails.get("changed", 0),
        "countries_fixed": countries.get("changed", 0),
        "company_fields_fixed": company.get("changed", 0),
        "names_fixed": names_fixed,
        "junk_rows_removed": junk.get("relocated_count", junk.get("removed_count", 0)),
        "empty_rows_removed": sparse.get("relocated_count", sparse.get("removed_count", 0)),
        "duplicates_removed": dedupe.get("removed_count", 0),
        "duplicates_relocated_incomplete": dedupe.get("relocated_count", 0),
    }

    log_action(
        db,
        entity_type="buyer",
        entity_id=0,
        action="old_clients_post_import_cleaned",
        details={"source": source, **summary},
    )

    return {
        "emails": emails,
        "countries": countries,
        "company_fields": company,
        "names": names,
        "junk_removed": junk,
        "sparse_removed": sparse,
        "dedupe": dedupe,
        "summary": summary,
    }
