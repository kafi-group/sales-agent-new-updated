"""AI Sales Agent (Rayan & Sara) queue & outbound calling router."""

from __future__ import annotations

from datetime import datetime, timezone
import time
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from api.deps import get_current_user, get_current_user_released, get_db
from db.models import AppUser, Buyer, Contact
from db.session import SessionLocal
from modules import sales_assistant as assistant_module

router = APIRouter(prefix="/ai-sales-agent", tags=["ai-sales-agent"])
webhooks_router = APIRouter(prefix="/webhooks/vapi", tags=["vapi-webhooks"])

_NO_ANSWER_STATUSES = {
    "no-answer",
    "no_answer",
    "busy",
    "failed",
    "canceled",
    "cancelled",
    "manually-canceled",
    "call-deleted",
    "ring-timeout-hangup",
    "customer-did-not-answer",
    "customer-busy",
    "voicemail",
    "voicemail-reached",
    "twilio-failed-to-connect-call",
    "vonage-failed-to-connect-call",
    "silence-timed-out",
}

# Callee hung up / declined — redial once only if the call never became a real conversation.
_EARLY_HANGUP_STATUSES = {
    "customer-ended-call",
}


class UnlockRequest(BaseModel):
    access_code: str


class AssignTaskRequest(BaseModel):
    persona: str
    buyer_ids: list[int]
    contact_ids: list[int | None] | None = None


class SelfTestRequest(BaseModel):
    persona: str
    phone: str
    contact_name: str | None = None
    language: str | None = "en"
    # Tick which languages the agent may use (start language is always included).
    allowed_languages: list[str] | None = None
    dial_now: bool = True
    # Force female/male TTS when set (Sara → female, Rayan → male).
    voice_gender: str | None = None


class RunnerControlRequest(BaseModel):
    persona: str
    task_id: int | None = None
    sequence: bool = True
    # When set (e.g. auto_mode from AI Auto Mode Start), dial/email that lane only.
    queue_lane: str | None = None


_VALID_QUEUE_LANES = frozenset({"outreach", "data_update", "auto_mode"})
_DIRECT_LANE = "direct"  # test calls only; not assignable, not part of the pipeline
_PIPELINE_PERSONA = "pipeline"


def _agent_personas() -> frozenset[str]:
    try:
        from modules import org_admin_config as org

        ids = org.active_agent_ids()
        if ids:
            return frozenset(ids)
    except Exception:  # noqa: BLE001
        pass
    return frozenset({"male", "female"})


def _assignable_personas() -> frozenset[str]:
    return _agent_personas() | {_PIPELINE_PERSONA}


# Back-compat aliases used by existing checks
_AGENT_PERSONAS = frozenset({"male", "female"})
_ASSIGNABLE_PERSONAS = frozenset({"male", "female", "pipeline"})


def _default_runner(persona: str, *, name: str, voice: str, gender_label: str) -> dict[str, Any]:
    return {
        "persona": persona,
        "display_name": name,
        "gender_label": gender_label,
        "app_username": persona,
        "voice": voice,
        "status": "idle",
        "current_task_id": None,
        "current_task": None,
        "pending_count": 0,
        "twilio_ready": True,
        "sequence_mode": False,
        "operator_user_id": None,
    }


# Global mock/live runner state
_RUNNERS = [
    _default_runner("male", name="Rayan", voice="en-US-Neural2-D", gender_label="male"),
    _default_runner("female", name="Sara", voice="en-US-Neural2-F", gender_label="female"),
]


def sync_runners_from_registry() -> None:
    """Add/update runners from org admin registry without clearing the task queue."""
    global _RUNNERS, _AGENT_PERSONAS, _ASSIGNABLE_PERSONAS
    try:
        from modules import org_admin_config as org
        from modules.ai_agent_persona import (
            FEMALE_VOICE,
            MALE_VOICE,
            enforce_sara_rayan_agent,
            persona_gender,
        )

        agents = org.list_ai_sales_agents(active_only=False)
    except Exception:  # noqa: BLE001
        return
    by_persona = {str(r.get("persona")): r for r in _RUNNERS if r.get("persona")}
    next_runners: list[dict[str, Any]] = []
    for ag in agents:
        aid = str(ag.get("id") or "").strip()
        if not aid:
            continue
        # Sara/Rayan always keep female/male voice + gender, even if registry drifted.
        ag = enforce_sara_rayan_agent(dict(ag))
        aid = str(ag.get("id") or aid).strip()
        gender = persona_gender(
            aid,
            gender_label=str(ag.get("gender_label") or ""),
            display_name=str(ag.get("name") or ""),
            voice=str(ag.get("voice") or ""),
        )
        voice = FEMALE_VOICE if gender == "female" else MALE_VOICE
        if aid in ("female", "male"):
            # Core agents: lock voice + gender_label to the canonical mapping.
            voice = FEMALE_VOICE if aid == "female" else MALE_VOICE
            gender = "female" if aid == "female" else "male"
        existing = by_persona.get(aid)
        if existing:
            existing["display_name"] = str(ag.get("name") or existing.get("display_name") or aid)
            existing["voice"] = voice
            existing["gender_label"] = gender
            existing["persona"] = aid
            if ag.get("active"):
                next_runners.append(existing)
        elif ag.get("active"):
            next_runners.append(
                _default_runner(
                    aid,
                    name=str(ag.get("name") or aid),
                    voice=voice,
                    gender_label=gender,
                )
            )
    if next_runners:
        _RUNNERS = next_runners
    active_ids = [str(a["id"]) for a in agents if a.get("active")]
    if active_ids:
        _AGENT_PERSONAS = frozenset(active_ids)
        _ASSIGNABLE_PERSONAS = frozenset(active_ids) | {_PIPELINE_PERSONA}


_TASKS: list[dict[str, Any]] = []


def _persist_queue() -> None:
    try:
        from modules.ai_sales_queue_store import save_queue_state

        save_queue_state(tasks=_TASKS, runners=_RUNNERS)
    except Exception as exc:  # noqa: BLE001
        print(f"AI Sales queue persist failed: {exc}", flush=True)


def _load_persisted_queue() -> None:
    global _TASKS
    try:
        from modules.ai_sales_queue_store import ensure_state_table, load_queue_state

        ensure_state_table()
        data = load_queue_state()
        tasks = [t for t in (data.get("tasks") or []) if isinstance(t, dict)]
        # Interrupted dials stay assigned; mark ready to dial again.
        for t in tasks:
            if t.get("status") == "in_progress":
                t["status"] = "queued"
                t["call_sid"] = None
                t["outcome"] = None
                t["remarks"] = "Still assigned — call interrupted by server restart; ready to dial again."
                t.pop("started_at", None)
            if t.get("is_test"):
                t["queue_lane"] = _DIRECT_LANE  # move old test calls out of Outreach
        _TASKS = tasks
        saved_runners = {
            str(r.get("persona")): r
            for r in (data.get("runners") or [])
            if isinstance(r, dict) and r.get("persona")
        }
        for r in _RUNNERS:
            snap = saved_runners.get(str(r["persona"])) or {}
            if snap.get("operator_user_id") is not None:
                r["operator_user_id"] = snap.get("operator_user_id")
            r["status"] = "idle"
            r["sequence_mode"] = False
            r["current_task_id"] = None
            r["current_task"] = None
    except Exception as exc:  # noqa: BLE001
        print(f"AI Sales queue load failed: {exc}", flush=True)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _next_task_id() -> int:
    if not _TASKS:
        return 1
    return max(int(t.get("id") or 0) for t in _TASKS) + 1


def _agent_name(persona: str) -> str:
    try:
        from modules.ai_agent_persona import persona_display_name
        from modules import org_admin_config as org

        return persona_display_name(
            persona,
            display_name=org.agent_display_name(persona),
        )
    except Exception:  # noqa: BLE001
        pass
    from modules.ai_agent_persona import persona_display_name

    return persona_display_name(persona)


def _stamp_task_voice_gender(task: dict[str, Any]) -> None:
    """Every queued dial inherits Sara=female / Rayan=male (not only self-test)."""
    from modules.ai_agent_persona import persona_gender

    persona = str(task.get("persona") or "")
    runner = _get_runner(persona) or {}
    task["voice_gender"] = persona_gender(
        persona,
        voice_gender=str(task.get("voice_gender") or "") or None,
        gender_label=str(runner.get("gender_label") or ""),
        display_name=str(runner.get("display_name") or ""),
        voice=str(runner.get("voice") or ""),
    )


def _get_runner(persona: str) -> dict[str, Any] | None:
    return next((r for r in _RUNNERS if r.get("persona") == persona), None)


def _find_task(task_id: int | None) -> dict[str, Any] | None:
    if not task_id:
        return None
    return next((t for t in _TASKS if t.get("id") == task_id), None)


def _contact_phone(contact: Contact | None) -> str | None:
    if not contact:
        return None
    for raw in (
        contact.phone,
        contact.primary_phone,
        contact.secondary_mobile,
        contact.secondary_phone,
        contact.wa_id,
    ):
        value = (raw or "").strip()
        if value:
            return value
    return None


def _contact_email(contact: Contact | None) -> str | None:
    if not contact:
        return None
    value = (contact.email or contact.secondary_email or "").strip()
    return value or None


def _is_no_answer(status: str | None, ended_reason: str | None, duration: Any) -> bool:
    """True when this dial attempt missed (no pickup / busy / our 16s hangup / early decline).

    Not true for a real answered conversation that the customer later ended.
    """
    blob = f"{status or ''} {ended_reason or ''}".strip().lower().replace("_", "-")
    tokens = {part for part in blob.replace("/", " ").split() if part}
    try:
        seconds = int(float(duration)) if duration not in (None, "") else None
    except (TypeError, ValueError):
        seconds = None

    # Our forced 16s hangup / API cancel — always a missed attempt.
    if any(
        flag in blob
        for flag in (
            "manually-canceled",
            "call-deleted",
            "ring-timeout-hangup",
            "customer-did-not-answer",
        )
    ):
        return True

    # Real talk then hangup — do not treat as a missed ring attempt.
    if tokens & _EARLY_HANGUP_STATUSES or any(flag in blob for flag in _EARLY_HANGUP_STATUSES):
        if seconds is not None and seconds >= 20:
            return False
        # Declined / hung up during ring or within first seconds → count as missed attempt.
        return True

    if tokens & _NO_ANSWER_STATUSES or blob in _NO_ANSWER_STATUSES:
        return True
    for flag in _NO_ANSWER_STATUSES:
        if flag in blob:
            return True

    # Vapi often posts status=ended/completed with a thin reason after we kill a ring.
    # Short duration + no real conversation ⇒ treat as unanswered so attempt 2 can run.
    if seconds is not None and seconds <= 18:
        if "ended" in blob or "completed" in blob:
            if any(
                x in blob
                for x in (
                    "assistant-ended-call",
                    "assistant-forwarded",
                    "transfer",
                    "exceeded-max-duration",
                )
            ):
                return False
            return True

    return False


def _auto_followup_after_call(
    db: Session,
    *,
    user: AppUser | None,
    agent_name: str,
    contact_name: str,
    phone: str | None,
    email: str | None,
    company_name: str | None = None,
    outcome: str = "connected",
) -> dict[str, Any]:
    """Send personal WhatsApp (Baileys) + mailbox email after a Sara/Rayan call.

    Does not use Meta WhatsApp Cloud API. Does not prompt the operator.
    Respects AI Auto Mode channel toggles when Auto Mode is enabled.
    """
    from integrations import whatsapp_bridge_client as bridge
    from integrations.mail_client import mail_client
    from modules.ai_sales_auto_mode import get_auto_mode_settings

    auto = get_auto_mode_settings()
    # When Auto Mode is off, keep legacy always-on follow-up behaviour.
    send_wa = True if not auto.get("enabled") else bool(auto.get("send_whatsapp_after_call"))
    send_em = True if not auto.get("enabled") else bool(auto.get("send_email_after_call"))

    company = (company_name or "").strip()
    greet_name = (contact_name or "there").strip() or "there"
    no_answer = outcome == "no_answer"

    if no_answer:
        wa_text = (
            f"Hello {greet_name}, this is {agent_name} from Kafi Commodities "
            "(Brand: ESSENCE).\n\n"
            "We tried to reach you by phone just now but no one picked up. "
            "Please let me know a good time to talk on the phone.\n\n"
            f"Best regards,\n{agent_name}\nKafi Commodities Export Team"
        )
        if company:
            wa_text = wa_text.replace(
                "We tried to reach you by phone just now",
                f"We tried to reach {company} by phone just now",
                1,
            )
        subject = f"Tried reaching you — {agent_name}, Kafi Commodities"
        body = (
            f"<p>Dear {greet_name},</p>"
            "<p>We tried to reach out to you by phone but no one picked up. "
            "Please let me know a good time to talk on the phone.</p>"
            f"<p>This is <strong>{agent_name}</strong> from "
            "<strong>Kafi Commodities (Pvt.) Ltd. (Brand: ESSENCE)</strong>"
            f"{f' regarding {company}' if company else ''}.</p>"
            f"<p>Best regards,<br/><strong>{agent_name}</strong><br/>"
            "Kafi Commodities Export Team<br/>"
            '<a href="https://www.kafi-group.com">www.kafi-group.com</a></p>'
        )
    else:
        wa_text = (
            f"Hello {greet_name}, this is {agent_name} from Kafi Commodities "
            "(Brand: ESSENCE).\n\n"
            "Thank you for your time on the call. As discussed, I am sharing this "
            "note so we can continue over WhatsApp — catalogues, packaging, and "
            "CNF/FOB pricing whenever you are ready.\n\n"
            f"Best regards,\n{agent_name}\nKafi Commodities Export Team"
        )
        if company:
            wa_text = wa_text.replace(
                "Thank you for your time on the call.",
                f"Thank you for your time on the call regarding {company}.",
                1,
            )
        subject = f"Following our call — {agent_name}, Kafi Commodities"
        body = (
            f"<p>Dear {greet_name},</p>"
            f"<p>Thank you for speaking with <strong>{agent_name}</strong> from "
            "<strong>Kafi Commodities (Pvt.) Ltd. (Brand: ESSENCE)</strong>"
            f"{f' about {company}' if company else ''}.</p>"
            "<p>As discussed, please find this follow-up so we can share catalogues, "
            "packaging options, and CNF/FOB pricing at your convenience.</p>"
            f"<p>Best regards,<br/><strong>{agent_name}</strong><br/>"
            "Kafi Commodities Export Team<br/>"
            '<a href="https://www.kafi-group.com">www.kafi-group.com</a></p>'
        )

    result: dict[str, Any] = {
        "whatsapp_status": "skipped",
        "whatsapp_message": None,
        "email_status": "skipped",
        "email_message": None,
        "email_to": email,
        "outcome": outcome,
    }

    if not user:
        result["whatsapp_message"] = "No operator user on the call — follow-up not sent."
        result["email_message"] = result["whatsapp_message"]
        return result

    if not send_wa:
        result["whatsapp_status"] = "skipped"
        result["whatsapp_message"] = "Skipped — WhatsApp off in AI Auto Mode."
    elif phone:
        try:
            status = bridge.bridge_status(user.id, username=user.username)
            if not status.get("connected"):
                result["whatsapp_status"] = "not_connected"
                result["whatsapp_message"] = (
                    "Personal WhatsApp is not connected. Open WhatsApp Mobile and scan QR."
                )
            else:
                bridge.bridge_send(
                    user.id,
                    to_phone=phone,
                    message=wa_text,
                    username=user.username,
                )
                result["whatsapp_status"] = "sent"
                result["whatsapp_message"] = f"Personal WhatsApp sent to {phone}"
                try:
                    from db.models import (
                        Channel,
                        Direction,
                        HandledBy,
                        Interaction,
                        InteractionStatus,
                    )
                    from modules.comms_generator import get_comms

                    contact = get_comms()._ensure_whatsapp_contact(db, wa_id=phone)
                    outbound = Interaction(
                        contact_id=contact.id,
                        channel=Channel.whatsapp,
                        direction=Direction.outbound,
                        content=wa_text,
                        status=InteractionStatus.sent,
                        handled_by=HandledBy.agent,
                        provider_message_id="baileys_ai_call_followup",
                    )
                    db.add(outbound)
                    db.commit()
                except Exception:
                    pass
        except Exception as exc:  # noqa: BLE001
            result["whatsapp_status"] = "error"
            result["whatsapp_message"] = str(exc)[:300]
    else:
        result["whatsapp_message"] = "No phone on file for WhatsApp follow-up."

    if not send_em:
        result["email_status"] = "skipped"
        result["email_message"] = "Skipped — Email off in AI Auto Mode."
    elif email:
        try:
            send_result = mail_client.send_approved(
                to=email,
                subject=subject,
                body=body,
                mailbox_user=user,
            )
            result["email_status"] = send_result.get("status") or "error"
            result["email_message"] = send_result.get("message") or result["email_status"]
            result["email_to"] = email
        except Exception as exc:  # noqa: BLE001
            result["email_status"] = "error"
            result["email_message"] = str(exc)[:300]
    else:
        result["email_message"] = "No email address on file for this contact."

    return result


def _load_operator(db: Session, user_id: int | None) -> AppUser | None:
    if not user_id:
        return None
    try:
        return db.get(AppUser, int(user_id))
    except Exception:
        return None


def _send_task_followup(
    db: Session,
    task: dict[str, Any],
    *,
    outcome: str,
    user: AppUser | None = None,
) -> dict[str, Any]:
    if task.get("followup_sent"):
        return task.get("followup") or {}
    operator = user
    if operator is None:
        operator = _load_operator(db, task.get("operator_user_id"))
    email = (task.get("contact_email") or "").strip() or None
    if task.get("is_test") and not email and operator:
        email = (operator.mailbox_email or "").strip() or None
    # "Call follow-ups for AI Agents": situation-based mail. Returns None when nothing was sent
    # (mode off, no fit, any failure before sending) and we fall back to the generic follow-up below.
    try:
        from modules.call_followup_engine import try_situation_followup

        situation_followup = try_situation_followup(
            db,
            task,
            outcome=outcome,
            operator=operator,
            email=email,
            agent_name=_agent_name(str(task.get("persona") or "female")),
        )
    except Exception as exc:  # noqa: BLE001
        print(f"Call follow-up situations failed before sending, using generic follow-up: {exc}", flush=True)
        situation_followup = None
    if situation_followup is not None:
        task["followup"] = situation_followup
        task["followup_sent"] = True
        return situation_followup
    followup = _auto_followup_after_call(
        db,
        user=operator,
        agent_name=_agent_name(str(task.get("persona") or "female")),
        contact_name=task.get("contact_name") or "there",
        phone=task.get("contact_phone"),
        email=email,
        company_name=task.get("company_name"),
        outcome=outcome,
    )
    task["followup"] = followup
    task["followup_sent"] = True
    return followup


def _refresh_runner_counts() -> None:
    for r in _RUNNERS:
        persona_tasks = [
            t
            for t in _TASKS
            if t.get("persona") == r["persona"] and _lane_matches(t, "outreach")
        ]
        pending = [t for t in persona_tasks if t.get("status") in ("queued", "in_progress")]
        r["pending_count"] = len(pending)
        in_prog = next((t for t in persona_tasks if t.get("status") == "in_progress"), None)
        if in_prog:
            r["current_task_id"] = in_prog.get("id")
            r["current_task"] = in_prog
        elif pending:
            r["current_task_id"] = pending[0].get("id")
            r["current_task"] = pending[0]
        else:
            r["current_task_id"] = None
            r["current_task"] = None
            if r.get("status") == "running":
                r["status"] = "idle"
                r["sequence_mode"] = False
    _persist_queue()


def _dial_task(
    db: Session,
    *,
    task: dict[str, Any],
    user: AppUser,
    language: str = "en",
    allowed_languages: list[str] | None = None,
) -> dict[str, Any]:
    from integrations.voice_client import voice_client
    from db.models import Channel, Direction, HandledBy, Interaction, InteractionStatus

    phone = task.get("contact_phone")
    if not phone:
        task["status"] = "failed"
        task["ready"] = False
        task["remarks"] = "No phone on this contact."
        raise HTTPException(400, "This queue item has no phone number.")

    persona = str(task.get("persona") or "female")
    _stamp_task_voice_gender(task)
    voice_gender = str(task.get("voice_gender") or "").strip() or None
    lang = (language or task.get("language") or "en").strip().lower() or "en"
    allowed = allowed_languages if allowed_languages is not None else task.get("allowed_languages")
    agent_name = _agent_name(persona)
    contact_name = task.get("contact_name") or "Purchasing Manager"

    # Create call log BEFORE dial so recording/captions can attach when the call ends.
    interaction_id = task.get("interaction_id")
    if not interaction_id:
        try:
            interaction = Interaction(
                contact_id=task.get("contact_id"),
                channel=Channel.phone,
                direction=Direction.outbound,
                subject=f"AI Voice Call ({agent_name}) to {contact_name}",
                content=(
                    f"Interactive AI voice call to {phone}. "
                    f"Company: {task.get('company_name') or 'n/a'}. "
                    f"Contact: {contact_name}."
                ),
                handled_by=HandledBy.agent,
                status=InteractionStatus.sent,
                approved_by="dashboard",
                attachments=[],
            )
            db.add(interaction)
            db.commit()
            db.refresh(interaction)
            interaction_id = interaction.id
            task["interaction_id"] = interaction_id
        except Exception as exc:  # noqa: BLE001
            print(f"Could not create AI call interaction: {exc}", flush=True)
            interaction_id = None

    call_result = voice_client.place_outbound_ai_call(
        phone,
        persona=persona,
        contact_name=contact_name,
        language=lang,
        task_id=task.get("id"),
        company_name=task.get("company_name"),
        designation=task.get("designation"),
        ring_attempt=1,
        voice_gender=voice_gender,
        allowed_languages=allowed if isinstance(allowed, list) else None,
        interaction_id=int(interaction_id) if interaction_id else None,
    )
    if not call_result.get("ok"):
        task["status"] = "failed"
        task["remarks"] = f"Twilio Voice Error: {call_result.get('error')}"
        raise HTTPException(400, f"Twilio Voice Error: {call_result.get('error')}")

    task["status"] = "in_progress"
    task["language"] = lang
    task["allowed_languages"] = allowed if isinstance(allowed, list) else None
    task["call_sid"] = call_result.get("call_sid")
    task["call_engine"] = call_result.get("engine")
    task["ring_attempt"] = int(call_result.get("ring_attempt") or 1)
    task["redial_used"] = False
    task["started_at"] = _now_iso()
    task["operator_user_id"] = user.id
    task["outcome"] = "Calling"
    task["remarks"] = f"Calling {phone} live (SID: {call_result.get('call_sid')})..."
    task["followup_sent"] = False

    if interaction_id:
        try:
            row = db.get(Interaction, int(interaction_id))
            if row:
                row.content = (
                    f"Interactive AI voice call to {phone}. "
                    f"SID: {call_result.get('call_sid')}. Engine: {call_result.get('engine')}."
                )
                db.commit()
        except Exception:
            pass

    runner = _get_runner(str(task.get("persona")))
    if runner:
        runner["status"] = "running"
        runner["current_task_id"] = task["id"]
        runner["current_task"] = task
        runner["operator_user_id"] = user.id
        runner["active_call_sid"] = call_result.get("call_sid")
    _persist_queue()
    return call_result


def _task_lane(task: dict[str, Any]) -> str:
    # Test calls ("Test call to your phone") live in their own lane so they never
    # count as Outreach contacts, pipeline items or run-log entries.
    if task.get("is_test") or str(task.get("queue_lane") or "").strip().lower() == _DIRECT_LANE:
        return _DIRECT_LANE
    lane = str(task.get("queue_lane") or "outreach").strip().lower()
    return lane if lane in _VALID_QUEUE_LANES else "outreach"


def _lane_matches(task: dict[str, Any], want: str) -> bool:
    """Direct (test) calls are still dialed by the outreach dialer, but only listed separately."""
    lane = _task_lane(task)
    return lane == want or (want == "outreach" and lane == _DIRECT_LANE)


def _next_queued(persona: str, *, lane: str = "outreach") -> dict[str, Any] | None:
    want = lane if lane in _VALID_QUEUE_LANES else "outreach"
    return next(
        (
            t
            for t in _TASKS
            if t.get("persona") == persona
            and t.get("status") == "queued"
            and t.get("ready")
            and t.get("contact_phone")
            and _lane_matches(t, want)
        ),
        None,
    )


def _advance_sequence(db: Session, persona: str, user: AppUser | None) -> None:
    runner = _get_runner(persona)
    if not runner:
        return
    if runner.get("_advancing"):
        return
    runner["_advancing"] = True
    try:
        _advance_sequence_locked(db, runner, persona, user)
    finally:
        runner["_advancing"] = False


def _advance_sequence_locked(
    db: Session,
    runner: dict[str, Any],
    persona: str,
    user: AppUser | None,
) -> None:
    if runner.get("status") == "paused":
        _persist_queue()
        return
    # Single-number "Call this" — do not auto-dial the rest of the queue.
    if not runner.get("sequence_mode"):
        if runner.get("status") == "running":
            runner["status"] = "idle"
            runner["current_task_id"] = None
            runner["current_task"] = None
        _persist_queue()
        return
    if any(
        t.get("persona") == persona and t.get("status") == "in_progress" for t in _TASKS
    ):
        return
    dial_lane = str(runner.get("queue_lane") or "outreach").strip().lower()
    if dial_lane not in _VALID_QUEUE_LANES:
        dial_lane = "outreach"
    nxt = _next_queued(persona, lane=dial_lane)
    if not nxt:
        runner["status"] = "idle"
        runner["sequence_mode"] = False
        runner["current_task_id"] = None
        runner["current_task"] = None
        _persist_queue()
        return
    operator = user or _load_operator(db, runner.get("operator_user_id") or nxt.get("operator_user_id"))
    if not operator:
        runner["status"] = "idle"
        _persist_queue()
        return
    runner["status"] = "running"
    try:
        _dial_task(db, task=nxt, user=operator)
    except HTTPException:
        nxt["status"] = "failed"
        nxt["outcome"] = "Dial failed"
        _persist_queue()
        _advance_sequence_locked(db, runner, persona, operator)


def _finish_task(
    db: Session,
    task: dict[str, Any],
    *,
    status: str | None = None,
    ended_reason: str | None = None,
    duration: Any = None,
    outcome_label: str | None = None,
    user: AppUser | None = None,
    hangup: bool = False,
    call_summary: str | None = None,
    call_transcript: str | None = None,
) -> dict[str, Any]:
    from integrations.voice_client import voice_client

    if hangup and task.get("call_sid"):
        try:
            voice_client.end_call(str(task["call_sid"]))
        except Exception:
            pass

    runner = _get_runner(str(task.get("persona") or ""))
    if runner and runner.get("current_task_id") == task.get("id"):
        runner["active_call_sid"] = None

    no_answer = _is_no_answer(status, ended_reason, duration)
    outcome = "no_answer" if no_answer else "connected"
    if task.get("status") in ("queued",):
        return task
    if task.get("status") not in ("completed", "failed", "skipped"):
        task["status"] = "completed"
        task["completed_at"] = _now_iso()
        if no_answer:
            task["outcome"] = outcome_label or "No pickup"
            task["remarks"] = "No one picked up — missed-call follow-up sent."
        else:
            task["outcome"] = outcome_label or "Call ended"
            task["remarks"] = "Call ended — WhatsApp and email follow-up sent."

    followup = _send_task_followup(db, task, outcome=outcome, user=user)
    persona = str(task.get("persona") or "")
    operator = user or _load_operator(db, task.get("operator_user_id"))
    agent_name = _agent_name(persona) if persona else "Sara"

    # Target & Workspace autopilot — remarks + funnel stage without human clicks.
    try:
        from modules.ai_workspace_autopilot import apply_workspace_autopilot

        ws = apply_workspace_autopilot(
            db,
            buyer_id=task.get("buyer_id"),
            user=operator,
            no_answer=no_answer,
            summary=call_summary or task.get("call_summary"),
            transcript=call_transcript or task.get("call_transcript"),
            ended_reason=ended_reason,
            outcome_label=str(task.get("outcome") or outcome_label or ""),
            agent_name=agent_name,
        )
        if ws:
            task["workspace_autopilot"] = ws
    except Exception as exc:  # noqa: BLE001
        print(f"Workspace autopilot hook failed: {exc}", flush=True)

    _advance_sequence(db, persona, operator)
    _refresh_runner_counts()
    return followup


def _call_was_answered(call_sid: str | None, duration: Any, transcript: str | None) -> bool:
    """True when the customer really talked to the agent (>=20s, or they spoke)."""

    def _seconds(value: Any) -> int | None:
        try:
            return int(float(value)) if value not in (None, "") else None
        except (TypeError, ValueError):
            return None

    def _talked(text: str | None) -> bool:
        low = (text or "").lower()
        return "user:" in low or "customer:" in low

    secs = _seconds(duration)
    if (secs is not None and secs >= 20) or _talked(transcript):
        return True
    if call_sid:
        try:
            from integrations.voice_client import voice_client

            info = voice_client.fetch_outbound_status(call_sid)
            live_secs = _seconds(info.get("duration"))
            if (live_secs is not None and live_secs >= 20) or _talked(info.get("call_transcript")):
                return True
        except Exception as exc:  # noqa: BLE001
            print(f"Answered-call check failed: {exc}", flush=True)
    return False


def handle_ai_call_status(
    *,
    task_id: int | None,
    call_sid: str | None,
    status: str | None,
    duration: Any = None,
    ended_reason: str | None = None,
    call_summary: str | None = None,
    call_transcript: str | None = None,
    ring_attempt: int | None = None,
    recording_url: str | None = None,
    interaction_id: int | None = None,
    db: Session | None = None,
) -> dict[str, Any]:
    """Twilio / Vapi terminal status — send follow-up and dial the next queued lead."""
    from integrations.voice_client import voice_client

    terminal = {
        "completed",
        "busy",
        "failed",
        "no-answer",
        "canceled",
        "cancelled",
        "ended",
    }
    blob = f"{status or ''} {ended_reason or ''}".lower()
    is_terminal = any(token in blob for token in terminal) or _is_no_answer(
        status, ended_reason, duration
    )
    if not is_terminal:
        return {"ok": True, "ignored": True}

    task = _find_task(task_id)
    if task is None and call_sid:
        task = next((t for t in _TASKS if t.get("call_sid") == call_sid), None)

    if task is None or task.get("status") not in ("in_progress", "running"):
        return {"ok": True, "ignored": True}

    # Ignore stale status from attempt 1 after we already moved to attempt 2.
    if call_sid and task.get("call_sid") and str(call_sid) != str(task.get("call_sid")):
        return {"ok": True, "ignored": "stale_call_sid"}

    if call_summary:
        task["call_summary"] = call_summary
    if call_transcript:
        task["call_transcript"] = call_transcript
    if recording_url:
        task["recording_url"] = recording_url
    if interaction_id and not task.get("interaction_id"):
        task["interaction_id"] = interaction_id

    # Always prefer the live task counter (webhook metadata can lag / be stale).
    attempt = int(task.get("ring_attempt") or ring_attempt or 1)
    no_answer = _is_no_answer(status, ended_reason, duration)
    max_attempts = voice_client.max_ring_attempts()
    # A conversation the customer took part in must never be redialed, even when the
    # webhook omitted the duration (customer-ended-call + no duration looks "missed").
    if no_answer and attempt < max_attempts and _call_was_answered(call_sid, duration, call_transcript):
        no_answer = False
    if no_answer and (task.get("ended_by_user") or task.get("answered")):
        print(
            f"Redial skipped task={task.get('id')} ended_by_user={task.get('ended_by_user')} "
            f"answered={task.get('answered')} status={status} reason={ended_reason}",
            flush=True,
        )
        no_answer = False
    if no_answer and attempt < max_attempts:
        phone = task.get("contact_phone")
        if phone:
            next_attempt = attempt + 1
            # Mark before place_outbound so a second webhook cannot double-dial.
            task["ring_attempt"] = next_attempt
            task["redial_used"] = next_attempt > 1
            task["remarks"] = (
                f"Attempt {attempt} no connect — redialing attempt {next_attempt}/{max_attempts} "
                f"(~{voice_client.ring_timeout_seconds() or 16}s each)."
            )
            task["outcome"] = "Re-dialing"
            redial = voice_client.place_outbound_ai_call(
                phone,
                persona=str(task.get("persona") or "female"),
                contact_name=task.get("contact_name") or "Purchasing Manager",
                language=str(task.get("language") or "en"),
                task_id=task.get("id"),
                company_name=task.get("company_name"),
                designation=task.get("designation"),
                ring_attempt=next_attempt,
                voice_gender=str(task.get("voice_gender") or "") or None,
                allowed_languages=(
                    task.get("allowed_languages")
                    if isinstance(task.get("allowed_languages"), list)
                    else None
                ),
                interaction_id=(
                    int(task["interaction_id"])
                    if task.get("interaction_id") is not None
                    else None
                ),
            )
            if redial.get("ok"):
                task["call_sid"] = redial.get("call_sid")
                task["call_engine"] = redial.get("engine")
                task["started_at"] = _now_iso()
                task["status"] = "in_progress"
                _refresh_runner_counts()
                return {"ok": True, "redialed": True, "ring_attempt": next_attempt}
            task["remarks"] = (
                f"Auto-redial failed after attempt {attempt}: {redial.get('error')}"
            )

    local_db = db if db is not None else SessionLocal()
    try:
        _finish_task(
            local_db,
            task,
            status=status,
            ended_reason=ended_reason,
            duration=duration,
            call_summary=call_summary,
            call_transcript=call_transcript,
        )
        return {"ok": True, "task_id": task.get("id")}
    finally:
        if db is None:
            local_db.close()


_LAST_RECONCILE_TIME: float = 0.0


def _reconcile_live_calls() -> None:
    """If webhooks were missed, poll Vapi/Twilio for ended calls; clear stale dials."""
    global _LAST_RECONCILE_TIME
    now = time.monotonic()
    if now - _LAST_RECONCILE_TIME < 6.0:
        return
    _LAST_RECONCILE_TIME = now

    from integrations.voice_client import voice_client

    live = [t for t in _TASKS if t.get("status") == "in_progress"]
    if not live:
        return
    
    db = SessionLocal()
    try:
        _do_reconcile_live_calls(db, live)
    finally:
        db.close()

def _do_reconcile_live_calls(db: Session, live: list[dict[str, Any]]) -> None:
    from integrations.voice_client import voice_client
    for task in live:
        started = task.get("started_at")
        try:
            started_dt = datetime.fromisoformat(str(started).replace("Z", "+00:00"))
            age = (datetime.now(timezone.utc) - started_dt).total_seconds()
        except Exception:
            age = 999

        call_sid = task.get("call_sid")
        if not call_sid:
            if age >= 20:
                _finish_task(
                    db,
                    task,
                    status="failed",
                    ended_reason="no-call-sid",
                    outcome_label="Dial failed (no call id)",
                )
            continue

        # Give the network a few seconds before polling.
        if age < 20:
            continue

        info = voice_client.fetch_outbound_status(call_sid)
        status = str(info.get("status") or "").lower().replace("_", "-")
        ended_reason = str(info.get("ended_reason") or "")
        if status in {"in-progress", "answered", "forwarding"}:
            task["answered"] = True

        if info.get("ended"):
            handle_ai_call_status(
                task_id=task.get("id"),
                call_sid=str(call_sid),
                status=str(info.get("status") or ""),
                duration=info.get("duration"),
                ended_reason=ended_reason,
                ring_attempt=task.get("ring_attempt"),
                recording_url=info.get("recording_url"),
                call_transcript=info.get("call_transcript"),
                interaction_id=(
                    int(task["interaction_id"])
                    if task.get("interaction_id") is not None
                    else None
                ),
                db=db,
            )
            continue

        # Vapi/Twilio accepted the job but never reached the handset.
        never_rang = status in {"", "queued", "queued-for-outbound"} or not info.get("ok")
        if age >= 90 and never_rang:
            try:
                voice_client.end_call(str(call_sid))
            except Exception:
                pass
            _finish_task(
                db,
                task,
                status="failed",
                ended_reason="did-not-ring",
                outcome_label="Did not ring — dial never reached phone",
            )
            continue

        # Hard timeout for any stuck live call (missed webhook).
        if age >= 180:
            try:
                voice_client.end_call(str(call_sid))
            except Exception:
                pass
            _finish_task(
                db,
                task,
                status=status or "ended",
                ended_reason=ended_reason or "stale-timeout",
                outcome_label="Call timed out (no status update)",
            )


@router.post("/unlock")
def unlock_ai_sales_agent(
    payload: UnlockRequest,
    user: AppUser = Depends(get_current_user_released),
) -> dict[str, bool]:
    _ = user
    code = (payload.access_code or "").strip()
    if not assistant_module.access_code_valid(code):
        raise HTTPException(403, "Invalid access code. Please use access code: 07860")
    return {"ok": True}


@router.get("/runners")
def list_runners(
    user: AppUser = Depends(get_current_user_released),
) -> dict[str, Any]:
    _ = user
    try:
        sync_runners_from_registry()
    except Exception:  # noqa: BLE001
        pass
    try:
        _reconcile_live_calls()
    except Exception:
        pass
    _refresh_runner_counts()
    return {"runners": _RUNNERS}


@router.get("/tasks")
def list_tasks(
    persona: str | None = Query(default=None),
    status: str | None = Query(default=None),
    limit: int = Query(default=200, ge=1, le=500),
    user: AppUser = Depends(get_current_user_released),
) -> dict[str, Any]:
    _ = user
    try:
        _reconcile_live_calls()
    except Exception:
        pass
    filtered = _TASKS
    if persona:
        filtered = [t for t in filtered if t.get("persona") == persona]
    if status:
        filtered = [t for t in filtered if t.get("status") == status]
    return {"tasks": filtered[:limit]}


def _persona_label(persona: str) -> str:
    p = (persona or "").strip()
    if p == _PIPELINE_PERSONA:
        return "AI Sales Agent list"
    try:
        return _agent_name(p)
    except Exception:  # noqa: BLE001
        pass
    pl = p.lower()
    if pl == "female":
        return "Sara"
    if pl == "male":
        return "Rayan"
    return p or "unknown"


def _lane_label(lane: str) -> str:
    l = (lane or "").strip().lower()
    if l == "outreach":
        return "Outreach"
    if l == "data_update":
        return "Data Update"
    if l == "auto_mode":
        return "AI Auto Mode"
    if l == _DIRECT_LANE:
        return "Direct AI Call"
    return l or "—"


@router.post("/tasks/assign")
def assign_tasks(
    payload: AssignTaskRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    try:
        sync_runners_from_registry()
    except Exception:  # noqa: BLE001
        pass
    target = str(payload.persona or "").strip().lower()
    if target not in _ASSIGNABLE_PERSONAS:
        raise HTTPException(
            400,
            "Persona must be pipeline (AI Sales Agent list) or an active AI Sales Agent.",
        )
    created = []
    skipped: list[dict[str, Any]] = []
    self_label = _persona_label(target)
    contact_ids = payload.contact_ids or []

    def _same_contact(t: dict[str, Any], bid: int, cid: int | None, phone: str | None) -> bool:
        if t.get("buyer_id") == bid and cid is not None and t.get("contact_id") == cid:
            return True
        if phone and t.get("contact_phone") and str(t.get("contact_phone")) == str(phone):
            return True
        if cid is None and phone is None and t.get("buyer_id") == bid and t.get("contact_id") is None:
            return True
        return False

    def _find_same(bid: int, cid: int | None, phone: str | None) -> dict[str, Any] | None:
        return next(
            (t for t in _TASKS if _same_contact(t, bid, cid, phone)),
            None,
        )

    for index, bid in enumerate(payload.buyer_ids):
        buyer = db.get(Buyer, bid)
        wanted_cid = contact_ids[index] if index < len(contact_ids) else None
        contact: Contact | None = None
        if wanted_cid:
            found = db.get(Contact, wanted_cid)
            if found and (buyer is None or found.buyer_id == bid):
                contact = found
        if contact is None and buyer and buyer.contacts:
            contact = buyer.contacts[0]
        company_name = buyer.company_name if buyer else f"Lead #{bid}"
        contact_name = (contact.full_name if contact else None) or "Purchasing Manager"
        contact_phone = _contact_phone(contact) or getattr(buyer, "phone", None)
        contact_email = _contact_email(contact)
        contact_id = contact.id if contact else None

        existing = _find_same(bid, contact_id, contact_phone)
        if existing:
            cur = str(existing.get("persona") or "").strip().lower()
            # Already on a different agent — do not silently steal.
            if cur in _AGENT_PERSONAS and target != cur:
                if target == _PIPELINE_PERSONA:
                    skipped.append(
                        {
                            "buyer_id": bid,
                            "contact_id": contact_id,
                            "company_name": company_name,
                            "reason": (
                                f"Already assigned to {_persona_label(cur)} — "
                                f"remove from {_persona_label(cur)} first."
                            ),
                            "other_task_id": existing.get("id"),
                        }
                    )
                    continue
                if cur != target:
                    skipped.append(
                        {
                            "buyer_id": bid,
                            "contact_id": contact_id,
                            "company_name": company_name,
                            "reason": (
                                f"Already assigned to {_persona_label(cur)} — "
                                f"remove from {_persona_label(cur)} first."
                            ),
                            "other_task_id": existing.get("id"),
                        }
                    )
                    continue

            # Staging → Sara/Rayan: promote in place.
            if cur == _PIPELINE_PERSONA and target in _AGENT_PERSONAS:
                existing["persona"] = target
                _stamp_task_voice_gender(existing)
                existing["status"] = "queued"
                existing["ready"] = bool(
                    contact_phone
                    or contact_email
                    or existing.get("contact_phone")
                    or existing.get("contact_email")
                )
                existing["contact_phone"] = contact_phone or existing.get("contact_phone")
                existing["contact_email"] = contact_email or existing.get("contact_email")
                existing["contact_name"] = contact_name or existing.get("contact_name")
                existing["company_name"] = company_name or existing.get("company_name")
                existing["remarks"] = f"Assigned to {_persona_label(target)} from AI Sales Agent list."
                created.append(existing)
                continue

            if existing.get("status") in ("queued", "in_progress") and cur == target:
                created.append(existing)
                continue
            # Already assigned historically — put back in queue; never drop.
            existing["persona"] = target
            _stamp_task_voice_gender(existing)
            existing["status"] = "queued"
            existing["ready"] = bool(
                contact_phone
                or contact_email
                or existing.get("contact_phone")
                or existing.get("contact_email")
            )
            existing["contact_phone"] = contact_phone or existing.get("contact_phone")
            existing["contact_email"] = contact_email or existing.get("contact_email")
            existing["contact_name"] = contact_name or existing.get("contact_name")
            existing["company_name"] = company_name or existing.get("company_name")
            existing["call_sid"] = None
            existing["outcome"] = None
            existing["followup_sent"] = False
            existing["followup"] = {}
            existing["remarks"] = "Re-queued — still assigned until manually removed."
            existing.pop("started_at", None)
            existing.pop("completed_at", None)
            created.append(existing)
            continue

        task = {
            "id": _next_task_id(),
            "persona": target,
            "buyer_id": bid,
            "contact_id": contact_id,
            "company_name": company_name,
            "contact_name": contact_name,
            "contact_phone": contact_phone,
            "contact_email": contact_email,
            "country": (buyer.country if buyer else None),
            "designation": (contact.designation if contact else None),
            "grading": (buyer.company_grading if buyer else None),
            "status": "queued",
            # Staging list has no lane yet; agents default to Outreach until moved.
            "queue_lane": "outreach" if target in _AGENT_PERSONAS else None,
            "ready": bool(contact_phone or contact_email),
            "warnings": (
                []
                if (contact_phone or contact_email)
                else ["No phone or email on this contact"]
            ),
            "created_at": _now_iso(),
            "followup_sent": False,
        }
        _stamp_task_voice_gender(task)
        _TASKS.append(task)
        created.append(task)
    _refresh_runner_counts()
    notice = None
    if skipped:
        names = ", ".join(
            (s.get("company_name") or f"#{s.get('buyer_id')}") for s in skipped[:5]
        )
        extra = f" (+{len(skipped) - 5} more)" if len(skipped) > 5 else ""
        notice = (
            f"{len(skipped)} contact(s) were not added to {self_label}: "
            f"{names}{extra}."
        )
    if created:
        try:
            from modules import ai_sales_agent_log as asal

            lane = "outreach" if target in _AGENT_PERSONAS else None
            asal.record_assign(
                db,
                user=user,
                persona=target,
                tasks=created,
                queue_lane=lane,
                note=f"Assigned {len(created)} to {self_label}",
            )
        except Exception as log_exc:  # noqa: BLE001
            print(f"AI Sales Agent assign log failed: {log_exc}", flush=True)
    return {"tasks": created, "skipped": skipped, "notice": notice}


class SetTaskPersonaRequest(BaseModel):
    task_ids: list[int]
    persona: str  # female | male


@router.post("/tasks/set-persona")
def set_task_persona(
    payload: SetTaskPersonaRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Move staging (pipeline) contacts onto an AI Sales Agent."""
    try:
        sync_runners_from_registry()
    except Exception:  # noqa: BLE001
        pass
    target = str(payload.persona or "").strip().lower()
    if target not in _AGENT_PERSONAS:
        raise HTTPException(400, "persona must be an active AI Sales Agent")
    id_set = {int(x) for x in (payload.task_ids or []) if int(x) > 0}
    updated = 0
    skipped = 0
    moved: list[dict[str, Any]] = []
    for t in _TASKS:
        if t.get("id") not in id_set:
            continue
        cur = str(t.get("persona") or "").strip().lower()
        if cur == target:
            updated += 1
            continue
        # Only promote from staging, or allow Sara↔Rayan reassignment.
        if cur not in (_PIPELINE_PERSONA, *_AGENT_PERSONAS):
            skipped += 1
            continue
        t["persona"] = target
        if t.get("status") not in ("in_progress",):
            t["status"] = "queued"
        if not t.get("queue_lane"):
            t["queue_lane"] = "outreach"
        t["remarks"] = f"Assigned to {_persona_label(target)}."
        updated += 1
        moved.append(t)
    _refresh_runner_counts()
    _persist_queue()
    if moved:
        try:
            from modules import ai_sales_agent_log as asal

            asal.record_assign(
                db,
                user=user,
                persona=target,
                tasks=moved,
                queue_lane="outreach",
                note=f"Moved {len(moved)} to {_persona_label(target)}",
            )
        except Exception as log_exc:  # noqa: BLE001
            print(f"AI Sales Agent set-persona log failed: {log_exc}", flush=True)
    return {
        "updated": updated,
        "skipped": skipped,
        "persona": target,
        "label": _persona_label(target),
    }


@router.post("/tasks/self-test")
def queue_self_test(
    payload: SelfTestRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    agent_name = _agent_name(payload.persona)
    contact_name = payload.contact_name or "Mr. Khalid"

    contact_id = None
    contact_email = (user.mailbox_email or "").strip() or None
    if payload.phone:
        try:
            from sqlalchemy import or_

            digits = "".join(ch for ch in payload.phone if ch.isdigit())
            tail = digits[-10:] if len(digits) >= 8 else ""
            if tail:
                matched_contact = (
                    db.query(Contact)
                    .filter(
                        or_(
                            Contact.phone.contains(tail),
                            Contact.primary_phone.contains(tail),
                            Contact.secondary_mobile.contains(tail),
                            Contact.wa_id.contains(tail),
                        )
                    )
                    .first()
                )
                if matched_contact:
                    contact_id = matched_contact.id
                    contact_email = (
                        (matched_contact.email or matched_contact.secondary_email or "").strip()
                        or contact_email
                    )
        except Exception:
            pass

    task = {
        "id": _next_task_id(),
        "persona": payload.persona,
        "voice_gender": (payload.voice_gender or "").strip().lower() or None,
        "buyer_id": 0,
        "contact_id": contact_id,
        "company_name": "Direct AI Call",
        "contact_name": contact_name,
        "contact_phone": payload.phone,
        "contact_email": contact_email,
        "status": "queued",
        "ready": True,
        "is_test": True,
        "queue_lane": _DIRECT_LANE,
        "language": (payload.language or "en").strip().lower() or "en",
        "allowed_languages": payload.allowed_languages,
        "created_at": _now_iso(),
        "operator_user_id": user.id,
        "followup_sent": False,
    }
    _stamp_task_voice_gender(task)
    _TASKS.insert(0, task)

    runner = _get_runner(payload.persona)
    if runner:
        runner["sequence_mode"] = False
        runner["operator_user_id"] = user.id

    call_result: dict[str, Any] = {}
    if payload.dial_now:
        call_result = _dial_task(
            db,
            task=task,
            user=user,
            language=payload.language or "en",
            allowed_languages=payload.allowed_languages,
        )
    _refresh_runner_counts()

    # Interaction is created inside _dial_task (so recording/captions can attach).
    # If dial_now was false, create a queued log row without media yet.
    if not payload.dial_now:
        try:
            from db.models import Channel, Direction, HandledBy, Interaction, InteractionStatus

            interaction = Interaction(
                contact_id=contact_id,
                channel=Channel.phone,
                direction=Direction.outbound,
                subject=f"AI Voice Call ({agent_name}) to {contact_name}",
                content=f"Queued AI voice call to {payload.phone}.",
                handled_by=HandledBy.agent,
                status=InteractionStatus.sent,
                approved_by="dashboard",
                attachments=[],
            )
            db.add(interaction)
            db.commit()
            db.refresh(interaction)
            task["interaction_id"] = interaction.id
            _persist_queue()
        except Exception as exc:
            print(f"Could not log AI interaction to DB: {exc}", flush=True)

    return {"task": task, "call_result": call_result}


class EndCallRequest(BaseModel):
    persona: str | None = None
    call_sid: str | None = None
    task_id: int | None = None


@router.post("/end-call")
def end_ai_call(
    payload: EndCallRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    from integrations.voice_client import voice_client

    sids: list[str] = []
    if payload.call_sid and str(payload.call_sid).strip():
        sids.append(str(payload.call_sid).strip())

    candidates: list[dict[str, Any]] = []
    for t in _TASKS:
        matches = False
        if payload.task_id and t.get("id") == payload.task_id:
            matches = True
        elif (
            payload.persona
            and t.get("persona") == payload.persona
            and t.get("status") in ("in_progress", "running", "calling")
        ):
            matches = True
        elif (
            not payload.task_id
            and not payload.persona
            and t.get("status") in ("in_progress", "running", "calling")
        ):
            matches = True

        if matches:
            candidates.append(t)
            sid = t.get("call_sid")
            if sid and str(sid) not in sids:
                sids.append(str(sid))

    # Runner may hold the live SID even if task status drifted.
    if payload.persona:
        runner = _get_runner(payload.persona)
        if runner:
            for key in ("active_call_sid",):
                sid = runner.get(key)
                if sid and str(sid) not in sids:
                    sids.append(str(sid))
            ct = runner.get("current_task")
            if isinstance(ct, dict) and ct.get("call_sid"):
                sid = str(ct["call_sid"])
                if sid not in sids:
                    sids.append(sid)
                if ct not in candidates and ct.get("id"):
                    # Prefer the live task object from _TASKS when present.
                    live = next((x for x in _TASKS if x.get("id") == ct.get("id")), ct)
                    if live not in candidates:
                        candidates.append(live)

    # Mark BEFORE hanging up: Vapi's "call-deleted / manually-canceled" webhook can arrive
    # first and would otherwise look like a missed ring and trigger an auto-redial.
    for t in candidates:
        t["ended_by_user"] = True

    hangup_results: list[dict[str, Any]] = []
    for sid in sids:
        try:
            hangup_results.append(voice_client.end_call(sid))
        except Exception as exc:  # noqa: BLE001
            hangup_results.append({"ok": False, "error": str(exc), "call_sid": sid})

    ended_task = None
    for t in candidates or []:
        duration = None
        if t.get("started_at"):
            try:
                started_dt = datetime.fromisoformat(str(t["started_at"]).replace("Z", "+00:00"))
                duration = (datetime.now(timezone.utc) - started_dt).total_seconds()
            except Exception:
                duration = None
        _finish_task(
            db,
            t,
            status="completed",
            duration=duration,
            outcome_label="Ended by user",
            user=user,
            hangup=False,  # already hung up above
        )
        ended_task = t
        # Pull recording/transcript from Vapi now — end-of-call-report may arrive later
        # or never if webhooks were missed; Call history still needs the media.
        try:
            sid = t.get("call_sid")
            iid = t.get("interaction_id")
            if sid and iid:
                info = voice_client.fetch_outbound_status(str(sid))
                from modules.call_media import save_ai_call_media

                if info.get("recording_url") or info.get("call_transcript"):
                    save_ai_call_media(
                        db,
                        interaction_id=int(iid),
                        recording_url=info.get("recording_url"),
                        recording_sid=str(sid),
                        duration_seconds=info.get("duration") or duration,
                        transcript=info.get("call_transcript"),
                    )
                    if info.get("recording_url"):
                        t["recording_url"] = info.get("recording_url")
                    if info.get("call_transcript"):
                        t["call_transcript"] = info.get("call_transcript")
        except Exception as media_exc:  # noqa: BLE001
            print(f"End-call media fetch failed: {media_exc}", flush=True)
        break

    # No matching task but we still tried SIDs — report hangup outcome.
    if not ended_task and not sids:
        raise HTTPException(
            404,
            "No in-progress call found to end. If the phone is still connected, hang up from the handset.",
        )

    ok_any = any(r.get("ok") for r in hangup_results) if hangup_results else bool(ended_task)
    if hangup_results and not ok_any:
        detail = "; ".join(
            str(r.get("error") or "unknown") for r in hangup_results if not r.get("ok")
        )
        raise HTTPException(502, f"Could not hang up the live call: {detail}")

    return {
        "ok": ok_any or bool(ended_task),
        "task": ended_task,
        "followup": (ended_task or {}).get("followup"),
        "hangup": hangup_results,
    }


@router.delete("/tasks/{task_id}")
def delete_task(
    task_id: int,
    user: AppUser = Depends(get_current_user),
) -> dict[str, bool]:
    _ = user
    global _TASKS
    _TASKS = [t for t in _TASKS if t.get("id") != task_id]
    _refresh_runner_counts()
    _persist_queue()
    return {"ok": True}


@router.post("/tasks/{task_id}/skip")
def skip_task(
    task_id: int,
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    _ = user
    for t in _TASKS:
        if t.get("id") == task_id:
            t["status"] = "skipped"
            _refresh_runner_counts()
            return t
    raise HTTPException(404, "Task not found")


def _bulk_email_queued(
    db: Session,
    *,
    persona: str,
    user: AppUser,
    runner: dict[str, Any],
) -> dict[str, Any]:
    """When Auto Mode has call_mode off: email contacts on this agent's AI Auto Mode lane."""
    import html as html_mod
    import time

    from config import settings as app_settings
    from integrations.mail_client import mail_client
    from modules.ai_sales_auto_mode import get_bulk_email_config
    from modules.email_templates import get_template, render_template_text

    agent_name = _agent_name(persona)
    runner["queue_lane"] = "auto_mode"
    cfg = get_bulk_email_config(persona)
    subject_tpl = (cfg.get("subject") or "").strip()
    body_tpl = (cfg.get("body") or "").strip()
    template_id = cfg.get("template_id")
    template = get_template(db, int(template_id)) if template_id else None
    if template and (not subject_tpl or not body_tpl):
        if not subject_tpl:
            subject_tpl = (template.subject or "").strip()
        if not body_tpl:
            body_tpl = (template.body or "").strip()
    if not subject_tpl or not body_tpl:
        raise HTTPException(
            400,
            f"Set a template (and edit subject/body/signature) for {agent_name} "
            "under AI Auto Mode → bulk email setup before starting.",
        )

    send_attachments: list[dict[str, Any]] = []
    if template and getattr(template, "attachments", None):
        try:
            from modules.email_attachments import copy_attachments, resolve_attachment_list

            send_attachments = copy_attachments(
                resolve_attachment_list(template.attachments)
            )
        except Exception as att_exc:  # noqa: BLE001
            print(f"Bulk email: could not load template attachments: {att_exc}", flush=True)
            send_attachments = []

    from_email = (cfg.get("from_mailbox_email") or "").strip().lower()
    mailbox_user = user
    if from_email:
        match = (
            db.query(AppUser)
            .filter(AppUser.mailbox_email.isnot(None))
            .filter(AppUser.mailbox_email.ilike(from_email))
            .first()
        )
        if match is None:
            raise HTTPException(
                400,
                f"From mailbox {from_email} is not linked to a Sales Agent user. "
                "Pick essence@ / marketing@ / info@ (or your own) from the From list.",
            )
        mailbox_user = match
    cc = (cfg.get("cc") or "").strip() or None

    queued = [
        t
        for t in _TASKS
        if t.get("persona") == persona
        and _task_lane(t) == "auto_mode"
        and t.get("status") not in ("in_progress", "running")
    ]
    # Bulk email: AI Auto Mode lane only (queued or already completed from an
    # earlier pass). Re-open completed rows so Start can send again.
    for t in queued:
        if t.get("status") != "queued":
            t["status"] = "queued"
        # Email-ready if they have an address (phone not required for bulk email).
        if (t.get("contact_email") or "").strip():
            t["ready"] = True
    queued = [t for t in queued if t.get("ready", True)]
    if not queued:
        raise HTTPException(
            400,
            f"No contacts on {agent_name}'s AI Auto Mode list to email. "
            "Assign contacts to the agent, move them into AI Auto Mode, then Start again.",
        )
    try:
        from modules import ai_sales_agent_log as asal

        asal.record_run_start(
            db,
            user=user,
            persona=persona,
            queue_lane="auto_mode",
            tasks=queued,
            note=f"{agent_name} AI Auto Mode bulk email started ({len(queued)} contacts)",
        )
    except Exception as log_exc:  # noqa: BLE001
        print(f"AI Sales Agent auto-mode log failed: {log_exc}", flush=True)
    sent = 0
    failed = 0
    delay = float(getattr(app_settings, "bulk_email_message_delay_seconds", 0) or 0)

    class _MergeStub:
        def __init__(self, **kwargs: Any) -> None:
            for key, value in kwargs.items():
                setattr(self, key, value)

    for index, task in enumerate(queued):
        email = (task.get("contact_email") or "").strip()
        greet = (task.get("contact_name") or "there").strip() or "there"
        company = (task.get("company_name") or "").strip()
        if not email:
            task["status"] = "completed"
            task["outcome"] = "no_email"
            task["followup"] = {
                "email_status": "skipped",
                "email_message": "No email on file",
                "whatsapp_status": "skipped",
            }
            failed += 1
            continue

        buyer_id = task.get("buyer_id")
        buyer = db.get(Buyer, int(buyer_id)) if buyer_id else None
        contact = None
        contact_id = task.get("contact_id")
        if contact_id:
            contact = db.get(Contact, int(contact_id))
        if buyer is None:
            buyer = _MergeStub(
                company_name=company,
                country=task.get("country") or "",
                industry="",
                website_url="",
            )
        if contact is None:
            contact = _MergeStub(
                full_name=greet,
                designation=task.get("designation") or "",
                email=email,
            )

        subject = render_template_text(subject_tpl, buyer=buyer, contact=contact)
        body = render_template_text(body_tpl, buyer=buyer, contact=contact)
        send_body = body
        if body and "<" not in body:
            send_body = html_mod.escape(body).replace("\n", "<br/>\n")

        try:
            send_result = mail_client.send_approved(
                to=email,
                subject=subject,
                body=send_body,
                mailbox_user=mailbox_user,
                cc=cc,
                send_mode="bulk",
                attachments=send_attachments or None,
            )
            status = send_result.get("status") or "error"
            task["status"] = "completed"
            task["outcome"] = "emailed"
            task["followup"] = {
                "email_status": status,
                "email_message": send_result.get("message") or status,
                "email_to": email,
                "email_from": from_email or (mailbox_user.mailbox_email or ""),
                "email_cc": cc,
                "email_template_id": template_id,
                "whatsapp_status": "skipped",
                "whatsapp_message": "Call mode off — WhatsApp not sent in bulk-email pass.",
            }
            if status in ("sent", "queued", "ok", "success"):
                sent += 1
            else:
                failed += 1
        except Exception as exc:  # noqa: BLE001
            task["status"] = "completed"
            task["outcome"] = "email_failed"
            task["followup"] = {
                "email_status": "error",
                "email_message": str(exc)[:300],
                "whatsapp_status": "skipped",
            }
            failed += 1

        if index < len(queued) - 1 and delay > 0:
            time.sleep(delay)

    runner["status"] = "idle"
    runner["sequence_mode"] = False
    runner["operator_user_id"] = user.id
    runner["current_task_id"] = None
    runner["current_task"] = None
    runner["bulk_email_result"] = {
        "sent": sent,
        "failed": failed,
        "total": len(queued),
        "from": from_email or (mailbox_user.mailbox_email or ""),
        "cc": cc,
        "template_id": template_id,
        "agent": agent_name,
    }
    _refresh_runner_counts()
    _persist_queue()
    return runner



@router.post("/runners/start")
def start_runner(
    payload: RunnerControlRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    from modules.ai_sales_auto_mode import get_auto_mode_settings

    try:
        sync_runners_from_registry()
    except Exception:  # noqa: BLE001
        pass
    runner = _get_runner(payload.persona)
    if not runner:
        raise HTTPException(404, "Runner persona not found")

    auto = get_auto_mode_settings()
    requested_lane = str(payload.queue_lane or "").strip().lower() or None
    if requested_lane and requested_lane not in _VALID_QUEUE_LANES:
        raise HTTPException(400, "queue_lane must be outreach, data_update, or auto_mode")
    # Bulk email AI Auto Mode list when call mode is off:
    # - explicit Auto Mode Start (queue_lane=auto_mode), or
    # - legacy: Auto Mode enabled and Start without a lane.
    if (
        payload.task_id is None
        and not auto.get("call_mode")
        and auto.get("bulk_email_when_no_call")
        and (
            requested_lane == "auto_mode"
            or (bool(auto.get("enabled")) and requested_lane is None)
        )
    ):
        return _bulk_email_queued(db, persona=payload.persona, user=user, runner=runner)

    dial_lane = requested_lane or "outreach"
    if dial_lane == "data_update":
        raise HTTPException(
            400,
            "Data Update contacts are researched by Data Update Start, not the call runner.",
        )
    runner["queue_lane"] = dial_lane

    in_prog = next(
        (
            t
            for t in _TASKS
            if t.get("persona") == payload.persona
            and t.get("status") in ("in_progress", "running")
            and _lane_matches(t, dial_lane)
        ),
        None,
    )
    if in_prog:
        runner["status"] = "running"
        runner["sequence_mode"] = bool(payload.sequence) if payload.task_id is None else False
        runner["operator_user_id"] = user.id
        runner["current_task_id"] = in_prog.get("id")
        runner["current_task"] = in_prog
        return runner

    if payload.task_id:
        nxt = _find_task(payload.task_id)
        if not nxt:
            raise HTTPException(404, "Queue item not found")
        if nxt.get("persona") != payload.persona:
            raise HTTPException(400, "That queue item belongs to the other agent.")
        if nxt.get("status") != "queued":
            raise HTTPException(400, "That queue item is not waiting to be called.")
        runner["sequence_mode"] = False
        runner["queue_lane"] = "outreach" if _task_lane(nxt) == _DIRECT_LANE else _task_lane(nxt)
    else:
        nxt = _next_queued(payload.persona, lane=dial_lane)
        runner["sequence_mode"] = bool(payload.sequence)
        if not nxt:
            runner["status"] = "idle"
            lane_label = "AI Auto Mode" if dial_lane == "auto_mode" else "Outreach"
            raise HTTPException(
                400,
                f"No ready contacts in this agent's {lane_label} list.",
            )

    runner["operator_user_id"] = user.id
    # Log the contacts this Start will process (sequence = whole lane queue).
    try:
        from modules import ai_sales_agent_log as asal

        if payload.task_id is None and bool(payload.sequence):
            to_log = [
                t
                for t in _TASKS
                if t.get("persona") == payload.persona
                and _task_lane(t) == dial_lane
                and t.get("status") == "queued"
            ]
            if not to_log and nxt:
                to_log = [nxt]
        else:
            to_log = [nxt] if nxt else []
        to_log = [t for t in to_log if not t.get("is_test")]  # test calls stay out of run logs
        if to_log:
            asal.record_run_start(
                db,
                user=user,
                persona=payload.persona,
                queue_lane=dial_lane,
                tasks=to_log,
                note=(
                    f"{_persona_label(payload.persona)} {_lane_label(dial_lane)} started "
                    f"({len(to_log)} contact{'s' if len(to_log) != 1 else ''})"
                ),
            )
    except Exception as log_exc:  # noqa: BLE001
        print(f"AI Sales Agent outreach log failed: {log_exc}", flush=True)
    _dial_task(db, task=nxt, user=user)
    _refresh_runner_counts()
    return runner


@router.post("/runners/pause")
def pause_runner(
    payload: RunnerControlRequest,
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    _ = user
    runner = _get_runner(payload.persona)
    if not runner:
        raise HTTPException(404, "Runner persona not found")
    runner["status"] = "paused"
    runner["sequence_mode"] = False
    return runner


class UpdateRulesRequest(BaseModel):
    rules: str


class TrainFromHistoryRequest(BaseModel):
    """How to pick training examples for Sara & Rayan."""

    source: Literal["auto", "curated", "history", "ids"] = "auto"
    interaction_ids: list[int] = Field(default_factory=list)


@router.get("/training")
def get_ai_training_info(db: Session = Depends(get_db), user: AppUser = Depends(get_current_user)):
    _ = user
    from modules.ai_agent_training import get_training_knowledge
    return get_training_knowledge(db)


@router.get("/training/selected-calls")
def list_ai_training_selected_calls(
    limit: int = Query(80, ge=1, le=200),
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    """Calls ticked Train Sara & Rayan on post-call drafts."""
    _ = user
    from modules.ai_agent_training import list_selected_training_calls

    return list_selected_training_calls(db, limit=limit)


@router.post("/train-from-history")
def train_ai_from_history(
    payload: TrainFromHistoryRequest | None = None,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    _ = user
    from modules.ai_agent_training import train_agent_from_history

    body = payload or TrainFromHistoryRequest()
    try:
        return train_agent_from_history(
            db,
            source=body.source,
            interaction_ids=body.interaction_ids or None,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/update-rules")
def update_ai_sales_rules(payload: UpdateRulesRequest, user: AppUser = Depends(get_current_user)):
    _ = user
    from modules.ai_agent_training import update_custom_rules
    return update_custom_rules(payload.rules)


class BulkEmailPersonaSettings(BaseModel):
    template_id: int | None = None
    from_mailbox_email: str | None = None
    cc: str | None = None
    subject: str | None = None
    body: str | None = None


class AutoModeSettingsUpdate(BaseModel):
    enabled: bool | None = None
    study_contacts: bool | None = None
    call_mode: bool | None = None
    send_email_after_call: bool | None = None
    send_whatsapp_after_call: bool | None = None
    bulk_email_when_no_call: bool | None = None
    study_products: bool | None = None
    product_brief: str | None = None
    bulk_email_by_persona: dict[str, BulkEmailPersonaSettings] | None = None


@router.get("/auto-mode")
def get_ai_auto_mode(user: AppUser = Depends(get_current_user)):
    _ = user
    from modules.ai_sales_auto_mode import get_auto_mode_settings

    return get_auto_mode_settings()


@router.put("/auto-mode")
def put_ai_auto_mode(
    payload: AutoModeSettingsUpdate,
    user: AppUser = Depends(get_current_user),
):
    _ = user
    from modules.ai_sales_auto_mode import update_auto_mode_settings

    patch = payload.model_dump(exclude_none=True)
    # Nested persona dicts: convert Pydantic models already dumped to plain dicts.
    by_persona = patch.get("bulk_email_by_persona")
    if isinstance(by_persona, dict):
        patch["bulk_email_by_persona"] = {
            key: (val if isinstance(val, dict) else dict(val))
            for key, val in by_persona.items()
        }
    return update_auto_mode_settings(patch)


class AutoModeScheduleStartRequest(BaseModel):
    persona: str  # female | male
    run_at: str  # ISO or datetime-local (Asia/Karachi if no tz)


@router.post("/auto-mode/schedule-start")
def post_auto_mode_schedule_start(
    payload: AutoModeScheduleStartRequest,
    user: AppUser = Depends(get_current_user),
):
    """Schedule Start Sara/Rayan at a future date/time (same actions as Start now)."""
    from modules.ai_sales_auto_mode import get_auto_mode_settings, schedule_start

    persona = str(payload.persona or "").strip().lower()
    try:
        sync_runners_from_registry()
    except Exception:  # noqa: BLE001
        pass
    if persona not in _AGENT_PERSONAS:
        raise HTTPException(400, "persona must be an active AI Sales Agent")
    settings = get_auto_mode_settings()
    if not settings.get("enabled"):
        raise HTTPException(400, "Turn AI Auto Mode ON before scheduling a start")
    try:
        entry = schedule_start(
            persona=persona,
            run_at=payload.run_at,
            created_by=user.id,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    name = _agent_name(persona)
    return {
        "ok": True,
        "schedule": entry,
        "message": f"{name} will start at the scheduled time (checks about every minute).",
    }


@router.delete("/auto-mode/schedule-start/{schedule_id}")
def delete_auto_mode_schedule_start(
    schedule_id: str,
    user: AppUser = Depends(get_current_user),
):
    _ = user
    from modules.ai_sales_auto_mode import cancel_scheduled_start

    try:
        entry = cancel_scheduled_start(schedule_id)
    except ValueError as exc:
        raise HTTPException(404 if "not found" in str(exc).lower() else 400, str(exc)) from exc
    return {"ok": True, "schedule": entry}


class SetTaskLaneRequest(BaseModel):
    task_ids: list[int]
    queue_lane: str  # outreach | data_update | auto_mode


@router.post("/tasks/set-lane")
def set_task_lane(
    payload: SetTaskLaneRequest,
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Move tasks between Outreach, Data Update, and AI Auto Mode (mutually exclusive)."""
    _ = user
    lane = str(payload.queue_lane or "").strip().lower()
    if lane not in _VALID_QUEUE_LANES:
        raise HTTPException(400, "queue_lane must be outreach, data_update, or auto_mode")
    updated = 0
    id_set = set(int(x) for x in (payload.task_ids or []) if int(x) > 0)
    for t in _TASKS:
        if t.get("id") in id_set:
            t["queue_lane"] = lane
            # Returning to a runnable lane keeps them dialable / emailable.
            if lane in ("outreach", "auto_mode") and t.get("status") not in ("in_progress",):
                t["status"] = "queued"
            updated += 1
    _refresh_runner_counts()
    _persist_queue()
    # Lane moves stay snappy — no DB assign-log write on every drag between lists.
    return {"updated": updated, "queue_lane": lane}


class DataUpdateScheduleUpdate(BaseModel):
    persona: str
    enabled: bool | None = None
    time: str | None = None
    end_time: str | None = None
    stop_mode: str | None = None  # until_done | until_end_time
    weekdays: list[str] | None = None
    cooldown_sec: int | None = None


@router.post("/tasks/bulk-delete")
def bulk_delete_tasks(
    payload: dict[str, Any],
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    _ = user
    global _TASKS
    ids = payload.get("task_ids") or []
    if not isinstance(ids, list) or not ids:
        raise HTTPException(400, "task_ids required")
    id_set = {int(x) for x in ids if str(x).strip().isdigit() or isinstance(x, int)}
    before = len(_TASKS)
    _TASKS = [t for t in _TASKS if int(t.get("id") or 0) not in id_set]
    _refresh_runner_counts()
    _persist_queue()
    return {"ok": True, "removed": before - len(_TASKS)}


@router.get("/logs")
def list_ai_sales_agent_logs(
    limit: int = Query(200, ge=1, le=500),
    event_kind: str | None = Query(None),
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Assign + process-start activity for AI Sales Agent (admin sees all users)."""
    from modules import ai_sales_agent_log as asal

    kind = (event_kind or "").strip().lower() or None
    if kind and kind not in (asal.EVENT_ASSIGN, asal.EVENT_RUN_START):
        raise HTTPException(400, "event_kind must be assign or run_start")
    # Non-admins only see their own rows.
    role = user.role.value if hasattr(user.role, "value") else str(user.role)
    filter_user_id = None if role == "admin" else user.id
    try:
        events = asal.list_events(
            db, limit=limit, event_kind=kind, user_id=filter_user_id
        )
    except Exception as exc:  # noqa: BLE001
        print(f"AI Sales Agent logs read failed: {exc}", flush=True)
        events = []
    runs = [e for e in events if e.get("event_kind") == asal.EVENT_RUN_START]
    return {
        "events": events,
        "runs": runs,
        "summary": asal.build_summary(events),
    }


@router.get("/data-update")
def get_data_update_status(
    user: AppUser = Depends(get_current_user),
    db=Depends(get_db),
) -> dict[str, Any]:
    _ = user
    from modules import ai_sales_data_update as du

    # One-time backfill of yellow highlights from existing Data Update logs.
    # Does not touch schedules, queues, or the running tick.
    try:
        du.maybe_sync_highlights_once(db)
    except Exception:  # noqa: BLE001
        pass

    status = du.get_status()
    queues: dict[str, dict[str, list[dict[str, Any]]]] = {
        pid: {"outreach": [], "data_update": [], "auto_mode": []}
        for pid in list(status.get("schedules") or {"female": None, "male": None})
    }
    if "female" not in queues:
        queues["female"] = {"outreach": [], "data_update": [], "auto_mode": []}
    if "male" not in queues:
        queues["male"] = {"outreach": [], "data_update": [], "auto_mode": []}
    for t in _TASKS:
        persona = t.get("persona")
        if persona not in queues:
            continue
        lane = _task_lane(t)
        if lane not in queues[persona]:
            queues[persona][lane] = []
        queues[persona][lane].append(t)
    status["queues"] = queues
    return status


@router.put("/data-update/schedule")
def put_data_update_schedule(
    payload: DataUpdateScheduleUpdate,
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    _ = user
    from modules import ai_sales_data_update as du

    persona = str(payload.persona or "").strip().lower()
    known = set(du.persona_ids())
    if persona not in known:
        try:
            du.ensure_persona_slots([persona])
            known = set(du.persona_ids())
        except Exception:  # noqa: BLE001
            pass
    if persona not in known:
        raise HTTPException(400, "Unknown AI Sales Agent persona")
    return du.update_schedule(persona, payload.model_dump(exclude_none=True))


@router.post("/data-update/run-now")
def run_data_update_now(
    persona: str = Query(...),
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    from modules import ai_sales_data_update as du

    p = str(persona or "").strip().lower()
    known = set(du.persona_ids())
    if p not in known:
        try:
            du.ensure_persona_slots([p])
            known = set(du.persona_ids())
        except Exception:  # noqa: BLE001
            pass
    if p not in known:
        raise HTTPException(400, "Unknown AI Sales Agent persona")
    pending = [
        t
        for t in _TASKS
        if t.get("persona") == p and _task_lane(t) == "data_update"
    ]
    if not pending:
        raise HTTPException(400, "No contacts in this agent's Data Update queue.")
    # Reset run markers so all current queue items are processed.
    run_data = du.start_run(p, total=len(pending), force=True)
    run_id = run_data["run_state"][p].get("run_id")
    for t in pending:
        t.pop("data_update_run_id", None)
        t["status"] = "queued"
    _persist_queue()
    try:
        from modules import ai_sales_agent_log as asal

        asal.record_run_start(
            db,
            user=user,
            persona=p,
            queue_lane="data_update",
            tasks=pending,
            note=(
                f"{_persona_label(p)} Data Update started "
                f"({len(pending)} contact{'s' if len(pending) != 1 else ''})"
            ),
        )
    except Exception as log_exc:  # noqa: BLE001
        print(f"AI Sales Agent data-update log failed: {log_exc}", flush=True)
    return {"ok": True, "run_id": run_id, "total": len(pending), "status": run_data}


class WorkspaceAutopilotUpdate(BaseModel):
    enabled: bool | None = None
    auto_remarks: bool | None = None
    auto_interested: bool | None = None
    auto_not_interested: bool | None = None
    auto_no_response: bool | None = None
    auto_follow_up: bool | None = None


@router.get("/workspace-autopilot")
def get_workspace_autopilot(user: AppUser = Depends(get_current_user)):
    _ = user
    from modules.ai_workspace_autopilot import get_workspace_autopilot_settings

    return get_workspace_autopilot_settings()


@router.put("/workspace-autopilot")
def put_workspace_autopilot(
    payload: WorkspaceAutopilotUpdate,
    user: AppUser = Depends(get_current_user),
):
    _ = user
    from modules.ai_workspace_autopilot import update_workspace_autopilot_settings

    return update_workspace_autopilot_settings(payload.model_dump(exclude_none=True))


class ProcessScheduleModel(BaseModel):
    kind: str = "daily"
    time: str = "09:45"
    weekdays: list[str] | None = None


class ProcessActionsModel(BaseModel):
    call: bool = False
    email: bool = True
    whatsapp: bool = True


class ProcessCreateRequest(BaseModel):
    name: str
    persona: str = "female"
    enabled: bool = True
    schedule: ProcessScheduleModel | None = None
    actions: ProcessActionsModel | None = None
    buyer_ids: list[int] = []
    contact_ids: list[int | None] | None = None


class ProcessUpdateRequest(BaseModel):
    name: str | None = None
    persona: str | None = None
    enabled: bool | None = None
    schedule: ProcessScheduleModel | None = None
    actions: ProcessActionsModel | None = None
    buyer_ids: list[int] | None = None
    contact_ids: list[int | None] | None = None


def execute_recurring_process(
    db: Session,
    *,
    process: dict[str, Any],
    user: AppUser,
) -> dict[str, Any]:
    """Assign process contacts to Sara/Rayan queue and run ticked actions."""
    personas: list[str] = []
    persona = str(process.get("persona") or "female")
    try:
        sync_runners_from_registry()
    except Exception:  # noqa: BLE001
        pass
    if persona == "both":
        personas = [p for p in ("female", "male") if p in _AGENT_PERSONAS] or ["female", "male"]
    elif persona in _AGENT_PERSONAS:
        personas = [persona]
    else:
        personas = ["female"] if "female" in _AGENT_PERSONAS else list(_AGENT_PERSONAS)[:1] or ["female"]

    actions = process.get("actions") or {}
    buyer_ids = [int(b) for b in (process.get("buyer_ids") or []) if int(b) > 0]
    contact_ids = process.get("contact_ids") or []
    assigned_total = 0
    for p in personas:
        created = assign_tasks(
            AssignTaskRequest(persona=p, buyer_ids=buyer_ids, contact_ids=contact_ids or None),
            db=db,
            user=user,
        )
        assigned_total += len(created.get("tasks") or [])

    email_sent = 0
    wa_sent = 0
    call_started = False

    # Call mode: start sequence for each persona that has queued ready tasks.
    if actions.get("call"):
        for p in personas:
            runner = _get_runner(p)
            if not runner:
                continue
            try:
                start_runner(
                    RunnerControlRequest(persona=p, sequence=True, task_id=None),
                    db=db,
                    user=user,
                )
                call_started = True
            except HTTPException:
                continue

    # If not calling (or call failed to start), still honor email/WhatsApp for queued contacts.
    if not actions.get("call") or actions.get("email") or actions.get("whatsapp"):
        from integrations import whatsapp_bridge_client as bridge
        from integrations.mail_client import mail_client

        for p in personas:
            agent_name = _agent_name(p)
            queued = [
                t
                for t in _TASKS
                if t.get("persona") == p
                and t.get("status") == "queued"
                and t.get("buyer_id") in set(buyer_ids)
            ]
            for task in queued:
                greet = (task.get("contact_name") or "there").strip() or "there"
                company = (task.get("company_name") or "").strip()
                email = (task.get("contact_email") or "").strip()
                phone = (task.get("contact_phone") or "").strip()
                followup: dict[str, Any] = dict(task.get("followup") or {})

                if actions.get("email") and not actions.get("call") and email:
                    subject = f"Introduction — {agent_name}, Kafi Commodities"
                    body = (
                        f"<p>Dear {greet},</p>"
                        f"<p>This is <strong>{agent_name}</strong> from "
                        "<strong>Kafi Commodities (Pvt.) Ltd. (Brand: ESSENCE)</strong>"
                        f"{f' regarding {company}' if company else ''}.</p>"
                        "<p>We would like to share catalogues and CNF/FOB pricing for your market.</p>"
                        f"<p>Best regards,<br/><strong>{agent_name}</strong><br/>"
                        "Kafi Commodities Export Team</p>"
                    )
                    try:
                        send_result = mail_client.send_approved(
                            to=email,
                            subject=subject,
                            body=body,
                            mailbox_user=user,
                        )
                        status = send_result.get("status") or "error"
                        followup["email_status"] = status
                        followup["email_to"] = email
                        if status in ("sent", "queued", "ok", "success"):
                            email_sent += 1
                    except Exception as exc:  # noqa: BLE001
                        followup["email_status"] = "error"
                        followup["email_message"] = str(exc)[:200]

                if actions.get("whatsapp") and phone:
                    wa_text = (
                        f"Hello {greet}, this is {agent_name} from Kafi Commodities "
                        "(Brand: ESSENCE).\n\n"
                        "Sharing a quick note — happy to send catalogues, packaging details, "
                        "and CNF/FOB pricing whenever you are ready.\n\n"
                        f"Best regards,\n{agent_name}\nKafi Commodities Export Team"
                    )
                    try:
                        status = bridge.bridge_status(user.id, username=user.username)
                        if not status.get("connected"):
                            followup["whatsapp_status"] = "not_connected"
                        else:
                            wa_res = bridge.bridge_send(
                                user.id,
                                to_phone=phone,
                                message=wa_text,
                                username=user.username,
                            )
                            st = wa_res.get("status") or ("sent" if wa_res.get("ok") else "error")
                            followup["whatsapp_status"] = st
                            if st == "sent" or wa_res.get("ok"):
                                wa_sent += 1
                    except Exception as exc:  # noqa: BLE001
                        followup["whatsapp_status"] = "error"
                        followup["whatsapp_message"] = str(exc)[:200]

                task["followup"] = followup
                if not actions.get("call"):
                    task["status"] = "completed"
                    task["outcome"] = "process_outreach"
                    task["completed_at"] = _now_iso()

    _refresh_runner_counts()
    return {
        "assigned": assigned_total,
        "email_sent": email_sent,
        "whatsapp_sent": wa_sent,
        "call_started": call_started,
        "personas": personas,
    }


@router.get("/processes")
def list_ai_processes(user: AppUser = Depends(get_current_user)):
    _ = user
    from modules.ai_sales_processes import list_processes

    return {"processes": list_processes()}


@router.post("/processes")
def create_ai_process(
    payload: ProcessCreateRequest,
    user: AppUser = Depends(get_current_user),
):
    _ = user
    from modules.ai_sales_processes import create_process

    body = payload.model_dump()
    if payload.schedule:
        body["schedule"] = payload.schedule.model_dump()
    if payload.actions:
        body["actions"] = payload.actions.model_dump()
    return create_process(body)


@router.put("/processes/{process_id}")
def update_ai_process(
    process_id: str,
    payload: ProcessUpdateRequest,
    user: AppUser = Depends(get_current_user),
):
    _ = user
    from modules.ai_sales_processes import update_process

    patch = payload.model_dump(exclude_none=True)
    if payload.schedule is not None:
        patch["schedule"] = payload.schedule.model_dump()
    if payload.actions is not None:
        patch["actions"] = payload.actions.model_dump()
    updated = update_process(process_id, patch)
    if not updated:
        raise HTTPException(404, "Process not found")
    return updated


@router.delete("/processes/{process_id}")
def delete_ai_process(
    process_id: str,
    user: AppUser = Depends(get_current_user),
):
    _ = user
    from modules.ai_sales_processes import delete_process

    if not delete_process(process_id):
        raise HTTPException(404, "Process not found")
    return {"ok": True}


@router.post("/processes/{process_id}/run-now")
def run_ai_process_now(
    process_id: str,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    from modules.ai_sales_processes import get_process, mark_process_ran

    proc = get_process(process_id)
    if not proc:
        raise HTTPException(404, "Process not found")
    if not proc.get("buyer_ids"):
        raise HTTPException(400, "Assign at least one contact (buyer ID) to this process first.")
    result = execute_recurring_process(db, process=proc, user=user)
    from datetime import datetime
    from zoneinfo import ZoneInfo

    run_key = datetime.now(ZoneInfo("Asia/Karachi")).strftime("%Y-%m-%dT%H:%M") + "-manual"
    mark_process_ran(process_id, run_key, result)
    return {"ok": True, "result": result, "process": get_process(process_id)}


@webhooks_router.post("/ai-agent")
async def vapi_ai_agent_status(request: Request) -> dict[str, Any]:
    """Vapi end-of-call / status-update — auto WhatsApp + email, then next in queue."""
    try:
        body = await request.json()
    except Exception:
        return {"ok": True}
    message = body.get("message") if isinstance(body, dict) else None
    if not isinstance(message, dict):
        message = body if isinstance(body, dict) else {}
    msg_type = str(message.get("type") or "")
    if msg_type and msg_type not in {"end-of-call-report", "status-update"}:
        return {"ok": True, "ignored": True}
    call = message.get("call") if isinstance(message.get("call"), dict) else body.get("call") or {}
    metadata = {}
    if isinstance(call, dict) and isinstance(call.get("metadata"), dict):
        metadata = call["metadata"]
    elif isinstance(message.get("metadata"), dict):
        metadata = message["metadata"]
    task_id = metadata.get("task_id") if isinstance(metadata, dict) else None
    try:
        task_id_int = int(task_id) if task_id is not None else None
    except (TypeError, ValueError):
        task_id_int = None
    call_sid = None
    if isinstance(call, dict):
        call_sid = call.get("id") or call.get("callId")
    ended_reason = message.get("endedReason") or message.get("ended_reason") or call.get("endedReason")
    status = message.get("status") or call.get("status") or ended_reason
    duration = (
        message.get("durationSeconds")
        or message.get("duration")
        or (call.get("duration") if isinstance(call, dict) else None)
    )

    # Pull summary / transcript / recording for Call history + Train Sara & Rayan.
    call_summary = None
    call_transcript = None
    recording_url = None
    analysis = message.get("analysis") if isinstance(message.get("analysis"), dict) else {}
    artifact = message.get("artifact") if isinstance(message.get("artifact"), dict) else {}
    for candidate in (
        message.get("summary"),
        analysis.get("summary") if isinstance(analysis, dict) else None,
        analysis.get("successEvaluation") if isinstance(analysis, dict) else None,
        message.get("successEvaluation"),
    ):
        if isinstance(candidate, str) and candidate.strip():
            call_summary = candidate.strip()
            break
    for candidate in (
        message.get("transcript"),
        artifact.get("transcript") if isinstance(artifact, dict) else None,
        call.get("transcript") if isinstance(call, dict) else None,
    ):
        if isinstance(candidate, str) and candidate.strip():
            call_transcript = candidate.strip()[:8000]
            break
        if isinstance(candidate, list):
            # Vapi sometimes sends message array transcript
            parts = []
            for row in candidate[:80]:
                if isinstance(row, dict):
                    role = row.get("role") or row.get("speaker") or ""
                    text = row.get("message") or row.get("text") or ""
                    if text:
                        parts.append(f"{role}: {text}".strip())
                elif isinstance(row, str):
                    parts.append(row)
            if parts:
                call_transcript = "\n".join(parts)[:8000]
                break

    for candidate in (
        message.get("recordingUrl"),
        message.get("stereoRecordingUrl"),
        message.get("presignedMonoUrl"),
        message.get("presignedStereoUrl"),
        artifact.get("presignedMonoUrl") if isinstance(artifact, dict) else None,
        artifact.get("presignedStereoUrl") if isinstance(artifact, dict) else None,
        artifact.get("recordingUrl") if isinstance(artifact, dict) else None,
        artifact.get("stereoRecordingUrl") if isinstance(artifact, dict) else None,
        artifact.get("recording") if isinstance(artifact, dict) else None,
        call.get("presignedMonoUrl") if isinstance(call, dict) else None,
        call.get("presignedStereoUrl") if isinstance(call, dict) else None,
        call.get("recordingUrl") if isinstance(call, dict) else None,
        call.get("stereoRecordingUrl") if isinstance(call, dict) else None,
    ):
        if isinstance(candidate, str) and candidate.strip().startswith("http"):
            recording_url = candidate.strip()
            break
        if isinstance(candidate, dict):
            for key in ("url", "presignedMonoUrl", "presignedStereoUrl", "recordingUrl", "stereoRecordingUrl"):
                val = candidate.get(key)
                if isinstance(val, str) and val.strip().startswith("http"):
                    recording_url = val.strip()
                    break
            if recording_url:
                break

    # Fallback: fetch call from Vapi if webhook omitted the recording URL.
    if not recording_url and call_sid and not str(call_sid).startswith("CA"):
        try:
            import json as _json
            import urllib.request

            from config import settings as app_settings

            vkey = getattr(app_settings, "vapi_api_key", None)
            if vkey:
                req = urllib.request.Request(
                    f"https://api.vapi.ai/call/{call_sid}",
                    headers={
                        "Authorization": f"Bearer {vkey}",
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                    },
                )
                with urllib.request.urlopen(req, timeout=12) as res:
                    call_data = _json.loads(res.read().decode("utf-8"))
                art = call_data.get("artifact") if isinstance(call_data, dict) else None
                for candidate in (
                    (art or {}).get("presignedMonoUrl") if isinstance(art, dict) else None,
                    (art or {}).get("presignedStereoUrl") if isinstance(art, dict) else None,
                    (call_data or {}).get("presignedMonoUrl"),
                    (call_data or {}).get("presignedStereoUrl"),
                    (call_data or {}).get("recordingUrl"),
                    (call_data or {}).get("stereoRecordingUrl"),
                    (art or {}).get("recordingUrl") if isinstance(art, dict) else None,
                    (art or {}).get("stereoRecordingUrl") if isinstance(art, dict) else None,
                ):
                    if isinstance(candidate, str) and candidate.strip().startswith("http"):
                        recording_url = candidate.strip()
                        break
                if not call_transcript and isinstance(art, dict):
                    t = art.get("transcript")
                    if isinstance(t, str) and t.strip():
                        call_transcript = t.strip()[:8000]
        except Exception as fetch_exc:  # noqa: BLE001
            print(f"Vapi call fetch for recording skipped: {fetch_exc}", flush=True)

    if str(status or "").lower().replace("_", "-") in {"in-progress", "answered", "forwarding"}:
        # The customer picked up: this call must never be treated as a missed ring/redialed.
        live_task = _find_task(task_id_int)
        if live_task is None and call_sid:
            live_task = next((t for t in _TASKS if t.get("call_sid") == call_sid), None)
        if live_task is not None:
            live_task["answered"] = True
    if msg_type == "status-update" and str(status or "").lower() not in {
        "ended",
        "completed",
        "failed",
    }:
        return {"ok": True, "ignored": True}
    ring_attempt = None
    if isinstance(metadata, dict) and metadata.get("ring_attempt") is not None:
        try:
            ring_attempt = int(metadata.get("ring_attempt"))
        except (TypeError, ValueError):
            ring_attempt = None
    interaction_id = None
    if isinstance(metadata, dict) and metadata.get("interaction_id") is not None:
        try:
            interaction_id = int(metadata.get("interaction_id"))
        except (TypeError, ValueError):
            interaction_id = None
    from fastapi.concurrency import run_in_threadpool
    return await run_in_threadpool(
        handle_ai_call_status,
        task_id=task_id_int,
        call_sid=str(call_sid) if call_sid else None,
        status=str(status or ""),
        duration=duration,
        ended_reason=str(ended_reason or ""),
        call_summary=call_summary,
        call_transcript=call_transcript,
        ring_attempt=ring_attempt,
        recording_url=recording_url,
        interaction_id=interaction_id,
    )


# Restore queue after all helpers exist (survives Railway redeploys).
_load_persisted_queue()
try:
    sync_runners_from_registry()
except Exception:
    pass
try:
    _refresh_runner_counts()
except Exception:
    pass