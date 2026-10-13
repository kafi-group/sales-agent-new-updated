"""Tool handlers for the sales assistant chatbot."""

from __future__ import annotations

from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from db.models import AppUser, AppUserRole, Buyer, UserActivityEvent
from modules import activity as activity_module
from modules.countries import country_search_terms

KPI_TZ = ZoneInfo("Asia/Karachi")

USER_ALIASES: dict[str, str] = {
    "usman": "usmankhan",
    "usman khan": "usmankhan",
    "asim": "asim",
    "sadia": "sadia",
    "admin": "admin",
}

NAV_DESTINATIONS: dict[str, dict[str, Any]] = {
    "whatsapp": {"type": "whatsapp", "section": "whatsapp-inbox"},
    "whatsapp inbox": {"type": "whatsapp", "section": "whatsapp-inbox"},
    "whatsapp templates": {"type": "whatsapp", "section": "whatsapp-templates"},
    "inbox": {"type": "mail", "section": "inbox"},
    "email inbox": {"type": "mail", "section": "inbox"},
    "sent": {"type": "mail", "section": "sent"},
    "mail activity": {"type": "mail", "section": "activity"},
    "calls": {"type": "tab", "tab": "calls"},
    "call history": {"type": "tab", "tab": "calls"},
    "kpi": {"type": "tab", "tab": "kpi"},
    "ai mode": {"type": "ai-mode"},
    "lifecycle": {"type": "ai-mode", "panel": "lifecycle"},
    "leads table": {"type": "tab", "tab": "table"},
    "master table": {"type": "tab", "tab": "master-table"},
    "indexes": {"type": "tab", "tab": "indexes"},
    "chatbot": {"type": "tab", "tab": "chatbot"},
    "brand assistant": {"type": "tab", "tab": "chatbot"},
    "settings": {"type": "tab", "tab": "settings"},
}


def _is_admin(viewer: AppUser) -> bool:
    role = viewer.role.value if isinstance(viewer.role, AppUserRole) else str(viewer.role)
    return role == AppUserRole.admin.value


def resolve_user(db: Session, name: str | None, viewer: AppUser) -> AppUser | None:
    if not name or not str(name).strip():
        return None
    raw = str(name).strip()
    key = raw.lower()
    username = USER_ALIASES.get(key, key.replace(" ", ""))
    user = (
        db.query(AppUser)
        .filter(AppUser.is_active.is_(True))
        .filter(
            (AppUser.username.ilike(username))
            | (AppUser.full_name.ilike(f"%{raw}%"))
        )
        .first()
    )
    if not user:
        return None
    if not _is_admin(viewer) and user.id != viewer.id:
        return None
    return user


def tool_list_team(db: Session, viewer: AppUser) -> dict[str, Any]:
    if not _is_admin(viewer):
        return {
            "users": [
                {
                    "id": viewer.id,
                    "username": viewer.username,
                    "full_name": viewer.full_name,
                }
            ]
        }
    rows = (
        db.query(AppUser)
        .filter(AppUser.is_active.is_(True))
        .order_by(AppUser.full_name.asc())
        .all()
    )
    return {
        "users": [
            {"id": u.id, "username": u.username, "full_name": u.full_name}
            for u in rows
        ]
    }


def tool_get_user_activity(
    db: Session,
    viewer: AppUser,
    *,
    user_name: str | None = None,
    period: str = "day",
) -> dict[str, Any]:
    report_date = datetime.now(KPI_TZ).date()
    target_id: int | None = None
    if user_name:
        user = resolve_user(db, user_name, viewer)
        if not user:
            return {"error": f"Could not find or access user '{user_name}'."}
        target_id = user.id
    elif not _is_admin(viewer):
        target_id = viewer.id

    try:
        report = activity_module.get_kpi_report(
            db,
            report_date=report_date,
            viewer=viewer,
            user_id=target_id,
            period=period or "day",
        )
    except ValueError as exc:
        return {"error": str(exc)}

    activities = report.get("activities") or []
    report["activities"] = activities[:12]
    report["activities_truncated"] = len(activities) > 12
    return report


def tool_list_calls(
    db: Session,
    viewer: AppUser,
    *,
    user_name: str | None = None,
    country: str | None = None,
    period: str = "day",
    limit: int = 25,
) -> dict[str, Any]:
    report_date = datetime.now(KPI_TZ).date()
    normalized_period = (period or "day").strip().lower()
    _start, _end, start_utc, end_utc = activity_module.period_bounds(
        report_date,
        normalized_period,
    )

    query = db.query(UserActivityEvent).filter(
        UserActivityEvent.activity_type == activity_module.CALL_LOGGED,
        UserActivityEvent.created_at >= start_utc,
        UserActivityEvent.created_at < end_utc,
    )

    if user_name:
        user = resolve_user(db, user_name, viewer)
        if not user:
            return {"error": f"Could not find or access user '{user_name}'."}
        query = query.filter(UserActivityEvent.user_id == user.id)
    elif not _is_admin(viewer):
        query = query.filter(UserActivityEvent.user_id == viewer.id)

    events = (
        query.order_by(UserActivityEvent.created_at.desc())
        .limit(max(limit, 1) * 4)
        .all()
    )

    terms = (
        [t for t in country_search_terms(country) if t]
        if country and str(country).strip()
        else None
    )

    rows: list[dict[str, Any]] = []
    by_country: dict[str, int] = {}

    for event in events:
        details = event.details or {}
        buyer_id = details.get("buyer_id")
        company = str(details.get("company_name") or "").strip()
        buyer_country: str | None = None
        if buyer_id:
            buyer = db.get(Buyer, int(buyer_id))
            if buyer:
                company = (buyer.company_name or company).strip()
                buyer_country = (buyer.country or "").strip() or None

        if terms:
            hay = (buyer_country or company or "").lower()
            if not any(term in hay for term in terms):
                continue

        caller = db.get(AppUser, event.user_id)
        country_label = buyer_country or "Unknown"
        by_country[country_label] = by_country.get(country_label, 0) + 1
        rows.append(
            {
                "time": event.created_at.isoformat() if event.created_at else None,
                "caller": caller.full_name if caller else "Unknown",
                "username": caller.username if caller else None,
                "company": company or "(unknown company)",
                "country": buyer_country,
                "summary": event.summary,
            }
        )
        if len(rows) >= max(1, min(limit, 40)):
            break

    return {
        "period": normalized_period,
        "date": report_date.isoformat(),
        "timezone": "Asia/Karachi",
        "country_filter": country,
        "calls": rows,
        "total_listed": len(rows),
        "by_country": by_country,
    }


def tool_navigate(destination: str) -> dict[str, Any]:
    key = (destination or "").strip().lower()
    if not key:
        return {"error": "Destination is required."}

    for label, action in NAV_DESTINATIONS.items():
        if key == label or key in label or label in key:
            return {"action": action, "label": label}

    return {
        "error": (
            f"Unknown destination '{destination}'. "
            "Try: WhatsApp, inbox, calls, KPI, AI mode, leads table."
        )
    }


def dispatch_tool(
    db: Session,
    viewer: AppUser,
    name: str,
    args: dict[str, Any],
) -> dict[str, Any]:
    if name == "list_team":
        return tool_list_team(db, viewer)
    if name == "get_user_activity":
        return tool_get_user_activity(
            db,
            viewer,
            user_name=args.get("user_name"),
            period=str(args.get("period") or "day"),
        )
    if name == "list_calls":
        return tool_list_calls(
            db,
            viewer,
            user_name=args.get("user_name"),
            country=args.get("country"),
            period=str(args.get("period") or "day"),
            limit=int(args.get("limit") or 25),
        )
    if name == "navigate":
        return tool_navigate(str(args.get("destination") or ""))
    return {"error": f"Unknown tool: {name}"}
