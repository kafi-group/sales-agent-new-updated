"""One-time Outlook OAuth setup — prints a refresh token for backend/.env.

Microsoft disabled SMTP AUTH for many personal @outlook.com mailboxes (error 5.7.139).
This app therefore:
  - sends via Microsoft Graph Mail.Send
  - reads inbox via IMAP OAuth (outlook.office.com)

=== Azure app setup (one time, ~5 min) ===

1. Open: https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/CreateApplicationBlade
   Sign in as kaficommoditiespvtltd@outlook.com (same mailbox account).

2. New registration:
   - Name: Kafi Sales Agent Inbox
   - Supported account types: pick the THIRD option:
     "Accounts in any organizational directory and personal Microsoft accounts"
     (NOT "Single tenant" — that causes the tenant error you saw before)
   - Redirect URI: select "Public client/native (mobile & desktop)" → http://localhost
   - Click Register

3. Copy the "Application (client) ID" from the Overview page.

4. Left menu → Authentication → Advanced settings:
   - "Allow public client flows" → Yes → Save

5. Left menu → API permissions → Add a permission:
   - Microsoft APIs → Microsoft Graph → Delegated permissions → Mail.Send → Add
   - (Optional) IMAP for inbox: if you can find Office 365 Exchange Online /
     Legacy APIs, add IMAP.AccessAsUser.All — otherwise the script will request
     it during browser consent.

6. Run this script (from backend/):
   python scripts/get_outlook_refresh_token.py

7. Paste printed values into backend/.env and restart python run.py
"""

from __future__ import annotations

import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

# Different resources — consent separately (MSAL cannot mix audiences in one call).
GRAPH_SEND_SCOPES = [
    "https://graph.microsoft.com/Mail.Send",
]
IMAP_SCOPES = [
    "https://outlook.office.com/IMAP.AccessAsUser.All",
]


def main() -> None:
    try:
        from msal import ConfidentialClientApplication, PublicClientApplication
    except ImportError:
        print("Install: pip install msal", file=sys.stderr)
        sys.exit(1)

    print("Outlook Inbox OAuth setup")
    print("=" * 50)
    print(
        "Personal @outlook.com accounts often have SMTP disabled.\n"
        "This script consents to Graph Mail.Send (outbound) and IMAP (inbox).\n"
        "If you have not created an Azure app yet, read the steps at the top of:\n"
        "  scripts/get_outlook_refresh_token.py\n"
    )
    client_id = input("Application (client) ID from Azure: ").strip()
    if not client_id:
        print("Client ID is required.", file=sys.stderr)
        sys.exit(1)

    client_secret = input("Client secret (leave blank — recommended for personal Outlook): ").strip()
    tenant = input("Tenant [press Enter for consumers]: ").strip() or "consumers"
    authority = f"https://login.microsoftonline.com/{tenant}"

    if client_secret:
        app = ConfidentialClientApplication(
            client_id,
            client_credential=client_secret,
            authority=authority,
        )
    else:
        app = PublicClientApplication(client_id, authority=authority)

    print("\n[1/2] Opening browser — consent to Microsoft Graph Mail.Send…")
    print("Sign in as kaficommoditiespvtltd@outlook.com")
    result = app.acquire_token_interactive(
        scopes=GRAPH_SEND_SCOPES,
        prompt="consent",
    )

    if "access_token" not in result:
        print("\nAuth failed (Graph):", result.get("error_description") or result, file=sys.stderr)
        print(
            "\nIf you see 'account does not exist in tenant': recreate the Azure app with\n"
            "'Personal Microsoft accounts' enabled (not Single tenant only).",
            file=sys.stderr,
        )
        sys.exit(1)

    refresh = result.get("refresh_token")
    if not refresh:
        print(
            "No refresh token returned. Revoke old access at account.microsoft.com/privacy/app-access "
            "and try again.",
            file=sys.stderr,
        )
        sys.exit(1)

    print("\n[2/2] Opening browser — consent to IMAP inbox access…")
    imap_result = app.acquire_token_interactive(
        scopes=IMAP_SCOPES,
        prompt="consent",
    )
    if "access_token" not in imap_result:
        print(
            "\nWARNING: IMAP consent failed — sending may still work, but Inbox may not.\n"
            f"Detail: {imap_result.get('error_description') or imap_result}",
            file=sys.stderr,
        )
    elif imap_result.get("refresh_token"):
        refresh = imap_result["refresh_token"]

    default_email = "kaficommoditiespvtltd@outlook.com"
    email = input(f"\nMailbox email [{default_email}]: ").strip() or default_email

    print("\nAdd these lines to backend/.env (remove MAILBOX_PASSWORD if present):\n")
    print("MAILBOX_ENABLED=true")
    print(f"MAILBOX_EMAIL={email}")
    print(f"MAILBOX_CLIENT_ID={client_id}")
    if client_secret:
        print(f"MAILBOX_CLIENT_SECRET={client_secret}")
    print(f"MAILBOX_REFRESH_TOKEN={refresh}")
    print(f"MAILBOX_TENANT_ID={tenant}")
    print("MAILBOX_DISPLAY_NAME=Kafi Commodities")
    print("\nRestart the backend: python run.py")


if __name__ == "__main__":
    main()
