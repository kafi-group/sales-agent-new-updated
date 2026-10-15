"""Per-user cPanel mailbox credentials (encrypted at rest).

Shared IMAP/SMTP hosts stay in env (MAILBOX_IMAP_HOST, etc.).
Each AppUser stores their own mailbox email + encrypted password.
"""

from __future__ import annotations

import base64
import hashlib
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Iterator

from config import settings

_current_account: ContextVar["MailboxAccount | None"] = ContextVar(
    "mailbox_account", default=None
)
_current_user_id: ContextVar[int | None] = ContextVar("mailbox_user_id", default=None)


@dataclass(frozen=True)
class MailboxAccount:
    email: str
    password: str
    display_name: str | None = None


# Shared mailboxes use a fixed public From name (not the logged-in rep's name).
_MAILBOX_PUBLIC_SENDER_NAMES: dict[str, str] = {
    "info@kafi-group.com": "Asad Ali",
    "marketing@kafi-group.com": "Anjum Ali",
}


def public_sender_display_name(
    mailbox_email: str,
    fallback: str | None = None,
) -> str | None:
    """Return the customer-facing From name for known shared Kafi mailboxes."""
    mapped = _MAILBOX_PUBLIC_SENDER_NAMES.get((mailbox_email or "").strip().lower())
    if mapped:
        return mapped
    cleaned = (fallback or "").strip()
    return cleaned or None


def hosts_enabled() -> bool:
    """Feature flag — credentials are per-user."""
    return bool(settings.mailbox_enabled)


def get_active_mailbox() -> MailboxAccount | None:
    return _current_account.get()


def get_active_mailbox_user_id() -> int | None:
    return _current_user_id.get()


@contextmanager
def use_mailbox(
    account: MailboxAccount | None,
    *,
    user_id: int | None = None,
) -> Iterator[MailboxAccount | None]:
    if account is None:
        yield None
        return
    token = _current_account.set(account)
    uid_token = _current_user_id.set(user_id)
    try:
        yield account
    finally:
        _current_account.reset(token)
        _current_user_id.reset(uid_token)


def _fernet_keys() -> list[bytes]:
    keys: list[bytes] = []
    raw = (settings.mailbox_credentials_key or "").strip()
    if raw:
        # .env keys are sometimes pasted without trailing '=' padding.
        padded = raw + ("=" * ((4 - len(raw) % 4) % 4))
        keys.append(padded.encode("ascii"))
    # Deterministic fallback so local/dev still works without a key set.
    digest = hashlib.sha256(b"kafi-mailbox-dev-key").digest()
    keys.append(base64.urlsafe_b64encode(digest))
    return keys


def encrypt_mailbox_password(password: str) -> str:
    if not password:
        raise ValueError("Mailbox password is required")
    from cryptography.fernet import Fernet

    return Fernet(_fernet_keys()[0]).encrypt(password.encode("utf-8")).decode("ascii")


def decrypt_mailbox_password(token: str) -> str:
    if not token:
        raise ValueError("Mailbox password is missing")
    from cryptography.fernet import Fernet, InvalidToken

    last_exc: Exception | None = None
    for key in _fernet_keys():
        try:
            return Fernet(key).decrypt(token.encode("ascii")).decode("utf-8")
        except (InvalidToken, ValueError, TypeError) as exc:
            last_exc = exc
            continue
    raise ValueError("Could not decrypt mailbox password") from last_exc


# username -> settings attrs for Railway/backend .env fallback (users never type these)
_ENV_MAILBOX_SLOTS: tuple[tuple[str, str, str], ...] = (
    ("mailbox_admin_email", "mailbox_admin_password", "mailbox_admin_display_name"),
    ("mailbox_asim_email", "mailbox_asim_password", "mailbox_asim_display_name"),
    ("mailbox_usman_email", "mailbox_usman_password", "mailbox_usman_display_name"),
    ("mailbox_sadia_email", "mailbox_sadia_password", "mailbox_sadia_display_name"),
    ("mailbox_finance_email", "mailbox_finance_password", "mailbox_finance_display_name"),
)

_ENV_MAILBOX_BY_USERNAME: dict[str, tuple[str, str, str]] = {
    "admin": _ENV_MAILBOX_SLOTS[0],
    "khalid": _ENV_MAILBOX_SLOTS[0],
    "mrkhalid": _ENV_MAILBOX_SLOTS[0],
    "khaled": _ENV_MAILBOX_SLOTS[0],
    "khaledparacha": _ENV_MAILBOX_SLOTS[0],
    "asim": _ENV_MAILBOX_SLOTS[1],
    "usmankhan": _ENV_MAILBOX_SLOTS[2],
    "usman": _ENV_MAILBOX_SLOTS[2],
    "usman_khan": _ENV_MAILBOX_SLOTS[2],
    "sadia": _ENV_MAILBOX_SLOTS[3],
    "finance": _ENV_MAILBOX_SLOTS[4],
}


def _account_from_env_attrs(attrs: tuple[str, str, str]) -> MailboxAccount | None:
    email_attr, password_attr, display_attr = attrs
    email = (getattr(settings, email_attr, None) or "").strip()
    password = (getattr(settings, password_attr, None) or "").strip()
    if not email or not password:
        return None
    display = (getattr(settings, display_attr, None) or "").strip() or None
    return MailboxAccount(
        email=email,
        password=password,
        display_name=public_sender_display_name(email, display),
    )


def resolve_mailbox_from_env(
    username: str | None = None,
    *,
    mailbox_email: str | None = None,
) -> MailboxAccount | None:
    """Fallback: MAILBOX_*_* on Railway/backend .env (not the user's login password).

    Matches by Sales Agent username aliases, then by mailbox email so any user
    assigned marketing@ / info@ / etc. still gets the correct SMTP password.
    """
    key = (username or "").strip().lower()
    if key:
        attrs = _ENV_MAILBOX_BY_USERNAME.get(key)
        if attrs:
            account = _account_from_env_attrs(attrs)
            if account:
                return account

    want = (mailbox_email or "").strip().lower()
    if want:
        for attrs in _ENV_MAILBOX_SLOTS:
            account = _account_from_env_attrs(attrs)
            if account and account.email.strip().lower() == want:
                return account
    return None


def resolve_user_mailbox(user) -> MailboxAccount | None:
    """Build a MailboxAccount from AppUser columns, or None if not set up.

    Works for every Sales Agent user with a mailbox on their row. Reps only log
    into Sales Agent (username/password). Mailbox password is stored encrypted
    on their user row (or Railway env) — they never enter it at send time.

    Railway/backend .env is preferred when present. A stale encrypted DB password
    previously caused SMTP 535 while MAILBOX_*_PASSWORD was already correct.
    """
    if user is None:
        return None
    if not bool(getattr(user, "mailbox_enabled", True)):
        return None
    email = (getattr(user, "mailbox_email", None) or "").strip()
    username = getattr(user, "username", None)
    env_account = resolve_mailbox_from_env(username, mailbox_email=email or None)
    if env_account is not None:
        # Keep the user's assigned address when set; always take the live env password.
        display = (getattr(user, "mailbox_display_name", None) or "").strip() or None
        if not display:
            display = (getattr(user, "full_name", None) or "").strip() or None
        use_email = email or env_account.email
        return MailboxAccount(
            email=use_email,
            password=env_account.password,
            display_name=public_sender_display_name(
                use_email, display or env_account.display_name
            ),
        )

    enc = (getattr(user, "mailbox_password_encrypted", None) or "").strip()
    if email and enc:
        try:
            password = decrypt_mailbox_password(enc)
            display = (getattr(user, "mailbox_display_name", None) or "").strip() or None
            if not display:
                display = (getattr(user, "full_name", None) or "").strip() or None
            display = public_sender_display_name(email, display)
            return MailboxAccount(email=email, password=password, display_name=display)
        except ValueError:
            return None
    return None


def user_mailbox_configured(user) -> bool:
    return resolve_user_mailbox(user) is not None


def set_user_mailbox(
    user,
    *,
    mailbox_email: str | None = None,
    mailbox_password: str | None = None,
    mailbox_display_name: str | None = None,
    mailbox_enabled: bool | None = None,
    clear_password: bool = False,
) -> None:
    """Mutate user mailbox fields (caller commits). Password omitted = keep existing."""
    if mailbox_email is not None:
        cleaned = mailbox_email.strip().lower()
        user.mailbox_email = cleaned or None
    if mailbox_display_name is not None:
        cleaned_name = mailbox_display_name.strip()
        user.mailbox_display_name = cleaned_name or None
    if mailbox_enabled is not None:
        user.mailbox_enabled = mailbox_enabled
    if clear_password:
        user.mailbox_password_encrypted = None
    elif mailbox_password is not None and mailbox_password.strip():
        user.mailbox_password_encrypted = encrypt_mailbox_password(mailbox_password)
