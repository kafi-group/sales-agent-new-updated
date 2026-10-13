"""Dedicated Gemini clients for AI Mode — separate keys from llm_client / chatbot / KPI.

- Query replies: Company lifecycle → New Lead manual replies (AI_MODE_QUERY_GEMINI_*)
- Auto-replies: after-hours email + WhatsApp (AI_MODE_AUTO_REPLY_GEMINI_*)

Each profile uses one base model + two fallback models on 429/404.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Literal

from config import settings
from modules.llm_client import (
    DEFAULT_MODEL,
    _apply_prompt_template,
    _is_retryable_model_error,
    _load_prompt,
    _resolve_model_name,
    with_email_reply_standards,
)

PROMPTS_DIR = Path(__file__).resolve().parents[1] / "prompts"

_DEFAULT_FALLBACK_MODELS = (
    "gemini-2.5-flash",
    "gemini-3.5-flash",
)


def _parse_csv(value: str | None) -> list[str]:
    if not value or not value.strip():
        return []
    return [part.strip() for part in value.split(",") if part.strip()]


def _model_chain(
    *,
    primary_setting: str | None,
    fallbacks_setting: str | None,
) -> list[str]:
    primary = _resolve_model_name(primary_setting or DEFAULT_MODEL)
    fallbacks = _parse_csv(fallbacks_setting) or list(_DEFAULT_FALLBACK_MODELS)
    chain: list[str] = []
    for model in [primary, *fallbacks[:2]]:
        resolved = _resolve_model_name(model)
        if resolved and resolved not in chain:
            chain.append(resolved)
    return chain or [DEFAULT_MODEL]


def _collect_api_keys(primary: str | None, extras_csv: str | None) -> list[str]:
    keys = _parse_csv(extras_csv)
    primary_key = (primary or "").strip()
    if primary_key and primary_key not in keys:
        keys.insert(0, primary_key)
    return keys


def _get_gemini_clients(api_keys: list[str]) -> list[Any]:
    if not api_keys:
        return []
    try:
        from google import genai  # type: ignore[import]

        return [genai.Client(api_key=key) for key in api_keys]
    except Exception:
        return []


def _generate(
    *,
    api_keys: list[str],
    model_chain: list[str],
    max_output_tokens: int,
    system: str,
    prompt: str,
) -> str:
    clients = _get_gemini_clients(api_keys)
    if not clients:
        raise RuntimeError("Gemini API key is not configured for this AI Mode profile.")

    from google.genai import types as genai_types  # type: ignore[import]

    config = genai_types.GenerateContentConfig(
        max_output_tokens=max(256, max_output_tokens),
        system_instruction=system,
    )

    last_error: Exception | None = None
    retryable = False

    for client in clients:
        for model in model_chain:
            try:
                response = client.models.generate_content(
                    model=model,
                    contents=prompt,
                    config=config,
                )
                text = (response.text or "").strip()
                if text:
                    return text
                raise RuntimeError("Empty model response")
            except Exception as exc:
                last_error = exc
                if _is_retryable_model_error(exc):
                    retryable = True
                    continue
                raise RuntimeError(f"Gemini generation failed ({model}): {exc}") from exc

    if retryable:
        raise RuntimeError(
            "Gemini failed on all configured models (rate limit or unavailable model)."
        ) from last_error
    raise RuntimeError(f"Gemini generation failed: {last_error}") from last_error


def _query_api_keys() -> list[str]:
    """Dedicated AI Mode query keys, else shared GEMINI_API_KEY (+ GEMINI_API_KEYS)."""
    keys = _collect_api_keys(
        settings.ai_mode_query_gemini_api_key,
        settings.ai_mode_query_gemini_api_keys,
    )
    if keys:
        return keys
    return _collect_api_keys(
        settings.gemini_api_key or settings.llm_api_key,
        settings.gemini_api_keys,
    )


def query_llm_enabled() -> bool:
    return bool(_query_api_keys())


def _auto_reply_api_keys() -> list[str]:
    return _collect_api_keys(
        settings.ai_mode_auto_reply_gemini_api_key,
        settings.ai_mode_auto_reply_gemini_api_keys,
    )


def auto_reply_llm_enabled() -> bool:
    return bool(_auto_reply_api_keys())


def _query_model_chain() -> list[str]:
    return _model_chain(
        primary_setting=settings.ai_mode_query_gemini_model,
        fallbacks_setting=settings.ai_mode_query_gemini_fallback_models,
    )


def _auto_reply_model_chain() -> list[str]:
    return _model_chain(
        primary_setting=settings.ai_mode_auto_reply_gemini_model,
        fallbacks_setting=settings.ai_mode_auto_reply_gemini_fallback_models,
    )


def draft_query_email_reply(
    *,
    sender_name: str,
    sender_email: str,
    greeting_name: str,
    subject: str,
    inbound_body: str,
    form_url: str | None,
    template_hint: str,
    fallback_body: str,
) -> dict[str, Any]:
    """LLM draft for New Lead query replies (manual UI + AI Mode auto-reply)."""
    if not query_llm_enabled():
        return {
            "body": fallback_body,
            "source": "template",
            "llm_enabled": False,
        }

    template = _load_prompt("ai_mode_query_reply_prompt.md")
    if not template:
        template = (
            "Write a brief professional reply to this inquiry from {greeting_name} "
            "({sender_email}). Max 80 words. Answer only what they asked.\n"
            "Subject: {subject}\n\n{inbound_body}"
        )

    form_clause = (form_url or "").strip() or "our team will share the form link with you shortly"
    prompt = with_email_reply_standards(
        _apply_prompt_template(
            template,
            sender_name=sender_name or greeting_name or "Sir/Madam",
            greeting_name=greeting_name or "Sir/Madam",
            sender_email=sender_email or "",
            subject=subject or "(no subject)",
            inbound_body=(inbound_body or subject or "")[:4000],
            form_url=form_clause,
            template_hint=(template_hint or "")[:1500],
        )
    )
    system = (
        "You write brief B2B export sales emails for Kafi Commodities. "
        "Hard limit: about 60–80 words, concise and to the point. "
        "Answer only what the buyer asked — no long primers, catalogs, or filler. "
        "Output plain text email body only."
    )

    try:
        # Cap tokens so replies stay short even if env is set high.
        max_tokens = min(
            512,
            max(256, int(settings.ai_mode_query_gemini_max_output_tokens or 512)),
        )
        body = _generate(
            api_keys=_query_api_keys(),
            model_chain=_query_model_chain(),
            max_output_tokens=max_tokens,
            system=system,
            prompt=prompt,
        )
        from modules.ai_mode_sender import finalize_reply_body

        body = finalize_reply_body(
            body, form_url=form_url, greeting_name=greeting_name
        )
        return {
            "body": body,
            "source": "llm",
            "llm_enabled": True,
            "model": _query_model_chain()[0],
        }
    except Exception as exc:
        err = str(exc)
        is_rate_limit = _is_retryable_model_error(exc) or "rate limit" in err.lower()
        return {
            "body": fallback_body,
            "source": "template",
            "llm_enabled": True,
            "error": err[:300],
            "fallback_reason": "rate_limit" if is_rate_limit else "error",
        }


def draft_auto_reply_message(
    *,
    channel: Literal["email", "whatsapp"],
    sender_name: str,
    sender_email: str,
    greeting_name: str,
    company_name: str,
    inbound_body: str,
    company_research: str,
    form_url: str | None,
    template_hint: str,
    fallback_body: str,
) -> dict[str, Any]:
    """LLM draft for after-hours auto-reply (email or WhatsApp)."""
    if not auto_reply_llm_enabled():
        return {
            "body": fallback_body,
            "source": "template",
            "llm_enabled": False,
        }

    template = _load_prompt("ai_mode_auto_reply_prompt.md")
    if not template:
        template = (
            "Write a {channel} auto-reply for {sender_name}.\n"
            "Message: {inbound_body}\nResearch: {company_research}"
        )

    form_clause = (form_url or "").strip() or "our team will share the form link with you shortly"
    prompt = with_email_reply_standards(
        _apply_prompt_template(
            template,
            channel=channel,
            sender_name=sender_name or greeting_name or "there",
            sender_email=sender_email or "",
            greeting_name=greeting_name or "Sir/Madam",
            person_name=greeting_name or "",
            company_name=company_name or "",
            inbound_body=(inbound_body or "")[:3500],
            company_research=(company_research or "No additional company information found.")[:2500],
            form_url=form_clause,
            template_hint=(template_hint or "")[:1200],
        )
    )
    system = (
        "You write after-hours auto-replies for Kafi Commodities export sales. "
        "Keep replies concise, specific, and directly related to the inquiry; "
        "avoid long explanations unless requested. "
        "Output plain text only."
    )
    max_tokens = 768 if channel == "whatsapp" else int(
        settings.ai_mode_auto_reply_gemini_max_output_tokens or 1024
    )

    try:
        body = _generate(
            api_keys=_auto_reply_api_keys(),
            model_chain=_auto_reply_model_chain(),
            max_output_tokens=max_tokens,
            system=system,
            prompt=prompt,
        )
        from modules.ai_mode_sender import finalize_reply_body

        body = finalize_reply_body(
            body, form_url=form_url, greeting_name=greeting_name
        )
        return {
            "body": body,
            "source": "llm",
            "llm_enabled": True,
            "model": _auto_reply_model_chain()[0],
        }
    except Exception as exc:
        err = str(exc)
        is_rate_limit = _is_retryable_model_error(exc) or "rate limit" in err.lower()
        return {
            "body": fallback_body,
            "source": "template",
            "llm_enabled": True,
            "error": err[:300],
            "fallback_reason": "rate_limit" if is_rate_limit else "error",
        }
