"""Refined scan: company cells that look like street/city/postcode, not company names."""
from __future__ import annotations

import re
from collections import Counter
from pathlib import Path

import openpyxl

PATH = Path(r"c:\Users\Abc\Downloads\Master Contacts file.xlsx")
OUT = Path(r"D:\First AI World\Cursor Projects\sales, social, hr Aug 2026") / "Master-Contacts-cleaning-log.md"

UK_PC = re.compile(r"\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b", re.I)
# City + postcode style: "London, W1K 4QY" / "Middlesex EN1 1DZ"
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
EMAILISH = re.compile(r"(?i)^(email\s*[·\-:.]?\s*)?.+@.+\..+")
EMAIL_LABEL = re.compile(r"(?i)^email\s*[·\-:]")
ONLY_DASH = re.compile(r"^[\-\—–_./\s]+$")
COMPANYISH = re.compile(
    r"(?i)\b(ltd|limited|llc|inc|corp|company|co\.|plc|pvt|gmbh|sarl|bv|oy|ab|"
    r"trading|foods|distributors?|importers?|exporters?|group|enterprises?|mill|mills)\b"
)


def looks_like_address_company(co: str) -> str | None:
    s = co.strip()
    if not s:
        return "empty"
    if ONLY_DASH.match(s) or s in {"---", "N/A", "n/a", "NA", ".", "null", "None"}:
        return "dash_placeholder"
    if EMAIL_LABEL.search(s) or EMAILISH.search(s) or ("@" in s and "." in s):
        return "email_as_company"
    if UK_PC.search(s) and not COMPANYISH.search(s):
        return "uk_postcode_as_company"
    if CITY_PC.match(s) and not COMPANYISH.search(s):
        return "city_postcode_as_company"
    if STREET_START.search(s) and not COMPANYISH.search(s):
        return "street_address_as_company"
    if BARE_LOCATION.match(s) and not COMPANYISH.search(s):
        return "location_as_company"
    # Pure postcode only
    if re.fullmatch(r"[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}", s, re.I):
        return "postcode_only"
    return None


def main() -> None:
    wb = openpyxl.load_workbook(PATH, read_only=True, data_only=True)
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    header = [str(c).replace("\n", " ").strip() if c is not None else "" for c in rows[0]]
    idx = {h: i for i, h in enumerate(header)}
    i_co, i_addr, i_city, i_country = idx["Company Name"], idx["Address"], idx["City"], idx["Country"]

    flags: Counter[str] = Counter()
    samples: dict[str, list] = {}
    hits: list[dict] = []

    for n, r in enumerate(rows[1:], start=2):
        co = str(r[i_co]).strip() if r[i_co] is not None else ""
        addr = str(r[i_addr]).strip() if r[i_addr] is not None else ""
        city = str(r[i_city]).strip() if r[i_city] is not None else ""
        country = str(r[i_country]).strip() if r[i_country] is not None else ""
        reason = looks_like_address_company(co)
        if not reason:
            continue
        flags[reason] += 1
        samples.setdefault(reason, [])
        if len(samples[reason]) < 12:
            samples[reason].append((n, co, addr, city, country))
        hits.append(
            {
                "row": n,
                "reason": reason,
                "company": co,
                "address": addr,
                "city": city,
                "country": country,
            }
        )

    print("TOTAL ROWS", len(rows) - 1)
    print("PROBLEM COMPANY CELLS", len(hits))
    print("BY REASON:", dict(flags))
    for reason, items in samples.items():
        print(f"\n== {reason} ({flags[reason]}) ==")
        for it in items:
            print(" ", it)

    # Write first process-log draft
    lines = [
        "# Master Contacts — Data Cleaning Process Log",
        "",
        f"**Source file:** `{PATH.name}`  ",
        f"**Rows:** {len(rows) - 1}  ",
        f"**Columns:** {', '.join(header)}",
        "",
        "## Known issues (from directors meeting + scan)",
        "",
        "- Company Name sometimes contains **street / city / UK postcode** instead of a company.",
        "- Address column may be empty while the \"company\" cell holds the address.",
        "- Some company cells are blank, dashes, or email-like labels.",
        "- Header typo: `Busniess Type` → should become `Business Type` on export.",
        "",
        "## Scan results (pass 1 — detection only)",
        "",
        f"| Reason | Count |",
        f"|--------|------:|",
    ]
    for k, v in flags.most_common():
        lines.append(f"| {k} | {v} |")
    lines.extend(
        [
            "",
            f"**Total flagged company cells:** {len(hits)}",
            "",
            "## Cleaning rules (draft — will refine with Usman)",
            "",
            "1. If Company Name matches address patterns (UK postcode, city+postcode, street-leading, location-only) **and** Address is empty → move text to Address; set Company Name blank (or mark `NEEDS_COMPANY`).",
            "2. If Company Name matches address patterns **and** Address already filled → keep Address; clear Company Name (or mark `NEEDS_COMPANY`) so we don't lose the address duplicate.",
            "3. If Company Name is email-label / email → move to Primary Email if that column empty; clear company.",
            "4. Dash/placeholder company → blank.",
            "5. Normalize header: Busniess Type → Business Type; collapse newlines in phone headers.",
            "6. Strip zero-width / odd unicode from address cells.",
            "7. Do **not** invent company names — leave blank / flag for Usman review.",
            "",
            "## Next steps",
            "",
            "1. Produce cleaned XLS + `NEEDS_REVIEW` sheet of flagged rows.",
            "2. Send to Usman for check.",
            "3. After sign-off, codify as Data Cleaning module (upload → clean → export).",
            "",
            "## Sample flagged rows",
            "",
        ]
    )
    for reason, items in samples.items():
        lines.append(f"### {reason}")
        for row, co, addr, city, country in items[:8]:
            lines.append(f"- Row {row}: company=`{co}` | address=`{addr}` | city=`{city}` | country=`{country}`")
        lines.append("")

    OUT.write_text("\n".join(lines), encoding="utf-8")
    print("\nWrote log:", OUT)


if __name__ == "__main__":
    main()
