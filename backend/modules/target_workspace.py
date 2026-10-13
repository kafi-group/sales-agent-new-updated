"""Target and Workspace module — daily country targets, 4-stage outreach funnel,
11-stage inbound deals pipeline, dead lead health meter, drip campaign, and admin verification."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo
from sqlalchemy import func, or_
from sqlalchemy.orm import Session, joinedload

from db.models import (
    AiCompanyLifecycle,
    AppUser,
    AppUserRole,
    Buyer,
    Contact,
    DayCountryTarget,
    DripCampaignLead,
    UserActivityEvent,
    WorkspaceLeadLifecycle,
    WorkspaceReviewOption,
)
from modules import activity as activity_module
from modules.call_timing import get_call_recommendation
from modules.client_history import resolve_current_remarks

PK_TZ = ZoneInfo("Asia/Karachi")


def _phone_digits(raw: str | None) -> str:
    return "".join(ch for ch in str(raw or "") if ch.isdigit())


def _collect_workspace_phones(
    *,
    contacts: list[Any],
    replacement_phone: str | None = None,
) -> list[dict[str, Any]]:
    """All distinct phone numbers on this buyer's contacts (workspace outreach only)."""
    seen: set[str] = set()
    phones: list[dict[str, Any]] = []

    def add(
        raw: str | None,
        *,
        field_label: str,
        contact_id: int | None = None,
        contact_name: str | None = None,
    ) -> None:
        value = (raw or "").strip()
        if not value:
            return
        digits = _phone_digits(value)
        if len(digits) < 6:
            return
        # Dedupe by last 10 digits so +92… and 0… variants collapse.
        key = digits[-10:] if len(digits) >= 10 else digits
        if key in seen:
            return
        seen.add(key)
        phones.append(
            {
                "number": value,
                "field_label": field_label,
                "contact_id": contact_id,
                "contact_name": contact_name,
            }
        )

    for contact in contacts:
        cid = int(contact.id) if getattr(contact, "id", None) is not None else None
        cname = (getattr(contact, "full_name", None) or "").strip() or None
        add(getattr(contact, "primary_phone", None), field_label="Primary phone", contact_id=cid, contact_name=cname)
        add(getattr(contact, "phone", None), field_label="Phone", contact_id=cid, contact_name=cname)
        add(
            getattr(contact, "secondary_mobile", None),
            field_label="Secondary mobile",
            contact_id=cid,
            contact_name=cname,
        )
        add(
            getattr(contact, "secondary_phone", None),
            field_label="Secondary phone",
            contact_id=cid,
            contact_name=cname,
        )
        add(getattr(contact, "wa_id", None), field_label="WhatsApp ID", contact_id=cid, contact_name=cname)

    add(replacement_phone, field_label="Replacement phone")

    for idx, row in enumerate(phones, start=1):
        row["index"] = idx
        row["select_label"] = f"#{idx}"
    return phones


# 4 Core Outreach Stages (+ interested promotes out into Interested/Potential deals)
OUTREACH_STAGE_KEYS = frozenset(
    {"fresh", "needs_follow_up", "not_interested", "no_response"}
)
OUTREACH_STAGES = [
    {"key": "fresh", "label": "Never Contacted / Fresh", "color": "emerald"},
    {"key": "needs_follow_up", "label": "Needs Follow Up", "color": "amber"},
    {"key": "not_interested", "label": "Not Interested", "color": "rose"},
    {"key": "no_response", "label": "No Response", "color": "slate"},
]
WORKSPACE_LEAD_STAGES = OUTREACH_STAGE_KEYS | {"interested"}

DEFAULT_DAY_TARGETS: dict[str, list[str]] = {
    "monday": ["United Arab Emirates", "Saudi Arabia", "Oman"],
    "tuesday": ["Vietnam", "Malaysia", "Singapore"],
    "wednesday": ["Egypt", "Turkey", "Jordan"],
    "thursday": ["Philippines", "Thailand", "South Africa"],
    "friday": ["China", "Indonesia", "Tanzania"],
    "saturday": ["Bahrain", "Kuwait", "Qatar"],
    "sunday": ["Global / International", "Other Markets"],
}

DEFAULT_FOLLOW_UP_REASONS = [
    {"label": "Need approval from HO", "value": "need_approval_ho", "action_hint": "Prepare formal business proposal for Head Office review"},
    {"label": "Call back later", "value": "call_back_later", "action_hint": "Schedule callback at client requested time slot"},
    {"label": "Currently searching for more vendors until further notice", "value": "searching_vendors", "action_hint": "Send competitive FOB/CNF comparison sheet"},
    {"label": "Requested formal quotation & pricing", "value": "quotation_requested", "action_hint": "Generate CNF/FOB quotation via Quotation Agent"},
    {"label": "Decision maker in meeting / out of office", "value": "decision_maker_busy", "action_hint": "Follow up via WhatsApp and email first"},
    {"label": "Reviewing samples / technical specifications", "value": "reviewing_samples", "action_hint": "Check in on test results / lab feedback"},
]

DEFAULT_NOT_INTERESTED_REASONS = [
    {
        "label": "Price High",
        "value": "price_high",
        "action_hint": "Call again and ask for their competitor's pricing; offer tiered volume discount or flexible payment terms.",
    },
    {
        "label": "Items Mismatch",
        "value": "items_mismatch",
        "action_hint": "Inquire exactly what products, grades, and packaging specifications they are currently importing.",
    },
    {
        "label": "Client is Exporter itself",
        "value": "client_exporter",
        "action_hint": "Assess if they are direct or indirect rival; explore barter trade, origin sourcing, or bilateral cooperation.",
    },
    {
        "label": "Already has an Exporter / Supplier",
        "value": "has_supplier",
        "action_hint": "Offer backup supply security, faster shipping transit, or specialized quality certificates.",
    },
    {
        "label": "Other objection",
        "value": "other",
        "action_hint": "Log specific customer rationale and schedule future re-engagement.",
    },
]


def seed_default_day_targets(db: Session) -> None:
    """Seed default target countries per day of week if empty."""
    try:
        if db.query(DayCountryTarget).count() == 0:
            for day, countries in DEFAULT_DAY_TARGETS.items():
                for c in countries:
                    db.add(DayCountryTarget(day_of_week=day.lower(), country=c, is_active=True))
            db.commit()
    except Exception as exc:
        db.rollback()
        print(f"Note on seed_default_day_targets: {exc}", flush=True)


def seed_default_review_options(db: Session) -> None:
    """Seed review reasons and objection actions if empty."""
    try:
        if db.query(WorkspaceReviewOption).count() == 0:
            for item in DEFAULT_FOLLOW_UP_REASONS:
                db.add(
                    WorkspaceReviewOption(
                        category="follow_up_reason",
                        label=item["label"],
                        value=item["value"],
                        action_hint=item["action_hint"],
                        is_system=True,
                    )
                )
            for item in DEFAULT_NOT_INTERESTED_REASONS:
                db.add(
                    WorkspaceReviewOption(
                        category="not_interested_reason",
                        label=item["label"],
                        value=item["value"],
                        action_hint=item["action_hint"],
                        is_system=True,
                    )
                )
            db.commit()
    except Exception as exc:
        db.rollback()
        print(f"Note on seed_default_review_options: {exc}", flush=True)


def _seed_defaults_if_empty(db: Session) -> None:
    """Seed default target countries and review options if tables are newly created."""
    seed_default_day_targets(db)
    seed_default_review_options(db)


def get_current_day_name() -> str:
    """Return lowercase day of week in Asia/Karachi (e.g. 'friday')."""
    now = datetime.now(PK_TZ)
    return now.strftime("%A").lower()


def get_day_country_targets(
    db: Session,
    *,
    day_of_week: str | None = None,
    user_id: int | None = None,
) -> list[dict[str, Any]]:
    """List target countries for a given day, scoped by user assignment if set."""
    _seed_defaults_if_empty(db)
    day = (day_of_week or get_current_day_name()).strip().lower()

    q = db.query(DayCountryTarget).filter(
        DayCountryTarget.day_of_week == day,
        DayCountryTarget.is_active.is_(True),
    )
    if user_id is not None:
        q = q.filter(
            or_(
                DayCountryTarget.assigned_user_id == user_id,
                DayCountryTarget.assigned_user_id.is_(None),
            )
        )

    rows = q.order_by(DayCountryTarget.country.asc()).all()
    results = []
    for r in rows:
        user_name = "All Users (Team)"
        try:
            if r.assigned_user and hasattr(r.assigned_user, "full_name") and r.assigned_user.full_name:
                user_name = r.assigned_user.full_name
        except Exception:
            pass
        results.append(
            {
                "id": r.id,
                "day_of_week": r.day_of_week,
                "country": r.country,
                "assigned_user_id": r.assigned_user_id,
                "assigned_user_name": user_name,
                "is_active": r.is_active,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
        )
    return results


def add_day_country_target(
    db: Session,
    *,
    day_of_week: str,
    country: str,
    assigned_user_id: int | None = None,
    created_by_user_id: int | None = None,
) -> dict[str, Any]:
    """Add a target country for a day."""
    day = day_of_week.strip().lower()
    c_name = country.strip()
    if not c_name:
        raise ValueError("Country name is required")

    existing = (
        db.query(DayCountryTarget)
        .filter(
            DayCountryTarget.day_of_week == day,
            func.lower(DayCountryTarget.country) == c_name.lower(),
            DayCountryTarget.assigned_user_id == assigned_user_id,
        )
        .first()
    )
    if existing:
        existing.is_active = True
        db.commit()
        db.refresh(existing)
        target = existing
    else:
        target = DayCountryTarget(
            day_of_week=day,
            country=c_name,
            assigned_user_id=assigned_user_id,
            created_by_user_id=created_by_user_id,
            is_active=True,
        )
        db.add(target)
        db.commit()
        db.refresh(target)

    return {
        "id": target.id,
        "day_of_week": target.day_of_week,
        "country": target.country,
        "assigned_user_id": target.assigned_user_id,
        "is_active": target.is_active,
    }


def remove_day_country_target(db: Session, *, target_id: int) -> bool:
    """Deactivate or remove a target country."""
    target = db.get(DayCountryTarget, target_id)
    if not target:
        return False
    db.delete(target)
    db.commit()
    return True


def _ensure_lead_lifecycle(db: Session, buyer_id: int, user_id: int | None = None) -> WorkspaceLeadLifecycle:
    """Fetch or create WorkspaceLeadLifecycle record for a lead."""
    row = (
        db.query(WorkspaceLeadLifecycle)
        .filter(WorkspaceLeadLifecycle.buyer_id == buyer_id)
        .first()
    )
    if not row:
        row = WorkspaceLeadLifecycle(
            buyer_id=buyer_id,
            user_id=user_id,
            stage="fresh",
        )
        db.add(row)
        db.commit()
        db.refresh(row)
    return row


def list_workspace_leads(
    db: Session,
    *,
    day_of_week: str | None = None,
    country: str | None = None,
    stage: str | None = None,
    user_id: int | None = None,
    search: str | None = None,
    master_type: str | None = "fmcg",
    page: int = 1,
    limit: int = 50,
) -> dict[str, Any]:
    """List leads filtered by today's target countries and 4 outreach funnel stages."""
    _seed_defaults_if_empty(db)
    day = (day_of_week or get_current_day_name()).strip().lower()

    # 1. Resolve countries assigned for this day
    target_country_records = get_day_country_targets(db, day_of_week=day, user_id=user_id)
    assigned_countries = [t["country"] for t in target_country_records if t.get("country")]

    # If specific country/countries selected (and not "all"), filter to them;
    # otherwise use all assigned countries for this day.
    # Comma-separated values allow multi-select from the Filter Country UI.
    if country and str(country).strip().lower() not in ["all", ""]:
        filter_countries = [
            part.strip()
            for part in str(country).split(",")
            if part.strip() and part.strip().lower() != "all"
        ]
    else:
        filter_countries = assigned_countries

    # 2. Build Buyer Query
    q = (
        db.query(Buyer)
        .options(joinedload(Buyer.contacts))
    )

    # Same master-list scoping as Master Table / My Assigned.
    mt = (master_type or "fmcg").strip().lower() or "fmcg"
    if mt == "fmcg":
        q = q.filter(
            or_(
                func.lower(Buyer.master_type) == "fmcg",
                Buyer.master_type.is_(None),
                Buyer.master_type == "",
            )
        )
    else:
        q = q.filter(func.lower(Buyer.master_type) == mt)

    if filter_countries:
        # Match country case-insensitively with trim and substring flexibility
        country_filters = []
        for c in filter_countries:
            if not c or not str(c).strip() or str(c).strip().lower() == "all":
                continue
            c_clean = str(c).strip().lower()
            country_filters.append(func.lower(func.trim(Buyer.country)) == c_clean)
            country_filters.append(Buyer.country.ilike(f"%{c_clean}%"))
        if country_filters:
            q = q.filter(or_(*country_filters))

    if search and search.strip():
        s = f"%{search.strip()}%"
        q = q.filter(
            or_(
                Buyer.company_name.ilike(s),
                Buyer.country.ilike(s),
                Buyer.industry.ilike(s),
                Buyer.product_interest.ilike(s),
            )
        )

    # Reps only see THEIR assigned leads (same pool as My Assigned Leads).
    # Do not include unassigned / other reps' buyers — that leaked extra Sibco etc.
    # Admin team view passes user_id=None and sees all buyers in target countries.
    if user_id is not None:
        q = q.filter(Buyer.assigned_to_user_id == user_id)

    # Cap SQL scan — funnel page paginates in Python; avoid loading the whole DB.
    buyers = q.order_by(Buyer.id.desc()).limit(2500).all()
    buyer_ids = [b.id for b in buyers]

    # Preload user map only for assignees on this page (not every AppUser).
    try:
        assignee_ids = {b.assigned_to_user_id for b in buyers if b.assigned_to_user_id}
        user_name_map: dict[int, str] = {}
        if assignee_ids:
            app_users = db.query(AppUser).filter(AppUser.id.in_(assignee_ids)).all()
            user_name_map = {u.id: (u.full_name or u.username) for u in app_users}
    except Exception:
        user_name_map = {}

    # 3. Preload WorkspaceLeadLifecycle records
    lifecycles_map: dict[int, WorkspaceLeadLifecycle] = {}
    if buyer_ids:
        try:
            lcs = (
                db.query(WorkspaceLeadLifecycle)
                .filter(WorkspaceLeadLifecycle.buyer_id.in_(buyer_ids))
                .all()
            )
            lifecycles_map = {lc.buyer_id: lc for lc in lcs}
        except Exception:
            lifecycles_map = {}

    # 4. Map & Categorize leads into 4 Funnel Stages
    stage_counts = {
        "fresh": 0,
        "needs_follow_up": 0,
        "not_interested": 0,
        "no_response": 0,
    }
    dead_lead_count = 0

    lead_items: list[dict[str, Any]] = []
    now_utc = datetime.now(timezone.utc)

    for b in buyers:
        try:
            lc = lifecycles_map.get(b.id)
            current_stage = lc.stage if lc else "fresh"

            # If no explicit lifecycle stage set yet, check if there's history on buyer
            if not lc:
                if b.remarks and ("not interested" in str(b.remarks).lower()):
                    current_stage = "not_interested"
                elif b.follow_up_at or (b.remarks and "follow" in str(b.remarks).lower()):
                    current_stage = "needs_follow_up"
                else:
                    current_stage = "fresh"

            # Promoted to Interested/Potential deals — leave the 4-stage outreach funnel
            if current_stage not in OUTREACH_STAGE_KEYS:
                continue

            if current_stage in stage_counts:
                stage_counts[current_stage] += 1
            else:
                stage_counts["fresh"] += 1
                current_stage = "fresh"

            contacts = getattr(b, "contacts", None) or []
            primary_contact = contacts[0] if len(contacts) > 0 else None

            # Calculate Dead Lead Health Meter
            emails_sent = (lc.emails_sent_count if lc else 0)
            calls_made = (lc.calls_made_count if lc else 0)
            
            # Check days since last interaction/update with safe timezone math
            last_activity_date = (lc.updated_at if lc and lc.updated_at else b.updated_at or b.created_at)
            days_no_response = 0
            if last_activity_date:
                try:
                    if last_activity_date.tzinfo is None:
                        act_utc = last_activity_date.replace(tzinfo=timezone.utc)
                    else:
                        act_utc = last_activity_date.astimezone(timezone.utc)
                    days_no_response = max(0, (now_utc - act_utc).days)
                except Exception:
                    days_no_response = 0

            # Meter turns RED if >= 20 emails or >= 30 days without response
            is_dead_lead = emails_sent >= 20 or (days_no_response >= 30 and calls_made > 0)
            if is_dead_lead:
                dead_lead_count += 1

            # Resolve TO DO Guidance for objections
            to_do_guidance = None
            if current_stage == "not_interested":
                reason = (lc.not_interested_reason if lc else None) or "price_high"
                for opt in DEFAULT_NOT_INTERESTED_REASONS:
                    if opt["value"] == reason:
                        to_do_guidance = opt["action_hint"]
                        break

            contact_person = (primary_contact.full_name if primary_contact and primary_contact.full_name else None) or getattr(b, "contact_person", None) or None
            email = (primary_contact.email if primary_contact and primary_contact.email else None) or getattr(b, "primary_email", None) or None
            designation = (primary_contact.designation if primary_contact and primary_contact.designation else None) or getattr(b, "designation", None) or None
            phones = _collect_workspace_phones(
                contacts=list(contacts),
                replacement_phone=(lc.replacement_phone if lc else None),
            )
            phone = phones[0]["number"] if phones else (
                (primary_contact.primary_phone or primary_contact.phone if primary_contact else None)
                or getattr(b, "primary_phone", None)
                or None
            )

            # Safe assigned to name
            assigned_name = user_name_map.get(b.assigned_to_user_id)
            if not assigned_name and b.assigned_to and str(b.assigned_to).lower() != "unassigned":
                assigned_name = str(b.assigned_to)

            call_timing = get_call_recommendation(b.country)

            latest_remarks = resolve_current_remarks(b) or None
            remarks_history_count = len(
                [
                    entry
                    for entry in (b.remarks_history or [])
                    if isinstance(entry, dict) and (entry.get("text") or "").strip()
                ]
            )
            if latest_remarks and remarks_history_count == 0:
                remarks_history_count = 1

            item_data = {
                "id": b.id,
                "buyer_id": b.id,
                "company_name": b.company_name or "Unnamed Company",
                "country": b.country or "",
                "city": b.city or "",
                "industry": b.industry or "",
                "product_interest": b.product_interest or "",
                "website_url": b.website_url or "",
                "contact_person": contact_person,
                "contact_name": contact_person,
                "contact_id": int(primary_contact.id) if primary_contact else None,
                "designation": designation,
                "contact_designation": designation,
                "primary_email": email,
                "email": email,
                "primary_phone": phone,
                "phone": phone,
                "phones": phones,
                "assigned_to_user_id": b.assigned_to_user_id,
                "assigned_to_name": assigned_name,
                "call_recommended": call_timing.get("call_recommended"),
                "call_local_time": call_timing.get("call_local_time"),
                "call_reason": call_timing.get("call_reason"),
                "remarks": latest_remarks,
                "remarks_history_count": remarks_history_count,
                "company_grading": getattr(b, "company_grading", None) or None,
                "stage": current_stage,
                "not_interested_reason": lc.not_interested_reason if lc else None,
                "not_interested_remarks": lc.not_interested_remarks if lc else None,
                "to_do_guidance": to_do_guidance,
                "todo_action_hint": to_do_guidance,
                "follow_up_reason": lc.follow_up_reason if lc else None,
                "follow_up_action": lc.follow_up_action if lc else None,
                "follow_up_date": lc.follow_up_date.isoformat() if lc and lc.follow_up_date else None,
                "whatsapp_call_tried": lc.whatsapp_call_tried if lc else False,
                "whatsapp_call_proof": lc.whatsapp_call_proof if lc else None,
                "searched_internet_email": lc.searched_internet_email if lc else False,
                "searched_internet_phone": lc.searched_internet_phone if lc else False,
                "replacement_email": lc.replacement_email if lc else None,
                "replacement_contact_name": lc.replacement_contact_name if lc else None,
                "replacement_phone": lc.replacement_phone if lc else None,
                "linkedin_request_sent": lc.linkedin_request_sent if lc else False,
                "linkedin_msg_sent": lc.linkedin_msg_sent if lc else False,
                "emails_sent_count": emails_sent,
                "calls_made_count": calls_made,
                "days_since_last_response": days_no_response,
                "days_no_response": days_no_response,
                "is_dead_lead_meter_red": is_dead_lead,
                "is_dead_lead": is_dead_lead,
                "is_drip_candidate": lc.is_drip_candidate if lc else False,
                "last_contacted_at": (lc.updated_at if lc else b.updated_at).isoformat() if (lc and lc.updated_at) or b.updated_at else None,
                "updated_at": (lc.updated_at if lc else b.updated_at).isoformat() if (lc and lc.updated_at) or b.updated_at else None,
            }

            # Stage filter
            if not stage or stage == "all" or current_stage == stage:
                lead_items.append(item_data)
        except Exception as lead_exc:
            print(f"Error mapping buyer {getattr(b, 'id', 'unknown')}: {lead_exc}", flush=True)

    # 5. Pagination
    total = len(lead_items)
    start_idx = (page - 1) * limit
    paginated_items = lead_items[start_idx : start_idx + limit]

    stage_counts["total"] = sum(stage_counts.values())

    return {
        "day_of_week": day,
        "target_countries": assigned_countries,
        "assigned_countries": assigned_countries,
        "selected_country": country,
        "master_type": mt,
        "counts": stage_counts,
        "stage_counts": stage_counts,
        "dead_lead_count": dead_lead_count,
        "total": total,
        "page": page,
        "limit": limit,
        "leads": paginated_items,
        "items": paginated_items,
    }


def update_workspace_lead_stage(
    db: Session,
    *,
    buyer_id: int,
    user: AppUser,
    stage: str,
    not_interested_reason: str | None = None,
    not_interested_remarks: str | None = None,
    follow_up_reason: str | None = None,
    follow_up_action: str | None = None,
    follow_up_date: datetime | None = None,
    whatsapp_call_tried: bool | None = None,
    whatsapp_call_proof: str | None = None,
    searched_internet_email: bool | None = None,
    searched_internet_phone: bool | None = None,
    linkedin_request_sent: bool | None = None,
    linkedin_msg_sent: bool | None = None,
    force_ai_autopilot: bool = False,
) -> dict[str, Any]:
    """Update outreach stage, objection reasons, follow-up parameters, or audit verification proof.

    Stage ``interested`` removes the lead from the 4-stage outreach funnel and places it
    into the Interested/Potential (AI company lifecycle) deals pipeline.

    ``force_ai_autopilot`` lets Sara/Rayan apply stages without human assignment checks.
    """
    buyer = db.get(Buyer, buyer_id)
    if not buyer:
        raise ValueError("Lead / Buyer not found")

    stage_key = (stage or "").strip().lower().replace(" ", "_").replace("-", "_")
    if stage_key not in WORKSPACE_LEAD_STAGES:
        raise ValueError(
            f"Invalid stage. Use one of: {', '.join(sorted(WORKSPACE_LEAD_STAGES))}"
        )

    # Non-admins may only update leads assigned to them (workspace = assigned pool).
    role = user.role.value if hasattr(user.role, "value") else str(user.role)
    if not force_ai_autopilot and role != "admin" and buyer.assigned_to_user_id != user.id:
        raise ValueError("This lead is not assigned to you")

    lc = _ensure_lead_lifecycle(db, buyer_id, user_id=user.id)
    old_stage = lc.stage
    lc.stage = stage_key
    lc.user_id = user.id

    if not_interested_reason is not None:
        lc.not_interested_reason = not_interested_reason
    if not_interested_remarks is not None:
        lc.not_interested_remarks = not_interested_remarks
    if follow_up_reason is not None:
        lc.follow_up_reason = follow_up_reason
    if follow_up_action is not None:
        lc.follow_up_action = follow_up_action
    if follow_up_date is not None:
        lc.follow_up_date = follow_up_date
    if whatsapp_call_tried is not None:
        lc.whatsapp_call_tried = whatsapp_call_tried
    if whatsapp_call_proof is not None:
        lc.whatsapp_call_proof = whatsapp_call_proof
    if searched_internet_email is not None:
        lc.searched_internet_email = searched_internet_email
    if searched_internet_phone is not None:
        lc.searched_internet_phone = searched_internet_phone
    if linkedin_request_sent is not None:
        lc.linkedin_request_sent = linkedin_request_sent
    if linkedin_msg_sent is not None:
        lc.linkedin_msg_sent = linkedin_msg_sent

    if stage_key == "interested":
        now = datetime.now(timezone.utc)
        if buyer.interested_clients_list_at is None:
            buyer.interested_clients_list_at = now
        ai_row = (
            db.query(AiCompanyLifecycle)
            .filter(AiCompanyLifecycle.buyer_id == buyer_id)
            .one_or_none()
        )
        # Don't pull closed/advanced deals backward; otherwise land on interested.
        protected = {"quotation_sent", "negotiation", "won", "lost"}
        if not ai_row:
            db.add(
                AiCompanyLifecycle(
                    buyer_id=buyer_id,
                    stage="interested",
                    stage_entered_at=now,
                    history=[
                        {
                            "stage": "interested",
                            "at": now.isoformat(),
                            "notes": "Marked interested from Outreach Funnel",
                            "by_user_id": user.id,
                        }
                    ],
                    updated_by_user_id=user.id,
                )
            )
        elif ai_row.stage not in protected:
            history = list(ai_row.history or [])
            if ai_row.stage != "interested":
                history.append(
                    {
                        "stage": "interested",
                        "at": now.isoformat(),
                        "notes": "Marked interested from Outreach Funnel",
                        "by_user_id": user.id,
                    }
                )
                ai_row.stage = "interested"
                ai_row.stage_entered_at = now
                ai_row.history = history
            ai_row.updated_by_user_id = user.id
            ai_row.updated_at = now

    db.commit()
    db.refresh(lc)

    # Log KPI / Audit Activity event for Mr. Khalid
    if old_stage != stage_key or whatsapp_call_proof or searched_internet_email:
        proof_note = f" (WhatsApp proof: {whatsapp_call_proof})" if whatsapp_call_proof else ""
        activity_module.log_activity(
            db,
            user_id=user.id,
            activity_type=activity_module.TABLE_ROW_EDITED,
            title="Workspace Stage Update",
            summary=f"Updated {buyer.company_name} to {stage_key.replace('_', ' ').title()}{proof_note}",
            entity_type="buyer",
            entity_id=buyer.id,
            details={
                "buyer_id": buyer.id,
                "company_name": buyer.company_name,
                "stage": stage_key,
                "whatsapp_call_proof": whatsapp_call_proof,
                "searched_internet_email": searched_internet_email,
            },
        )

    return {
        "buyer_id": buyer.id,
        "stage": lc.stage,
        "not_interested_reason": lc.not_interested_reason,
        "follow_up_reason": lc.follow_up_reason,
        "whatsapp_call_tried": lc.whatsapp_call_tried,
        "whatsapp_call_proof": lc.whatsapp_call_proof,
        "searched_internet_email": lc.searched_internet_email,
        "updated_at": lc.updated_at.isoformat() if lc.updated_at else None,
    }


def replace_contact_and_shift_to_drip(
    db: Session,
    *,
    buyer_id: int,
    user: AppUser,
    new_contact_name: str,
    new_email: str,
    new_phone: str | None = None,
    new_designation: str | None = None,
    product_type: str = "FMCG / Food & Beverage",
    notes: str | None = None,
) -> dict[str, Any]:
    """Shift dead/stale email into independent Drip Campaign table (15-day cadence)
    and update the active Contact with new verified details."""
    buyer = db.get(Buyer, buyer_id)
    if not buyer:
        raise ValueError("Lead / Buyer not found")

    primary_contact = buyer.contacts[0] if buyer.contacts else None
    old_email = primary_contact.email if primary_contact and primary_contact.email else "unknown@email.com"
    old_name = primary_contact.full_name if primary_contact else "Old Contact"
    old_designation = primary_contact.designation if primary_contact else ""

    # 1. Enroll Old Contact into DripCampaignLead (Completely separate table)
    drip_entry = DripCampaignLead(
        company_name=buyer.company_name,
        product_type=product_type or buyer.industry or "FMCG / General",
        contact_person_name=old_name,
        contact_designation=old_designation,
        email=old_email,
        country=buyer.country,
        source_buyer_id=buyer.id,
        user_id=user.id,
        status="active",
        notes=notes or f"Replaced by {user.full_name} on {datetime.now(PK_TZ).strftime('%d %b %Y')}",
    )
    db.add(drip_entry)

    # 2. Update Active Contact in Master Table with New Verified Contact Details
    if primary_contact:
        primary_contact.full_name = new_contact_name.strip()
        primary_contact.email = new_email.strip()
        if new_phone:
            primary_contact.phone = new_phone.strip()
            primary_contact.primary_phone = new_phone.strip()
        if new_designation:
            primary_contact.designation = new_designation.strip()
    else:
        new_contact = Contact(
            buyer_id=buyer.id,
            full_name=new_contact_name.strip(),
            email=new_email.strip(),
            phone=new_phone.strip() if new_phone else None,
            designation=new_designation.strip() if new_designation else None,
        )
        db.add(new_contact)

    # 3. Update WorkspaceLeadLifecycle: Reset to Fresh / Verified and flag internet research completed
    lc = _ensure_lead_lifecycle(db, buyer.id, user_id=user.id)
    lc.stage = "fresh"  # Reset to Fresh so rep can call the new person
    lc.searched_internet_email = True
    lc.searched_internet_phone = True if new_phone else False
    lc.replacement_email = new_email.strip()
    lc.replacement_contact_name = new_contact_name.strip()
    lc.replacement_phone = new_phone.strip() if new_phone else None
    lc.emails_sent_count = 0  # Reset counter for new contact
    lc.calls_made_count = 0
    lc.is_drip_candidate = False

    db.commit()
    db.refresh(drip_entry)

    # 4. Log Activity for Admin Audit
    activity_module.log_activity(
        db,
        user_id=user.id,
        activity_type=activity_module.TABLE_ROW_EDITED,
        title="Contact Replaced & Shifted to Drip",
        summary=f"Replaced {old_email} with {new_email} for {buyer.company_name}. Old email moved to Drip Campaign.",
        entity_type="buyer",
        entity_id=buyer.id,
        details={
            "buyer_id": buyer.id,
            "company_name": buyer.company_name,
            "old_email": old_email,
            "new_email": new_email,
            "new_contact_name": new_contact_name,
            "drip_id": drip_entry.id,
        },
    )

    return {
        "success": True,
        "drip_id": drip_entry.id,
        "buyer_id": buyer.id,
        "company_name": buyer.company_name,
        "new_contact_name": new_contact_name,
        "new_email": new_email,
        "new_phone": new_phone,
        "drip_email": old_email,
        "stage": lc.stage,
    }


def list_drip_campaign_leads(
    db: Session,
    *,
    user_id: int | None = None,
    search: str | None = None,
    page: int = 1,
    limit: int = 50,
) -> dict[str, Any]:
    """List all replaced / dead emails enrolled in the 15-day Drip Campaign table."""
    q = db.query(DripCampaignLead)
    if user_id is not None:
        q = q.filter(
            or_(
                DripCampaignLead.user_id == user_id,
                DripCampaignLead.user_id.is_(None),
            )
        )
    if search:
        s = f"%{search.strip()}%"
        q = q.filter(
            or_(
                DripCampaignLead.company_name.ilike(s),
                DripCampaignLead.email.ilike(s),
                DripCampaignLead.contact_person_name.ilike(s),
                DripCampaignLead.country.ilike(s),
            )
        )

    total = q.count()
    rows = (
        q.order_by(DripCampaignLead.added_at.desc())
        .offset((page - 1) * limit)
        .limit(limit)
        .all()
    )

    now_utc = datetime.now(timezone.utc)
    items = []
    for r in rows:
        added = r.added_at.replace(tzinfo=timezone.utc) if r.added_at else now_utc
        days_in_drip = (now_utc - added).days
        items.append(
            {
                "id": r.id,
                "company_name": r.company_name,
                "product_type": r.product_type,
                "contact_person_name": r.contact_person_name,
                "contact_designation": r.contact_designation,
                "email": r.email,
                "country": r.country,
                "days_in_drip": days_in_drip,
                "drip_emails_sent_count": r.drip_emails_sent_count,
                "responses_received_count": r.responses_received_count,
                "status": r.status,
                "last_drip_sent_at": r.last_drip_sent_at.isoformat() if r.last_drip_sent_at else None,
                "notes": r.notes,
                "added_at": r.added_at.isoformat() if r.added_at else None,
            }
        )

    return {
        "total": total,
        "page": page,
        "limit": limit,
        "cadence_days": 15,
        "items": items,
    }


def list_review_options(db: Session, *, category: str | None = None) -> list[dict[str, Any]]:
    """List customizable review reasons & action hints."""
    _seed_defaults_if_empty(db)
    q = db.query(WorkspaceReviewOption)
    if category:
        q = q.filter(WorkspaceReviewOption.category == category)
    rows = q.order_by(WorkspaceReviewOption.id.asc()).all()
    return [
        {
            "id": r.id,
            "category": r.category,
            "label": r.label,
            "value": r.value,
            "action_hint": r.action_hint,
            "is_system": r.is_system,
        }
        for r in rows
    ]


def add_review_option(
    db: Session,
    *,
    category: str,
    label: str,
    action_hint: str | None = None,
    user_id: int | None = None,
) -> dict[str, Any]:
    """Add a new custom review dropdown option."""
    val = label.strip().lower().replace(" ", "_")[:95]
    row = WorkspaceReviewOption(
        category=category.strip(),
        label=label.strip(),
        value=val,
        action_hint=action_hint.strip() if action_hint else None,
        is_system=False,
        created_by_user_id=user_id,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return {
        "id": row.id,
        "category": row.category,
        "label": row.label,
        "value": row.value,
        "action_hint": row.action_hint,
        "is_system": row.is_system,
    }


def delete_review_option(db: Session, *, option_id: int) -> bool:
    """Delete a custom review dropdown option."""
    row = db.get(WorkspaceReviewOption, option_id)
    if not row or row.is_system:
        return False
    db.delete(row)
    db.commit()
    return True
