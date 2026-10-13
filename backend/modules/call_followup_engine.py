"""Situation-based post-call follow-up for Sara / Rayan.

After a call, pick the best *situation* (and draft) from "Call follow-ups for AI Agents", fill in the
placeholders, optionally let the AI polish the wording (with a strict facts guard), then send the
email (and WhatsApp when a WhatsApp text exists and the QR session is connected).

Safety rules:
  * `try_situation_followup` returns None whenever nothing was sent, so the caller falls back to the
    old generic follow-up. Once sending has started it ALWAYS returns a result (never None), so a
    fallback can never double-send.
  * All slow AI steps run under a time limit and have no side effects.
  * Prices, weights, numbers, names and product lists come from the saved draft only: the polished
    text is rejected (original draft used) if any such line changed.
  * The sending mode (off / test_only / all) lives in call_followup_meta and defaults to test_only.
"""

from __future__ import annotations

import html
import os
import re
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from typing import Any

from modules import call_followups as cf

_SELECT_TIMEOUT = 15.0
_POLISH_TIMEOUT = 12.0
_FETCH_TIMEOUT = 10.0

CALL_FAILED_GROUP = "call couldn't be made"

_FALLBACKS = {
    "contact_name": "Sir/Madam",
    "company_name": "your company",
    "agent_name": "Sara",
    "product": "product",
    "country": "your market",
    "referrer_name": "your colleague",
}


def _norm(value: str | None) -> str:
    return (value or "").replace("’", "'").strip().lower()


def _with_timeout(fn: Any, seconds: float, *args: Any) -> Any:
    """Run fn(*args) with a time limit. Returns None on timeout/error (never raises)."""
    ex = ThreadPoolExecutor(max_workers=1)
    fut = ex.submit(fn, *args)
    try:
        return fut.result(timeout=seconds)
    except FutureTimeout:
        print(f"Call follow-up step timed out after {seconds}s: {getattr(fn, '__name__', fn)}", flush=True)
        return None
    except Exception as exc:  # noqa: BLE001
        print(f"Call follow-up step failed ({getattr(fn, '__name__', fn)}): {exc}", flush=True)
        return None
    finally:
        ex.shutdown(wait=False)


# --------------------------------------------------------------------------- choosing


def _candidates() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for g in cf.list_all():
        if not g.get("enabled"):
            continue
        drafts = [
            d for d in (g.get("drafts") or []) if d.get("enabled") and (d.get("body") or "").strip()
        ]
        if drafts:
            out.append({**g, "drafts": drafts})
    return out


def _llm_select(cands: list[dict[str, Any]], summary: str, transcript: str, outcome: str) -> Any:
    from modules.llm_client import llm_client

    lines = []
    for g in cands:
        ds = "; ".join(f'{d["id"]}={d["name"]}' for d in g["drafts"])
        lines.append(f'- group_id {g["id"]}: {g["name"]} - {g["description"]} [drafts: {ds}]')
    prompt = (
        "Situations (choose exactly one):\n"
        + "\n".join(lines)
        + f"\n\nCall outcome: {outcome}\n"
        + f"Call summary: {summary or 'n/a'}\n"
        + f"Call transcript (may be partial):\n{(transcript or 'n/a')[:3500]}\n\n"
        + 'Reply with JSON only: {"group_id": <number or null>, "draft_id": <number>, '
        + '"product": "<main product the customer talked about, or empty>", "reason": "<short>"}. '
        + "Use null for group_id if no situation clearly fits."
    )
    system = (
        "You classify the outcome of a B2B sales phone call for Kafi Commodities, a Pakistani food "
        "exporter, into exactly one situation from a fixed list, and pick the best draft in it."
    )
    return llm_client.generate_json(prompt, system=system)


def _pick(
    cands: list[dict[str, Any]], outcome: str, summary: str, transcript: str
) -> tuple[dict[str, Any], dict[str, Any], str] | None:
    """Returns (group, draft, product) or None when nothing fits."""
    if outcome == "no_answer":
        for g in cands:
            if _norm(g["name"]) == CALL_FAILED_GROUP:
                return g, g["drafts"][0], ""
        return None

    if not (summary or transcript):
        return None
    data = _with_timeout(_llm_select, _SELECT_TIMEOUT, cands, summary, transcript, outcome)
    if not isinstance(data, dict):
        return None
    try:
        gid = int(data.get("group_id"))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    group = next((g for g in cands if int(g["id"]) == gid), None)
    if group is None:
        return None
    draft = None
    try:
        did = int(data.get("draft_id"))  # type: ignore[arg-type]
        draft = next((d for d in group["drafts"] if int(d["id"]) == did), None)
    except (TypeError, ValueError):
        draft = None
    if draft is None:
        draft = group["drafts"][0]
    product = str(data.get("product") or "").strip()[:60]
    return group, draft, product


# --------------------------------------------------------------------------- writing


def _fill(text_in: str, ctx: dict[str, str]) -> str:
    out = text_in or ""
    if not (ctx.get("company_name") or "").strip():
        out = out.replace("Dear [company_name] Team,", "Dear Team,")
    for key, fallback in _FALLBACKS.items():
        val = (ctx.get(key) or "").strip() or fallback
        out = out.replace(f"[{key}]", val)
    return out


def _with_signature(body: str, agent_name: str) -> str:
    last = ""
    for ln in reversed(body.rstrip().splitlines()):
        if ln.strip():
            last = ln.strip()
            break
    if last.lower().rstrip(",") == "best regards":
        return body.rstrip() + f"\n{agent_name}\nKafi Commodities Export Team\nwww.kafi-group.com"
    return body


def _to_html(text_in: str) -> str:
    blocks = [b for b in re.split(r"\n{2,}", text_in.strip()) if b.strip()]
    parts = []
    for b in blocks:
        esc = html.escape(b, quote=False).replace("\n", "<br/>")
        esc = re.sub(r"(https?://[^\s<]+)", r'<a href="\1">\1</a>', esc)
        parts.append(f"<p>{esc}</p>")
    return "".join(parts)


_NUM = re.compile(r"\d[\d.,%]*")
_CAPS = re.compile(r"\b[A-Z][A-Z0-9\-]{1,}\b")


def _num_set(text_in: str) -> set[str]:
    return {t.strip(".,") for t in _NUM.findall(text_in)}


def _facts_preserved(original: str, rewritten: str) -> bool:
    """True only if the rewrite kept every fact: lines with digits verbatim, no new numbers,
    all-caps product/term tokens still present, and a sane length."""
    if not (rewritten or "").strip():
        return False
    n_low = rewritten.lower()
    for line in original.splitlines():
        s = line.strip()
        if s and re.search(r"\d", s) and s.lower() not in n_low:
            return False
    if not _num_set(rewritten) <= _num_set(original):
        return False
    for tok in set(_CAPS.findall(original)):
        if tok.lower() not in n_low:
            return False
    ratio = len(rewritten) / max(len(original), 1)
    return 0.6 <= ratio <= 1.5


def _llm_polish(body: str, summary: str) -> Any:
    from modules.llm_client import llm_client

    system = (
        "You adapt an approved sales email so it reads naturally for one specific phone call. "
        "You never change facts."
    )
    prompt = (
        "Adapt the wording of the opening and closing sentences of this approved email so it fits the "
        "call naturally. STRICT RULES: keep every line that contains a number, list item, product list, "
        "price, weight or website EXACTLY unchanged; do not add or remove products, prices, quantities, "
        "dates or promises; do not change names or the company name; keep it in English, polite and "
        "professional, and about the same length.\n\n"
        f"Call summary: {summary}\n\nApproved email:\n---\n{body}\n---\n\n"
        'Return JSON only: {"body": "<the full email text>"}'
    )
    data = llm_client.generate_json(prompt, system=system)
    new = data.get("body") if isinstance(data, dict) else None
    return new if isinstance(new, str) else None


# --------------------------------------------------------------------------- attachments


def _auto_catalogue_ids(product: str) -> list[str]:
    from modules.catalogues import CATALOGUES_DEF

    p = (product or "").lower()
    ids = {c["id"] for c in CATALOGUES_DEF}
    if "rice" in p:
        for cid in ids:  # a dedicated rice catalogue, once one is added
            if "rice" in cid.lower():
                return [cid]
    if "salt" in p:
        if any(k in p for k in ("non-edible", "non edible", "lamp", "decor", "wellness", "bath", "candle")):
            return ["non_edible_salt"] if "non_edible_salt" in ids else ["all_products"]
        if any(k in p for k in ("edible", "food", "culinary", "table", "cooking", "kitchen")):
            return ["edible_salt"] if "edible_salt" in ids else ["all_products"]
        return ["salt_catalogue"] if "salt_catalogue" in ids else ["all_products"]
    return ["all_products"]


def _public_base() -> str:
    try:
        from config import settings

        base = (getattr(settings, "twilio_webhook_base_url", None) or "").strip().rstrip("/")
    except Exception:  # noqa: BLE001
        base = ""
    if not base:
        dom = os.environ.get("RAILWAY_PUBLIC_DOMAIN", "").strip()
        base = f"https://{dom}" if dom else ""
    return base


def _prepare_attachments(ids: list[str]) -> tuple[list[dict[str, Any]], list[tuple[str, str]]]:
    """Returns (email attachments, [(title, download_url)] for files too big to attach)."""
    from modules.catalogues import (
        EMAIL_ATTACH_MAX_BYTES,
        attach_catalogues_as_attachments,
        get_catalogue_by_id,
    )

    attached: list[dict[str, Any]] = []
    links: list[tuple[str, str]] = []
    base = _public_base()
    for cid in ids:
        try:
            path, meta = get_catalogue_by_id(cid)
            size = path.stat().st_size
        except Exception:  # noqa: BLE001
            continue
        if size > EMAIL_ATTACH_MAX_BYTES:
            if base:
                links.append((meta["title"], f"{base}/api/catalogues/{meta['id']}/download"))
            continue
        attached.extend(attach_catalogues_as_attachments([cid]))
    return attached, links


# --------------------------------------------------------------------------- main entry


def try_situation_followup(
    db: Any,
    task: dict[str, Any],
    *,
    outcome: str,
    operator: Any,
    email: str | None,
    agent_name: str,
) -> dict[str, Any] | None:
    """Send the situation-based follow-up. None = nothing was sent (caller uses the old sender)."""
    mode = cf.get_mode()
    if mode == "off":
        return None
    if mode == "test_only" and not task.get("is_test"):
        return None
    if operator is None:
        return None
    phone = task.get("contact_phone")
    if not email and not phone:
        return None

    cands = _candidates()
    if not cands:
        print("Call follow-up situations: no enabled situation with a draft - using generic mail.", flush=True)
        return None

    summary = (task.get("call_summary") or "").strip()
    transcript = (task.get("call_transcript") or "").strip()
    if outcome != "no_answer" and not (summary or transcript) and task.get("call_sid"):
        try:
            from integrations.voice_client import voice_client

            info = _with_timeout(voice_client.fetch_outbound_status, _FETCH_TIMEOUT, task.get("call_sid"))
            if isinstance(info, dict):
                transcript = (info.get("call_transcript") or "").strip()
        except Exception:  # noqa: BLE001
            pass

    picked = _pick(cands, outcome, summary, transcript)
    if picked is None:
        print(
            f"Call follow-up situations: no situation chosen for task={task.get('id')} "
            f"(outcome={outcome}, summary={'yes' if summary else 'no'}, "
            f"transcript={'yes' if transcript else 'no'}) - using generic mail.",
            flush=True,
        )
        return None
    group, draft, product = picked

    ctx = {
        "contact_name": (task.get("contact_name") or "").strip(),
        "company_name": (task.get("company_name") or "").strip(),
        "agent_name": agent_name,
        "product": product,
        "country": (task.get("country") or "").strip(),
        "referrer_name": "",
    }
    if _norm(ctx["company_name"]) == "direct ai call":
        ctx["company_name"] = ""  # test-call placeholder, not a real company

    subject = _fill(draft.get("subject") or "Following our call - Kafi Commodities", ctx)
    body_text = _fill(draft.get("body") or "", ctx)
    wa_text = _fill(draft.get("whatsapp_text") or "", ctx).strip()

    if summary and outcome != "no_answer":
        polished = _with_timeout(_llm_polish, _POLISH_TIMEOUT, body_text, summary)
        if isinstance(polished, str) and _facts_preserved(body_text, polished):
            body_text = polished
        elif isinstance(polished, str):
            print("Call follow-up situations: polished text changed facts - using the saved draft.", flush=True)

    body_text = _with_signature(body_text, agent_name)

    mode_att = draft.get("attachment_mode") or "none"
    if mode_att == "catalogue":
        cat_ids = [str(c) for c in (draft.get("catalogue_ids") or [])]
    elif mode_att == "auto":
        cat_ids = _auto_catalogue_ids(product)
    else:
        cat_ids = []
    attachments: list[dict[str, Any]] = []
    links: list[tuple[str, str]] = []
    if cat_ids:
        try:
            attachments, links = _prepare_attachments(cat_ids)
        except Exception as exc:  # noqa: BLE001
            print(f"Call follow-up situations: attachments skipped ({exc})", flush=True)

    body_html = _to_html(body_text)
    if links:
        items = "".join(f'<li><a href="{u}">{html.escape(t)}</a></li>' for t, u in links)
        body_html += f"<p>Download link{'s' if len(links) > 1 else ''}:</p><ul>{items}</ul>"
        if wa_text:
            wa_text += "\n\n" + "\n".join(f"{t}: {u}" for t, u in links)

    # ---- sending: from here on we always return a result (never None) ----
    from integrations import whatsapp_bridge_client as bridge
    from integrations.mail_client import mail_client
    from modules.ai_sales_auto_mode import get_auto_mode_settings

    auto = get_auto_mode_settings()
    send_wa = True if not auto.get("enabled") else bool(auto.get("send_whatsapp_after_call"))
    send_em = True if not auto.get("enabled") else bool(auto.get("send_email_after_call"))

    result: dict[str, Any] = {
        "engine": "situations",
        "situation": group["name"],
        "draft": draft["name"],
        "whatsapp_status": "skipped",
        "whatsapp_message": None,
        "email_status": "skipped",
        "email_message": None,
        "email_to": email,
        "outcome": outcome,
    }

    if not send_wa:
        result["whatsapp_message"] = "Skipped - WhatsApp off in AI Auto Mode."
    elif not phone:
        result["whatsapp_message"] = "No phone on file for WhatsApp follow-up."
    elif not wa_text:
        result["whatsapp_message"] = "No WhatsApp text in this draft."
    else:
        try:
            status = bridge.bridge_status(operator.id, username=operator.username)
            if not status.get("connected"):
                result["whatsapp_status"] = "not_connected"
                result["whatsapp_message"] = "Personal WhatsApp is not connected (scan the QR)."
            else:
                bridge.bridge_send(
                    operator.id, to_phone=phone, message=wa_text, username=operator.username
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
                    db.add(
                        Interaction(
                            contact_id=contact.id,
                            channel=Channel.whatsapp,
                            direction=Direction.outbound,
                            content=wa_text,
                            status=InteractionStatus.sent,
                            handled_by=HandledBy.agent,
                            provider_message_id="baileys_ai_call_followup_situation",
                        )
                    )
                    db.commit()
                except Exception:  # noqa: BLE001
                    pass
        except Exception as exc:  # noqa: BLE001
            result["whatsapp_status"] = "error"
            result["whatsapp_message"] = str(exc)[:300]

    if not send_em:
        result["email_message"] = "Skipped - Email off in AI Auto Mode."
    elif not email:
        result["email_message"] = "No email address on file for this contact."
    else:
        try:
            sent = mail_client.send_approved(
                to=email,
                subject=subject,
                body=body_html,
                attachments=attachments or None,
                mailbox_user=operator,
            )
            result["email_status"] = sent.get("status") or "error"
            result["email_message"] = sent.get("message") or result["email_status"]
        except Exception as exc:  # noqa: BLE001
            result["email_status"] = "error"
            result["email_message"] = str(exc)[:300]

    print(
        f"Call follow-up situations: task={task.get('id')} situation={group['name']!r} "
        f"draft={draft['name']!r} product={product!r} email={result['email_status']} "
        f"whatsapp={result['whatsapp_status']}",
        flush=True,
    )
    return result
