"""AI assistant for mailbox questions (important unread, queries, etc.)."""

from __future__ import annotations

from typing import Any

from db.models import AppUser
from modules import inbox as inbox_module


def _format_thread_line(thread: dict[str, Any], index: int) -> str:
    unread = "UNREAD" if int(thread.get("unread_count") or 0) > 0 else "read"
    sender = thread.get("latest_from_name") or thread.get("latest_from_email") or "Unknown"
    subject = thread.get("subject") or "(no subject)"
    preview = (thread.get("latest_preview") or "")[:160]
    date = thread.get("latest_date") or ""
    return (
        f"{index}. [{unread}] From: {sender} | Subject: {subject} | Date: {date}\n"
        f"   Preview: {preview}\n"
        f"   thread_id: {thread.get('thread_id')}"
    )


def query_mailbox(user: AppUser, *, question: str, unread_only: bool = False) -> dict[str, Any]:
    status = inbox_module.status(user)
    unread_count = int(status.get("unread_count") or 0)
    thread_page = inbox_module.list_threads(
        user,
        limit=40,
        offset=0,
        unread_only=unread_only,
    )
    threads = list(thread_page.get("items") or [])
    if unread_only:
        threads = [t for t in threads if int(t.get("unread_count") or 0) > 0]

    if not threads:
        return {
            "answer": (
                "I could not find matching recent conversations in the mailbox scan. "
                "Try Refresh, or ask about a specific sender or subject keyword."
            ),
            "suggested_threads": [],
            "unread_count": unread_count,
        }

    catalog = "\n".join(_format_thread_line(t, i + 1) for i, t in enumerate(threads[:25]))
    prompt = (
        "You are a concise executive mail assistant for Kafi Commodities sales staff.\n"
        f"Mailbox: {status.get('email') or 'unknown'} · server unread count: {unread_count}\n\n"
        "Recent conversations (newest first):\n"
        f"{catalog}\n\n"
        f"User question: {question.strip()}\n\n"
        "Answer in plain English. Highlight the most important items first. "
        "If listing emails, include sender and subject. Keep under 220 words."
    )
    try:
        from config import settings
        from modules.ai_mode_llm import _generate, _query_api_keys, _query_model_chain

        answer = _generate(
            api_keys=_query_api_keys(),
            model_chain=_query_model_chain(),
            max_output_tokens=int(settings.ai_mode_query_gemini_max_output_tokens or 1024),
            system="You are a concise executive mail assistant for Kafi Commodities.",
            prompt=prompt,
        ).strip()
    except Exception as exc:  # noqa: BLE001
        answer = (
            f"I scanned {len(threads)} recent conversation(s) but the AI service is unavailable ({exc}). "
            "Check the list on the left or try again shortly."
        )

    # Surface up to 5 threads mentioned or top unread.
    suggested = sorted(
        threads,
        key=lambda t: (int(t.get("unread_count") or 0), str(t.get("latest_date") or "")),
        reverse=True,
    )[:5]
    return {
        "answer": answer,
        "suggested_threads": suggested,
        "unread_count": unread_count,
    }
