"""Download, store, and transcribe Twilio call recordings."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import httpx
from sqlalchemy.orm import Session

from config import settings
from db.models import Channel, Interaction

logger = logging.getLogger(__name__)

_BACKEND_DIR = Path(__file__).resolve().parent.parent
STORAGE_DIR = _BACKEND_DIR / "storage" / "call_recordings"
CALL_RECORDING_TYPE = "call_recording"
AI_TRAINING_TYPE = "ai_training"


def _ensure_storage() -> None:
    STORAGE_DIR.mkdir(parents=True, exist_ok=True)


def get_call_media(interaction: Interaction) -> dict[str, Any] | None:
    attachments = interaction.attachments or []
    if not isinstance(attachments, list):
        return None
    for item in attachments:
        if isinstance(item, dict) and item.get("type") == CALL_RECORDING_TYPE:
            return item
    return None


def get_ai_training_selected(interaction: Interaction) -> bool:
    """Opt-in Train Sara & Rayan flag — stored in attachments JSON (no schema lock)."""
    attachments = interaction.attachments or []
    if not isinstance(attachments, list):
        return False
    for item in attachments:
        if isinstance(item, dict) and item.get("type") == AI_TRAINING_TYPE:
            return bool(item.get("selected"))
    return False


def set_ai_training_selected_flag(interaction: Interaction, selected: bool) -> None:
    attachments = list(interaction.attachments or [])
    if not isinstance(attachments, list):
        attachments = []
    kept = [
        item
        for item in attachments
        if not (isinstance(item, dict) and item.get("type") == AI_TRAINING_TYPE)
    ]
    if selected:
        kept.append({"type": AI_TRAINING_TYPE, "selected": True})
    interaction.attachments = kept


def _set_call_media(interaction: Interaction, media: dict[str, Any]) -> None:
    from sqlalchemy.orm.attributes import flag_modified

    attachments = list(interaction.attachments or [])
    if not isinstance(attachments, list):
        attachments = []
    kept = [
        item
        for item in attachments
        if not (isinstance(item, dict) and item.get("type") == CALL_RECORDING_TYPE)
    ]
    kept.append(media)
    interaction.attachments = kept
    flag_modified(interaction, "attachments")


def public_call_media(media: dict[str, Any] | None, *, interaction_id: int) -> dict[str, Any]:
    if not media:
        return {
            "recording_available": False,
            "recording_sid": None,
            "recording_duration_seconds": None,
            "recording_url": None,
            "download_url": None,
            "transcript": None,
            "transcript_status": None,
            "transcript_error": None,
        }
    available = bool(media.get("local_path") or media.get("recording_url"))
    return {
        "recording_available": available,
        "recording_sid": media.get("recording_sid"),
        "recording_duration_seconds": media.get("duration_seconds"),
        "recording_url": f"/calls/{interaction_id}/recording" if available else None,
        "download_url": f"/calls/{interaction_id}/recording?download=1" if available else None,
        "transcript": media.get("transcript"),
        "transcript_status": media.get("transcript_status"),
        "transcript_error": media.get("transcript_error"),
    }


_ATTEMPTED_BACKFILLS: dict[str, float] = {}
_BACKFILL_COOLDOWN_SECONDS = 300.0  # Do not re-poll Vapi for 5 minutes if already tried


def download_public_recording(recording_url: str, recording_sid: str) -> tuple[Path, str]:
    """Download a publicly reachable recording URL (Vapi/S3) without Twilio auth."""
    _ensure_storage()
    url = (recording_url or "").strip()
    if not url:
        raise ValueError("Empty recording URL")
    with httpx.Client(timeout=15.0, follow_redirects=True) as client:
        response = client.get(url)
        response.raise_for_status()
        data = response.content
        content_type = (response.headers.get("content-type") or "audio/mpeg").split(";")[0].strip()
    ext = "mp3"
    if "wav" in content_type or url.lower().endswith(".wav"):
        ext = "wav"
    elif "ogg" in content_type or url.lower().endswith(".ogg"):
        ext = "ogg"
    elif url.lower().endswith(".mp3"):
        ext = "mp3"
    safe_sid = "".join(ch for ch in (recording_sid or "vapi") if ch.isalnum() or ch in "-_")[:64] or "vapi"
    path = STORAGE_DIR / f"{safe_sid}.{ext}"
    path.write_bytes(data)
    return path, content_type or f"audio/{ext}"


def save_ai_call_media(
    db: Session,
    *,
    interaction_id: int,
    recording_url: str | None = None,
    recording_sid: str | None = None,
    duration_seconds: int | float | None = None,
    transcript: str | None = None,
) -> dict[str, Any] | None:
    """Attach Vapi (or other AI) recording + closed captions onto a phone Interaction."""
    interaction = db.get(Interaction, interaction_id)
    if not interaction or interaction.channel != Channel.phone:
        return None

    media = get_call_media(interaction) or {"type": CALL_RECORDING_TYPE}
    media["type"] = CALL_RECORDING_TYPE
    sid = (recording_sid or media.get("recording_sid") or f"ai-{interaction_id}").strip()
    media["recording_sid"] = sid
    if duration_seconds is not None:
        try:
            media["duration_seconds"] = int(float(duration_seconds))
        except (TypeError, ValueError):
            pass

    url = (recording_url or "").strip() or None
    if url:
        media["recording_url"] = url
        media["recording_status"] = "completed"

    text = (transcript or "").strip()
    if text:
        media["transcript"] = text[:20000]
        media["transcript_status"] = "ready"
        media["transcript_error"] = None
    elif media.get("recording_url") and (media.get("transcript_status") or "") != "ready":
        media["transcript_status"] = media.get("transcript_status") or "pending"

    if not media.get("local_path") and not media.get("recording_url") and not media.get("transcript"):
        return None

    _set_call_media(interaction, media)
    db.commit()
    db.refresh(interaction)

    # Download local copy asynchronously in background so DB connection is freed instantly!
    if url and not media.get("local_path"):
        import threading

        def _bg_download(target_url: str, target_sid: str, target_iid: int):
            try:
                if "api.twilio.com" in target_url.lower():
                    path, content_type = download_twilio_recording(target_url, target_sid)
                else:
                    path, content_type = download_public_recording(target_url, target_sid)
                from db.session import SessionLocal

                with SessionLocal() as bg_db:
                    attach_local_recording(
                        bg_db,
                        interaction_id=target_iid,
                        local_path=f"call_recordings/{path.name}",
                        content_type=content_type,
                    )
            except Exception as exc:
                logger.warning("Background local audio caching skipped for %s: %s", target_iid, exc)

        threading.Thread(
            target=_bg_download,
            args=(url, sid, int(interaction_id)),
            daemon=True,
        ).start()

    return media


def maybe_backfill_ai_call_media(db: Session, interaction: Interaction) -> dict[str, Any] | None:
    """If Call history has no recording yet, try once to pull it from Vapi by SID in content."""
    import re
    import time

    existing = get_call_media(interaction)
    if existing and (
        existing.get("local_path")
        or existing.get("recording_url")
        or (existing.get("transcript") or "").strip()
    ):
        return existing

    content = interaction.content or ""
    match = re.search(r"SID:\s*([A-Za-z0-9_-]+)", content)
    if not match:
        return existing
    sid = match.group(1).strip()
    if not sid or sid.startswith("CA"):
        return existing

    # Check cooldown cache so we do not spam Vapi on every list/poll query
    now = time.time()
    last_attempt = _ATTEMPTED_BACKFILLS.get(sid)
    if last_attempt and (now - last_attempt) < _BACKFILL_COOLDOWN_SECONDS:
        return existing
    _ATTEMPTED_BACKFILLS[sid] = now

    try:
        from integrations.voice_client import voice_client

        info = voice_client.fetch_outbound_status(sid)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Vapi media backfill status fetch failed for %s: %s", interaction.id, exc)
        return existing

    if not info.get("recording_url") and not info.get("call_transcript"):
        return existing

    try:
        return save_ai_call_media(
            db,
            interaction_id=int(interaction.id),
            recording_url=info.get("recording_url"),
            recording_sid=sid,
            duration_seconds=info.get("duration"),
            transcript=info.get("call_transcript"),
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("Vapi media backfill save failed for %s: %s", interaction.id, exc)
        return existing


def download_twilio_recording(recording_url: str, recording_sid: str) -> tuple[Path, str]:
    """Download a Twilio recording as MP3. Returns (local_path, content_type)."""
    if not settings.twilio_account_sid or not settings.twilio_auth_token:
        raise RuntimeError("Twilio credentials missing — cannot download recording")

    _ensure_storage()
    base = recording_url.rstrip("/")
    if base.endswith(".mp3") or base.endswith(".wav"):
        fetch_url = base
        ext = Path(base).suffix.lstrip(".") or "mp3"
    else:
        fetch_url = f"{base}.mp3"
        ext = "mp3"

    auth = (settings.twilio_account_sid, settings.twilio_auth_token)
    with httpx.Client(timeout=120.0, follow_redirects=True) as client:
        response = client.get(fetch_url, auth=auth)
        response.raise_for_status()
        data = response.content
        content_type = response.headers.get("content-type", f"audio/{ext}")

    filename = f"{recording_sid}.{ext}"
    path = STORAGE_DIR / filename
    path.write_bytes(data)
    return path, content_type


def attach_local_recording(
    db: Session,
    *,
    interaction_id: int,
    local_path: str,
    content_type: str,
) -> None:
    interaction = db.get(Interaction, interaction_id)
    if not interaction:
        return
    media = get_call_media(interaction) or {"type": CALL_RECORDING_TYPE}
    media["local_path"] = local_path
    media["content_type"] = content_type
    _set_call_media(interaction, media)
    db.commit()


def resolve_local_recording(media: dict[str, Any]) -> Path | None:
    local = media.get("local_path")
    if not local:
        return None
    rel = str(local).replace("\\", "/").lstrip("/")
    if rel.startswith("call_recordings/"):
        path = _BACKEND_DIR / "storage" / rel
    else:
        path = STORAGE_DIR / Path(rel).name
    return path if path.is_file() else None


def save_recording_from_webhook(
    db: Session,
    *,
    interaction_id: int,
    recording_sid: str,
    recording_url: str,
    recording_status: str,
    recording_duration: str | None = None,
) -> dict[str, Any] | None:
    interaction = db.get(Interaction, interaction_id)
    if not interaction or interaction.channel != Channel.phone:
        return None

    duration_seconds: int | None = None
    if recording_duration and str(recording_duration).isdigit():
        duration_seconds = int(recording_duration)

    media = get_call_media(interaction) or {
        "type": CALL_RECORDING_TYPE,
        "transcript_status": "pending",
    }
    media.update(
        {
            "type": CALL_RECORDING_TYPE,
            "recording_sid": recording_sid,
            "recording_url": recording_url,
            "recording_status": recording_status,
            "duration_seconds": duration_seconds,
        }
    )

    if recording_status.lower() == "completed" and recording_url:
        try:
            path, content_type = download_twilio_recording(recording_url, recording_sid)
            media["local_path"] = f"call_recordings/{path.name}"
            media["content_type"] = content_type
            if not media.get("transcript"):
                media["transcript_status"] = "pending"
        except Exception as exc:
            logger.exception("Failed to download Twilio recording %s", recording_sid)
            media["transcript_status"] = media.get("transcript_status") or "failed"
            media["transcript_error"] = f"Recording download failed: {exc}"

    _set_call_media(interaction, media)
    db.commit()
    db.refresh(interaction)
    return media


def transcribe_call_recording(db: Session, *, interaction_id: int) -> dict[str, Any]:
    interaction = db.get(Interaction, interaction_id)
    if not interaction or interaction.channel != Channel.phone:
        raise ValueError("Call not found")

    media = get_call_media(interaction)
    if not media:
        raise ValueError("No recording found for this call")

    path = resolve_local_recording(media)
    if not path and media.get("recording_url") and media.get("recording_sid"):
        path, content_type = download_twilio_recording(
            str(media["recording_url"]),
            str(media["recording_sid"]),
        )
        media["local_path"] = f"call_recordings/{path.name}"
        media["content_type"] = content_type

    if not path or not path.is_file():
        media["transcript_status"] = "failed"
        media["transcript_error"] = "Recording file is not available yet"
        _set_call_media(interaction, media)
        db.commit()
        raise ValueError("Recording file is not available yet")

    current_status = (media.get("transcript_status") or "").lower()
    if current_status == "ready" and (media.get("transcript") or "").strip():
        return media
    if current_status == "processing":
        raise ValueError("Closed captions are already being generated — check back shortly")

    media["transcript_status"] = "processing"
    media["transcript_error"] = None
    media["transcript"] = None
    _set_call_media(interaction, media)
    db.commit()

    try:
        from modules.llm_client import llm_client

        if not llm_client.enabled:
            raise RuntimeError(
                "Speech-to-text needs GEMINI_API_KEY in backend/.env to generate closed captions"
            )

        audio_bytes = path.read_bytes()
        mime = str(media.get("content_type") or "audio/mpeg")
        if "wav" in mime:
            mime_type = "audio/wav"
        elif "ogg" in mime:
            mime_type = "audio/ogg"
        else:
            mime_type = "audio/mpeg"

        duration_seconds = media.get("duration_seconds")
        if isinstance(duration_seconds, str) and duration_seconds.isdigit():
            duration_seconds = int(duration_seconds)

        transcript = llm_client.transcribe_audio(
            audio_bytes,
            mime_type=mime_type,
            duration_seconds=int(duration_seconds) if duration_seconds else None,
            hint=(
                "This is a sales phone call between a Kafi Commodities sales agent "
                "and a buyer/client. Produce a full word-for-word transcript."
            ),
        )
        media["transcript"] = transcript.strip()
        media["transcript_status"] = "ready"
        media["transcript_error"] = None
    except Exception as exc:
        logger.exception("Transcription failed for interaction %s", interaction_id)
        media["transcript_status"] = "failed"
        media["transcript_error"] = str(exc)
        _set_call_media(interaction, media)
        db.commit()
        raise

    _set_call_media(interaction, media)
    db.commit()
    db.refresh(interaction)

    try:
        from modules.personalized_followups import maybe_generate_for_interaction

        maybe_generate_for_interaction(db, interaction_id)
    except Exception:  # noqa: BLE001
        logger.exception(
            "Personalized follow-up draft generation failed for interaction %s",
            interaction_id,
        )

    return media
