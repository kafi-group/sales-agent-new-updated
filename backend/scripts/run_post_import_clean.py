"""Run post-import clean on production Old clients (Railway).

  cd backend
  railway run python scripts/run_post_import_clean.py

Optional dry breakdown first:
  railway run python scripts/run_post_import_clean.py --counts-only
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import create_engine, func, text
from sqlalchemy.orm import sessionmaker

from db.models import Buyer
from modules.leads import count_leads_table_sections, invalidate_section_counts_cache
from modules.post_import_old_clients import run_post_import_clean


def print_counts(db) -> None:
    counts = count_leads_table_sections(db)
    by_assignee = counts.get("by_assignee") or {}
    assignee_total = sum(int(v) for v in by_assignee.values())
    print("\n=== Section counts (admin view) ===")
    print(f"  Master table (ALL leads):     {counts.get('master', 0):>6}")
    print(f"  New search lead (unassigned): {counts.get('all', 0):>6}")
    print(f"  Old clients (unassigned pool):{counts.get('old_clients', 0):>6}")
    print(f"  Follow up clients:            {counts.get('interested_clients', 0):>6}")
    print(f"  Interested Clients:           {counts.get('sales_interested_clients', 0):>6}")
    print(f"  Not interested:               {counts.get('not_interested_clients', 0):>6}")
    print(f"  Did not receive call:         {counts.get('not_received_call_clients', 0):>6}")
    print(f"  Hyperstore targeted:          {counts.get('hyperstore_targeted', 0):>6}")
    print(f"  Targeted Distributors:        {counts.get('targeted_distributor', 0):>6}")
    print(f"  Targeted Client:              {counts.get('targeted_client', 0):>6}")
    print(f"  Incomplete archives:          {counts.get('incomplete_archives', 0):>6}")
    print(f"  Leads Sent To (all users):    {assignee_total:>6}")
    if by_assignee:
        for uid, n in sorted(by_assignee.items(), key=lambda x: -x[1]):
            print(f"    user {uid}: {n}")

    total_old = (
        db.query(func.count(Buyer.id))
        .filter(func.lower(func.coalesce(Buyer.source, "")) == "old_clients")
        .scalar()
        or 0
    )
    total_all = db.query(func.count(Buyer.id)).scalar() or 0
    assigned_old = (
        db.query(func.count(Buyer.id))
        .filter(
            func.lower(func.coalesce(Buyer.source, "")) == "old_clients",
            Buyer.assigned_to_user_id.isnot(None),
        )
        .scalar()
        or 0
    )
    print("\n=== DB totals ===")
    print(f"  All buyers in DB:             {total_all:>6}")
    print(f"  All old_clients source:       {total_old:>6}")
    print(f"  Assigned old_clients:         {assigned_old:>6}")
    print(
        "\nNote: Master table = every lead. Old clients badge = unassigned pool only.\n"
        "Assigned rows appear under Leads Sent To {user}. Outcome buckets are separate."
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--counts-only", action="store_true")
    args = parser.parse_args()

    database_url = (os.environ.get("DATABASE_URL") or "").strip()
    if not database_url:
        raise SystemExit("DATABASE_URL not set — run via: railway run python scripts/run_post_import_clean.py")

    engine = create_engine(database_url, pool_pre_ping=True)
    SessionLocal = sessionmaker(bind=engine)
    with SessionLocal() as db:
        # Supabase session pooler default timeout is tight for bulk deletes.
        db.execute(text("SET statement_timeout = '600s'"))
        print_counts(db)
        if args.counts_only:
            return

        print("\n=== Running post-import clean on old_clients ===")
        result = run_post_import_clean(db, source="old_clients")
        invalidate_section_counts_cache()
        s = result["summary"]
        print(
            f"Done — emails {s['emails_fixed']}, company {s['company_fields_fixed']}, "
            f"names {s['names_fixed']}, junk {s['junk_rows_removed']}, "
            f"empty {s['empty_rows_removed']}, duplicates {s['duplicates_removed']}"
        )
        print_counts(db)


if __name__ == "__main__":
    main()
