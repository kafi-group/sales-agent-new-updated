"""Outbound email via Resend HTTPS API (Railway Hobby-compatible).

Railway Hobby blocks SMTP ports 25/465/587. Resend uses HTTPS (443), so
individual + bulk sends work without upgrading to Pro. Verify domain
``kafi-group.com`` in the Resend dashboard and send as each user's mailbox
address (From). Inbox/Sent still use IMAP when MAILBOX_* hosts are set.
"""

from __future__ import annotations

import base64
import logging
from typing import Any

import httpx

from config import settings

logger = logging.getLogger(__name__)

RESEND_API = "https://api.resend.com/emails"


def resend_configured() -> bool:
    return bool((settings.resend_api_key or "").strip())


def _split_addrs(raw: str | None) -> list[str]:
    if not raw:
        return []
    return [
        part.strip()
        for part in raw.replace(";", ",").split(",")
        if part.strip() and "@" in part
    ]


def send_via_resend(
    *,
    from_email: str,
    from_name: str | None,
    to: str,
    subject: str,
    plain_body: str,
    html_body: str | None = None,
    cc: str | None = None,
    bcc: str | None = None,
    attachments: list[dict] | None = None,
    headers: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Send one email through Resend. ``attachments`` use email_attachments meta dicts."""
    api_key = (settings.resend_api_key or "").strip()
    if not api_key:
        return {
            "status": "not_configured",
            "message": "RESEND_API_KEY is not set. Add it on Railway for Hobby-plan sending.",
        }
    if not from_email or not to:
        return {"status": "error", "message": "From and To addresses are required"}

    from_header = f"{from_name} <{from_email}>" if from_name else from_email
    to_list = _split_addrs(to) or [to]
    payload: dict[str, Any] = {
        "from": from_header,
        "to": to_list,
        "subject": subject,
        "text": plain_body or "",
        "reply_to": [from_email],
    }
    if html_body:
        payload["html"] = html_body
    cc_list = _split_addrs(cc)
    if cc_list:
        payload["cc"] = cc_list
    bcc_list = _split_addrs(bcc)
    if bcc_list:
        payload["bcc"] = bcc_list
    if headers:
        payload["headers"] = headers

    if attachments:
        from modules.email_attachments import load_bytes

        att_payload: list[dict[str, str]] = []
        for meta in attachments:
            content_id = None
            if isinstance(meta, dict):
                content_id = (meta.get("content_id") or meta.get("cid") or "").strip() or None
            try:
                if isinstance(meta, dict) and isinstance(meta.get("bytes"), (bytes, bytearray)):
                    data = bytes(meta["bytes"])
                    filename = str(meta.get("filename") or "attachment.bin")
                    content_type = str(meta.get("content_type") or "application/octet-stream")
                else:
                    data, filename, content_type = load_bytes(meta)
            except FileNotFoundError as exc:
                return {"status": "error", "message": str(exc)}
            item: dict[str, str] = {
                "filename": filename,
                "content": base64.b64encode(data).decode("ascii"),
            }
            if content_type:
                item["content_type"] = content_type
            # Resend uses content_id for cid: inline images in HTML.
            if content_id:
                item["content_id"] = content_id
            att_payload.append(item)
        if att_payload:
            payload["attachments"] = att_payload

    try:
        response = httpx.post(
            RESEND_API,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=60.0,
        )
    except Exception as exc:  # noqa: BLE001
        return {"status": "error", "message": f"Resend send failed: {exc}"}

    if response.status_code in (200, 201):
        data = {}
        try:
            data = response.json()
        except Exception:  # noqa: BLE001
            pass
        return {
            "status": "sent",
            "message": "Email sent via Resend",
            "to": to,
            "subject": subject,
            "provider": "resend",
            "provider_id": data.get("id"),
        }

    detail = response.text
    try:
        err = response.json()
        detail = err.get("message") or err.get("name") or detail
        if isinstance(err.get("message"), list):
            detail = "; ".join(str(x) for x in err["message"])
    except Exception:  # noqa: BLE001
        pass
    logger.warning("Resend HTTP %s: %s", response.status_code, detail)
    return {
        "status": "error",
        "message": f"Resend send failed ({response.status_code}): {detail}",
    }
