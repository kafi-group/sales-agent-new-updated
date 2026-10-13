"""Gmail API client — inbox read/reply and approved outbound sends."""

from __future__ import annotations

import base64
import re
from datetime import datetime, timezone
from email.mime.text import MIMEText
from email.utils import parseaddr, parsedate_to_datetime
from typing import Any

from config import settings
from modules.inbox_cutoff import (
    get_inbox_since,
    gmail_after_query,
    message_is_after_cutoff,
    set_inbox_since_to_now,
)

GMAIL_SCOPES = [
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.modify",
]

_HTML_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")


def _html_to_preview(html: str) -> str:
    text = _HTML_TAG_RE.sub(" ", html or "")
    return _WS_RE.sub(" ", text).strip()


def _header_value(headers: list[dict[str, str]], name: str) -> str:
    target = name.lower()
    for header in headers:
        if header.get("name", "").lower() == target:
            return header.get("value", "")
    return ""


def _parse_date(value: str) -> datetime | None:
    if not value:
        return None
    try:
        parsed = parsedate_to_datetime(value)
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=timezone.utc)
        return parsed
    except (TypeError, ValueError, IndexError):
        return None


def _decode_body_data(data: str | None) -> str:
    if not data:
        return ""
    padded = data + "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(padded.encode()).decode("utf-8", errors="replace")


def _extract_bodies(payload: dict[str, Any]) -> tuple[str | None, str | None, list[dict[str, Any]]]:
    text: str | None = None
    html: str | None = None
    attachments: list[dict[str, Any]] = []

    def walk(part: dict[str, Any]) -> None:
        nonlocal text, html
        mime = part.get("mimeType", "")
        filename = part.get("filename") or ""
        body = part.get("body", {})
        data = body.get("data")
        if filename:
            attachments.append(
                {
                    "filename": filename,
                    "size": body.get("size"),
                    "content_type": mime or None,
                }
            )
        if mime == "text/plain" and data and text is None:
            text = _decode_body_data(data)
        elif mime == "text/html" and data and html is None:
            html = _decode_body_data(data)
        for child in part.get("parts") or []:
            walk(child)

    walk(payload)
    return text, html, attachments


class EmailClient:
    @property
    def is_configured(self) -> bool:
        return bool(
            settings.gmail_client_id
            and settings.gmail_client_secret
            and settings.gmail_refresh_token
        )

    def inbox_since(self) -> str:
        return get_inbox_since().isoformat()

    def reset_inbox_cutoff(self) -> str:
        return set_inbox_since_to_now().isoformat()

    def _credentials(self):
        from google.oauth2.credentials import Credentials

        return Credentials(
            token=None,
            refresh_token=settings.gmail_refresh_token,
            token_uri="https://oauth2.googleapis.com/token",
            client_id=settings.gmail_client_id,
            client_secret=settings.gmail_client_secret,
            scopes=GMAIL_SCOPES,
        )

    def _service(self):
        try:
            from googleapiclient.discovery import build
        except ImportError as exc:
            raise RuntimeError(
                "Gmail dependencies not installed. Run: pip install google-api-python-client google-auth"
            ) from exc
        return build("gmail", "v1", credentials=self._credentials(), cache_discovery=False)

    def mailbox_email(self) -> str | None:
        if settings.gmail_sender_email:
            return settings.gmail_sender_email
        if not self.is_configured:
            return None
        try:
            profile = self._service().users().getProfile(userId="me").execute()
            return profile.get("emailAddress")
        except Exception:  # noqa: BLE001
            return None

    def _inbox_query(self, *, unread_only: bool = False) -> str:
        parts = ["in:inbox", gmail_after_query()]
        if unread_only:
            parts.append("is:unread")
        return " ".join(parts)

    def _summarize_message(self, msg: dict[str, Any]) -> dict[str, Any]:
        headers = msg.get("payload", {}).get("headers", [])
        from_raw = _header_value(headers, "From")
        from_name, from_email = parseaddr(from_raw)
        label_ids = msg.get("labelIds") or []
        preview = (msg.get("snippet") or "").strip()
        if not preview:
            _, html, _ = _extract_bodies(msg.get("payload", {}))
            if html:
                preview = _html_to_preview(html)[:240]

        return {
            "uid": msg["id"],
            "thread_id": msg.get("threadId"),
            "subject": _header_value(headers, "Subject") or "(no subject)",
            "from_email": from_email or None,
            "from_name": from_name or None,
            "date": _parse_date(_header_value(headers, "Date")),
            "preview": preview[:240],
            "unread": "UNREAD" in label_ids,
            "has_attachments": any(
                (part.get("filename") or "")
                for part in self._iter_parts(msg.get("payload", {}))
            ),
            "message_id": _header_value(headers, "Message-ID") or None,
        }

    @staticmethod
    def _iter_parts(payload: dict[str, Any]):
        stack = [payload]
        while stack:
            part = stack.pop()
            yield part
            stack.extend(part.get("parts") or [])

    def list_messages(self, *, limit: int = 25, unread_only: bool = False) -> list[dict[str, Any]]:
        service = self._service()
        result = (
            service.users()
            .messages()
            .list(
                userId="me",
                maxResults=limit,
                q=self._inbox_query(unread_only=unread_only),
            )
            .execute()
        )
        messages = result.get("messages") or []
        summaries: list[dict[str, Any]] = []
        for item in messages:
            msg = (
                service.users()
                .messages()
                .get(
                    userId="me",
                    id=item["id"],
                    format="metadata",
                    metadataHeaders=["From", "Subject", "Date", "Message-ID"],
                )
                .execute()
            )
            summaries.append(self._summarize_message(msg))
        return [m for m in summaries if message_is_after_cutoff(m.get("date"))]

    def get_message(self, uid: str) -> dict[str, Any] | None:
        service = self._service()
        try:
            msg = service.users().messages().get(userId="me", id=str(uid), format="full").execute()
        except Exception:  # noqa: BLE001
            return None

        data = self._summarize_message(msg)
        headers = msg.get("payload", {}).get("headers", [])
        text, html, attachments = _extract_bodies(msg.get("payload", {}))
        data.update(
            {
                "to": [parseaddr(addr)[1] for addr in _header_value(headers, "To").split(",") if addr.strip()],
                "cc": [parseaddr(addr)[1] for addr in _header_value(headers, "Cc").split(",") if addr.strip()],
                "body_text": text,
                "body_html": html,
                "attachments": attachments,
            }
        )
        return data

    def unread_count(self) -> int:
        return sum(1 for m in self.list_messages(limit=100, unread_only=True) if m.get("unread"))

    def mark_read(self, uid: str, seen: bool = True) -> None:
        service = self._service()
        body: dict[str, list[str]] = {}
        if seen:
            body["removeLabelIds"] = ["UNREAD"]
        else:
            body["addLabelIds"] = ["UNREAD"]
        service.users().messages().modify(userId="me", id=str(uid), body=body).execute()

    def _encode_message(self, message: MIMEText) -> str:
        return base64.urlsafe_b64encode(message.as_bytes()).decode("utf-8")

    def send_reply(
        self,
        *,
        to: str,
        subject: str,
        body: str,
        in_reply_to: str | None = None,
        references: str | None = None,
        cc: str | None = None,
        thread_id: str | None = None,
    ) -> dict[str, Any]:
        if not self.is_configured:
            return {
                "status": "not_configured",
                "message": (
                    "Gmail API is not configured. Set GMAIL_CLIENT_ID, "
                    "GMAIL_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN in backend/.env"
                ),
            }
        if not to:
            return {"status": "error", "message": "Recipient email is missing"}

        sender = self.mailbox_email()
        message = MIMEText(body, "plain", "utf-8")
        message["To"] = to
        message["Subject"] = subject
        if sender:
            message["From"] = sender
        if cc:
            message["Cc"] = cc
        if in_reply_to:
            message["In-Reply-To"] = in_reply_to
            message["References"] = references or in_reply_to

        send_body: dict[str, Any] = {"raw": self._encode_message(message)}
        if thread_id:
            send_body["threadId"] = thread_id

        try:
            service = self._service()
            result = service.users().messages().send(userId="me", body=send_body).execute()
        except Exception as exc:  # noqa: BLE001
            return {"status": "error", "message": f"Gmail reply failed: {exc}"}

        return {
            "status": "sent",
            "message": "Reply sent",
            "to": to,
            "subject": subject,
            "message_id": result.get("id"),
        }

    def create_draft(self, *, to: str, subject: str, body: str) -> dict[str, Any]:
        return {
            "status": "draft_only",
            "message": "Draft saved in database. Approve in the dashboard to send.",
            "to": to,
            "subject": subject,
        }

    def send_approved(self, *, to: str, subject: str, body: str) -> dict[str, Any]:
        if not self.is_configured:
            return {
                "status": "not_configured",
                "message": (
                    "Gmail API is not configured. Set GMAIL_CLIENT_ID, "
                    "GMAIL_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN in backend/.env"
                ),
            }

        if not to:
            return {"status": "error", "message": "Recipient email is missing"}

        message = MIMEText(body, "plain", "utf-8")
        message["to"] = to
        message["subject"] = subject
        sender = self.mailbox_email()
        if sender:
            message["from"] = sender

        try:
            service = self._service()
            result = service.users().messages().send(
                userId="me",
                body={"raw": self._encode_message(message)},
            ).execute()
        except Exception as exc:  # noqa: BLE001
            return {"status": "error", "message": f"Gmail send failed: {exc}"}

        return {
            "status": "sent",
            "message": "Email sent via Gmail",
            "to": to,
            "subject": subject,
            "message_id": result.get("id"),
        }


email_client = EmailClient()
