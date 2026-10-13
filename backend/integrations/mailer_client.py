"""Outbound email via the Vercel mailer (SMTP off Railway Hobby).

AI Mode / Approve & Send call this when MAILER_PUBLIC_URL + MAILER_HANDOFF_SECRET
are set. The mailer app runs SMTP on Vercel; Railway only issues a short JWT.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
import jwt

from config import settings
from modules.mailbox_accounts import get_active_mailbox, get_active_mailbox_user_id


def mailer_configured() -> bool:
    return bool(
        (settings.mailer_handoff_secret or "").strip()
        and (settings.mailer_public_url or "").strip()
    )


def _resolve_username(user_id: int | None) -> str | None:
    if not user_id:
        return None
    from db.models import AppUser
    from db.session import SessionLocal

    db = SessionLocal()
    try:
        user = db.get(AppUser, user_id)
        if user and user.username:
            return str(user.username).strip()
    finally:
        db.close()
    return None


def send_via_mailer(
    *,
    to: str,
    subject: str,
    body: str,
    username: str | None = None,
    mailbox_email: str | None = None,
    display_name: str | None = None,
    html: bool = True,
    cc: str | None = None,
    bcc: str | None = None,
    attachments: list[dict] | None = None,
) -> dict[str, Any]:
    """POST one message to the Vercel mailer /api/send endpoint."""
    secret = (settings.mailer_handoff_secret or "").strip()
    public_url = (settings.mailer_public_url or "").strip().rstrip("/")
    if not secret or not public_url:
        return {
            "status": "error",
            "message": (
                "Vercel mailer is not configured. Set MAILER_HANDOFF_SECRET and "
                "MAILER_PUBLIC_URL on the backend (same secret as the mailer Vercel project)."
            ),
        }

    account = get_active_mailbox()
    email = (mailbox_email or (account.email if account else "") or "").strip()
    name = display_name
    if name is None and account:
        name = account.display_name

    uname = (username or "").strip() or _resolve_username(get_active_mailbox_user_id())
    if not uname or not email:
        return {
            "status": "error",
            "message": (
                "Cannot send via mailer: missing username or mailbox email. "
                "Ensure the user has a company mailbox on the Users page."
            ),
        }

    attachment_refs: list[dict[str, Any]] = []
    if attachments:
        from modules.email_tracking import public_api_base

        base = (public_api_base() or "").rstrip("/")
        if not base:
            return {
                "status": "error",
                "message": (
                    "Cannot send attachments via mailer: PUBLIC_API_BASE_URL is not set "
                    "so the mailer cannot download the files."
                ),
            }
        for meta in attachments:
            if not isinstance(meta, dict):
                continue
            att_id = str(meta.get("id") or "").strip()
            filename = str(meta.get("filename") or "attachment").strip() or "attachment"
            if not att_id:
                return {
                    "status": "error",
                    "message": f"Attachment “{filename}” is missing an id — re-upload it.",
                }
            attachment_refs.append(
                {
                    "id": att_id,
                    "filename": filename,
                    "contentType": str(meta.get("content_type") or "application/octet-stream"),
                    "size": int(meta.get("size") or 0),
                    "url": f"{base}/api/mailer/inline-media/{att_id}",
                }
            )

    now = datetime.now(timezone.utc)
    token = jwt.encode(
        {
            "user_id": get_active_mailbox_user_id() or 0,
            "username": uname,
            "mailbox_email": email,
            "display_name": name,
            "buyer_ids": [],
            "iat": int(now.timestamp()),
            "exp": int((now + timedelta(minutes=5)).timestamp()),
        },
        secret,
        algorithm="HS256",
    )
    if isinstance(token, bytes):
        token = token.decode("ascii")

    payload: dict[str, Any] = {
        "token": token,
        "to": to,
        "subject": subject,
        "body": body,
        "html": html,
    }
    if (cc or "").strip():
        payload["cc"] = cc
    if (bcc or "").strip():
        payload["bcc"] = bcc
    if attachment_refs:
        payload["attachments"] = attachment_refs

    try:
        with httpx.Client(timeout=90.0) as client:
            res = client.post(
                f"{public_url}/api/send",
                json=payload,
            )
    except httpx.HTTPError as exc:
        return {
            "status": "error",
            "message": f"Mailer request failed: {exc}",
            "provider": "mailer",
        }

    try:
        data = res.json()
    except Exception:  # noqa: BLE001
        data = {}

    if res.is_success and data.get("ok"):
        return {
            "status": "sent",
            "message": data.get("message") or "Email sent via Vercel mailer",
            "to": to,
            "subject": subject,
            "provider": "mailer",
        }

    err = (
        data.get("error")
        or data.get("message")
        or res.text
        or f"HTTP {res.status_code}"
    )
    return {
        "status": "error",
        "message": f"Mailer send failed: {err}",
        "provider": "mailer",
    }
