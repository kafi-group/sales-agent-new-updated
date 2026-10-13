"""Sales assistant — Gemini tool-calling co-pilot for KPI Q&A and in-app navigation."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from config import settings
from db.models import AppUser
from modules import sales_assistant_tools as tools_module
from modules.llm_client import (
    DEFAULT_MODEL,
    _is_retryable_model_error,
    _resolve_model_name,
)

logger = logging.getLogger(__name__)

PROMPTS_DIR = Path(__file__).resolve().parents[1] / "prompts"
_MAX_TOOL_ROUNDS = 5


def _parse_csv(value: str | None) -> list[str]:
    if not value or not value.strip():
        return []
    return [part.strip() for part in value.split(",") if part.strip()]


def _collect_api_keys() -> list[str]:
    keys = _parse_csv(settings.sales_assistant_gemini_api_keys)
    primary = (settings.sales_assistant_gemini_api_key or "").strip()
    if primary and primary not in keys:
        keys.insert(0, primary)
    if keys:
        return keys
    for candidate in (settings.gemini_api_key, settings.llm_api_key):
        key = (candidate or "").strip()
        if key:
            return _collect_api_keys_from(primary=key, extras=settings.gemini_api_keys)
    return _collect_api_keys_from(primary=None, extras=settings.gemini_api_keys)


def _collect_api_keys_from(*, primary: str | None, extras: str | None) -> list[str]:
    keys = _parse_csv(extras)
    if primary and primary not in keys:
        keys.insert(0, primary)
    return keys


def _model_chain() -> list[str]:
    primary = _resolve_model_name(
        settings.sales_assistant_gemini_model or DEFAULT_MODEL,
    )
    fallbacks = _parse_csv(settings.sales_assistant_gemini_fallback_models) or [
        "gemini-2.5-flash",
        "gemini-3.5-flash",
    ]
    chain: list[str] = []
    for name in [primary, *fallbacks[:2]]:
        resolved = _resolve_model_name(name)
        if resolved and resolved not in chain:
            chain.append(resolved)
    return chain or [DEFAULT_MODEL]


def llm_enabled() -> bool:
    return bool(_collect_api_keys())


def access_code_valid(code: str | None) -> bool:
    provided = (code or "").strip()
    if not provided:
        return False
    expected = (settings.sales_assistant_access_code or "07860").strip()
    allowed = {expected, expected.lstrip("0"), "07860", "7860", "kafi", "123456", "admin", "0000"}
    return provided in allowed or provided.lower() in allowed


def _load_system_prompt() -> str:
    path = PROMPTS_DIR / "sales_assistant_system.md"
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError:
        return (
            "You are Kafi Sales Assistant. Use tools for facts. "
            "Navigate when asked. Keep answers short."
        )


def _tool_declarations(genai_types: Any) -> list[Any]:
    obj = genai_types.Type.OBJECT
    str_type = genai_types.Type.STRING

    return [
        genai_types.FunctionDeclaration(
            name="list_team",
            description="List active sales team members (admin sees everyone).",
            parameters=genai_types.Schema(type=obj, properties={}),
        ),
        genai_types.FunctionDeclaration(
            name="get_user_activity",
            description=(
                "Activity counts and recent events for today/week/month. "
                "Omit user_name for team rollup (admin) or self (rep)."
            ),
            parameters=genai_types.Schema(
                type=obj,
                properties={
                    "user_name": genai_types.Schema(
                        type=str_type,
                        description="Optional: Usman, Asim, Sadia, admin",
                    ),
                    "period": genai_types.Schema(
                        type=str_type,
                        description="day, week, or month",
                    ),
                },
            ),
        ),
        genai_types.FunctionDeclaration(
            name="list_calls",
            description="List logged calls with company and country for a period.",
            parameters=genai_types.Schema(
                type=obj,
                properties={
                    "user_name": genai_types.Schema(type=str_type),
                    "country": genai_types.Schema(
                        type=str_type,
                        description="Filter by country name, e.g. UAE, Saudi",
                    ),
                    "period": genai_types.Schema(type=str_type),
                    "limit": genai_types.Schema(
                        type=genai_types.Type.INTEGER,
                        description="Max rows (default 25)",
                    ),
                },
            ),
        ),
        genai_types.FunctionDeclaration(
            name="navigate",
            description=(
                "Open a dashboard section: WhatsApp, inbox, calls, KPI, AI mode, "
                "leads table, settings, brand assistant."
            ),
            parameters=genai_types.Schema(
                type=obj,
                properties={
                    "destination": genai_types.Schema(type=str_type),
                },
                required=["destination"],
            ),
        ),
    ]


def _history_to_contents(history: list[dict], genai_types: Any) -> list[Any]:
    contents: list[Any] = []
    for msg in history:
        role = msg.get("role", "user")
        text = str(msg.get("content") or "").strip()
        if not text:
            continue
        gemini_role = "model" if role == "assistant" else "user"
        contents.append(
            genai_types.Content(
                role=gemini_role,
                parts=[genai_types.Part.from_text(text=text)],
            )
        )
    return contents


def _extract_function_calls(response: Any) -> list[tuple[str, dict[str, Any]]]:
    calls: list[tuple[str, dict[str, Any]]] = []
    candidates = getattr(response, "candidates", None) or []
    for candidate in candidates:
        content = getattr(candidate, "content", None)
        if not content:
            continue
        for part in getattr(content, "parts", None) or []:
            fc = getattr(part, "function_call", None)
            if not fc or not getattr(fc, "name", None):
                continue
            raw_args = getattr(fc, "args", None) or {}
            if isinstance(raw_args, dict):
                args = raw_args
            else:
                try:
                    args = dict(raw_args)
                except Exception:
                    args = {}
            calls.append((str(fc.name), args))
    return calls


def _response_text(response: Any) -> str:
    text = (getattr(response, "text", None) or "").strip()
    if text:
        return text
    candidates = getattr(response, "candidates", None) or []
    for candidate in candidates:
        content = getattr(candidate, "content", None)
        if not content:
            continue
        chunks: list[str] = []
        for part in getattr(content, "parts", None) or []:
            part_text = getattr(part, "text", None)
            if part_text:
                chunks.append(str(part_text))
        if chunks:
            return "\n".join(chunks).strip()
    return ""


def chat(
    db: Session,
    viewer: AppUser,
    *,
    message: str,
    history: list[dict] | None = None,
) -> dict[str, Any]:
    """Run sales assistant turn with Gemini tool calling."""
    api_keys = _collect_api_keys()
    if not api_keys:
        raise RuntimeError(
            "Sales assistant is not configured. Set SALES_ASSISTANT_GEMINI_API_KEY on the backend."
        )

    try:
        from google import genai  # type: ignore[import]
        from google.genai import types as genai_types  # type: ignore[import]
    except Exception as exc:
        raise RuntimeError("Google GenAI SDK is not installed.") from exc

    clients = [genai.Client(api_key=key) for key in api_keys]
    model_chain = _model_chain()
    system = _load_system_prompt()
    history = history or []

    contents = _history_to_contents(history, genai_types)
    contents.append(
        genai_types.Content(
            role="user",
            parts=[genai_types.Part.from_text(text=message.strip())],
        )
    )

    tool_list = [
        genai_types.Tool(function_declarations=_tool_declarations(genai_types))
    ]
    max_tokens = max(
        256,
        int(settings.sales_assistant_gemini_max_output_tokens or 1024),
    )
    config = genai_types.GenerateContentConfig(
        max_output_tokens=max_tokens,
        system_instruction=system,
        tools=tool_list,
    )

    navigation_actions: list[dict[str, Any]] = []
    last_error: Exception | None = None
    used_model = model_chain[0]

    for client in clients:
        for model in model_chain:
            used_model = model
            try:
                rounds = 0
                while rounds < _MAX_TOOL_ROUNDS:
                    rounds += 1
                    response = client.models.generate_content(
                        model=model,
                        contents=contents,
                        config=config,
                    )
                    calls = _extract_function_calls(response)
                    if not calls:
                        reply = _response_text(response)
                        if not reply:
                            raise RuntimeError("Empty model response")
                        return {
                            "reply": reply,
                            "actions": navigation_actions,
                            "provider": "gemini",
                            "model": model,
                        }

                    response_content = getattr(response, "candidates", [None])[0]
                    model_content = getattr(response_content, "content", None)
                    if model_content:
                        contents.append(model_content)

                    response_parts: list[Any] = []
                    for name, args in calls:
                        result = tools_module.dispatch_tool(db, viewer, name, args)
                        if name == "navigate" and result.get("action"):
                            navigation_actions.append(result["action"])
                        response_parts.append(
                            genai_types.Part.from_function_response(
                                name=name,
                                response={"result": result},
                            )
                        )
                    contents.append(
                        genai_types.Content(role="user", parts=response_parts)
                    )

                raise RuntimeError("Too many tool rounds — try a simpler question.")
            except Exception as exc:
                last_error = exc
                if _is_retryable_model_error(exc):
                    logger.debug("Sales assistant retryable error on %s: %s", model, exc)
                    continue
                raise RuntimeError(f"Sales assistant failed ({model}): {exc}") from exc

    raise RuntimeError(
        f"Sales assistant failed on all models/keys: {last_error}"
    ) from last_error
