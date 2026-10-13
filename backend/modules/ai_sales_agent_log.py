"""AI Sales Agent activity log — assignments vs process starts."""

from __future__ import annotations

from collections import defaultdict
from datetime import timezone
from typing import Any

from sqlalchemy.orm import Session

from db.models import AiSalesAgentRunLog, AppUser

EVENT_ASSIGN = "assign"
EVENT_RUN_START = "run_start"

_PERSONA_LABELS = {
    "pipeline": "AI Sales Agent list",
    "female": "Sara",
    "male": "Rayan",
}
_LANE_LABELS = {
    "outreach": "Outreach",
    "data_update": "Data Update",
    "auto_mode": "AI Auto Mode",
}


def persona_label(persona: str | None) -> str:
    from modules.ai_agent_persona import persona_display_name

    p = (persona or "").strip()
    if p.lower() == "pipeline":
        return "AI Sales Agent list"
    return persona_display_name(p) if p else "—"


def lane_label(lane: str | None) -> str:
    l = (lane or "").strip().lower()
    return _LANE_LABELS.get(l, l or "—")


def user_display_label(user: AppUser | None, fallback: str | None = None) -> str:
    if user is not None:
        name = (user.full_name or "").strip() or (user.username or "").strip()
        if name:
            return name[:120]
    return ((fallback or "").strip() or "Someone")[:120]


def contacts_from_tasks(tasks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for t in tasks:
        if not isinstance(t, dict):
            continue
        rows.append(
            {
                "task_id": t.get("task_id") if t.get("task_id") is not None else t.get("id"),
                "buyer_id": t.get("buyer_id"),
                "company_name": (t.get("company_name") or "")[:255],
                "contact_name": (t.get("contact_name") or "")[:120],
                "contact_phone": (t.get("contact_phone") or "")[:64],
                "contact_email": (t.get("contact_email") or "")[:120],
            }
        )
    return rows


def record_event(
    db: Session,
    *,
    user: AppUser | None,
    event_kind: str,
    persona: str,
    contacts: list[dict[str, Any]],
    queue_lane: str | None = None,
    note: str | None = None,
    user_label: str | None = None,
    commit: bool = True,
) -> dict[str, Any] | None:
    """Persist one assign or run_start row. No-op when contacts is empty."""
    snaps = contacts_from_tasks(list(contacts or []))
    if not snaps:
        return None

    kind = (event_kind or "").strip().lower()
    if kind not in (EVENT_ASSIGN, EVENT_RUN_START):
        kind = EVENT_ASSIGN

    label = user_display_label(user, user_label)
    row = AiSalesAgentRunLog(
        user_id=getattr(user, "id", None),
        user_label=label,
        event_kind=kind,
        persona=(persona or "").strip().lower() or "pipeline",
        queue_lane=(queue_lane or "").strip().lower() or None,
        contact_count=len(snaps),
        contacts=snaps,
        note=(note or "")[:500] or None,
    )
    db.add(row)
    if commit:
        try:
            db.commit()
            db.refresh(row)
        except Exception as exc:
            db.rollback()
            # Missing table / transient DB — never take down the request path.
            print(f"AI Sales Agent log write skipped: {exc}", flush=True)
            return None
    return _row_to_dict(row)


def record_assign(
    db: Session,
    *,
    user: AppUser | None,
    persona: str,
    tasks: list[dict[str, Any]],
    queue_lane: str | None = None,
    note: str | None = None,
) -> dict[str, Any] | None:
    return record_event(
        db,
        user=user,
        event_kind=EVENT_ASSIGN,
        persona=persona,
        contacts=tasks,
        queue_lane=queue_lane,
        note=note,
    )


def record_run_start(
    db: Session,
    *,
    user: AppUser | None,
    persona: str,
    queue_lane: str,
    tasks: list[dict[str, Any]],
    note: str | None = None,
    user_label: str | None = None,
) -> dict[str, Any] | None:
    return record_event(
        db,
        user=user,
        event_kind=EVENT_RUN_START,
        persona=persona,
        contacts=tasks,
        queue_lane=queue_lane,
        note=note,
        user_label=user_label,
    )


def _row_to_dict(row: AiSalesAgentRunLog) -> dict[str, Any]:
    created = row.created_at
    if created is not None and created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    return {
        "id": row.id,
        "user_id": row.user_id,
        "user_label": row.user_label or "",
        "event_kind": row.event_kind,
        "persona": row.persona,
        "persona_label": persona_label(row.persona),
        "queue_lane": row.queue_lane,
        "lane_label": lane_label(row.queue_lane) if row.queue_lane else None,
        "contact_count": int(row.contact_count or 0),
        "contacts": list(row.contacts or []),
        "note": row.note,
        "created_at": created.isoformat() if created else None,
    }


def list_events(
    db: Session,
    *,
    limit: int = 200,
    event_kind: str | None = None,
    user_id: int | None = None,
) -> list[dict[str, Any]]:
    q = db.query(AiSalesAgentRunLog).order_by(AiSalesAgentRunLog.created_at.desc())
    if event_kind:
        q = q.filter(AiSalesAgentRunLog.event_kind == event_kind.strip().lower())
    if user_id is not None:
        q = q.filter(AiSalesAgentRunLog.user_id == int(user_id))
    rows = q.limit(max(1, min(int(limit or 200), 500))).all()
    return [_row_to_dict(r) for r in rows]


def build_summary(events: list[dict[str, Any]]) -> dict[str, Any]:
    """Aggregate assigned vs used (run_start) by user, date, persona, lane."""
    by_user: dict[str, dict[str, Any]] = {}
    by_date: dict[str, dict[str, Any]] = {}

    def _bucket(store: dict[str, dict[str, Any]], key: str) -> dict[str, Any]:
        if key not in store:
            store[key] = {
                "key": key,
                "assigned": 0,
                "used": 0,
                "difference": 0,
                "by_persona": defaultdict(int),
                "by_lane": defaultdict(int),
                "used_by_persona_lane": defaultdict(int),
                "runs": 0,
            }
        return store[key]

    for ev in events:
        kind = ev.get("event_kind")
        count = int(ev.get("contact_count") or 0)
        user_key = (ev.get("user_label") or "Someone").strip() or "Someone"
        created = ev.get("created_at") or ""
        date_key = created[:10] if isinstance(created, str) and len(created) >= 10 else "unknown"
        persona = (ev.get("persona") or "").strip().lower() or "pipeline"
        lane = (ev.get("queue_lane") or "").strip().lower() or None

        for store, key in ((by_user, user_key), (by_date, date_key)):
            b = _bucket(store, key)
            if kind == EVENT_ASSIGN:
                b["assigned"] += count
                b["by_persona"][persona] += count
                if lane:
                    b["by_lane"][lane] += count
            elif kind == EVENT_RUN_START:
                b["used"] += count
                b["runs"] += 1
                b["by_persona"][persona] += count
                if lane:
                    b["by_lane"][lane] += count
                    b["used_by_persona_lane"][f"{persona}:{lane}"] += count

    def _finalize(items: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        for b in items.values():
            b["difference"] = max(0, int(b["assigned"]) - int(b["used"]))
            b["by_persona"] = dict(b["by_persona"])
            b["by_lane"] = dict(b["by_lane"])
            b["used_by_persona_lane"] = dict(b["used_by_persona_lane"])
            out.append(b)
        out.sort(key=lambda x: x["key"], reverse=True)
        return out

    total_assigned = sum(int(e.get("contact_count") or 0) for e in events if e.get("event_kind") == EVENT_ASSIGN)
    total_used = sum(int(e.get("contact_count") or 0) for e in events if e.get("event_kind") == EVENT_RUN_START)
    total_runs = sum(1 for e in events if e.get("event_kind") == EVENT_RUN_START)

    return {
        "total_assigned": total_assigned,
        "total_used": total_used,
        "total_difference": max(0, total_assigned - total_used),
        "total_runs": total_runs,
        "by_user": _finalize(by_user),
        "by_date": _finalize(by_date),
    }
