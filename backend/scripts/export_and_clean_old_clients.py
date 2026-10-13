"""Export Old clients from production DB as backup, then produce cleaned XLS.

Usage (from backend/, with Railway linked):
  railway run python scripts/export_and_clean_old_clients.py

Outputs under:
  D:\\First AI World\\Cursor Projects\\sales, social, hr Aug 2026\\old-clients-data\\
"""
from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Font
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import Session, sessionmaker

OUT_DIR = Path(r"D:\First AI World\Cursor Projects\sales, social, hr Aug 2026\old-clients-data")
LOG = Path(r"D:\First AI World\Cursor Projects\sales, social, hr Aug 2026\Master-Contacts-cleaning-log.md")

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

HEADERS = [
    "buyer_id",
    "legacy_serial_no",
    "Company Name",
    "Business Type",
    "Companies Grading",
    "Designation",
    "Contact Person",
    "Primary Mobile No.",
    "Secondary Mobile No.",
    "Primary Phone No.",
    "Secondary Phone No.",
    "Primary Email",
    "Secondary Email",
    "Country",
    "Product",
    "City",
    "Address",
    "Remarks",
    "Website",
    "Source",
]


def clean_text(value: object) -> str:
    if value is None:
        return ""
    return ZW.sub("", str(value)).replace("\n", " ").strip()


def classify_company(co: str) -> str | None:
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


def fetch_rows(db: Session) -> list[dict]:
    sql = text(
        """
        SELECT
          b.id AS buyer_id,
          b.legacy_serial_no,
          b.company_name,
          b.industry AS business_type,
          b.company_grading,
          c.designation AS designation,
          c.full_name AS contact_person,
          c.phone AS primary_mobile,
          c.secondary_mobile AS secondary_mobile,
          c.primary_phone AS primary_phone,
          c.secondary_phone AS secondary_phone,
          c.email AS primary_email,
          c.secondary_email AS secondary_email,
          b.country,
          b.product_interest AS product,
          b.city,
          b.address,
          b.remarks,
          b.website_url AS website,
          b.source
        FROM buyers b
        LEFT JOIN LATERAL (
          SELECT *
          FROM contacts c
          WHERE c.buyer_id = b.id
          ORDER BY c.id ASC
          LIMIT 1
        ) c ON TRUE
        WHERE LOWER(COALESCE(b.source, '')) = 'old_clients'
        ORDER BY COALESCE(b.legacy_serial_no, b.id) ASC
        """
    )
    result = db.execute(sql)
    cols = list(result.keys())
    return [dict(zip(cols, row)) for row in result.fetchall()]


def row_to_excel(r: dict) -> list:
    return [
        r.get("buyer_id"),
        r.get("legacy_serial_no"),
        clean_text(r.get("company_name")),
        clean_text(r.get("business_type")),
        clean_text(r.get("company_grading")),
        clean_text(r.get("designation")),
        clean_text(r.get("contact_person")),
        clean_text(r.get("primary_mobile")),
        clean_text(r.get("secondary_mobile")),
        clean_text(r.get("primary_phone")),
        clean_text(r.get("secondary_phone")),
        clean_text(r.get("primary_email")),
        clean_text(r.get("secondary_email")),
        clean_text(r.get("country")),
        clean_text(r.get("product")),
        clean_text(r.get("city")),
        clean_text(r.get("address")),
        clean_text(r.get("remarks")),
        clean_text(r.get("website")),
        clean_text(r.get("source")),
    ]


def write_workbook(path: Path, rows: list[list], review_rows: list[list] | None = None) -> None:
    wb = Workbook()
    ws = wb.active
    ws.title = "Old clients"
    ws.append(HEADERS)
    for cell in ws[1]:
        cell.font = Font(bold=True)
    for row in rows:
        ws.append(row)
    if review_rows is not None:
        rev = wb.create_sheet("Needs Review")
        rev.append(
            [
                "buyer_id",
                "legacy_serial_no",
                "Rule",
                "Old Company Name",
                "New Company Name",
                "Old Address",
                "New Address",
                "City",
                "Country",
                "Notes",
            ]
        )
        for cell in rev[1]:
            cell.font = Font(bold=True)
        for row in review_rows:
            rev.append(row)
    wb.save(path)


def clean_rows(raw_rows: list[dict]) -> tuple[list[list], list[list], int]:
    cleaned: list[list] = []
    review: list[list] = []
    changes = 0
    for r in raw_rows:
        company = clean_text(r.get("company_name"))
        address = clean_text(r.get("address"))
        city = clean_text(r.get("city"))
        country = clean_text(r.get("country"))
        email = clean_text(r.get("primary_email"))
        reason = classify_company(company)
        new_company, new_address = company, address
        notes = ""
        if reason:
            old_company, old_address = company, address
            if reason == "dash_placeholder":
                new_company = ""
                notes = "Cleared placeholder company"
            elif reason == "email_as_company":
                m = re.search(r"[\w.+-]+@[\w.-]+\.\w+", company)
                extracted = m.group(0) if m else ""
                if extracted and not email:
                    r["primary_email"] = extracted
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
            r["company_name"] = new_company
            r["address"] = new_address
            review.append(
                [
                    r.get("buyer_id"),
                    r.get("legacy_serial_no"),
                    reason,
                    old_company,
                    new_company,
                    old_address,
                    new_address,
                    city,
                    country,
                    notes,
                ]
            )
            changes += 1
        cleaned.append(row_to_excel(r))
    return cleaned, review, changes


def main() -> None:
    database_url = (os.environ.get("DATABASE_URL") or "").strip()
    if not database_url:
        raise SystemExit("DATABASE_URL is not set. Run via: railway run python scripts/...")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    backup_path = OUT_DIR / f"Old-clients-BACKUP-before-clean-{stamp}.xlsx"
    cleaned_path = OUT_DIR / f"Old-clients-CLEANED-pass1-{stamp}.xlsx"
    restore_note = OUT_DIR / "RESTORE-README.txt"

    engine = create_engine(database_url, pool_pre_ping=True)
    SessionLocal = sessionmaker(bind=engine)
    with SessionLocal() as db:
        raw = fetch_rows(db)
    print(f"Fetched old_clients rows: {len(raw)}")

    backup_rows = [row_to_excel(r) for r in raw]
    write_workbook(backup_path, backup_rows)
    print(f"BACKUP saved: {backup_path}")

    cleaned_rows, review_rows, changes = clean_rows(raw)
    write_workbook(cleaned_path, cleaned_rows, review_rows)
    print(f"CLEANED saved: {cleaned_path}")
    print(f"Needs Review changes: {changes}")

    restore_note.write_text(
        "\n".join(
            [
                "OLD CLIENTS BACKUP / RESTORE",
                "============================",
                "",
                f"Backup (exact DB snapshot before cleaning): {backup_path.name}",
                f"Cleaned pass-1 (for Usman review): {cleaned_path.name}",
                "",
                "If Usman/directors reject the cleaning:",
                "1. Do NOT delete data from Sales Agent yet.",
                "2. Keep this backup file — it is the restore source.",
                "3. Re-import can use the backup XLS into Old clients after a controlled wipe,",
                "   or we can write a DB restore script from buyer_id + columns.",
                "",
                "IMPORTANT: Cleaning so far only produced files. Live DB was NOT modified.",
                "",
            ]
        ),
        encoding="utf-8",
    )

    appendix = [
        "",
        f"## Old clients DB export + clean pass 1 ({datetime.now(timezone.utc):%Y-%m-%d %H:%M UTC})",
        "",
        f"- Source: Sales Agent production DB (`source = old_clients`)",
        f"- Rows exported: **{len(raw)}**",
        f"- Backup (restore source): `{backup_path}`",
        f"- Cleaned file: `{cleaned_path}`",
        f"- Address/email/company fixes logged: **{changes}** (see Needs Review sheet)",
        "- Live database was **not** changed — files only.",
        "",
    ]
    if LOG.exists():
        LOG.write_text(LOG.read_text(encoding="utf-8") + "\n".join(appendix), encoding="utf-8")
    else:
        LOG.write_text("# Cleaning log\n" + "\n".join(appendix), encoding="utf-8")
    print(f"Updated log: {LOG}")


if __name__ == "__main__":
    main()
