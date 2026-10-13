"""Company mailbox client — IMAP receive + SMTP or Microsoft Graph send.

Two outbound modes, chosen automatically from what's configured in backend/.env:
  - Standard SMTP AUTH (username + password) — used for cPanel-hosted mail
    (e.g. mail.kafi-group.com) or any provider with SMTP enabled.
  - Microsoft Graph Mail.Send (OAuth) — used only when MAILBOX_CLIENT_ID +
    MAILBOX_REFRESH_TOKEN are set, since personal @outlook.com mailboxes often
    have SMTP AUTH disabled (5.7.139).
IMAP receive always uses username + password (or OAuth XOAUTH2 when configured).
"""

from __future__ import annotations

import base64
import re
import threading
from contextlib import contextmanager
from datetime import datetime
from typing import Any

import httpx

from config import settings
from modules.inbox_cutoff import as_utc, date_sort_key, get_inbox_since, message_is_after_cutoff
from modules.mailbox_accounts import get_active_mailbox

_HTML_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")

# Outlook personal IMAP often breaks under concurrent sessions from the same account.
_IMAP_LOCKS: dict[str, threading.RLock] = {}
_IMAP_LOCKS_GUARD = threading.Lock()
# Caches keyed by mailbox email so users never share each other's list/unread state.
_FOLDER_COUNT_CACHE: dict[str, dict[str, Any]] = {}
_FOLDER_COUNT_TTL_SEC = 60.0
_UNREAD_CACHE: dict[str, dict[str, Any]] = {}
_UNREAD_TTL_SEC = 45.0
# List endpoints cache (prevents hammering IMAP on tab switches)
_LIST_CACHE: dict[str, Any] = {}
_LIST_CACHE_TTL_SEC = 45.0
# OAuth access tokens — refreshing on every IMAP connect was a large fixed cost.
_TOKEN_CACHE: dict[str, dict[str, Any]] = {}
# Recent conversation summaries reused by get_thread so opening a mail does not
# re-download the whole Inbox+Sent list.
_CONV_SUMMARY_CACHE: dict[str, dict[str, Any]] = {}
_CONV_SUMMARY_TTL_SEC = 60.0


def _account_cache_key() -> str:
    acct = get_active_mailbox()
    if acct and acct.email:
        return acct.email.strip().lower()
    return (settings.mailbox_email or "").strip().lower() or "_default"


@contextmanager
def _imap_lock(timeout: float = 35.0):
    """Per-mailbox lock with timeout so stuck IMAP cannot freeze the API worker."""
    key = _account_cache_key()
    with _IMAP_LOCKS_GUARD:
        lock = _IMAP_LOCKS.get(key)
        if lock is None:
            lock = threading.RLock()
            _IMAP_LOCKS[key] = lock
    acquired = lock.acquire(timeout=timeout)
    if not acquired:
        raise TimeoutError(
            "Mailbox is busy. Contacts, WhatsApp, and workspace still work — retry mail shortly."
        )
    try:
        yield
    finally:
        lock.release()


def _password_auth_help() -> str:
    return (
        "Mailbox login failed. Check this user's mailbox email/password "
        "(Users page) or legacy MAILBOX_EMAIL / MAILBOX_PASSWORD in backend/.env."
    )


def _invalidate_mail_caches(account_key: str | None = None) -> None:
    key = account_key or _account_cache_key()
    _UNREAD_CACHE.pop(key, None)
    _FOLDER_COUNT_CACHE.pop(key, None)
    _CONV_SUMMARY_CACHE.pop(key, None)
    prefix = f"{key}:"
    for cache_key in list(_LIST_CACHE.keys()):
        if cache_key.startswith(prefix):
            _LIST_CACHE.pop(cache_key, None)


def _list_cache_get(key: str) -> list[dict[str, Any]] | None:
    import time

    full = f"{_account_cache_key()}:{key}"
    entry = _LIST_CACHE.get(full)
    if not entry:
        return None
    if time.monotonic() - float(entry.get("at") or 0) > _LIST_CACHE_TTL_SEC:
        return None
    data = entry.get("data")
    return list(data) if isinstance(data, list) else None


def _list_cache_set(key: str, data: list[dict[str, Any]]) -> None:
    import time

    full = f"{_account_cache_key()}:{key}"
    _LIST_CACHE[full] = {"at": time.monotonic(), "data": list(data)}


# Separate audiences — MSAL refreshes one resource at a time.
IMAP_SCOPES = [
    "https://outlook.office.com/IMAP.AccessAsUser.All",
]
GRAPH_SEND_SCOPES = [
    "https://graph.microsoft.com/Mail.Send",
]

# Kept for scripts / docs that import a combined list.
MAILBOX_SCOPES = IMAP_SCOPES + GRAPH_SEND_SCOPES

_SENT_FOLDER_CANDIDATES = (
    "INBOX.Sent",
    "INBOX/Sent",
    "Sent",
    "Sent Items",
    "Sent Messages",
)

_TRASH_FOLDER_CANDIDATES = (
    "INBOX.Trash",
    "INBOX/Trash",
    "Trash",
    "Deleted Items",
    "Deleted",
    "INBOX.Deleted Items",
)

_ARCHIVE_FOLDER_CANDIDATES = (
    "INBOX.Archive",
    "INBOX/Archive",
    "Archive",
    "Archives",
    "Archived",
)

_JUNK_FOLDER_CANDIDATES = (
    "Junk",
    "Junk E-mail",
    "Junk Email",
    "Spam",
    "INBOX.spam",
    "INBOX.Junk",
    "INBOX/Junk",
    "INBOX.Junk Email",
)

# Logical folder keys used by the API / UI.
FOLDER_KEYS = ("inbox", "sent", "trash", "archive", "junk")

_FOLDER_CANDIDATES: dict[str, tuple[str, ...]] = {
    "inbox": ("INBOX",),
    "sent": _SENT_FOLDER_CANDIDATES,
    "trash": _TRASH_FOLDER_CANDIDATES,
    "archive": _ARCHIVE_FOLDER_CANDIDATES,
    "junk": _JUNK_FOLDER_CANDIDATES,
}


def _html_to_preview(html: str) -> str:
    text = _HTML_TAG_RE.sub(" ", html or "")
    return _WS_RE.sub(" ", text).strip()


def _xoauth2_bytes(email: str, access_token: str) -> bytes:
    return f"user={email}\x01auth=Bearer {access_token}\x01\x01".encode()


def _is_sent_folder(folder: str | None) -> bool:
    name = (folder or "").strip().lower()
    if not name:
        return False
    if name.startswith("sent") or name.endswith(".sent") or name.endswith("/sent"):
        return True
    return "sent" in name.split(".") or "sent" in name.split("/")


class OutlookClient:
    def _cred_email(self) -> str | None:
        acct = get_active_mailbox()
        if acct and acct.email:
            return acct.email.strip()
        return (settings.mailbox_email or "").strip() or None

    def _cred_password(self) -> str | None:
        acct = get_active_mailbox()
        if acct and acct.password:
            return acct.password
        return settings.mailbox_password or None

    def _cred_display_name(self) -> str | None:
        acct = get_active_mailbox()
        if acct and acct.display_name:
            return acct.display_name
        return settings.mailbox_display_name or None

    @property
    def is_configured(self) -> bool:
        if not settings.mailbox_enabled:
            return False
        email = self._cred_email()
        if not email:
            return False
        if self._use_oauth() and get_active_mailbox() is None:
            return True
        # Resend HTTPS needs From email only (IMAP password still used for Sent/inbox).
        from integrations.resend_client import resend_configured

        if resend_configured():
            return True
        return bool(self._cred_password())

    def _use_resend(self) -> bool:
        from integrations.resend_client import resend_configured

        return resend_configured()

    def _use_oauth(self) -> bool:
        # Per-user cPanel accounts always use password auth; OAuth is legacy global only.
        if get_active_mailbox() is not None:
            return False
        return bool(
            settings.mailbox_client_id
            and settings.mailbox_refresh_token
        )

    def _authority(self) -> str:
        tenant = (settings.mailbox_tenant_id or "consumers").strip()
        return f"https://login.microsoftonline.com/{tenant}"

    def _msal_app(self):
        try:
            from msal import ConfidentialClientApplication, PublicClientApplication
        except ImportError as exc:
            raise RuntimeError("Install msal: pip install msal") from exc

        authority = self._authority()
        if settings.mailbox_client_secret:
            return ConfidentialClientApplication(
                settings.mailbox_client_id,
                client_credential=settings.mailbox_client_secret,
                authority=authority,
            )
        return PublicClientApplication(settings.mailbox_client_id, authority=authority)

    def _acquire_access_token(self, scopes: list[str] | None = None) -> str:
        if not self._use_oauth():
            raise RuntimeError("Mailbox authentication is not configured")

        import time

        scopes = scopes or IMAP_SCOPES
        cache_key = " ".join(scopes)
        now = time.time()
        cached = _TOKEN_CACHE.get(cache_key)
        if cached and float(cached.get("expires_at") or 0) > now + 60:
            return str(cached["token"])

        app = self._msal_app()
        result = app.acquire_token_by_refresh_token(
            settings.mailbox_refresh_token,
            scopes=scopes,
        )
        if not result or "access_token" not in result:
            detail = (result or {}).get("error_description") or (result or {}).get("error")
            raise RuntimeError(detail or "Mailbox token refresh failed")

        token = str(result["access_token"])
        expires_in = int(result.get("expires_in") or 3600)
        _TOKEN_CACHE[cache_key] = {
            "token": token,
            "expires_at": now + max(120, expires_in),
        }
        return token

    def _ssl_context(self, host: str):
        """TLS context; when connecting by IP, SNI/verify use MAILBOX_SSL_HOSTNAME."""
        import ssl

        ctx = ssl.create_default_context()
        verify_host = (settings.mailbox_ssl_hostname or "").strip() or None
        # Only override when host is not already the cert hostname.
        if verify_host and verify_host != host:
            return ctx, verify_host
        return ctx, None

    def _connect_imap(self):
        import imaplib
        import socket

        from imap_tools import MailBox

        host = settings.mailbox_imap_host
        port = settings.mailbox_imap_port
        ssl_context, server_hostname = self._ssl_context(host)
        # Hard cap so a hung IMAP server cannot pin the only uvicorn worker.
        imap_timeout = 25

        if server_hostname:

            class _IMAP4_SSL(imaplib.IMAP4_SSL):
                def _create_socket(self, timeout):  # noqa: ANN001
                    sock = socket.create_connection(
                        (self.host, self.port),
                        timeout if timeout is not None else imap_timeout,
                    )
                    return ssl_context.wrap_socket(sock, server_hostname=server_hostname)

            client = _IMAP4_SSL(host, port, timeout=imap_timeout)
        else:
            client = imaplib.IMAP4_SSL(
                host, port, ssl_context=ssl_context, timeout=imap_timeout
            )

        if self._use_oauth():
            token = self._acquire_access_token(IMAP_SCOPES)
            client.authenticate(
                "XOAUTH2",
                lambda _challenge: _xoauth2_bytes(self._cred_email() or "", token),
            )
        else:
            password = self._cred_password()
            email = self._cred_email()
            if not password or not email:
                raise RuntimeError("Mailbox password is not configured")
            try:
                login_result = client.login(email, password)
            except Exception as exc:
                raise RuntimeError(_password_auth_help()) from exc
            if login_result[0] != "OK":
                raise RuntimeError(_password_auth_help())

        mailbox = MailBox(host, port)
        mailbox.client = client
        mailbox.folder.set("INBOX")
        return mailbox

    def _mailbox(self, folder: str = "INBOX"):
        if not self.is_configured:
            raise RuntimeError(
                "Mailbox is not enabled. Set MAILBOX_ENABLED=true and configure "
                "this user's mailbox email/password (or legacy MAILBOX_EMAIL in .env)."
            )
        mailbox = self._connect_imap()
        if folder and folder != "INBOX":
            mailbox.folder.set(folder)
        return mailbox

    def _folder_status_counts(self, mailbox, imap_name: str) -> tuple[int, int]:
        """Return (total_messages, unseen) via IMAP STATUS — avoids fetching bodies."""
        try:
            code, data = mailbox.client.status(imap_name, "(MESSAGES UNSEEN)")
            if code != "OK" or not data:
                return 0, 0
            raw = data[0]
            text = raw.decode("utf-8", errors="ignore") if isinstance(raw, (bytes, bytearray)) else str(raw)
            messages = 0
            unseen = 0
            match_msg = re.search(r"MESSAGES\s+(\d+)", text, re.IGNORECASE)
            match_unseen = re.search(r"UNSEEN\s+(\d+)", text, re.IGNORECASE)
            if match_msg:
                messages = int(match_msg.group(1))
            if match_unseen:
                unseen = int(match_unseen.group(1))
            return messages, unseen
        except Exception:  # noqa: BLE001
            return 0, 0

    def _list_folder_names(self, mailbox) -> set[str]:
        try:
            return {f.name for f in mailbox.folder.list()}
        except Exception:  # noqa: BLE001
            return set()

    def _resolve_folder_name(
        self,
        mailbox,
        folder_key: str,
        *,
        names: set[str] | None = None,
    ) -> str | None:
        """Map a logical folder key (inbox/sent/trash/archive) to an IMAP folder name."""
        key = (folder_key or "inbox").strip().lower()
        if key == "inbox":
            return "INBOX"
        candidates = _FOLDER_CANDIDATES.get(key)
        if not candidates:
            return None
        if names is None:
            names = self._list_folder_names(mailbox)
        for candidate in candidates:
            if candidate in names:
                return candidate
        lower_map = {n.lower(): n for n in names}
        for candidate in candidates:
            if candidate.lower() in lower_map:
                return lower_map[candidate.lower()]
        # Fuzzy: folder name contains the key word (e.g. "Deleted Items")
        needles = {
            "sent": ("sent",),
            "trash": ("trash", "deleted"),
            "archive": ("archive",),
            "junk": ("junk", "spam"),
        }.get(key, ())
        for needle in needles:
            for name in names:
                if needle in name.lower():
                    return name
        return None

    def _resolve_sent_folder(self, mailbox) -> str | None:
        return self._resolve_folder_name(mailbox, "sent")

    def resolve_folders(self) -> dict[str, str | None]:
        """Return logical key → IMAP folder name (or None if missing)."""
        with _imap_lock():
            mailbox = self._mailbox("INBOX")
            try:
                names = self._list_folder_names(mailbox)
                return {
                    key: self._resolve_folder_name(mailbox, key, names=names)
                    for key in FOLDER_KEYS
                }
            finally:
                try:
                    mailbox.logout()
                except Exception:  # noqa: BLE001
                    pass

    def folder_counts(self, *, limit: int = 100) -> dict[str, dict[str, Any]]:
        """Counts + resolved IMAP names for sidebar badges."""
        import time

        now = time.monotonic()
        cache_key = _account_cache_key()
        cached_entry = _FOLDER_COUNT_CACHE.get(cache_key)
        if (
            cached_entry is not None
            and cached_entry.get("data") is not None
            and now - float(cached_entry.get("at") or 0) < _FOLDER_COUNT_TTL_SEC
        ):
            return cached_entry["data"]

        with _imap_lock():
            mailbox = self._mailbox("INBOX")
            try:
                names = self._list_folder_names(mailbox)
                resolved = {
                    key: self._resolve_folder_name(mailbox, key, names=names)
                    for key in FOLDER_KEYS
                }
                out: dict[str, dict[str, Any]] = {}
                for key, imap_name in resolved.items():
                    if not imap_name:
                        out[key] = {
                            "key": key,
                            "imap_name": None,
                            "available": False,
                            "count": 0,
                            "unread_count": 0,
                        }
                        continue
                    total, unseen = self._folder_status_counts(mailbox, imap_name)
                    # STATUS returns mailbox totals (fine for badges). Cap display noise.
                    out[key] = {
                        "key": key,
                        "imap_name": imap_name,
                        "available": True,
                        "count": min(int(total), max(limit, 1) * 50),
                        "unread_count": int(unseen),
                    }
                _FOLDER_COUNT_CACHE[cache_key] = {
                    "at": time.monotonic(),
                    "data": out,
                }
                return out
            finally:
                try:
                    mailbox.logout()
                except Exception:  # noqa: BLE001
                    pass

    def list_folder_messages(
        self,
        folder_key: str = "inbox",
        *,
        limit: int = 50,
        offset: int = 0,
        unread_only: bool = False,
        search_text: str | None = None,
    ) -> list[dict[str, Any]]:
        key = (folder_key or "inbox").strip().lower()
        if key not in FOLDER_KEYS:
            raise ValueError(f"Unknown folder: {folder_key}")

        with _imap_lock():
            mailbox = self._mailbox("INBOX")
            try:
                imap_name = self._resolve_folder_name(mailbox, key)
                if not imap_name:
                    return []
                # Sent/Trash/Archive ignore the "new mail only" cutoff so history stays visible.
                apply_cutoff = key == "inbox" and not search_text
                summaries = self._fetch_folder(
                    mailbox,
                    imap_name,
                    limit=limit,
                    offset=offset,
                    unread_only=unread_only,
                    since_date=None if apply_cutoff else datetime(2000, 1, 1).date(),
                    search_text=search_text,
                )
            finally:
                try:
                    mailbox.logout()
                except Exception:  # noqa: BLE001
                    pass

        if key == "inbox" and not search_text:
            summaries = [m for m in summaries if message_is_after_cutoff(m.get("date"))]
        return summaries[:limit]

    def move_message(
        self,
        uid: str,
        *,
        from_folder: str,
        to_folder_key: str,
    ) -> dict[str, Any]:
        """Move a message from an IMAP folder name into a logical destination folder."""
        to_key = (to_folder_key or "").strip().lower()
        if to_key not in FOLDER_KEYS:
            return {"status": "error", "message": f"Unknown destination folder: {to_folder_key}"}

        source = (from_folder or "INBOX").strip() or "INBOX"
        with _imap_lock():
            mailbox = self._mailbox(source)
            try:
                dest = self._resolve_folder_name(mailbox, to_key)
                if not dest:
                    return {
                        "status": "error",
                        "message": f"Destination folder '{to_key}' was not found on this mailbox",
                    }
                if source.lower() == dest.lower():
                    return {
                        "status": "ok",
                        "message": "Already in destination folder",
                        "from_folder": source,
                        "to_folder": dest,
                        "to_folder_key": to_key,
                    }
                mailbox.folder.set(source)
                mailbox.move(str(uid), dest)
                _invalidate_mail_caches()
                return {
                    "status": "ok",
                    "message": f"Moved to {to_key}",
                    "from_folder": source,
                    "to_folder": dest,
                    "to_folder_key": to_key,
                }
            except Exception as exc:  # noqa: BLE001
                return {"status": "error", "message": f"Could not move message: {exc}"}
            finally:
                try:
                    mailbox.logout()
                except Exception:  # noqa: BLE001
                    pass

    def empty_trash(self) -> dict[str, Any]:
        """Permanently delete all messages currently in Trash / Deleted Items."""
        with _imap_lock():
            mailbox = self._mailbox("INBOX")
            try:
                trash = self._resolve_folder_name(mailbox, "trash")
                if not trash:
                    return {
                        "status": "error",
                        "message": "Trash folder was not found on this mailbox",
                        "deleted_count": 0,
                    }
                mailbox.folder.set(trash)
                from imap_tools import AND

                uids = [
                    str(m.uid)
                    for m in mailbox.fetch(
                        AND(all=True),
                        mark_seen=False,
                        bulk=True,
                        headers_only=True,
                    )
                ]
                if not uids:
                    return {
                        "status": "ok",
                        "message": "Trash is already empty",
                        "deleted_count": 0,
                    }
                mailbox.delete(uids)
                try:
                    mailbox.expunge()
                except Exception:  # noqa: BLE001
                    pass
                _invalidate_mail_caches()
                return {
                    "status": "ok",
                    "message": f"Deleted {len(uids)} message{'s' if len(uids) != 1 else ''}",
                    "deleted_count": len(uids),
                }
            except Exception as exc:  # noqa: BLE001
                return {
                    "status": "error",
                    "message": f"Could not empty trash: {exc}",
                    "deleted_count": 0,
                }
            finally:
                try:
                    mailbox.logout()
                except Exception:  # noqa: BLE001
                    pass

    def _header(self, msg, *names: str) -> str | None:
        obj = msg.obj
        for name in names:
            value = obj.get(name)
            if value:
                return str(value)
        return None

    def _direction(self, from_email: str | None, folder: str) -> str:
        mailbox_email = (self._cred_email() or "").strip().lower()
        if _is_sent_folder(folder):
            return "outbound"
        if from_email and mailbox_email and from_email.strip().lower() == mailbox_email:
            return "outbound"
        return "inbound"

    def _summarize(self, msg, *, folder: str = "INBOX") -> dict[str, Any]:
        # List fetches use headers_only — body/preview may be empty until detail open.
        preview = (msg.text or "").strip()
        if not preview and msg.html:
            preview = _html_to_preview(msg.html)
        from_name = msg.from_values.name if msg.from_values else ""
        from_email = msg.from_
        to_addrs = [addr.email for addr in (msg.to_values or []) if addr.email]
        cc_addrs = [addr.email for addr in (msg.cc_values or []) if addr.email]
        # BCC is usually stripped for recipients; still expose when the mailbox
        # retains the header (common on Sent items).
        bcc_addrs = [
            addr.email
            for addr in (getattr(msg, "bcc_values", None) or [])
            if getattr(addr, "email", None)
        ]
        if not bcc_addrs:
            bcc_raw = self._header(msg, "Bcc", "BCC") or ""
            bcc_addrs = [
                part.strip()
                for part in bcc_raw.replace(";", ",").split(",")
                if "@" in part
            ]
        return {
            "uid": str(msg.uid),
            "folder": folder,
            "subject": msg.subject or "(no subject)",
            "from_email": from_email,
            "from_name": from_name or None,
            "to": to_addrs,
            "cc": cc_addrs,
            "bcc": bcc_addrs,
            "date": as_utc(msg.date),
            "preview": preview[:240],
            "unread": "\\Seen" not in msg.flags,
            "flags": [str(x) for x in (getattr(msg, "flags", None) or [])],
            "has_attachments": bool(getattr(msg, "attachments", None)),
            "message_id": self._header(msg, "Message-ID", "Message-Id"),
            "in_reply_to": self._header(msg, "In-Reply-To"),
            "references": self._header(msg, "References"),
            "direction": self._direction(from_email, folder),
        }

    def _detail_from_msg(self, msg, *, folder: str = "INBOX") -> dict[str, Any]:
        data = self._summarize(msg, folder=folder)
        data.update(
            {
                "body_text": msg.text or None,
                "body_html": msg.html or None,
                "attachments": [
                    {"filename": att.filename, "size": att.size, "content_type": att.content_type}
                    for att in msg.attachments
                ],
            }
        )
        return data

    def _fetch_folder(
        self,
        mailbox,
        folder: str,
        *,
        limit: int,
        offset: int = 0,
        unread_only: bool = False,
        since_date=None,
        headers_only: bool = True,
        search_text: str | None = None,
    ) -> list[dict[str, Any]]:
        from imap_tools import AND

        from modules.inbox_cutoff import get_inbox_since, has_active_cutoff

        try:
            mailbox.folder.set(folder)
        except Exception:  # noqa: BLE001
            return []

        if since_date is None and has_active_cutoff():
            since_date = get_inbox_since().date()

        text = (search_text or "").strip()
        if text:
            text_criteria = AND(text=text)
            if unread_only and since_date is not None:
                criteria = AND(text=text, date_gte=since_date, seen=False)
            elif unread_only:
                criteria = AND(text=text, seen=False)
            elif since_date is not None:
                criteria = AND(text=text, date_gte=since_date)
            else:
                criteria = text_criteria
        elif unread_only and since_date is not None:
            criteria = AND(date_gte=since_date, seen=False)
        elif unread_only:
            criteria = AND(seen=False)
        elif since_date is not None:
            criteria = AND(date_gte=since_date)
        else:
            criteria = AND(all=True)

        fetch_limit = max(1, int(limit) + max(0, int(offset)))

        def _run(fetch_criteria):
            return list(
                mailbox.fetch(
                    fetch_criteria,
                    limit=fetch_limit,
                    reverse=True,
                    mark_seen=False,
                    bulk=True,
                    headers_only=headers_only,
                )
            )

        try:
            messages = _run(criteria)
        except Exception:  # noqa: BLE001
            # Some servers reject ALL; fall back to a wide date window.
            try:
                if text:
                    fallback = AND(text=text, date_gte=datetime(2000, 1, 1).date())
                else:
                    fallback = (
                        AND(date_gte=datetime(2000, 1, 1).date(), seen=False)
                        if unread_only
                        else AND(date_gte=datetime(2000, 1, 1).date())
                    )
                messages = _run(fallback)
            except Exception:  # noqa: BLE001
                return []
        if headers_only:
            rows = [self._summarize(m, folder=folder) for m in messages]
        else:
            rows = [self._detail_from_msg(m, folder=folder) for m in messages]
        start = max(0, int(offset))
        end = start + max(1, int(limit))
        return rows[start:end]

    def list_messages(
        self,
        *,
        limit: int = 25,
        offset: int = 0,
        unread_only: bool = False,
        search_text: str | None = None,
    ) -> list[dict[str, Any]]:
        cache_key = f"list_messages:{limit}:{offset}:{int(unread_only)}:{search_text or ''}"
        if not search_text:
            cached = _list_cache_get(cache_key)
            if cached is not None:
                return cached[:limit]

        with _imap_lock():
            mailbox = self._mailbox("INBOX")
            try:
                summaries = self._fetch_folder(
                    mailbox,
                    "INBOX",
                    limit=limit,
                    offset=offset,
                    unread_only=unread_only,
                    headers_only=True,
                    search_text=search_text,
                )
            finally:
                try:
                    mailbox.logout()
                except Exception:  # noqa: BLE001
                    pass
        if not search_text:
            filtered = [m for m in summaries if message_is_after_cutoff(m.get("date"))]
            result = filtered[:limit]
            _list_cache_set(cache_key, result)
            return result
        return [m for m in summaries if message_is_after_cutoff(m.get("date"))][:limit]

    def list_inbox_for_query_scan(self, *, limit: int = 10) -> list[dict[str, Any]]:
        """Fresh INBOX pull for New Lead scan — no cache, latest N read+unread, full bodies."""
        _invalidate_mail_caches()
        fetch_limit = max(1, min(int(limit or 10), 50))
        with _imap_lock():
            mailbox = self._mailbox("INBOX")
            try:
                rows = self._fetch_folder(
                    mailbox,
                    "INBOX",
                    limit=fetch_limit,
                    unread_only=False,
                    headers_only=False,
                )
            finally:
                try:
                    mailbox.logout()
                except Exception:  # noqa: BLE001
                    pass
        filtered = [m for m in rows if message_is_after_cutoff(m.get("date"))]
        return filtered[:fetch_limit]

    def list_conversation_messages(
        self,
        *,
        limit: int = 50,
        offset: int = 0,
        unread_only: bool = False,
        search_text: str | None = None,
    ) -> list[dict[str, Any]]:
        """Inbox + Sent message headers for conversation threading (no full bodies)."""
        import time

        if search_text:
            offset = 0

        cache_key = f"list_conversation:{limit}:{offset}:{int(unread_only)}:{search_text or ''}"
        if not search_text:
            cached = _list_cache_get(cache_key)
            if cached is not None:
                return cached

        # Reuse a fresh full-scan cache when a smaller limit is requested.
        now = time.monotonic()
        conv = _CONV_SUMMARY_CACHE.get(_account_cache_key()) or {}
        if (
            not unread_only
            and not search_text
            and offset == 0
            and conv.get("data") is not None
            and int(conv.get("limit") or 0) >= limit
            and now - float(conv.get("at") or 0) < _CONV_SUMMARY_TTL_SEC
        ):
            data = list(conv["data"])[: max(limit * 2, limit)]
            _list_cache_set(cache_key, data)
            return data

        with _imap_lock():
            mailbox = self._mailbox("INBOX")
            try:
                per_folder = max(limit + offset, limit, 1)
                per_folder = min(per_folder, 500)
                inbox = self._fetch_folder(
                    mailbox,
                    "INBOX",
                    limit=per_folder,
                    offset=0 if search_text else 0,
                    unread_only=unread_only,
                    headers_only=True,
                    search_text=search_text,
                )
                sent: list[dict[str, Any]] = []
                if not search_text:
                    sent_folder = self._resolve_sent_folder(mailbox)
                    if sent_folder:
                        sent = self._fetch_folder(
                            mailbox,
                            sent_folder,
                            limit=per_folder,
                            offset=0,
                            unread_only=False,
                            headers_only=True,
                        )
            finally:
                try:
                    mailbox.logout()
                except Exception:  # noqa: BLE001
                    pass

        combined = inbox + sent
        combined = [
            m
            for m in combined
            if not any(
                marker in str(m.get("folder") or "").lower()
                for marker in ("spam", "junk", "trash", "deleted")
            )
        ]
        filtered = [m for m in combined if message_is_after_cutoff(m.get("date"))]
        # Dedupe by message-id when both copies exist.
        seen_ids: set[str] = set()
        unique: list[dict[str, Any]] = []
        for msg in sorted(filtered, key=lambda m: date_sort_key(m.get("date")), reverse=True):
            mid = (msg.get("message_id") or "").strip().lower()
            if mid:
                if mid in seen_ids:
                    continue
                seen_ids.add(mid)
            unique.append(msg)

        if not search_text and offset:
            unique = unique[offset:]
        elif not search_text:
            unique = unique[: per_folder]

        _list_cache_set(cache_key, unique)
        if not unread_only and not search_text and offset == 0:
            acct_k = _account_cache_key()
            _CONV_SUMMARY_CACHE[acct_k] = {
                "at": time.monotonic(),
                "limit": limit,
                "data": list(unique),
            }
            inbox_unseen = sum(1 for m in inbox if m.get("unread") or m.get("seen") is False)
            _UNREAD_CACHE[acct_k] = {"at": time.monotonic(), "count": inbox_unseen}
        return unique

    def _imap_folder_for(self, mailbox, folder: str | None) -> str:
        """Map logical keys (inbox/sent/…) or raw IMAP names to a selectable folder."""
        raw = (folder or "INBOX").strip() or "INBOX"
        key = raw.lower()
        if key in FOLDER_KEYS:
            return self._resolve_folder_name(mailbox, key) or (
                "INBOX" if key == "inbox" else raw
            )
        if key == "inbox":
            return "INBOX"
        return raw

    def get_message(self, uid: str, *, folder: str = "INBOX") -> dict[str, Any] | None:
        from imap_tools import AND

        with _imap_lock():
            mailbox = self._mailbox("INBOX")
            try:
                imap_folder = self._imap_folder_for(mailbox, folder)
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
        return self._detail_from_msg(messages[0], folder=folder)

    def get_messages_by_keys(
        self,
        keys: list[str],
        *,
        headers_only: bool = False,
    ) -> list[dict[str, Any]]:
        """Fetch messages for folder:uid keys in one IMAP session (batched)."""
        from imap_tools import AND

        grouped: dict[str, list[str]] = {}
        for key in keys:
            if ":" not in key:
                grouped.setdefault("inbox", []).append(key)
                continue
            folder, uid = key.split(":", 1)
            grouped.setdefault((folder or "inbox").strip() or "inbox", []).append(uid)

        out: list[dict[str, Any]] = []
        with _imap_lock():
            mailbox = self._mailbox("INBOX")
            try:
                for folder_key, uids in grouped.items():
                    if not uids:
                        continue
                    imap_folder = self._imap_folder_for(mailbox, folder_key)
                    try:
                        mailbox.folder.set(imap_folder)
                    except Exception:  # noqa: BLE001
                        continue
                    # Batch UID FETCH instead of one round-trip per message.
                    uid_set = ",".join(str(u) for u in uids)
                    try:
                        messages = list(
                            mailbox.fetch(
                                AND(uid=uid_set),
                                mark_seen=False,
                                bulk=True,
                                headers_only=headers_only,
                            )
                        )
                    except Exception:  # noqa: BLE001
                        messages = []
                        for uid in uids:
                            try:
                                messages.extend(
                                    mailbox.fetch(
                                        AND(uid=str(uid)),
                                        mark_seen=False,
                                        bulk=False,
                                        headers_only=headers_only,
                                    )
                                )
                            except Exception:  # noqa: BLE001
                                continue
                    for msg in messages:
                        # Keep logical folder key for label assignment matching.
                        logical = (folder_key or "inbox").strip().lower() or "inbox"
                        display_folder = logical if logical in FOLDER_KEYS else imap_folder
                        if headers_only:
                            out.append(self._summarize(msg, folder=display_folder))
                        else:
                            out.append(self._detail_from_msg(msg, folder=display_folder))
            finally:
                try:
                    mailbox.logout()
                except Exception:  # noqa: BLE001
                    pass
        out.sort(key=lambda m: date_sort_key(m.get("date")))
        return out

    def unread_count(self) -> int:
        import time

        now = time.monotonic()
        cache_key = _account_cache_key()
        cached = _UNREAD_CACHE.get(cache_key)
        if cached is not None and now - float(cached.get("at") or 0) < _UNREAD_TTL_SEC:
            return int(cached.get("count") or 0)

        with _imap_lock():
            mailbox = self._mailbox("INBOX")
            try:
                _total, unseen = self._folder_status_counts(mailbox, "INBOX")
            finally:
                try:
                    mailbox.logout()
                except Exception:  # noqa: BLE001
                    pass
        _UNREAD_CACHE[cache_key] = {"at": time.monotonic(), "count": unseen}
        return unseen

    def mark_read(self, uid: str, seen: bool = True, *, folder: str = "INBOX") -> None:
        self.mark_read_many([(folder, str(uid))], seen=seen)

    def mark_read_many(
        self, items: list[tuple[str, str]], *, seen: bool = True
    ) -> None:
        """Flag many messages seen/unseen in one IMAP session (grouped by folder)."""
        from imap_tools import MailMessageFlags

        if not items:
            return

        grouped: dict[str, list[str]] = {}
        for folder, uid in items:
            grouped.setdefault(folder or "INBOX", []).append(str(uid))

        with _imap_lock():
            mailbox = self._mailbox("INBOX")
            try:
                for folder, uids in grouped.items():
                    try:
                        mailbox.folder.set(folder)
                    except Exception:  # noqa: BLE001
                        continue
                    try:
                        mailbox.flag(uids, MailMessageFlags.SEEN, seen)
                    except Exception:  # noqa: BLE001
                        for uid in uids:
                            try:
                                mailbox.flag(str(uid), MailMessageFlags.SEEN, seen)
                            except Exception:  # noqa: BLE001
                                continue
                _invalidate_mail_caches()
            finally:
                try:
                    mailbox.logout()
                except Exception:  # noqa: BLE001
                    pass

    def _graph_file_attachments(self, attachments: list[dict]) -> list[dict[str, Any]] | dict[str, Any]:
        """Build Graph fileAttachment payloads, or return an error dict."""
        from modules.email_attachments import load_bytes

        out: list[dict[str, Any]] = []
        for meta in attachments:
            try:
                data, filename, content_type = load_bytes(meta)
            except FileNotFoundError as exc:
                return {"status": "error", "message": str(exc)}
            out.append(
                {
                    "@odata.type": "#microsoft.graph.fileAttachment",
                    "name": filename,
                    "contentType": content_type,
                    "contentBytes": base64.b64encode(data).decode("ascii"),
                }
            )
        return out

    def _send_smtp(
        self,
        *,
        to: str,
        subject: str,
        body: str,
        cc: str | None = None,
        bcc: str | None = None,
        attachments: list[dict] | None = None,
        interaction_id: int | None = None,
        send_mode: str = "individual",
    ) -> dict[str, Any]:
        """Send via standard SMTP AUTH — works for cPanel-hosted mail (e.g. mail.kafi-group.com)
        or any provider with SMTP enabled. Uses implicit SSL on port 465, STARTTLS otherwise."""
        import smtplib
        from email import encoders, utils as email_utils
        from email.mime.base import MIMEBase
        from email.mime.multipart import MIMEMultipart
        from email.mime.text import MIMEText

        from modules.email_attachments import load_bytes
        from modules.email_tracking import build_tracked_bodies_with_inline

        if not self._cred_password():
            return {
                "status": "error",
                "message": "Mailbox password is not configured. Set MAILBOX_PASSWORD in backend/.env.",
            }

        from_addr = self._cred_email()
        display_name = self._cred_display_name()
        plain_body, html_body, inline_images = build_tracked_bodies_with_inline(
            body,
            interaction_id=interaction_id,
            send_mode=send_mode,
        )

        def _split_addrs(raw: str | None) -> list[str]:
            if not raw:
                return []
            return [
                part.strip()
                for part in raw.replace(";", ",").split(",")
                if part.strip() and "@" in part
            ]

        message = MIMEMultipart("mixed")
        message["From"] = f"{display_name} <{from_addr}>" if display_name else from_addr
        message["To"] = to
        if cc:
            message["Cc"] = cc
        if bcc:
            message["Bcc"] = bcc
        message["Subject"] = subject
        message["Date"] = email_utils.formatdate(localtime=True)
        message["Message-ID"] = email_utils.make_msgid(
            domain=(from_addr or "localhost").split("@")[-1]
        )

        if html_body:
            if inline_images:
                related = MIMEMultipart("related")
                alt = MIMEMultipart("alternative")
                alt.attach(MIMEText(plain_body, "plain", "utf-8"))
                alt.attach(MIMEText(html_body, "html", "utf-8"))
                related.attach(alt)
                for img in inline_images:
                    ctype = str(img.get("content_type") or "image/png")
                    maintype, _, subtype = ctype.partition("/")
                    part = MIMEBase(maintype or "image", subtype or "png")
                    part.set_payload(img["data"])
                    encoders.encode_base64(part)
                    cid = str(img.get("cid") or "").strip()
                    filename = str(img.get("filename") or "inline.png")
                    part.add_header("Content-ID", f"<{cid}>")
                    part.add_header(
                        "Content-Disposition",
                        "inline",
                        filename=filename,
                    )
                    related.attach(part)
                message.attach(related)
            else:
                alt = MIMEMultipart("alternative")
                alt.attach(MIMEText(plain_body, "plain", "utf-8"))
                alt.attach(MIMEText(html_body, "html", "utf-8"))
                message.attach(alt)
        else:
            message.attach(MIMEText(plain_body, "plain", "utf-8"))

        for meta in attachments or []:
            try:
                data, filename, content_type = load_bytes(meta)
            except FileNotFoundError as exc:
                return {"status": "error", "message": str(exc)}
            maintype, _, subtype = (content_type or "application/octet-stream").partition("/")
            part = MIMEBase(maintype or "application", subtype or "octet-stream")
            part.set_payload(data)
            encoders.encode_base64(part)
            part.add_header("Content-Disposition", f'attachment; filename="{filename}"')
            message.attach(part)

        recipients = _split_addrs(to) + _split_addrs(cc) + _split_addrs(bcc)
        if not recipients:
            recipients = [to]
        host = settings.mailbox_smtp_host
        port = settings.mailbox_smtp_port
        ssl_context, server_hostname = self._ssl_context(host)
        raw = message.as_bytes() if hasattr(message, "as_bytes") else message.as_string().encode("utf-8")

        try:
            import socket

            server: smtplib.SMTP
            if port == 465:
                if server_hostname:

                    class _SMTP_SSL(smtplib.SMTP_SSL):
                        def _get_socket(self, host, port, timeout):  # noqa: ANN001
                            sock = socket.create_connection((host, port), timeout)
                            return ssl_context.wrap_socket(
                                sock, server_hostname=server_hostname
                            )

                    server = _SMTP_SSL(host, port, timeout=30, context=ssl_context)
                else:
                    server = smtplib.SMTP_SSL(
                        host, port, timeout=30, context=ssl_context
                    )
            else:
                server = smtplib.SMTP(host, port, timeout=30)
                server.ehlo()
                if server_hostname:
                    # starttls wraps with context; set _host so SNI uses cert hostname
                    server._host = server_hostname  # noqa: SLF001
                server.starttls(context=ssl_context)
                server.ehlo()
            try:
                server.login(self._cred_email(), self._cred_password())
                refused = server.sendmail(from_addr, recipients, message.as_string())
            finally:
                try:
                    server.quit()
                except Exception:  # noqa: BLE001
                    pass
            if refused:
                detail = "; ".join(
                    f"{addr}: {err}" for addr, err in refused.items()
                ) or str(refused)
                return {
                    "status": "error",
                    "error_type": "invalid_recipient",
                    "message": (
                        f"Email not sent — recipient rejected or no longer exists. {detail}"
                    ),
                    "to": to,
                    "subject": subject,
                }
        except smtplib.SMTPRecipientsRefused as exc:
            detail = "; ".join(
                f"{addr}: {err}" for addr, err in (exc.recipients or {}).items()
            ) or str(exc)
            return {
                "status": "error",
                "error_type": "invalid_recipient",
                "message": (
                    f"Email not sent — address is invalid or no longer exists. {detail}"
                ),
                "to": to,
                "subject": subject,
            }
        except Exception as exc:  # noqa: BLE001
            err = str(exc)
            lower = err.lower()
            if "timed out" in lower or "timeout" in lower:
                return {
                    "status": "error",
                    "message": (
                        "SMTP send failed: timed out. "
                        "Railway Hobby blocks outbound SMTP (ports 25/465/587). "
                        "Set MAILER_HANDOFF_SECRET + MAILER_PUBLIC_URL so sends go "
                        "through the Vercel mailer, or set RESEND_API_KEY, or upgrade "
                        f"Railway to Pro. Detail: {err}"
                    ),
                }
            # Some SMTP servers raise generic SMTPResponseException (550 user unknown).
            if isinstance(exc, smtplib.SMTPResponseException) and int(getattr(exc, "smtp_code", 0) or 0) in {
                550,
                551,
                552,
                553,
            }:
                return {
                    "status": "error",
                    "error_type": "invalid_recipient",
                    "message": f"Email not sent — recipient rejected ({exc.smtp_code}): {err}",
                    "to": to,
                    "subject": subject,
                }
            return {"status": "error", "message": f"SMTP send failed: {err}"}

        # cPanel/SMTP does not auto-save to Sent — append a copy via IMAP.
        try:
            self._append_to_sent(raw)
        except Exception:  # noqa: BLE001
            pass
        _invalidate_mail_caches()

        return {"status": "sent", "message": "Email sent", "to": to, "subject": subject}

    def _send_resend(
        self,
        *,
        to: str,
        subject: str,
        body: str,
        cc: str | None = None,
        bcc: str | None = None,
        attachments: list[dict] | None = None,
        interaction_id: int | None = None,
        send_mode: str = "individual",
        in_reply_to: str | None = None,
        references: str | None = None,
    ) -> dict[str, Any]:
        """Send via Resend HTTPS — works on Railway Hobby (SMTP ports blocked)."""
        from email import encoders, utils as email_utils
        from email.mime.base import MIMEBase
        from email.mime.multipart import MIMEMultipart
        from email.mime.text import MIMEText

        from integrations.resend_client import send_via_resend
        from modules.email_attachments import load_bytes
        from modules.email_tracking import build_tracked_bodies_with_inline

        from_addr = self._cred_email()
        if not from_addr:
            return {
                "status": "error",
                "message": (
                    "No From address. Set this user's company mailbox email "
                    "(Users page) so Resend can send as @kafi-group.com."
                ),
            }
        display_name = self._cred_display_name()
        plain_body, html_body, inline_images = build_tracked_bodies_with_inline(
            body,
            interaction_id=interaction_id,
            send_mode=send_mode,
        )
        headers: dict[str, str] = {}
        if in_reply_to:
            headers["In-Reply-To"] = in_reply_to
        if references:
            headers["References"] = references

        # Resend inline images: pass as attachments with content_id matching cid: in HTML.
        resend_attachments = list(attachments or [])
        for img in inline_images:
            resend_attachments.append(
                {
                    "filename": img.get("filename") or "inline.png",
                    "content_type": img.get("content_type") or "image/png",
                    "content_id": img.get("cid"),
                    "bytes": img.get("data"),
                }
            )

        result = send_via_resend(
            from_email=from_addr,
            from_name=display_name,
            to=to,
            subject=subject,
            plain_body=plain_body,
            html_body=html_body,
            cc=cc,
            bcc=bcc,
            attachments=resend_attachments,
            headers=headers or None,
        )
        if result.get("status") != "sent":
            return result

        # Best-effort copy into IMAP Sent (993 is not blocked like SMTP on Hobby).
        try:
            message = MIMEMultipart("mixed")
            message["From"] = f"{display_name} <{from_addr}>" if display_name else from_addr
            message["To"] = to
            if cc:
                message["Cc"] = cc
            if bcc:
                message["Bcc"] = bcc
            message["Subject"] = subject
            message["Date"] = email_utils.formatdate(localtime=True)
            message["Message-ID"] = email_utils.make_msgid(
                domain=from_addr.split("@")[-1]
            )
            if html_body:
                if inline_images:
                    related = MIMEMultipart("related")
                    alt = MIMEMultipart("alternative")
                    alt.attach(MIMEText(plain_body, "plain", "utf-8"))
                    alt.attach(MIMEText(html_body, "html", "utf-8"))
                    related.attach(alt)
                    for img in inline_images:
                        ctype = str(img.get("content_type") or "image/png")
                        maintype, _, subtype = ctype.partition("/")
                        part = MIMEBase(maintype or "image", subtype or "png")
                        part.set_payload(img["data"])
                        encoders.encode_base64(part)
                        cid = str(img.get("cid") or "").strip()
                        filename = str(img.get("filename") or "inline.png")
                        part.add_header("Content-ID", f"<{cid}>")
                        part.add_header(
                            "Content-Disposition",
                            "inline",
                            filename=filename,
                        )
                        related.attach(part)
                    message.attach(related)
                else:
                    alt = MIMEMultipart("alternative")
                    alt.attach(MIMEText(plain_body, "plain", "utf-8"))
                    alt.attach(MIMEText(html_body, "html", "utf-8"))
                    message.attach(alt)
            else:
                message.attach(MIMEText(plain_body, "plain", "utf-8"))
            for meta in attachments or []:
                try:
                    data, filename, content_type = load_bytes(meta)
                except FileNotFoundError:
                    continue
                maintype, _, subtype = (content_type or "application/octet-stream").partition(
                    "/"
                )
                part = MIMEBase(maintype or "application", subtype or "octet-stream")
                part.set_payload(data)
                encoders.encode_base64(part)
                part.add_header("Content-Disposition", f'attachment; filename="{filename}"')
                message.attach(part)
            raw = (
                message.as_bytes()
                if hasattr(message, "as_bytes")
                else message.as_string().encode("utf-8")
            )
            if self._cred_password():
                self._append_to_sent(raw)
        except Exception:  # noqa: BLE001
            pass
        _invalidate_mail_caches()
        return result

    def _append_to_sent(self, raw_message: bytes) -> None:
        """Store a copy of an outbound SMTP message in the IMAP Sent folder."""
        import imaplib
        import time

        with _imap_lock():
            mailbox = self._mailbox("INBOX")
            try:
                sent_folder = self._resolve_sent_folder(mailbox)
                if not sent_folder:
                    return
                date_str = imaplib.Time2Internaldate(time.time())
                mailbox.client.append(sent_folder, "\\Seen", date_str, raw_message)
            finally:
                try:
                    mailbox.logout()
                except Exception:  # noqa: BLE001
                    pass

    def append_outbound_to_sent(self, raw_message: bytes) -> bool:
        """Public best-effort APPEND for mailer / Resend paths. Clears list caches."""
        try:
            self._append_to_sent(raw_message)
            _invalidate_mail_caches()
            return True
        except Exception:  # noqa: BLE001
            return False

    def send_reply(
        self,
        *,
        to: str,
        subject: str,
        body: str,
        in_reply_to: str | None = None,
        references: str | None = None,
        cc: str | None = None,
        bcc: str | None = None,
        attachments: list[dict] | None = None,
        interaction_id: int | None = None,
        send_mode: str = "individual",
    ) -> dict[str, Any]:
        if not self.is_configured:
            return {
                "status": "not_configured",
                "message": "Mailbox is not enabled. Set MAILBOX_ENABLED=true in backend/.env",
            }
        if not to:
            return {"status": "error", "message": "Recipient email is missing"}
        if not self._use_oauth():
            # Prefer Vercel mailer (SMTP off Railway Hobby) when configured —
            # including messages with attachments (mailer fetches files by id/url).
            from integrations.mailer_client import mailer_configured, send_via_mailer

            if mailer_configured():
                from modules.email_tracking import build_tracked_bodies

                plain_body, html_body = build_tracked_bodies(
                    body,
                    interaction_id=interaction_id,
                    send_mode=send_mode,
                )
                send_body = html_body or plain_body
                return send_via_mailer(
                    to=to,
                    subject=subject,
                    body=send_body,
                    html=bool(html_body),
                    cc=cc,
                    bcc=bcc,
                    attachments=attachments,
                )
            if self._use_resend():
                return self._send_resend(
                    to=to,
                    subject=subject,
                    body=body,
                    cc=cc,
                    bcc=bcc,
                    attachments=attachments,
                    interaction_id=interaction_id,
                    send_mode=send_mode,
                    in_reply_to=in_reply_to,
                    references=references,
                )
            return self._send_smtp(
                to=to,
                subject=subject,
                body=body,
                cc=cc,
                bcc=bcc,
                attachments=attachments,
                interaction_id=interaction_id,
                send_mode=send_mode,
            )

        att_list = attachments or []
        graph_attachments: list[dict[str, Any]] = []
        if att_list:
            built = self._graph_file_attachments(att_list)
            if isinstance(built, dict):
                return built
            graph_attachments = built

        from modules.email_tracking import build_tracked_bodies

        plain_body, html_body = build_tracked_bodies(
            body,
            interaction_id=interaction_id,
            send_mode=send_mode,
        )
        message: dict[str, Any] = {
            "subject": subject,
            "body": (
                {"contentType": "HTML", "content": html_body}
                if html_body
                else {"contentType": "Text", "content": plain_body}
            ),
            "toRecipients": [{"emailAddress": {"address": to}}],
        }
        if self._cred_display_name():
            message["from"] = {
                "emailAddress": {
                    "address": self._cred_email(),
                    "name": self._cred_display_name(),
                }
            }
        def _graph_addrs(raw: str | None) -> list[dict[str, Any]]:
            if not raw:
                return []
            addrs = [
                part.strip()
                for part in raw.replace(";", ",").split(",")
                if part.strip() and "@" in part
            ]
            return [{"emailAddress": {"address": addr}} for addr in addrs]

        cc_recipients = _graph_addrs(cc)
        bcc_recipients = _graph_addrs(bcc)
        if cc_recipients:
            message["ccRecipients"] = cc_recipients
        if bcc_recipients:
            message["bccRecipients"] = bcc_recipients
        if graph_attachments:
            message["attachments"] = graph_attachments
        # Graph rejects non-x- custom internetMessageHeaders (In-Reply-To/References).
        # Threading is preserved via Re: subject + quoted body from the inbox module.
        _ = (in_reply_to, references)

        payload = {"message": message, "saveToSentItems": True}

        try:
            token = self._acquire_access_token(GRAPH_SEND_SCOPES)
            response = httpx.post(
                "https://graph.microsoft.com/v1.0/me/sendMail",
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                },
                json=payload,
                timeout=60.0,
            )
        except Exception as exc:  # noqa: BLE001
            return {"status": "error", "message": f"Reply send failed: {exc}"}

        if response.status_code in (202, 200):
            return {"status": "sent", "message": "Reply sent", "to": to, "subject": subject}

        detail = response.text
        try:
            err = response.json().get("error") or {}
            detail = err.get("message") or detail
        except Exception:  # noqa: BLE001
            pass
        return {
            "status": "error",
            "message": f"Reply send failed: Graph {response.status_code}: {detail}",
        }

    def send_approved(
        self,
        *,
        to: str,
        subject: str,
        body: str,
        attachments: list[dict] | None = None,
        interaction_id: int | None = None,
        send_mode: str = "individual",
        cc: str | None = None,
        bcc: str | None = None,
    ) -> dict[str, Any]:
        """Send an approved outbound email (quotations, outreach, bulk campaigns)."""
        return self.send_reply(
            to=to,
            subject=subject,
            body=body,
            attachments=attachments,
            interaction_id=interaction_id,
            send_mode=send_mode,
            cc=cc,
            bcc=bcc,
        )


outlook_client = OutlookClient()
