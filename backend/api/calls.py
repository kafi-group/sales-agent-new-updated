from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from api.deps import get_current_user, get_db, require_admin
from api.schemas import (
    CallConfigRead,
    CallFilterOptionsResponse,
    CallHistoryItem,
    CallHistoryListResponse,
    CallInitiateRequest,
    CallInitiateResponse,
    CallNotesRequest,
    DialableContactSuggestion,
    DialableContactSuggestionsResponse,
    DialableLeadsResponse,
    ManualCallRequest,
    TwilioBalanceRead,
    VoiceTokenRead,
)
from db.models import AppUser, AppUserRole, Contact, Interaction
from db.session import SessionLocal
from integrations.voice_client import voice_client
from modules import calls as calls_module
from modules import leads as leads_module

from config import settings


def _is_admin(user: AppUser) -> bool:
    role = user.role.value if isinstance(user.role, AppUserRole) else str(user.role)
    return role == AppUserRole.admin.value


def _require_lead_access(db: Session, user: AppUser, lead_id: int) -> None:
    if not leads_module.user_can_access_buyer(db, user=user, buyer_id=lead_id):
        raise HTTPException(403, "You do not have access to this lead")

router = APIRouter(tags=["calls"])


@router.get("/calls/contact-suggestions", response_model=DialableContactSuggestionsResponse)
def suggest_dialable_contacts(
    q: str = Query("", min_length=0, max_length=200),
    section: str | None = Query(None),
    country: str | None = Query(None),
    grade: str | None = Query(None),
    designation: str | None = Query(None),
    limit: int = Query(25, ge=1, le=80),
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    """Typeahead search for contacts/companies with phone numbers for dialer autocomplete with multi-filters."""
    assigned_id = None if _is_admin(user) else user.id
    rows = calls_module.suggest_dialable_contacts(
        db,
        q=q,
        section=section,
        country=country,
        grade=grade,
        designation=designation,
        limit=limit,
        assigned_to_user_id=assigned_id,
    )
    return DialableContactSuggestionsResponse(
        q=q.strip(),
        section=section,
        country=country,
        grade=grade,
        designation=designation,
        rows=[DialableContactSuggestion(**row) for row in rows],
    )


@router.get("/calls/filter-options", response_model=CallFilterOptionsResponse)
def get_call_filter_options(
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    """Return distinct filter options (countries, grades, designations) for dialer."""
    assigned_id = None if _is_admin(user) else user.id
    return CallFilterOptionsResponse(
        **calls_module.get_call_filter_options(db, assigned_to_user_id=assigned_id)
    )


def _twilio_webhook_url(request: Request) -> str:
    """URL Twilio signed — use public base behind ngrok/Railway, not internal http://."""
    base = (settings.twilio_webhook_base_url or "").rstrip("/")
    if base:
        path = request.url.path
        query = request.url.query
        return f"{base}{path}" + (f"?{query}" if query else "")
    url = str(request.url)
    if request.headers.get("x-forwarded-proto") == "https" and url.startswith("http://"):
        return "https://" + url[7:]
    return url


def _twilio_webhook_url_candidates(request: Request) -> list[str]:
    """Build URL variants Railway/Twilio may disagree on during signature checks."""
    primary = _twilio_webhook_url(request)
    out = [primary]
    forwarded_host = (request.headers.get("x-forwarded-host") or "").split(",")[0].strip()
    forwarded_proto = (request.headers.get("x-forwarded-proto") or "https").split(",")[0].strip()
    if forwarded_host:
        path = request.url.path
        query = request.url.query
        out.append(
            f"{forwarded_proto}://{forwarded_host}{path}" + (f"?{query}" if query else "")
        )
    # Full request URL as seen by Starlette (often http:// inside Railway)
    out.append(str(request.url))
    if str(request.url).startswith("http://"):
        out.append("https://" + str(request.url)[7:])
    # Deduplicate while preserving order
    seen: set[str] = set()
    unique: list[str] = []
    for u in out:
        if u and u not in seen:
            seen.add(u)
            unique.append(u)
    return unique


async def _twilio_form(request: Request) -> dict[str, str]:
    form = await request.form()
    params = {str(k): str(v) for k, v in form.items()}
    if voice_client.is_configured and settings.twilio_validate_webhooks:
        signature = request.headers.get("X-Twilio-Signature", "")
        candidates = _twilio_webhook_url_candidates(request)
        if not voice_client.validate_webhook(
            _twilio_webhook_url(request),
            params,
            signature,
            alternate_urls=candidates,
        ):
            import logging

            logging.getLogger("twilio.webhook").warning(
                "Twilio signature mismatch path=%s candidates=%s has_signature=%s",
                request.url.path,
                candidates,
                bool(signature),
            )
            # Only block if strict enforcement is configured
            if str(getattr(settings, "twilio_strict_webhooks", "false")).lower() in {"1", "true", "yes"}:
                raise HTTPException(403, "Invalid Twilio signature")
    return params


def _transcribe_in_background(interaction_id: int) -> None:
    import logging

    logger = logging.getLogger(__name__)
    db = SessionLocal()
    try:
        calls_module.transcribe_call(db, interaction_id=interaction_id)
    except Exception:
        logger.exception("Background transcription failed for interaction %s", interaction_id)
    finally:
        db.close()


@router.get("/calls/config", response_model=CallConfigRead)
def get_call_config():
    cfg = calls_module.call_config()
    return CallConfigRead(**cfg)


@router.get("/calls/twilio-balance", response_model=TwilioBalanceRead)
def get_twilio_balance(_admin: AppUser = Depends(require_admin)):
    """Admin-only live Twilio prepaid balance for voice calling."""
    return TwilioBalanceRead(**calls_module.twilio_balance())


class ToggleHangupAfterFourthRingRequest(BaseModel):
    enabled: bool
    max_ring_attempts: int | None = None


@router.post("/calls/hangup-after-fourth-ring")
def toggle_hangup_after_fourth_ring(
    payload: ToggleHangupAfterFourthRingRequest,
    _admin: AppUser = Depends(require_admin),
):
    """Hang up unanswered dials after ring_timeout, then redial up to max_ring_attempts."""
    settings.hangup_after_fourth_ring = bool(payload.enabled)
    if payload.max_ring_attempts is not None:
        try:
            settings.max_ring_attempts = max(1, min(20, int(payload.max_ring_attempts)))
        except (TypeError, ValueError):
            pass
    seconds = int(getattr(settings, "ring_timeout_seconds", 16) or 16)
    attempts = int(getattr(settings, "max_ring_attempts", 10) or 10)
    return {
        "ok": True,
        "hangup_after_fourth_ring": settings.hangup_after_fourth_ring,
        "ring_timeout_seconds": seconds,
        "max_ring_attempts": attempts,
        "message": (
            f"Each unanswered dial rings ~{seconds}s then hangs up and redials "
            f"(up to {attempts} attempts) until answered — avoids sitting in voicemail."
            if settings.hangup_after_fourth_ring
            else "Calls can ring through to voicemail (Twilio credits will be used if voicemail answers)."
        ),
    }


@router.get("/calls/twilio-status")
def get_twilio_public_status():
    """Unauthenticated diagnostics for Twilio Console vs Railway mismatches."""
    cfg = calls_module.call_config()
    return {
        "configured": cfg.get("configured"),
        "webhooks_ready": cfg.get("webhooks_ready"),
        "browser_ready": cfg.get("browser_ready"),
        "caller_id_masked": cfg.get("caller_id_masked"),
        "twilio_account_sid": cfg.get("twilio_account_sid"),
        "twilio_twiml_app_sid": cfg.get("twilio_twiml_app_sid"),
        "twilio_webhook_base_url": cfg.get("twilio_webhook_base_url"),
        "twilio_validate_webhooks": cfg.get("twilio_validate_webhooks"),
        "setup_message": cfg.get("setup_message"),
        "missing_env": cfg.get("missing_env"),
    }


class VoiceEngineSettingsResponse(BaseModel):
    vapi_enabled: bool
    vapi_key_configured: bool
    elevenlabs_enabled: bool
    elevenlabs_key_masked: str | None = None
    has_elevenlabs_key: bool


class UnlockVoiceSettingsRequest(BaseModel):
    pin: str


class ToggleVoiceEngineRequest(BaseModel):
    pin: str
    enabled: bool


class UpdateElevenLabsKeyRequest(BaseModel):
    pin: str
    api_key: str | None = None


@router.post("/calls/unlock-voice-settings", response_model=VoiceEngineSettingsResponse)
def unlock_voice_settings(payload: UnlockVoiceSettingsRequest):
    if payload.pin != "786786":
        raise HTTPException(status_code=400, detail="Invalid PIN code. Authorization failed.")
    return get_voice_engine_settings()


@router.get("/calls/voice-engine-settings", response_model=VoiceEngineSettingsResponse)
def get_voice_engine_settings():
    eleven_key = getattr(settings, "elevenlabs_api_key", None) or ""
    masked = f"••••{eleven_key[-4:]}" if len(eleven_key) >= 4 else ("••••" if eleven_key else None)
    return VoiceEngineSettingsResponse(
        vapi_enabled=getattr(settings, "vapi_enabled", True),
        vapi_key_configured=bool(getattr(settings, "vapi_api_key", None)),
        elevenlabs_enabled=getattr(settings, "elevenlabs_enabled", True),
        elevenlabs_key_masked=masked,
        has_elevenlabs_key=bool(eleven_key.strip()),
    )


@router.post("/calls/toggle-vapi-engine")
def toggle_vapi_engine(payload: ToggleVoiceEngineRequest):
    if payload.pin != "786786":
        raise HTTPException(status_code=400, detail="Invalid PIN code. Authorization failed.")
    settings.vapi_enabled = payload.enabled
    return {
        "ok": True,
        "vapi_enabled": settings.vapi_enabled,
        "message": f"Vapi Voice Engine is now {'ON' if payload.enabled else 'OFF'}.",
    }


@router.post("/calls/toggle-elevenlabs-engine")
def toggle_elevenlabs_engine(payload: ToggleVoiceEngineRequest):
    if payload.pin != "786786":
        raise HTTPException(status_code=400, detail="Invalid PIN code. Authorization failed.")
    settings.elevenlabs_enabled = payload.enabled
    return {
        "ok": True,
        "elevenlabs_enabled": settings.elevenlabs_enabled,
        "message": f"ElevenLabs Voice API is now {'ON' if payload.enabled else 'OFF'}.",
    }


@router.post("/calls/update-elevenlabs-key")
def update_elevenlabs_key(payload: UpdateElevenLabsKeyRequest):
    if payload.pin != "786786":
        raise HTTPException(status_code=400, detail="Invalid PIN code. Authorization failed.")
    new_key = (payload.api_key or "").strip() or None
    settings.elevenlabs_api_key = new_key

    if new_key and getattr(settings, "vapi_api_key", None):
        try:
            import json
            import urllib.request
            data = json.dumps({"provider": "11labs", "apiKey": new_key}).encode()
            req = urllib.request.Request(
                "https://api.vapi.ai/credential",
                data=data,
                headers={
                    "Authorization": f"Bearer {settings.vapi_api_key}",
                    "Content-Type": "application/json",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                },
            )
            with urllib.request.urlopen(req, timeout=10) as res:
                _ = res.read()
        except Exception as exc:
            print(f"Could not sync ElevenLabs key to Vapi credentials: {exc}", flush=True)

    return {
        "ok": True,
        "has_key": bool(settings.elevenlabs_api_key),
        "message": "ElevenLabs API Key updated and synced to Vapi successfully.",
    }


@router.get("/calls/dialable-leads", response_model=DialableLeadsResponse)
def list_dialable_leads(
    page: int = 1,
    page_size: int = 25,
    country: str | None = None,
    valid_now: str | None = Query(
        default=None,
        description="yes = inside calling hours now; no = outside; omit = all",
    ),
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    """Quick Dial list: leads with phone numbers, scoped by role."""
    if _is_admin(user):
        assigned_to_user_id = None
        unassigned_only = False
    else:
        assigned_to_user_id = user.id
        unassigned_only = False
    result = calls_module.list_dialable_leads(
        db,
        assigned_to_user_id=assigned_to_user_id,
        unassigned_only=unassigned_only,
        country=country,
        valid_now=valid_now,
        page=page,
        page_size=page_size,
    )
    return DialableLeadsResponse(**result)


@router.get("/calls/voice-token", response_model=VoiceTokenRead)
def get_voice_token():
    try:
        result = calls_module.voice_access_token()
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(500, f"Voice token failed: {exc}") from exc
    return VoiceTokenRead(**result)


@router.get("/calls/history", response_model=CallHistoryListResponse)
def list_call_history(
    page: int = Query(1, ge=1),
    page_size: int = Query(5, ge=1, le=50),
    since_days: int = Query(calls_module.CALL_HISTORY_RETENTION_DAYS, ge=1, le=366),
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    assigned_id = None if _is_admin(user) else user.id
    result = calls_module.list_call_history(
        db,
        assigned_to_user_id=assigned_id,
        page=page,
        page_size=page_size,
        since_days=since_days,
    )
    return CallHistoryListResponse(
        total=int(result["total"]),
        page=int(result["page"]),
        page_size=int(result["page_size"]),
        total_pages=int(result["total_pages"]),
        since_days=result.get("since_days"),
        rows=[CallHistoryItem(**row) for row in result["rows"]],
    )


@router.get("/leads/{lead_id}/calls", response_model=CallHistoryListResponse)
def list_lead_calls(
    lead_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(5, ge=1, le=50),
    since_days: int | None = Query(None, ge=1, le=366),
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    from modules.buyers import get_buyer

    _require_lead_access(db, user, lead_id)
    if not get_buyer(db, lead_id):
        raise HTTPException(404, "Lead not found")
    result = calls_module.list_call_history(
        db,
        buyer_id=lead_id,
        page=page,
        page_size=page_size,
        since_days=since_days,
    )
    return CallHistoryListResponse(
        total=int(result["total"]),
        page=int(result["page"]),
        page_size=int(result["page_size"]),
        total_pages=int(result["total_pages"]),
        since_days=result.get("since_days"),
        rows=[CallHistoryItem(**row) for row in result["rows"]],
    )


def _generate_personalized_followup(draft_id: int) -> None:
    from db.session import SessionLocal
    from modules import personalized_followups as pf_module

    db = SessionLocal()
    try:
        pf_module.generate_draft_content(db, draft_id)
    except Exception:  # noqa: BLE001
        pass
    finally:
        db.close()


@router.get("/calls/{interaction_id}", response_model=CallHistoryItem)
def get_call_history_item(
    interaction_id: int,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    from db.models import Channel, Interaction

    interaction = db.get(Interaction, interaction_id)
    if not interaction or interaction.channel != Channel.phone:
        raise HTTPException(404, "Call not found")
    if interaction.contact_id:
        contact = db.get(Contact, interaction.contact_id)
        if contact and contact.buyer_id:
            _require_lead_access(db, user, contact.buyer_id)
    row = calls_module.get_call_history_item(db, interaction_id=interaction_id)
    if not row:
        raise HTTPException(404, "Call not found")
    return CallHistoryItem(**row)


@router.patch("/calls/{interaction_id}/notes", response_model=CallHistoryItem)
def update_call_notes(
    interaction_id: int,
    payload: CallNotesRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    try:
        result = calls_module.update_call_followup(
            db,
            interaction_id=interaction_id,
            notes=payload.notes,
            call_outcome=payload.call_outcome,
            app_user_id=user.id,
        )
    except ValueError as exc:
        raise HTTPException(400 if "Invalid call outcome" in str(exc) else 404, str(exc)) from exc

    outcome = (result.get("call_outcome") or "").strip().lower()
    if outcome in {"interested", "follow_up"}:
        from db.models import PersonalizedFollowupDraft

        draft = (
            db.query(PersonalizedFollowupDraft)
            .filter(PersonalizedFollowupDraft.interaction_id == interaction_id)
            .one_or_none()
        )
        if draft and draft.status in {"awaiting_transcript", "failed", "generating"}:
            background_tasks.add_task(_generate_personalized_followup, draft.id)

    return CallHistoryItem(**result)


class CallTrainingFlagRequest(BaseModel):
    selected: bool = True


@router.patch("/calls/{interaction_id}/training-flag", response_model=CallHistoryItem)
def set_call_training_flag(
    interaction_id: int,
    payload: CallTrainingFlagRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    """Mark/unmark a call for Sara & Rayan curated training."""
    interaction = db.get(Interaction, interaction_id)
    if interaction and interaction.contact_id:
        contact = db.get(Contact, interaction.contact_id)
        if contact and contact.buyer_id:
            _require_lead_access(db, user, contact.buyer_id)
    try:
        result = calls_module.set_ai_training_selected(
            db,
            interaction_id=interaction_id,
            selected=bool(payload.selected),
        )
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    return CallHistoryItem(**result)


@router.delete("/calls/{interaction_id}", status_code=204)
def delete_call_log(interaction_id: int, db: Session = Depends(get_db)):
    if not calls_module.delete_call_log(db, interaction_id=interaction_id):
        raise HTTPException(404, "Call not found")
    return Response(status_code=204)


@router.get("/calls/{interaction_id}/recording")
def get_call_recording(
    interaction_id: int,
    download: bool = Query(False),
    db: Session = Depends(get_db),
):
    try:
        path, content_type, filename = calls_module.get_call_recording_file(
            db, interaction_id=interaction_id
        )
    except Exception as exc:
        # If local download failed or isn't saved yet, check if there is an external recording URL and redirect to it
        from modules.call_media import get_call_media
        from starlette.responses import RedirectResponse

        interaction = db.get(Interaction, interaction_id)
        media = get_call_media(interaction) if interaction else None
        ext_url = (media or {}).get("recording_url")
        if ext_url and str(ext_url).startswith("http"):
            return RedirectResponse(url=ext_url)
        raise HTTPException(404, str(exc)) from exc

    headers = {}
    if download:
        headers["Content-Disposition"] = f'attachment; filename="{filename}"'
    else:
        headers["Content-Disposition"] = f'inline; filename="{filename}"'

    return FileResponse(
        path,
        media_type=content_type,
        filename=filename if download else None,
        headers=headers,
    )


@router.post("/calls/{interaction_id}/transcribe", response_model=CallHistoryItem)
def transcribe_call(
    interaction_id: int,
    background_tasks: BackgroundTasks,
    wait: bool = Query(False),
    db: Session = Depends(get_db),
):
    """Generate or refresh closed captions for a recorded call."""
    from db.models import Channel, Interaction

    interaction = db.get(Interaction, interaction_id)
    if not interaction or interaction.channel != Channel.phone:
        raise HTTPException(404, "Call not found")

    current = calls_module.call_interaction_to_dict(db, interaction)
    if not current.get("recording_available"):
        raise HTTPException(400, "No recording available for this call yet")

    if wait:
        try:
            result = calls_module.transcribe_call(db, interaction_id=interaction_id)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        except Exception as exc:
            raise HTTPException(502, str(exc)) from exc
        return CallHistoryItem(**result)

    if (current.get("transcript_status") or "").lower() == "processing":
        return CallHistoryItem(**current)

    background_tasks.add_task(_transcribe_in_background, interaction_id)
    current["transcript_status"] = "processing"
    current["transcript_error"] = None
    return CallHistoryItem(**current)


@router.post("/leads/{lead_id}/call", response_model=CallInitiateResponse)
def initiate_lead_call(
    lead_id: int,
    payload: CallInitiateRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    from modules.buyers import get_buyer
    from modules import activity as activity_module

    _require_lead_access(db, user, lead_id)
    if not get_buyer(db, lead_id):
        raise HTTPException(404, "Lead not found")
    try:
        result = calls_module.initiate_lead_call(
            db,
            buyer_id=lead_id,
            contact_id=payload.contact_id,
            phone=payload.phone,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    try:
        from modules import ai_mode as ai_mode_module

        company = ai_mode_module._resolve_call_company_name(
            db,
            company_name=result.get("company_name"),
            buyer_id=lead_id,
            interaction_id=result.get("id"),
        )
        contact_name = result.get("contact_name") or "contact"
        phone = result.get("lead_phone") or ""
        activity_module.log_activity(
            db,
            user_id=user.id,
            activity_type=activity_module.CALL_LOGGED,
            title="Call logged",
            summary=f"Called {company} ({contact_name}" + (f", {phone}" if phone else "") + ")",
            entity_type="interaction",
            entity_id=result.get("id"),
            details={"buyer_id": lead_id, "company_name": company},
        )

        ai_mode_module.record_call_activity(
            db,
            user_id=user.id,
            company_name=company,
            buyer_id=lead_id,
            interaction_id=result.get("id"),
            user_label=user.username,
        )
    except Exception:  # noqa: BLE001
        pass
    return CallInitiateResponse(**result)


@router.post("/calls/dial", response_model=CallInitiateResponse)
def initiate_manual_call(
    payload: ManualCallRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    from modules import activity as activity_module

    try:
        result = calls_module.initiate_manual_call(
            db,
            phone=payload.phone,
            contact_name=payload.contact_name,
            country=payload.country,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    try:
        from modules import ai_mode as ai_mode_module

        company = ai_mode_module._resolve_call_company_name(
            db,
            company_name=result.get("company_name"),
            buyer_id=result.get("buyer_id"),
            interaction_id=result.get("id"),
        )
        contact_name = result.get("contact_name") or payload.contact_name or "contact"
        phone = result.get("lead_phone") or payload.phone
        activity_module.log_activity(
            db,
            user_id=user.id,
            activity_type=activity_module.CALL_LOGGED,
            title="Call logged",
            summary=f"Called {company} ({contact_name}, {phone})",
            entity_type="interaction",
            entity_id=result.get("id"),
            details={"buyer_id": result.get("buyer_id"), "company_name": company},
        )

        ai_mode_module.record_call_activity(
            db,
            user_id=user.id,
            company_name=company,
            buyer_id=result.get("buyer_id"),
            interaction_id=result.get("id"),
            user_label=user.username,
        )
    except Exception:  # noqa: BLE001
        pass
    return CallInitiateResponse(**result)


webhooks_router = APIRouter(prefix="/webhooks/twilio", tags=["twilio-webhooks"])


def _twiml_response(xml: str) -> Response:
    # text/xml is what Twilio's debugger expects most reliably.
    return Response(content=xml, media_type="text/xml")


@webhooks_router.post("/voice/client-dial")
async def twilio_client_dial(request: Request):
    """TwiML: browser client connects → dial the lead directly.

    Must always return valid TwiML — any non-XML / 5xx makes Twilio play
    “An application error has occurred” and the SDK reports 31005.
    """
    import logging

    from db.session import SessionLocal
    from integrations.voice_client import normalize_e164
    from modules import calls as calls_module

    log = logging.getLogger("twilio.webhook")
    try:
        try:
            params = await _twilio_form(request)
        except HTTPException as exc:
            if exc.status_code == 403:
                log.warning("client-dial signature rejected")
                return _twiml_response(
                    voice_client.say_twiml(
                        "Webhook signature check failed. "
                        "Confirm TWILIO_AUTH_TOKEN and TWILIO_WEBHOOK_BASE_URL on Railway "
                        "match the TwiML App voice URL."
                    )
                )
            raise

        interaction_id = (
            params.get("interaction_id")
            or params.get("InteractionId")
            or request.query_params.get("interaction_id")
        )
        iid = 0
        if interaction_id:
            try:
                iid = int(str(interaction_id))
            except ValueError:
                iid = 0

        def _param_phone(*keys: str) -> str | None:
            for key in keys:
                raw = params.get(key) or request.query_params.get(key)
                if not raw:
                    continue
                text = str(raw).strip()
                # Skip Twilio reserved IDs / client identities mistaken for To.
                if text.startswith(("AP", "PN", "CA", "MG", "SK", "client:")):
                    continue
                normalized = normalize_e164(text)
                if normalized:
                    return normalized
            return None

        # Prefer the phone prepared at dial time (interaction), then SDK params.
        lead_phone: str | None = None
        if iid:
            import asyncio

            from fastapi.concurrency import run_in_threadpool

            def _lookup_prepared_phone() -> str | None:
                db = SessionLocal()
                try:
                    return calls_module.get_prepared_dial_phone(db, iid)
                finally:
                    db.close()

            # Worker thread + time limit: a dead DB connection must never block the event loop
            # (it froze the whole server for ~70s). On timeout fall back to the SDK's own params.
            try:
                lead_phone = await asyncio.wait_for(
                    run_in_threadpool(_lookup_prepared_phone), timeout=8.0
                )
            except Exception as exc:  # noqa: BLE001
                log.warning("client-dial prepared phone lookup failed: %s", exc)
        if not lead_phone:
            lead_phone = _param_phone(
                "leadPhone",
                "lead_phone",
                "To",
                "to",
                "Called",
            )

        if not lead_phone:
            log.warning(
                "client-dial missing dial target iid=%s keys=%s",
                iid,
                sorted(params.keys()),
            )
            return _twiml_response(
                voice_client.say_twiml("Missing lead number for this call.")
            )

        xml = voice_client.client_dial_twiml(str(lead_phone), iid)
        log.info(
            "client-dial ok to=%s interaction_id=%s twiml_bytes=%s",
            str(lead_phone)[-4:],
            iid,
            len(xml),
        )
        return _twiml_response(xml)
    except Exception as exc:  # noqa: BLE001
        log.exception("client-dial failed: %s", exc)
        return _twiml_response(
            voice_client.say_twiml(
                "The dial webhook failed on the server. Check Railway logs and Twilio debugger."
            )
        )


@webhooks_router.post("/voice/status")
async def twilio_call_status(request: Request):
    """Dial action / status callback — always returns valid TwiML so Twilio never errors with 12300."""
    import logging

    from sqlalchemy.exc import TimeoutError as SATimeoutError

    try:
        form = await _twilio_form(request)
    except HTTPException:
        return _twiml_response("<Response><Hangup/></Response>")

    interaction_id = request.query_params.get("interaction_id")
    if not interaction_id:
        return _twiml_response("<Response><Hangup/></Response>")

    try:
        iid = int(interaction_id)
    except ValueError:
        return _twiml_response("<Response><Hangup/></Response>")

    try:
        attempt = int(request.query_params.get("attempt") or "1")
    except ValueError:
        attempt = 1

    # Dial action webhook uses DialCallStatus; parent call uses CallStatus
    status = str(
        form.get("DialCallStatus") or form.get("CallStatus") or "unknown"
    )
    duration = str(form.get("DialCallDuration") or form.get("CallDuration") or "") or None
    call_sid = str(form.get("CallSid") or "") or None
    dial_status = str(form.get("DialCallStatus") or "").lower()

    def _handle_status() -> str:
        """All the DB work, returned as TwiML. Runs in a worker thread (never on the event loop)."""
        db = SessionLocal()
        try:
            calls_module.update_call_status(
                db,
                interaction_id=iid,
                call_status=status,
                call_duration=duration,
                call_sid=call_sid,
            )
            # Helpful spoken error when PSTN dial never connected (trial / geo / invalid).
            if dial_status == "failed":
                return voice_client.say_twiml(
                    "Could not connect this number. If Twilio is on a trial account, "
                    "verify the destination number under Verified Caller IDs, or upgrade "
                    "the account. Also enable the country under Voice Geographic Permissions."
                )

            # Hang up after ~4 rings (16s), then Dial again until answered or max attempts.
            # If the callee hangs up / declines early, DialCallStatus is canceled/busy —
            # that ends this attempt immediately (Twilio does not wait out the remaining timeout).
            no_connect = dial_status in {
                "no-answer",
                "busy",
                "canceled",
                "cancelled",
            }
            if no_connect and attempt < voice_client.max_ring_attempts():
                phone = calls_module.get_prepared_dial_phone(db, iid)
                if phone:
                    return voice_client.client_dial_twiml(
                        str(phone),
                        iid,
                        attempt=attempt + 1,
                    )

            return "<Response><Hangup/></Response>"
        finally:
            db.close()

    import asyncio

    from fastapi.concurrency import run_in_threadpool

    # This handler is async, so the blocking DB calls MUST NOT run on the event loop: a dead
    # Supabase connection blocked here for ~70s and froze every request (30 Sep / 1 Oct).
    try:
        xml = await asyncio.wait_for(run_in_threadpool(_handle_status), timeout=12.0)
        return _twiml_response(xml)
    except SATimeoutError:
        logging.getLogger("twilio.webhook").warning(
            "voice/status DB pool busy interaction_id=%s status=%s", iid, status
        )
        return _twiml_response("<Response><Hangup/></Response>")
    except asyncio.TimeoutError:
        logging.getLogger("twilio.webhook").warning(
            "voice/status timed out interaction_id=%s status=%s", iid, status
        )
        return _twiml_response("<Response><Hangup/></Response>")
    except Exception as exc:  # noqa: BLE001
        logging.getLogger("twilio.webhook").exception("voice/status failed: %s", exc)
        return _twiml_response("<Response><Hangup/></Response>")


@webhooks_router.post("/voice/recording")
async def twilio_call_recording(
    request: Request,
    background_tasks: BackgroundTasks,
):
    """Twilio posts here when a Dial recording is ready."""
    try:
        form = await _twilio_form(request)
    except HTTPException:
        return _twiml_response("<Response/>")

    interaction_id = request.query_params.get("interaction_id")
    if not interaction_id:
        return _twiml_response("<Response/>")

    try:
        iid = int(interaction_id)
    except ValueError:
        return _twiml_response("<Response/>")

    recording_sid = str(form.get("RecordingSid") or "")
    recording_url = str(form.get("RecordingUrl") or "")
    recording_status = str(form.get("RecordingStatus") or "completed")
    recording_duration = str(form.get("RecordingDuration") or "") or None

    if not recording_sid or not recording_url:
        return _twiml_response("<Response/>")

    from fastapi.concurrency import run_in_threadpool

    def _save_recording():
        # Downloads the audio over HTTP and writes the DB: never on the event loop.
        rec_db = SessionLocal()
        try:
            return calls_module.save_call_recording(
                rec_db,
                interaction_id=iid,
                recording_sid=recording_sid,
                recording_url=recording_url,
                recording_status=recording_status,
                recording_duration=recording_duration,
            )
        finally:
            rec_db.close()

    media = await run_in_threadpool(_save_recording)
    if media and media.get("local_path") and media.get("transcript_status") == "pending":
        background_tasks.add_task(_transcribe_in_background, iid)
    return _twiml_response("<Response/>")


@webhooks_router.post("/ai-agent/status")
async def twilio_ai_agent_status(request: Request):
    """Twilio status callback for Sara/Rayan outbound calls — follow-up + next in queue."""
    try:
        form = await _twilio_form(request)
    except HTTPException:
        return {"ok": True}
    task_id_raw = request.query_params.get("task_id")
    try:
        task_id = int(task_id_raw) if task_id_raw else None
    except ValueError:
        task_id = None
    ring_attempt_raw = request.query_params.get("ring_attempt")
    try:
        ring_attempt = int(ring_attempt_raw) if ring_attempt_raw else None
    except ValueError:
        ring_attempt = None
    status = str(form.get("CallStatus") or form.get("DialCallStatus") or "")
    duration = form.get("CallDuration") or form.get("DialCallDuration")
    call_sid = str(form.get("CallSid") or "") or None
    from api import ai_sales_agent as asa

    from fastapi.concurrency import run_in_threadpool
    await run_in_threadpool(
        asa.handle_ai_call_status,
        task_id=task_id,
        call_sid=call_sid,
        status=status,
        duration=duration,
        ended_reason=status,
        ring_attempt=ring_attempt,
    )
    return {"ok": True}


@webhooks_router.post("/ai-agent/intro")
async def twilio_ai_agent_intro(request: Request):
    """Initial spoken greeting when AI agent calls buyer, prompting for speech response."""
    from integrations.voice_client import resolve_call_gender

    persona = request.query_params.get("persona", "female")
    voice_gender = request.query_params.get("voice_gender")
    name = request.query_params.get("name", "there")
    gender = resolve_call_gender(persona, voice_gender=voice_gender)
    is_female = gender == "female"
    from integrations.voice_client import resolve_call_agent_name

    agent_name = resolve_call_agent_name(persona, is_female=is_female)
    voice = "Polly.Joanna-Neural" if is_female else "Polly.Matthew-Neural"

    greeting = f"Hello {name}, this is {agent_name} calling from Kafi Commodities. How are you doing today?"
    
    respond_url = ""
    if settings.twilio_webhook_base_url:
        import urllib.parse
        q_persona = urllib.parse.quote(persona)
        q_gender = urllib.parse.quote(gender)
        respond_url = voice_client.webhook_url(
            f"/api/webhooks/twilio/ai-agent/respond?persona={q_persona}&voice_gender={q_gender}"
        )
    else:
        respond_url = f"/api/webhooks/twilio/ai-agent/respond?persona={persona}&voice_gender={gender}"

    xml = voice_client.ai_gather_twiml(greeting, respond_url, voice=voice)
    return _twiml_response(xml)


@webhooks_router.post("/ai-agent/respond")
async def twilio_ai_agent_respond(request: Request):
    """Processes buyer's spoken input via Gemini AI and responds interactively."""
    from integrations.voice_client import resolve_call_gender, resolve_call_agent_name

    persona = request.query_params.get("persona", "female")
    voice_gender = request.query_params.get("voice_gender")
    gender = resolve_call_gender(persona, voice_gender=voice_gender)
    is_female = gender == "female"
    agent_name = resolve_call_agent_name(persona, is_female=is_female)
    voice = "Polly.Joanna-Neural" if is_female else "Polly.Matthew-Neural"

    params = await request.form()
    speech_result = (params.get("SpeechResult") or "").strip()

    if not speech_result:
        xml = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<Response>'
            f'<Say voice="{voice}">I did not catch that. Thank you for speaking with Kafi Commodities and have a wonderful day!</Say>'
            '<Hangup/>'
            '</Response>'
        )
        return _twiml_response(xml)

    # Check if buyer wants to conclude call
    lower_speech = speech_result.lower()
    if any(k in lower_speech for k in ["bye", "goodbye", "not interested", "stop calling", "hang up", "no thank you", "no thanks"]):
        xml = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<Response>'
            f'<Say voice="{voice}">Thank you for your time. Have a wonderful day!</Say>'
            '<Hangup/>'
            '</Response>'
        )
        return _twiml_response(xml)

    # Generate dynamic conversational response via Gemini AI
    try:
        from modules.llm_client import llm_client
        prompt = (
            f"You are {agent_name}, a friendly and sharp B2B AI Sales Executive for Kafi Commodities. "
            "Kafi Commodities exports white rice, sesame seeds, corn, spices, and edible oils globally. "
            f"You are on a live phone call with a client. The client just said: \"{speech_result}\". "
            "Respond naturally in 1 to 2 clear, spoken sentences to answer their question, mention our commodities if relevant, and keep the conversation going smoothly. "
            "Do NOT use markdown, emojis, bullet points, or special characters."
        )
        # llm_client.generate is blocking (tries every model in turn), so run it in a
        # worker thread with a cap; otherwise a slow Gemini stalls the whole server.
        from fastapi.concurrency import run_in_threadpool
        import asyncio

        ai_reply = await asyncio.wait_for(run_in_threadpool(llm_client.generate, prompt), timeout=7.0)
        ai_reply = (ai_reply or "").strip().replace("*", "").replace("#", "")
        if not ai_reply:
            ai_reply = "We offer premium quality white rice, sesame seeds, and agricultural commodities. Are you currently importing any of these items?"
    except Exception as exc:
        print(f"AI response generation error: {exc}", flush=True)
        ai_reply = "We specialize in premium white rice, sesame seeds, and edible oils with competitive FOB rates. Are you currently sourcing these for your market?"

    respond_url = ""
    if settings.twilio_webhook_base_url:
        import urllib.parse
        q_persona = urllib.parse.quote(persona)
        q_gender = urllib.parse.quote(gender)
        respond_url = voice_client.webhook_url(
            f"/api/webhooks/twilio/ai-agent/respond?persona={q_persona}&voice_gender={q_gender}"
        )
    else:
        respond_url = f"/api/webhooks/twilio/ai-agent/respond?persona={persona}&voice_gender={gender}"

    xml = voice_client.ai_gather_twiml(ai_reply, respond_url, voice=voice)
    return _twiml_response(xml)
