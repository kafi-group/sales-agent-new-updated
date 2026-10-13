"""One-off analysis of Master Contacts raw XLS for cleaning rules."""
from __future__ import annotations

import re
from collections import Counter
from pathlib import Path

import openpyxl

PATH = Path(r"c:\Users\Abc\Downloads\Master Contacts file.xlsx")


def main() -> None:
    wb = openpyxl.load_workbook(PATH, read_only=True, data_only=True)
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    header = [str(c).replace("\n", " ").strip() if c is not None else "" for c in rows[0]]
    print("HEADERS:", header)
    print("TOTAL DATA ROWS:", len(rows) - 1)

    idx = {h: i for i, h in enumerate(header)}

    def col(*names: str) -> int | None:
        for n in names:
            for h, i in idx.items():
                if h.lower().replace(" ", "") == n.lower().replace(" ", ""):
                    return i
        for n in names:
            for h, i in idx.items():
                if n.lower() in h.lower():
                    return i
        return None

    i_co = col("Company Name")
    i_addr = col("Address")
    i_city = col("City")
    i_country = col("Country")
    i_email = col("Primary Email")
    i_bt = col("Busniess Type", "Business Type")
    print(
        "col idx",
        dict(
            company=i_co,
            address=i_addr,
            city=i_city,
            country=i_country,
            email=i_email,
            business=i_bt,
        ),
    )

    uk_pc = re.compile(r"\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b", re.I)
    street_words = re.compile(
        r"\b(street|st\.|road|rd\.|avenue|ave\.|lane|ln\.|drive|dr\.|"
        r"close|court|ct\.|place|pl\.|way|boulevard|blvd|centre|center|"
        r"building|floor|suite|unit|industrial|estate|park)\b",
        re.I,
    )
    company_tokens = re.compile(
        r"(?i)\b(ltd|limited|llc|inc|corp|company|co\.|plc|pvt|private|"
        r"trading|foods|distributors?|importers?|exporters?|group|enterprises?)\b"
    )
    email_domain_name = re.compile(r"(?i)^email\s*[·\-:.]")
    only_dash = re.compile(r"^[\-\—–_./\s]+$")
    looks_like_city_pc = re.compile(r"(?i)^[A-Za-z .,'\-]+,\s*[A-Z0-9]{2,}")

    flags: Counter[str] = Counter()
    samples: dict[str, list] = {k: [] for k in [
        "address_like_company",
        "uk_postcode_in_company",
        "street_in_company",
        "email_in_company",
        "dash_company",
        "empty_company",
        "company_equals_address",
        "company_equals_city",
        "numeric_company",
    ]}

    def add(flag: str, rownum: int, company: str, addr: str | None = None) -> None:
        flags[flag] += 1
        if len(samples[flag]) < 10:
            samples[flag].append((rownum, company, addr))

    for n, r in enumerate(rows[1:], start=2):
        co = str(r[i_co]).strip() if i_co is not None and r[i_co] is not None else ""
        addr = str(r[i_addr]).strip() if i_addr is not None and r[i_addr] is not None else ""
        city = str(r[i_city]).strip() if i_city is not None and r[i_city] is not None else ""

        if not co:
            add("empty_company", n, co, addr)
            continue
        if only_dash.match(co) or co in {"---", "N/A", "n/a", "NA", "null", "None", "."}:
            add("dash_company", n, co, addr)
        if email_domain_name.search(co) or "@" in co:
            add("email_in_company", n, co, addr)
        if uk_pc.search(co):
            add("uk_postcode_in_company", n, co, addr)
        if street_words.search(co) and not company_tokens.search(co):
            add("street_in_company", n, co, addr)
        if looks_like_city_pc.match(co) or (uk_pc.search(co) and "," in co):
            add("address_like_company", n, co, addr)
        if addr and co.lower() == addr.lower():
            add("company_equals_address", n, co, addr)
        if city and co.lower() == city.lower():
            add("company_equals_city", n, co, addr)
        if re.fullmatch(r"\d+", co):
            add("numeric_company", n, co, addr)

    print("\nFLAG COUNTS:")
    for k, v in flags.most_common():
        print(f"  {k}: {v}")
    print("\nSAMPLES:")
    for k, items in samples.items():
        if not items:
            continue
        print(f"\n-- {k} --")
        for item in items:
            print(" ", item)

    if i_bt is not None:
        print(
            "\nBusiness Type top:",
            Counter(str(r[i_bt]).strip() for r in rows[1:] if r[i_bt]).most_common(15),
        )
    if i_country is not None:
        print(
            "Countries top:",
            Counter(str(r[i_country]).strip() for r in rows[1:] if r[i_country]).most_common(12),
        )


if __name__ == "__main__":
    main()
