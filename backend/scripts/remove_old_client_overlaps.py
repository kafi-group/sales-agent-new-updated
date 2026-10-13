"""Remove Discover / Leads-table rows that match Old clients by name or domain.

Old clients are never deleted. Run from backend/:

    python scripts/remove_old_client_overlaps.py
"""
import time

from db.models import Buyer
from db.session import SessionLocal
from modules.leads import remove_leads_overlapping_old_clients
from sqlalchemy import func as sa_func

db = SessionLocal()
try:
    old_n = (
        db.query(sa_func.count(Buyer.id))
        .filter(sa_func.lower(Buyer.source) == "old_clients")
        .scalar()
        or 0
    )
    leads_n = (
        db.query(sa_func.count(Buyer.id))
        .filter(sa_func.lower(sa_func.coalesce(Buyer.source, "")) != "old_clients")
        .scalar()
        or 0
    )
    print(f"before: {leads_n} discover/leads rows, {old_n} old clients", flush=True)

    t0 = time.time()
    result = remove_leads_overlapping_old_clients(db)
    print(
        "removed:",
        result["removed_count"],
        "| kept:",
        result["kept_count"],
        "| old clients:",
        result["old_clients_count"],
        "| in",
        round(time.time() - t0, 1),
        "s",
        flush=True,
    )
    for group in (result.get("groups") or [])[:25]:
        print(f"  - {group.get('company_name')}", flush=True)
    if len(result.get("groups") or []) > 25:
        print(f"  … and {len(result['groups']) - 25} more", flush=True)
finally:
    db.close()
