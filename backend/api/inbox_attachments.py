"""Inbox attachments — download a received file, or stage them for a forward.

Kept in its own router (registered with a guard in main.py) so it can never affect the
existing inbox routes.
"""

import re
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response

from api.deps import get_current_user_released
from api.inbox import _mailbox_target
from db.models import AppUser
from modules import inbox_attachments as inbox_attachments_module

router = APIRouter(prefix="/inbox", tags=["inbox-attachments"])


@router.get("/messages/{uid}/attachments/{index}")
def download_inbox_attachment(
    uid: str,
    index: int,
    folder: str = Query(default="INBOX"),
    mailbox_user_id: int | None = Query(default=None),
    user: AppUser = Depends(get_current_user_released),
):
    """Download the Nth attachment of a message (N = its position in the message's list)."""
    target = _mailbox_target(user, mailbox_user_id)
    try:
        item = inbox_attachments_module.get_attachment_file(target, uid, index, folder=folder)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Could not read attachment: {exc}") from exc
    if not item:
        raise HTTPException(404, "Attachment not found")

    data: bytes = item["payload"]
    if len(data) > inbox_attachments_module.MAX_DOWNLOAD_BYTES:
        raise HTTPException(413, "This attachment is too large to download here")

    filename = item["filename"] or f"attachment-{index + 1}"
    # re.ASCII: HTTP header values must be latin-1; the real (unicode) name goes in filename*.
    ascii_name = re.sub(r"[^\w.\- ]+", "_", filename, flags=re.ASCII).strip() or "attachment"
    return Response(
        content=data,
        media_type=item["content_type"] or "application/octet-stream",
        headers={
            # Always a download, never rendered inside the app's own origin.
            "Content-Disposition": f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}",
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.post("/messages/{uid}/attachments/stage")
def stage_inbox_attachments_for_forward(
    uid: str,
    folder: str = Query(default="INBOX"),
    mailbox_user_id: int | None = Query(default=None),
    user: AppUser = Depends(get_current_user_released),
):
    """Copy a message's attachments into outgoing-email storage so Forward can re-attach them."""
    target = _mailbox_target(user, mailbox_user_id)
    try:
        return inbox_attachments_module.stage_for_forward(target, uid, folder=folder)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Could not prepare attachments: {exc}") from exc
