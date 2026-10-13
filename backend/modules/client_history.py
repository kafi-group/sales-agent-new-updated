"""Client remark history — timestamped entries per buyer."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any

from sqlalchemy.orm import Session

from db.models import AppUser, Buyer

MAX_ENTRIES_PER_BUYER = 200


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def append_client_history(
    buyer: Buyer,
    *,
    text: str,
    by_username: str | None = None,
    source: str = "remark",
) -> None:
    """Append a remark entry if it differs from the latest saved entry."""
    body = (text or "").strip()
    if not body:
        return

    history = list(buyer.remarks_history or [])
    if history:
        last = history[-1]
        if isinstance(last, dict):
            if (last.get("text") or "").strip() == body and (last.get("source") or "") == source:
                return

    history.append(
        {
            "text": body,
            "at": _utcnow().isoformat(),
            "by": by_username,
            "source": source,
        }
    )
    buyer.remarks_history = history[-MAX_ENTRIES_PER_BUYER:]


def buyer_history_entries(buyer: Buyer) -> list[dict[str, Any]]:
    """Return history oldest → newest, including current remarks if not yet logged."""
    history = [dict(entry) for entry in (buyer.remarks_history or []) if isinstance(entry, dict)]
    current = (buyer.remarks or "").strip()
    if current:
        if not history or (history[-1].get("text") or "").strip() != current:
            history.append(
                {
                    "text": current,
                    "at": buyer.updated_at.isoformat() if buyer.updated_at else _utcnow().isoformat(),
                    "by": None,
                    "source": "remark",
                    "current": True,
                }
            )
    return history


_PKT = timezone(timedelta(hours=5))  # Asia/Karachi has no daylight saving


def _filter_day(value: str | None) -> date | None:
    text = (value or "").strip()
    if not text:
        return None
    try:
        return date.fromisoformat(text[:10])
    except ValueError:
        return None


def _entry_time(value: Any) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def list_client_history_feed(
    db: Session,
    *,
    assigned_to_user_id: int | None = None,
    buyer_id: int | None = None,
    search: str | None = None,
    page: int = 1,
    page_size: int = 50,
    date_from: str | None = None,
    date_to: str | None = None,
) -> dict[str, Any]:
    """Flatten remark history across buyers, newest first.

    ``date_from`` / ``date_to`` (YYYY-MM-DD, both inclusive, Karachi days) narrow the entries to
    one day (same value for both) or a range; either one may be left out.
    """
    day_from = _filter_day(date_from)
    day_to = _filter_day(date_to)
    if day_from and day_to and day_from > day_to:
        day_from, day_to = day_to, day_from
    window_start = (
        datetime.combine(day_from, datetime.min.time(), tzinfo=_PKT) if day_from else None
    )
    window_end = (
        datetime.combine(day_to, datetime.min.time(), tzinfo=_PKT) + timedelta(days=1)
        if day_to
        else None
    )
    query = db.query(Buyer)
    from sqlalchemy import or_

    query = query.filter(
        or_(
            Buyer.remarks_history.isnot(None),
            Buyer.remarks.isnot(None),
        )
    )
    if assigned_to_user_id is not None:
        query = query.filter(Buyer.assigned_to_user_id == assigned_to_user_id)
    if buyer_id is not None:
        query = query.filter(Buyer.id == buyer_id)

    needle = (search or "").strip().lower()
    if needle:
        from sqlalchemy import func as sa_func

        query = query.filter(
            sa_func.lower(sa_func.coalesce(Buyer.company_name, "")).like(f"%{needle}%")
        )

    buyers = query.order_by(Buyer.updated_at.desc().nullslast(), Buyer.id.desc()).all()

    flat: list[dict[str, Any]] = []
    for buyer in buyers:
        logged = list(buyer.remarks_history or [])
        for entry in buyer_history_entries(buyer):
            text = (entry.get("text") or "").strip()
            if not text:
                continue
            is_current_only = bool(entry.get("current"))
            if is_current_only and logged:
                continue
            if window_start is not None or window_end is not None:
                when = _entry_time(entry.get("at"))
                if when is None:
                    continue  # undated entries cannot be placed on a day
                if window_start is not None and when < window_start:
                    continue
                if window_end is not None and when >= window_end:
                    continue
            flat.append(
                {
                    "id": f"{buyer.id}:{entry.get('at') or text[:24]}",
                    "buyer_id": buyer.id,
                    "company_name": buyer.company_name,
                    "country": buyer.country,
                    "assigned_to": buyer.assigned_to,
                    "assigned_to_user_id": buyer.assigned_to_user_id,
                    "text": text,
                    "at": entry.get("at"),
                    "by": entry.get("by"),
                    "source": entry.get("source") or "remark",
                }
            )

    flat.sort(key=lambda row: row.get("at") or "", reverse=True)
    total = len(flat)
    page = max(1, int(page or 1))
    page_size = max(1, min(int(page_size or 50), 200))
    start = (page - 1) * page_size
    rows = flat[start : start + page_size]

    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "total_pages": max(1, (total + page_size - 1) // page_size),
        "rows": rows,
    }


def _latest_history_entry(buyer: Buyer) -> dict[str, Any] | None:
    history = [e for e in (buyer.remarks_history or []) if isinstance(e, dict)]
    for entry in reversed(history):
        if (entry.get("text") or "").strip():
            return entry
    return None


def resolve_current_remarks(buyer: Buyer) -> str:
    """Current remarks text: buyers.remarks, or the newest history entry if empty."""
    current = (buyer.remarks or "").strip()
    if current:
        return current
    latest = _latest_history_entry(buyer)
    return ((latest or {}).get("text") or "").strip()


def _current_remark_meta(buyer: Buyer, current: str | None = None) -> tuple[str | None, str | None]:
    """Return (updated_at, updated_by) for the current remarks snapshot."""
    text = (current if current is not None else resolve_current_remarks(buyer)).strip()
    if not text:
        return None, None
    history = [e for e in (buyer.remarks_history or []) if isinstance(e, dict)]
    for entry in reversed(history):
        if (entry.get("text") or "").strip() == text:
            return entry.get("at"), entry.get("by")
    if buyer.updated_at:
        return buyer.updated_at.isoformat(), None
    return None, None


def history_for_buyer(
    db: Session,
    buyer_id: int,
    *,
    heal_remarks: bool = True,
) -> dict[str, Any] | None:
    buyer = db.get(Buyer, buyer_id)
    if not buyer:
        return None

    # Keep the single remarks box in sync when history exists but remarks was never set
    # (e.g. older call-note history writes).
    current = resolve_current_remarks(buyer)
    if heal_remarks and current and not (buyer.remarks or "").strip():
        buyer.remarks = current
        db.commit()
        db.refresh(buyer)

    entries = buyer_history_entries(buyer)
    updated_at, updated_by = _current_remark_meta(buyer, current)
    return {
        "buyer_id": buyer.id,
        "company_name": buyer.company_name,
        "remarks": current or buyer.remarks,
        "remarks_updated_at": updated_at,
        "remarks_updated_by": updated_by,
        "entries": [
            {
                "text": e.get("text"),
                "at": e.get("at"),
                "by": e.get("by"),
                "source": e.get("source") or "remark",
                "current": bool(e.get("current")),
            }
            for e in entries
        ],
    }


def username_for_user(db: Session, user_id: int | None) -> str | None:
    if not user_id:
        return None
    user = db.get(AppUser, user_id)
    return user.username if user else None


def add_client_remark(
    db: Session,
    buyer_id: int,
    text: str,
    *,
    by_username: str | None = None,
    append_to_remarks: bool = True,
) -> dict[str, Any] | None:
    """Set the buyer's current remarks and append a history entry.

    ``append_to_remarks`` is kept for API compatibility; when True (default) the
    current ``buyers.remarks`` field is replaced with the new text (not concatenated).
    When False, only the history log is updated.
    """
    buyer = db.get(Buyer, buyer_id)
    if not buyer:
        return None

    note = (text or "").strip()
    if not note:
        raise ValueError("Remark text is required")

    append_client_history(
        buyer,
        text=note,
        by_username=by_username,
        source="remark",
    )

    if append_to_remarks:
        buyer.remarks = note

    db.commit()
    db.refresh(buyer)
    return history_for_buyer(db, buyer_id)
