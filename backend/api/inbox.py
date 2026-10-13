"""Inbox API — per-user IMAP mailbox and replies from the dashboard."""

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from api.deps import get_current_user_released, get_db
from db.session import SessionLocal
from api.schemas import (
    InboxAnalyzeRequest,
    InboxAnalyzeResponse,
    InboxComposeRequest,
    InboxComposeResponse,
    InboxEmptyTrashResponse,
    InboxFoldersResponse,
    InboxMessageDetail,
    InboxMessageSummary,
    InboxMoveRequest,
    InboxMoveResponse,
    InboxReplyRequest,
    InboxReplyResponse,
    InboxStatus,
    InboxThreadDetail,
    InboxThreadListResponse,
    InboxThreadMoveRequest,
    InboxThreadSummary,
    InboxMailAiQueryRequest,
    InboxMailAiQueryResponse,
    InboxMailSearchRequest,
    InboxMessageListResponse,
    InboxUnreadCount,
)
from db.models import AppUser, AppUserRole
from modules import inbox as inbox_module
from modules import inbox_assistant as inbox_assistant_module
from modules import inbox_mail_ai as inbox_mail_ai_module
from modules.mailbox_accounts import hosts_enabled, resolve_user_mailbox

router = APIRouter(prefix="/inbox", tags=["inbox"])

_VALID_FOLDERS = {"inbox", "sent", "trash", "archive", "junk"}
_LIST_FOLDERS = _VALID_FOLDERS | {"all"}

# Asim-only shared mailboxes (Mr Khalid request). Email-module override only.
_ASIM_SHARED_MAILBOX_EMAILS = frozenset(
    {
        "marketing@kafi-group.com",
        "info@kafi-group.com",
        "essence@kafi-group.com",
    }
)
_ASIM_SHARED_MAILBOX_ORDER = (
    "marketing@kafi-group.com",
    "info@kafi-group.com",
    "essence@kafi-group.com",
)


def _norm_mailbox_email(value: str | None) -> str:
    return (value or "").strip().lower()


def _is_asim(user: AppUser) -> bool:
    uname = _norm_mailbox_email(user.username)
    fname = _norm_mailbox_email(getattr(user, "full_name", None))
    return uname == "asim" or uname.startswith("asim") or "asim" in fname


def _guard_configured(user: AppUser) -> None:
    if not hosts_enabled():
        raise HTTPException(
            503,
            "Inbox is not enabled. Set MAILBOX_ENABLED=true and IMAP/SMTP hosts in backend/.env",
        )
    if not resolve_user_mailbox(user):
        raise HTTPException(
            503,
            "No mailbox configured for your account. Ask an admin to set your company email on the Users page.",
        )


def _inbox_error_message(exc: Exception) -> str:
    return f"Could not read inbox: {exc}"


def _expunge_mailbox_user(db, other: AppUser) -> AppUser:
    _ = (
        other.id,
        other.username,
        other.full_name,
        other.role,
        other.is_active,
        other.mailbox_email,
        other.mailbox_password_encrypted,
        other.mailbox_display_name,
        other.mailbox_enabled,
    )
    db.expunge(other)
    return other


def _resolve_mailbox_user(acting: AppUser, mailbox_user_id: int | None) -> AppUser:
    """Admin may open any mailbox. Asim may open marketing@ / info@ / essence@ only."""
    if not mailbox_user_id or int(mailbox_user_id) == int(acting.id):
        return acting
    role = acting.role.value if isinstance(acting.role, AppUserRole) else str(acting.role)
    db = SessionLocal()
    try:
        other = db.get(AppUser, int(mailbox_user_id))
        if not other:
            return acting
        if role == AppUserRole.admin.value:
            return _expunge_mailbox_user(db, other)
        if _is_asim(acting):
            email = _norm_mailbox_email(other.mailbox_email)
            if email in _ASIM_SHARED_MAILBOX_EMAILS:
                return _expunge_mailbox_user(db, other)
            raise HTTPException(
                403,
                "You can only switch to marketing@, info@, or essence@ mailboxes",
            )
        raise HTTPException(403, "Only admin can open another mailbox")
    finally:
        db.close()


def _mailbox_target(acting: AppUser, mailbox_user_id: int | None = None) -> AppUser:
    target = _resolve_mailbox_user(acting, mailbox_user_id)
    _guard_configured(target)
    return target


@router.get("/switchable-mailboxes")
def list_switchable_mailboxes(user: AppUser = Depends(get_current_user_released)):
    """Asim gets marketing/info/essence; everyone else gets only their own mailbox."""
    db = SessionLocal()
    try:
        if _is_asim(user):
            rows = (
                db.query(AppUser)
                .filter(AppUser.mailbox_email.isnot(None))
                .all()
            )
            by_email: dict[str, dict] = {}
            for row in rows:
                email = _norm_mailbox_email(row.mailbox_email)
                if email not in _ASIM_SHARED_MAILBOX_EMAILS:
                    continue
                existing = by_email.get(email)
                # Prefer active + enabled mailbox owners.
                score = (1 if row.is_active else 0) + (1 if row.mailbox_enabled else 0)
                prev_score = int((existing or {}).get("_score") or -1)
                if existing and score < prev_score:
                    continue
                by_email[email] = {
                    "user_id": int(row.id),
                    "email": (row.mailbox_email or "").strip(),
                    "display_name": (row.mailbox_display_name or row.full_name or "").strip()
                    or None,
                    "mailbox_enabled": bool(row.mailbox_enabled),
                    "_score": score,
                }
            ordered = []
            for email in _ASIM_SHARED_MAILBOX_ORDER:
                if email in by_email:
                    row = dict(by_email[email])
                    row.pop("_score", None)
                    ordered.append(row)
            return {"can_switch": len(ordered) > 0, "mailboxes": ordered}
        own_email = (user.mailbox_email or "").strip() or None
        return {
            "can_switch": False,
            "mailboxes": (
                [
                    {
                        "user_id": int(user.id),
                        "email": own_email,
                        "display_name": (user.mailbox_display_name or user.full_name or "").strip()
                        or None,
                        "mailbox_enabled": bool(user.mailbox_enabled),
                    }
                ]
                if own_email
                else []
            ),
        }
    finally:
        db.close()


@router.get("/status", response_model=InboxStatus)
def inbox_status(
    mailbox_user_id: int | None = Query(default=None),
    user: AppUser = Depends(get_current_user_released),
):
    target = _resolve_mailbox_user(user, mailbox_user_id)
    return inbox_module.status(target)


@router.get("/folders", response_model=InboxFoldersResponse)
def inbox_folders(
    mailbox_user_id: int | None = Query(default=None),
    user: AppUser = Depends(get_current_user_released),
):
    target = _resolve_mailbox_user(user, mailbox_user_id)
    return inbox_module.list_folders(target)


@router.get("/unread-count", response_model=InboxUnreadCount)
def inbox_unread_count(
    mailbox_user_id: int | None = Query(default=None),
    user: AppUser = Depends(get_current_user_released),
):
    target = _resolve_mailbox_user(user, mailbox_user_id)
    return {"count": inbox_module.unread_count(target)}


@router.get("/urgent-unreplied")
def get_urgent_unreplied_emails(
    db: SessionLocal = Depends(get_db),
    user: AppUser = Depends(get_current_user_released),
):
    """Fetch unreplied urgent and action-required threads for the active mailbox (or all team mailboxes if admin)."""
    try:
        threads = inbox_module.get_all_urgent_unreplied_threads(db, user)
        return {"urgent_threads": threads, "count": len(threads)}
    except Exception as exc:
        return {"urgent_threads": [], "count": 0, "error": str(exc)}


@router.post("/reset-cutoff")
def reset_inbox_cutoff(
    mailbox_user_id: int | None = Query(default=None),
    user: AppUser = Depends(get_current_user_released),
):
    target = _mailbox_target(user, mailbox_user_id)
    return inbox_module.reset_cutoff(target)


@router.post("/clear-cutoff")
def clear_inbox_cutoff(
    mailbox_user_id: int | None = Query(default=None),
    user: AppUser = Depends(get_current_user_released),
):
    """Show all mailbox mail again (undo 'New mail only')."""
    target = _mailbox_target(user, mailbox_user_id)
    return inbox_module.clear_cutoff(target)


@router.post("/clear-all-cutoffs")
def clear_all_inbox_cutoffs(user: AppUser = Depends(get_current_user_released)):
    """Disabled — caused team-wide historic mail floods. Use per-mailbox Show all mail."""
    raise HTTPException(
        403,
        "Clearing all users' email cutoffs is disabled. Use Show all mail for your own mailbox only.",
    )


@router.get("/threads", response_model=InboxThreadListResponse)
def list_inbox_threads(
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    unread_only: bool = Query(default=False),
    q: str | None = Query(default=None, max_length=200),
    triage_category: str | None = Query(default=None, max_length=40),
    mailbox_user_id: int | None = Query(default=None),
    user: AppUser = Depends(get_current_user_released),
):
    target = _mailbox_target(user, mailbox_user_id)
    try:
        result = inbox_module.list_threads(
            target,
            limit=limit,
            offset=offset,
            unread_only=unread_only,
            search_text=q,
            triage_category=triage_category,
        )
        return result
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, _inbox_error_message(exc)) from exc


@router.get("/threads/{thread_id}", response_model=InboxThreadDetail)
def get_inbox_thread(
    thread_id: str,
    mailbox_user_id: int | None = Query(default=None),
    user: AppUser = Depends(get_current_user_released),
):
    target = _mailbox_target(user, mailbox_user_id)
    try:
        thread = inbox_module.get_thread(target, thread_id)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Could not read conversation: {exc}") from exc
    if not thread:
        raise HTTPException(404, "Conversation not found")
    return thread


@router.post("/compose", response_model=InboxComposeResponse)
def compose_inbox_mail(
    payload: InboxComposeRequest,
    mailbox_user_id: int | None = Query(default=None),
    user: AppUser = Depends(get_current_user_released),
):
    """Compose and send a new email from the active (or switched) mailbox."""
    from modules import activity as activity_module

    target = _mailbox_target(user, mailbox_user_id)
    try:
        result = inbox_module.compose(
            target,
            to=payload.to,
            subject=payload.subject,
            body=payload.body,
            cc=payload.cc,
            bcc=payload.bcc,
            attachments=payload.attachments,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Could not send email: {exc}") from exc
    if result.get("status") != "sent":
        raise HTTPException(502, result.get("message", "Send failed"))

    subject = result.get("subject") or payload.subject or "(no subject)"
    to_addr = result.get("to") or payload.to
    db = SessionLocal()
    try:
        activity_module.log_activity(
            db,
            user_id=user.id,
            activity_type=activity_module.INBOX_REPLIED,
            title="Compose email sent",
            summary=f"Sent “{subject}” → {to_addr}",
            entity_type="inbox_compose",
            entity_id=None,
            details={
                "subject": subject,
                "to": to_addr,
                "from": result.get("from"),
                "mailbox_user_id": int(target.id),
            },
        )
        db.commit()
    finally:
        db.close()
    return {
        "status": result.get("status", "sent"),
        "message": result.get("message", "Sent"),
        "to": to_addr,
        "subject": subject,
        "from_email": result.get("from"),
    }


@router.post("/threads/{thread_id}/reply", response_model=InboxReplyResponse)
def reply_inbox_thread(
    thread_id: str,
    payload: InboxReplyRequest,
    mailbox_user_id: int | None = Query(default=None),
    user: AppUser = Depends(get_current_user_released),
):
    from modules import activity as activity_module

    target = _mailbox_target(user, mailbox_user_id)
    try:
        result = inbox_module.reply_to_thread(
            target,
            thread_id,
            payload.body,
            to=payload.to,
            subject=payload.subject,
            cc=payload.cc,
            bcc=payload.bcc,
            attachments=payload.attachments,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Could not send reply: {exc}") from exc
    if result.get("status") != "sent":
        raise HTTPException(502, result.get("message", "Reply failed"))

    subject = result.get("subject") or payload.subject or "(no subject)"
    to_addr = result.get("to") or payload.to or ""
    db = SessionLocal()
    try:
        activity_module.log_activity(
            db,
            user_id=user.id,
            activity_type=activity_module.INBOX_REPLIED,
            title="Inbox reply sent",
            summary=f"Replied to “{subject}”" + (f" → {to_addr}" if to_addr else ""),
            entity_type="inbox_thread",
            entity_id=None,
            details={
                "thread_id": thread_id,
                "subject": subject,
                "to": to_addr,
                "mailbox_user_id": int(target.id),
            },
        )
        db.commit()
    finally:
        db.close()
    return result


@router.post("/threads/{thread_id}/move", response_model=InboxMoveResponse)
def move_inbox_thread(
    thread_id: str,
    payload: InboxThreadMoveRequest,
    mailbox_user_id: int | None = Query(default=None),
    user: AppUser = Depends(get_current_user_released),
):
    target = _mailbox_target(user, mailbox_user_id)
    to_folder = payload.to_folder.strip().lower()
    if to_folder not in ("inbox", "trash", "archive"):
        raise HTTPException(400, "to_folder must be inbox, trash, or archive")
    try:
        result = inbox_module.move_thread_messages(target, thread_id, to_folder=to_folder)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Could not move conversation: {exc}") from exc
    if result.get("status") != "ok":
        raise HTTPException(502, result.get("message", "Move failed"))
    return {
        "status": result.get("status", "ok"),
        "message": result.get("message", "Moved"),
        "to_folder": result.get("to_folder"),
        "to_folder_key": result.get("to_folder"),
        "moved_count": result.get("moved_count", 0),
    }


@router.post("/threads/{thread_id}/analyze", response_model=InboxAnalyzeResponse)
def analyze_inbox_thread(
    thread_id: str,
    payload: InboxAnalyzeRequest = InboxAnalyzeRequest(),
    mailbox_user_id: int | None = Query(default=None),
    user: AppUser = Depends(get_current_user_released),
):
    """Summarize a conversation and draft a reply the rep can edit before sending."""
    target = _mailbox_target(user, mailbox_user_id)
    try:
        result = inbox_assistant_module.analyze_inbox_thread(
            target, thread_id, goal=payload.goal
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Could not analyze conversation: {exc}") from exc
    if not result:
        raise HTTPException(404, "Conversation not found")
    return result


@router.post("/messages/{uid}/analyze", response_model=InboxAnalyzeResponse)
def analyze_inbox_message(
    uid: str,
    payload: InboxAnalyzeRequest = InboxAnalyzeRequest(),
    mailbox_user_id: int | None = Query(default=None),
    user: AppUser = Depends(get_current_user_released),
):
    """Summarize a single message and draft a reply."""
    target = _mailbox_target(user, mailbox_user_id)
    folder = payload.folder or "INBOX"
    try:
        result = inbox_assistant_module.analyze_inbox_message(
            target, uid, folder=folder, goal=payload.goal
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Could not analyze message: {exc}") from exc
    if not result:
        raise HTTPException(404, "Message not found")
    return result


@router.get("/messages", response_model=InboxMessageListResponse)
def list_inbox_messages(
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    unread_only: bool = Query(default=False),
    folder: str = Query(default="inbox", description="Logical folder: inbox|sent|trash|archive"),
    q: str | None = Query(default=None, max_length=200),
    mailbox_user_id: int | None = Query(default=None),
    user: AppUser = Depends(get_current_user_released),
):
    target = _mailbox_target(user, mailbox_user_id)
    key = folder.strip().lower()
    if key not in _LIST_FOLDERS:
        raise HTTPException(400, f"folder must be one of: {', '.join(sorted(_LIST_FOLDERS))}")
    try:
        items = inbox_module.list_messages(
            target,
            limit=limit,
            offset=offset,
            unread_only=unread_only,
            folder=key,
            search_text=q,
        )
        total = len(items)
        if not q and key != "all":
            folders = inbox_module.list_folders(target)
            for row in folders.get("folders") or []:
                if row.get("key") == key:
                    total = int(row.get("count") or total)
                    break
        return {
            "items": items,
            "total": total,
            "offset": offset,
            "limit": limit,
            "has_more": len(items) >= limit,
        }
    except TimeoutError:
        # Keep API worker free for leads / WhatsApp / workspace.
        return {
            "items": [],
            "total": 0,
            "offset": offset,
            "limit": limit,
            "has_more": False,
        }
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, _inbox_error_message(exc)) from exc


@router.post("/search", response_model=InboxMessageListResponse)
def search_inbox_mail(
    payload: InboxMailSearchRequest,
    mailbox_user_id: int | None = Query(default=None),
    user: AppUser = Depends(get_current_user_released),
):
    target = _mailbox_target(user, mailbox_user_id)
    scope = (payload.scope or "inbox").strip().lower()
    try:
        return inbox_module.search_mail(
            target,
            query=payload.query,
            scope=scope,
            limit=payload.limit,
            offset=payload.offset,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, _inbox_error_message(exc)) from exc


@router.post("/ai-query", response_model=InboxMailAiQueryResponse)
def inbox_ai_query(
    payload: InboxMailAiQueryRequest,
    mailbox_user_id: int | None = Query(default=None),
    user: AppUser = Depends(get_current_user_released),
):
    target = _mailbox_target(user, mailbox_user_id)
    try:
        return inbox_mail_ai_module.query_mailbox(
            target,
            question=payload.question,
            unread_only=payload.unread_only,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Mail assistant error: {exc}") from exc


@router.get("/messages/{uid}", response_model=InboxMessageDetail)
def get_inbox_message(
    uid: str,
    folder: str = Query(default="INBOX"),
    mailbox_user_id: int | None = Query(default=None),
    user: AppUser = Depends(get_current_user_released),
):
    target = _mailbox_target(user, mailbox_user_id)
    try:
        message = inbox_module.get_message(target, uid, folder=folder)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Could not read message: {exc}") from exc
    if not message:
        raise HTTPException(404, "Message not found")
    return message


@router.post("/messages/{uid}/read", response_model=InboxUnreadCount)
def mark_inbox_message_read(
    uid: str,
    folder: str = Query(default="INBOX"),
    mailbox_user_id: int | None = Query(default=None),
    user: AppUser = Depends(get_current_user_released),
):
    target = _mailbox_target(user, mailbox_user_id)
    try:
        inbox_module.mark_read(target, uid, True, folder=folder)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Could not update message: {exc}") from exc
    return {"count": inbox_module.unread_count(target)}


@router.post("/messages/{uid}/move", response_model=InboxMoveResponse)
def move_inbox_message(
    uid: str,
    payload: InboxMoveRequest,
    mailbox_user_id: int | None = Query(default=None),
    user: AppUser = Depends(get_current_user_released),
):
    target = _mailbox_target(user, mailbox_user_id)
    to_folder = payload.to_folder.strip().lower()
    if to_folder not in _VALID_FOLDERS:
        raise HTTPException(400, f"to_folder must be one of: {', '.join(sorted(_VALID_FOLDERS))}")
    try:
        result = inbox_module.move_message(
            target,
            uid,
            from_folder=payload.from_folder,
            to_folder=to_folder,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Could not move message: {exc}") from exc
    if result.get("status") != "ok":
        raise HTTPException(502, result.get("message", "Move failed"))
    return {
        "status": result.get("status", "ok"),
        "message": result.get("message", "Moved"),
        "from_folder": result.get("from_folder"),
        "to_folder": result.get("to_folder"),
        "to_folder_key": result.get("to_folder_key"),
        "moved_count": 1,
    }


@router.post("/trash/empty", response_model=InboxEmptyTrashResponse)
def empty_inbox_trash(
    mailbox_user_id: int | None = Query(default=None),
    user: AppUser = Depends(get_current_user_released),
):
    target = _mailbox_target(user, mailbox_user_id)
    try:
        result = inbox_module.empty_trash(target)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Could not empty trash: {exc}") from exc
    if result.get("status") != "ok":
        raise HTTPException(502, result.get("message", "Empty trash failed"))
    return result


class AutoTrashSettingsUpdate(BaseModel):
    enabled: bool = Field(..., description="Turn Auto Trash on/off for this mailbox user")


@router.get("/auto-trash/settings")
def get_auto_trash_settings(
    mailbox_user_id: int | None = Query(default=None),
    user: AppUser = Depends(get_current_user_released),
    db=Depends(get_db),
):
    """Per-mailbox Auto Trash toggle + global learn status."""
    from modules import auto_trash

    target = _resolve_mailbox_user(user, mailbox_user_id)
    try:
        row = auto_trash.get_or_create_settings(db, target.id)
        profile = auto_trash.get_or_create_profile(db)
        return auto_trash.settings_to_dict(row, profile)
    except Exception as exc:  # noqa: BLE001
        print(f"Auto Trash settings read failed: {exc}", flush=True)
        return auto_trash.settings_fallback_dict(target.id)


@router.put("/auto-trash/settings")
def put_auto_trash_settings(
    payload: AutoTrashSettingsUpdate,
    mailbox_user_id: int | None = Query(default=None),
    user: AppUser = Depends(get_current_user_released),
    db=Depends(get_db),
):
    from modules import auto_trash

    target = _resolve_mailbox_user(user, mailbox_user_id)
    try:
        return auto_trash.set_enabled(db, target.id, payload.enabled)
    except Exception as exc:  # noqa: BLE001
        print(f"Auto Trash settings write failed: {exc}", flush=True)
        # Surface a clear error so the UI can roll back optimistic toggle.
        raise HTTPException(
            503,
            "Auto Trash settings are not ready yet. Wait a moment and try again.",
        ) from exc


@router.get("/auto-trash/daily-log")
def get_auto_trash_daily_log(
    days: int = Query(default=14, ge=1, le=90),
    user: AppUser = Depends(get_current_user_released),
    db=Depends(get_db),
):
    """Day-wise counts of emails auto-moved to Trash, broken down by user."""
    _ = user
    from modules import auto_trash

    return auto_trash.daily_stats(db, days=days)


@router.post("/auto-trash/learn")
def run_auto_trash_learn(
    user: AppUser = Depends(get_current_user_released),
    db=Depends(get_db),
):
    """Scan Trash on all configured mailboxes and refresh the global Auto Trash profile."""
    _ = user
    from modules import auto_trash

    return auto_trash.learn_from_trash(db)


@router.post("/messages/{uid}/reply", response_model=InboxReplyResponse)
def reply_inbox_message(
    uid: str,
    payload: InboxReplyRequest,
    mailbox_user_id: int | None = Query(default=None),
    user: AppUser = Depends(get_current_user_released),
):
    from modules import activity as activity_module

    target = _mailbox_target(user, mailbox_user_id)
    try:
        result = inbox_module.reply(
            target,
            uid,
            payload.body,
            folder=payload.folder or "INBOX",
            to=payload.to,
            subject=payload.subject,
            cc=payload.cc,
            bcc=payload.bcc,
            attachments=payload.attachments,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Could not send reply: {exc}") from exc
    if result.get("status") != "sent":
        raise HTTPException(502, result.get("message", "Reply failed"))

    subject = result.get("subject") or payload.subject or "(no subject)"
    to_addr = result.get("to") or payload.to or ""
    db = SessionLocal()
    try:
        activity_module.log_activity(
            db,
            user_id=user.id,
            activity_type=activity_module.INBOX_REPLIED,
            title="Inbox reply sent",
            summary=f"Replied to “{subject}”" + (f" → {to_addr}" if to_addr else ""),
            entity_type="inbox_message",
            entity_id=None,
            details={
                "uid": uid,
                "subject": subject,
                "to": to_addr,
                "mailbox_user_id": int(target.id),
            },
        )
        db.commit()
    finally:
        db.close()
    return result
