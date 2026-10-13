"""Product image chatbot — vision-capable multi-provider LLM with aggressive fallback.

Provider priority (first configured key wins on each turn):
  1. Gemini Flash chain   — gemini-3.1-flash-lite → gemini-2.5-flash → gemini-3.5-flash → gemini-2.0-flash
  2. OpenAI GPT-4o        — gpt-4o-mini → gpt-4o (vision)
  3. Anthropic Claude     — claude-3-5-haiku → claude-3-5-sonnet (vision)

Any 429 / quota / rate-limit error on one provider automatically tries the next model
then the next provider, so credit exhaustion on a single key never breaks the chat.
"""

from __future__ import annotations

import base64
import json
import logging
import re
from pathlib import Path
from typing import Any

from config import settings

logger = logging.getLogger(__name__)

PROMPTS_DIR = Path(__file__).resolve().parents[1] / "prompts"

DEFAULT_GEMINI_IMAGE_CHAIN = [
    "gemini-2.5-flash",
    "gemini-3.1-flash-lite",
    "gemini-3.5-flash",
    "gemini-2.0-flash",
]

DEFAULT_OPENAI_IMAGE_CHAIN = [
    "gpt-4o-mini",
    "gpt-4o",
]

DEFAULT_ANTHROPIC_IMAGE_CHAIN = [
    "claude-3-5-haiku-20241022",
    "claude-3-5-sonnet-20241022",
]

_chatbot_gemini_clients: list[Any] | None = None


def _parse_csv(value: str | None) -> list[str]:
    if not value or not value.strip():
        return []
    return [part.strip() for part in value.split(",") if part.strip()]


def _chatbot_gemini_model_chain() -> list[str]:
    fallbacks = _parse_csv(settings.chatbot_gemini_fallback_models) or DEFAULT_GEMINI_IMAGE_CHAIN
    chain: list[str] = []
    for model in fallbacks:
        if model and model not in chain:
            chain.append(model)
    return chain or list(DEFAULT_GEMINI_IMAGE_CHAIN)


def _chatbot_openai_model_chain() -> list[str]:
    primary = (settings.chatbot_openai_model or "gpt-4o-mini").strip()
    chain = [primary, *DEFAULT_OPENAI_IMAGE_CHAIN]
    deduped: list[str] = []
    for model in chain:
        if model and model not in deduped:
            deduped.append(model)
    return deduped


def _chatbot_anthropic_model_chain() -> list[str]:
    primary = (settings.chatbot_anthropic_model or "claude-3-5-haiku-20241022").strip()
    chain = [primary, *DEFAULT_ANTHROPIC_IMAGE_CHAIN]
    deduped: list[str] = []
    for model in chain:
        if model and model not in deduped:
            deduped.append(model)
    return deduped


def _get_chatbot_gemini_clients() -> list[Any]:
    """Gemini clients for product chatbot only — uses CHATBOT_GEMINI_* env vars."""
    global _chatbot_gemini_clients
    if _chatbot_gemini_clients is not None:
        return _chatbot_gemini_clients

    keys = _parse_csv(settings.chatbot_gemini_api_keys)
    primary = settings.chatbot_gemini_api_key
    if primary and primary not in keys:
        keys.insert(0, primary)

    if not keys:
        _chatbot_gemini_clients = []
        return _chatbot_gemini_clients

    try:
        from google import genai  # type: ignore[import]

        _chatbot_gemini_clients = [genai.Client(api_key=key) for key in keys]
    except Exception:
        _chatbot_gemini_clients = []

    return _chatbot_gemini_clients


def _is_rate_limit(exc: Exception) -> bool:
    text = str(exc).lower()
    return any(
        m in text
        for m in (
            "429", "resource_exhausted", "rate limit", "rate_limit",
            "quota", "too many requests", "overloaded", "529",
        )
    )


def _is_retryable(exc: Exception) -> bool:
    if _is_rate_limit(exc):
        return True
    text = str(exc).lower()
    return any(
        m in text
        for m in ("404", "not_found", "no longer available", "model not found", "is not found")
    )


def _load_system_prompt() -> str:
    path = PROMPTS_DIR / "product_chatbot_system.md"
    if path.exists():
        return path.read_text(encoding="utf-8").strip()
    return (
        "You are a brand intelligence assistant. Identify brands from product images "
        "and deliver comprehensive brand and company contact information."
    )


_IMAGE_EXTRACTION_PROMPT = """Analyze this product image for BRAND identification. Read ALL visible text — logos, wordmarks, stylized fonts, small print.

Return ONLY valid JSON (no markdown):
{
  "brand_name": "primary brand name — REQUIRED if any logo, wordmark, or brand text is visible",
  "brand_visible_cues": "describe logo, colors, tagline, or brand styling seen on pack",
  "manufacturer_or_parent_company": "if different from brand name, else null",
  "brand_on_pack": {
    "company_name": null,
    "address": null,
    "phone": null,
    "email": null,
    "website": null,
    "social_media": null,
    "country": null,
    "registration_numbers": null,
    "other_brand_text": "any other brand or company-related text on the pack"
  },
  "product_name_on_pack": "one line only, or null"
}

Rules:
- Brand identification is the top priority. If you see a logo or brand mark, you MUST set brand_name.
- Transcribe brand-related label text accurately.
- Use null only for fields genuinely not visible on this side of the pack."""


def _parse_json_object(raw: str) -> dict:
    text = (raw or "").strip()
    if text.startswith("```"):
        lines = text.split("\n")
        end = -1 if lines[-1].startswith("```") else len(lines)
        text = "\n".join(lines[1:end])
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if match:
        text = match.group(0)
    try:
        data = json.loads(text)
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        return {}


def _extract_from_image(
    *,
    image_bytes: bytes,
    mime_type: str,
) -> dict:
    """Vision pass — brand, product, and on-pack text."""
    raw = _generate_reply(
        message=_IMAGE_EXTRACTION_PROMPT,
        image_bytes=image_bytes,
        mime_type=mime_type,
        history=[],
        system="You extract structured JSON from product images. Respond with JSON only.",
    )
    return _parse_json_object(raw)


def _brand_for_lookup(extraction: dict) -> str | None:
    for key in ("brand_name", "manufacturer_or_parent_company", "brand_on_pack"):
        if key == "brand_on_pack":
            pack = extraction.get("brand_on_pack") or extraction.get("visible_on_pack") or {}
            if isinstance(pack, dict):
                name = (pack.get("company_name") or "").strip()
                if name:
                    return name
            continue
        value = (extraction.get(key) or extraction.get("manufacturer_name") or "").strip()
        if value and value.lower() not in {"null", "unknown", "n/a"}:
            return value
    return None


def _format_search_results(results: Any) -> str:
    lines: list[str] = []

    kg = getattr(results, "knowledge_graph", None) or {}
    if kg:
        lines.append("Knowledge graph:")
        for key in ("title", "website", "phone", "address", "description"):
            val = kg.get(key)
            if val:
                lines.append(f"  {key}: {val}")

    local = getattr(results, "local", None) or []
    if local:
        lines.append("Local / business listings:")
        for place in local[:5]:
            title = place.get("title") or ""
            phone = place.get("phone") or ""
            address = place.get("address") or ""
            if title or phone or address:
                lines.append(f"  - {title} | {phone} | {address}")

    organic = getattr(results, "organic", None) or []
    if organic:
        lines.append("Web results:")
        for item in organic[:12]:
            title = item.get("title") or ""
            link = item.get("link") or ""
            snippet = item.get("snippet") or ""
            if title or snippet:
                lines.append(f"  - {title}")
                if link:
                    lines.append(f"    {link}")
                if snippet:
                    lines.append(f"    {snippet}")

    if not lines:
        return "No web results found for this brand."
    return "\n".join(lines)


def _lookup_company_details(brand_name: str) -> str:
    from modules.web_search import any_combined_provider_available, any_provider_available, search, search_combined

    brand = (brand_name or "").strip()
    if not brand:
        return "No brand name to search."

    if not any_combined_provider_available() and not any_provider_available():
        return "Web search is not configured — company lookup skipped."

    queries = [
        f'"{brand}" company official website contact phone email',
        f'"{brand}" manufacturer headquarters address',
        f'"{brand}" brand owner company profile about',
        f'"{brand}" customer service helpline contact us',
    ]

    chunks: list[str] = []
    seen: set[str] = set()
    for query in queries:
        results = search_combined(query, num=12) if any_combined_provider_available() else search(query, num=12)
        formatted = _format_search_results(results)
        if formatted and formatted not in seen:
            seen.add(formatted)
            chunks.append(f"Query: {query}\n{formatted}")

    return "\n\n".join(chunks) if chunks else "No web results found for this brand."


def _build_synthesis_message(
    *,
    user_message: str,
    extraction: dict,
    web_context: str,
    brand_name: str | None,
) -> str:
    return (
        f"User question: {user_message}\n\n"
        f"## Brand identified from image\n"
        f"{json.dumps(extraction, indent=2)}\n\n"
        f"## Web research for brand: {brand_name or 'unknown'}\n"
        f"{web_context}\n\n"
        "Write the response with ### Brand Information as the FIRST and most detailed section. "
        "Use every relevant detail from the web research — company overview, all phones, emails, "
        "addresses, websites, social media, and registration info. "
        "Label each fact as On pack or Web lookup. "
        "Product details: 2–3 lines maximum at the end only if useful."
    )


# ---------------------------------------------------------------------------
# Gemini vision
# ---------------------------------------------------------------------------

def _gemini_text_part(genai_types: Any, text: str) -> Any:
    return genai_types.Part.from_text(text=text)


def _try_gemini(
    *,
    message: str,
    image_bytes: bytes | None,
    mime_type: str,
    history: list[dict],
    system: str,
) -> str:
    from modules.llm_client import _is_retryable_model_error

    clients = _get_chatbot_gemini_clients()
    if not clients:
        raise RuntimeError(
            "No chatbot Gemini API key configured. Set CHATBOT_GEMINI_API_KEY in backend/.env."
        )

    from google.genai import types as genai_types  # type: ignore[import]

    # Build contents list for this turn
    turn_parts: list[Any] = []
    if image_bytes:
        turn_parts.append(
            genai_types.Part.from_bytes(data=image_bytes, mime_type=mime_type)
        )
    turn_parts.append(_gemini_text_part(genai_types, message))

    # Build full contents with prior history
    contents: list[Any] = []
    for msg in history:
        role = msg.get("role", "user")
        text = msg.get("content", "")
        if not text:
            continue
        contents.append(
            genai_types.Content(
                role=role,
                parts=[_gemini_text_part(genai_types, text)],
            )
        )
    contents.append(genai_types.Content(role="user", parts=turn_parts))

    model_chain = _chatbot_gemini_model_chain()
    last_exc: Exception | None = None
    for gemini_client in clients:
        for model in model_chain:
            try:
                config = genai_types.GenerateContentConfig(
                    max_output_tokens=2048,
                    system_instruction=system,
                )
                resp = gemini_client.models.generate_content(
                    model=model,
                    contents=contents,
                    config=config,
                )
                return (resp.text or "").strip()
            except Exception as exc:
                last_exc = exc
                if _is_retryable_model_error(exc):
                    logger.debug("Gemini %s retryable: %s", model, exc)
                    continue
                raise RuntimeError(f"Gemini vision failed ({model}): {exc}") from exc

    raise RuntimeError(
        f"Gemini exhausted all models/keys: {last_exc}"
    ) from last_exc


# ---------------------------------------------------------------------------
# OpenAI vision
# ---------------------------------------------------------------------------

def _try_openai(
    *,
    message: str,
    image_bytes: bytes | None,
    mime_type: str,
    history: list[dict],
    system: str,
) -> str:
    try:
        from openai import OpenAI  # type: ignore[import]
    except ImportError as exc:
        raise RuntimeError("openai package not installed") from exc

    key = settings.chatbot_openai_api_key
    if not key:
        raise RuntimeError("CHATBOT_OPENAI_API_KEY not configured")

    oa = OpenAI(api_key=key)
    messages: list[dict] = [{"role": "system", "content": system}]

    for msg in history:
        messages.append({"role": msg["role"], "content": msg["content"]})

    # Build the current user turn
    if image_bytes:
        b64 = base64.b64encode(image_bytes).decode()
        user_content: Any = [
            {"type": "image_url", "image_url": {"url": f"data:{mime_type};base64,{b64}"}},
            {"type": "text", "text": message},
        ]
    else:
        user_content = message

    messages.append({"role": "user", "content": user_content})

    last_exc: Exception | None = None
    for model in _chatbot_openai_model_chain():
        try:
            resp = oa.chat.completions.create(
                model=model,
                messages=messages,  # type: ignore[arg-type]
                max_tokens=2048,
            )
            return (resp.choices[0].message.content or "").strip()
        except Exception as exc:
            last_exc = exc
            if _is_retryable(exc):
                logger.debug("OpenAI %s retryable: %s", model, exc)
                continue
            raise RuntimeError(f"OpenAI vision failed ({model}): {exc}") from exc

    raise RuntimeError(f"OpenAI exhausted all models: {last_exc}") from last_exc


# ---------------------------------------------------------------------------
# Anthropic vision
# ---------------------------------------------------------------------------

def _try_anthropic(
    *,
    message: str,
    image_bytes: bytes | None,
    mime_type: str,
    history: list[dict],
    system: str,
) -> str:
    try:
        import anthropic  # type: ignore[import]
    except ImportError as exc:
        raise RuntimeError("anthropic package not installed") from exc

    key = settings.chatbot_anthropic_api_key
    if not key:
        raise RuntimeError("CHATBOT_ANTHROPIC_API_KEY not configured")

    ant = anthropic.Anthropic(api_key=key)
    messages: list[dict] = []

    for msg in history:
        messages.append({"role": msg["role"], "content": msg["content"]})

    if image_bytes:
        b64 = base64.b64encode(image_bytes).decode()
        user_content: Any = [
            {
                "type": "image",
                "source": {"type": "base64", "media_type": mime_type, "data": b64},
            },
            {"type": "text", "text": message},
        ]
    else:
        user_content = message

    messages.append({"role": "user", "content": user_content})

    last_exc: Exception | None = None
    for model in _chatbot_anthropic_model_chain():
        try:
            resp = ant.messages.create(
                model=model,
                max_tokens=2048,
                system=system,
                messages=messages,  # type: ignore[arg-type]
            )
            return (resp.content[0].text if resp.content else "").strip()
        except Exception as exc:
            last_exc = exc
            if _is_retryable(exc):
                logger.debug("Anthropic %s retryable: %s", model, exc)
                continue
            raise RuntimeError(f"Anthropic vision failed ({model}): {exc}") from exc

    raise RuntimeError(f"Anthropic exhausted all models: {last_exc}") from last_exc


def _generate_reply(
    *,
    message: str,
    image_bytes: bytes | None = None,
    mime_type: str = "image/jpeg",
    history: list[dict],
    system: str,
) -> str:
    """Try Gemini → OpenAI → Anthropic; returns raw text."""
    errors: list[str] = []

    try:
        return _try_gemini(
            message=message,
            image_bytes=image_bytes,
            mime_type=mime_type,
            history=history,
            system=system,
        )
    except Exception as exc:
        errors.append(f"Gemini: {exc}")
        logger.warning("Gemini failed: %s", exc)

    try:
        return _try_openai(
            message=message,
            image_bytes=image_bytes,
            mime_type=mime_type,
            history=history,
            system=system,
        )
    except Exception as exc:
        errors.append(f"OpenAI: {exc}")
        logger.warning("OpenAI failed: %s", exc)

    try:
        return _try_anthropic(
            message=message,
            image_bytes=image_bytes,
            mime_type=mime_type,
            history=history,
            system=system,
        )
    except Exception as exc:
        errors.append(f"Anthropic: {exc}")
        logger.warning("Anthropic failed: %s", exc)

    raise RuntimeError(f"All providers failed: {' | '.join(errors)}")


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def chat(
    *,
    message: str,
    image_bytes: bytes | None = None,
    mime_type: str = "image/jpeg",
    history: list[dict] | None = None,
) -> dict:
    """Send a message (with optional product image) and return a reply dict.

    Tries Gemini → OpenAI → Anthropic in that order, automatically falling back
    whenever a provider hits a rate limit or model unavailability error.

    Returns:
        {
            "reply": str,
            "provider": str,   # which provider ultimately succeeded
            "model": str,      # not always available; best-effort
        }
    """
    system = _load_system_prompt()
    hist = history or []

    # Image upload: extract brand → web lookup → synthesize full answer
    if image_bytes:
        try:
            extraction = _extract_from_image(image_bytes=image_bytes, mime_type=mime_type)
            brand_name = _brand_for_lookup(extraction)
            web_context = _lookup_company_details(brand_name) if brand_name else "No brand identified for web lookup."
            synthesis_message = _build_synthesis_message(
                user_message=message,
                extraction=extraction,
                web_context=web_context,
                brand_name=brand_name,
            )
            reply = _generate_reply(
                message=synthesis_message,
                image_bytes=None,
                mime_type=mime_type,
                history=hist,
                system=system,
            )
            return {
                "reply": reply,
                "provider": "gemini",
                "model": _chatbot_gemini_model_chain()[0],
            }
        except Exception as exc:
            logger.warning("Image pipeline failed, falling back to single-pass: %s", exc)

    errors: list[str] = []

    # Text-only / fallback single-pass
    try:
        reply = _try_gemini(
            message=message,
            image_bytes=image_bytes,
            mime_type=mime_type,
            history=hist,
            system=system,
        )
        return {"reply": reply, "provider": "gemini", "model": _chatbot_gemini_model_chain()[0]}
    except Exception as exc:
        errors.append(f"Gemini: {exc}")
        logger.warning("Gemini provider failed for chatbot: %s", exc)

    # 2. OpenAI
    try:
        reply = _try_openai(
            message=message,
            image_bytes=image_bytes,
            mime_type=mime_type,
            history=hist,
            system=system,
        )
        return {"reply": reply, "provider": "openai", "model": _chatbot_openai_model_chain()[0]}
    except Exception as exc:
        errors.append(f"OpenAI: {exc}")
        logger.warning("OpenAI provider failed for chatbot: %s", exc)

    # 3. Anthropic
    try:
        reply = _try_anthropic(
            message=message,
            image_bytes=image_bytes,
            mime_type=mime_type,
            history=hist,
            system=system,
        )
        return {"reply": reply, "provider": "anthropic", "model": _chatbot_anthropic_model_chain()[0]}
    except Exception as exc:
        errors.append(f"Anthropic: {exc}")
        logger.warning("Anthropic provider failed for chatbot: %s", exc)

    summary = " | ".join(errors)
    raise RuntimeError(
        f"All AI providers exhausted for product chatbot. Errors: {summary}"
    )


def status() -> dict:
    """Return which chatbot providers are configured (CHATBOT_* keys only)."""
    return {
        "gemini": bool(_get_chatbot_gemini_clients()),
        "openai": bool(settings.chatbot_openai_api_key),
        "anthropic": bool(settings.chatbot_anthropic_api_key),
    }
