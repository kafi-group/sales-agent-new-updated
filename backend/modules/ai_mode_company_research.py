"""SerpAPI company research for AI Mode auto-replies — dedicated key only."""

from __future__ import annotations

import re
from typing import Any

import httpx

from config import settings

_HTTP_TIMEOUT = 20.0

_GENERIC_EMAIL_DOMAINS = frozenset(
    {
        "gmail.com",
        "googlemail.com",
        "yahoo.com",
        "yahoo.co.uk",
        "hotmail.com",
        "outlook.com",
        "live.com",
        "icloud.com",
        "aol.com",
        "proton.me",
        "protonmail.com",
        "mail.com",
        "yandex.com",
        "zoho.com",
    }
)


def auto_reply_serpapi_enabled() -> bool:
    return bool((settings.ai_mode_auto_reply_serpapi_api_key or "").strip())


def _company_hint_from_email(from_email: str | None) -> str | None:
    addr = (from_email or "").strip().lower()
    if "@" not in addr:
        return None
    local, domain = addr.split("@", 1)
    if domain in _GENERIC_EMAIL_DOMAINS:
        return None
    base = domain.split(".")[0]
    if len(base) < 3 or base in {"mail", "email", "info", "contact"}:
        return local.replace(".", " ").replace("_", " ").strip() or None
    return base.replace("-", " ").replace("_", " ").strip()


def _build_search_query(
    *,
    from_name: str | None,
    from_email: str | None,
    subject: str | None,
) -> str:
    name = (from_name or "").strip()
    domain_hint = _company_hint_from_email(from_email)
    subj = (subject or "").strip()

    parts: list[str] = []
    if name and len(name) > 2 and name.lower() not in {"sir", "madam", "team", "sales"}:
        parts.append(name)
    if domain_hint:
        parts.append(domain_hint)
    if not parts and subj:
        parts.append(subj[:80])

    core = " ".join(parts).strip() or "food importer"
    return f"{core} company food import distributor"


def _serpapi_search(query: str, *, num: int = 5) -> dict[str, Any]:
    api_key = (settings.ai_mode_auto_reply_serpapi_api_key or "").strip()
    if not api_key:
        return {"summary": "", "error": "SerpAPI key not configured"}

    params = {
        "engine": "google",
        "q": query,
        "api_key": api_key,
        "num": num,
    }

    try:
        response = httpx.get(
            "https://serpapi.com/search.json",
            params=params,
            timeout=_HTTP_TIMEOUT,
        )
        response.raise_for_status()
        data = response.json()
    except httpx.HTTPError as exc:
        return {"summary": "", "error": f"SerpAPI request failed: {exc}"}
    except Exception as exc:  # noqa: BLE001
        return {"summary": "", "error": str(exc)[:200]}

    if err := data.get("error"):
        return {"summary": "", "error": str(err)[:200]}

    lines: list[str] = []

    kg = data.get("knowledge_graph") or {}
    if isinstance(kg, dict) and kg.get("title"):
        lines.append(f"Company: {kg.get('title')}")
        if kg.get("type"):
            lines.append(f"Type: {kg.get('type')}")
        if kg.get("description"):
            lines.append(f"About: {kg.get('description')}")
        if kg.get("website"):
            lines.append(f"Website: {kg.get('website')}")
        if kg.get("address"):
            lines.append(f"Address: {kg.get('address')}")

    organic = data.get("organic_results") or []
    for idx, item in enumerate(organic[:4], start=1):
        title = (item.get("title") or "").strip()
        snippet = (item.get("snippet") or "").strip()
        link = (item.get("link") or "").strip()
        if title or snippet:
            block = f"{idx}. {title}"
            if snippet:
                block += f" — {snippet}"
            if link:
                block += f" ({link})"
            lines.append(block)

    summary = "\n".join(lines).strip()
    return {
        "query": query,
        "summary": summary[:2500],
        "has_results": bool(summary),
    }


def research_inbound_sender(
    *,
    from_name: str | None = None,
    from_email: str | None = None,
    subject: str | None = None,
    body: str | None = None,
) -> dict[str, Any]:
    """Look up public info about the sender's company before auto-reply."""
    if not auto_reply_serpapi_enabled():
        return {
            "summary": "",
            "source": "disabled",
            "query": None,
        }

    query = _build_search_query(
        from_name=from_name,
        from_email=from_email,
        subject=subject,
    )

    # If body mentions a company website, add domain context to the query.
    body_text = (body or "")[:2000]
    domain_match = re.search(
        r"https?://(?:www\.)?([a-z0-9][-a-z0-9.]+\.[a-z]{2,})",
        body_text,
        re.I,
    )
    if domain_match:
        host = domain_match.group(1).lower()
        if host not in _GENERIC_EMAIL_DOMAINS:
            query = f"{host} company food import"

    result = _serpapi_search(query)
    result["source"] = "serpapi"
    return result


def format_research_for_llm(research: dict[str, Any]) -> str:
    if research.get("error"):
        return f"(Web search unavailable: {research['error']})"
    summary = (research.get("summary") or "").strip()
    if summary:
        return summary
    return "No additional public company information was found."
