"""Persisted AI Sales Agent Auto Mode settings (Sara / Rayan)."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "ai_sales_auto_mode.json"

DEFAULT_BULK_EMAIL_PERSONA: dict[str, Any] = {
    "template_id": None,
    "from_mailbox_email": "",
    "cc": "",
    "subject": "",
    "body": "",
}

DEFAULT_SETTINGS: dict[str, Any] = {
    "enabled": False,
    "study_contacts": True,
    "call_mode": True,
    "send_email_after_call": True,
    "send_whatsapp_after_call": True,
    "bulk_email_when_no_call": True,
    "study_products": True,
    "product_brief": (
        "Kafi Commodities (Brand: ESSENCE) exports Basmati and non-Basmati rice, "
        "Himalayan pink salt, pickles, chutneys, pastes, sauces, spices, recipe mixes, "
        "honey, and related staples. Emphasize ISO/HACCP/Halal certifications, export "
        "packaging (retail cartons and bulk), consistent quality, and flexible CNF/FOB "
        "quotations by destination port and MOQ."
    ),
    # Per-agent defaults for Start Sara/Rayan when call mode is OFF + bulk email ON.
    "bulk_email_by_persona": {
        "female": dict(DEFAULT_BULK_EMAIL_PERSONA),
        "male": dict(DEFAULT_BULK_EMAIL_PERSONA),
    },
    # One-shot Start at date/time (Schedule button). Not recurring.
    "scheduled_starts": [],
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ensure_file() -> None:
    _DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    if not _DATA_PATH.exists():
        _DATA_PATH.write_text(json.dumps(DEFAULT_SETTINGS, indent=2), encoding="utf-8")


def _load_raw() -> dict[str, Any]:
    _ensure_file()
    try:
        raw = json.loads(_DATA_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return raw if isinstance(raw, dict) else {}


def _save_raw(data: dict[str, Any]) -> None:
    _ensure_file()
    _DATA_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")


def _normalize_bulk_persona(raw: Any) -> dict[str, Any]:
    out = dict(DEFAULT_BULK_EMAIL_PERSONA)
    if not isinstance(raw, dict):
        return out
    tid = raw.get("template_id")
    if tid is None or tid == "":
        out["template_id"] = None
    else:
        try:
            out["template_id"] = int(tid)
        except (TypeError, ValueError):
            out["template_id"] = None
    out["from_mailbox_email"] = str(raw.get("from_mailbox_email") or "").strip()
    out["cc"] = str(raw.get("cc") or "").strip()
    out["subject"] = str(raw.get("subject") or "")
    out["body"] = str(raw.get("body") or "")
    return out


def _normalize_bulk_by_persona(raw: Any) -> dict[str, dict[str, Any]]:
    base = {
        "female": dict(DEFAULT_BULK_EMAIL_PERSONA),
        "male": dict(DEFAULT_BULK_EMAIL_PERSONA),
    }
    if not isinstance(raw, dict):
        return base
    for persona in ("female", "male"):
        if persona in raw:
            base[persona] = _normalize_bulk_persona(raw.get(persona))
    return base


def _parse_run_at(value: str) -> datetime:
    raw = (value or "").strip()
    if not raw:
        raise ValueError("run_at is required")
    # datetime-local from browsers is "YYYY-MM-DDTHH:MM" (no tz) — treat as Asia/Karachi.
    if len(raw) == 16 and "T" in raw and "+" not in raw and not raw.endswith("Z"):
        raw = f"{raw}:00"
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("Invalid run_at datetime") from exc
    if dt.tzinfo is None:
        from zoneinfo import ZoneInfo

        dt = dt.replace(tzinfo=ZoneInfo("Asia/Karachi"))
    return dt.astimezone(timezone.utc)


def _normalize_scheduled_start(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    persona = str(raw.get("persona") or "").strip().lower()
    if persona not in ("female", "male"):
        return None
    run_at = str(raw.get("run_at") or "").strip()
    if not run_at:
        return None
    status = str(raw.get("status") or "pending").strip().lower()
    if status not in ("pending", "running", "done", "failed", "cancelled"):
        status = "pending"
    try:
        created_by = int(raw.get("created_by") or 0) or None
    except (TypeError, ValueError):
        created_by = None
    return {
        "id": str(raw.get("id") or uuid.uuid4()),
        "persona": persona,
        "run_at": run_at,
        "status": status,
        "created_by": created_by,
        "created_at": str(raw.get("created_at") or _now_iso()),
        "finished_at": raw.get("finished_at"),
        "error": raw.get("error"),
        "result_message": raw.get("result_message"),
    }


def _normalize_scheduled_starts(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for item in raw:
        norm = _normalize_scheduled_start(item)
        if norm:
            out.append(norm)
    # Keep recent history; drop very old cancelled/done beyond 40.
    pending = [x for x in out if x["status"] in ("pending", "running")]
    done = [x for x in out if x["status"] not in ("pending", "running")][-30:]
    return pending + done


def get_auto_mode_settings() -> dict[str, Any]:
    raw = _load_raw()
    out = json.loads(json.dumps(DEFAULT_SETTINGS))
    for key, default in DEFAULT_SETTINGS.items():
        if key not in raw:
            continue
        if key == "bulk_email_by_persona":
            out[key] = _normalize_bulk_by_persona(raw.get(key))
        elif key == "scheduled_starts":
            out[key] = _normalize_scheduled_starts(raw.get(key))
        elif isinstance(default, bool):
            out[key] = bool(raw[key])
        elif isinstance(default, str):
            out[key] = str(raw[key] or default)
        elif isinstance(default, list):
            out[key] = raw[key] if isinstance(raw[key], list) else list(default)
        else:
            out[key] = raw[key]
    return out


def get_bulk_email_config(persona: str) -> dict[str, Any]:
    """Return Sara/Rayan bulk-email setup (template, from, cc, editable body)."""
    persona = "female" if persona not in ("male", "female") else persona
    settings = get_auto_mode_settings()
    by_persona = settings.get("bulk_email_by_persona") or {}
    return _normalize_bulk_persona(by_persona.get(persona))


def update_auto_mode_settings(patch: dict[str, Any]) -> dict[str, Any]:
    current = get_auto_mode_settings()
    for key, default in DEFAULT_SETTINGS.items():
        if key not in patch:
            continue
        if key == "scheduled_starts":
            # Managed via schedule_start / cancel — ignore accidental PUT overwrites.
            continue
        if key == "bulk_email_by_persona":
            incoming = patch.get(key)
            if not isinstance(incoming, dict):
                continue
            merged = _normalize_bulk_by_persona(current.get("bulk_email_by_persona"))
            for persona in ("female", "male"):
                if persona in incoming:
                    prev = merged[persona]
                    chunk = incoming[persona]
                    if isinstance(chunk, dict):
                        merged[persona] = _normalize_bulk_persona({**prev, **chunk})
            current[key] = merged
        elif isinstance(default, bool):
            current[key] = bool(patch[key])
        elif isinstance(default, str):
            current[key] = str(patch[key] if patch[key] is not None else default)
    _save_raw(current)
    return current


def list_scheduled_starts(*, pending_only: bool = False) -> list[dict[str, Any]]:
    rows = list(get_auto_mode_settings().get("scheduled_starts") or [])
    if pending_only:
        return [r for r in rows if r.get("status") in ("pending", "running")]
    return rows


def schedule_start(
    *,
    persona: str,
    run_at: str,
    created_by: int | None,
) -> dict[str, Any]:
    """Queue a one-shot Start for Sara/Rayan at run_at (local Karachi if no tz)."""
    persona = "female" if persona not in ("male", "female") else persona
    dt_utc = _parse_run_at(run_at)
    now = datetime.now(timezone.utc)
    if dt_utc <= now:
        raise ValueError("Choose a date and time in the future")

    data = get_auto_mode_settings()
    starts = list(data.get("scheduled_starts") or [])
    # Replace any pending/running start for the same agent.
    starts = [
        s
        for s in starts
        if not (s.get("persona") == persona and s.get("status") in ("pending", "running"))
    ]
    entry = {
        "id": str(uuid.uuid4()),
        "persona": persona,
        "run_at": dt_utc.isoformat(),
        "status": "pending",
        "created_by": created_by,
        "created_at": _now_iso(),
        "finished_at": None,
        "error": None,
        "result_message": None,
    }
    starts.append(entry)
    data["scheduled_starts"] = _normalize_scheduled_starts(starts)
    _save_raw(data)
    return entry


def cancel_scheduled_start(schedule_id: str) -> dict[str, Any]:
    data = get_auto_mode_settings()
    starts = list(data.get("scheduled_starts") or [])
    found = None
    for row in starts:
        if row.get("id") == schedule_id:
            if row.get("status") not in ("pending", "running"):
                raise ValueError("That schedule already finished")
            row["status"] = "cancelled"
            row["finished_at"] = _now_iso()
            found = row
            break
    if not found:
        raise ValueError("Schedule not found")
    data["scheduled_starts"] = starts
    _save_raw(data)
    return found


def due_scheduled_starts() -> list[dict[str, Any]]:
    now = datetime.now(timezone.utc)
    due: list[dict[str, Any]] = []
    for row in list_scheduled_starts(pending_only=True):
        if row.get("status") != "pending":
            continue
        try:
            when = datetime.fromisoformat(str(row["run_at"]).replace("Z", "+00:00"))
            if when.tzinfo is None:
                when = when.replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        if when <= now:
            due.append(row)
    return due


def mark_scheduled_start(
    schedule_id: str,
    *,
    status: str,
    error: str | None = None,
    result_message: str | None = None,
) -> dict[str, Any] | None:
    data = get_auto_mode_settings()
    starts = list(data.get("scheduled_starts") or [])
    found = None
    for row in starts:
        if row.get("id") == schedule_id:
            row["status"] = status
            if status in ("done", "failed", "cancelled"):
                row["finished_at"] = _now_iso()
            if error is not None:
                row["error"] = error
            if result_message is not None:
                row["result_message"] = result_message
            found = row
            break
    if found:
        data["scheduled_starts"] = starts
        _save_raw(data)
    return found
