"""Apply MAILBOX_ADMIN_* / MAILBOX_ASIM_* / MAILBOX_USMAN_* from .env onto app_users.

Usage (from backend/):
  python scripts/set_user_mailboxes.py

Passwords stay in backend/.env only — never hardcode them here.
"""

from __future__ import annotations

import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from db.session import SessionLocal
from modules.mailbox_env_sync import sync_mailboxes_from_env


def main() -> None:
    db = SessionLocal()
    try:
        synced = sync_mailboxes_from_env(db)
        if not synced:
            print(
                "No mailbox env vars found. Set MAILBOX_ADMIN_EMAIL / "
                "MAILBOX_ASIM_EMAIL / MAILBOX_USMAN_EMAIL (+ passwords) in backend/.env"
            )
            return
        for username in synced:
            print(f"OK  {username}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
