"""Recurring AI Sales Agent processes for Sara / Rayan."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

_DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "ai_sales_processes.json"
_TZ = ZoneInfo("Asia/Karachi")

WEEKDAY_NAMES = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ensure_file() -> None:
    _DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    if not _DATA_PATH.exists():
        _DATA_PATH.write_text(json.dumps({"processes": []}, indent=2), encoding="utf-8")


def _load() -> dict[str, Any]:
    _ensure_file()
    try:
        raw = json.loads(_DATA_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"processes": []}
    if not isinstance(raw, dict):
        return {"processes": []}
    procs = raw.get("processes")
    if not isinstance(procs, list):
        procs = []
    return {"processes": procs}


def _save(data: dict[str, Any]) -> None:
    _ensure_file()
    _DATA_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")


def _normalize_process(raw: dict[str, Any]) -> dict[str, Any]:
    persona = str(raw.get("persona") or "female").strip().lower()
    if persona not in ("male", "female", "both"):
        persona = "female"
    schedule = raw.get("schedule") if isinstance(raw.get("schedule"), dict) else {}
    kind = str(schedule.get("kind") or "daily").strip().lower()
    if kind not in ("daily", "weekly"):
        kind = "daily"
    time_str = str(schedule.get("time") or "09:45").strip()
    if len(time_str) == 4 and time_str[1] == ":":
        time_str = f"0{time_str}"
    weekdays = schedule.get("weekdays")
    if not isinstance(weekdays, list) or not weekdays:
        weekdays = list(WEEKDAY_NAMES) if kind == "daily" else ["mon"]
    weekdays = [str(d).strip().lower()[:3] for d in weekdays if str(d).strip()]
    weekdays = [d for d in weekdays if d in WEEKDAY_NAMES]
    if not weekdays:
        weekdays = ["mon"]

    actions = raw.get("actions") if isinstance(raw.get("actions"), dict) else {}
    buyer_ids = raw.get("buyer_ids") if isinstance(raw.get("buyer_ids"), list) else []
    contact_ids = raw.get("contact_ids") if isinstance(raw.get("contact_ids"), list) else []
    clean_buyers: list[int] = []
    for b in buyer_ids:
        try:
            n = int(b)
            if n > 0:
                clean_buyers.append(n)
        except (TypeError, ValueError):
            continue
    clean_contacts: list[int | None] = []
    for c in contact_ids:
        if c is None or c == "":
            clean_contacts.append(None)
            continue
        try:
            clean_contacts.append(int(c))
        except (TypeError, ValueError):
            clean_contacts.append(None)

    return {
        "id": str(raw.get("id") or uuid.uuid4()),
        "name": (str(raw.get("name") or "Untitled process").strip() or "Untitled process")[:120],
        "persona": persona,
        "enabled": bool(raw.get("enabled", True)),
        "schedule": {"kind": kind, "time": time_str, "weekdays": weekdays},
        "actions": {
            "call": bool(actions.get("call", False)),
            "email": bool(actions.get("email", True)),
            "whatsapp": bool(actions.get("whatsapp", True)),
        },
        "buyer_ids": clean_buyers,
        "contact_ids": clean_contacts[: len(clean_buyers)] if clean_contacts else [],
        "last_run_at": raw.get("last_run_at"),
        "last_run_key": raw.get("last_run_key"),
        "last_result": raw.get("last_result"),
        "created_at": raw.get("created_at") or _now_iso(),
        "updated_at": raw.get("updated_at") or _now_iso(),
    }


def list_processes() -> list[dict[str, Any]]:
    data = _load()
    return [_normalize_process(p) for p in data["processes"] if isinstance(p, dict)]


def get_process(process_id: str) -> dict[str, Any] | None:
    for p in list_processes():
        if p["id"] == process_id:
            return p
    return None


def create_process(payload: dict[str, Any]) -> dict[str, Any]:
    data = _load()
    proc = _normalize_process({**payload, "id": str(uuid.uuid4()), "created_at": _now_iso(), "updated_at": _now_iso()})
    data["processes"].append(proc)
    _save(data)
    return proc


def update_process(process_id: str, patch: dict[str, Any]) -> dict[str, Any] | None:
    data = _load()
    for i, raw in enumerate(data["processes"]):
        if not isinstance(raw, dict) or str(raw.get("id")) != process_id:
            continue
        merged = {**_normalize_process(raw), **{k: v for k, v in patch.items() if v is not None}}
        merged["id"] = process_id
        merged["updated_at"] = _now_iso()
        proc = _normalize_process(merged)
        data["processes"][i] = proc
        _save(data)
        return proc
    return None


def delete_process(process_id: str) -> bool:
    data = _load()
    before = len(data["processes"])
    data["processes"] = [
        p for p in data["processes"] if not (isinstance(p, dict) and str(p.get("id")) == process_id)
    ]
    if len(data["processes"]) == before:
        return False
    _save(data)
    return True


def mark_process_ran(process_id: str, run_key: str, result: dict[str, Any] | None = None) -> None:
    update_process(
        process_id,
        {
            "last_run_at": _now_iso(),
            "last_run_key": run_key,
            "last_result": result or {},
        },
    )


def due_processes(now: datetime | None = None) -> list[dict[str, Any]]:
    """Return enabled processes that should run at this local minute."""
    local = (now or datetime.now(_TZ)).astimezone(_TZ)
    hhmm = local.strftime("%H:%M")
    weekday = WEEKDAY_NAMES[local.weekday()]
    run_key = local.strftime("%Y-%m-%dT%H:%M")
    due: list[dict[str, Any]] = []
    for proc in list_processes():
        if not proc.get("enabled"):
            continue
        if not proc.get("buyer_ids"):
            continue
        schedule = proc.get("schedule") or {}
        if str(schedule.get("time") or "") != hhmm:
            continue
        weekdays = schedule.get("weekdays") or []
        if weekday not in weekdays:
            continue
        if proc.get("last_run_key") == run_key:
            continue
        due.append(proc)
    return due
