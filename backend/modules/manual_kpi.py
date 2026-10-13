"""Manual KPI entries — off-system activity log (Daily KPI Report spreadsheet)."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from db.models import AppUser, AppUserRole, ManualKpiEntry

KPI_TIMEZONE = ZoneInfo("Asia/Karachi")


def _is_admin(user: AppUser) -> bool:
    role = user.role.value if isinstance(user.role, AppUserRole) else str(user.role)
    return role == AppUserRole.admin.value


def period_bounds(report_date: date, period: str) -> tuple[date, date]:
    """Return inclusive start/end dates for day | week | month | year."""
    normalized = (period or "day").strip().lower()
    if normalized in {"week", "weekly"}:
        start_date = report_date - timedelta(days=report_date.weekday())
        end_date = start_date + timedelta(days=6)
    elif normalized in {"month", "monthly"}:
        start_date = report_date.replace(day=1)
        if start_date.month == 12:
            next_month = start_date.replace(year=start_date.year + 1, month=1)
        else:
            next_month = start_date.replace(month=start_date.month + 1)
        end_date = next_month - timedelta(days=1)
    elif normalized in {"year", "yearly"}:
        start_date = report_date.replace(month=1, day=1)
        end_date = report_date.replace(month=12, day=31)
    else:
        start_date = report_date
        end_date = report_date
    return start_date, end_date


def _entry_dict(entry: ManualKpiEntry, user: AppUser | None) -> dict[str, Any]:
    return {
        "id": entry.id,
        "user_id": entry.user_id,
        "username": user.username if user else None,
        "full_name": user.full_name if user else None,
        "activity_date": entry.activity_date.isoformat(),
        "person_name": entry.person_name,
        "company": entry.company,
        "country": entry.country,
        "contact_type": entry.contact_type,
        "follow_up_type": entry.follow_up_type,
        "wechat_contacts": entry.wechat_contacts,
        "remarks": entry.remarks,
        "created_at": entry.created_at,
        "updated_at": entry.updated_at,
    }


def list_manual_kpi_entries(
    db: Session,
    *,
    viewer: AppUser,
    report_date: date,
    period: str = "day",
    user_id: int | None = None,
) -> dict[str, Any]:
    start_date, end_date = period_bounds(report_date, period)
    admin = _is_admin(viewer)
    target_user_id = user_id if admin else viewer.id
    if not admin:
        target_user_id = viewer.id
    elif user_id is not None:
        if not db.get(AppUser, user_id):
            raise ValueError("User not found")

    query = db.query(ManualKpiEntry).filter(
        ManualKpiEntry.activity_date >= start_date,
        ManualKpiEntry.activity_date <= end_date,
    )
    if target_user_id is not None:
        query = query.filter(ManualKpiEntry.user_id == target_user_id)

    rows = query.order_by(
        ManualKpiEntry.activity_date.desc(),
        ManualKpiEntry.id.desc(),
    ).all()

    user_ids = {r.user_id for r in rows}
    users = {
        u.id: u for u in db.query(AppUser).filter(AppUser.id.in_(user_ids)).all()
    } if user_ids else {}

    return {
        "items": [_entry_dict(r, users.get(r.user_id)) for r in rows],
        "total": len(rows),
        "period": (period or "day").strip().lower(),
        "date_start": start_date.isoformat(),
        "date_end": end_date.isoformat(),
        "timezone": "Asia/Karachi",
        "scope": "team" if admin and target_user_id is None else "user",
    }


def create_manual_kpi_entry(
    db: Session,
    *,
    user: AppUser,
    activity_date: date,
    person_name: str | None = None,
    company: str | None = None,
    country: str | None = None,
    contact_type: str | None = None,
    follow_up_type: str | None = None,
    wechat_contacts: str | None = None,
    remarks: str | None = None,
) -> dict[str, Any]:
    entry = ManualKpiEntry(
        user_id=user.id,
        activity_date=activity_date,
        person_name=(person_name or "").strip() or None,
        company=(company or "").strip() or None,
        country=(country or "").strip() or None,
        contact_type=(contact_type or "").strip() or None,
        follow_up_type=(follow_up_type or "").strip() or None,
        wechat_contacts=(wechat_contacts or "").strip() or None,
        remarks=(remarks or "").strip() or None,
    )
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return _entry_dict(entry, user)


def update_manual_kpi_entry(
    db: Session,
    *,
    entry_id: int,
    viewer: AppUser,
    **fields: Any,
) -> dict[str, Any]:
    entry = db.get(ManualKpiEntry, entry_id)
    if not entry:
        raise ValueError("Entry not found")
    admin = _is_admin(viewer)
    if not admin and entry.user_id != viewer.id:
        raise PermissionError("You can only edit your own manual KPI rows")

    for key in (
        "activity_date",
        "person_name",
        "company",
        "country",
        "contact_type",
        "follow_up_type",
        "wechat_contacts",
        "remarks",
    ):
        if key not in fields or fields[key] is None:
            continue
        value = fields[key]
        if key == "activity_date" and isinstance(value, str):
            value = date.fromisoformat(value)
        elif isinstance(value, str):
            value = value.strip() or None
        setattr(entry, key, value)

    entry.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(entry)
    owner = db.get(AppUser, entry.user_id)
    return _entry_dict(entry, owner)


def delete_manual_kpi_entry(db: Session, *, entry_id: int, viewer: AppUser) -> None:
    entry = db.get(ManualKpiEntry, entry_id)
    if not entry:
        raise ValueError("Entry not found")
    admin = _is_admin(viewer)
    if not admin and entry.user_id != viewer.id:
        raise PermissionError("You can only delete your own manual KPI rows")
    db.delete(entry)
    db.commit()
