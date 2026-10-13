"""Rule-based inbox email triage categories."""

from __future__ import annotations

from typing import Any

EMAIL_TRIAGE_CATEGORIES = (
    "urgent",
    "action_required",
    "opportunity",
    "info",
    "tracking",
    "newsletter",
    "invites_exhibitions",
    "advertising",
    "tax_notice_challan",
)

_CATEGORY_LABELS = {
    "urgent": "Urgent",
    "action_required": "Action required",
    "opportunity": "Opportunity",
    "info": "Info",
    "tracking": "Tracking / Cargo / Documents",
    "newsletter": "Newsletter",
    "invites_exhibitions": "Invites & Exhibitions",
    "advertising": "Advertising",
    "tax_notice_challan": "Tax, Notice & Challan",
}


def triage_category_label(category: str | None) -> str:
    key = (category or "info").strip().lower()
    return _CATEGORY_LABELS.get(key, "Info")


def classify_email_triage(
    *,
    subject: str | None,
    body: str | None,
    from_email: str | None = None,
) -> str:
    """Return one of EMAIL_TRIAGE_CATEGORIES."""
    text = f"{subject or ''}\n{body or ''}".lower()
    subj = (subject or "").lower()

    tax_terms = (
        "tax",
        "notice",
        "challan",
        "fbr",
        "srb",
        "pra",
        "kpra",
        "income tax",
        "sales tax",
        "withholding",
        "assessment",
        "audit",
        "penalty",
        "statutory",
        "government notice",
        "bank challan",
        "cpr",
        "tax return",
        "e-filing",
    )
    if any(term in text for term in tax_terms):
        return "tax_notice_challan"

    invites_terms = (
        "invitation",
        "invite",
        "exhibition",
        "exhibitions",
        "expo",
        "summit",
        "conference",
        "trade show",
        "webinar",
        "event",
        "booth",
        "wspc",
        "fair",
        "forum",
        "meeting invitation",
    )
    if any(term in text for term in invites_terms) or (
        from_email and any(k in from_email.lower() for k in ("expo", "event", "invitation"))
    ):
        return "invites_exhibitions"

    advertising_terms = (
        "advertising",
        "advertisement",
        "sponsored",
        "promo",
        "promotion",
        "promotional",
        "discount",
        "special offer",
        "media kit",
        "banner ad",
        "banner advertising",
        "you have won",
        "you've won",
        "congratulations",
        "claim your prize",
        "lottery",
        "jackpot",
        "shopping voucher",
        "gift card",
    )
    if any(term in text for term in advertising_terms):
        return "advertising"

    newsletter_terms = (
        "newsletter",
        "digest",
        "bulletin",
        "weekly update",
        "monthly update",
        "subscription",
        "latest news",
        "industry news",
        "market update",
        "issue #",
    )
    if any(term in text for term in newsletter_terms) or (
        from_email and "newsletter" in from_email.lower()
    ):
        return "newsletter"

    tracking_terms = (
        "tracking",
        "shipment",
        "bill of lading",
        "b/l",
        "container",
        "cargo",
        "customs",
        "clearance",
        "awb",
        "courier",
        "document",
        "certificate",
        "coa",
        "phytosanitary",
    )
    if any(term in text for term in tracking_terms):
        return "tracking"

    urgent_terms = ("urgent", "asap", "immediate", "deadline today", "time sensitive")
    if any(term in subj or term in text[:500] for term in urgent_terms):
        return "urgent"

    opportunity_terms = (
        "rfq",
        "quotation",
        "quote",
        "inquiry",
        "enquiry",
        "interested in",
        "import",
        "distributor",
        "sample",
        "price list",
    )
    if any(term in text for term in opportunity_terms):
        return "opportunity"

    info_terms = (
        "unsubscribe",
        "no-reply",
        "noreply",
    )
    if any(term in text for term in info_terms) or (
        from_email and "noreply" in from_email.lower()
    ):
        return "info"

    action_terms = (
        "please reply",
        "please confirm",
        "waiting for",
        "follow up",
        "reminder",
        "payment",
        "invoice",
    )
    if any(term in text for term in action_terms):
        return "action_required"

    return "action_required"


def enrich_thread_with_triage(thread: dict[str, Any]) -> dict[str, Any]:
    out = dict(thread)
    messages = list(out.get("messages") or [])
    latest_inbound = None
    for msg in reversed(messages):
        if msg.get("direction") != "outbound":
            latest_inbound = msg
            break
    if latest_inbound is None and messages:
        latest_inbound = messages[-1]
    subject = out.get("subject") or (latest_inbound or {}).get("subject")
    body = ""
    if latest_inbound:
        body = (latest_inbound.get("body_text") or latest_inbound.get("preview") or "")[:4000]
    category = classify_email_triage(
        subject=subject,
        body=body,
        from_email=(latest_inbound or {}).get("from_email"),
    )
    out["triage_category"] = category
    out["triage_label"] = triage_category_label(category)
    return out
