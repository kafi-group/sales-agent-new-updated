"""Manual follow-up reminders for Follow up clients and Did not receive call."""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy.orm import Session

from db.models import Buyer, Channel, Contact, Interaction
from modules.calls import buyer_ids_with_latest_call_outcome, parse_call_fields

_FOLLOW_UP_SCHEDULE_OUTCOMES = frozenset({"follow_up", "not_received_call"})

_SECTION_BY_OUTCOME = {
    "follow_up": "interested_clients",
    "not_received_call": "not_received_call_clients",
}


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _latest_outcome_for_buyer(db: Session, buyer_id: int) -> str | None:
    rows = (
        db.query(Interaction)
        .join(Contact, Interaction.contact_id == Contact.id)
        .filter(Contact.buyer_id == buyer_id, Interaction.channel == Channel.phone)
        .order_by(Interaction.created_at.desc())
        .all()
    )
    for interaction in rows:
        outcome = parse_call_fields(interaction.content).get("call_outcome")
        if outcome:
            return str(outcome).lower()
    return None


def _placement_date_for_buyer(db: Session, buyer_id: int) -> datetime | None:
    """Latest phone call with a follow-up / not-received outcome."""
    rows = (
        db.query(Interaction)
        .join(Contact, Interaction.contact_id == Contact.id)
        .filter(Contact.buyer_id == buyer_id, Interaction.channel == Channel.phone)
        .order_by(Interaction.created_at.desc())
        .all()
    )
    for interaction in rows:
        outcome = parse_call_fields(interaction.content).get("call_outcome")
        if outcome and str(outcome).lower() in _FOLLOW_UP_SCHEDULE_OUTCOMES:
            return interaction.created_at
    return None


def _primary_contact_name(db: Session, buyer_id: int) -> str | None:
    contact = (
        db.query(Contact)
        .filter(Contact.buyer_id == buyer_id)
        .order_by(Contact.id.asc())
        .first()
    )
    return contact.full_name if contact else None


def _schedule_eligible_buyer_ids(db: Session) -> set[int]:
    ids: set[int] = set()
    for outcome in _FOLLOW_UP_SCHEDULE_OUTCOMES:
        ids |= buyer_ids_with_latest_call_outcome(db, outcome)
    # Interested Clients can also schedule a next-call reminder.
    listed = {
        row[0]
        for row in db.query(Buyer.id)
        .filter(Buyer.interested_clients_list_at.isnot(None))
        .all()
    }
    return ids | listed


def sync_buyer_interested_status(
    db: Session,
    *,
    buyer_id: int,
    new_outcome: str | None,
    previous_outcome: str | None = None,
    user_id: int | None = None,
    user_label: str | None = None,
) -> None:
    buyer = db.get(Buyer, buyer_id)
    if not buyer:
        return

    prev = (previous_outcome or "").strip().lower() or None
    new = (new_outcome or "").strip().lower() or None

    if new == "interested":
        # Client is Interested → Interested Clients table (not Follow up).
        was_new = buyer.interested_clients_list_at is None
        buyer.interested_at = _utcnow()
        buyer.interested_follow_up_ack_at = None
        if was_new:
            if user_id is not None:
                from modules import ai_mode as ai_mode_module

                ai_mode_module.record_interested_activity(
                    db,
                    user_id=user_id,
                    company_name=buyer.company_name,
                    buyer_id=buyer.id,
                    source="call",
                    user_label=user_label,
                    note="Call outcome: Client is Interested",
                    commit=False,
                )
            else:
                buyer.interested_clients_list_at = _utcnow()
    elif new == "follow_up":
        # Next call scheduled — Follow up clients only; does not imply interest.
        if prev == "interested":
            # Keep Interested Clients membership if they were already interested.
            pass
        buyer.follow_up_at = None
    elif new == "not_received_call":
        if prev == "interested":
            # Keep Interested Clients membership; clear interested_at placement only.
            buyer.interested_at = None
            buyer.interested_follow_up_ack_at = None
        buyer.follow_up_at = None
    elif new == "not_interested":
        buyer.interested_at = None
        buyer.interested_follow_up_ack_at = None
        buyer.follow_up_at = None
        buyer.interested_clients_list_at = None
        if prev != "not_interested" and user_id is not None:
            from modules import ai_mode as ai_mode_module

            ai_mode_module.record_not_interested_activity(
                db,
                user_id=user_id,
                company_name=buyer.company_name,
                buyer_id=buyer.id,
                source="call",
                user_label=user_label,
                note="Call outcome: Not interested",
                commit=False,
            )
        elif prev != "not_interested":
            from modules import ai_mode as ai_mode_module

            ai_mode_module.mark_buyer_not_interested_stage(
                db,
                buyer.id,
                user_id=user_id,
                note="Call outcome: Not interested",
                commit=False,
            )
    elif new == "closed_business":
        # Closed business / do not contact: out of Interested and Follow up, no reminders.
        buyer.interested_at = None
        buyer.interested_follow_up_ack_at = None
        buyer.follow_up_at = None
        buyer.interested_clients_list_at = None
    elif prev in {"interested", "follow_up", "not_received_call"} and new not in {
        "interested",
        "follow_up",
        "not_received_call",
        "not_interested",
    }:
        if prev == "interested":
            buyer.interested_at = None
            buyer.interested_follow_up_ack_at = None
        buyer.follow_up_at = None


def set_interested_clients_list_membership(
    db: Session,
    *,
    buyer_ids: list[int],
    in_list: bool,
    user_id: int | None = None,
    user_label: str | None = None,
) -> dict[str, object]:
    """Add/remove buyers from the Interested Clients leads-table section."""
    now = _utcnow()
    updated_ids: list[int] = []
    for buyer_id in buyer_ids:
        buyer = db.get(Buyer, buyer_id)
        if not buyer:
            continue
        if in_list:
            if buyer.interested_clients_list_at is None:
                if user_id is not None:
                    from modules import ai_mode as ai_mode_module

                    ai_mode_module.record_interested_activity(
                        db,
                        user_id=user_id,
                        company_name=buyer.company_name,
                        buyer_id=buyer.id,
                        source="manual",
                        user_label=user_label,
                        commit=False,
                    )
                else:
                    buyer.interested_clients_list_at = now
                updated_ids.append(buyer_id)
        elif buyer.interested_clients_list_at is not None:
            buyer.interested_clients_list_at = None
            updated_ids.append(buyer_id)
    if updated_ids:
        db.commit()
        from modules.leads import invalidate_section_counts_cache

        invalidate_section_counts_cache()
    return {"updated_count": len(updated_ids), "updated_ids": updated_ids}


def _ensure_placement_at(db: Session, buyer: Buyer) -> datetime:
    if buyer.interested_at:
        return buyer.interested_at
    placement = _placement_date_for_buyer(db, buyer.id)
    if placement:
        return placement
    return buyer.follow_up_at or _utcnow()


def list_due_follow_ups(
    db: Session,
    *,
    assigned_to_user_id: int | None = None,
) -> list[dict]:
    """Return clients whose manually scheduled follow-up date is due."""
    eligible_ids = _schedule_eligible_buyer_ids(db)
    if not eligible_ids:
        return []

    now = _utcnow()
    due: list[dict] = []

    query = (
        db.query(Buyer)
        .filter(Buyer.id.in_(eligible_ids), Buyer.follow_up_at.isnot(None))
    )
    if assigned_to_user_id is not None:
        query = query.filter(Buyer.assigned_to_user_id == assigned_to_user_id)
    buyers = query.all()
    for buyer in buyers:
        if not buyer.follow_up_at:
            continue
        due_at = _as_utc(buyer.follow_up_at)
        if now < due_at:
            continue

        outcome = _latest_outcome_for_buyer(db, buyer.id) or "follow_up"
        if buyer.interested_clients_list_at and outcome == "interested":
            section = "sales_interested_clients"
        else:
            section = _SECTION_BY_OUTCOME.get(outcome, "interested_clients")
        placement = _ensure_placement_at(db, buyer)
        placement_utc = _as_utc(placement)
        days_since = max(0, (now - placement_utc).days)
        contact_name = _primary_contact_name(db, buyer.id)
        stamp = due_at.strftime("%Y%m%d%H%M")

        due.append(
            {
                "id": f"{buyer.id}-{stamp}",
                "buyer_id": buyer.id,
                "company_name": buyer.company_name,
                "contact_name": contact_name,
                "interested_at": placement.isoformat(),
                "weeks_since_placement": max(1, days_since // 7) if days_since >= 7 else 0,
                "days_since_placement": days_since,
                "due_at": due_at.isoformat(),
                "call_outcome": outcome,
                "table_section": section,
            }
        )

    due.sort(key=lambda item: item["due_at"])
    return due


def set_follow_up_at(
    db: Session,
    *,
    buyer_id: int,
    follow_up_at: datetime | None,
    by_user_id: int | None = None,
    by_username: str | None = None,
) -> dict:
    buyer = db.get(Buyer, buyer_id)
    if not buyer:
        raise ValueError("Lead not found")
    if buyer_id not in _schedule_eligible_buyer_ids(db):
        raise ValueError(
            "Client must be on Follow up clients, Interested Clients, or Did not receive call "
            "to schedule a reminder"
        )

    if follow_up_at is not None:
        follow_up_at = _as_utc(follow_up_at)

    buyer.follow_up_at = follow_up_at
    buyer.interested_follow_up_ack_at = None
    db.commit()
    db.refresh(buyer)

    if follow_up_at is not None and by_user_id is not None:
        from modules import ai_mode as ai_mode_module

        ai_mode_module.record_follow_up_activity(
            db,
            user_id=by_user_id,
            company_name=buyer.company_name,
            buyer_id=buyer.id,
            event_type="scheduled",
            follow_up_at=follow_up_at,
            user_label=by_username,
        )

    return {
        "buyer_id": buyer.id,
        "follow_up_at": buyer.follow_up_at.isoformat() if buyer.follow_up_at else None,
    }


def acknowledge_follow_up(db: Session, *, buyer_id: int) -> dict:
    """Clear the scheduled reminder after the user acts on a due notification."""
    buyer = db.get(Buyer, buyer_id)
    if not buyer:
        raise ValueError("Lead not found")
    if buyer_id not in _schedule_eligible_buyer_ids(db):
        raise ValueError(
            "Client must be on Follow up clients, Interested Clients, or Did not receive call"
        )

    buyer.follow_up_at = None
    buyer.interested_follow_up_ack_at = _utcnow()
    db.commit()
    db.refresh(buyer)
    return {
        "buyer_id": buyer.id,
        "interested_follow_up_ack_at": buyer.interested_follow_up_ack_at.isoformat(),
        "follow_up_at": None,
    }
