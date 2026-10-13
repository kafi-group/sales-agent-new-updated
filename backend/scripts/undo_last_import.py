"""One-shot: undo last import into a list (admin emergency).

Usage (from backend/):
  python scripts/undo_last_import.py new_salt_data_sep_2026
  python scripts/undo_last_import.py new_salt_data_sep_2026 --dry-run
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))


def main() -> int:
    parser = argparse.ArgumentParser(description="Undo last spreadsheet import for a list source")
    parser.add_argument("source", help="Buyer.source / list key, e.g. new_salt_data_sep_2026")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be removed without deleting",
    )
    parser.add_argument(
        "--allow-expired",
        action="store_true",
        help="Allow undo even if older than 1 hour (emergency)",
    )
    args = parser.parse_args()

    from db.migrate import run_migrations
    from db.session import SessionLocal
    from modules.import_rollback import get_rollback_status, rollback_last_import

    run_migrations()
    db = SessionLocal()
    try:
        status = get_rollback_status(
            db, args.source, allow_expired=args.allow_expired or True
        )
        print("Status:", status)
        if not status.get("available"):
            print("Nothing to undo.")
            return 1
        if args.dry_run:
            print(
                f"DRY RUN — would remove ~{status.get('created_count')} contacts "
                f"from {status.get('source')}"
            )
            return 0
        result = rollback_last_import(
            db,
            source=args.source,
            actor_user_id=None,
            allow_expired=True,
        )
        print("Result:", result)
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
