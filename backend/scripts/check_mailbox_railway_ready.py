"""Print MAILBOX_* keys present in backend/.env (values redacted) for Railway setup.

Usage:
  cd backend
  python scripts/check_mailbox_railway_ready.py
  python scripts/check_mailbox_railway_ready.py --test-smtp   # optional live SMTP login test
"""

from __future__ import annotations

import argparse
import socket
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from config import settings
from modules.mailbox_accounts import hosts_enabled

REQUIRED_HOST_KEYS = (
    "MAILBOX_ENABLED",
    "MAILBOX_IMAP_HOST",
    "MAILBOX_IMAP_PORT",
    "MAILBOX_SMTP_HOST",
    "MAILBOX_SMTP_PORT",
    "MAILBOX_SSL_HOSTNAME",
    "MAILBOX_CREDENTIALS_KEY",
)

PER_USER_KEYS = (
    "MAILBOX_ADMIN_EMAIL",
    "MAILBOX_ADMIN_PASSWORD",
    "MAILBOX_ADMIN_DISPLAY_NAME",
    "MAILBOX_ASIM_EMAIL",
    "MAILBOX_ASIM_PASSWORD",
    "MAILBOX_ASIM_DISPLAY_NAME",
    "MAILBOX_USMAN_EMAIL",
    "MAILBOX_USMAN_PASSWORD",
    "MAILBOX_USMAN_DISPLAY_NAME",
    "MAILBOX_SADIA_EMAIL",
    "MAILBOX_SADIA_PASSWORD",
    "MAILBOX_SADIA_DISPLAY_NAME",
    "MAILBOX_FINANCE_EMAIL",
    "MAILBOX_FINANCE_PASSWORD",
    "MAILBOX_FINANCE_DISPLAY_NAME",
)


def _present(attr: str) -> bool:
    return bool((getattr(settings, attr, None) or ""))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--test-smtp",
        action="store_true",
        help="Attempt SMTP AUTH with MAILBOX_ADMIN_* credentials",
    )
    args = parser.parse_args()

    print("=== Local mailbox config (for Railway Variables) ===")
    print(f"hosts_enabled (MAILBOX_ENABLED): {hosts_enabled()}")
    print(f"IMAP: {settings.mailbox_imap_host}:{settings.mailbox_imap_port}")
    print(f"SMTP: {settings.mailbox_smtp_host}:{settings.mailbox_smtp_port}")
    print(f"SSL hostname: {settings.mailbox_ssl_hostname}")
    print(f"PUBLIC_API_BASE_URL: {settings.public_api_base_url or '(unset)'}")
    print()
    print("Copy these variable NAMES into Railway > Backend service > Variables")
    print("(paste values from your local backend/.env - do not commit them):")
    print()
    for key in REQUIRED_HOST_KEYS + PER_USER_KEYS + ("PUBLIC_API_BASE_URL",):
        attr = key.lower()
        ok = _present(attr) if key != "MAILBOX_ENABLED" else settings.mailbox_enabled
        print(f"  {'OK ' if ok else 'MISS'}  {key}")

    print()
    host = settings.mailbox_smtp_host
    port = settings.mailbox_smtp_port
    try:
        with socket.create_connection((host, port), timeout=8):
            print(f"TCP {host}:{port} reachable from this machine.")
    except OSError as exc:
        print(f"TCP {host}:{port} NOT reachable: {exc}")

    if not args.test_smtp:
        print("\nRun with --test-smtp to verify SMTP login for MAILBOX_ADMIN_*.")
        return

    email = (settings.mailbox_admin_email or "").strip()
    password = settings.mailbox_admin_password or ""
    if not email or not password:
        print("Cannot test SMTP: MAILBOX_ADMIN_EMAIL/PASSWORD missing.")
        sys.exit(1)

    import smtplib
    import ssl

    print(f"\nTesting SMTP AUTH as {email} ...")
    ctx = ssl.create_default_context()
    verify_host = (settings.mailbox_ssl_hostname or "").strip() or None
    try:
        if port == 465:
            if verify_host and verify_host != host:

                class _SMTP_SSL(smtplib.SMTP_SSL):
                    def _get_socket(self, h, p, timeout):  # noqa: ANN001
                        sock = socket.create_connection((h, p), timeout)
                        return ctx.wrap_socket(sock, server_hostname=verify_host)

                with _SMTP_SSL(host, port, timeout=30, context=ctx) as server:
                    server.login(email, password)
            else:
                with smtplib.SMTP_SSL(host, port, timeout=30, context=ctx) as server:
                    server.login(email, password)
        else:
            with smtplib.SMTP(host, port, timeout=30) as server:
                server.ehlo()
                if verify_host:
                    server._host = verify_host  # noqa: SLF001
                server.starttls(context=ctx)
                server.ehlo()
                server.login(email, password)
        print("SMTP AUTH OK — individual + bulk send can use this mailbox.")
    except Exception as exc:
        print(f"SMTP AUTH FAILED: {exc}")
        sys.exit(1)


if __name__ == "__main__":
    main()
