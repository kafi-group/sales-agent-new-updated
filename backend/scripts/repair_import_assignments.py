"""Repair: unassign auto-imported leads, then dedupe Leads + Old clients."""
import time

from db.models import Buyer
from db.session import SessionLocal
from modules.leads import dedupe_leads_table, unassign_spreadsheet_imports

db = SessionLocal()
try:
    before_asn = db.query(Buyer).filter(Buyer.assigned_to_user_id.isnot(None)).count()
    before_un = db.query(Buyer).filter(Buyer.assigned_to_user_id.is_(None)).count()
    print("before assigned/unassigned:", before_asn, before_un, flush=True)

    t0 = time.time()
    result = unassign_spreadsheet_imports(db)
    print("unassign:", result, "in", round(time.time() - t0, 1), "s", flush=True)

    asn = db.query(Buyer).filter(Buyer.assigned_to_user_id.isnot(None)).count()
    un = db.query(Buyer).filter(Buyer.assigned_to_user_id.is_(None)).count()
    print("after assigned/unassigned:", asn, un, flush=True)

    t0 = time.time()
    d1 = dedupe_leads_table(db, exclude_source="old_clients")
    print(
        "dedupe leads:",
        d1["removed_count"],
        "removed,",
        d1["kept_count"],
        "kept in",
        round(time.time() - t0, 1),
        "s",
        flush=True,
    )

    t0 = time.time()
    d2 = dedupe_leads_table(db, source="old_clients")
    print(
        "dedupe old_clients:",
        d2["removed_count"],
        "removed in",
        round(time.time() - t0, 1),
        "s",
        flush=True,
    )
finally:
    db.close()
