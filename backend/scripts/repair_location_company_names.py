"""Repair buyers where company_name is actually a city/country/address.

Usage:
  cd backend
  python scripts/repair_location_company_names.py --dry-run
  python scripts/repair_location_company_names.py --apply --source old_clients
  python scripts/repair_location_company_names.py --apply --all-clients
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from db.session import SessionLocal
from modules.buyer_name_repair import repair_location_company_names


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Write changes (default is dry-run)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview only (default)",
    )
    parser.add_argument(
        "--source",
        default="old_clients",
        help="Buyer source filter (default: old_clients). Use '' with --all-clients.",
    )
    parser.add_argument(
        "--all-clients",
        action="store_true",
        help="Scan all buyers (no source filter)",
    )
    parser.add_argument("--limit", type=int, default=None, help="Max repairs to apply")
    parser.add_argument(
        "--sleep",
        type=float,
        default=0.15,
        help="Seconds between web lookups when applying",
    )
    args = parser.parse_args()
    dry_run = not args.apply
    if args.dry_run:
        dry_run = True

    source = None if args.all_clients else (args.source or "old_clients")

    db = SessionLocal()
    try:
        result = repair_location_company_names(
            db,
            source=source,
            dry_run=dry_run,
            limit=args.limit,
            sleep_s=0.0 if dry_run else args.sleep,
        )
        print(json.dumps(result, indent=2, default=str))
    finally:
        db.close()


if __name__ == "__main__":
    main()
