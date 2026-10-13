"""LLM client — Google Gemini via the google-genai SDK.

Set GEMINI_API_KEY in backend/.env to enable. Falls back gracefully to
rule-based outputs when the key is absent or the SDK is unavailable.

Cost controls:
- Defaults to gemini-3.1-flash-lite (cheapest GA model for new API keys).
- On rate-limit (429) or unavailable model (404), tries fallback models.
- Caps max output tokens to keep responses short.

Model switching vs extra keys:
- Switching models: same key, often works when limits are per-model.
- Extra keys in the SAME project: do NOT add quota.
- Extra keys from DIFFERENT projects: can add quota, but use only for
  legitimate dev/prod separation — not to bypass free-tier limits.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from config import settings

PROMPTS_DIR = Path(__file__).resolve().parents[1] / "prompts"

# Prefer fast Flash models for audio (lower latency than text-default chain).
TRANSCRIPTION_MODEL_CHAIN = (
    "gemini-2.0-flash",
    "gemini-2.5-flash",
    "gemini-3.1-flash-lite",
    "gemini-3.5-flash",
)


def _transcription_max_tokens(duration_seconds: int | None) -> int:
    """Scale output budget with recording length (~12 tokens/sec, min 4k, max 16k)."""
    seconds = max(30, int(duration_seconds or 180))
    return min(16384, max(4096, seconds * 12))


# Cheapest → slightly more capable. All Flash-family, low cost.
DEFAULT_MODEL = "gemini-3.1-flash-lite"
DEFAULT_FALLBACK_MODELS = (
    "gemini-2.5-flash",
    "gemini-3.5-flash",
    "gemini-2.0-flash",
)

# Google retires models for new API keys — map old IDs to current replacements.
RETIRED_MODEL_ALIASES: dict[str, str] = {
    "gemini-2.5-flash-lite": "gemini-3.1-flash-lite",
    "gemini-2.5-flash-lite-preview-09-2025": "gemini-3.1-flash-lite",
    "gemini-2.0-flash-lite": "gemini-3.1-flash-lite",
    "gemini-1.5-flash": "gemini-3.1-flash-lite",
    "gemini-1.5-flash-8b": "gemini-3.1-flash-lite",
}


def _resolve_model_name(model: str) -> str:
    name = (model or "").strip()
    if not name:
        return DEFAULT_MODEL
    return RETIRED_MODEL_ALIASES.get(name, name)


def _build_model_chain() -> list[str]:
    primary_model = _resolve_model_name(settings.gemini_model or DEFAULT_MODEL)
    fallbacks = _parse_csv_env(settings.gemini_fallback_models) or list(DEFAULT_FALLBACK_MODELS)
    chain: list[str] = []
    for model in [primary_model, *fallbacks]:
        resolved = _resolve_model_name(model)
        if resolved and resolved not in chain:
            chain.append(resolved)
    return chain or [DEFAULT_MODEL]


def _load_prompt(filename: str) -> str:
    path = PROMPTS_DIR / filename
    if path.exists():
        return path.read_text(encoding="utf-8")
    return ""


_EMAIL_REPLY_STANDARDS_FALLBACK = (
    "## Email reply standards (mandatory)\n"
    "1. Concise — Prefer short replies (about 80–120 words). Longer only when the "
    "customer clearly asked for detail, specs, or a full quotation explanation.\n"
    "2. Specific — Address their actual question or next step; reference a concrete "
    "point from their message when useful.\n"
    "3. Inquiry-related — Stay on this customer’s inquiry; do not pad with generic "
    "catalogs or company history.\n"
    "4. No unsolicited essays — Avoid long explanations unless specifically requested.\n"
    "5. Professional plain text — no invented prices, MOQs, or commitments."
)


def email_reply_standards() -> str:
    """Shared rules for every customer-facing email reply / draft."""
    text = _load_prompt("email_reply_standards.md").strip()
    return text or _EMAIL_REPLY_STANDARDS_FALLBACK


def with_email_reply_standards(prompt: str) -> str:
    """Prepend mandatory reply standards to an LLM email prompt."""
    body = (prompt or "").strip()
    standards = email_reply_standards()
    if not body:
        return standards
    return f"{standards}\n\n---\n\n{body}"


def _parse_csv_env(value: str | None) -> list[str]:
    if not value or not value.strip():
        return []
    return [part.strip() for part in value.split(",") if part.strip()]


def _is_rate_limit_error(exc: Exception) -> bool:
    text = str(exc).lower()
    return any(
        marker in text
        for marker in (
            "429",
            "resource_exhausted",
            "rate limit",
            "rate_limit",
            "quota",
            "too many requests",
        )
    )


def _is_retryable_model_error(exc: Exception) -> bool:
    """Rate limits and retired/unavailable model IDs — try the next model in chain."""
    text = str(exc).lower()
    if _is_rate_limit_error(exc):
        return True
    return any(
        marker in text
        for marker in (
            "404",
            "not_found",
            "no longer available",
            "is not found",
            "was not found",
            "model not found",
        )
    )


def _apply_prompt_template(template: str, **values: str) -> str:
    """Fill {name} placeholders without str.format (safe when content or template contains JSON braces)."""
    result = template
    for key, value in values.items():
        result = result.replace("{" + key + "}", value)
    return result


class LLMClient:
    """Centralized LLM interface — cheapest model first, fallback on 429/404."""

    def __init__(self) -> None:
        self._clients: list[Any] = []
        self._max_output_tokens: int = 512
        self._clients_initialised = False

    def reset(self) -> None:
        """Drop cached clients so the next request reloads settings from .env."""
        self._clients = []
        self._clients_initialised = False

    def _get_clients(self) -> list[Any]:
        if self._clients_initialised:
            return self._clients
        self._clients_initialised = True

        keys = _parse_csv_env(settings.gemini_api_keys)
        primary = settings.gemini_api_key or settings.llm_api_key
        if primary and primary not in keys:
            keys.insert(0, primary)

        if not keys:
            return []

        try:
            from google import genai  # type: ignore[import]

            self._clients = [genai.Client(api_key=key) for key in keys]
        except Exception:
            self._clients = []

        self._max_output_tokens = max(128, int(settings.gemini_max_output_tokens or 512))

        return self._clients

    def model_chain(self) -> list[str]:
        """Always read fresh from settings (avoids stale model cache after .env changes)."""
        return _build_model_chain()

    @property
    def enabled(self) -> bool:
        """True when a Gemini API key is configured and the SDK is available."""
        return bool(self._get_clients())

    @property
    def active_model(self) -> str:
        """Primary (cheapest) model configured for this client."""
        chain = self.model_chain()
        return chain[0] if chain else DEFAULT_MODEL

    # ------------------------------------------------------------------
    # Core generation
    # ------------------------------------------------------------------

    def _generate_with_model(
        self,
        client: Any,
        model: str,
        prompt: str,
        *,
        system: str | None = None,
        contents: Any | None = None,
        max_output_tokens: int | None = None,
    ) -> str:
        from google.genai import types as genai_types  # type: ignore[import]

        config_kwargs: dict[str, Any] = {
            "max_output_tokens": max_output_tokens or self._max_output_tokens,
        }
        if system:
            config_kwargs["system_instruction"] = system
        config = genai_types.GenerateContentConfig(**config_kwargs)

        response = client.models.generate_content(
            model=model,
            contents=contents if contents is not None else prompt,
            config=config,
        )
        return response.text or ""

    def generate(self, prompt: str, *, system: str | None = None) -> str:
        """Return raw text. Tries cheapest model first, then fallbacks on 429."""
        clients = self._get_clients()
        if not clients:
            raise NotImplementedError(
                "LLM is not configured. Add GEMINI_API_KEY to backend/.env to enable Gemini."
            )

        last_error: Exception | None = None
        retryable = False
        chain = self.model_chain()

        for client in clients:
            for model in chain:
                try:
                    return self._generate_with_model(client, model, prompt, system=system)
                except Exception as exc:
                    last_error = exc
                    if _is_retryable_model_error(exc):
                        retryable = True
                        continue
                    raise RuntimeError(f"Gemini generation failed ({model}): {exc}") from exc

        if retryable:
            raise RuntimeError(
                "Gemini failed on all configured models (rate limit or unavailable model). "
                "Wait for quota reset or update GEMINI_MODEL in backend/.env."
            ) from last_error
        raise RuntimeError(f"Gemini generation failed: {last_error}") from last_error

    def transcribe_audio(
        self,
        audio_bytes: bytes,
        *,
        mime_type: str = "audio/mpeg",
        hint: str | None = None,
        duration_seconds: int | None = None,
    ) -> str:
        """Speech-to-text via Gemini multimodal audio understanding."""
        clients = self._get_clients()
        if not clients:
            raise NotImplementedError(
                "LLM is not configured. Add GEMINI_API_KEY to backend/.env to enable transcription."
            )

        from google.genai import types as genai_types  # type: ignore[import]

        prompt = (
            "Transcribe this phone call recording word for word as closed captions.\n"
            "Rules:\n"
            "- Capture the entire conversation accurately.\n"
            "- Label speakers as Agent: and Client: when you can tell them apart.\n"
            "- If a word is unclear, use [inaudible].\n"
            "- Do not summarize. Output only the transcript dialogue.\n"
            "- Keep natural punctuation and paragraph breaks between turns.\n"
        )
        if hint:
            prompt += f"\nContext: {hint}\n"

        contents = [
            genai_types.Part.from_bytes(data=audio_bytes, mime_type=mime_type),
            prompt,
        ]

        last_error: Exception | None = None
        retryable = False
        chain: list[str] = []
        for model in TRANSCRIPTION_MODEL_CHAIN:
            resolved = _resolve_model_name(model)
            if resolved not in chain:
                chain.append(resolved)
        if not chain:
            chain = self.model_chain()
        token_budget = _transcription_max_tokens(duration_seconds)
        for client in clients:
            for model in chain:
                try:
                    return self._generate_with_model(
                        client,
                        model,
                        prompt,
                        contents=contents,
                        max_output_tokens=token_budget,
                    ).strip()
                except Exception as exc:
                    last_error = exc
                    if _is_retryable_model_error(exc):
                        retryable = True
                        continue
                    raise RuntimeError(f"Gemini transcription failed ({model}): {exc}") from exc

        if retryable:
            raise RuntimeError(
                "Gemini transcription failed on all configured models. "
                "Update GEMINI_MODEL in backend/.env or try again shortly."
            ) from last_error
        raise RuntimeError(f"Gemini transcription failed: {last_error}") from last_error

    def generate_json(self, prompt: str, *, system: str | None = None) -> dict[str, Any]:
        """Return a parsed JSON dict. Strips markdown fences if present."""
        raw = self.generate(
            prompt + "\n\nRespond with ONLY valid JSON. No markdown, no code fences.",
            system=system,
        )
        text = raw.strip()
        if text.startswith("```"):
            lines = text.split("\n")
            end = -1 if lines[-1].startswith("```") else len(lines)
            text = "\n".join(lines[1:end])
        # Grab first JSON object if model adds extra prose
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if match:
            text = match.group(0)
        return json.loads(text)

    # ------------------------------------------------------------------
    # Domain-specific helpers (used by research / scoring / comms)
    # ------------------------------------------------------------------

    def enhance_website_summary(
        self,
        *,
        company_name: str,
        website_text: str,
        current_summary: str,
    ) -> str:
        """Return a richer 2-3 sentence business summary from raw website text."""
        if not self.enabled:
            return current_summary
        prompt = (
            "You are a B2B sales analyst for Kafi Commodities, a Pakistani food exporter.\n\n"
            f"Company: {company_name}\n"
            f"Website excerpt:\n{website_text[:2000]}\n\n"
            "Write 2-3 concise sentences on: what they sell/import, target markets, "
            "and fit for Pakistani food exports (rice, chutneys, sauces, pickles, salt, spices).\n"
            "Return only the summary."
        )
        try:
            return self.generate(prompt)
        except Exception:
            return current_summary

    def score_lead(
        self,
        *,
        buyer_profile: str,
        interactions: str,
        export_history: str,
        fallback_label: str,
        fallback_reasoning: str,
    ) -> dict[str, Any]:
        """Return {score, reasoning, key_factors} using the lead-scoring prompt."""
        if not self.enabled:
            return {
                "score": fallback_label,
                "reasoning": fallback_reasoning,
                "key_factors": [],
            }
        template = _load_prompt("lead_scoring_prompt.md")
        prompt = _apply_prompt_template(
            template,
            buyer_profile=buyer_profile[:2500],
            interactions=interactions[:1500],
            export_history=export_history[:1000],
        )
        try:
            result = self.generate_json(prompt)
            score = str(result.get("score", fallback_label)).upper().replace(" ", "")
            legacy = {"HOT": "AAA", "WARM": "AA", "COLD": "A"}
            score = legacy.get(score, score)
            if score not in ("AAA", "AA", "A"):
                score = fallback_label
            return {
                "score": score,
                "reasoning": result.get("reasoning", fallback_reasoning),
                "key_factors": result.get("key_factors", []),
            }
        except Exception:
            return {
                "score": fallback_label,
                "reasoning": fallback_reasoning,
                "key_factors": [],
            }

    def draft_email(
        self,
        *,
        buyer_country: str,
        target_language: str,
        buyer_context: str,
        goal: str,
        product_specs: str,
        fallback_body: str,
    ) -> str:
        """Return an LLM-written email body using the email-draft prompt."""
        if not self.enabled:
            return fallback_body
        template = _load_prompt("email_draft_prompt.md")
        prompt = with_email_reply_standards(
            _apply_prompt_template(
                template,
                buyer_country=buyer_country or "International",
                target_language=target_language or "English",
                buyer_context=buyer_context[:1200],
                goal=goal,
                product_specs=product_specs[:800],
            )
        )
        try:
            return self.generate(
                prompt,
                system=(
                    "You write concise, inquiry-specific B2B emails for Kafi Commodities. "
                    "Avoid long explanations unless the buyer asked for detail."
                ),
            )
        except Exception:
            return fallback_body


llm_client = LLMClient()
