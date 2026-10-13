"""Download / re-attach the files of a received inbox message.

Additive and read-only against the mailbox: it fetches ONE message over IMAP exactly like
``outlook_client.get_message`` does (``mark_seen=False``), and returns its attachments in the
same order the inbox lists them, so the attachment's position in that list is its id.
"""

from __future__ import annotations

from typing import Any

from db.models import AppUser
from integrations.outlook_client import _imap_lock, outlook_client
from modules.mailbox_accounts import resolve_user_mailbox, use_mailbox

# Largest single file the inbox will hand back for download.
MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024


def _fetch_attachments(uid: str, folder: str) -> list[dict[str, Any]] | None:
    """Raw attachment files of one message; ``None`` when the message / folder is not found."""
    from imap_tools import AND

    with _imap_lock():
        mailbox = outlook_client._mailbox("INBOX")  # noqa: SLF001 - same access get_message uses
        try:
            imap_folder = outlook_client._imap_folder_for(mailbox, folder)  # noqa: SLF001
            if imap_folder != "INBOX":
                try:
                    mailbox.folder.set(imap_folder)
                except Exception:  # noqa: BLE001
                    return None
            messages = list(
                mailbox.fetch(
                    AND(uid=str(uid)),
                    mark_seen=False,
                    bulk=False,
                    headers_only=False,
                )
            )
        finally:
            try:
                mailbox.logout()
            except Exception:  # noqa: BLE001
                pass
    if not messages:
        return None

    items: list[dict[str, Any]] = []
    for att in messages[0].attachments:
        items.append(
            {
                "filename": (att.filename or "").strip(),
                "content_type": (att.content_type or "application/octet-stream").strip(),
                "payload": att.payload or b"",
                "inline": str(getattr(att, "content_disposition", "") or "").lower() == "inline"
                and bool(getattr(att, "content_id", "") or ""),
            }
        )
    return items


def get_attachment_file(
    user: AppUser, uid: str, index: int, *, folder: str = "INBOX"
) -> dict[str, Any] | None:
    """One attachment (filename, content_type, payload bytes) or ``None`` if it does not exist."""
    account = resolve_user_mailbox(user)
    if not account:
        return None
    with use_mailbox(account, user_id=user.id):
        items = _fetch_attachments(uid, folder)
    if items is None or index < 0 or index >= len(items):
        return None
    return items[index]


def stage_for_forward(user: AppUser, uid: str, *, folder: str = "INBOX") -> dict[str, Any]:
    """Save a message's attachments as outgoing-email attachments so a forward can re-attach them.

    Uses the same storage and the same rules as a normal "Attach file" upload (blocked file
    types, 10 MB per file, 8 files per email). Anything that cannot be carried is listed in
    ``skipped`` so the user knows to attach it by hand.
    """
    from modules.email_attachments import (
        MAX_FILE_BYTES,
        MAX_FILES_PER_EMAIL,
        _assert_attachment_allowed,
        public_attachment,
        register_attachment_from_bytes,
    )

    account = resolve_user_mailbox(user)
    if not account:
        return {"attachments": [], "skipped": []}
    with use_mailbox(account, user_id=user.id):
        items = _fetch_attachments(uid, folder)
    if not items:
        return {"attachments": [], "skipped": []}

    attachments: list[dict[str, Any]] = []
    skipped: list[str] = []
    for item in items:
        name = item["filename"] or "attachment"
        data: bytes = item["payload"]
        if item["inline"] and str(item["content_type"]).lower().startswith("image/"):
            continue  # embedded picture (signature logo) — not a real attachment
        if not data:
            skipped.append(f"{name} (empty)")
            continue
        try:
            content_type = _assert_attachment_allowed(name, item["content_type"])
        except ValueError:
            skipped.append(f"{name} (file type not allowed)")
            continue
        if len(data) > MAX_FILE_BYTES:
            skipped.append(f"{name} (over {MAX_FILE_BYTES // (1024 * 1024)} MB)")
            continue
        if len(attachments) >= MAX_FILES_PER_EMAIL:
            skipped.append(f"{name} (too many files)")
            continue
        meta = register_attachment_from_bytes(data, name, content_type)
        attachments.append(public_attachment(meta))
    return {"attachments": attachments, "skipped": skipped}
