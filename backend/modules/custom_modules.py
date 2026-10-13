"""Module for managing dynamic custom lead modules, sidebar lists, and testing staff recipients."""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from db.models import Buyer, Contact, CustomLeadModule
from modules.buyers import create_buyer, create_contact

logger = logging.getLogger(__name__)

# Default staff recipient profiles for daily morning bulk email & WhatsApp testing
DEFAULT_STAFF_RECIPIENTS = [
    {
        "company_name": "Kafi Commodities (Pvt.) Limited — Mr. Khalid (CEO)",
        "contact_name": "Khalid Mahmood Paracha",
        "designation": "CEO & Managing Director",
        "email": "khalid@kafi-group.com",
        "secondary_email": "info@kafi-group.com",
        "primary_mobile": "+923008206633",
        "country": "Pakistan",
        "city": "Karachi",
        "remarks": "Official Kafi Executive Staff for morning bulk email & WhatsApp testing",
    },
    {
        "company_name": "Kafi Commodities (Pvt.) Limited — Asim (Sales)",
        "contact_name": "Asim",
        "designation": "Senior Sales Executive",
        "email": "asim@kafi-group.com",
        "secondary_email": None,
        "primary_mobile": "+923008206633",
        "country": "Pakistan",
        "city": "Karachi",
        "remarks": "Official Kafi Sales Staff for morning bulk email & WhatsApp testing",
    },
    {
        "company_name": "Kafi Commodities (Pvt.) Limited — Usman Khan (Sales & Ops)",
        "contact_name": "Usman Khan",
        "designation": "Sales & Operations Executive",
        "email": "usman@kafi-group.com",
        "secondary_email": None,
        "primary_mobile": "+923008206633",
        "country": "Pakistan",
        "city": "Karachi",
        "remarks": "Official Kafi Sales Staff for morning bulk email & WhatsApp testing",
    },
    {
        "company_name": "Kafi Commodities (Pvt.) Limited — Sadia (Export Support)",
        "contact_name": "Sadia",
        "designation": "Sales Support & Export",
        "email": "sadia@kafi-group.com",
        "secondary_email": None,
        "primary_mobile": "+923008206633",
        "country": "Pakistan",
        "city": "Karachi",
        "remarks": "Official Kafi Export Staff for morning bulk email & WhatsApp testing",
    },
    {
        "company_name": "Kafi Commodities (Pvt.) Limited — Izaan (AI Systems)",
        "contact_name": "Izaan Bin Mujeeb",
        "designation": "AI Systems Admin",
        "email": "izaan@kafi-group.com",
        "secondary_email": None,
        "primary_mobile": "+923008206633",
        "country": "Pakistan",
        "city": "Karachi",
        "remarks": "Official Kafi Tech Staff for morning bulk email & WhatsApp testing",
    },
]


def list_custom_modules(
    db: Session,
    include_disabled: bool = True,
    *,
    master_type: str | None = "fmcg",
    assigned_to_user_id: int | None = None,
) -> list[dict[str, Any]]:
    """List all custom lead modules with live lead counts.

    Counts use the same master_type / assignee scope as the leads table and
    sidebar section-counts so badges match “X in section”.
    """
    from sqlalchemy import func as sa_func

    query = db.query(CustomLeadModule)
    if not include_disabled:
        query = query.filter(CustomLeadModule.is_enabled.is_(True))
    modules = query.order_by(CustomLeadModule.order_index.asc(), CustomLeadModule.id.asc()).all()

    count_q = db.query(sa_func.lower(Buyer.source), sa_func.count(Buyer.id)).filter(
        Buyer.source.isnot(None)
    )
    if master_type:
        mt = master_type.strip().lower()
        if mt == "fmcg":
            count_q = count_q.filter(
                or_(
                    sa_func.lower(Buyer.master_type) == "fmcg",
                    Buyer.master_type.is_(None),
                    Buyer.master_type == "",
                )
            )
        else:
            count_q = count_q.filter(sa_func.lower(Buyer.master_type) == mt)
    if assigned_to_user_id is not None:
        count_q = count_q.filter(Buyer.assigned_to_user_id == assigned_to_user_id)

    source_counts: dict[str, int] = dict(count_q.group_by(sa_func.lower(Buyer.source)).all())

    result = []
    for m in modules:
        key_clean = (m.key or "").strip().lower()
        count = int(source_counts.get(key_clean, 0) or 0)

        result.append(
            {
                "id": m.id,
                "key": m.key,
                "name": m.name,
                "description": m.description or "",
                "icon": m.icon or "📋",
                "color": m.color or "#3b82f6",
                "is_builtin": bool(m.is_builtin),
                "is_enabled": bool(m.is_enabled),
                "order_index": m.order_index,
                "count": count,
                "created_at": m.created_at.isoformat() if m.created_at else None,
            }
        )
    return result


def create_custom_module(db: Session, payload: dict[str, Any]) -> dict[str, Any]:
    """Create a new custom lead module / list."""
    name = (payload.get("name") or "").strip()
    if not name:
        raise ValueError("Module name is required")

    # Generate slug key
    raw_key = (payload.get("key") or "").strip().lower()
    if not raw_key:
        raw_key = re.sub(r"[^a-z0-9_]+", "_", name.lower()).strip("_")
    key = raw_key[:50] or "custom_list"

    # Ensure uniqueness
    existing = db.query(CustomLeadModule).filter(CustomLeadModule.key == key).first()
    if existing:
        # Append random number
        count = db.query(CustomLeadModule).filter(CustomLeadModule.key.like(f"{key}%")).count()
        key = f"{key}_{count + 1}"

    max_order = db.query(func.max(CustomLeadModule.order_index)).scalar() or 0

    module = CustomLeadModule(
        key=key,
        name=name,
        description=(payload.get("description") or "").strip() or None,
        icon=(payload.get("icon") or "📋").strip()[:10],
        color=(payload.get("color") or "#10b981").strip()[:20],
        is_builtin=False,
        is_enabled=True,
        order_index=max_order + 1,
    )
    db.add(module)
    db.commit()
    db.refresh(module)

    return {
        "id": module.id,
        "key": module.key,
        "name": module.name,
        "description": module.description or "",
        "icon": module.icon,
        "color": module.color,
        "is_builtin": False,
        "is_enabled": True,
        "order_index": module.order_index,
        "count": 0,
    }


def update_custom_module(db: Session, key: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Update settings or toggle visibility for a custom/built-in module."""
    module = db.query(CustomLeadModule).filter(CustomLeadModule.key == key.strip().lower()).first()
    if not module:
        raise ValueError(f"Module with key '{key}' not found")

    if "name" in payload and payload["name"]:
        module.name = str(payload["name"]).strip()
    if "description" in payload:
        module.description = str(payload["description"]).strip() or None
    if "icon" in payload and payload["icon"]:
        module.icon = str(payload["icon"]).strip()[:10]
    if "color" in payload and payload["color"]:
        module.color = str(payload["color"]).strip()[:20]
    if "is_enabled" in payload:
        module.is_enabled = bool(payload["is_enabled"])
    if "order_index" in payload:
        module.order_index = int(payload["order_index"])

    db.commit()
    db.refresh(module)

    count = db.query(Buyer).filter(func.lower(Buyer.source) == module.key.lower()).count()

    return {
        "id": module.id,
        "key": module.key,
        "name": module.name,
        "description": module.description or "",
        "icon": module.icon,
        "color": module.color,
        "is_builtin": bool(module.is_builtin),
        "is_enabled": bool(module.is_enabled),
        "order_index": module.order_index,
        "count": count,
    }


def delete_custom_module(db: Session, key: str) -> dict[str, Any]:
    """Delete a custom module and reset its leads back to old_clients."""
    key_clean = key.strip().lower()
    module = db.query(CustomLeadModule).filter(CustomLeadModule.key == key_clean).first()
    if not module:
        raise ValueError(f"Module with key '{key}' not found")
    if module.is_builtin:
        raise ValueError("Built-in system lists cannot be deleted. You can disable them to hide from sidebar.")

    # Re-route leads to old_clients
    leads_count = db.query(Buyer).filter(func.lower(Buyer.source) == key_clean).count()
    if leads_count > 0:
        db.query(Buyer).filter(func.lower(Buyer.source) == key_clean).update(
            {Buyer.source: "old_clients"}, synchronize_session=False
        )

    db.delete(module)
    db.commit()

    return {
        "deleted": True,
        "key": key_clean,
        "leads_reassigned_to_old_clients": leads_count,
    }


def seed_testing_staff(db: Session) -> list[dict[str, Any]]:
    """Seed or ensure all Kafi Commodities staff members are present in the 'testing' list."""
    # 1. Ensure testing module exists
    testing_mod = db.query(CustomLeadModule).filter(CustomLeadModule.key == "testing").first()
    if not testing_mod:
        testing_mod = CustomLeadModule(
            key="testing",
            name="Testing",
            description="Kafi Commodities staff numbers & emails for daily morning bulk testing",
            icon="🧪",
            color="#10b981",
            is_builtin=False,
            is_enabled=True,
            order_index=1,
        )
        db.add(testing_mod)
        db.commit()

    seeded = []
    for staff in DEFAULT_STAFF_RECIPIENTS:
        # Check if buyer already exists with this email or company name in testing
        email = (staff.get("email") or "").strip().lower()
        existing_contact = None
        if email:
            existing_contact = db.query(Contact).filter(func.lower(Contact.email) == email).first()

        buyer = None
        if existing_contact and existing_contact.buyer_id:
            buyer = db.get(Buyer, existing_contact.buyer_id)

        if not buyer:
            buyer = db.query(Buyer).filter(
                or_(
                    func.lower(Buyer.company_name) == staff["company_name"].lower(),
                    func.lower(Buyer.email) == email,
                )
            ).first()

        if buyer:
            # Update source to testing
            buyer.source = "testing"
            buyer.intake_method = "upload"
            buyer.primary_mobile = staff["primary_mobile"]
            buyer.company_name = staff["company_name"]
            buyer.country = staff["country"]
            buyer.city = staff["city"]
            if not buyer.remarks:
                buyer.remarks = staff["remarks"]
            db.commit()
            seeded.append({"id": buyer.id, "name": staff["contact_name"], "status": "updated"})
        else:
            # Create new lead & contact
            new_buyer = create_buyer(
                db,
                data={
                    "company_name": staff["company_name"],
                    "email": staff["email"],
                    "secondary_email": staff.get("secondary_email"),
                    "primary_mobile": staff["primary_mobile"],
                    "country": staff["country"],
                    "city": staff["city"],
                    "designation": staff["designation"],
                    "contact_person": staff["contact_name"],
                    "source": "testing",
                    "intake_method": "upload",
                    "remarks": staff["remarks"],
                    "master_type": "fmcg",
                    "company_grading": "AAAA",
                },
                commit=True,
            )
            create_contact(
                db,
                data={
                    "buyer_id": new_buyer.id,
                    "full_name": staff["contact_name"],
                    "email": staff["email"],
                    "phone": staff["primary_mobile"],
                    "designation": staff["designation"],
                    "is_primary": True,
                },
                commit=True,
            )
            seeded.append({"id": new_buyer.id, "name": staff["contact_name"], "status": "created"})

    return seeded


def add_recipient_to_module(db: Session, module_key: str, data: dict[str, Any]) -> dict[str, Any]:
    """Add a single staff / test recipient directly to any module (e.g. testing)."""
    contact_name = (data.get("contact_name") or data.get("contact_person") or "").strip()
    company_name = (data.get("company_name") or "").strip() or f"Kafi Test Recipient — {contact_name}"
    email = (data.get("email") or "").strip()
    mobile = (data.get("primary_mobile") or data.get("phone") or "").strip()
    designation = (data.get("designation") or "Staff / QA Tester").strip()

    if not contact_name and not company_name:
        raise ValueError("Contact person name or company name is required")

    buyer = create_buyer(
        db,
        data={
            "company_name": company_name,
            "email": email or None,
            "secondary_email": (data.get("secondary_email") or "").strip() or None,
            "primary_mobile": mobile or None,
            "country": (data.get("country") or "Pakistan").strip(),
            "city": (data.get("city") or "Karachi").strip(),
            "designation": designation,
            "contact_person": contact_name,
            "source": module_key.strip().lower(),
            "intake_method": "upload",
            "remarks": (data.get("remarks") or "Added to test list for daily bulk testing").strip(),
            "master_type": "fmcg",
        },
        commit=True,
    )
    if contact_name or email or mobile:
        create_contact(
            db,
            data={
                "buyer_id": buyer.id,
                "full_name": contact_name or company_name,
                "email": email or None,
                "phone": mobile or None,
                "designation": designation,
                "is_primary": True,
            },
            commit=True,
        )

    return {
        "id": buyer.id,
        "company_name": buyer.company_name,
        "contact_person": buyer.contact_person,
        "email": buyer.email,
        "primary_mobile": buyer.primary_mobile,
        "source": buyer.source,
    }
