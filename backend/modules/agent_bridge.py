"""Read-only dashboard data for bank-recon / PA (agent-bridge API)."""

from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from db.models import (
    AiCompanyLifecycle,
    AppUser,
    AppUserRole,
    Buyer,
    Channel,
    Contact,
    Direction,
    Interaction,
    InteractionStatus,
    Quotation,
    QuotationLineItem,
    QuotationStatus,
)
from modules import activity as activity_module
from modules import ai_mode as ai_mode_module
from modules.calls import latest_call_notes_by_buyer, list_call_history, parse_call_fields


# Map internal lifecycle keys → brief-friendly pipeline buckets.
_PIPELINE_BUCKETS: dict[str, tuple[str, ...]] = {
    "new": ("new_lead", "potential_clients"),
    "contacted": ("assigned", "calling", "follow_up", "interested"),
    "quoted": ("quotation_sent", "negotiation"),
    "won": ("won",),
    "lost": ("lost", "not_interested"),
}


def _admin_viewer(db: Session) -> AppUser:
    admin = (
        db.query(AppUser)
        .filter(AppUser.role == AppUserRole.admin, AppUser.is_active.is_(True))
        .order_by(AppUser.id.asc())
        .first()
    )
    if admin:
        return admin
    fallback = (
        db.query(AppUser).filter(AppUser.is_active.is_(True)).order_by(AppUser.id.asc()).first()
    )
    if not fallback:
        raise RuntimeError("No active Sales Agent users")
    return fallback


def _iso_z(dt: datetime | str | None) -> str | None:
    if dt is None:
        return None
    if isinstance(dt, str):
        return dt
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _pipeline_value_usd(db: Session) -> float:
    open_statuses = (QuotationStatus.sent, QuotationStatus.approved)
    line_total = func.coalesce(QuotationLineItem.quantity, 0) * func.coalesce(
        QuotationLineItem.unit_price, 0
    )
    from_lines = (
        db.query(func.coalesce(func.sum(line_total), 0))
        .join(Quotation, Quotation.id == QuotationLineItem.quotation_id)
        .filter(Quotation.status.in_(open_statuses))
        .scalar()
    )
    header_total = func.coalesce(Quotation.quantity, 0) * func.coalesce(Quotation.unit_price, 0)
    from_headers = (
        db.query(func.coalesce(func.sum(header_total), 0))
        .outerjoin(QuotationLineItem, QuotationLineItem.quotation_id == Quotation.id)
        .filter(Quotation.status.in_(open_statuses), QuotationLineItem.id.is_(None))
        .scalar()
    )
    return round(float(from_lines or 0) + float(from_headers or 0), 2)


def bridge_summary(db: Session) -> dict[str, Any]:
    today = date.today()
    _, _, day_start_utc, day_end_utc = activity_module.period_bounds(today, "day")
    _, _, week_start_utc, week_end_utc = activity_module.period_bounds(today, "week")

    leads_today = (
        db.query(func.count(Buyer.id))
        .filter(Buyer.created_at >= day_start_utc, Buyer.created_at < day_end_utc)
        .scalar()
        or 0
    )
    leads_week = (
        db.query(func.count(Buyer.id))
        .filter(Buyer.created_at >= week_start_utc, Buyer.created_at < week_end_utc)
        .scalar()
        or 0
    )

    now_utc = datetime.now(timezone.utc)
    follow_ups_due = (
        db.query(func.count(Buyer.id))
        .filter(Buyer.follow_up_at.isnot(None), Buyer.follow_up_at <= now_utc)
        .scalar()
        or 0
    )

    admin = _admin_viewer(db)
    kpi_today = activity_module.get_kpi_report(
        db, report_date=today, viewer=admin, period="day", user_id=None
    )
    calls_today = int((kpi_today.get("counts") or {}).get("calls_logged") or 0)

    return {
        "leadsToday": int(leads_today),
        "leadsThisWeek": int(leads_week),
        "pipelineValueUsd": _pipeline_value_usd(db),
        "callsToday": calls_today,
        "followUpsDue": int(follow_ups_due),
        "asOf": _iso_z(now_utc),
    }


def bridge_leads(db: Session, *, limit: int = 20) -> dict[str, Any]:
    limit = max(1, min(int(limit), 100))
    rows = db.query(Buyer).order_by(Buyer.updated_at.desc()).limit(limit).all()
    buyer_ids = {b.id for b in rows}
    notes_by_buyer = latest_call_notes_by_buyer(db, buyer_ids=buyer_ids) if buyer_ids else {}

    lifecycle_by_buyer: dict[int, AiCompanyLifecycle] = {}
    if buyer_ids:
        for lc in (
            db.query(AiCompanyLifecycle)
            .filter(AiCompanyLifecycle.buyer_id.in_(buyer_ids))
            .all()
        ):
            lifecycle_by_buyer[lc.buyer_id] = lc

    leads: list[dict[str, Any]] = []
    for buyer in rows:
        lc = lifecycle_by_buyer.get(buyer.id)
        status = lc.stage if lc else None
        notes = notes_by_buyer.get(buyer.id) or buyer.remarks
        leads.append(
            {
                "id": str(buyer.id),
                "name": buyer.company_name,
                "status": status or buyer.company_grading or "unknown",
                "source": buyer.source or "unknown",
                "assignedTo": buyer.assigned_to if buyer.assigned_to != "unassigned" else None,
                "lastActivityAt": _iso_z(buyer.updated_at),
                "notes": (notes or "")[:280] or None,
            }
        )
    return {"leads": leads}


def bridge_pipeline(db: Session) -> dict[str, Any]:
    admin = _admin_viewer(db)
    internal = ai_mode_module.lifecycle_pipeline_counts(db, viewer=admin)
    stages: list[dict[str, Any]] = []
    for bucket, keys in _PIPELINE_BUCKETS.items():
        count = sum(int(internal.get(k) or 0) for k in keys)
        stages.append({"stage": bucket, "count": count})
    return {"stages": stages}


def _rep_name_for_interaction(db: Session, interaction_id: int) -> str | None:
    from db.models import AiCallActivityLog

    row = (
        db.query(AiCallActivityLog)
        .filter(AiCallActivityLog.interaction_id == interaction_id)
        .order_by(AiCallActivityLog.created_at.desc())
        .first()
    )
    if not row or not row.user_id:
        return None
    user = db.get(AppUser, row.user_id)
    return user.full_name if user else None


def bridge_calls(db: Session, *, limit: int = 20) -> dict[str, Any]:
    limit = max(1, min(int(limit), 100))
    result = list_call_history(db, limit=limit, since_days=30)
    calls: list[dict[str, Any]] = []
    for row in result.get("rows") or []:
        if not isinstance(row, dict):
            continue
        parsed = parse_call_fields(row.get("content"))
        summary = (
            row.get("notes")
            or parsed.get("notes")
            or (row.get("transcript") or "")[:240]
            or row.get("subject")
            or ""
        )
        calls.append(
            {
                "id": str(row.get("id")),
                "leadName": row.get("company_name") or row.get("contact_name") or "Unknown",
                "repName": _rep_name_for_interaction(db, int(row["id"])) if row.get("id") else None,
                "startedAt": _iso_z(row.get("created_at")),
                "durationSec": parsed.get("call_duration_seconds"),
                "summary": str(summary)[:500] if summary else None,
            }
        )
    return {"calls": calls}


def _rep_revenue_usd(db: Session, user_id: int | None) -> float:
    if not user_id:
        return 0.0
    open_statuses = (QuotationStatus.sent, QuotationStatus.approved)
    line_total = func.coalesce(QuotationLineItem.quantity, 0) * func.coalesce(
        QuotationLineItem.unit_price, 0
    )
    rev_lines = (
        db.query(func.coalesce(func.sum(line_total), 0))
        .join(Quotation, Quotation.id == QuotationLineItem.quotation_id)
        .join(Buyer, Quotation.buyer_id == Buyer.id)
        .filter(
            Quotation.status.in_(open_statuses),
            Buyer.assigned_to_user_id == user_id,
        )
        .scalar()
    )
    header_total = func.coalesce(Quotation.quantity, 0) * func.coalesce(Quotation.unit_price, 0)
    rev_headers = (
        db.query(func.coalesce(func.sum(header_total), 0))
        .join(Buyer, Quotation.buyer_id == Buyer.id)
        .outerjoin(QuotationLineItem, QuotationLineItem.quotation_id == Quotation.id)
        .filter(
            Quotation.status.in_(open_statuses),
            Buyer.assigned_to_user_id == user_id,
            QuotationLineItem.id.is_(None),
        )
        .scalar()
    )
    return round(float(rev_lines or 0) + float(rev_headers or 0), 2)


def bridge_performance(db: Session) -> dict[str, Any]:
    today = date.today()
    start_date, _, start_utc, _ = activity_module.period_bounds(today, "week")
    admin = _admin_viewer(db)
    report = activity_module.get_kpi_report(
        db, report_date=today, viewer=admin, period="week", user_id=None
    )
    by_rep: list[dict[str, Any]] = []
    for bucket in report.get("per_user") or []:
        if not isinstance(bucket, dict):
            continue
        user = bucket.get("user") or {}
        counts = bucket.get("counts") or {}
        name = user.get("full_name") or user.get("username") or "Unknown"
        uid = user.get("id")

        rep_rev = _rep_revenue_usd(db, uid)
        rep_meetings = (
            int(counts.get("outcomes_follow_up") or 0)
            + int(counts.get("outcomes_interested") or 0)
            + int(counts.get("outcomes_call_back") or 0)
        )

        by_rep.append(
            {
                "repName": name,
                "callsMade": int(counts.get("calls_logged") or 0),
                "leadsWorked": int(counts.get("table_edits") or 0)
                + int(counts.get("leads_imported") or 0),
                "followUpsCompleted": int(counts.get("outcomes_follow_up") or 0),
                "revenue": rep_rev,
                "target": 50000.0,
                "meetings": rep_meetings,
            }
        )
    by_rep.sort(key=lambda r: (r["callsMade"], r["leadsWorked"]), reverse=True)
    tracking = start_utc if start_utc.tzinfo else start_utc.replace(tzinfo=timezone.utc)
    return {
        "byRep": by_rep,
        "trackingSince": _iso_z(tracking),
    }


def bridge_emails(db: Session, *, limit: int = 20) -> dict[str, Any]:
    limit = max(1, min(int(limit), 100))
    emails: list[dict[str, Any]] = []

    # 1. DB interactions with channel == email
    db_interactions = (
        db.query(Interaction)
        .filter(Interaction.channel == Channel.email)
        .order_by(Interaction.created_at.desc())
        .limit(limit)
        .all()
    )

    if db_interactions:
        for inter in db_interactions:
            contact = db.get(Contact, inter.contact_id) if inter.contact_id else None
            buyer = db.get(Buyer, contact.buyer_id) if contact and contact.buyer_id else None
            sender_str = contact.email if contact and contact.email else (buyer.company_name if buyer else "Unknown")
            if contact and contact.full_name:
                sender_str = f"{contact.full_name} <{contact.email}>" if contact.email else contact.full_name

            emails.append(
                {
                    "id": str(inter.id),
                    "sender": sender_str,
                    "subject": inter.subject or "Email Conversation",
                    "receivedAt": _iso_z(inter.created_at),
                    "snippet": (inter.content or "")[:200] or None,
                    "leadName": buyer.company_name if buyer else (contact.full_name if contact and contact.full_name else "Unknown"),
                    "status": "unread" if getattr(inter, "direction", None) == Direction.inbound else "read",
                }
            )

    # 2. Supplement from live Inbox threads if needed
    if len(emails) < limit:
        try:
            admin = _admin_viewer(db)
            from modules import inbox as inbox_module

            res = inbox_module.list_threads(admin, limit=limit - len(emails), offset=0)
            threads = res.get("items") or []
            existing_subjects = {e["subject"] for e in emails}
            for t in threads:
                subj = t.get("subject") or "No Subject"
                if subj in existing_subjects:
                    continue
                sender_name = t.get("latest_from_name") or t.get("latest_from_email") or "Unknown"
                sender_email = t.get("latest_from_email")
                sender_formatted = f"{sender_name} <{sender_email}>" if sender_email else sender_name
                snippet_text = t.get("snippet") or subj

                lead_name = sender_name
                if sender_email:
                    b = db.query(Buyer).filter(Buyer.email.ilike(f"%{sender_email}%")).first()
                    if b:
                        lead_name = b.company_name

                emails.append(
                    {
                        "id": str(t.get("thread_id") or t.get("id") or len(emails) + 1),
                        "sender": sender_formatted,
                        "subject": subj,
                        "receivedAt": _iso_z(t.get("latest_date")),
                        "snippet": str(snippet_text)[:200] if snippet_text else None,
                        "leadName": lead_name,
                        "status": "unread" if (t.get("unread_count") or 0) > 0 else "read",
                    }
                )
        except Exception:  # noqa: BLE001
            pass

    return {"emails": emails[:limit]}


def _process_bridge_attachments(raw_input: Any) -> list[dict]:
    import base64
    import urllib.request
    from modules.email_attachments import register_attachment_from_bytes

    if raw_input is None:
        return []
    if isinstance(raw_input, dict):
        raw_list = [raw_input]
    elif isinstance(raw_input, list):
        raw_list = raw_input
    else:
        return []

    processed: list[dict] = []
    for att in raw_list:
        if not isinstance(att, dict):
            continue
        if "id" in att and not att.get("base64") and not att.get("url"):
            processed.append(att)
            continue

        filename = att.get("filename") or att.get("name") or "attachment.pdf"
        content_type = (
            att.get("mimeType")
            or att.get("mime_type")
            or att.get("content_type")
            or "application/octet-stream"
        )
        file_bytes: bytes | None = None

        if att.get("base64"):
            b64_str = str(att["base64"]).strip()
            if "," in b64_str and ";base64" in b64_str[:50]:
                b64_str = b64_str.split(",", 1)[1]
            try:
                file_bytes = base64.b64decode(b64_str)
            except Exception as exc:
                raise ValueError(f"Failed to decode base64 attachment '{filename}': {exc}") from exc
        elif att.get("url"):
            url = str(att["url"]).strip()
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "Kafi-Sales-Agent/1.0"})
                with urllib.request.urlopen(req, timeout=30) as resp:
                    file_bytes = resp.read()
                    if not att.get("mimeType") and not att.get("mime_type"):
                        content_type = resp.headers.get_content_type() or content_type
            except Exception as exc:
                raise ValueError(f"Failed to fetch attachment from URL '{url}': {exc}") from exc

        if file_bytes is not None:
            reg_att = register_attachment_from_bytes(
                file_bytes, filename=filename, content_type=content_type
            )
            processed.append(reg_att)

    return processed


def send_bridge_email(db: Session, payload: dict[str, Any]) -> dict[str, Any]:
    """Send an outbound email requested via external API / CNF Pricing bridge."""
    from modules import activity as activity_module
    from modules import inbox as inbox_module

    to_addr = (payload.get("to") or "").strip()
    if not to_addr or "@" not in to_addr:
        raise ValueError("Invalid recipient email address ('to' is required)")

    subject = (payload.get("subject") or "").strip() or "(no subject)"
    body = (payload.get("body") or "").rstrip()
    if not body:
        raise ValueError("Email body cannot be empty ('body' is required)")

    cc = (payload.get("cc") or "").strip() or None
    bcc = (payload.get("bcc") or "").strip() or None
    sender_username = (payload.get("sender_username") or "").strip().lower()

    # Resolve sender user
    sender_user: AppUser | None = None
    if sender_username:
        sender_user = (
            db.query(AppUser)
            .filter(func.lower(AppUser.username) == sender_username, AppUser.is_active.is_(True))
            .first()
        )
    if not sender_user:
        sender_user = _admin_viewer(db)

    # Process attachments
    raw_attachments = (
        payload.get("attachments") if "attachments" in payload else payload.get("attachment")
    )
    processed_attachments = _process_bridge_attachments(raw_attachments)

    # Send email
    result = inbox_module.compose(
        sender_user,
        to=to_addr,
        subject=subject,
        body=body,
        cc=cc,
        bcc=bcc,
        attachments=processed_attachments,
    )

    if result.get("status") != "sent":
        err_msg = result.get("message") or "Failed to send email via mail server"
        raise RuntimeError(err_msg)

    # Activity logging
    lead_id = payload.get("lead_id")
    try:
        activity_module.log_activity(
            db,
            user_id=sender_user.id,
            activity_type=activity_module.INBOX_REPLIED,
            title="External CNF Bridge email sent",
            summary=f"Sent “{subject}” → {to_addr}",
            entity_type="lead" if lead_id else "inbox_compose",
            entity_id=int(lead_id) if lead_id else None,
            details={
                "source": "cnf_pricing_bridge",
                "to": to_addr,
                "subject": subject,
                "cc": cc,
                "attachments_count": len(processed_attachments),
                "lead_id": lead_id,
            },
        )
    except Exception:  # noqa: BLE001
        pass

    return {
        "status": "sent",
        "from_email": result.get("from") or sender_user.mailbox_email or sender_user.username,
        "to": to_addr,
        "subject": subject,
        "attachments_count": len(processed_attachments),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


def auto_reply_bridge_email(db: Session, payload: dict[str, Any]) -> dict[str, Any]:
    """Process an inbound email forwarded by an external pipeline (e.g. Kafi Commodities app),
    generate an AI reply, send it back to the sender, and record logs.

    Accepts: { from, fromName, subject, body, attachment? }
    Returns: { ok: true, ... } or { ok: false, error: ... }
    """
    import hashlib
    from modules import activity as activity_module
    from modules import ai_mode as ai_mode_module
    from modules import inbox as inbox_module

    try:
        from_addr = (
            payload.get("from")
            or payload.get("from_email")
            or payload.get("sender")
            or payload.get("fromEmail")
            or ""
        ).strip()
        if not from_addr or "@" not in from_addr:
            return {"ok": False, "error": "Invalid or missing 'from' email address"}

        from_name = (
            payload.get("fromName")
            or payload.get("from_name")
            or payload.get("name")
            or ""
        ).strip()
        subject = (payload.get("subject") or "").strip()
        body = (
            payload.get("body")
            or payload.get("text")
            or payload.get("content")
            or payload.get("preview")
            or ""
        ).strip()

        # Deduplication key to prevent double-processing:
        message_id = str(
            payload.get("message_id")
            or payload.get("messageId")
            or payload.get("id")
            or ""
        ).strip()

        # Resolve sender user (mailbox used to send the reply)
        sender_username = (payload.get("sender_username") or "").strip().lower()
        sender_user: AppUser | None = None
        if sender_username:
            sender_user = (
                db.query(AppUser)
                .filter(func.lower(AppUser.username) == sender_username, AppUser.is_active.is_(True))
                .first()
            )
        if not sender_user:
            sender_user = _admin_viewer(db)

        # Compute unique key for this inbound email to prevent race conditions or double-processing
        if message_id:
            msg_key = f"bridge:{from_addr.lower()}:{message_id}"
        else:
            content_sig = f"{subject}:{body[:200]}".encode()
            msg_key = f"bridge:{from_addr.lower()}:{hashlib.sha256(content_sig).hexdigest()[:16]}"

        claimed = ai_mode_module._try_claim_auto_reply(
            db,
            user_id=sender_user.id,
            channel="email",
            message_key=msg_key,
            recipient=from_addr,
            subject=subject or "Inquiry",
            preview=body[:400] if body else subject[:400],
        )
        if not claimed:
            return {
                "ok": True,
                "status": "skipped",
                "reason": "already_processed_or_claimed",
                "recipient": from_addr,
                "message_key": msg_key,
            }

        # Generate AI reply using Sales Agent AI engine
        settings = ai_mode_module.get_or_create_settings(db, sender_user.id)
        draft_result = ai_mode_module._compose_query_auto_reply_email_body(
            settings=settings,
            sender_name=from_name,
            sender_email=from_addr,
            subject=subject,
            inbound_body=body or subject,
        )

        greeting_name = (
            draft_result.get("greeting_name")
            or from_name
            or from_addr.split("@")[0]
        )
        reply_body = (draft_result.get("body") or "").strip()
        if not reply_body:
            reply_body = ai_mode_module.render_template(
                settings.email_body_template,
                name=greeting_name,
                form_url=settings.form_url,
                subject=subject,
            )

        if subject:
            reply_subject = f"Re: {subject}" if not subject.lower().startswith("re:") else subject
        else:
            reply_subject = ai_mode_module.render_template(
                settings.email_subject_template or "Re: Thank you for contacting Kafi Commodities",
                name=greeting_name,
                form_url=settings.form_url,
                subject="",
            )

        # Process attachments if provided
        processed_attachments = _process_bridge_attachments(
            payload.get("attachments") if "attachments" in payload else payload.get("attachment")
        )

        send_res = inbox_module.compose(
            sender_user,
            to=from_addr,
            subject=reply_subject,
            body=reply_body,
            attachments=processed_attachments,
        )

        if send_res.get("status") != "sent":
            err_msg = send_res.get("message") or "Failed to send auto-reply email via mail server"
            ai_mode_module._log_reply(
                db,
                user_id=sender_user.id,
                channel="email",
                message_key=msg_key,
                recipient=from_addr,
                subject=reply_subject,
                preview=body[:400] if body else subject[:400],
                status="error",
                detail=err_msg,
            )
            return {"ok": False, "error": err_msg}

        # Log to AI auto-reply log
        ai_mode_module._log_reply(
            db,
            user_id=sender_user.id,
            channel="email",
            message_key=msg_key,
            recipient=from_addr,
            subject=reply_subject,
            preview=body[:400] if body else subject[:400],
            status="sent",
            detail=f"source=agent_bridge; reply_source={draft_result.get('source')}; model={draft_result.get('model')}",
        )

        # Log to activity history
        try:
            activity_module.log_activity(
                db,
                user_id=sender_user.id,
                activity_type=activity_module.INBOX_REPLIED,
                title="Bridge email AI auto-reply sent",
                summary=f"Auto-replied “{reply_subject}” → {from_addr}",
                entity_type="inbox_compose",
                details={
                    "source": "agent_bridge_auto_reply",
                    "to": from_addr,
                    "subject": reply_subject,
                    "reply_source": draft_result.get("source"),
                    "model": draft_result.get("model"),
                    "message_key": msg_key,
                },
            )
        except Exception:  # noqa: BLE001
            pass

        return {
            "ok": True,
            "recipient": from_addr,
            "subject": reply_subject,
            "reply_body": reply_body,
            "reply_source": draft_result.get("source"),
            "model": draft_result.get("model"),
        }
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}



# ── Outbound CNF Pricing Engine Client (https://kafiai-agents.vercel.app) ──────

CNF_APP_BASE_URL = "https://kafiai-agents.vercel.app"


def get_bridge_secret() -> str:
    import os

    return (
        os.getenv("AGENT_BRIDGE_SECRET")
        or os.getenv("SALES_AGENT_BRIDGE_SECRET")
        or ""
    )


def fetch_live_pricing(sku: str) -> dict[str, Any]:
    """Fetch real-time live FOB pricing for SKU from CNF/FOB costing engine."""
    import json
    import os
    import urllib.parse
    import urllib.request

    base_url = os.getenv("CNF_APP_BASE_URL", CNF_APP_BASE_URL).rstrip("/")
    secret = get_bridge_secret()
    url = f"{base_url}/api/agent-bridge/pricing?sku={urllib.parse.quote(sku.strip())}"
    headers = {
        "User-Agent": "Kafi-Sales-Agent/1.0",
        "Authorization": f"Bearer {secret}",
        "x-bridge-secret": secret,
    }
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data
    except urllib.error.HTTPError as exc:
        err_body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"CNF Pricing API error ({exc.code}): {err_body}") from exc
    except Exception as exc:
        raise RuntimeError(f"Failed to connect to CNF Pricing API: {exc}") from exc


def fetch_pricing_card(sku: str, format_type: str = "image") -> dict[str, Any]:
    """Fetch single-product price card (image or PDF) from CNF costing engine."""
    import json
    import os
    import urllib.parse
    import urllib.request

    base_url = os.getenv("CNF_APP_BASE_URL", CNF_APP_BASE_URL).rstrip("/")
    secret = get_bridge_secret()
    fmt = "pdf" if format_type.lower() == "pdf" else "image"
    url = f"{base_url}/api/agent-bridge/pricing-card?sku={urllib.parse.quote(sku.strip())}&format={fmt}"
    headers = {
        "User-Agent": "Kafi-Sales-Agent/1.0",
        "Authorization": f"Bearer {secret}",
        "x-bridge-secret": secret,
    }
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data
    except urllib.error.HTTPError as exc:
        err_body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"CNF Price Card API error ({exc.code}): {err_body}") from exc
    except Exception as exc:
        raise RuntimeError(f"Failed to fetch CNF price card: {exc}") from exc


def fetch_quotation_card(quotation_id: str, format_type: str = "pdf") -> dict[str, Any]:
    """Fetch full container CNF quotation card (image or PDF) from CNF engine."""
    import json
    import os
    import urllib.parse
    import urllib.request

    base_url = os.getenv("CNF_APP_BASE_URL", CNF_APP_BASE_URL).rstrip("/")
    secret = get_bridge_secret()
    fmt = "pdf" if format_type.lower() == "pdf" else "image"
    url = f"{base_url}/api/agent-bridge/quotation-card?id={urllib.parse.quote(quotation_id.strip())}&format={fmt}"
    headers = {
        "User-Agent": "Kafi-Sales-Agent/1.0",
        "Authorization": f"Bearer {secret}",
        "x-bridge-secret": secret,
    }
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data
    except urllib.error.HTTPError as exc:
        err_body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"CNF Quotation Card API error ({exc.code}): {err_body}") from exc
    except Exception as exc:
        raise RuntimeError(f"Failed to fetch CNF quotation card: {exc}") from exc


def attach_live_pricing_card(sku: str, format_type: str = "image") -> dict[str, Any]:
    """Fetch and register a live price card directly into Sales Agent attachments."""
    import base64
    from modules.email_attachments import register_attachment_from_bytes

    card_data = fetch_pricing_card(sku=sku, format_type=format_type)
    b64_str = card_data.get("base64") or ""
    if "," in b64_str and ";base64" in b64_str[:50]:
        b64_str = b64_str.split(",", 1)[1]
    file_bytes = base64.b64decode(b64_str)

    ext = "pdf" if format_type.lower() == "pdf" else "png"
    mime = "application/pdf" if format_type.lower() == "pdf" else "image/png"
    safe_sku = "".join(c if c.isalnum() or c in "-_" else "_" for c in sku).strip("_")
    filename = f"Kafi_Price_Card_{safe_sku.upper() or 'PRODUCT'}.{ext}"

    reg_att = register_attachment_from_bytes(file_bytes, filename=filename, content_type=mime)
    return reg_att


def attach_live_quotation_card(quotation_id: str, format_type: str = "pdf") -> dict[str, Any]:
    """Fetch and register a live container quotation card into Sales Agent attachments."""
    import base64
    from modules.email_attachments import register_attachment_from_bytes

    card_data = fetch_quotation_card(quotation_id=quotation_id, format_type=format_type)
    b64_str = card_data.get("base64") or ""
    if "," in b64_str and ";base64" in b64_str[:50]:
        b64_str = b64_str.split(",", 1)[1]
    file_bytes = base64.b64decode(b64_str)

    ext = "pdf" if format_type.lower() == "pdf" else "png"
    mime = "application/pdf" if format_type.lower() == "pdf" else "image/png"
    safe_qid = "".join(c if c.isalnum() or c in "-_" else "_" for c in quotation_id).strip("_")
    filename = f"Kafi_CNF_Quotation_{safe_qid.upper() or 'QUOTE'}.{ext}"

    reg_att = register_attachment_from_bytes(file_bytes, filename=filename, content_type=mime)
    return reg_att


