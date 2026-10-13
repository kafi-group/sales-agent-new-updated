"""KPI scorecard: targets assigned by the admin vs. what each person actually did, as a % and a grade.

* Auto pointers read the existing KPI counts (calls, emails, WhatsApp ...).
* Manual pointers read the Manual KPI sheet (e.g. WhatsApp calls made from the office mobile).
* A target is PER DAY (and per user; the admin can override it for one person). A pointer without a
  target is not graded. Week / month targets are the daily target x working days elapsed.
* Percent = actual / target, capped at 100. Grade = A+ / A / B+ / B / C / D from the percent.
  The overall score is the weighted average of the graded pointers.

Targets are saved in a small JSON file on the Railway volume (like the master-list config), so no
database change is needed and they survive redeploys.
"""

from __future__ import annotations

import json
import os
import re
import threading
from copy import deepcopy
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from db.models import AppUser, AppUserRole, ManualKpiEntry
from modules import activity as activity_module

KPI_TARGETS_PIN = (os.environ.get("KPI_TARGETS_PIN") or "").strip() or "786786"

GRADE_ORDER = ["A+", "A", "B+", "B", "C"]  # D is everything below C
DEFAULT_BANDS = {"A+": 100.0, "A": 90.0, "B+": 80.0, "B": 70.0, "C": 50.0}

# (key in the KPI counts, label shown to the admin)
AUTO_METRICS: list[tuple[str, str]] = [
    ("calls_logged", "Calls attempted"),
    ("companies_called", "Companies called"),
    ("outcomes_follow_up", "Calls picked up"),
    ("outcomes_interested", "Client interested"),
    ("outcomes_not_interested", "Not interested"),
    ("outcomes_not_received_call", "No answer"),
    ("call_remarks", "Call remarks"),
    ("leads_imported", "Leads imported"),
    ("table_edits", "Table edits"),
    ("email_templates_created", "Templates created"),
    ("personal_emails_sent", "Personal emails sent"),
    ("bulk_emails_sent", "Bulk emails sent"),
    ("personal_whatsapp_sent", "Personal WhatsApp sent"),
    ("bulk_whatsapp_sent", "Bulk WhatsApp sent"),
    ("inbox_replies", "Inbox replies"),
    ("brand_assistant_sessions", "AI Research & Update"),
]


def _low(value: str | None) -> str:
    return (value or "").strip().lower()


# key -> (label, test applied to each Manual KPI row of the person in the period)
MANUAL_METRICS: dict[str, tuple[str, Any]] = {
    "manual_whatsapp_calls": (
        "WhatsApp calls attended (manual sheet)",
        lambda e: _low(e.contact_type) == "whatsapp",
    ),
    "manual_phone_calls": (
        "Phone calls attended (manual sheet)",
        lambda e: _low(e.contact_type) in {"phone", "call"},
    ),
    "manual_emails": (
        "Emails to contacts (manual sheet)",
        lambda e: _low(e.contact_type) == "email",
    ),
    "manual_wechat": (
        "WeChat contacts (manual sheet)",
        lambda e: _low(e.wechat_contacts) == "yes",
    ),
    "manual_follow_ups": (
        "Follow-ups done (manual sheet)",
        lambda e: _low(e.follow_up_type) not in {"", "no"},
    ),
    "manual_contacts": (
        "People reached, any channel (manual sheet)",
        lambda e: _low(e.contact_type) not in {"", "no"},
    ),
}


def metric_catalogue() -> list[dict[str, str]]:
    rows = [{"key": k, "label": label, "source": "auto"} for k, label in AUTO_METRICS]
    rows += [{"key": k, "label": v[0], "source": "manual"} for k, v in MANUAL_METRICS.items()]
    return rows


_METRIC_KEYS = {r["key"] for r in metric_catalogue()}


def _pointer(key: str, label: str, metric: str, target: float = 0, enabled: bool = False, note: str = "") -> dict:
    return {"key": key, "label": label, "metric": metric, "target": target, "weight": 1.0, "enabled": enabled, "note": note}


def default_config() -> dict[str, Any]:
    return {
        "pointers": [
            _pointer(
                "whatsapp_calls",
                "WhatsApp Calls",
                "manual_whatsapp_calls",
                target=5,
                enabled=True,
                note="10–15 attempts from the office mobile; minimum 5 attended per day",
            ),
            # Starter pointers: switched off until the admin sets a target.
            _pointer("calls_attempted", "System calls attempted", "calls_logged"),
            _pointer("calls_picked_up", "Calls picked up", "outcomes_follow_up"),
            _pointer("companies_called", "Companies called", "companies_called"),
            _pointer("personal_emails", "Personal emails sent", "personal_emails_sent"),
            _pointer("personal_whatsapp", "Personal WhatsApp sent", "personal_whatsapp_sent"),
            _pointer("bulk_whatsapp", "Bulk WhatsApp sent", "bulk_whatsapp_sent"),
            _pointer("client_interested", "Client interested", "outcomes_interested"),
            _pointer("call_remarks", "Call remarks", "call_remarks"),
            _pointer("inbox_replies", "Inbox replies", "inbox_replies"),
        ],
        "user_targets": {},  # {"<user_id>": {"<pointer key>": daily target}}
        "grade_bands": dict(DEFAULT_BANDS),
        "working_days": [0, 1, 2, 3, 4, 5],  # Mon..Sat (0 = Monday)
    }


# --------------------------------------------------------------------------- storage

_BACKEND_DIR = Path(__file__).resolve().parent.parent
_REPO_PATH = _BACKEND_DIR / "data" / "kpi_scorecard.json"
_LOCK = threading.Lock()
_MEMORY: dict[str, Any] | None = None


def _data_path() -> Path:
    override = (os.environ.get("KPI_SCORECARD_CONFIG_PATH") or "").strip()
    if override:
        return Path(override)
    for candidate in (Path("/data/kpi_scorecard.json"), Path("/data/storage/kpi_scorecard.json")):
        parent = candidate.parent
        try:
            if parent.is_dir() and os.access(parent, os.W_OK):
                return candidate
        except OSError:
            continue
    return _REPO_PATH


def _slug(raw: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", (raw or "").strip().lower()).strip("_")[:40]


def _num(value: Any, *, field: str, strict: bool, default: float = 0.0, minimum: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        if strict and value not in (None, ""):
            raise ValueError(f"{field} must be a number") from None
        return default
    if number != number or number < minimum:  # NaN or below the minimum
        if strict:
            raise ValueError(f"{field} must be {minimum:g} or more")
        return default
    return round(number, 2)


def normalise_config(raw: Any, *, strict: bool = False) -> dict[str, Any]:
    """Clean a config. ``strict`` (used on save) raises ValueError instead of quietly fixing."""
    base = default_config()
    if not isinstance(raw, dict):
        if strict:
            raise ValueError("Invalid scorecard settings")
        return base

    pointers: list[dict[str, Any]] = []
    seen: set[str] = set()
    raw_pointers = raw.get("pointers")
    if isinstance(raw_pointers, list):
        for item in raw_pointers:
            if not isinstance(item, dict):
                continue
            label = str(item.get("label") or "").strip()[:60]
            metric = str(item.get("metric") or "").strip()
            if not label:
                if strict:
                    raise ValueError("Every pointer needs a name")
                continue
            if metric not in _METRIC_KEYS:
                if strict:
                    raise ValueError(f"'{label}': unknown measure")
                continue
            key = _slug(str(item.get("key") or label)) or "pointer"
            original, n = key, 2
            while key in seen:
                key = f"{original}_{n}"
                n += 1
            seen.add(key)
            pointers.append(
                {
                    "key": key,
                    "label": label,
                    "metric": metric,
                    "target": _num(item.get("target"), field=f"'{label}' target", strict=strict),
                    "weight": _num(item.get("weight"), field=f"'{label}' weight", strict=strict, default=1.0),
                    "enabled": bool(item.get("enabled")),
                    "note": str(item.get("note") or "").strip()[:200],
                }
            )
        if not pointers and strict:
            raise ValueError("Keep at least one pointer")
    pointers = pointers or base["pointers"]

    user_targets: dict[str, dict[str, float]] = {}
    raw_user = raw.get("user_targets")
    if isinstance(raw_user, dict):
        for uid, per_pointer in raw_user.items():
            if not str(uid).isdigit() or not isinstance(per_pointer, dict):
                continue
            row: dict[str, float] = {}
            for pkey, value in per_pointer.items():
                if pkey in seen and value not in (None, ""):
                    row[pkey] = _num(value, field="Per-person target", strict=strict)
            if row:
                user_targets[str(int(uid))] = row

    bands = dict(DEFAULT_BANDS)
    raw_bands = raw.get("grade_bands")
    if isinstance(raw_bands, dict):
        for grade in GRADE_ORDER:
            if grade in raw_bands:
                bands[grade] = _num(
                    raw_bands[grade], field=f"Grade {grade} minimum", strict=strict, default=DEFAULT_BANDS[grade]
                )
                if bands[grade] > 100 and strict:
                    raise ValueError(f"Grade {grade} minimum cannot be above 100%")
    ordered = [bands[g] for g in GRADE_ORDER]
    if any(a < b for a, b in zip(ordered, ordered[1:])):
        if strict:
            raise ValueError("Grade minimums must go down from A+ to C (A+ highest)")
        bands = dict(DEFAULT_BANDS)

    days = raw.get("working_days")
    working: list[int] = []
    if isinstance(days, list):
        working = sorted({int(d) for d in days if str(d).lstrip("-").isdigit() and 0 <= int(d) <= 6})
    if not working:
        if strict and isinstance(days, list):
            raise ValueError("Pick at least one working day")
        working = base["working_days"]

    return {"pointers": pointers, "user_targets": user_targets, "grade_bands": bands, "working_days": working}


def get_config() -> dict[str, Any]:
    global _MEMORY
    with _LOCK:
        path = _data_path()
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            raw = _MEMORY
        return normalise_config(raw) if raw is not None else default_config()


def save_config(raw: Any) -> dict[str, Any]:
    global _MEMORY
    cleaned = normalise_config(raw, strict=True)
    with _LOCK:
        _MEMORY = deepcopy(cleaned)
        try:
            path = _data_path()
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(cleaned, indent=2), encoding="utf-8")
        except OSError:
            pass  # read-only disk: keep it in memory so Settings still works until restart
    return cleaned


def pin_ok(pin: str | None) -> bool:
    return (pin or "").strip() == KPI_TARGETS_PIN


# --------------------------------------------------------------------------- scoring

def grade_for(percent: float | None, bands: dict[str, float]) -> str | None:
    if percent is None:
        return None
    for grade in GRADE_ORDER:
        if percent + 1e-9 >= bands.get(grade, DEFAULT_BANDS[grade]):
            return grade
    return "D"


def working_days_elapsed(start: date, end: date, today: date, working: set[int]) -> int:
    last = min(end, today)
    count, day = 0, start
    while day <= last:
        if day.weekday() in working:
            count += 1
        day += timedelta(days=1)
    return count


def _people(db: Session, viewer: AppUser, user_id: int | None) -> list[AppUser]:
    role = viewer.role.value if isinstance(viewer.role, AppUserRole) else str(viewer.role)
    if role != AppUserRole.admin.value:
        return [viewer]
    if user_id is not None:
        person = db.get(AppUser, user_id)
        if person is None:
            raise ValueError("User not found")
        return [person]
    rows = db.query(AppUser).filter(AppUser.is_active.is_(True)).order_by(AppUser.full_name.asc()).all()
    return [u for u in rows if (u.role.value if isinstance(u.role, AppUserRole) else str(u.role)) != AppUserRole.admin.value]


def compute_scorecard(
    db: Session,
    *,
    viewer: AppUser,
    report_date: date,
    period: str = "day",
    user_id: int | None = None,
    today: date | None = None,
) -> dict[str, Any]:
    config = get_config()
    bands = config["grade_bands"]
    normalized = activity_module._normalize_period(period)  # noqa: SLF001
    start_date, end_date, start_utc, end_utc = activity_module.period_bounds(report_date, normalized)
    today = today or datetime.now(activity_module.KPI_TIMEZONE).date()
    days = working_days_elapsed(start_date, end_date, today, set(config["working_days"]))

    people = _people(db, viewer, user_id)
    pointers = [p for p in config["pointers"] if p["enabled"]]

    manual_rows: dict[int, list[ManualKpiEntry]] = {}
    ids = [p.id for p in people]
    if ids and any(p["metric"] in MANUAL_METRICS for p in pointers):
        for row in (
            db.query(ManualKpiEntry)
            .filter(
                ManualKpiEntry.user_id.in_(ids),
                ManualKpiEntry.activity_date >= start_date,
                ManualKpiEntry.activity_date <= end_date,
            )
            .all()
        ):
            manual_rows.setdefault(row.user_id, []).append(row)

    def actual_for(person: AppUser, counts: dict[str, int], metric: str) -> int:
        if metric in MANUAL_METRICS:
            test = MANUAL_METRICS[metric][1]
            return sum(1 for e in manual_rows.get(person.id, []) if test(e))
        return int(counts.get(metric) or 0)

    users_out: list[dict[str, Any]] = []
    visible_pointer_keys: set[str] = set()
    team_actual: dict[str, int] = {}
    team_target: dict[str, float] = {}

    for person in people:
        counts: dict[str, int] = {}
        if any(p["metric"] not in MANUAL_METRICS for p in pointers):
            counts = activity_module.get_kpi_counts_for_range(
                db, start_utc=start_utc, end_utc=end_utc, viewer=viewer, user_id=person.id
            )
        overrides = config["user_targets"].get(str(person.id), {})
        rows: list[dict[str, Any]] = []
        weighted_total = weight_sum = 0.0
        for pointer in pointers:
            daily = overrides.get(pointer["key"], pointer["target"])
            actual = actual_for(person, counts, pointer["metric"])
            target = round(daily * days, 2)
            percent: float | None = None
            if daily > 0 and days > 0:
                percent = round(min(actual / target, 1.0) * 100, 1)
                visible_pointer_keys.add(pointer["key"])
                team_actual[pointer["key"]] = team_actual.get(pointer["key"], 0) + actual
                team_target[pointer["key"]] = team_target.get(pointer["key"], 0.0) + target
                weighted_total += percent * pointer["weight"]
                weight_sum += pointer["weight"]
            rows.append(
                {
                    "key": pointer["key"],
                    "actual": actual,
                    "target": target if daily > 0 else None,
                    "percent": percent,
                    "grade": grade_for(percent, bands),
                }
            )
        overall = round(weighted_total / weight_sum, 1) if weight_sum > 0 else None
        users_out.append(
            {
                "user": {"id": person.id, "username": person.username, "full_name": person.full_name},
                "overall_percent": overall,
                "overall_grade": grade_for(overall, bands),
                "pointers": rows,
            }
        )

    shown = [p for p in pointers if p["key"] in visible_pointer_keys]
    for entry in users_out:
        entry["pointers"] = [row for row in entry["pointers"] if row["key"] in visible_pointer_keys]
    team_rows: list[dict[str, Any]] = []
    team_weighted = team_weights = 0.0
    for pointer in shown:
        target = team_target.get(pointer["key"], 0.0)
        actual = team_actual.get(pointer["key"], 0)
        percent = round(min(actual / target, 1.0) * 100, 1) if target > 0 else None
        if percent is not None:
            team_weighted += percent * pointer["weight"]
            team_weights += pointer["weight"]
        team_rows.append(
            {
                "key": pointer["key"],
                "actual": actual,
                "target": round(target, 2) if target > 0 else None,
                "percent": percent,
                "grade": grade_for(percent, bands),
            }
        )
    team_overall = round(team_weighted / team_weights, 1) if team_weights > 0 else None

    return {
        "period": normalized,
        "date": report_date.isoformat(),
        "date_start": start_date.isoformat(),
        "date_end": end_date.isoformat(),
        "timezone": "Asia/Karachi",
        "working_days": days,
        "bands": [{"grade": g, "min": bands[g]} for g in GRADE_ORDER] + [{"grade": "D", "min": 0}],
        "pointers": [
            {
                "key": p["key"],
                "label": p["label"],
                "note": p["note"],
                "source": "manual" if p["metric"] in MANUAL_METRICS else "auto",
                "target_per_day": p["target"],
            }
            for p in shown
        ],
        "users": users_out,
        "team": {"overall_percent": team_overall, "overall_grade": grade_for(team_overall, bands), "pointers": team_rows},
    }
