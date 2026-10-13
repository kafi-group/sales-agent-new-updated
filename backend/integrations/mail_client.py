"""Outbound email — Resend HTTPS (Railway Hobby), cPanel SMTP AUTH, or Graph."""

from __future__ import annotations

from typing import Any

from db.models import AppUser
from integrations.outlook_client import outlook_client
from integrations.resend_client import resend_configured
from modules.mailbox_accounts import (
    hosts_enabled,
    resolve_user_mailbox,
    use_mailbox,
    user_mailbox_configured,
)


class MailClient:
    def is_configured_for(self, user: AppUser | None = None) -> bool:
        if user is not None:
            if not hosts_enabled():
                return False
            if resend_configured():
                account = resolve_user_mailbox(user)
                return bool(account and account.email)
            return user_mailbox_configured(user)
        return outlook_client.is_configured

    @property
    def is_configured(self) -> bool:
        # Hosts enabled for IMAP, or Resend for Hobby outbound.
        return hosts_enabled() or resend_configured()

    def mailbox_email(self, user: AppUser | None = None) -> str | None:
        if user is not None:
            account = resolve_user_mailbox(user)
            return account.email if account else None
        from config import settings

        return settings.mailbox_email if outlook_client.is_configured else None

    def send_approved(
        self,
        *,
        to: str,
        subject: str,
        body: str,
        attachments: list[dict] | None = None,
        interaction_id: int | None = None,
        send_mode: str = "individual",
        mailbox_user: AppUser | None = None,
        cc: str | None = None,
    ) -> dict[str, Any]:
        account = resolve_user_mailbox(mailbox_user) if mailbox_user is not None else None
        if mailbox_user is not None and account is None:
            return {
                "status": "not_configured",
                "message": (
                    "No mailbox configured for your account. "
                    "Ask an admin to set your company email on the Users page."
                ),
            }
        # user_id is required so the Vercel mailer JWT can resolve username
        # (same pattern as inbox.py). Without it, send_via_mailer fails with
        # "missing username or mailbox email".
        with use_mailbox(
            account,
            user_id=mailbox_user.id if mailbox_user is not None else None,
        ):
            if not outlook_client.is_configured:
                return {
                    "status": "not_configured",
                    "message": (
                        "Mailbox is not enabled. Set MAILBOX_ENABLED=true and "
                        "configure this user's mailbox credentials."
                    ),
                }
            return outlook_client.send_approved(
                to=to,
                subject=subject,
                body=body,
                attachments=attachments,
                interaction_id=interaction_id,
                send_mode=send_mode,
                cc=cc,
            )


def settings_mailbox_fallback() -> bool:
    from config import settings

    return bool(settings.mailbox_email and settings.mailbox_password)


mail_client = MailClient()
