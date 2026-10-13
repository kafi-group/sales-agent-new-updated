"""Personalized post-call follow-ups from closed captions → email + WhatsApp drafts."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, Literal

from sqlalchemy.orm import Session

from db.models import (
    AppUser,
    AppUserRole,
    Buyer,
    Contact,
    Interaction,
    PersonalizedFollowupDraft,
)
from modules.channel_sync import derive_whatsapp_from_email, sync_whatsapp_with_email

ELIGIBLE_OUTCOMES = frozenset(
    {"interested", "follow_up", "not_interested", "not_received_call"}
)
ACTIVE_STATUSES = frozenset({"awaiting_transcript", "generating", "ready", "failed"})

FollowupContext = Literal[
    "live_conversation",
    "voicemail_or_no_answer",
    "negative_call",
    "not_interested",
    "brief_or_unclear",
]

VOICEMAIL_LINE = re.compile(
    r"(?i)^\s*(voicemail|voice mail|answering machine|no answer|did not answer|"
    r"unreachable|not reachable|no pickup|went to voicemail)\s*$"
)
VOICEMAIL_IN_TEXT = re.compile(
    r"(?i)\b(voicemail|voice mail|answering machine|left (?:a )?message|"
    r"could not connect|unable to reach|no one answered|went straight to voicemail)\b"
)
PROFANITY_HINT = re.compile(
    r"(?i)\b(fuck|shit|damn|bitch|asshole|idiot|stupid|bullshit|piss off|get lost)\b"
)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _sanitize_no_attachment_language(subject: str, body: str) -> tuple[str, str]:
    """Strip attachment wording — post-call sends have no files attached."""
    import re

    attachment_phrases = re.compile(
        r"(?i)\b("
        r"please find (?:the )?attach(?:ed|ment)|"
        r"find attach(?:ed|ment)|"
        r"see attach(?:ed|ment)|"
        r"attach(?:ed|ment) (?:is|are|herewith|below|for your reference)|"
        r"as attach(?:ed|ment)|"
        r"enclosed (?:is|are|please find)"
        r")\b[^.\n]*[.\n]?"
    )

    cleaned_body = attachment_phrases.sub("", body or "").strip()
    cleaned_body = re.sub(r"\n{3,}", "\n\n", cleaned_body)
    cleaned_subject = re.sub(
        r"(?i)\b(?:attached|attachment|enclosed)\b",
        "",
        subject or "",
    ).strip()
    cleaned_subject = re.sub(r"\s{2,}", " ", cleaned_subject)
    return cleaned_subject or subject, cleaned_body or body


def _is_admin(user: AppUser) -> bool:
    role = user.role.value if isinstance(user.role, AppUserRole) else str(user.role)
    return role == AppUserRole.admin.value


def _call_notes(interaction: Interaction) -> str:
    from modules.calls import parse_call_fields

    return (parse_call_fields(interaction.content).get("notes") or "").strip()


def _transcript_text(interaction: Interaction) -> str | None:
    from modules.call_media import get_call_media

    media = get_call_media(interaction) or {}
    if (media.get("transcript_status") or "").lower() != "ready":
        return None
    text = (media.get("transcript") or "").strip()
    return text or None


def _notes_indicate_voicemail(notes: str) -> bool:
    """True when remarks explicitly tag Voicemail (not No voicemail)."""
    for line in (notes or "").splitlines():
        key = line.strip().lower()
        if key == "voicemail":
            return True
        if key == "no voicemail":
            return False
    return False


def classify_call_followup_context(
    *,
    call_outcome: str | None,
    notes: str,
    transcript: str | None,
) -> FollowupContext:
    """Decide which follow-up tone to use — never assume a live chat on voicemail."""
    outcome = (call_outcome or "").strip().lower()
    notes_text = (notes or "").strip()
    transcript_text = (transcript or "").strip()
    combined = f"{notes_text}\n{transcript_text}"

    if outcome == "not_interested":
        return "not_interested"

    if outcome == "not_received_call" or _notes_indicate_voicemail(notes_text):
        return "voicemail_or_no_answer"

    if VOICEMAIL_IN_TEXT.search(combined) and len(transcript_text) < 120:
        return "voicemail_or_no_answer"

    for line in notes_text.splitlines():
        if VOICEMAIL_LINE.match(line.strip()):
            return "voicemail_or_no_answer"

    if transcript_text and PROFANITY_HINT.search(transcript_text):
        return "negative_call"

    if len(transcript_text) >= 80:
        return "live_conversation"

    if outcome in {"interested", "follow_up"} and len(notes_text) >= 30:
        return "live_conversation"

    if not transcript_text and not notes_text:
        return "brief_or_unclear"

    if len(transcript_text) < 40 and not notes_text:
        return "voicemail_or_no_answer"

    return "brief_or_unclear"


def _context_label(context: FollowupContext) -> str:
    return {
        "live_conversation": "Live phone conversation",
        "voicemail_or_no_answer": "Voicemail / could not connect",
        "negative_call": "Difficult call — stay professional",
        "not_interested": "Not interested",
        "brief_or_unclear": "Brief or unclear call",
    }[context]


def _fallback_followup_message(
    *,
    call_context: FollowupContext,
    company: str,
    contact_name: str,
    country: str,
) -> tuple[str, str]:
    market = country or "your market"
    if call_context == "voicemail_or_no_answer":
        return (
            f"Following up — Kafi Commodities & {company}",
            (
                f"Dear {contact_name},\n\n"
                f"We tried reaching you by phone today regarding {company} but were unable to "
                f"connect. We would be glad to introduce Kafi Commodities and our ESSENCE range "
                f"(rice, spices, sauces, pickles, Himalayan salt, and related products) for "
                f"{market}.\n\n"
                f"Please reply with a convenient time to call back, or let us know if email or "
                f"WhatsApp works better for you.\n\n"
                f"Best regards,\nKafi Commodities Export Team"
            ),
        )
    if call_context == "negative_call":
        return (
            f"Following up — Kafi Commodities & {company}",
            (
                f"Dear {contact_name},\n\n"
                f"Thank you for taking our call today. We appreciate your time and would like to "
                f"keep the conversation focused on how Kafi Commodities can support {company} "
                f"with ESSENCE food exports from Pakistan.\n\n"
                f"If useful, we can share product categories and specifications at your "
                f"convenience — with no obligation.\n\n"
                f"Best regards,\nKafi Commodities Export Team"
            ),
        )
    if call_context == "not_interested":
        return (
            "Thank you — Kafi Commodities",
            (
                f"Dear {contact_name},\n\n"
                f"Thank you for your time on our call today. We understand {company} may not be "
                f"looking to proceed at the moment.\n\n"
                f"Should your requirements change, we remain available for ESSENCE product "
                f"information from Kafi Commodities.\n\n"
                f"Best regards,\nKafi Commodities Export Team"
            ),
        )
    if call_context == "brief_or_unclear":
        return (
            f"Following up — Kafi Commodities & {company}",
            (
                f"Dear {contact_name},\n\n"
                f"We attempted to connect with {company} by phone today. We would welcome a "
                f"brief conversation about ESSENCE exports from Kafi Commodities when "
                f"convenient.\n\n"
                f"Please let us know a suitable time to reach you.\n\n"
                f"Best regards,\nKafi Commodities Export Team"
            ),
        )
    return (
        f"Following our call — Kafi Commodities & {company}",
        (
            f"Dear {contact_name},\n\n"
            f"Thank you for speaking with us today. As discussed, this message confirms our "
            f"conversation regarding {company} and Kafi Commodities' ESSENCE product range.\n\n"
            f"We remain at your service for specifications, samples, or pricing whenever "
            f"convenient for you.\n\n"
            f"Best regards,\nKafi Commodities Export Team"
        ),
    )


def _llm_system_for_context(call_context: FollowupContext) -> str:
    base = (
        "You write concise follow-up emails for Kafi Commodities (Pakistan food exporter). "
        "Always professional — never echo profanity, insults, or aggressive language from "
        "call captions. Return JSON only. One message is used for both email and WhatsApp."
    )
    if call_context == "voicemail_or_no_answer":
        return (
            base
            + " The rep did NOT speak with a live buyer — do not claim a conversation happened."
        )
    return base


def _llm_prompt_for_context(
    *,
    call_context: FollowupContext,
    context_label: str,
    outcome_label: str,
    company: str,
    contact_name: str,
    country: str,
    excerpt: str,
) -> str:
    shared_rules = """
Return JSON only with keys:
- subject: email subject line (max 90 chars)
- email_body: about 60–100 words, warm and professional

Rules:
- Do not invent product quantities, prices, or meeting times not in the source.
- NEVER mention attachments or enclosed files — plain text only.
- Sign as Kafi Commodities Export Team.
- Same body will be sent on WhatsApp.
"""
    if call_context == "live_conversation":
        return f"""Write a call-confirmation follow-up for Kafi Commodities.

Context: {context_label}
Call outcome: {outcome_label}
Company: {company}
Contact: {contact_name}
Country: {country or "unknown"}

Call transcript / remarks:
---
{excerpt}
---

- Start by confirming the phone conversation ("As per our call today…" or similar).
- Reference 1–2 concrete business points from the transcript (products, market, next steps).
- NEVER repeat rude language from the transcript — summarize business substance only.
{shared_rules}"""

    if call_context == "voicemail_or_no_answer":
        return f"""Write a follow-up for Kafi Commodities after a MISSED call (voicemail / no answer).

Context: {context_label}
Call outcome: {outcome_label}
Company: {company}
Contact: {contact_name}
Country: {country or "unknown"}

Rep notes / system transcript (may be voicemail greeting only):
---
{excerpt}
---

CRITICAL: No live conversation took place. Do NOT write "as per our call", "pleasure connecting",
"as discussed", or imply the buyer answered.

Instead:
- Say we tried to reach them by phone today but could not connect.
- Briefly mention ESSENCE exports (rice, spices, sauces, pickles, salt).
- Invite them to reply with a convenient time or preferred channel.
{shared_rules}"""

    if call_context == "negative_call":
        return f"""Write a diplomatic follow-up after a difficult phone call.

Context: {context_label}
Company: {company}
Contact: {contact_name}

Transcript / remarks:
---
{excerpt}
---

- Stay calm and professional; do not reference conflict, swearing, or tone.
- Focus on how Kafi can support their business with ESSENCE products.
- Do not claim specific agreements unless clearly stated in the transcript.
{shared_rules}"""

    if call_context == "not_interested":
        return f"""Write a polite closing note after the buyer indicated they are not interested.

Company: {company}
Contact: {contact_name}

Remarks:
---
{excerpt}
---

- Thank them for their time; leave the door open without pressure.
{shared_rules}"""

    return f"""Write a cautious follow-up when the call was brief or unclear.

Context: {context_label}
Company: {company}
Contact: {contact_name}

Source:
---
{excerpt}
---

- Do NOT assume a full conversation happened.
- Say we attempted to connect and invite them to suggest a better time.
{shared_rules}"""


def _classify_phone_type(phone: str, label_hint: str = "") -> tuple[str, bool, bool]:
    """Classify phone number type and WhatsApp capability.

    Returns: (type: "mobile"|"landline"|"unknown", is_landline: bool, wa_supported: bool)
    """
    clean = "".join(ch for ch in phone if ch.isdigit())
    # UAE (+971)
    if clean.startswith("971"):
        # Landlines: +971 2 (Abu Dhabi), +971 3 (Al Ain), +971 4 (Dubai), +971 6 (Sharjah/Ajman), +971 7 (RAK), +971 9 (Fujairah)
        if any(clean.startswith(p) for p in ("9712", "9713", "9714", "9716", "9717", "9719")):
            return "landline", True, False
        # Mobiles: +971 50, 52, 54, 55, 56, 58
        if any(clean.startswith(p) for p in ("97150", "97152", "97154", "97155", "97156", "97158")):
            return "mobile", False, True
    # Saudi (+966)
    if clean.startswith("966"):
        if clean.startswith("9665"):
            return "mobile", False, True
        if any(clean.startswith(p) for p in ("96611", "96612", "96613", "96614", "96616", "96617")):
            return "landline", True, False
    # Pakistan (+92)
    if clean.startswith("92"):
        if clean.startswith("923"):
            return "mobile", False, True
        if any(clean.startswith(p) for p in ("9221", "9242", "9251", "9291", "9261", "9281")):
            return "landline", True, False
    # UK (+44)
    if clean.startswith("44"):
        if clean.startswith("447"):
            return "mobile", False, True
        if any(clean.startswith(p) for p in ("441", "442")):
            return "landline", True, False
    # US/Canada (+1)
    if clean.startswith("1") and len(clean) == 11:
        return "mobile", False, True

    hint = (label_hint or "").lower()
    if "mobile" in hint or "cell" in hint or "whatsapp" in hint:
        return "mobile", False, True
    if "landline" in hint or "office" in hint or "fax" in hint or "tel" in hint:
        return "landline", True, False

    return "unknown", False, True


def get_available_phones_for_draft(db: Session, draft: PersonalizedFollowupDraft) -> list[dict[str, Any]]:
    """Gather, deduplicate, and classify all available phone numbers for this lead/contact."""
    from integrations.voice_client import normalize_e164
    from modules.calls import parse_call_fields

    interaction = db.get(Interaction, draft.interaction_id) if draft.interaction_id else None
    dialed_raw = parse_call_fields(interaction.content).get("lead_phone") if interaction else None
    dialed_e164 = normalize_e164(dialed_raw) if dialed_raw else None

    contact = db.get(Contact, draft.contact_id) if draft.contact_id else None
    buyer = db.get(Buyer, draft.buyer_id) if draft.buyer_id else None

    raw_list: list[dict[str, Any]] = []

    if contact:
        if contact.phone:
            raw_list.append({"phone": contact.phone, "label": "Primary Mobile", "contact_name": contact.full_name})
        if contact.secondary_mobile:
            raw_list.append({"phone": contact.secondary_mobile, "label": "Secondary Mobile", "contact_name": contact.full_name})
        if contact.primary_phone:
            raw_list.append({"phone": contact.primary_phone, "label": "Office Phone", "contact_name": contact.full_name})
        if contact.secondary_phone:
            raw_list.append({"phone": contact.secondary_phone, "label": "Secondary Landline", "contact_name": contact.full_name})
        if contact.wa_id and contact.wa_id != contact.phone:
            raw_list.append({"phone": contact.wa_id, "label": "WhatsApp Number", "contact_name": contact.full_name})

    if buyer and buyer.contacts:
        for c in buyer.contacts:
            if contact and c.id == contact.id:
                continue
            if c.phone:
                raw_list.append({"phone": c.phone, "label": f"{c.full_name} (Mobile)", "contact_name": c.full_name})
            if c.secondary_mobile:
                raw_list.append({"phone": c.secondary_mobile, "label": f"{c.full_name} (Secondary)", "contact_name": c.full_name})
            if c.primary_phone:
                raw_list.append({"phone": c.primary_phone, "label": f"{c.full_name} (Office)", "contact_name": c.full_name})

    if dialed_raw:
        raw_list.insert(0, {
            "phone": dialed_raw,
            "label": "Dialed Number",
            "contact_name": contact.full_name if contact else None,
        })

    seen_e164: set[str] = set()
    result: list[dict[str, Any]] = []
    for item in raw_list:
        raw_p = (item.get("phone") or "").strip()
        if not raw_p:
            continue
        e164 = normalize_e164(raw_p) or raw_p
        if e164 in seen_e164:
            continue
        seen_e164.add(e164)

        is_dialed = bool((dialed_e164 and e164 == dialed_e164) or (dialed_raw and raw_p == dialed_raw))
        ptype, is_landline, wa_supported = _classify_phone_type(e164, item.get("label", ""))

        result.append({
            "phone": e164,
            "raw": raw_p,
            "label": item.get("label", "Phone"),
            "contact_name": item.get("contact_name"),
            "is_dialed": is_dialed,
            "type": ptype,
            "is_landline": is_landline,
            "wa_supported": wa_supported,
        })

    # Sort so dialed or mobile numbers appear first, followed by landlines
    result.sort(key=lambda x: (not x["is_dialed"], x["is_landline"]))
    return result


def _normalize_email_addr(raw: str | None) -> str:
    return (raw or "").strip().lower()


def get_available_emails_for_draft(db: Session, draft: PersonalizedFollowupDraft) -> list[dict[str, Any]]:
    """Gather and deduplicate all emails on the lead's contact(s)."""
    contact = db.get(Contact, draft.contact_id) if draft.contact_id else None
    buyer = db.get(Buyer, draft.buyer_id) if draft.buyer_id else None

    raw_list: list[dict[str, Any]] = []

    if contact:
        if contact.email:
            raw_list.append({
                "email": contact.email,
                "label": "Primary Email",
                "contact_name": contact.full_name,
                "contact_id": contact.id,
                "is_primary": True,
            })
        if contact.secondary_email:
            raw_list.append({
                "email": contact.secondary_email,
                "label": "Secondary Email",
                "contact_name": contact.full_name,
                "contact_id": contact.id,
                "is_primary": False,
            })

    if buyer and buyer.contacts:
        for c in buyer.contacts:
            if contact and c.id == contact.id:
                continue
            if c.email:
                raw_list.append({
                    "email": c.email,
                    "label": f"{c.full_name} (Primary)",
                    "contact_name": c.full_name,
                    "contact_id": c.id,
                    "is_primary": True,
                })
            if c.secondary_email:
                raw_list.append({
                    "email": c.secondary_email,
                    "label": f"{c.full_name} (Secondary)",
                    "contact_name": c.full_name,
                    "contact_id": c.id,
                    "is_primary": False,
                })

    seen: set[str] = set()
    result: list[dict[str, Any]] = []
    for item in raw_list:
        raw_e = (item.get("email") or "").strip()
        if not raw_e or "@" not in raw_e:
            continue
        key = _normalize_email_addr(raw_e)
        if key in seen:
            continue
        seen.add(key)
        result.append({
            "email": raw_e,
            "label": item.get("label") or "Email",
            "contact_name": item.get("contact_name"),
            "contact_id": item.get("contact_id"),
            "is_primary": bool(item.get("is_primary")),
        })

    # Prefer the draft contact's primary email first
    if contact and contact.email:
        primary_key = _normalize_email_addr(contact.email)
        result.sort(key=lambda x: (0 if _normalize_email_addr(x["email"]) == primary_key else 1, x["label"]))
    return result


def draft_to_dict(db: Session, draft: PersonalizedFollowupDraft) -> dict[str, Any]:
    from modules.call_media import get_ai_training_selected, get_call_media, public_call_media

    buyer = db.get(Buyer, draft.buyer_id)
    contact = db.get(Contact, draft.contact_id) if draft.contact_id else None
    interaction = db.get(Interaction, draft.interaction_id)
    notes = _call_notes(interaction) if interaction else ""
    transcript = _transcript_text(interaction) if interaction else None
    call_context = classify_call_followup_context(
        call_outcome=draft.call_outcome,
        notes=notes,
        transcript=transcript,
    )
    available_phones = get_available_phones_for_draft(db, draft)
    selected_phone = None
    if available_phones:
        # Default to first non-landline dialed, or first mobile, or first phone
        mobile_dialed = next((p["phone"] for p in available_phones if p["is_dialed"] and not p["is_landline"]), None)
        dialed = next((p["phone"] for p in available_phones if p["is_dialed"]), None)
        first_mobile = next((p["phone"] for p in available_phones if not p["is_landline"]), None)
        selected_phone = mobile_dialed or dialed or first_mobile or available_phones[0]["phone"]

    available_emails = get_available_emails_for_draft(db, draft)
    selected_email = None
    if available_emails:
        selected_email = available_emails[0]["email"]
    elif contact and contact.email:
        selected_email = contact.email

    media = public_call_media(get_call_media(interaction), interaction_id=draft.interaction_id) if interaction else {}

    return {
        "id": draft.id,
        "interaction_id": draft.interaction_id,
        "buyer_id": draft.buyer_id,
        "company_name": buyer.company_name if buyer else None,
        "country": buyer.country if buyer else None,
        "contact_id": draft.contact_id,
        "contact_name": contact.full_name if contact else None,
        "contact_email": contact.email if contact else None,
        "contact_phone": (contact.phone or contact.wa_id) if contact else None,
        "available_phones": available_phones,
        "selected_phone": selected_phone,
        "available_emails": available_emails,
        "selected_email": selected_email,
        "created_by_user_id": draft.created_by_user_id,
        "call_outcome": draft.call_outcome,
        "call_context": call_context,
        "call_context_label": _context_label(call_context),
        "status": draft.status,
        "subject": draft.subject,
        "email_body": draft.email_body,
        "whatsapp_body": draft.whatsapp_body,
        "transcript_excerpt": draft.transcript_excerpt,
        "generation_error": draft.generation_error,
        "email_send_status": draft.email_send_status,
        "whatsapp_send_status": draft.whatsapp_send_status,
        "whatsapp_personal_send_status": draft.whatsapp_personal_send_status,
        "email_send_message": draft.email_send_message,
        "whatsapp_send_message": draft.whatsapp_send_message,
        "whatsapp_personal_send_message": draft.whatsapp_personal_send_message,
        "sent_at": draft.sent_at.isoformat() if draft.sent_at else None,
        "created_at": draft.created_at.isoformat() if draft.created_at else None,
        "updated_at": draft.updated_at.isoformat() if draft.updated_at else None,
        "transcript": transcript or media.get("transcript"),
        "transcript_status": media.get("transcript_status"),
        "recording_available": bool(media.get("recording_available")),
        "ai_training_selected": get_ai_training_selected(interaction) if interaction else False,
    }


def ensure_draft_for_call(
    db: Session,
    *,
    interaction_id: int,
    call_outcome: str,
    user_id: int | None,
    generate_now: bool = True,
) -> PersonalizedFollowupDraft | None:
    """Create or refresh a personalized draft after any completed call with remarks/outcome."""
    outcome = (call_outcome or "").strip().lower() or "follow_up"

    interaction = db.get(Interaction, interaction_id)
    if not interaction:
        return None
    contact = db.get(Contact, interaction.contact_id)
    if not contact:
        return None

    draft = (
        db.query(PersonalizedFollowupDraft)
        .filter(PersonalizedFollowupDraft.interaction_id == interaction_id)
        .one_or_none()
    )
    if draft and draft.status == "sent":
        return draft

    if not draft:
        draft = PersonalizedFollowupDraft(
            interaction_id=interaction_id,
            buyer_id=contact.buyer_id,
            contact_id=contact.id,
            created_by_user_id=user_id,
            call_outcome=outcome,
            status="awaiting_transcript",
        )
        db.add(draft)
    else:
        draft.call_outcome = outcome
        draft.contact_id = contact.id
        draft.buyer_id = contact.buyer_id
        if user_id and not draft.created_by_user_id:
            draft.created_by_user_id = user_id
        if draft.status in {"dismissed", "failed"}:
            draft.status = "awaiting_transcript"
            draft.generation_error = None

    db.commit()
    db.refresh(draft)

    if generate_now:
        return generate_draft_content(db, draft.id)
    return draft


def generate_draft_content(db: Session, draft_id: int) -> PersonalizedFollowupDraft:
    draft = db.get(PersonalizedFollowupDraft, draft_id)
    if not draft:
        raise ValueError("Personalized draft not found")
    if draft.status == "sent":
        return draft

    interaction = db.get(Interaction, draft.interaction_id)
    if not interaction:
        raise ValueError("Call interaction not found")

    buyer = db.get(Buyer, draft.buyer_id)
    contact = db.get(Contact, draft.contact_id) if draft.contact_id else None
    transcript = _transcript_text(interaction)
    notes = _call_notes(interaction)

    if not transcript and not notes:
        draft.status = "awaiting_transcript"
        draft.generation_error = (
            "Waiting for closed captions (or call remarks) before drafting the message."
        )
        db.commit()
        db.refresh(draft)
        return draft

    draft.status = "generating"
    draft.generation_error = None
    db.commit()

    company = buyer.company_name if buyer else "the client"
    contact_name = (contact.full_name if contact else None) or "Sir/Madam"
    country = (buyer.country if buyer else None) or ""
    outcome_label = (
        "Client is Interested" if draft.call_outcome == "interested" else "Follow up"
    )

    call_context = classify_call_followup_context(
        call_outcome=draft.call_outcome,
        notes=notes,
        transcript=transcript,
    )
    context_label = _context_label(call_context)

    source = transcript or notes
    excerpt = source[:4000]
    draft.transcript_excerpt = excerpt[:2000]

    fallback_subject, fallback_email = _fallback_followup_message(
        call_context=call_context,
        company=company,
        contact_name=contact_name,
        country=country,
    )

    subject = fallback_subject
    email_body = fallback_email

    try:
        from modules.llm_client import llm_client

        if llm_client.enabled:
            from modules.llm_client import with_email_reply_standards

            prompt = with_email_reply_standards(_llm_prompt_for_context(
                call_context=call_context,
                context_label=context_label,
                outcome_label=outcome_label,
                company=company,
                contact_name=contact_name,
                country=country,
                excerpt=excerpt,
            ))
            data = llm_client.generate_json(
                prompt,
                system=_llm_system_for_context(call_context),
            )
            subject = (data.get("subject") or subject).strip()[:500] or subject
            email_body = (data.get("email_body") or email_body).strip() or email_body
            # Safety net: never send "as per our call" on voicemail drafts.
            if call_context in {"voicemail_or_no_answer", "brief_or_unclear"}:
                if re.search(r"(?i)as per our (call|conversation|discussion)", email_body):
                    subject, email_body = fallback_subject, fallback_email
    except Exception as exc:  # noqa: BLE001
        draft.generation_error = f"Used fallback draft ({exc})"

    subject, email_body = _sanitize_no_attachment_language(subject, email_body)

    # Email is source of truth — WhatsApp always mirrors the same information.
    whatsapp_body = derive_whatsapp_from_email(email_body)

    draft.subject = subject
    draft.email_body = email_body
    draft.whatsapp_body = whatsapp_body
    draft.status = "ready"
    if not draft.generation_error:
        draft.generation_error = None
    db.commit()
    db.refresh(draft)
    return draft


def maybe_generate_for_interaction(db: Session, interaction_id: int) -> None:
    """Called when closed captions become ready — fill drafts still waiting."""
    draft = (
        db.query(PersonalizedFollowupDraft)
        .filter(PersonalizedFollowupDraft.interaction_id == interaction_id)
        .one_or_none()
    )
    if not draft or draft.status == "sent":
        return
    if draft.status in {"awaiting_transcript", "failed", "generating"}:
        generate_draft_content(db, draft.id)


def dismiss_draft_for_ineligible_outcome(
    db: Session, *, interaction_id: int, call_outcome: str | None
) -> None:
    """Drop unsent drafts when the call is marked Not interested / Did not receive."""
    outcome = (call_outcome or "").strip().lower()
    if outcome in ELIGIBLE_OUTCOMES:
        return
    draft = (
        db.query(PersonalizedFollowupDraft)
        .filter(PersonalizedFollowupDraft.interaction_id == interaction_id)
        .one_or_none()
    )
    if not draft or draft.status == "sent":
        return
    draft.status = "dismissed"
    db.commit()


def list_drafts(
    db: Session,
    *,
    viewer: AppUser,
    status: str | None = None,
    limit: int = 100,
) -> dict[str, Any]:
    q = db.query(PersonalizedFollowupDraft)
    if status:
        q = q.filter(PersonalizedFollowupDraft.status == status.strip().lower())
    else:
        q = q.filter(PersonalizedFollowupDraft.status.in_(sorted(ACTIVE_STATUSES)))

    total = q.count()
    rows = (
        q.order_by(PersonalizedFollowupDraft.created_at.desc())
        .limit(min(max(1, limit), 200))
        .all()
    )
    ready_q = db.query(PersonalizedFollowupDraft).filter(
        PersonalizedFollowupDraft.status == "ready"
    )
    return {
        "total": total,
        "pending_count": int(ready_q.count() or 0),
        "rows": [draft_to_dict(db, row) for row in rows],
    }


def get_draft_for_interaction(
    db: Session,
    *,
    interaction_id: int,
) -> dict[str, Any] | None:
    draft = (
        db.query(PersonalizedFollowupDraft)
        .filter(PersonalizedFollowupDraft.interaction_id == interaction_id)
        .order_by(PersonalizedFollowupDraft.created_at.desc())
        .first()
    )
    if not draft:
        return None
    return draft_to_dict(db, draft)


def update_draft(
    db: Session,
    draft_id: int,
    *,
    subject: str | None = None,
    email_body: str | None = None,
    whatsapp_body: str | None = None,
) -> PersonalizedFollowupDraft:
    """Update draft subject, email body, and/or WhatsApp message."""
    draft = db.get(PersonalizedFollowupDraft, draft_id)
    if not draft:
        raise ValueError("Personalized draft not found")
    if draft.status == "sent":
        raise ValueError("This follow-up was already sent")
    if subject is not None:
        draft.subject = subject.strip()[:500]
    if email_body is not None:
        draft.email_body = email_body.strip()
    if whatsapp_body is not None:
        draft.whatsapp_body = whatsapp_body.strip()
    elif email_body is not None and not draft.whatsapp_body:
        draft.whatsapp_body = derive_whatsapp_from_email(draft.email_body or "")
    if draft.status in {"awaiting_transcript", "failed", "generating"} and draft.email_body:
        draft.status = "ready"
    db.commit()
    db.refresh(draft)
    return draft


def translate_draft_content(
    *,
    language: str,
    subject: str,
    email_body: str,
    whatsapp_body: str,
) -> dict[str, str]:
    """Translate follow-up subject/bodies into the recipient's local language.

    Returns translated fields only (caller decides whether to persist).
    """
    from modules.followup_languages import resolve_followup_language
    from modules.llm_client import llm_client

    lang = resolve_followup_language(language)
    code = lang["code"]
    if code == "en":
        return {
            "language": "en",
            "language_label": lang["label"],
            "subject": (subject or "").strip(),
            "email_body": (email_body or "").strip(),
            "whatsapp_body": (whatsapp_body or "").strip()
            or derive_whatsapp_from_email((email_body or "").strip()),
        }

    native = lang["native"]
    prompt = f"""Translate this B2B sales follow-up into {native} for an importer/buyer.

Rules:
- Keep the same meaning, tone, and business intent (Kafi Commodities food export follow-up).
- Keep company names, person names, product names, SKUs, Incoterms, and email addresses unchanged when they are proper nouns / codes.
- Subject should stay concise.
- Email and WhatsApp should both be fully in {native} (natural business writing for that language).
- WhatsApp may be slightly shorter than email but must match the same points.
- Return JSON only with keys: subject, email_body, whatsapp_body.

Subject:
{(subject or "").strip()}

Email:
{(email_body or "").strip()}

WhatsApp:
{(whatsapp_body or email_body or "").strip()}
"""
    try:
        data = llm_client.generate_json(
            prompt,
            system=(
                f"You are a professional B2B translator. Output valid JSON only. "
                f"Target language: {native}."
            ),
        )
    except Exception:
        # Offline / no Gemini — leave English so the rep can still edit/send.
        data = {}

    out_subject = str(data.get("subject") or subject or "").strip()[:500]
    out_email = str(data.get("email_body") or email_body or "").strip()
    out_wa = str(data.get("whatsapp_body") or "").strip()
    if not out_wa:
        out_wa = derive_whatsapp_from_email(out_email)
    return {
        "language": code,
        "language_label": lang["label"],
        "subject": out_subject,
        "email_body": out_email,
        "whatsapp_body": out_wa,
    }


def dismiss_draft(db: Session, draft_id: int) -> PersonalizedFollowupDraft:
    draft = db.get(PersonalizedFollowupDraft, draft_id)
    if not draft:
        raise ValueError("Personalized draft not found")
    draft.status = "dismissed"
    db.commit()
    db.refresh(draft)
    return draft


def send_draft(
    db: Session,
    draft_id: int,
    *,
    user: AppUser,
    channels: str | list[str] | None = None,
    target_phone: str | None = None,
    target_email: str | None = None,
    subject: str | None = None,
    email_body: str | None = None,
    whatsapp_body: str | None = None,
    template_name: str | None = None,
    template_language: str = "en_US",
    template_variables: list[str] | None = None,
    attachments: list[dict] | None = None,
) -> dict[str, Any]:
    """Send the reviewed message via email and/or WhatsApp (human-approved).

    ``channels``: ``"email"`` | ``"whatsapp"`` | ``"both"`` (default), or a list
    of channel names. Outside the 24h WhatsApp window, pass an approved
    ``template_name`` (+ variables) or the WhatsApp send will fail with a
    template-required message the UI can surface.
    """
    draft = db.get(PersonalizedFollowupDraft, draft_id)
    if not draft:
        raise ValueError("Personalized draft not found")

    channel_set: set[str]
    if channels is None:
        channel_set = {"email", "whatsapp"}
    elif isinstance(channels, str):
        key = channels.strip().lower()
        if key in {"all", "all_three", "everything", "email_whatsapp_personal"}:
            channel_set = {"email", "whatsapp", "whatsapp_personal"}
        elif key in {"both", "all", "email+whatsapp", "email_whatsapp"}:
            channel_set = {"email", "whatsapp"}
        elif key in {"email", "whatsapp", "whatsapp_personal"}:
            channel_set = {key}
        else:
            raise ValueError(
                "channels must be 'email', 'whatsapp', 'whatsapp_personal', 'both', or 'all'"
            )
    else:
        channel_set = {str(c).strip().lower() for c in channels if str(c).strip()}
        channel_set &= {"email", "whatsapp", "whatsapp_personal"}
        if not channel_set:
            raise ValueError("Select at least one channel")

    send_email = "email" in channel_set
    send_whatsapp = "whatsapp" in channel_set
    send_whatsapp_personal = "whatsapp_personal" in channel_set

    email_already_ok = (draft.email_send_status or "") in {"sent", "queued"}
    wa_already_ok = draft.whatsapp_send_status == "sent"
    wa_personal_already_ok = draft.whatsapp_personal_send_status == "sent"

    if draft.status == "sent" and (
        (not send_email or email_already_ok)
        and (not send_whatsapp or wa_already_ok)
        and (not send_whatsapp_personal or wa_personal_already_ok)
    ):
        raise ValueError("This follow-up was already sent on the selected channel(s)")

    # Skip channels that already succeeded (retry only the failed ones).
    if send_email and email_already_ok:
        send_email = False
    if send_whatsapp and wa_already_ok:
        send_whatsapp = False
    if send_whatsapp_personal and wa_personal_already_ok:
        send_whatsapp_personal = False
    if not send_email and not send_whatsapp and not send_whatsapp_personal:
        raise ValueError("Selected channel(s) were already sent")

    if subject is not None:
        draft.subject = subject.strip()[:500]
    if email_body is not None:
        draft.email_body = email_body.strip()
    if whatsapp_body is not None:
        draft.whatsapp_body = whatsapp_body.strip()
    elif not draft.whatsapp_body:
        draft.whatsapp_body = derive_whatsapp_from_email(draft.email_body or "")
    db.commit()

    body_text = (draft.email_body or "").strip()
    wa_text = (draft.whatsapp_body or draft.email_body or "").strip()

    if send_email:
        if not (draft.subject or "").strip() or not body_text:
            raise ValueError("Subject and email body are required before sending email")

    interaction = db.get(Interaction, draft.interaction_id)
    notes = _call_notes(interaction) if interaction else ""
    transcript = _transcript_text(interaction) if interaction else None
    call_context = classify_call_followup_context(
        call_outcome=draft.call_outcome,
        notes=notes,
        transcript=transcript,
    )
    if body_text and call_context in {"voicemail_or_no_answer", "brief_or_unclear"}:
        if re.search(r"(?i)\b(as per our (call|conversation|discussion)|following our call|thank you for speaking with us today)\b", body_text):
            raise ValueError(
                "This draft assumes a live phone conversation, but the call was voicemail or "
                "could not connect. Edit the message or click Regenerate before sending."
            )
    if body_text and call_context == "negative_call":
        if PROFANITY_HINT.search(body_text):
            raise ValueError(
                "Remove any quoted profanity from the draft before sending — keep the tone professional."
            )
    if send_whatsapp and not wa_text and not (template_name or "").strip():
        raise ValueError("Message body is required before sending WhatsApp (Meta)")
    if send_whatsapp_personal and not wa_text:
        raise ValueError("Message body is required before sending WhatsApp Personal")

    from modules.comms_generator import get_comms
    from integrations.voice_client import normalize_e164

    contact = db.get(Contact, draft.contact_id) if draft.contact_id else None
    recipient_wa_phone = None
    if target_phone and target_phone.strip():
        recipient_wa_phone = normalize_e164(target_phone.strip()) or target_phone.strip()
    elif contact and (contact.phone or contact.wa_id):
        recipient_wa_phone = normalize_e164(contact.phone or contact.wa_id) or (contact.phone or contact.wa_id)
    elif interaction:
        from modules.calls import parse_call_fields
        dialed_p = parse_call_fields(interaction.content).get("lead_phone")
        if dialed_p:
            recipient_wa_phone = normalize_e164(dialed_p) or dialed_p

    available_emails = get_available_emails_for_draft(db, draft)
    recipient_email = (target_email or "").strip() or None
    if not recipient_email:
        if available_emails:
            recipient_email = available_emails[0]["email"]
        elif contact and (contact.email or "").strip():
            recipient_email = contact.email.strip()

    comms = get_comms()
    email_status = draft.email_send_status
    email_message = draft.email_send_message
    wa_status = draft.whatsapp_send_status
    wa_message = draft.whatsapp_send_message
    wa_personal_status = draft.whatsapp_personal_send_status
    wa_personal_message = draft.whatsapp_personal_send_message
    email_interaction_id = draft.email_interaction_id
    wa_interaction_id = draft.whatsapp_interaction_id
    email_invalid = False
    failed_email = None

    # Email
    if send_email:
        try:
            if not recipient_email:
                raise ValueError("No email address available for this contact")
            email_draft = comms.create_manual_email_draft(
                db,
                buyer_id=draft.buyer_id,
                contact_id=draft.contact_id,
                subject=draft.subject or "",
                body=draft.email_body or "",
                attachments=attachments,
            )
            email_interaction_id = email_draft.id
            _approved, send_result = comms.approve_draft(
                db,
                email_draft.id,
                approved_by=user.username,
                send=True,
                mailbox_user=user,
                force_email=recipient_email,
            )
            email_status = (send_result or {}).get("status") or "sent"
            email_message = (send_result or {}).get("message")
            approved_status = getattr(_approved.status, "value", _approved.status)
            if email_status not in {"sent", "queued"} and str(approved_status) == "sent":
                email_status = "sent"
                email_message = email_message or "Email sent"
            from modules.email_activity import classify_send_result, is_invalid_recipient_message

            if email_status not in {"sent", "queued"} and (
                classify_send_result(send_result) == "invalid_recipient"
                or is_invalid_recipient_message(email_message)
            ):
                email_invalid = True
                failed_email = recipient_email
                email_message = (
                    f"Email not sent — {recipient_email} is no longer valid or does not exist. "
                    "Try another email from this contact."
                )
        except Exception as exc:  # noqa: BLE001
            email_status = "error"
            email_message = str(exc)
            from modules.email_activity import is_invalid_recipient_message

            if is_invalid_recipient_message(email_message) or "no email address" in email_message.lower():
                email_invalid = True
                failed_email = recipient_email
                if recipient_email:
                    email_message = (
                        f"Email not sent — {recipient_email} is no longer valid or does not exist. "
                        "Try another email from this contact."
                    )

    # WhatsApp (free text inside 24h window, or approved template outside it)
    if send_whatsapp:
        try:
            from modules import whatsapp_templates as templates_module
            from integrations.whatsapp_client import whatsapp_client

            if not recipient_wa_phone:
                raise ValueError("Recipient has no phone number for WhatsApp")

            resolved_variables = list(template_variables or [])
            template_row = None
            if (template_name or "").strip():
                from db.models import WhatsAppTemplate

                template_row = (
                    db.query(WhatsAppTemplate)
                    .filter(WhatsAppTemplate.name == template_name.strip())
                    .order_by(WhatsAppTemplate.id.desc())
                    .first()
                )
                if template_row and template_row.variable_count > 0:
                    suggested = templates_module.suggest_template_variables(
                        template_row.body_text,
                        template_row.variable_count,
                        contact_name=draft.contact_name or (contact.full_name if contact else "Client"),
                        company_name=draft.company_name,
                        country=draft.country,
                    )
                    resolved_variables = templates_module.merge_template_variables(
                        resolved_variables,
                        suggested,
                    )

            expires = contact.whatsapp_window_expires_at if contact else None
            if expires is not None and expires.tzinfo is None:
                expires = expires.replace(tzinfo=timezone.utc)
            within_window = bool(expires and expires > datetime.now(timezone.utc))

            components = None
            if (template_name or "").strip():
                components = (
                    templates_module.build_template_send_components(
                        template_row,
                        resolved_variables,
                    )
                    or None
                )

            wa_result = whatsapp_client.send_approved(
                phone=recipient_wa_phone,
                message=(draft.whatsapp_body or draft.email_body or "").strip(),
                template_name=(template_name or "").strip() or None,
                template_language=template_language or "en_US",
                template_components=components,
                within_session_window=within_window,
            )
            wa_status = wa_result.get("status") or "error"
            wa_message = wa_result.get("message")
            if wa_status == "sent":
                if contact:
                    wa_draft = comms.create_manual_whatsapp_draft(
                        db,
                        contact_id=contact.id,
                        content=(draft.whatsapp_body or draft.email_body or "").strip(),
                    )
                    wa_draft.provider_message_id = wa_result.get("provider_message_id")
                    wa_draft.status = InteractionStatus.sent
                    wa_draft.wa_status = "sent"
                    wa_draft.template_name = (template_name or "").strip() or None
                    db.commit()
                    wa_interaction_id = wa_draft.id
        except Exception as exc:  # noqa: BLE001
            wa_status = "error"
            wa_message = str(exc)

    # WhatsApp Personal (Baileys bridge — rep's scanned phone)
    if send_whatsapp_personal:
        try:
            from integrations import whatsapp_bridge_client as bridge

            if not recipient_wa_phone:
                raise ValueError("Recipient has no phone number for WhatsApp Personal")
            status = bridge.bridge_status(user.id, username=user.username)
            if not status.get("connected"):
                raise ValueError(
                    "Personal WhatsApp is not connected. Open WhatsApp QR and scan your phone."
                )
            bridge.bridge_send(
                user.id,
                to_phone=recipient_wa_phone,
                message=(draft.whatsapp_body or draft.email_body or "").strip(),
                username=user.username,
            )
            wa_personal_status = "sent"
            wa_personal_message = f"Sent to {recipient_wa_phone} via personal WhatsApp"
        except Exception as exc:  # noqa: BLE001
            wa_personal_status = "error"
            wa_personal_message = str(exc)

    draft.email_interaction_id = email_interaction_id
    draft.whatsapp_interaction_id = wa_interaction_id
    draft.email_send_status = email_status
    draft.whatsapp_send_status = wa_status
    draft.whatsapp_personal_send_status = wa_personal_status
    draft.email_send_message = email_message
    draft.whatsapp_send_message = wa_message
    draft.whatsapp_personal_send_message = wa_personal_message

    email_ok = (email_status or "") in {"sent", "queued"}
    wa_ok = wa_status == "sent"
    wa_personal_ok = wa_personal_status == "sent"

    requested_email = "email" in channel_set
    requested_wa = "whatsapp" in channel_set
    requested_wa_personal = "whatsapp_personal" in channel_set
    email_done = (not requested_email) or email_ok
    wa_done = (not requested_wa) or wa_ok
    wa_personal_done = (not requested_wa_personal) or wa_personal_ok

    if (requested_email and email_ok) or (requested_wa and wa_ok) or (
        requested_wa_personal and wa_personal_ok
    ):
        if email_done and wa_done and wa_personal_done:
            draft.status = "sent"
            draft.sent_at = draft.sent_at or _utcnow()
            draft.generation_error = None
        else:
            # Partial success — keep ready so the failed channel can be retried.
            draft.status = "ready"
            draft.sent_at = draft.sent_at or _utcnow()
            if requested_email and not email_ok:
                draft.generation_error = email_message or "Email send failed"
            elif requested_wa and not wa_ok:
                draft.generation_error = wa_message or "WhatsApp (Meta) send failed"
            elif requested_wa_personal and not wa_personal_ok:
                draft.generation_error = wa_personal_message or "WhatsApp Personal send failed"
            else:
                draft.generation_error = None
    else:
        draft.status = "ready"
        draft.generation_error = email_message or wa_message or "Send failed"

    db.commit()
    db.refresh(draft)

    from modules.audit import log_action
    from modules import activity as activity_module

    log_action(
        db,
        entity_type="personalized_followup",
        entity_id=draft.id,
        action="sent" if email_done and wa_done else "send_partial",
        actor=user.username,
        details={
            "channels": sorted(channel_set),
            "email_status": email_status,
            "whatsapp_status": wa_status,
            "buyer_id": draft.buyer_id,
            "template_name": template_name,
        },
    )

    if requested_email and email_ok:
        activity_module.log_activity(
            db,
            user_id=user.id,
            activity_type=activity_module.PERSONAL_EMAILS_SENT,
            title="Personal email sent",
            summary=f"Personalized follow-up email (draft #{draft.id})",
            quantity=1,
            entity_type="personalized_followup",
            entity_id=draft.id,
            details={"mode": "personalized_followup", "channel": "email", "buyer_id": draft.buyer_id},
        )
    if requested_wa and wa_ok:
        activity_module.log_activity(
            db,
            user_id=user.id,
            activity_type=activity_module.PERSONAL_WHATSAPP_SENT,
            title="Personal WhatsApp sent",
            summary=f"Personalized follow-up WhatsApp (draft #{draft.id})",
            quantity=1,
            entity_type="personalized_followup",
            entity_id=draft.id,
            details={"mode": "personalized_followup", "channel": "whatsapp", "buyer_id": draft.buyer_id},
        )

    if requested_email and requested_wa:
        if email_ok and wa_ok:
            message = "Email and WhatsApp sent."
        elif email_ok:
            message = f"Email sent; WhatsApp not sent: {wa_message}"
        elif wa_ok:
            message = f"WhatsApp sent; email not sent: {email_message}"
        else:
            message = f"Send failed: {email_message or wa_message}"
    elif requested_email:
        message = "Email sent." if email_ok else f"Email not sent: {email_message}"
    else:
        message = "WhatsApp sent." if wa_ok else f"WhatsApp not sent: {wa_message}"

    remaining_emails = [
        e
        for e in available_emails
        if not failed_email
        or _normalize_email_addr(e.get("email")) != _normalize_email_addr(failed_email)
    ]
    if email_invalid and not remaining_emails:
        message = (
            f"All listed emails for this contact are invalid or do not exist"
            f"{f' (last tried: {failed_email})' if failed_email else ''}. "
            "Add a new email address to continue."
        )

    return {
        "draft": draft_to_dict(db, draft),
        "email_sent": email_ok if requested_email else False,
        "whatsapp_sent": wa_ok if requested_wa else False,
        "needs_whatsapp_template": bool(
            requested_wa
            and not wa_ok
            and wa_message
            and "template" in (wa_message or "").lower()
        ),
        "email_invalid": email_invalid if requested_email else False,
        "failed_email": failed_email,
        "available_emails": available_emails,
        "message": message,
    }
