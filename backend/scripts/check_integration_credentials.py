"""Redacted checklist for Twilio / mailbox / mailer credentials.

Usage (from backend/):
  python scripts/check_integration_credentials.py
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from config import settings
from integrations.voice_client import voice_client
from modules.mailbox_accounts import hosts_enabled


def _ok(label: str, present: bool, note: str = "") -> None:
    mark = "OK  " if present else "MISS"
    suffix = f" — {note}" if note else ""
    print(f"  {mark}  {label}{suffix}")


def main() -> None:
    print("=== Integration credentials (local Settings / .env) ===")
    print("\nTwilio")
    _ok("TWILIO_ACCOUNT_SID", bool(settings.twilio_account_sid))
    _ok("TWILIO_AUTH_TOKEN", bool(settings.twilio_auth_token))
    _ok("TWILIO_PHONE_NUMBER", bool(settings.twilio_phone_number))
    _ok("TWILIO_API_KEY_SID", bool(settings.twilio_api_key_sid))
    _ok("TWILIO_API_KEY_SECRET", bool(settings.twilio_api_key_secret))
    _ok("TWILIO_TWIML_APP_SID", bool(settings.twilio_twiml_app_sid))
    _ok("TWILIO_WEBHOOK_BASE_URL", bool(settings.twilio_webhook_base_url), settings.twilio_webhook_base_url or "")
    _ok("voice configured", voice_client.is_configured)
    _ok("browser ready", voice_client.browser_ready)
    _ok("webhooks ready", voice_client.webhooks_ready)

    print("\nMailbox hosts")
    _ok("MAILBOX_ENABLED", hosts_enabled())
    _ok("IMAP/SMTP hosts", bool(settings.mailbox_imap_host and settings.mailbox_smtp_host))
    _ok("MAILBOX_SSL_HOSTNAME", bool(settings.mailbox_ssl_hostname), settings.mailbox_ssl_hostname or "")
    _ok("MAILBOX_CREDENTIALS_KEY", bool(settings.mailbox_credentials_key))

    print("\nPer-user mailbox env slots (passwords)")
    for label, email, password in (
        ("admin", settings.mailbox_admin_email, settings.mailbox_admin_password),
        ("asim", settings.mailbox_asim_email, settings.mailbox_asim_password),
        ("usman", settings.mailbox_usman_email, settings.mailbox_usman_password),
        ("sadia", settings.mailbox_sadia_email, settings.mailbox_sadia_password),
    ):
        _ok(
            f"{label} email",
            bool(email),
            email or "",
        )
        _ok(f"{label} password", bool(password), "set in .env or Users UI")

    print("\nMailer")
    _ok("MAILER_PUBLIC_URL", bool(settings.mailer_public_url), settings.mailer_public_url or "")
    _ok("MAILER_HANDOFF_SECRET", bool(settings.mailer_handoff_secret))
    mailer_ok = bool(settings.mailer_public_url and settings.mailer_handoff_secret)
    _ok("mailer configured", mailer_ok)

    print("\nHotmail/Outlook OAuth (optional legacy)")
    oauth = bool(settings.mailbox_client_id and settings.mailbox_refresh_token)
    _ok("MAILBOX_CLIENT_ID + REFRESH_TOKEN", oauth, "skip if using cPanel passwords")

    missing_critical = []
    if not voice_client.is_configured:
        missing_critical.append("Twilio Console secrets (SID/token/API key/TwiML app/phone)")
    if not settings.mailbox_admin_password and not settings.mailbox_asim_password:
        missing_critical.append("Mailbox passwords (Users page — re-enter after new CREDENTIALS_KEY)")
    if not mailer_ok:
        missing_critical.append("MAILER_PUBLIC_URL + MAILER_HANDOFF_SECRET")

    print()
    if missing_critical:
        print("Still needed before full smoke tests:")
        for item in missing_critical:
            print(f"  - {item}")
        print(
            "\nAlso: Vercel mailer-pied must use the SAME MAILER_HANDOFF_SECRET "
            "as Railway (or deploy a new mailer and update MAILER_PUBLIC_URL)."
        )
        sys.exit(1)
    print("Local critical flags look set. Re-check /api/health on Railway after deploy.")


if __name__ == "__main__":
    main()
