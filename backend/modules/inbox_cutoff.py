"""Optional inbox start moment — only applied when explicitly set (per user)."""

from __future__ import annotations

import json
from datetime import date, datetime, timezone
from pathlib import Path

from config import settings

_BACKEND_DIR = Path(__file__).resolve().parents[1]
_CUTOFF_DIR = _BACKEND_DIR / "storage" / "inbox_cutoffs"
_LEGACY_CUTOFF_FILE = _BACKEND_DIR / "storage" / "inbox_cutoff.json"
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def _parse_datetime(value: str) -> datetime | None:
    text = (value or "").strip()
    if not text:
        return None
    try:
        if "T" in text:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        else:
            parsed = datetime.combine(date.fromisoformat(text[:10]), datetime.min.time())
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except ValueError:
        return None


def _cutoff_file(user_id: int | None) -> Path:
    if user_id is None:
        return _LEGACY_CUTOFF_FILE
    return _CUTOFF_DIR / f"user_{user_id}.json"


def _read_file_cutoff(user_id: int | None = None) -> datetime | None:
    path = _cutoff_file(user_id)
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return _parse_datetime(str(data.get("since", "")))
    except (OSError, json.JSONDecodeError, TypeError):
        return None


def _write_file_cutoff(value: datetime, user_id: int | None = None) -> None:
    path = _cutoff_file(user_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"since": value.astimezone(timezone.utc).isoformat()}, indent=2) + "\n",
        encoding="utf-8",
    )


def clear_inbox_cutoff(user_id: int | None = None) -> None:
    """Remove the optional cutoff so all mailbox mail is eligible again."""
    try:
        path = _cutoff_file(user_id)
        if path.is_file():
            path.unlink()
        if _LEGACY_CUTOFF_FILE.is_file():
            _LEGACY_CUTOFF_FILE.unlink()
    except OSError:
        pass


def clear_all_inbox_cutoffs() -> int:
    """Clear inbox cutoffs for ALL users and legacy files so everyone sees all past emails."""
    count = 0
    if _LEGACY_CUTOFF_FILE.is_file():
        try:
            _LEGACY_CUTOFF_FILE.unlink()
            count += 1
        except OSError:
            pass
    if _CUTOFF_DIR.is_dir():
        for file in _CUTOFF_DIR.glob("*.json"):
            try:
                file.unlink()
                count += 1
            except OSError:
                pass
    return count


def has_active_cutoff(user_id: int | None = None) -> bool:
    if user_id is None:
        try:
            from modules.mailbox_accounts import get_active_mailbox_user_id

            user_id = get_active_mailbox_user_id()
        except Exception:  # noqa: BLE001
            user_id = None
    return bool(_read_file_cutoff(user_id))


def get_inbox_since(*, initialize: bool = False, user_id: int | None = None) -> datetime:
    """Earliest message time to include.

    Unlike before, this does NOT auto-create a "now" cutoff on first use —
    that hid all existing mail. With no cutoff configured, returns epoch (show all).
    """
    if user_id is None:
        try:
            from modules.mailbox_accounts import get_active_mailbox_user_id

            user_id = get_active_mailbox_user_id()
        except Exception:  # noqa: BLE001
            user_id = None

    stored = _read_file_cutoff(user_id)
    if stored:
        return stored

    if initialize:
        return _EPOCH
    return _EPOCH


def set_inbox_since_to_now(user_id: int | None = None) -> datetime:
    """Ignore all mail before right now (explicit user action)."""
    now = datetime.now(timezone.utc)
    _write_file_cutoff(now, user_id=user_id)
    return now


def gmail_after_query(since: datetime | None = None) -> str:
    """Gmail search fragment — date granularity only (e.g. after:2026/07/08)."""
    moment = (since or get_inbox_since()).astimezone(timezone.utc)
    return f"after:{moment.year}/{moment.month:02d}/{moment.day:02d}"


def as_utc(value: datetime | None) -> datetime | None:
    """Normalize message/cutoff datetimes so naive and aware values can be compared."""
    if value is None:
        return None
    if not isinstance(value, datetime):
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def date_sort_key(value: object) -> datetime:
    """Stable UTC key for sorting mixed/missing message dates."""
    if isinstance(value, datetime):
        return as_utc(value) or _EPOCH
    return _EPOCH


def message_is_after_cutoff(
    message_date: datetime | None, *, user_id: int | None = None
) -> bool:
    if not has_active_cutoff(user_id):
        return True
    msg = as_utc(message_date)
    if msg is None:
        return True
    cutoff = as_utc(get_inbox_since(user_id=user_id)) or _EPOCH
    return msg >= cutoff
