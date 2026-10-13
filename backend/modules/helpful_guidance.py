"""Helpful Guidance — coaching report from client history, KPI, and channel activity."""

from __future__ import annotations

import re
from collections import Counter
from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Literal
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from db.models import AppUser, AppUserRole, Buyer
from modules.activity import get_kpi_counts_for_range, get_kpi_report

KPI_TZ = ZoneInfo("Asia/Karachi")

GuidanceChannel = Literal["calls", "emails", "whatsapp", "telegram"]

_REMARK_PATTERNS: list[tuple[str, str]] = [
    (r"not pick|no answer|did not receive|didn't pick|unanswered", "no_answer"),
    (r"wrong number|invalid number|disconnected|not in service", "wrong_number"),
    (r"voicemail|voice mail|left message", "voicemail"),
    (r"not interested|declined|no requirement", "not_interested"),
    (r"interested|follow up|callback|call back|quotation|quote|rfq", "positive_signal"),
    (r"head office|operator|reception", "gatekeeper"),
]


def _normalize_period_months(months: int) -> int:
    return max(1, min(months, 12))


def _normalize_channel(channel: str | None) -> GuidanceChannel:
    key = (channel or "calls").strip().lower()
    if key in {"email", "emails"}:
        return "emails"
    if key in {"whatsapp", "wa", "meta", "whatsapp_meta"}:
        return "whatsapp"
    if key in {"telegram", "tg"}:
        return "telegram"
    return "calls"


def _parse_day(value: str | None, *, end_of_day: bool) -> datetime | None:
    if not value:
        return None
    raw = value.strip()
    if not raw:
        return None
    try:
        day = date.fromisoformat(raw[:10])
    except ValueError as exc:
        raise ValueError(f"Invalid date '{value}'. Use YYYY-MM-DD.") from exc
    local = datetime.combine(
        day,
        time(23, 59, 59, 999999) if end_of_day else time.min,
        tzinfo=KPI_TZ,
    )
    return local.astimezone(timezone.utc)


def resolve_guidance_window(
    *,
    days: int | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    months: int | None = None,
) -> dict[str, Any]:
    """Resolve coaching window. Prefer custom range, then rolling days, else months."""
    if date_from or date_to:
        start = _parse_day(date_from, end_of_day=False)
        end = _parse_day(date_to, end_of_day=True)
        if start and end and end < start:
            raise ValueError("date_to must be on or after date_from")
        if start is None and end is not None:
            start = end - timedelta(days=29)
            start = datetime.combine(start.date(), time.min, tzinfo=KPI_TZ).astimezone(
                timezone.utc
            )
        if end is None and start is not None:
            end = datetime.now(timezone.utc)
        assert start is not None and end is not None
        span_days = max(1, (end.date() - start.astimezone(KPI_TZ).date()).days + 1)
        return {
            "mode": "range",
            "days": span_days,
            "months": None,
            "since": start,
            "until": end,
            "period_label": (
                f"{start.astimezone(KPI_TZ).date().isoformat()} → "
                f"{end.astimezone(KPI_TZ).date().isoformat()}"
            ),
        }

    if days is not None and int(days) > 0:
        d = max(1, min(int(days), 3650))
        until = datetime.now(timezone.utc)
        since = until - timedelta(days=d)
        label = "Today" if d == 1 else f"Last {d} days"
        return {
            "mode": "days",
            "days": d,
            "months": None,
            "since": since,
            "until": until,
            "period_label": label,
        }

    # Legacy calendar-month rollup (kept for older clients).
    m = _normalize_period_months(int(months or 3))
    return {
        "mode": "months",
        "days": None,
        "months": m,
        "since": None,
        "until": None,
        "period_label": f"Last {m} month{'s' if m != 1 else ''}",
    }


def _scan_remark_patterns(db: Session, *, assigned_to_user_id: int | None) -> dict[str, Any]:
    query = db.query(Buyer.id, Buyer.company_name, Buyer.remarks_history, Buyer.remarks)
    if assigned_to_user_id is not None:
        query = query.filter(Buyer.assigned_to_user_id == assigned_to_user_id)
    counts: Counter[str] = Counter()
    samples: dict[str, list[str]] = {label: [] for _, label in _REMARK_PATTERNS}
    scanned = 0
    for _bid, company, history, remarks in query.all():
        texts: list[str] = []
        if remarks and str(remarks).strip():
            texts.append(str(remarks).strip())
        for entry in history or []:
            if isinstance(entry, dict) and (entry.get("text") or "").strip():
                texts.append(str(entry["text"]).strip())
        for text in texts:
            scanned += 1
            lower = text.lower()
            for pattern, key in _REMARK_PATTERNS:
                if re.search(pattern, lower):
                    counts[key] += 1
                    if len(samples[key]) < 5:
                        samples[key].append(f"{company}: {text[:120]}")
    return {"scanned_remarks": scanned, "pattern_counts": dict(counts), "samples": samples}


def _monthly_kpi_rollups(
    db: Session,
    *,
    viewer: AppUser,
    target_user_id: int | None,
    months: int,
) -> list[dict[str, Any]]:
    today = date.today()
    rollups: list[dict[str, Any]] = []
    cursor = today
    for _ in range(months):
        try:
            report = get_kpi_report(
                db,
                report_date=cursor,
                viewer=viewer,
                user_id=target_user_id,
                period="month",
            )
            rollups.append(
                {
                    "period_label": report.get("period_label") or cursor.strftime("%B %Y"),
                    "counts": report.get("counts") or {},
                }
            )
        except ValueError:
            pass
        cursor = cursor.replace(day=1) - timedelta(days=1)
    return rollups


def _build_call_recommendations(
    pattern_counts: dict[str, int],
    kpi_totals: dict[str, int],
) -> list[dict[str, str]]:
    recs: list[dict[str, str]] = []
    calls = int(kpi_totals.get("calls_logged") or 0)
    no_answer = int(kpi_totals.get("outcomes_not_received_call") or 0)
    interested = int(kpi_totals.get("outcomes_interested") or 0)
    follow_up = int(kpi_totals.get("outcomes_follow_up") or 0)

    if calls > 0 and no_answer / max(calls, 1) >= 0.35:
        recs.append(
            {
                "title": "High no-answer rate",
                "body": (
                    "More than a third of logged calls are “did not receive call”. "
                    "Use Quick Dial → Valid to call now, call in local 10 AM–5 PM windows, "
                    "and avoid redialing the same number within 48 hours. "
                    "Send a short WhatsApp or email before the second attempt to cut voicemail charges."
                ),
            }
        )

    if pattern_counts.get("voicemail", 0) >= 5:
        recs.append(
            {
                "title": "Voicemail is costing connect time",
                "body": (
                    "Many remarks mention voicemail. Prefer WhatsApp template or email first for cold leads; "
                    "reserve calls for “Valid to call now” slots. "
                    "If you must leave voicemail, keep batches smaller (10) and log outcome as Did not receive call."
                ),
            }
        )

    if pattern_counts.get("wrong_number", 0) >= 3:
        recs.append(
            {
                "title": "Wrong numbers in the list",
                "body": (
                    "Clean spreadsheet phones before import. "
                    "Move name-only / phone-only rows to Incomplete Data from Archives until verified."
                ),
            }
        )

    if pattern_counts.get("positive_signal", 0) >= interested + follow_up and calls > 10:
        recs.append(
            {
                "title": "Interest in remarks but low formal outcomes",
                "body": (
                    "Reps are noting interest in remarks but not always selecting Client is interested / Follow up. "
                    "Always pick an outcome in post-call remarks so KPI and Follow up clients stay accurate."
                ),
            }
        )

    if not recs:
        recs.append(
            {
                "title": "Keep momentum",
                "body": (
                    "Log every call outcome, use Assigned list for your daily queue, "
                    "and coordinate before calling another rep’s assigned contacts."
                ),
            }
        )
    return recs


def _build_email_recommendations(stats: dict[str, Any]) -> list[dict[str, str]]:
    totals = stats.get("totals") or {}
    individual = stats.get("individual") or {}
    bulk = stats.get("bulk") or {}
    sent = int(totals.get("sent") or 0)
    failed = int(totals.get("failed") or 0)
    opened = int(totals.get("opened") or 0)
    replied = int(totals.get("replied") or 0)
    open_rate = float(totals.get("open_rate_pct") or 0)
    reply_rate = float(totals.get("reply_rate_pct") or 0)
    recs: list[dict[str, str]] = []

    if sent == 0:
        return [
            {
                "title": "No email sends in this window",
                "body": (
                    "Use Mail compose for hot leads and Bulk Email Sender / Vercel mailer for nurture lists. "
                    "Track results under Email Activity."
                ),
            }
        ]

    if failed / max(sent + failed, 1) >= 0.1:
        recs.append(
            {
                "title": "Send failures are high",
                "body": (
                    "Check mailbox auth, invalid addresses, and bulk failure lists in Email Activity. "
                    "Clean bounced/invalid contacts before the next campaign."
                ),
            }
        )

    if sent >= 10 and open_rate < 20:
        recs.append(
            {
                "title": "Low open rate",
                "body": (
                    "Tighten subject lines (product + country + Halal/ISO when relevant). "
                    "Prefer individual mail for HOT / AAAA leads; keep bulk for cold nurture."
                ),
            }
        )

    if opened >= 5 and reply_rate < 5:
        recs.append(
            {
                "title": "Opens without replies",
                "body": (
                    "Follow up 3–5 days after an open with a short ask (MOQ, destination port, product interest). "
                    "Offer a one-page catalogue or quotation PDF."
                ),
            }
        )

    if int(bulk.get("sent") or 0) > int(individual.get("sent") or 0) * 3 and replied == 0:
        recs.append(
            {
                "title": "Bulk-heavy mix",
                "body": (
                    "Bulk drives volume but few replies. Carve out daily personal emails to top scored leads "
                    "and reference their product fit from the buyer profile."
                ),
            }
        )

    if not recs:
        recs.append(
            {
                "title": "Email cadence looks healthy",
                "body": (
                    "Keep pairing opens with timely follow-ups, and review Email Activity Replies after each campaign."
                ),
            }
        )
    return recs


def _build_whatsapp_recommendations(stats: dict[str, Any]) -> list[dict[str, str]]:
    totals = stats.get("totals") or {}
    sent = int(totals.get("sent") or 0)
    failed = int(totals.get("failed") or 0)
    recs: list[dict[str, str]] = []

    if sent == 0:
        return [
            {
                "title": "No WhatsApp Meta sends in this window",
                "body": (
                    "Use approved Cloud API templates for cold outreach outside the 24h window, "
                    "and free-text replies inside the customer-service window."
                ),
            }
        ]

    if failed / max(sent + failed, 1) >= 0.1:
        recs.append(
            {
                "title": "WhatsApp delivery failures",
                "body": (
                    "Check invalid numbers, template rejections, and Meta quality rating. "
                    "Fix wa_id / E.164 formatting before retrying bulk templates."
                ),
            }
        )

    recs.append(
        {
            "title": "Warm before you dial",
            "body": (
                "Send a short Meta template 10–30 minutes before cold calls to lift pickup rates. "
                "Log outcomes so Sales Help Manager can compare WhatsApp → call conversion."
            ),
        }
    )
    recs.append(
        {
            "title": "Use the 24h window",
            "body": (
                "When a buyer replies on WhatsApp, answer quickly with catalogue links and CNF/FOB options "
                "while free-form messages are still allowed."
            ),
        }
    )
    return recs


def _agent_guidance(db: Session, *, user_id: Any, months: int, window: dict[str, Any], channel: GuidanceChannel) -> dict[str, Any]:
    raw_user_str = str(user_id or "").lower()
    agent_name = (
        "Sara"
        if "sara" in raw_user_str
        else ("Rayan" if "rayan" in raw_user_str else "AI Sales Agents (Sara & Rayan)")
    )
    from db.models import Interaction, Channel, HandledBy

    total_calls, interested_cnt, followup_cnt, no_ans_cnt = 0, 0, 0, 0
    try:
        query = db.query(Interaction).filter(Interaction.channel == Channel.phone)
        if "sara" in raw_user_str:
            query = query.filter(Interaction.subject.ilike("%sara%"))
        elif "rayan" in raw_user_str:
            query = query.filter(Interaction.subject.ilike("%rayan%"))
        else:
            query = query.filter(Interaction.handled_by == HandledBy.agent)
        since = window.get("since")
        until = window.get("until")
        if since is not None:
            query = query.filter(Interaction.created_at >= since)
        if until is not None:
            query = query.filter(Interaction.created_at <= until)
        ai_calls = query.all()
        total_calls = len(ai_calls)
        interested_cnt = sum(
            1
            for c in ai_calls
            if "interested" in (c.subject or "").lower() or "interested" in (c.content or "").lower()
        )
        followup_cnt = sum(
            1
            for c in ai_calls
            if "follow" in (c.subject or "").lower() or "catalogue" in (c.content or "").lower()
        )
        no_ans_cnt = max(0, total_calls - interested_cnt - followup_cnt)
    except Exception as e:  # noqa: BLE001
        print(f"Error querying AI calls for guidance: {e}", flush=True)

    kpi_totals = {
        "calls_logged": total_calls,
        "outcomes_interested": interested_cnt,
        "outcomes_follow_up": followup_cnt,
        "outcomes_not_received_call": no_ans_cnt,
    }

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "channel": channel,
        "months": window.get("months"),
        "days": window.get("days"),
        "period_label": window.get("period_label"),
        "since": window["since"].isoformat() if window.get("since") else None,
        "until": window["until"].isoformat() if window.get("until") else None,
        "user_id": user_id,
        "is_team_view": False,
        "is_agent_view": True,
        "agent_name": agent_name,
        "connected": True,
        "kpi_by_month": [],
        "kpi_totals": kpi_totals,
        "metric_tiles": [
            {"label": "Calls logged", "value": kpi_totals["calls_logged"]},
            {"label": "Interested", "value": kpi_totals["outcomes_interested"]},
            {"label": "Follow up", "value": kpi_totals["outcomes_follow_up"]},
            {"label": "No answer", "value": kpi_totals["outcomes_not_received_call"]},
        ],
        "remark_patterns": {"scanned_remarks": total_calls, "pattern_counts": {}, "samples": {}},
        "strengths": [
            f"{agent_name} introduces Kafi Commodities cleanly and offers WhatsApp & Email catalogue delivery.",
            f"{agent_name} never repeats customer names unnecessarily and maintains natural spoken voice.",
            "Zero manual rep fatigue — handles automated calling queue efficiently with instant DB logging.",
        ],
        "gaps": [
            f"{agent_name} needs continuous objection handling tuning for volume discounts (100+ MT).",
            "High no-answer rate on cold calling batches — try warming up leads via WhatsApp template before queuing AI calls.",
            "Ensure custom sales rules in AI dashboard are updated with exact target CNF port pricing.",
        ],
        "recommendations": [
            {
                "title": f"Train {agent_name} from Call History",
                "body": (
                    f"Click 'Auto-Train from Call History' on the AI Sales Agent page so Gemini AI "
                    f"continuously learns winning objection responses for {agent_name}."
                ),
            },
            {
                "title": "Add Executive Custom Rules",
                "body": (
                    "Type specific company pricing rules (e.g. 'Always offer CNF Karachi port quotes first') "
                    "in the Custom Sales Rules editor on the AI Sales Agent page."
                ),
            },
            {
                "title": "Warm Up Cold Leads Before Dialing",
                "body": (
                    "Send a short WhatsApp template or email introduction 10 minutes before queuing "
                    "calls to Sara/Rayan to boost pickup rates."
                ),
            },
        ],
        "approach_buyers": [
            f"Queue high-intent leads to {agent_name} from Master Table or Old clients.",
            f"{agent_name} will verify buyer identity ('Am I speaking with [Name]?') on pickup.",
            f"Offer catalogue and price list over WhatsApp & Email without asking for contact info.",
        ],
        "save_phone_bill": [
            "Queue calls during local business hours (10 AM - 4 PM buyer time).",
            "Skip wrong numbers and unverified contact phones.",
        ],
    }


def _calls_guidance(
    db: Session,
    *,
    viewer: AppUser,
    target_user_id: int | None,
    is_team_view: bool,
    window: dict[str, Any],
) -> dict[str, Any]:
    remark_scan = _scan_remark_patterns(db, assigned_to_user_id=target_user_id)
    kpi_by_month: list[dict[str, Any]] = []
    if window["mode"] == "months":
        months = int(window["months"] or 3)
        kpi_by_month = _monthly_kpi_rollups(
            db, viewer=viewer, target_user_id=target_user_id, months=months
        )
        kpi_totals: dict[str, int] = {}
        for row in kpi_by_month:
            for key, val in (row.get("counts") or {}).items():
                if isinstance(val, int):
                    kpi_totals[key] = kpi_totals.get(key, 0) + val
    else:
        kpi_totals = get_kpi_counts_for_range(
            db,
            start_utc=window["since"],
            end_utc=window["until"] + timedelta(microseconds=1),
            viewer=viewer,
            user_id=target_user_id,
        )

    recommendations = _build_call_recommendations(
        remark_scan.get("pattern_counts") or {},
        kpi_totals,
    )

    strengths: list[str] = []
    if int(kpi_totals.get("outcomes_interested") or 0) > 0:
        strengths.append("Logged interested clients — keep nurturing with quotations.")
    if int(kpi_totals.get("calls_logged") or 0) >= 20:
        strengths.append("Consistent calling activity — focus on connect rate and outcomes.")
    if int(kpi_totals.get("bulk_emails_sent") or 0) + int(kpi_totals.get("personal_emails_sent") or 0) > 0:
        strengths.append("Email outreach in use — pair with call windows for warmer conversations.")

    gaps: list[str] = []
    pc = remark_scan.get("pattern_counts") or {}
    if pc.get("no_answer", 0) >= 10:
        gaps.append("Frequent no-answer / not picking up — timing and list quality.")
    if pc.get("gatekeeper", 0) >= 3:
        gaps.append("Gatekeeper blocks — ask for procurement/import manager email before calling again.")
    if int(kpi_totals.get("outcomes_not_interested") or 0) > int(kpi_totals.get("outcomes_interested") or 0):
        gaps.append("More not-interested than interested — refine country/product fit in Old clients filters.")

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "channel": "calls",
        "months": window.get("months"),
        "days": window.get("days"),
        "period_label": window.get("period_label"),
        "since": window["since"].isoformat() if window.get("since") else None,
        "until": window["until"].isoformat() if window.get("until") else None,
        "user_id": target_user_id,
        "is_team_view": is_team_view,
        "is_agent_view": False,
        "connected": True,
        "kpi_by_month": kpi_by_month,
        "kpi_totals": kpi_totals,
        "metric_tiles": [
            {"label": "Calls logged", "value": int(kpi_totals.get("calls_logged") or 0)},
            {"label": "Interested", "value": int(kpi_totals.get("outcomes_interested") or 0)},
            {"label": "Follow up", "value": int(kpi_totals.get("outcomes_follow_up") or 0)},
            {"label": "No answer", "value": int(kpi_totals.get("outcomes_not_received_call") or 0)},
        ],
        "remark_patterns": remark_scan,
        "strengths": strengths or ["Building history — keep logging every touchpoint."],
        "gaps": gaps or ["No major gaps detected from remark patterns yet."],
        "recommendations": recommendations,
        "approach_buyers": [
            "Research company + product fit (salt, rice, sauces) before first call.",
            "Use Valid to call now in Quick Dial for the buyer’s country.",
            "Warm up with WhatsApp template or email when cold; call when they reply or in-window.",
            "Always log outcome + one-line remark — powers Follow up clients and this guidance.",
            "Check Assigned before dialing; coordinate if another rep owns the lead.",
        ],
        "save_phone_bill": [
            "Filter Valid to call now — fewer rings to voicemail abroad.",
            "Smaller bulk batches (10) with Skip & next when no answer — don’t chain 25 voicemails.",
            "WhatsApp first for repeat no-answer numbers within 7 days.",
            "Remove wrong numbers via Full clean / dedupe on Old clients.",
        ],
    }


def _emails_guidance(
    db: Session,
    *,
    viewer: AppUser,
    target_user_id: int | None,
    is_team_view: bool,
    window: dict[str, Any],
) -> dict[str, Any]:
    from modules import email_activity

    role = viewer.role.value if isinstance(viewer.role, AppUserRole) else str(viewer.role)
    is_admin = role == AppUserRole.admin.value
    days = window.get("days")
    date_from = None
    date_to = None
    if window["mode"] == "range" and window.get("since") and window.get("until"):
        date_from = window["since"].astimezone(KPI_TZ).date().isoformat()
        date_to = window["until"].astimezone(KPI_TZ).date().isoformat()
        days = None
    elif window["mode"] == "months":
        days = int(window["months"] or 3) * 30

    stats = email_activity.insights_stats(
        db,
        days=days,
        date_from=date_from,
        date_to=date_to,
        user_id=viewer.id if not is_admin else target_user_id,
        is_admin=is_admin and target_user_id is None,
        channel="email",
        sync_user=viewer if target_user_id in (None, viewer.id) else None,
    )
    totals = stats.get("totals") or {}
    tiles = [
        {"label": "Sent", "value": int(totals.get("sent") or 0)},
        {"label": "Failed", "value": int(totals.get("failed") or 0)},
        {"label": "Opened", "value": int(totals.get("opened") or 0)},
        {"label": "Replies", "value": int(totals.get("replied") or 0)},
    ]
    strengths: list[str] = []
    gaps: list[str] = []
    if int(totals.get("sent") or 0) > 0:
        strengths.append(
            f"Sent {int(totals.get('sent') or 0)} emails "
            f"({float(totals.get('success_rate_pct') or 0)}% delivery success)."
        )
    if float(totals.get("open_rate_pct") or 0) >= 25:
        strengths.append(f"Open rate {float(totals.get('open_rate_pct') or 0)}% — subjects are landing.")
    if int(totals.get("replied") or 0) > 0:
        strengths.append("Recipients are replying — prioritize those threads in Inbox.")
    if float(totals.get("open_rate_pct") or 0) < 15 and int(totals.get("sent") or 0) >= 10:
        gaps.append("Open rate is low — test shorter, product-led subjects.")
    if int(totals.get("failed") or 0) > 0:
        gaps.append("Failed sends present — review Email Activity Failed lists.")
    if int(totals.get("opened") or 0) > 0 and int(totals.get("replied") or 0) == 0:
        gaps.append("Opens without replies — schedule follow-ups on opened leads.")

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "channel": "emails",
        "months": window.get("months"),
        "days": window.get("days"),
        "period_label": window.get("period_label"),
        "since": window["since"].isoformat() if window.get("since") else None,
        "until": window["until"].isoformat() if window.get("until") else None,
        "user_id": target_user_id,
        "is_team_view": is_team_view,
        "is_agent_view": False,
        "connected": True,
        "kpi_by_month": [],
        "kpi_totals": {
            "emails_sent": int(totals.get("sent") or 0),
            "emails_failed": int(totals.get("failed") or 0),
            "emails_opened": int(totals.get("opened") or 0),
            "emails_replied": int(totals.get("replied") or 0),
            "email_open_rate_pct": float(totals.get("open_rate_pct") or 0),
            "email_reply_rate_pct": float(totals.get("reply_rate_pct") or 0),
        },
        "metric_tiles": tiles,
        "insights": stats,
        "remark_patterns": {"scanned_remarks": 0, "pattern_counts": {}, "samples": {}},
        "strengths": strengths or ["Start sending to build email coaching history."],
        "gaps": gaps or ["No major email gaps detected in this window."],
        "recommendations": _build_email_recommendations(stats),
        "approach_buyers": [
            "Personalize individual emails for HOT / AAAA leads with product fit from the buyer profile.",
            "Lead with certifications (Halal, ISO, HACCP) and clear next step (quote / samples / MOQ).",
            "Use Email Activity → Replies to queue Inbox follow-ups the same day.",
        ],
        "save_phone_bill": [
            "Email or WhatsApp first for cold numbers that keep going to voicemail.",
            "Reserve calls for opens/replies and Valid to call now slots.",
        ],
    }


def _whatsapp_guidance(
    db: Session,
    *,
    viewer: AppUser,
    target_user_id: int | None,
    is_team_view: bool,
    window: dict[str, Any],
) -> dict[str, Any]:
    from modules import email_activity

    role = viewer.role.value if isinstance(viewer.role, AppUserRole) else str(viewer.role)
    is_admin = role == AppUserRole.admin.value
    days = window.get("days")
    date_from = None
    date_to = None
    if window["mode"] == "range" and window.get("since") and window.get("until"):
        date_from = window["since"].astimezone(KPI_TZ).date().isoformat()
        date_to = window["until"].astimezone(KPI_TZ).date().isoformat()
        days = None
    elif window["mode"] == "months":
        days = int(window["months"] or 3) * 30

    stats = email_activity.insights_stats(
        db,
        days=days,
        date_from=date_from,
        date_to=date_to,
        user_id=viewer.id if not is_admin else target_user_id,
        is_admin=is_admin and target_user_id is None,
        channel="whatsapp",
    )
    totals = stats.get("totals") or {}
    tiles = [
        {"label": "Sent", "value": int(totals.get("sent") or 0)},
        {"label": "Failed", "value": int(totals.get("failed") or 0)},
        {"label": "Batches", "value": int((stats.get("bulk") or {}).get("batches") or 0)},
        {
            "label": "Success rate",
            "value": f"{float(totals.get('success_rate_pct') or 0)}%",
        },
    ]
    strengths: list[str] = []
    gaps: list[str] = []
    if int(totals.get("sent") or 0) > 0:
        strengths.append(f"Meta WhatsApp sends recorded: {int(totals.get('sent') or 0)}.")
    if float(totals.get("success_rate_pct") or 0) >= 90:
        strengths.append("High delivery success on WhatsApp Cloud API.")
    if int(totals.get("failed") or 0) > 0:
        gaps.append("Failed WhatsApp deliveries — check template status and number format.")
    if int(totals.get("sent") or 0) == 0:
        gaps.append("No WhatsApp Meta activity in this window.")

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "channel": "whatsapp",
        "months": window.get("months"),
        "days": window.get("days"),
        "period_label": window.get("period_label"),
        "since": window["since"].isoformat() if window.get("since") else None,
        "until": window["until"].isoformat() if window.get("until") else None,
        "user_id": target_user_id,
        "is_team_view": is_team_view,
        "is_agent_view": False,
        "connected": True,
        "kpi_by_month": [],
        "kpi_totals": {
            "whatsapp_sent": int(totals.get("sent") or 0),
            "whatsapp_failed": int(totals.get("failed") or 0),
            "whatsapp_success_rate_pct": float(totals.get("success_rate_pct") or 0),
        },
        "metric_tiles": tiles,
        "insights": stats,
        "remark_patterns": {"scanned_remarks": 0, "pattern_counts": {}, "samples": {}},
        "strengths": strengths or ["Connect Meta templates and start outreach to build history."],
        "gaps": gaps or ["No major WhatsApp gaps detected in this window."],
        "recommendations": _build_whatsapp_recommendations(stats),
        "approach_buyers": [
            "Use approved templates for first touch; switch to free-text after the buyer replies.",
            "Warm leads on WhatsApp before queuing AI or human cold calls.",
            "Keep catalogue / CNF answers ready for the 24h service window.",
        ],
        "save_phone_bill": [
            "WhatsApp first for numbers that repeatedly go to voicemail.",
            "Only dial after a Meta reply or Valid to call now window.",
        ],
    }


def _telegram_guidance(*, window: dict[str, Any], target_user_id: int | None, is_team_view: bool) -> dict[str, Any]:
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "channel": "telegram",
        "months": window.get("months"),
        "days": window.get("days"),
        "period_label": window.get("period_label"),
        "since": window["since"].isoformat() if window.get("since") else None,
        "until": window["until"].isoformat() if window.get("until") else None,
        "user_id": target_user_id,
        "is_team_view": is_team_view,
        "is_agent_view": False,
        "connected": False,
        "kpi_by_month": [],
        "kpi_totals": {},
        "metric_tiles": [
            {"label": "Sent", "value": 0},
            {"label": "Failed", "value": 0},
            {"label": "Replies", "value": 0},
            {"label": "Status", "value": "Not connected"},
        ],
        "remark_patterns": {"scanned_remarks": 0, "pattern_counts": {}, "samples": {}},
        "strengths": [],
        "gaps": ["Telegram personal bridge is not fully connected for coaching yet."],
        "recommendations": [
            {
                "title": "Telegram coaching coming next",
                "body": (
                    "Once Telegram replies are wired like WhatsApp Meta activity, this tab will show "
                    "sent / failed / reply coaching for the selected period."
                ),
            }
        ],
        "approach_buyers": [
            "Use WhatsApp Meta or email for outreach until Telegram reply tracking is live.",
        ],
        "save_phone_bill": [
            "Prefer message channels before cold dialing abroad.",
        ],
    }


def generate_helpful_guidance(
    db: Session,
    *,
    viewer: AppUser,
    months: int = 3,
    user_id: Any = None,
    channel: str | None = "calls",
    days: int | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
) -> dict[str, Any]:
    """Build a coaching report for calls, emails, WhatsApp Meta, or Telegram."""
    ch = _normalize_channel(channel)
    window = resolve_guidance_window(
        days=days,
        date_from=date_from,
        date_to=date_to,
        months=months if days is None and not date_from and not date_to else None,
    )

    raw_user_str = str(user_id or "").lower()
    is_agent_view = any(k in raw_user_str for k in ("agent", "sara", "rayan"))
    if is_agent_view:
        return _agent_guidance(
            db,
            user_id=user_id,
            months=int(window.get("months") or months or 3),
            window=window,
            channel=ch,
        )

    role = viewer.role.value if isinstance(viewer.role, AppUserRole) else str(viewer.role)
    is_admin = role == AppUserRole.admin.value
    target_user_id = viewer.id if not is_admin else (int(user_id) if str(user_id or "").isdigit() else None)
    is_team_view = bool(is_admin and user_id is None)

    if ch == "emails":
        return _emails_guidance(
            db,
            viewer=viewer,
            target_user_id=target_user_id,
            is_team_view=is_team_view,
            window=window,
        )
    if ch == "whatsapp":
        return _whatsapp_guidance(
            db,
            viewer=viewer,
            target_user_id=target_user_id,
            is_team_view=is_team_view,
            window=window,
        )
    if ch == "telegram":
        return _telegram_guidance(
            window=window,
            target_user_id=target_user_id,
            is_team_view=is_team_view,
        )

    return _calls_guidance(
        db,
        viewer=viewer,
        target_user_id=target_user_id,
        is_team_view=is_team_view,
        window=window,
    )
