"""One-time Gmail OAuth setup — prints a refresh token for backend/.env.

Powers both the in-app Inbox (read/reply) and Approve & Send outbound email.

Prerequisites (Google Cloud Console):
  1. https://console.cloud.google.com → create/select a project
  2. APIs & Services → Enable **Gmail API**
  3. OAuth consent screen → External → add your Gmail as a test user
  4. Credentials → Create OAuth client ID → **Desktop app** → download JSON
  5. Save JSON as backend/credentials.json (do not commit)

Run from backend/:
  python scripts/get_gmail_refresh_token.py

Then add to backend/.env:
  GMAIL_CLIENT_ID=...
  GMAIL_CLIENT_SECRET=...
  GMAIL_REFRESH_TOKEN=...
  GMAIL_SENDER_EMAIL=your@gmail.com
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

SCOPES = [
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.modify",
]
BACKEND_DIR = Path(__file__).resolve().parents[1]
CREDENTIALS_FILE = BACKEND_DIR / "credentials.json"


def _client_config() -> dict:
    if CREDENTIALS_FILE.is_file():
        with CREDENTIALS_FILE.open(encoding="utf-8") as fh:
            return json.load(fh)

    sys.path.insert(0, str(BACKEND_DIR))
    from config import settings

    if settings.gmail_client_id and settings.gmail_client_secret:
        return {
            "installed": {
                "client_id": settings.gmail_client_id,
                "client_secret": settings.gmail_client_secret,
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
                "redirect_uris": ["http://localhost"],
            }
        }

    print(f"Missing {CREDENTIALS_FILE}", file=sys.stderr)
    print(
        "Either download OAuth client JSON (Desktop app) from Google Cloud Console\n"
        "and save it as backend/credentials.json, or set GMAIL_CLIENT_ID and\n"
        "GMAIL_CLIENT_SECRET in backend/.env first.",
        file=sys.stderr,
    )
    sys.exit(1)


def main() -> None:
    try:
        from google_auth_oauthlib.flow import InstalledAppFlow
    except ImportError:
        print("Install: pip install google-auth-oauthlib", file=sys.stderr)
        sys.exit(1)

    client_config = _client_config()

    installed = client_config.get("installed") or client_config.get("web")
    if not installed:
        print("OAuth client config must contain 'installed' or 'web'.", file=sys.stderr)
        sys.exit(1)

    print("Gmail OAuth — inbox + send scopes")
    print("=" * 50)
    print(
        "If you already authorized this app before, revoke it first:\n"
        "  https://myaccount.google.com/permissions\n"
        "Then sign in again when the browser opens.\n"
    )

    flow = InstalledAppFlow.from_client_config(client_config, SCOPES)
    creds = flow.run_local_server(port=0, prompt="consent", access_type="offline")

    if not creds.refresh_token:
        print(
            "No refresh token returned. Revoke access at "
            "https://myaccount.google.com/permissions and run again.",
            file=sys.stderr,
        )
        sys.exit(1)

    client_id = installed.get("client_id", "")
    client_secret = installed.get("client_secret", "")

    print("\nAdd these lines to backend/.env:\n")
    print(f"GMAIL_CLIENT_ID={client_id}")
    print(f"GMAIL_CLIENT_SECRET={client_secret}")
    print(f"GMAIL_REFRESH_TOKEN={creds.refresh_token}")
    print("GMAIL_SENDER_EMAIL=your-sending-address@gmail.com")
    print("\nReplace GMAIL_SENDER_EMAIL with the Google account you signed in with.")


if __name__ == "__main__":
    main()
