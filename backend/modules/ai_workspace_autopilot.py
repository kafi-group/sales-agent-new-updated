"""Sara / Rayan Target & Workspace autopilot.

When enabled, after an AI Sales Agent call ends the system writes remarks and
moves the lead in the outreach funnel (interested / not interested / no response /
needs follow-up) without a human clicking those buttons.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

_DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "ai_workspace_autopilot.json"

DEFAULT_SETTINGS: dict[str, Any] = {
    "enabled": False,
    "auto_remarks": True,
    "auto_interested": True,
    "auto_not_interested": True,
    "auto_no_response": True,
    "auto_follow_up": True,
}

_INTERESTED_RE = re.compile(
    r"\b("
    r"interested|send (me )?(a )?(quote|quotation|price|catalogue|catalog|list)|"
    r"want (the )?(price|quote|catalogue)|sounds good|yes please|please send|"
    r"quotation|ready to buy|let'?s proceed|go ahead"
    r")\b",
    re.I,
)
_NOT_INTERESTED_RE = re.compile(
    r"\b("
    r"not interested|no thanks|don'?t (call|contact)|stop calling|"
    r"already have (a )?supplier|too expensive|price (is )?high|"
    r"no need|not looking|remove (me|us)|unsubscribe"
    r")\b",
    re.I,
)
_FOLLOW_UP_RE = re.compile(
    r"\b("
    r"call back|callback|later|next week|busy|in a meeting|"
    r"send (whatsapp|email)|think about|discuss with|follow[- ]?up|"
    r"get back|check with"
    r")\b",
    re.I,
)


def _ensure_file() -> None:
    _DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    if not _DATA_PATH.exists():
        _DATA_PATH.write_text(json.dumps(DEFAULT_SETTINGS, indent=2), encoding="utf-8")


def get_workspace_autopilot_settings() -> dict[str, Any]:
    _ensure_file()
    try:
        raw = json.loads(_DATA_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return dict(DEFAULT_SETTINGS)
    out = dict(DEFAULT_SETTINGS)
    if isinstance(raw, dict):
        for key, default in DEFAULT_SETTINGS.items():
            if key not in raw:
                continue
            if isinstance(default, bool):
                out[key] = bool(raw[key])
    return out


def update_workspace_autopilot_settings(patch: dict[str, Any]) -> dict[str, Any]:
    current = get_workspace_autopilot_settings()
    for key, default in DEFAULT_SETTINGS.items():
        if key not in patch:
            continue
        if isinstance(default, bool):
            current[key] = bool(patch[key])
    _ensure_file()
    _DATA_PATH.write_text(json.dumps(current, indent=2), encoding="utf-8")
    return current


def classify_workspace_outcome(
    *,
    no_answer: bool,
    summary: str | None = None,
    transcript: str | None = None,
    ended_reason: str | None = None,
    outcome_label: str | None = None,
) -> dict[str, Any]:
    """Map call signals → outreach stage + remark text."""
    blob = " ".join(
        p
        for p in (
            summary or "",
            transcript or "",
            ended_reason or "",
            outcome_label or "",
        )
        if p
    ).strip()
    lower = blob.lower()

    agent_tag = "Sara/Rayan AI"
    if no_answer or any(
        tok in lower
        for tok in (
            "no-answer",
            "no answer",
            "voicemail",
            "did not answer",
            "customer-did-not-answer",
            "busy",
            "silence-timed-out",
        )
    ):
        return {
            "stage": "no_response",
            "remarks": f"[{agent_tag}] No answer / unreachable on AI call.",
            "not_interested_reason": None,
            "not_interested_remarks": None,
            "follow_up_reason": None,
            "follow_up_action": None,
        }

    if blob and _NOT_INTERESTED_RE.search(blob):
        snippet = (summary or transcript or "Declined on AI call")[:400]
        return {
            "stage": "not_interested",
            "remarks": f"[{agent_tag}] Not interested — {snippet}",
            "not_interested_reason": "AI call — buyer declined / not buying now",
            "not_interested_remarks": snippet,
            "follow_up_reason": None,
            "follow_up_action": None,
        }

    if blob and _INTERESTED_RE.search(blob):
        snippet = (summary or transcript or "Expressed interest on AI call")[:400]
        return {
            "stage": "interested",
            "remarks": f"[{agent_tag}] Interested — {snippet}",
            "not_interested_reason": None,
            "not_interested_remarks": None,
            "follow_up_reason": None,
            "follow_up_action": None,
        }

    if blob and _FOLLOW_UP_RE.search(blob):
        snippet = (summary or transcript or "Asked to follow up")[:400]
        return {
            "stage": "needs_follow_up",
            "remarks": f"[{agent_tag}] Needs follow-up — {snippet}",
            "not_interested_reason": None,
            "not_interested_remarks": None,
            "follow_up_reason": "AI call — callback / review requested",
            "follow_up_action": "Follow up via WhatsApp/email then call again",
        }

    # Connected call without clear signal → nurture in Needs Follow Up
    snippet = (summary or transcript or outcome_label or "AI sales call completed")[:400]
    return {
        "stage": "needs_follow_up",
        "remarks": f"[{agent_tag}] Call completed — {snippet}",
        "not_interested_reason": None,
        "not_interested_remarks": None,
        "follow_up_reason": "AI call completed — nurture",
        "follow_up_action": "Review call notes; follow up with catalogue/price list",
    }


def apply_workspace_autopilot(
    db: Any,
    *,
    buyer_id: int | None,
    user: Any,
    no_answer: bool,
    summary: str | None = None,
    transcript: str | None = None,
    ended_reason: str | None = None,
    outcome_label: str | None = None,
    agent_name: str = "Sara",
) -> dict[str, Any] | None:
    """Write remarks + funnel stage when autopilot is enabled. Returns apply result or None."""
    settings = get_workspace_autopilot_settings()
    if not settings.get("enabled"):
        return None
    if not buyer_id:
        return {"ok": False, "error": "no_buyer_id"}
    if user is None:
        return {"ok": False, "error": "no_operator"}

    classified = classify_workspace_outcome(
        no_answer=no_answer,
        summary=summary,
        transcript=transcript,
        ended_reason=ended_reason,
        outcome_label=outcome_label,
    )
    stage = classified["stage"]

    # Respect per-action toggles
    if stage == "interested" and not settings.get("auto_interested"):
        stage = "needs_follow_up" if settings.get("auto_follow_up") else None
    elif stage == "not_interested" and not settings.get("auto_not_interested"):
        stage = "needs_follow_up" if settings.get("auto_follow_up") else None
    elif stage == "no_response" and not settings.get("auto_no_response"):
        stage = None
    elif stage == "needs_follow_up" and not settings.get("auto_follow_up"):
        stage = None

    remarks = classified.get("remarks") or ""
    if agent_name and remarks.startswith("[Sara/Rayan AI]"):
        remarks = remarks.replace("[Sara/Rayan AI]", f"[{agent_name} AI]", 1)

    result: dict[str, Any] = {
        "ok": True,
        "buyer_id": buyer_id,
        "stage": stage,
        "remarks_written": False,
        "stage_updated": False,
    }

    try:
        if settings.get("auto_remarks") and remarks:
            from modules import client_history as client_history_module

            client_history_module.add_client_remark(
                db,
                int(buyer_id),
                remarks,
                by_username=getattr(user, "username", None) or agent_name,
                append_to_remarks=True,
            )
            result["remarks_written"] = True
            result["remarks"] = remarks

        if stage:
            from modules import target_workspace as tw_module

            tw_module.update_workspace_lead_stage(
                db,
                buyer_id=int(buyer_id),
                user=user,
                stage=stage,
                not_interested_reason=classified.get("not_interested_reason"),
                not_interested_remarks=classified.get("not_interested_remarks"),
                follow_up_reason=classified.get("follow_up_reason"),
                follow_up_action=classified.get("follow_up_action"),
                force_ai_autopilot=True,
            )
            result["stage_updated"] = True
    except Exception as exc:  # noqa: BLE001
        result["ok"] = False
        result["error"] = str(exc)[:300]
        print(f"Workspace autopilot apply failed: {exc}", flush=True)

    return result
