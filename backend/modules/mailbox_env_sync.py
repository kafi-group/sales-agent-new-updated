"""Sync per-user mailbox credentials from backend/.env onto app_users."""

from __future__ import annotations

import logging

from sqlalchemy.orm import Session

from config import settings
from db.models import AppUser
from modules.mailbox_accounts import public_sender_display_name, set_user_mailbox

logger = logging.getLogger(__name__)

# app username -> (email_attr, password_attr, display_attr)
_ENV_USER_MAILBOXES: tuple[tuple[str, str, str, str], ...] = (
    ("admin", "mailbox_admin_email", "mailbox_admin_password", "mailbox_admin_display_name"),
    ("khalid", "mailbox_admin_email", "mailbox_admin_password", "mailbox_admin_display_name"),
    ("asim", "mailbox_asim_email", "mailbox_asim_password", "mailbox_asim_display_name"),
    ("usmankhan", "mailbox_usman_email", "mailbox_usman_password", "mailbox_usman_display_name"),
    ("sadia", "mailbox_sadia_email", "mailbox_sadia_password", "mailbox_sadia_display_name"),
    ("finance", "mailbox_finance_email", "mailbox_finance_password", "mailbox_finance_display_name"),
)


def sync_mailboxes_from_env(db: Session) -> list[str]:
    """Apply MAILBOX_*_* per-user mailbox vars from .env onto app_users.

    Returns usernames that were updated.
    """
    updated: list[str] = []
    for username, email_attr, password_attr, display_attr in _ENV_USER_MAILBOXES:
        email = (getattr(settings, email_attr, None) or "").strip()
        # Trim — leading/trailing spaces or CR from .env cause SMTP 535.
        password = (getattr(settings, password_attr, None) or "").strip()
        display = (getattr(settings, display_attr, None) or "").strip() or None
        if not email or not password:
            continue
        user = db.query(AppUser).filter(AppUser.username == username).first()
        if not user:
            logger.warning("Mailbox env set for %s but app user not found", username)
            continue
        set_user_mailbox(
            user,
            mailbox_email=email,
            mailbox_password=password,
            mailbox_display_name=public_sender_display_name(email, display or user.full_name),
            mailbox_enabled=True,
        )
        updated.append(username)
    if updated:
        db.commit()
        logger.info("Synced mailbox credentials from .env for: %s", ", ".join(updated))
    return updated
