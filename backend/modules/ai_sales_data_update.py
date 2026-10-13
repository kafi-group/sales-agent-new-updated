"""AI Auto Data Update Schedule — Sara/Rayan only, one schedule each.

Processes the Data Update queue (mutually exclusive with Outreach) one contact
at a time with a cooldown. Autopilot: research missing fields and save without
human review; report progress + completion summary.
"""

from __future__ import annotations

import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

_DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "ai_sales_data_update.json"
_TZ = ZoneInfo("Asia/Karachi")
WEEKDAY_NAMES = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")

PRIORITY_FIELDS = (
    "company_name",
    "contact_name",
    "contact_designation",
    "contact_phone",
    "contact_email",
    "website_url",
    "country",
)

FIELD_LABELS = {
    "company_name": "Company name",
    "contact_name": "Contact person",
    "contact_designation": "Designation",
    "contact_phone": "Phone",
    "contact_email": "Email",
    "website_url": "Website",
    "country": "Country",
}

DEFAULT_COOLDOWN_SEC = 45
MAX_RUN_HISTORY = 40
MAX_LOG_LINES = 80
MAX_REPORT_LOG_LINES = 40


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _now_iso() -> str:
    return _now_utc().isoformat()


def _default_persona_schedule() -> dict[str, Any]:
    return {
        "enabled": False,
        "time": "10:00",
        "end_time": "",  # optional HH:MM — used when stop_mode is until_end_time
        "stop_mode": "until_done",  # until_done | until_end_time
        "weekdays": list(WEEKDAY_NAMES),
        "cooldown_sec": DEFAULT_COOLDOWN_SEC,
        "last_run_key": None,
        "last_started_at": None,
    }


def _default_run_state() -> dict[str, Any]:
    return {
        "status": "idle",  # idle | running | completed
        "current_buyer_id": None,
        "current_label": None,
        "next_allowed_at": None,
        "progress": {
            "done": 0,
            "total": 0,
            "succeeded": 0,
            "failed": 0,
            "skipped": 0,
            "filled_total": 0,
        },
        "log": [],  # current run per-contact results
        "last_report": None,
        # Completed (and interrupted) runs — newest first — for later review.
        "run_history": [],
        "updated_at": None,
        "run_id": None,
    }


def _default_store() -> dict[str, Any]:
    return {
        "schedules": {
            "female": _default_persona_schedule(),
            "male": _default_persona_schedule(),
        },
        "run_state": {
            "female": _default_run_state(),
            "male": _default_run_state(),
        },
    }


def _merge_schedule(sch: dict[str, Any]) -> dict[str, Any]:
    merged = _default_persona_schedule()
    merged["enabled"] = bool(sch.get("enabled", False))
    merged["time"] = str(sch.get("time") or "10:00").strip() or "10:00"
    end_t = str(sch.get("end_time") or "").strip()
    merged["end_time"] = end_t
    stop_mode = str(sch.get("stop_mode") or "until_done").strip().lower()
    merged["stop_mode"] = (
        stop_mode if stop_mode in ("until_done", "until_end_time") else "until_done"
    )
    wds = sch.get("weekdays")
    if isinstance(wds, list) and wds:
        cleaned = [str(d).strip().lower()[:3] for d in wds if str(d).strip()]
        cleaned = [d for d in cleaned if d in WEEKDAY_NAMES]
        if cleaned:
            merged["weekdays"] = cleaned
    try:
        merged["cooldown_sec"] = max(15, min(600, int(sch.get("cooldown_sec") or DEFAULT_COOLDOWN_SEC)))
    except (TypeError, ValueError):
        merged["cooldown_sec"] = DEFAULT_COOLDOWN_SEC
    merged["last_run_key"] = sch.get("last_run_key")
    merged["last_started_at"] = sch.get("last_started_at")
    return merged


def _merge_run_state(st: dict[str, Any]) -> dict[str, Any]:
    merged_st = _default_run_state()
    merged_st.update({k: st.get(k, merged_st.get(k)) for k in merged_st})
    if isinstance(st.get("progress"), dict):
        merged_st["progress"] = {**merged_st["progress"], **st["progress"]}
    if isinstance(st.get("log"), list):
        merged_st["log"] = st["log"][-MAX_LOG_LINES:]
    if isinstance(st.get("run_history"), list):
        merged_st["run_history"] = [
            h for h in st["run_history"] if isinstance(h, dict)
        ][:MAX_RUN_HISTORY]
    if not merged_st["run_history"] and isinstance(merged_st.get("last_report"), dict):
        merged_st["run_history"] = [merged_st["last_report"]]
    return merged_st


def _ensure_file() -> None:
    _DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    if not _DATA_PATH.exists():
        _DATA_PATH.write_text(json.dumps(_default_store(), indent=2), encoding="utf-8")


def _load() -> dict[str, Any]:
    _ensure_file()
    try:
        raw = json.loads(_DATA_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return _default_store()
    if not isinstance(raw, dict):
        return _default_store()
    base = _default_store()
    raw_sch = raw.get("schedules") if isinstance(raw.get("schedules"), dict) else {}
    raw_st = raw.get("run_state") if isinstance(raw.get("run_state"), dict) else {}
    persona_ids = set(base["schedules"].keys()) | set(raw_sch.keys()) | set(raw_st.keys())
    for persona in persona_ids:
        sch = raw_sch.get(persona)
        if isinstance(sch, dict):
            base["schedules"][persona] = _merge_schedule(sch)
        elif persona not in base["schedules"]:
            base["schedules"][persona] = _default_persona_schedule()
        st = raw_st.get(persona)
        if isinstance(st, dict):
            base["run_state"][persona] = _merge_run_state(st)
        elif persona not in base["run_state"]:
            base["run_state"][persona] = _default_run_state()
    if raw.get("highlights_synced_v1"):
        base["highlights_synced_v1"] = True
    return base


def persona_ids() -> list[str]:
    data = _load()
    ids = list(data.get("schedules") or {})
    # Prefer Sara/Rayan first for stable UI order
    preferred = [p for p in ("female", "male") if p in ids]
    rest = sorted(p for p in ids if p not in preferred)
    return preferred + rest


def ensure_persona_slots(ids: list[str] | None = None) -> list[str]:
    """Add schedule/run_state slots for new AI agents without touching existing queues."""
    wanted = [str(x).strip() for x in (ids or []) if str(x).strip()]
    if not wanted:
        try:
            from modules import org_admin_config as org

            wanted = org.active_agent_ids()
        except Exception:  # noqa: BLE001
            wanted = ["female", "male"]
    data = _load()
    dirty = False
    for pid in wanted:
        if pid not in data["schedules"]:
            data["schedules"][pid] = _default_persona_schedule()
            dirty = True
        if pid not in data["run_state"]:
            data["run_state"][pid] = _default_run_state()
            dirty = True
    if dirty:
        _save(data)
    return persona_ids()


def _normalize_persona(persona: str, data: dict[str, Any] | None = None) -> str:
    p = str(persona or "").strip()
    store = data or _load()
    known = set(store.get("schedules") or {}) | set(store.get("run_state") or {})
    if p in known:
        return p
    if p in ("male", "female"):
        return p
    return "female"


def _report_dedupe_key(report: dict[str, Any]) -> str:
    return str(report.get("run_id") or report.get("finished_at") or "")


def _prepend_run_history(
    history: list[dict[str, Any]], report: dict[str, Any]
) -> list[dict[str, Any]]:
    if not isinstance(report, dict):
        return history[:MAX_RUN_HISTORY]
    key = _report_dedupe_key(report)
    cleaned = [
        h
        for h in history
        if isinstance(h, dict) and (not key or _report_dedupe_key(h) != key)
    ]
    cleaned.insert(0, report)
    return cleaned[:MAX_RUN_HISTORY]


def _snapshot_report_from_state(st: dict[str, Any], *, partial: bool = False) -> dict[str, Any]:
    prog = st.get("progress") or {}
    return {
        "finished_at": _now_iso(),
        "succeeded": prog.get("succeeded", 0),
        "failed": prog.get("failed", 0),
        "skipped": prog.get("skipped", 0),
        "filled_total": prog.get("filled_total", 0),
        "done": prog.get("done", 0),
        "total": prog.get("total", 0),
        "log": list(st.get("log") or [])[-MAX_REPORT_LOG_LINES:],
        "run_id": st.get("run_id"),
        "partial": bool(partial),
    }

def _save(data: dict[str, Any]) -> None:
    _ensure_file()
    _DATA_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")


def get_status() -> dict[str, Any]:
    try:
        ensure_persona_slots()
    except Exception:  # noqa: BLE001
        pass
    data = _load()
    # Persist one-time seed of last_report → run_history for older installs.
    dirty = False
    for persona in list(data.get("run_state") or {}):
        st = data["run_state"][persona]
        if not st.get("run_history") and isinstance(st.get("last_report"), dict):
            st["run_history"] = [st["last_report"]]
            dirty = True
    if dirty:
        _save(data)
    return data


def update_schedule(persona: str, patch: dict[str, Any]) -> dict[str, Any]:
    data = _load()
    persona = _normalize_persona(persona, data)
    if persona not in data["schedules"]:
        data["schedules"][persona] = _default_persona_schedule()
        data["run_state"][persona] = _default_run_state()
    sch = data["schedules"][persona]
    if "enabled" in patch:
        sch["enabled"] = bool(patch["enabled"])
    if "time" in patch and patch["time"]:
        t = str(patch["time"]).strip()
        if len(t) == 4 and t[1] == ":":
            t = f"0{t}"
        sch["time"] = t
    if "end_time" in patch:
        et = str(patch.get("end_time") or "").strip()
        if et and len(et) == 4 and et[1] == ":":
            et = f"0{et}"
        sch["end_time"] = et
    if "stop_mode" in patch and patch["stop_mode"] is not None:
        mode = str(patch["stop_mode"]).strip().lower()
        if mode in ("until_done", "until_end_time"):
            sch["stop_mode"] = mode
    if "weekdays" in patch and isinstance(patch["weekdays"], list):
        cleaned = [str(d).strip().lower()[:3] for d in patch["weekdays"] if str(d).strip()]
        cleaned = [d for d in cleaned if d in WEEKDAY_NAMES]
        # Allow empty (disarm days) or any subset — previously empty was ignored.
        sch["weekdays"] = cleaned if cleaned else list(WEEKDAY_NAMES)
    if "cooldown_sec" in patch:
        try:
            sch["cooldown_sec"] = max(15, min(600, int(patch["cooldown_sec"])))
        except (TypeError, ValueError):
            pass
    data["schedules"][persona] = sch
    _save(data)
    return data


def _parse_hhmm(value: str) -> tuple[int, int] | None:
    try:
        parts = str(value or "").strip().split(":")
        return int(parts[0]), int(parts[1])
    except (TypeError, ValueError, IndexError):
        return None


def past_end_time(sch: dict[str, Any]) -> bool:
    """True when stop_mode is until_end_time and local time is past end_time."""
    if str(sch.get("stop_mode") or "") != "until_end_time":
        return False
    parsed = _parse_hhmm(str(sch.get("end_time") or ""))
    if not parsed:
        return False
    hour, minute = parsed
    now = datetime.now(_TZ)
    return (now.hour, now.minute) > (hour, minute)


def should_stop_running(persona: str) -> bool:
    data = _load()
    persona = _normalize_persona(persona, data)
    sch = data["schedules"].get(persona) or _default_persona_schedule()
    return past_end_time(sch)


def _is_blank(value: Any) -> bool:
    v = str(value or "").strip()
    return (not v) or v in {"—", "-", "Not found", "not found", "N/A", "n/a"}


def _pick_line(text: str, patterns: list[re.Pattern[str]]) -> str:
    for line in text.splitlines():
        trimmed = re.sub(r"^[-*#\s]+", "", line).strip()
        for pat in patterns:
            m = pat.match(trimmed)
            if m and m.group(1):
                return re.sub(r"\*\*", "", m.group(1)).strip()
    return ""


def parse_research_reply(text: str) -> dict[str, str]:
    """Parse chatbot structured reply into CRM field candidates."""
    if not (text or "").strip():
        return {}
    company = _pick_line(
        text,
        [
            re.compile(r"^(?:\*\*)?(?:brand name|company name|parent company)(?:\*\*)?:\s*(.+)$", re.I),
        ],
    )
    country = _pick_line(
        text,
        [re.compile(r"^(?:\*\*)?(?:country|head office country)(?:\*\*)?:\s*(.+)$", re.I)],
    )
    industry = _pick_line(
        text,
        [re.compile(r"^(?:\*\*)?(?:business type|industry|sector)(?:\*\*)?:\s*(.+)$", re.I)],
    )
    website = _pick_line(
        text,
        [
            re.compile(r"^(?:\*\*)?website(?:\*\*)?:\s*(.+)$", re.I),
            re.compile(r"^(?:\*\*)?website url(?:\*\*)?:\s*(.+)$", re.I),
        ],
    )
    if website and not re.match(r"^https?://", website, re.I) and "not found" not in website.lower():
        website = "https://" + website.lstrip("/")
    address = _pick_line(
        text,
        [
            re.compile(
                r"^(?:\*\*)?(?:head office address|address|office address)(?:\*\*)?:\s*(.+)$",
                re.I,
            )
        ],
    )
    phone = _pick_line(
        text,
        [re.compile(r"^(?:\*\*)?(?:phone|phone numbers?|tel)(?:\*\*)?:\s*(.+)$", re.I)],
    )
    if not phone:
        m = re.search(r"\+?\d[\d\s().-]{7,}\d", text)
        phone = m.group(0).strip() if m else ""
    email = _pick_line(
        text,
        [re.compile(r"^(?:\*\*)?(?:email|email addresses?)(?:\*\*)?:\s*(.+)$", re.I)],
    )
    if not email:
        m = re.search(r"[\w.+-]+@[\w.-]+\.\w{2,}", text)
        email = m.group(0) if m else ""
    contact_name = _pick_line(
        text,
        [
            re.compile(
                r"^(?:\*\*)?(?:contact person|contact name|person name)(?:\*\*)?:\s*(.+)$",
                re.I,
            )
        ],
    )
    designation = _pick_line(
        text,
        [re.compile(r"^(?:\*\*)?(?:designation|role|job title)(?:\*\*)?:\s*(.+)$", re.I)],
    )

    def clean(v: str) -> str:
        v = (v or "").strip()
        if _is_blank(v) or re.match(r"^not\s+found", v, re.I):
            return ""
        if re.match(r"^provided data", v, re.I):
            v = re.sub(r"^provided data\s*[:\-–]?\s*", "", v, flags=re.I).strip()
        return "" if _is_blank(v) else v

    return {
        "company_name": clean(company),
        "country": clean(country),
        "industry": clean(industry)[:120],
        "website_url": clean(website),
        "address": clean(address),
        "contact_phone": clean(phone),
        "contact_email": clean(email),
        "contact_name": clean(contact_name),
        "contact_designation": clean(designation),
    }


def build_research_prompt(row: dict[str, Any]) -> str:
    known: list[str] = []
    for label, key in (
        ("Company name", "company_name"),
        ("Contact person", "contact_name"),
        ("Phone", "contact_phone"),
        ("Email", "contact_email"),
        ("Country", "country"),
        ("City", "city"),
        ("Business type", "industry"),
        ("Website", "website_url"),
        ("Address", "address"),
        ("Designation", "contact_designation"),
        ("Company grading", "company_grading"),
    ):
        val = row.get(key)
        if not _is_blank(val):
            known.append(f"- {label}: {str(val).strip()}")

    missing = [FIELD_LABELS[k] for k in PRIORITY_FIELDS if _is_blank(row.get(k))]
    return (
        "I have this CRM contact with incomplete data. Search the internet and fill ONLY the missing fields. "
        "Do not invent facts — write \"Not found\" when unknown. Do not change fields that are already provided.\n\n"
        f"Known data:\n{chr(10).join(known) if known else '- (almost nothing on file)'}\n\n"
        f"Missing fields to find (priority order): {', '.join(missing) if missing else 'any useful company/contact details'}.\n\n"
        "Return a clear structured profile with these labels on their own lines:\n"
        "Company name:\nCountry:\nBusiness type:\nWebsite:\nAddress:\nPhone:\nEmail:\nContact person:\nDesignation:\n"
        "Company overview:"
    )


def _schedule_due(sch: dict[str, Any]) -> bool:
    if not sch.get("enabled"):
        return False
    now = datetime.now(_TZ)
    wd = WEEKDAY_NAMES[now.weekday()]
    if wd not in (sch.get("weekdays") or []):
        return False
    time_str = str(sch.get("time") or "10:00")
    try:
        hour, minute = [int(x) for x in time_str.split(":")[:2]]
    except (TypeError, ValueError):
        return False
    # Due within the scheduled minute (job ticks every 1 min).
    if now.hour != hour or now.minute != minute:
        return False
    run_key = now.strftime("%Y-%m-%dT%H:%M")
    return sch.get("last_run_key") != run_key


def start_run(persona: str, *, total: int, force: bool = False) -> dict[str, Any]:
    persona = _normalize_persona(persona)
    data = _load()
    prev = data["run_state"][persona]
    if prev.get("status") == "running" and not force:
        return data

    # Keep reviewable history across runs (start_run used to wipe the whole state).
    history = list(prev.get("run_history") or [])
    last_report = prev.get("last_report") if isinstance(prev.get("last_report"), dict) else None
    if prev.get("status") == "running" and list(prev.get("log") or []):
        history = _prepend_run_history(
            history, _snapshot_report_from_state(prev, partial=True)
        )
    elif last_report:
        history = _prepend_run_history(history, last_report)

    st = _default_run_state()
    st["run_history"] = history[:MAX_RUN_HISTORY]
    st["last_report"] = last_report
    st["status"] = "running"
    st["run_id"] = f"{persona}-{int(time.time())}"
    st["progress"] = {
        "done": 0,
        "total": max(0, int(total)),
        "succeeded": 0,
        "failed": 0,
        "skipped": 0,
        "filled_total": 0,
    }
    st["log"] = []
    st["updated_at"] = _now_iso()
    st["next_allowed_at"] = None
    data["run_state"][persona] = st
    sch = data["schedules"][persona]
    sch["last_started_at"] = _now_iso()
    if not force:
        sch["last_run_key"] = datetime.now(_TZ).strftime("%Y-%m-%dT%H:%M")
    data["schedules"][persona] = sch
    _save(data)
    return data


def _append_log(st: dict[str, Any], entry: dict[str, Any]) -> None:
    log = list(st.get("log") or [])
    log.append(entry)
    st["log"] = log[-MAX_LOG_LINES:]


def complete_run(persona: str) -> dict[str, Any]:
    persona = _normalize_persona(persona)
    data = _load()
    st = data["run_state"][persona]
    report = _snapshot_report_from_state(st, partial=False)
    st["status"] = "completed"
    st["current_buyer_id"] = None
    st["current_label"] = None
    st["last_report"] = report
    st["run_history"] = _prepend_run_history(list(st.get("run_history") or []), report)
    st["updated_at"] = _now_iso()
    data["run_state"][persona] = st
    _save(data)
    return data


def mark_ai_data_update_fields(db: Any, buyer_id: int, fields: list[str]) -> None:
    """Merge CRM field keys filled by Data Update onto the buyer (for list yellow highlights)."""
    if not buyer_id or not fields:
        return
    from db.models import Buyer

    allowed = set(PRIORITY_FIELDS) | {"industry", "address"}
    clean = [f for f in fields if f in allowed]
    if not clean:
        return
    buyer = db.get(Buyer, int(buyer_id))
    if not buyer:
        return
    prev = getattr(buyer, "ai_data_update_fields", None) or []
    if not isinstance(prev, list):
        prev = []
    merged = sorted(set([*prev, *clean]))
    buyer.ai_data_update_fields = merged
    try:
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()


def clear_ai_data_update_fields(db: Any, buyer_id: int, fields: list[str]) -> None:
    """Drop highlight flags when a human manually edits those cells."""
    if not buyer_id or not fields:
        return
    from db.models import Buyer

    buyer = db.get(Buyer, int(buyer_id))
    if not buyer:
        return
    prev = getattr(buyer, "ai_data_update_fields", None) or []
    if not isinstance(prev, list) or not prev:
        return
    drop = set(fields)
    next_fields = [f for f in prev if f not in drop]
    if next_fields == prev:
        return
    buyer.ai_data_update_fields = next_fields or None
    try:
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()


def sync_highlights_from_run_logs(db: Any) -> int:
    """Backfill buyer.ai_data_update_fields from Data Update activity logs (no process change)."""
    data = _load()
    stamped = 0
    for persona in list(data.get("run_state") or {}):
        st = data.get("run_state", {}).get(persona) or {}
        entries: list[dict[str, Any]] = []
        for item in st.get("log") or []:
            if isinstance(item, dict):
                entries.append(item)
        for hist in st.get("run_history") or []:
            if not isinstance(hist, dict):
                continue
            for item in hist.get("log") or []:
                if isinstance(item, dict):
                    entries.append(item)
        last = st.get("last_report")
        if isinstance(last, dict):
            for item in last.get("log") or []:
                if isinstance(item, dict):
                    entries.append(item)
        seen: set[int] = set()
        for entry in entries:
            if entry.get("skipped") or not entry.get("ok"):
                continue
            bid = entry.get("buyer_id")
            filled = entry.get("filled") or []
            if not bid or not filled:
                continue
            bid_i = int(bid)
            mark_ai_data_update_fields(db, bid_i, list(filled))
            if bid_i not in seen:
                seen.add(bid_i)
                stamped += 1
    return stamped


def maybe_sync_highlights_once(db: Any) -> None:
    """Backfill highlights from logs at most once (flag stored in schedule JSON)."""
    data = _load()
    if data.get("highlights_synced_v1"):
        return
    try:
        sync_highlights_from_run_logs(db)
        data = _load()
        data["highlights_synced_v1"] = True
        _save(data)
    except Exception:  # noqa: BLE001
        # Retry on a later poll (e.g. column not created yet).
        pass


def research_and_update_buyer(db: Any, buyer_id: int) -> dict[str, Any]:
    """Autopilot: research missing fields via chatbot (+ enrich fallback), save empties only."""
    from modules import leads as leads_module
    from modules import product_chatbot
    from modules.lead_discovery import enrich_existing_buyer

    row = leads_module.get_lead_table_row(db, buyer_id)
    if not row:
        return {"ok": False, "error": "Lead not found", "filled": [], "changes": []}

    missing = [k for k in PRIORITY_FIELDS if _is_blank(row.get(k))]
    if not missing:
        return {
            "ok": True,
            "skipped": True,
            "reason": "No priority fields missing",
            "filled": [],
            "changes": [],
            "label": row.get("company_name") or row.get("contact_name") or f"#{buyer_id}",
        }

    prompt = build_research_prompt(row)
    reply = ""
    provider = None
    try:
        resp = product_chatbot.chat(
            message=prompt,
            image_bytes=None,
            mime_type="image/jpeg",
            history=[],
        )
        reply = str(resp.get("reply") or "")
        provider = resp.get("provider")
    except Exception as exc:  # noqa: BLE001
        # Fall through to classic enrich/onboard
        reply = ""
        provider = f"chatbot_error:{exc}"[:120]

    found = parse_research_reply(reply) if reply else {}
    update_payload: dict[str, Any] = {}
    # Target the existing contact row so we never create a second contact that
    # hides the original phone (same rule as AI Research & Update).
    if row.get("contact_id") is not None:
        update_payload["contact_id"] = row.get("contact_id")

    for key in PRIORITY_FIELDS:
        # Fill empties only — never overwrite existing CRM values.
        if not _is_blank(row.get(key)):
            continue
        val = found.get(key)
        if key == "contact_designation":
            val = found.get("contact_designation") or found.get("designation")
        if val and not _is_blank(val):
            update_payload[key] = val

    # Drop blank contact patches so upsert cannot clear filled fields.
    for key in list(update_payload.keys()):
        if key == "contact_id":
            continue
        if key.startswith("contact_") and _is_blank(update_payload.get(key)):
            update_payload.pop(key, None)

    # If chatbot found little, try classic enrichment (fills empties only).
    if len([k for k in update_payload if k != "contact_id"]) < 1:
        try:
            enrich_existing_buyer(db, buyer_id)
            db.commit()
        except Exception:  # noqa: BLE001
            db.rollback()
        try:
            from modules import leads as lm

            lm.onboard_buyer(db, buyer_id)
        except Exception:  # noqa: BLE001
            pass
        # Repair any split contacts enrichment may have left behind.
        try:
            from modules import buyers as buyers_module

            buyers_module.merge_stranded_contact_fields(db, buyer_id)
        except Exception:  # noqa: BLE001
            pass

    filled: list[str] = []
    changes: list[dict[str, str]] = []
    patch_keys = [k for k in update_payload if k != "contact_id"]
    if patch_keys:
        updated = leads_module.update_lead_table_row(
            db,
            buyer_id,
            update_payload,
            fill_missing_only=True,
        )
        if updated:
            # Recompute what actually landed (guard may have dropped some keys).
            after_row = updated
            filled = []
            changes = []
            for key in patch_keys:
                if _is_blank(row.get(key)) and not _is_blank(after_row.get(key)):
                    filled.append(key)
                    changes.append(
                        {
                            "field": key,
                            "label": FIELD_LABELS.get(key, key),
                            "before": str(row.get(key) or "").strip() or "(empty)",
                            "after": str(after_row.get(key) or "").strip(),
                        }
                    )
    else:
        # Buyer-only / enrich path — still merge stranded phones onto the display contact.
        try:
            from modules import buyers as buyers_module

            buyers_module.merge_stranded_contact_fields(db, buyer_id)
        except Exception:  # noqa: BLE001
            pass

    # Re-read to report what changed after enrich/onboard path
    after = leads_module.get_lead_table_row(db, buyer_id) or row
    if not filled:
        for key in PRIORITY_FIELDS:
            if _is_blank(row.get(key)) and not _is_blank(after.get(key)):
                filled.append(key)
                changes.append(
                    {
                        "field": key,
                        "label": FIELD_LABELS.get(key, key),
                        "before": "(empty)",
                        "after": str(after.get(key) or "").strip(),
                    }
                )

    if filled:
        try:
            mark_ai_data_update_fields(db, buyer_id, filled)
        except Exception:  # noqa: BLE001
            pass

    return {
        "ok": True,
        "skipped": False,
        "filled": filled,
        "changes": changes,
        "provider": provider,
        "label": after.get("company_name") or after.get("contact_name") or f"#{buyer_id}",
        "missing_before": missing,
    }


def record_contact_result(
    persona: str,
    *,
    buyer_id: int,
    label: str,
    result: dict[str, Any],
    cooldown_sec: int,
) -> dict[str, Any]:
    persona = _normalize_persona(persona)
    data = _load()
    st = data["run_state"][persona]
    prog = dict(st.get("progress") or {})
    prog["done"] = int(prog.get("done") or 0) + 1
    if result.get("skipped"):
        prog["skipped"] = int(prog.get("skipped") or 0) + 1
    elif result.get("ok") and result.get("filled"):
        prog["succeeded"] = int(prog.get("succeeded") or 0) + 1
        prog["filled_total"] = int(prog.get("filled_total") or 0) + len(result.get("filled") or [])
    elif result.get("ok"):
        prog["skipped"] = int(prog.get("skipped") or 0) + 1
    else:
        prog["failed"] = int(prog.get("failed") or 0) + 1
    st["progress"] = prog
    st["current_buyer_id"] = None
    st["current_label"] = None
    next_at = _now_utc().timestamp() + max(15, int(cooldown_sec or DEFAULT_COOLDOWN_SEC))
    st["next_allowed_at"] = datetime.fromtimestamp(next_at, tz=timezone.utc).isoformat()
    st["updated_at"] = _now_iso()
    _append_log(
        st,
        {
            "at": _now_iso(),
            "buyer_id": buyer_id,
            "label": label,
            "ok": bool(result.get("ok")),
            "skipped": bool(result.get("skipped")),
            "filled": result.get("filled") or [],
            "changes": result.get("changes") or [],
            "error": result.get("error"),
            "provider": result.get("provider"),
            "reason": result.get("reason"),
        },
    )
    data["run_state"][persona] = st
    _save(data)
    return data


def cooldown_elapsed(persona: str) -> bool:
    data = _load()
    st = data["run_state"].get(persona) or {}
    nxt = st.get("next_allowed_at")
    if not nxt:
        return True
    try:
        when = datetime.fromisoformat(str(nxt).replace("Z", "+00:00"))
        if when.tzinfo is None:
            when = when.replace(tzinfo=timezone.utc)
        return _now_utc() >= when
    except (TypeError, ValueError):
        return True


def mark_current(persona: str, buyer_id: int, label: str) -> None:
    data = _load()
    st = data["run_state"][persona]
    st["current_buyer_id"] = buyer_id
    st["current_label"] = label
    st["updated_at"] = _now_iso()
    data["run_state"][persona] = st
    _save(data)


def personas_needing_start() -> list[str]:
    data = _load()
    out: list[str] = []
    for persona in list(data.get("schedules") or {}):
        st = (data.get("run_state") or {}).get(persona) or {}
        if st.get("status") == "running":
            continue
        sch = data["schedules"].get(persona) or {}
        if _schedule_due(sch):
            out.append(persona)
    return out


def running_personas() -> list[str]:
    data = _load()
    return [
        p
        for p in list(data.get("run_state") or {})
        if (data["run_state"][p] or {}).get("status") == "running"
    ]
