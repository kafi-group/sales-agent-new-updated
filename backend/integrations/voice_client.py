"""Twilio Programmable Voice — browser calling from the sales dashboard."""

from __future__ import annotations

import re
import threading
from typing import Any, Literal

from config import settings
from modules.ai_agent_persona import persona_display_name, persona_gender


def resolve_call_gender(
    persona: str | None,
    *,
    voice_gender: str | None = None,
) -> Literal["female", "male"]:
    """Map agent persona → TTS gender. Sara → female; Rayan → male (everywhere)."""
    gender_label = None
    display_name = None
    voice = None
    try:
        from api import ai_sales_agent as asa

        runner = asa._get_runner(str(persona or ""))
        if isinstance(runner, dict):
            gender_label = str(runner.get("gender_label") or "") or None
            display_name = str(runner.get("display_name") or "") or None
            voice = str(runner.get("voice") or "") or None
    except Exception:
        pass
    return persona_gender(
        persona,
        voice_gender=voice_gender,
        gender_label=gender_label,
        display_name=display_name,
        voice=voice,
    )


def resolve_call_agent_name(persona: str | None, *, is_female: bool | None = None) -> str:
    display_name = None
    gender_label = None
    voice = None
    try:
        from api import ai_sales_agent as asa

        runner = asa._get_runner(str(persona or ""))
        if isinstance(runner, dict):
            display_name = str(runner.get("display_name") or "") or None
            gender_label = str(runner.get("gender_label") or "") or None
            voice = str(runner.get("voice") or "") or None
    except Exception:
        pass
    name = persona_display_name(
        persona, display_name=display_name, gender_label=gender_label, voice=voice
    )
    if name not in {"Sara", "Rayan"} and is_female is not None:
        return "Sara" if is_female else "Rayan"
    return name


_FOURTH_RING_SECONDS = 16  # ~4s per ring × 4 rings per dial attempt
_DEFAULT_MAX_RING_ATTEMPTS = 10  # 16s → hangup → 16s again … until answer or this cap
_HARD_MAX_RING_ATTEMPTS = 20
# Carrier still setting up the call — never hang up solely because of these.
_PRE_RING_STATUSES = {
    "queued",
    "connecting",
    "initiated",
    "scheduled",
}
# Handset is actually ringing (safe to apply ring budget).
_RINGING_STATUSES = {
    "ringing",
    "dialing",
}
# Still "live" for auto-redial decisions (pre-ring + ringing).
_LIVE_DIAL_STATUSES = _PRE_RING_STATUSES | _RINGING_STATUSES
_ANSWERED_STATUSES = {
    "in-progress",
    "in_progress",
    "answered",
    "forwarding",
}
_NO_CONNECT_STATUSES = {
    "no-answer",
    "no_answer",
    "busy",
    "canceled",
    "cancelled",
    "failed",
}


def normalize_e164(phone: str | None) -> str | None:
    """Normalize a phone string to E.164 (+country + number).

    Handles common Pakistan local mobiles (03XXXXXXXXX / 3XXXXXXXXX → +923…).
    """
    if not phone:
        return None
    raw = phone.strip()
    if not raw or raw.lower() in {"not found", "n/a", "na", "none", "-"}:
        return None

    cleaned = re.sub(r"[^\d+]", "", raw)
    if cleaned.startswith("00"):
        cleaned = f"+{cleaned[2:]}"

    # Digits only (no leading +) for regional heuristics.
    bare = cleaned[1:] if cleaned.startswith("+") else cleaned

    # Pakistan mobile: national 03XXXXXXXXX (11) or 3XXXXXXXXX (10) → +923…
    if not cleaned.startswith("+"):
        if re.fullmatch(r"03\d{9}", bare):
            cleaned = f"+92{bare[1:]}"
        elif re.fullmatch(r"3\d{9}", bare):
            cleaned = f"+92{bare}"
        elif re.fullmatch(r"92\d{10}", bare):
            cleaned = f"+{bare}"
        else:
            cleaned = f"+{bare}"
    elif cleaned.startswith("+0") and re.fullmatch(r"\+03\d{9}", cleaned):
        # Accidental +0307… from naive prefixing
        cleaned = f"+92{cleaned[2:]}"

    if re.fullmatch(r"\+\d{8,15}", cleaned):
        return cleaned
    return None


def mask_phone(phone: str | None) -> str | None:
    """Mask a phone number for display (e.g. +971****4567)."""
    normalized = normalize_e164(phone)
    if not normalized or len(normalized) < 8:
        return None
    return f"{normalized[:4]}****{normalized[-4:]}"


LANGUAGE_CONFIGS: dict[str, dict[str, str]] = {
    "en": {
        "name": "English",
        "voice_female": "en-US-JennyNeural",
        "voice_male": "en-US-GuyNeural",
        "greeting": "Hello, am I speaking with {c_name}?",
        "instruction": (
            "Start the call in English. The customer's phone country code does NOT determine language — "
            "a US number may speak French, Arabic, Urdu, etc. Mirror whatever language they use."
        ),
    },
    "ur": {
        "name": "Urdu",
        "voice_female": "ur-PK-UzmaNeural",
        "voice_male": "ur-PK-AsadNeural",
        "greeting": "سلام! کیا میری بات {c_name} سے ہو رہی ہے؟",
        "instruction": (
            "Start the call in Urdu (اردو) and STAY in Urdu unless the customer clearly asks "
            "to switch (e.g. 'speak English') or clearly speaks another ALLOWED language. "
            "Never switch to Chinese, Japanese, or Arabic because of noisy transcription."
        ),
    },
    "fr": {
        "name": "French",
        "voice_female": "fr-FR-DeniseNeural",
        "voice_male": "fr-FR-HenriNeural",
        "greeting": "Bonjour, est-ce que je parle à {c_name} ?",
        "instruction": (
            "Start in French. If they switch to English, Arabic, Urdu, or another language mid-call, "
            "continue in their language. Do not assume English from a US or other phone number."
        ),
    },
    "ar": {
        "name": "Arabic",
        "voice_female": "ar-SA-ZariyahNeural",
        "voice_male": "ar-SA-HamedNeural",
        "greeting": "مرحباً، هل أتحدث مع {c_name}؟",
        "instruction": (
            "Start in formal B2B Arabic. If they switch language mid-call (English, French, Urdu, etc.), "
            "continue in their language. Phone country code does not decide the language."
        ),
    },
    "de": {
        "name": "German",
        "voice_female": "de-DE-KatjaNeural",
        "voice_male": "de-DE-ConradNeural",
        "greeting": "Hallo, spreche ich mit {c_name}?",
        "instruction": (
            "Start in German. If the customer switches language mid-call, continue in their language. "
            "Do not infer language from the phone number."
        ),
    },
    "ru": {
        "name": "Russian",
        "voice_female": "ru-RU-SvetlanaNeural",
        "voice_male": "ru-RU-DmitryNeural",
        "greeting": "Здравствуйте, я говорю с {c_name}?",
        "instruction": (
            "Start in Russian. If the customer switches language mid-call, continue in their language. "
            "Do not infer language from the phone number."
        ),
    },
    "zh": {
        "name": "Chinese",
        "voice_female": "zh-CN-XiaoxiaoNeural",
        "voice_male": "zh-CN-YunxiNeural",
        "greeting": "您好，请问是 {c_name} 先生/女士吗？",
        "instruction": (
            "Start in Mandarin Chinese. If the customer switches language mid-call, continue in their language. "
            "Do not infer language from the phone number."
        ),
    },
    "ja": {
        "name": "Japanese",
        "voice_female": "ja-JP-NanamiNeural",
        "voice_male": "ja-JP-KeitaNeural",
        "greeting": "こんにちは、{c_name}様でしょうか？",
        "instruction": (
            "Start in Japanese. If the customer switches language mid-call, continue in their language. "
            "Do not infer language from the phone number."
        ),
    },
    "fil": {
        "name": "Filipino",
        "voice_female": "fil-PH-BlessicaNeural",
        "voice_male": "fil-PH-AngeloNeural",
        "greeting": "Hello po, kausap ko ba si {c_name}?",
        "instruction": (
            "Start in Filipino (Tagalog). If the customer switches language mid-call, continue in their language. "
            "Do not infer language from the phone number."
        ),
    },
}

_SWITCHABLE_LANGUAGES = (
    "English, Urdu (اردو), Hindi, French (Français), Arabic (العربية), German (Deutsch), "
    "Russian (Русский), Mandarin Chinese (中文), Japanese (日本語), Filipino/Tagalog, "
    "and natural mixes (e.g. English+Urdu, English+French)"
)

# Deepgram / Vapi language codes for each UI language key.
_TRANSCRIBER_CODES: dict[str, str] = {
    "en": "en",
    "ur": "ur",
    "fr": "fr",
    "ar": "ar",
    "de": "de",
    "ru": "ru",
    "zh": "zh",
    "ja": "ja",
    "fil": "tl",
}

_ALL_LANGUAGE_KEYS = tuple(LANGUAGE_CONFIGS.keys())


def normalize_allowed_languages(
    start_language: str | None,
    allowed: list[str] | None,
) -> list[str]:
    """Start language is always included; unknown codes dropped."""
    start = (start_language or "en").strip().lower()
    if start not in LANGUAGE_CONFIGS:
        start = "en"
    raw = allowed if isinstance(allowed, list) else list(_ALL_LANGUAGE_KEYS)
    out: list[str] = []
    for code in raw:
        c = str(code or "").strip().lower()
        if c in LANGUAGE_CONFIGS and c not in out:
            out.append(c)
    if start not in out:
        out.insert(0, start)
    return out or [start]


def build_language_prompt_block(start_language: str, allowed: list[str]) -> str:
    """Strict language rules — stop random Chinese/Japanese/Arabic drift."""
    start = start_language if start_language in LANGUAGE_CONFIGS else "en"
    allowed_clean = normalize_allowed_languages(start, allowed)
    start_name = LANGUAGE_CONFIGS[start]["name"]
    allowed_names = ", ".join(LANGUAGE_CONFIGS[c]["name"] for c in allowed_clean)
    base = LANGUAGE_CONFIGS[start]["instruction"]
    return (
        f"STARTING LANGUAGE: {start_name} ({start}).\n"
        f"{base}\n\n"
        f"ALLOWED LANGUAGES FOR THIS CALL (only these): {allowed_names}.\n"
        "CRITICAL LANGUAGE RULES:\n"
        f"1. Open the call in {start_name} and KEEP speaking {start_name} by default.\n"
        "2. Only switch if the customer clearly speaks another ALLOWED language above.\n"
        "3. Never switch to Chinese, Japanese, Arabic, or any other language that is NOT in the allowed list — "
        "even if speech recognition guesses wrong.\n"
        f"4. If you are unsure what language they used, stay in {start_name}. Do not invent a new language.\n"
        f"5. If they ask to speak English (or another allowed language), switch then and stay there until they change again.\n"
    )


def resolve_transcriber_language(start_language: str, allowed: list[str]) -> str:
    """Pick Deepgram language. Lock high-confusion starts (Urdu/Arabic/CJK) to stop random hops."""
    start = (start_language or "en").strip().lower()
    if start not in LANGUAGE_CONFIGS:
        start = "en"
    allowed_clean = normalize_allowed_languages(start, allowed)
    if len(allowed_clean) == 1:
        return _TRANSCRIBER_CODES.get(allowed_clean[0], "en")
    # multi STT often mislabels Urdu as Chinese/Japanese/Arabic — lock to start instead.
    if start in {"ur", "ar", "zh", "ja", "ru"}:
        return _TRANSCRIBER_CODES.get(start, "en")
    return "multi"


class VoiceClient:
    @property
    def is_configured(self) -> bool:
        return bool(
            settings.twilio_account_sid
            and settings.twilio_auth_token
            and settings.twilio_phone_number
        )

    @property
    def webhooks_ready(self) -> bool:
        return self.is_configured and bool(settings.twilio_webhook_base_url)

    @property
    def browser_ready(self) -> bool:
        return bool(
            self.webhooks_ready
            and settings.twilio_api_key_sid
            and settings.twilio_api_key_secret
            and settings.twilio_twiml_app_sid
        )

    def webhook_url(self, path: str) -> str:
        base = (settings.twilio_webhook_base_url or "").rstrip("/")
        if not base:
            raise RuntimeError(
                "TWILIO_WEBHOOK_BASE_URL is not set — Twilio needs a public HTTPS URL "
                "(use ngrok for local dev, or your Railway/production API URL)."
            )
        if not path.startswith("/"):
            path = f"/{path}"
        return f"{base}{path}"

    def sync_twiml_app_voice_url(self) -> bool:
        """Ensure the Twilio TwiML App Voice URL points to the live server."""
        if not self.browser_ready or not settings.twilio_twiml_app_sid:
            return False
        expected_url = self.webhook_url("/api/webhooks/twilio/voice/client-dial")
        try:
            from twilio.rest import Client
            client = Client(settings.twilio_account_sid, settings.twilio_auth_token)
            app = client.applications.get(settings.twilio_twiml_app_sid).fetch()
            if app.voice_url != expected_url:
                client.applications.get(settings.twilio_twiml_app_sid).update(
                    voice_url=expected_url,
                    voice_method="POST",
                )
                print(f"Twilio TwiML App {settings.twilio_twiml_app_sid} voice_url updated to {expected_url}", flush=True)
            return True
        except Exception as exc:
            print(f"WARNING: failed to sync Twilio TwiML App Voice URL: {exc}", flush=True)
            return False

    def validate_webhook(
        self,
        url: str,
        params: dict[str, str],
        signature: str,
        *,
        alternate_urls: list[str] | None = None,
    ) -> bool:
        if not settings.twilio_validate_webhooks:
            return True
        if not settings.twilio_auth_token or not signature:
            return False
        from twilio.request_validator import RequestValidator

        validator = RequestValidator(settings.twilio_auth_token.strip())
        candidates: list[str] = []
        for candidate in [url, *(alternate_urls or [])]:
            raw = (candidate or "").strip()
            if not raw:
                continue
            # Twilio signs the exact URL it requested; proxies often differ by slash/scheme.
            for variant in (raw, raw.rstrip("/"), raw.replace("http://", "https://", 1)):
                if variant and variant not in candidates:
                    candidates.append(variant)

        for candidate in candidates:
            try:
                if validator.validate(candidate, params, signature):
                    return True
            except Exception:
                continue
        return False

    def create_access_token(self, *, identity: str = "sales-agent") -> str:
        if not self.browser_ready:
            raise RuntimeError(
                "Browser calling is not configured. Set TWILIO_API_KEY_SID, "
                "TWILIO_API_KEY_SECRET, and TWILIO_TWIML_APP_SID in backend/.env"
            )
        from twilio.jwt.access_token import AccessToken
        from twilio.jwt.access_token.grants import VoiceGrant

        token = AccessToken(
            settings.twilio_account_sid,
            settings.twilio_api_key_sid,
            settings.twilio_api_key_secret,
            identity=identity,
            ttl=3600,
        )
        grant = VoiceGrant(
            outgoing_application_sid=settings.twilio_twiml_app_sid,
            incoming_allow=False,
        )
        token.add_grant(grant)
        jwt = token.to_jwt()
        return jwt.decode("utf-8") if isinstance(jwt, bytes) else str(jwt)

    def say_twiml(self, message: str) -> str:
        """Safe spoken TwiML (never let Twilio fall back to 'application error')."""
        import html

        text = html.escape((message or "Call could not be completed.").strip()[:500])
        return (
            '<?xml version="1.0" encoding="UTF-8"?>'
            f"<Response><Say voice=\"alice\">{text}</Say><Hangup/></Response>"
        )

    def client_dial_twiml(
        self,
        lead_phone: str,
        interaction_id: int,
        *,
        attempt: int = 1,
    ) -> str:
        """TwiML for browser-initiated outbound calls — dials the lead directly.

        When hang-up-after-4th-ring is ON, Dial times out ~12s (~3s/ring). The Dial action
        webhook may return a second Dial (attempt 2) so the lead hears ~8 rings
        without voicemail.
        """
        import html

        lead = normalize_e164(lead_phone)
        if not lead:
            return self.say_twiml(
                "The phone number is invalid. Please check the lead number and try again."
            )
        caller_id = normalize_e164(settings.twilio_phone_number) or (
            settings.twilio_phone_number or ""
        ).strip()
        if not caller_id.startswith("+"):
            return self.say_twiml(
                "Caller ID is not configured. Set TWILIO_PHONE_NUMBER on the server."
            )

        # Status/recording callbacks need a public base URL. If missing, still Dial
        # so the call can ring — omit callbacks rather than crashing TwiML fetch.
        status_url = ""
        recording_url = ""
        safe_attempt = max(1, int(attempt or 1))
        if settings.twilio_webhook_base_url:
            status_url = self.webhook_url(
                f"/api/webhooks/twilio/voice/status?interaction_id={interaction_id}"
                f"&attempt={safe_attempt}"
            )
            recording_url = self.webhook_url(
                f"/api/webhooks/twilio/voice/recording?interaction_id={interaction_id}"
            )

        lead_xml = html.escape(lead, quote=True)
        caller_xml = html.escape(caller_id, quote=True)
        dial_attrs = [
            f'callerId="{caller_xml}"',
            'record="record-from-answer"',
        ]
        # All callers (Sara/Rayan + dashboard sales dials): hang up after ~4 rings when
        # hangup_after_fourth_ring is ON so unanswered calls do not hit voicemail / burn credits.
        ring_timeout = self.ring_timeout_seconds()
        if ring_timeout:
            dial_attrs.append(f'timeout="{ring_timeout}"')
        if recording_url:
            recording_xml = html.escape(recording_url, quote=True)
            dial_attrs.extend(
                [
                    f'recordingStatusCallback="{recording_xml}"',
                    'recordingStatusCallbackMethod="POST"',
                    'recordingStatusCallbackEvent="completed"',
                ]
            )
        if status_url:
            status_xml = html.escape(status_url, quote=True)
            dial_attrs.extend([f'action="{status_xml}"', 'method="POST"'])

        return (
            '<?xml version="1.0" encoding="UTF-8"?>'
            "<Response>"
            f'<Dial {" ".join(dial_attrs)}>'
            f"<Number>{lead_xml}</Number>"
            "</Dial>"
            "</Response>"
        )

    def fetch_account_balance(self) -> dict[str, Any]:
        """Live Twilio prepaid balance (admin diagnostics)."""
        if not settings.twilio_account_sid or not settings.twilio_auth_token:
            return {
                "ok": False,
                "message": "Twilio is not configured on the server.",
            }
        try:
            from twilio.rest import Client

            client = Client(
                settings.twilio_account_sid.strip(),
                settings.twilio_auth_token.strip(),
            )
            record = client.api.v2010.accounts(settings.twilio_account_sid.strip()).balance.fetch()
            balance_raw = getattr(record, "balance", None)
            currency = (getattr(record, "currency", None) or "USD").upper()
            try:
                balance = float(balance_raw)
            except (TypeError, ValueError):
                return {
                    "ok": False,
                    "message": f"Unexpected balance value from Twilio: {balance_raw!r}",
                }
            return {
                "ok": True,
                "balance": balance,
                "currency": currency,
                "account_status": "active",
            }
        except Exception as exc:  # noqa: BLE001
            return {
                "ok": False,
                "message": f"Could not fetch Twilio balance: {exc}",
            }

    def setup_hints(self) -> dict[str, Any]:
        missing: list[str] = []
        if not settings.twilio_account_sid:
            missing.append("TWILIO_ACCOUNT_SID")
        if not settings.twilio_auth_token:
            missing.append("TWILIO_AUTH_TOKEN")
        if not settings.twilio_phone_number:
            missing.append("TWILIO_PHONE_NUMBER")
        if not settings.twilio_webhook_base_url:
            missing.append("TWILIO_WEBHOOK_BASE_URL")
        if not settings.twilio_api_key_sid:
            missing.append("TWILIO_API_KEY_SID")
        if not settings.twilio_api_key_secret:
            missing.append("TWILIO_API_KEY_SECRET")
        if not settings.twilio_twiml_app_sid:
            missing.append("TWILIO_TWIML_APP_SID")
        return {"missing": missing, "browser_ready": self.browser_ready}

    def hangup_after_fourth_ring_enabled(self) -> bool:
        return bool(getattr(settings, "hangup_after_fourth_ring", True))

    def ring_timeout_seconds(self) -> int | None:
        if not self.hangup_after_fourth_ring_enabled():
            return None
        try:
            seconds = int(getattr(settings, "ring_timeout_seconds", _FOURTH_RING_SECONDS) or _FOURTH_RING_SECONDS)
        except (TypeError, ValueError):
            seconds = _FOURTH_RING_SECONDS
        return max(8, min(seconds, 60))

    def max_ring_attempts(self) -> int:
        """How many 16s dial attempts when hangup-after-rings is ON (stops on answer)."""
        if not self.hangup_after_fourth_ring_enabled():
            return 1
        try:
            n = int(
                getattr(settings, "max_ring_attempts", _DEFAULT_MAX_RING_ATTEMPTS)
                or _DEFAULT_MAX_RING_ATTEMPTS
            )
        except (TypeError, ValueError):
            n = _DEFAULT_MAX_RING_ATTEMPTS
        return max(1, min(n, _HARD_MAX_RING_ATTEMPTS))

    def should_auto_redial(self, *, attempt: int, status: str | None) -> bool:
        """True when this unanswered attempt should be followed by another dial."""
        blob = (status or "").lower().replace("_", "-")
        if attempt >= self.max_ring_attempts():
            return False
        if any(tok in blob for tok in _NO_CONNECT_STATUSES):
            return True
        if blob in _LIVE_DIAL_STATUSES:
            return True
        return False

    def schedule_fourth_ring_hangup(
        self,
        call_sid: str | None,
        *,
        attempt: int = 1,
        on_hangup_redial: Any | None = None,
    ) -> None:
        """If still ringing after ~4 rings, hang up; optionally auto-redial once (~8 rings total).

        Timer starts only after the call leaves pre-ring (queued/connecting). Arming from
        Vapi/Twilio create time was killing dials before the handset rang.
        """
        seconds = self.ring_timeout_seconds()
        sid = (call_sid or "").strip()
        if not seconds or not sid:
            return
        safe_attempt = max(1, int(attempt or 1))
        connect_grace = 45  # wait for carrier/Vapi to reach ringing

        def _watch() -> None:
            import time

            hung_up = False
            try:
                elapsed = 0.0
                status = ""
                while elapsed < connect_grace:
                    info = self.fetch_outbound_status(sid)
                    status = str(info.get("status") or "").lower().replace("_", "-")
                    if info.get("ended"):
                        return
                    if status in _ANSWERED_STATUSES:
                        return
                    if any(tok in status for tok in _NO_CONNECT_STATUSES):
                        return
                    if status in _RINGING_STATUSES:
                        break
                    # Still queued/connecting — keep waiting.
                    time.sleep(1.0)
                    elapsed += 1.0
                else:
                    # Never left pre-ring — do not force-hangup (would kill every AI dial).
                    print(
                        f"Fourth-ring hangup skipped (still pre-ring) call={sid[-8:]} "
                        f"status={status or 'unknown'} after {connect_grace}s",
                        flush=True,
                    )
                    return

                # Poll every second — if callee hangs up early, stop immediately
                # (do not wait out the remaining 16s "at any cost").
                ring_elapsed = 0.0
                while ring_elapsed < seconds:
                    time.sleep(1.0)
                    ring_elapsed += 1.0
                    info = self.fetch_outbound_status(sid)
                    status = str(info.get("status") or "").lower().replace("_", "-")
                    if info.get("ended"):
                        return
                    if status in _ANSWERED_STATUSES:
                        return
                    if any(tok in status for tok in _NO_CONNECT_STATUSES):
                        return

                info = self.fetch_outbound_status(sid)
                status = str(info.get("status") or "").lower().replace("_", "-")
                if info.get("ended") or status in _ANSWERED_STATUSES:
                    return
                # Still not answered after the ring budget — force hangup + optional redial.
                print(
                    f"Fourth-ring hangup call={sid[-8:]} attempt={safe_attempt} "
                    f"status={status or 'unknown'}",
                    flush=True,
                )
                self.end_call(sid)
                hung_up = True
            except Exception as exc:  # noqa: BLE001
                print(f"Fourth-ring hangup skipped: {exc}", flush=True)

            # Optional explicit redial hook (browser path uses Dial action TwiML instead).
            if hung_up and on_hangup_redial and safe_attempt < self.max_ring_attempts():
                time.sleep(1.5)
                try:
                    print(
                        f"Auto-redial after 4th-ring hangup attempt={safe_attempt}→{safe_attempt + 1}",
                        flush=True,
                    )
                    on_hangup_redial()
                except Exception as exc:  # noqa: BLE001
                    print(f"Auto-redial failed: {exc}", flush=True)

        threading.Thread(
            target=_watch,
            name=f"ring-limit-{sid[-8:]}",
            daemon=True,
        ).start()

    def ai_gather_twiml(self, message: str, action_url: str, voice: str = "Polly.Joanna-Neural") -> str:
        """Build TwiML with <Gather input='speech'> for interactive voice conversation."""
        import html
        text = html.escape((message or "").strip()[:500])
        action_xml = html.escape(action_url, quote=True)
        return (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<Response>'
            f'<Gather input="speech" action="{action_xml}" method="POST" speechTimeout="auto" timeout="6">'
            f'<Say voice="{voice}">{text}</Say>'
            '</Gather>'
            f'<Say voice="{voice}">I did not catch a response. Thank you for your time with Kafi Commodities and have a great day!</Say>'
            '<Hangup/>'
            '</Response>'
        )

    def place_outbound_ai_call(
        self,
        to_phone: str,
        text_message: str | None = None,
        persona: str = "female",
        contact_name: str | None = None,
        language: str | None = "en",
        task_id: int | None = None,
        company_name: str | None = None,
        designation: str | None = None,
        ring_attempt: int = 1,
        voice_gender: str | None = None,
        allowed_languages: list[str] | None = None,
        interaction_id: int | None = None,
    ) -> dict[str, Any]:
        """Initiate an outbound PSTN call via Vapi AI Voice Engine (or Twilio fallback).

        When hang-up-after-rings is ON, unanswered dials auto-redial up to max_ring_attempts.
        """
        normalized = normalize_e164(to_phone)
        if not normalized:
            return {"ok": False, "error": f"Invalid destination phone number: '{to_phone}'. Must be in E.164 format (e.g. +923142867152)."}

        safe_attempt = max(1, int(ring_attempt or 1))
        gender = resolve_call_gender(persona, voice_gender=voice_gender)
        is_female = gender == "female"
        lang_code = (language or "en").strip().lower()
        if lang_code not in LANGUAGE_CONFIGS:
            lang_code = "en"
        allowed_langs = normalize_allowed_languages(lang_code, allowed_languages)
        lang_block = build_language_prompt_block(lang_code, allowed_langs)
        transcriber_lang = resolve_transcriber_language(lang_code, allowed_langs)
        allowed_names = ", ".join(LANGUAGE_CONFIGS[c]["name"] for c in allowed_langs)

        def _arm_ring_limit(call_id: str | None) -> None:
            # After ~16s still ringing → hang up. For AI queue tasks, redial attempt 2
            # here (do not rely only on Vapi webhooks — they often omit no-answer reasons).
            def _redial_after_timeout() -> None:
                if not task_id or safe_attempt >= self.max_ring_attempts():
                    return
                try:
                    from api.ai_sales_agent import handle_ai_call_status

                    handle_ai_call_status(
                        task_id=int(task_id),
                        call_sid=call_id,
                        status="no-answer",
                        duration=self.ring_timeout_seconds() or 16,
                        ended_reason="ring-timeout-hangup",
                        ring_attempt=safe_attempt,
                    )
                except Exception as exc:  # noqa: BLE001
                    print(f"Ring-timeout redial hook failed: {exc}", flush=True)

            self.schedule_fourth_ring_hangup(
                call_id,
                attempt=safe_attempt,
                on_hangup_redial=(
                    _redial_after_timeout
                    if task_id and safe_attempt < self.max_ring_attempts()
                    else None
                ),
            )

        # Try Vapi Voice Engine first for sub-second conversational AI calling (if enabled)
        vapi_key = settings.vapi_api_key if getattr(settings, "vapi_enabled", True) else None
        vapi_phone_id = settings.vapi_phone_number_id

        lang_cfg = LANGUAGE_CONFIGS.get(lang_code, LANGUAGE_CONFIGS["en"])

        if vapi_key:
            try:
                import json
                import urllib.request
                gender = resolve_call_gender(persona, voice_gender=voice_gender)
                is_female = gender == "female"
                agent_name = resolve_call_agent_name(persona, is_female=is_female)
                c_name = contact_name or "there"
                first_msg = text_message or lang_cfg["greeting"].format(c_name=c_name)

                eleven_key = getattr(settings, "elevenlabs_api_key", None)
                eleven_on = getattr(settings, "elevenlabs_enabled", False)
                if eleven_on and eleven_key and eleven_key.strip():
                    # Multilingual TTS — do NOT set language:auto (causes random ZH/JA/AR hops).
                    voice_config = {
                        "provider": "11labs",
                        "voiceId": "21m00Tcm4TlvDq8ikWAM" if is_female else "ErXwobaYiN019PkySvjV",
                        "model": "eleven_multilingual_v2",
                    }
                elif lang_code == "ur":
                    # Vapi's built-in voices have no Urdu (400 "supported Vapi voice language"),
                    # which silently dropped every Urdu call to the English Twilio fallback.
                    # Use Azure's ur-PK neural voices instead.
                    voice_config = {
                        "provider": "azure",
                        "voiceId": lang_cfg["voice_female"] if is_female else lang_cfg["voice_male"],
                    }
                else:
                    # Stick TTS to the selected start language (no auto).
                    voice_config = {
                        "provider": "vapi",
                        "voiceId": "Savannah" if is_female else "Elliot",
                        "language": lang_code if lang_code != "fil" else "tl",
                    }
                print(
                    f"AI call voice gender={gender} persona={persona!r} "
                    f"engine_voice={voice_config.get('voiceId')} "
                    f"lang={lang_code} stt={transcriber_lang} allowed={allowed_langs}",
                    flush=True,
                )

                try:
                    from modules.ai_agent_training import get_training_knowledge
                    t_data = get_training_knowledge(None)
                    insights_txt = t_data.get("learned_insights", "")
                    rules_txt = t_data.get("custom_rules", "")
                except Exception:
                    insights_txt, rules_txt = "", ""

                contact_block = ""
                product_block = ""
                try:
                    from modules.ai_sales_auto_mode import get_auto_mode_settings

                    auto = get_auto_mode_settings()
                    # Contact study when Auto Mode is off (legacy) or study_contacts is ticked.
                    study_c = (not auto.get("enabled")) or bool(auto.get("study_contacts"))
                    if study_c:
                        parts = [
                            f"Contact person: {c_name}",
                            f"Company: {(company_name or '').strip() or 'unknown'}",
                            f"Designation: {(designation or '').strip() or 'unknown'}",
                        ]
                        contact_block = (
                            "\n\nCONTACT STUDY (use naturally — do not recite as a list):\n"
                            + "\n".join(parts)
                        )
                    if auto.get("enabled") and auto.get("study_products"):
                        brief = (auto.get("product_brief") or "").strip()
                        if brief:
                            product_block = (
                                "\n\nPRODUCT KNOWLEDGE (use confidently to answer quality, packaging, "
                                f"and buying questions):\n{brief}"
                            )
                except Exception:
                    contact_block = ""
                    product_block = ""

                system_prompt = (
                    f"You are {agent_name}, a friendly, natural, and sharp B2B AI Sales Representative for Kafi Commodities. "
                    "Kafi Commodities is a leading global exporter of White Rice (Basmati 1121 & 5% Broken), Sesame Seeds (99% Purity), Yellow Corn, Spices, and Edible Oils.\n\n"
                    f"{lang_block}\n"
                    f"Languages you may use on THIS call only: {allowed_names}.\n"
                    "Do not invent or drift into unticked languages. Phone country code never chooses the language.\n\n"
                    "STRICT CONVERSATIONAL PROTOCOL & RULES:\n"
                    f"1. OPENING GREETING: You start the call by asking '{first_msg}'. Once the customer confirms, introduce {agent_name} from Kafi Commodities and offer our product catalogue and price list.\n"
                    "2. DO NOT REPEAT THE CUSTOMER'S NAME: You already asked for their name in the greeting. NEVER repeat their name in every sentence during the call.\n"
                    "3. DO NOT ASK FOR EMAIL OR PHONE NUMBER: We ALREADY have the customer's email and phone number in our system. NEVER ask the buyer to give you their email or phone number.\n"
                    "4. CATALOGUE & PRICE LIST DELIVERY: Tell the buyer you will send the full product catalogue and CNF price list to WhatsApp and email — say this in the current allowed language.\n"
                    "5. SHORT SPOKEN RESPONSES: Speak concisely in 1 to 2 spoken sentences so the conversation feels natural over the phone.\n\n"
                    f"LEARNED SALES PLAYBOOK:\n{insights_txt}\n\n"
                    f"CUSTOM SALES RULES:\n{rules_txt}"
                    f"{contact_block}"
                    f"{product_block}"
                )

                payload = {
                    "customer": {"number": normalized, "name": c_name},
                    "assistant": {
                        # Recording is off for now. Vapi rejects a top-level
                        # "recordingEnabled" (HTTP 400), so it lives in artifactPlan.
                        "artifactPlan": {"recordingEnabled": False},
                        "name": agent_name,
                        "firstMessage": first_msg,
                        "model": {
                            "provider": "openai",
                            "model": "gpt-4o-mini",
                            "messages": [
                                {
                                    "role": "system",
                                    "content": system_prompt,
                                }
                            ],
                        },
                        "voice": voice_config,
                        "transcriber": {
                            "provider": "deepgram",
                            # nova-3 has no Chinese (Vapi 400 -> English Twilio fallback); nova-2 does.
                            "model": "nova-2" if transcriber_lang == "zh" else "nova-3",
                            "language": transcriber_lang,
                        },
                    },
                }

                if vapi_phone_id:
                    payload["phoneNumberId"] = vapi_phone_id
                meta: dict[str, Any] = {
                    "persona": persona,
                    "voice_gender": gender,
                    "ring_attempt": safe_attempt,
                    "language": lang_code,
                    "allowed_languages": allowed_langs,
                }
                if task_id is not None:
                    meta["task_id"] = task_id
                if interaction_id is not None:
                    meta["interaction_id"] = int(interaction_id)
                payload["metadata"] = meta
                if settings.twilio_webhook_base_url:
                    try:
                        payload["assistant"]["serverUrl"] = self.webhook_url(
                            "/api/webhooks/vapi/ai-agent"
                        )
                        payload["assistant"]["serverMessages"] = [
                            "end-of-call-report",
                            "status-update",
                        ]
                    except Exception:
                        pass

                data = json.dumps(payload).encode("utf-8")
                req = urllib.request.Request(
                    "https://api.vapi.ai/call",
                    data=data,
                    headers={
                        "Authorization": f"Bearer {vapi_key}",
                        "Content-Type": "application/json",
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                    },
                )
                with urllib.request.urlopen(req, timeout=12) as res:
                    resp_data = json.loads(res.read().decode("utf-8"))
                    call_id = resp_data.get("id")
                    _arm_ring_limit(call_id)
                    return {
                        "ok": True,
                        "call_sid": call_id,
                        "status": resp_data.get("status", "queued"),
                        "engine": "vapi",
                        "ring_attempt": safe_attempt,
                    }
            except Exception as exc:
                detail = ""
                try:
                    detail = exc.read().decode("utf-8", "replace")[:500]  # type: ignore[attr-defined]
                except Exception:
                    pass
                print(f"Vapi call failed, falling back to Twilio TwiML: {exc} {detail}", flush=True)

        if not self.is_configured:
            return {"ok": False, "error": "Neither Vapi nor Twilio is configured on the server."}
        
        try:
            from twilio.rest import Client
            import urllib.parse

            client = Client(
                settings.twilio_account_sid.strip(),
                settings.twilio_auth_token.strip(),
            )

            q_persona = urllib.parse.quote(persona or "female")
            q_gender = urllib.parse.quote(gender)
            q_name = urllib.parse.quote(contact_name or "there")

            if settings.twilio_webhook_base_url:
                webhook_url = self.webhook_url(
                    f"/api/webhooks/twilio/ai-agent/intro?persona={q_persona}"
                    f"&voice_gender={q_gender}&name={q_name}"
                )
                create_kwargs: dict[str, Any] = {
                    "to": normalized,
                    "from_": settings.twilio_phone_number.strip(),
                    "url": webhook_url,
                }
                ring_timeout = self.ring_timeout_seconds()
                if ring_timeout:
                    create_kwargs["timeout"] = ring_timeout
                if task_id is not None:
                    create_kwargs["status_callback"] = self.webhook_url(
                        f"/api/webhooks/twilio/ai-agent/status"
                        f"?task_id={int(task_id)}&ring_attempt={safe_attempt}"
                    )
                    create_kwargs["status_callback_event"] = ["answered", "completed"]
                    create_kwargs["status_callback_method"] = "POST"
                call = client.calls.create(**create_kwargs)
            else:
                msg = text_message or f"Hello {contact_name or 'there'}, this is {persona} from Kafi Commodities. Thank you for connecting."
                twiml_content = self.say_twiml(msg)
                fallback_kwargs: dict[str, Any] = {
                    "to": normalized,
                    "from_": settings.twilio_phone_number.strip(),
                    "twiml": twiml_content,
                }
                ring_timeout = self.ring_timeout_seconds()
                if ring_timeout:
                    fallback_kwargs["timeout"] = ring_timeout
                call = client.calls.create(**fallback_kwargs)
            _arm_ring_limit(getattr(call, "sid", None))
            return {
                "ok": True,
                "call_sid": call.sid,
                "status": call.status,
                "engine": "twilio",
                "ring_attempt": safe_attempt,
            }
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def end_call(self, call_sid: str) -> dict[str, Any]:
        """Hang up a live call via Twilio and/or Vapi (both legs when possible)."""
        if not call_sid:
            return {"ok": False, "error": "No call SID provided"}

        sid = str(call_sid).strip()
        errors: list[str] = []
        engines: list[str] = []

        def _twilio_hangup(twilio_sid: str) -> bool:
            if not (settings.twilio_account_sid and settings.twilio_auth_token):
                errors.append("Twilio is not configured")
                return False
            if not twilio_sid.startswith("CA"):
                return False
            try:
                from twilio.rest import Client

                c = Client(
                    settings.twilio_account_sid.strip(),
                    settings.twilio_auth_token.strip(),
                )
                c.calls(twilio_sid).update(status="completed")
                engines.append("twilio")
                print(f"Twilio hangup ok sid={twilio_sid[-8:]}", flush=True)
                return True
            except Exception as exc:  # noqa: BLE001
                errors.append(f"twilio: {exc}")
                print(f"Twilio hangup failed: {exc}", flush=True)
                return False

        def _vapi_provider_sids(data: dict[str, Any]) -> list[str]:
            found: list[str] = []
            for key in (
                "phoneCallProviderId",
                "phoneCallProviderCallId",
                "telephonyProviderId",
                "providerCallId",
            ):
                val = data.get(key)
                if isinstance(val, str) and val.startswith("CA"):
                    found.append(val)
            transport = data.get("transport") or data.get("phoneCallTransport") or {}
            if isinstance(transport, dict):
                for key in ("callId", "providerId", "callSid", "sid"):
                    val = transport.get(key)
                    if isinstance(val, str) and val.startswith("CA"):
                        found.append(val)
            # de-dupe
            out: list[str] = []
            for s in found:
                if s not in out:
                    out.append(s)
            return out

        def _vapi_hangup(vapi_id: str) -> bool:
            vapi_key = getattr(settings, "vapi_api_key", None)
            if not vapi_key:
                errors.append("Vapi is not configured")
                return False
            import json
            import urllib.error
            import urllib.request

            headers = {
                "Authorization": f"Bearer {vapi_key}",
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0",
            }
            # Fetch call so we can also kill the Twilio PSTN leg.
            try:
                get_req = urllib.request.Request(
                    f"https://api.vapi.ai/call/{vapi_id}",
                    headers={"Authorization": f"Bearer {vapi_key}"},
                )
                with urllib.request.urlopen(get_req, timeout=10) as res:
                    call_data = json.loads(res.read().decode("utf-8"))
                for tw_sid in _vapi_provider_sids(call_data if isinstance(call_data, dict) else {}):
                    _twilio_hangup(tw_sid)
            except Exception as exc:  # noqa: BLE001
                print(f"Vapi GET before hangup skipped: {exc}", flush=True)

            ok = False
            # Preferred: PATCH status ended (ends live PSTN).
            try:
                body = json.dumps({"status": "ended"}).encode("utf-8")
                patch_req = urllib.request.Request(
                    f"https://api.vapi.ai/call/{vapi_id}",
                    data=body,
                    headers=headers,
                    method="PATCH",
                )
                with urllib.request.urlopen(patch_req, timeout=10) as res:
                    _ = res.read()
                ok = True
                engines.append("vapi-patch")
                print(f"Vapi PATCH ended ok id={vapi_id[-8:]}", flush=True)
            except urllib.error.HTTPError as exc:
                # 400/404 often mean already ended — treat as success for hangup UX.
                if exc.code in (400, 404):
                    ok = True
                    engines.append("vapi-patch")
                else:
                    errors.append(f"vapi-patch: HTTP {exc.code}")
                    print(f"Vapi PATCH hangup failed: {exc}", flush=True)
            except Exception as exc:  # noqa: BLE001
                errors.append(f"vapi-patch: {exc}")
                print(f"Vapi PATCH hangup failed: {exc}", flush=True)

            # Fallback DELETE.
            try:
                del_req = urllib.request.Request(
                    f"https://api.vapi.ai/call/{vapi_id}",
                    headers={"Authorization": f"Bearer {vapi_key}"},
                    method="DELETE",
                )
                with urllib.request.urlopen(del_req, timeout=10) as res:
                    _ = res.read()
                ok = True
                engines.append("vapi-delete")
            except urllib.error.HTTPError as exc:
                if exc.code in (200, 204, 400, 404):
                    ok = True
                    engines.append("vapi-delete")
                else:
                    errors.append(f"vapi-delete: HTTP {exc.code}")
                    print(f"Vapi DELETE hangup failed: {exc}", flush=True)
            except Exception as exc:  # noqa: BLE001
                errors.append(f"vapi-delete: {exc}")
                print(f"Vapi DELETE hangup failed: {exc}", flush=True)

            return ok

        if sid.startswith("CA"):
            tw_ok = _twilio_hangup(sid)
            return {
                "ok": tw_ok,
                "engine": ",".join(engines) or "twilio",
                "error": None if tw_ok else ("; ".join(errors) or "Twilio hangup failed"),
            }

        v_ok = _vapi_hangup(sid)
        return {
            "ok": v_ok,
            "engine": ",".join(engines) or "vapi",
            "error": None if v_ok else ("; ".join(errors) or "Vapi hangup failed"),
        }

    def fetch_outbound_status(self, call_sid: str | None) -> dict[str, Any]:
        """Best-effort live status for a Vapi or Twilio call (used to detect no-answer)."""
        if not call_sid:
            return {"ok": False, "ended": False}
        sid = str(call_sid).strip()
        vapi_key = getattr(settings, "vapi_api_key", None)
        if vapi_key and not sid.startswith("CA"):
            try:
                import json
                import urllib.request

                req = urllib.request.Request(
                    f"https://api.vapi.ai/call/{sid}",
                    headers={
                        "Authorization": f"Bearer {vapi_key}",
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                    },
                )
                with urllib.request.urlopen(req, timeout=8) as res:
                    data = json.loads(res.read().decode("utf-8"))
                status = str(data.get("status") or "").lower()
                ended_reason = str(data.get("endedReason") or data.get("ended_reason") or "")
                duration = data.get("durationSeconds") or data.get("duration")
                if duration in (None, "") and data.get("startedAt") and data.get("endedAt"):
                    try:
                        from datetime import datetime

                        t0 = datetime.fromisoformat(str(data["startedAt"]).replace("Z", "+00:00"))
                        t1 = datetime.fromisoformat(str(data["endedAt"]).replace("Z", "+00:00"))
                        duration = max(0, int((t1 - t0).total_seconds()))
                    except Exception:  # noqa: BLE001
                        pass
                ended = status in {"ended", "completed", "failed"} or bool(ended_reason)
                art = data.get("artifact") if isinstance(data.get("artifact"), dict) else {}
                recording_url = None
                for candidate in (
                    art.get("presignedMonoUrl"),
                    art.get("presignedStereoUrl"),
                    art.get("recordingUrl"),
                    art.get("stereoRecordingUrl"),
                    data.get("presignedMonoUrl"),
                    data.get("presignedStereoUrl"),
                    data.get("recordingUrl"),
                    data.get("stereoRecordingUrl"),
                ):
                    if isinstance(candidate, str) and candidate.strip().startswith("http"):
                        recording_url = candidate.strip()
                        break
                transcript = None
                t = art.get("transcript")
                if isinstance(t, str) and t.strip():
                    transcript = t.strip()[:8000]
                return {
                    "ok": True,
                    "ended": ended,
                    "status": status or ended_reason,
                    "ended_reason": ended_reason,
                    "duration": duration,
                    "engine": "vapi",
                    "recording_url": recording_url,
                    "call_transcript": transcript,
                }
            except Exception as exc:
                print(f"Vapi status fetch failed: {exc}", flush=True)
        if sid.startswith("CA") and settings.twilio_account_sid and settings.twilio_auth_token:
            try:
                from twilio.rest import Client

                c = Client(settings.twilio_account_sid.strip(), settings.twilio_auth_token.strip())
                call = c.calls(sid).fetch()
                status = str(getattr(call, "status", "") or "").lower()
                duration = getattr(call, "duration", None)
                ended = status in {
                    "completed",
                    "busy",
                    "failed",
                    "no-answer",
                    "canceled",
                    "cancelled",
                }
                return {
                    "ok": True,
                    "ended": ended,
                    "status": status,
                    "ended_reason": status,
                    "duration": duration,
                    "engine": "twilio",
                }
            except Exception as exc:
                print(f"Twilio status fetch failed: {exc}", flush=True)
        return {"ok": False, "ended": False}


voice_client = VoiceClient()
