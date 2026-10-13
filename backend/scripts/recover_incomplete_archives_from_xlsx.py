"""Recover rows deleted during post-import clean — import missing rows as Incomplete Archives.

Compares backup + cleaned Master Contacts workbooks against every buyer in the DB
(phone / email / name+country keys). Rows present in Excel but absent in DB are
imported with source=incomplete_archives. Salvage-only: skips completely empty lines.

Usage (from backend/):
  python scripts/recover_incomplete_archives_from_xlsx.py \\
    --backup "c:/Users/Abc/Downloads/ALL Master Data Contacts Sheet - BACKUP 2026-08-11_1819.xlsx" \\
    --cleaned "c:/Users/Abc/Downloads/ALL Master Data Contacts Sheet - CLEANED 20260811-182040.xlsx"

Dry run (no DB writes):
  python scripts/recover_incomplete_archives_from_xlsx.py --backup path.xlsx --dry-run

Also relocate sparse old_clients already in DB:
  railway run python scripts/recover_incomplete_archives_from_xlsx.py --backup path.xlsx --relocate-sparse
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import NullPool

from db.models import Buyer, Contact
from modules.data_synthesis import (
    iter_spreadsheet_tables,
    map_sheet_rows,
    row_dedupe_keys,
    _email_key,
    _phone_digits,
)
from modules.incomplete_archives import INCOMPLETE_ARCHIVES_SOURCE
from modules.leads import cleanup_sparse_csv_leads, count_leads_table_sections, invalidate_section_counts_cache


EMAIL_WRAP_QUOTES = re.compile(r"^['\"`]+|['\"`]+$")


def clean_email_value(value: str | None) -> str:
    """Strip Excel/text apostrophes — e.g. 'info@shop.fr' → info@shop.fr (preserve valid data)."""
    raw = (value or "").strip()
    if not raw:
        return ""
    stripped = EMAIL_WRAP_QUOTES.sub("", raw).strip().strip("'\"`")
    if not stripped:
        return ""
    key = _email_key(stripped)
    return key or stripped.lower() if "@" in stripped else ""


def normalize_master_row(row: dict[str, str]) -> dict[str, str]:
    """Gentle clean: fix quoted emails, never drop salvage fields."""
    out = dict(row)
    for field in ("primary_email", "secondary_email"):
        cleaned = clean_email_value(out.get(field))
        if cleaned:
            out[field] = cleaned
        elif out.get(field):
            # Keep non-email text only if it looks like contact info elsewhere
            out[field] = (out.get(field) or "").strip()
    return out


def _parse_serial(value: str | None) -> int | None:
    raw = (value or "").strip()
    if raw.isdigit():
        return int(raw)
    return None


def master_row_has_salvage(row: dict[str, str]) -> bool:
    junk = {"", "unnamed", "unknown", "n/a", "na", "-", "---"}
    name = (row.get("company_name") or "").strip()
    if (row.get("product") or "").strip():
        return True
    if name and name.lower() not in junk:
        return True
    if (row.get("remarks") or "").strip():
        return True
    if (row.get("business_type") or "").strip():
        return True
    for field in (
        "primary_mobile",
        "secondary_mobile",
        "primary_phone",
        "secondary_phone",
        "primary_email",
        "secondary_email",
        "contact_person",
    ):
        if (row.get(field) or "").strip():
            return True
    return False


def master_row_to_import_raw(row: dict[str, str]) -> dict[str, Any]:
    row = normalize_master_row(row)
    return {
        "company_name": row.get("company_name") or "",
        "country": (row.get("country") or "").strip() or None,
        "industry": (row.get("business_type") or "").strip() or None,
        "company_grading": (row.get("company_grading") or "").strip() or None,
        "contact_name": (row.get("contact_person") or "").strip() or None,
        "email": clean_email_value(row.get("primary_email")) or None,
        "phone": (row.get("primary_mobile") or "").strip() or None,
        "primary_phone": (row.get("primary_phone") or "").strip() or None,
        "secondary_mobile": (row.get("secondary_mobile") or "").strip() or None,
        "secondary_phone": (row.get("secondary_phone") or "").strip() or None,
        "secondary_email": clean_email_value(row.get("secondary_email")) or None,
        "designation": (row.get("designation") or "").strip() or None,
        "product_interest": (row.get("product") or "").strip() or None,
        "city": (row.get("city") or "").strip() or None,
        "address": (row.get("address") or "").strip() or None,
        "remarks": (row.get("remarks") or "").strip() or None,
        "legacy_serial_no": _parse_serial(row.get("serial")),
        "source": INCOMPLETE_ARCHIVES_SOURCE,
    }


def load_master_rows(path: Path) -> list[dict[str, str]]:
    if not path.is_file():
        raise FileNotFoundError(path)
    raw_bytes = path.read_bytes()
    merged: list[dict[str, str]] = []
    for _filename, sheet_name, headers, sheet_rows in iter_spreadsheet_tables(path.name, raw_bytes):
        if "review" in sheet_name.lower():
            continue
        merged.extend(map_sheet_rows(headers, sheet_rows))
    return [normalize_master_row(r) for r in merged]


def merge_file_rows(*paths: Path) -> list[dict[str, str]]:
    """Union rows from multiple workbooks; later files override earlier on same dedupe key."""
    by_key: dict[str, dict[str, str]] = {}
    order: list[str] = []
    for path in paths:
        if not path:
            continue
        for row in load_master_rows(path):
            if not master_row_has_salvage(row):
                continue
            keys = row_dedupe_keys(row)
            if not keys:
                # Keep orphan fragments under a synthetic key
                keys = {f"row:{len(order)}:{row.get('company_name','')[:40]}"}
            primary = sorted(keys)[0]
            if primary not in by_key:
                order.append(primary)
            by_key[primary] = row
    return [by_key[k] for k in order]


def make_engine(database_url: str):
    """Single connection — prefer transaction pooler (6543) for bulk maintenance scripts."""
    url = database_url
    if "pooler.supabase.com:5432" in url:
        url = url.replace(":5432/", ":6543/")
    return create_engine(url, poolclass=NullPool, pool_pre_ping=True)


def build_db_dedupe_keys(db: Session) -> set[str]:
    keys: set[str] = set()
    buyers = db.query(Buyer).all()
    contact_by_buyer: dict[int, Contact | None] = {}
    for contact in db.query(Contact).all():
        if contact.buyer_id not in contact_by_buyer:
            contact_by_buyer[contact.buyer_id] = contact

    for buyer in buyers:
        contact = contact_by_buyer.get(buyer.id)
        row = {
            "company_name": buyer.company_name or "",
            "country": buyer.country or "",
            "primary_mobile": (contact.phone if contact else "") or (contact.primary_phone if contact else "") or "",
            "secondary_mobile": (contact.secondary_mobile if contact else "") or "",
            "primary_phone": (contact.primary_phone if contact else "") or "",
            "secondary_phone": (contact.secondary_phone if contact else "") or "",
            "primary_email": clean_email_value(contact.email if contact else "") or (contact.email if contact else "") or "",
            "secondary_email": clean_email_value(contact.secondary_email if contact else "") or "",
            "website": buyer.website_url or "",
        }
        keys.update(row_dedupe_keys(row))
    return keys


def row_matches_db(row: dict[str, str], db_keys: set[str]) -> bool:
    row_keys = row_dedupe_keys(row)
    if not row_keys:
        return False
    return bool(row_keys & db_keys)


def recover_missing_rows(
    db: Session,
    file_rows: list[dict[str, str]],
    *,
    dry_run: bool,
) -> dict[str, Any]:
    from modules.lead_discovery import import_candidates

    db_keys = build_db_dedupe_keys(db)
    missing: list[dict[str, str]] = []
    for row in file_rows:
        if row_matches_db(row, db_keys):
            continue
        missing.append(row)

    print(f"File rows (salvage):     {len(file_rows)}")
    print(f"Already in DB (matched): {len(file_rows) - len(missing)}")
    print(f"Missing to recover:       {len(missing)}")

    if dry_run or not missing:
        return {
            "file_rows": len(file_rows),
            "missing_count": len(missing),
            "created_count": 0,
            "dry_run": dry_run,
            "samples": [
                {
                    "company_name": r.get("company_name"),
                    "product": r.get("product"),
                    "phone": r.get("primary_mobile"),
                }
                for r in missing[:15]
            ],
        }

    import_payload = [master_row_to_import_raw(row) for row in missing]
    result = import_candidates(
        db,
        import_payload,
        skip_enrichment=True,
        replace_duplicates=False,
    )
    invalidate_section_counts_cache()
    return {
        "file_rows": len(file_rows),
        "missing_count": len(missing),
        "created_count": len(result.get("created") or []),
        "skipped_count": len(result.get("skipped") or []),
        "dry_run": False,
    }


def relocate_sparse_old_clients(db: Session) -> dict[str, Any]:
    result = cleanup_sparse_csv_leads(db, source="old_clients")
    invalidate_section_counts_cache()
    return result


def print_counts(db: Session) -> None:
    counts = count_leads_table_sections(db)
    print("\n=== Section counts ===")
    print(f"  Master:                {counts.get('master', 0):>6}")
    print(f"  Old clients:           {counts.get('old_clients', 0):>6}")
    print(f"  Incomplete archives:   {counts.get('incomplete_archives', 0):>6}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backup", type=Path, help="Original / backup XLSX (Usman master sheet)")
    parser.add_argument("--cleaned", type=Path, help="Cleaned upload-ready XLSX (optional, merged)")
    parser.add_argument("--db-backup", type=Path, help="Old DB export XLSX before dedupe (optional)")
    parser.add_argument("--dry-run", action="store_true", help="Report missing rows only")
    parser.add_argument(
        "--relocate-sparse",
        action="store_true",
        help="Move sparse old_clients rows to incomplete_archives (no deletes)",
    )
    args = parser.parse_args()

    if not args.backup and not args.relocate_sparse:
        parser.error("Provide --backup and/or --relocate-sparse")

    from config import settings

    database_url = (os.environ.get("DATABASE_URL") or settings.database_url or "").strip()
    if not database_url and not args.dry_run:
        raise SystemExit("DATABASE_URL required unless --dry-run with no DB relocate")

    file_rows: list[dict[str, str]] = []
    if args.backup:
        paths = [p for p in (args.backup, args.db_backup, args.cleaned) if p]
        file_rows = merge_file_rows(*paths)
        print(f"Loaded {len(file_rows)} salvage row(s) from {len(paths)} file(s)")

    if args.dry_run and file_rows:
        # Dry-run matching still needs DB if available
        if not database_url:
            print("No DATABASE_URL — listing salvage rows only:", len(file_rows))
            return
        engine = make_engine(database_url)
        SessionLocal = sessionmaker(bind=engine)
        with SessionLocal() as db:
            db.execute(text("SET statement_timeout = '300s'"))
            print_counts(db)
            result = recover_missing_rows(db, file_rows, dry_run=True)
            print("Sample missing rows:", result.get("samples"))
        return

    if not database_url:
        raise SystemExit("DATABASE_URL required for import")

    engine = make_engine(database_url)
    SessionLocal = sessionmaker(bind=engine)
    with SessionLocal() as db:
        db.execute(text("SET statement_timeout = '900s'"))
        print_counts(db)

        if args.relocate_sparse:
            print("\n=== Relocating sparse old_clients to incomplete_archives ===")
            relocated = relocate_sparse_old_clients(db)
            print(f"Relocated: {len(relocated.get('relocated') or [])}")

        if file_rows:
            print("\n=== Recovering missing Excel rows to incomplete_archives ===")
            result = recover_missing_rows(db, file_rows, dry_run=False)
            print(
                f"Created {result.get('created_count', 0)} row(s); "
                f"skipped {result.get('skipped_count', 0)}"
            )

        print_counts(db)


if __name__ == "__main__":
    main()
