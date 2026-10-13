"""Call follow-up situations for AI Sales Agents (Sara / Rayan).

A *situation group* ("Happy with current supplier", "Call couldn't be made", ...) holds one or
more email *drafts*. After a call the agent will pick the best situation + draft and send it
(later phase). This module is storage + CRUD only.

Tables are created on first use with CREATE TABLE IF NOT EXISTS, so it never touches the Alembic
chain or app boot, and every function opens its own short-lived connection.

"""

from __future__ import annotations

import json
import threading
from typing import Any

from sqlalchemy import text

from db.session import engine

PLACEHOLDERS = [
    "contact_name",
    "company_name",
    "agent_name",
    "product",
    "country",
    "referrer_name",
]
ATTACHMENT_MODES = ("none", "auto", "catalogue")
MODES = ("off", "test_only", "all")
DEFAULT_MODE = "test_only"

_LOCK = threading.Lock()
_READY = False

_DDL = [
    """CREATE TABLE IF NOT EXISTS call_followup_groups (
        id SERIAL PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )""",
    """CREATE TABLE IF NOT EXISTS call_followup_drafts (
        id SERIAL PRIMARY KEY,
        group_id INTEGER NOT NULL REFERENCES call_followup_groups(id) ON DELETE CASCADE,
        name VARCHAR(160) NOT NULL,
        subject VARCHAR(500) NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '',
        whatsapp_text TEXT NOT NULL DEFAULT '',
        attachment_mode VARCHAR(20) NOT NULL DEFAULT 'none',
        catalogue_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )""",
    "CREATE INDEX IF NOT EXISTS ix_call_followup_drafts_group ON call_followup_drafts (group_id)",
    """CREATE TABLE IF NOT EXISTS call_followup_meta (
        key VARCHAR(60) PRIMARY KEY,
        value VARCHAR(255) NOT NULL DEFAULT ''
    )""",
]

_GROUP_COLS = "id, name, description, enabled, sort_order, created_at, updated_at"
_DRAFT_COLS = (
    "id, group_id, name, subject, body, whatsapp_text, attachment_mode, "
    "catalogue_ids, enabled, sort_order, created_at, updated_at"
)
_GROUP_FIELDS = {"name", "description", "enabled"}
_DRAFT_FIELDS = {
    "name",
    "subject",
    "body",
    "whatsapp_text",
    "attachment_mode",
    "catalogue_ids",
    "enabled",
}


def ensure_tables() -> None:
    global _READY
    if _READY:
        return
    with _LOCK:
        if _READY:
            return
        with engine.begin() as conn:
            for ddl in _DDL:
                conn.exec_driver_sql(ddl)
        _READY = True


# --------------------------------------------------------------------------- seed data

_PRODUCT_LINE = "rice, spices, sauces, pickles, and salt"

_SEED_GROUPS: list[dict[str, Any]] = [
    {
        "name": "Interested in a different product",
        "description": (
            "We called about one product (for example salt) but during the call the customer said "
            "they also buy or import a different product (for example rice). Send only that "
            "product's catalogue, not the whole range."
        ),
        "enabled": True,
        "drafts": [
            {
                "name": "Rice overview",
                "subject": "Rice range - Kafi Commodities",
                "attachment_mode": "auto",
                "body": """Dear [contact_name],

As you mentioned on the call that you also import rice, I would like to share a brief overview of what we can offer.
We deal in a variety of rice, including both Basmati and non-Basmati types, and focus on maintaining good quality along with reasonable pricing. We always try to keep things simple and reliable for our buyers, especially when it comes to consistency and timely shipments.

You can check our available rice stocks below:

1. 1121 Basmati
1121 Sella (Parboiled) Basmati
1121 Steam Basmati
1121 Raw (White) Basmati

2. Super Basmati
Super Basmati Sella
Super Basmati Steam
Super Basmati Raw

3. 1509 Basmati
1509 Sella
1509 Steam
1509 Raw

4. Non-Basmati Rice Varieties
IRRI Series (Short/Medium Grain)
IRRI-6
IRRI-9

5. PK Series (Pakistan)
PK-386

6. Long Grain White Rice
Long Grain White (5%, 10%, 15% broken)

7. Parboiled (Sella) Non-Basmati
IRRI-6 Sella
IRRI-9 Sella
If you are currently sourcing any particular type of rice, feel free to share your requirements. I would be happy to send you details, pricing, or samples as needed.

We look forward to your prompt response and to taking the next step together.

Best regards,""",
            }
        ],
    },
    {
        "name": "Happy with current supplier",
        "description": (
            "The customer already has a supplier for our product and says they are satisfied. "
            "We are not asking them to switch - we offer to stay in touch as a backup option."
        ),
        "enabled": True,
        "drafts": [
            {
                "name": "Backup supplier",
                "subject": "Staying in touch as a backup supplier - Kafi Commodities",
                "attachment_mode": "auto",
                "body": """Dear [contact_name],

Thank you for your time on the call.

As discussed, you said that you are satisfied with your current [product] supplier and that is good to hear.

We are not asking you to replace your current supplier. We would simply like to stay in touch as a backup option in case you ever need better pricing, extra supply, or urgent support in the future.

Many buyers prefer to keep one extra supplier as a safe option in case of delays, stock issues, or sudden price changes.

Kindly find the attached file to review our [product] range,

We look forward to your prompt response and to taking the next step together.

Best regards,""",
            }
        ],
    },
    {
        "name": "Needs reassurance or support",
        "description": (
            "The customer is worried about a disruption (for example a port closure or a regional "
            "conflict) and needs reassurance that we can still supply, and/or asked for our price list."
        ),
        "enabled": True,
        "drafts": [
            {
                "name": "Supply assurance during disruption",
                "subject": "Our supply continues without interruption - Kafi Commodities",
                "attachment_mode": "none",
                "body": """Dear [contact_name],

Thank you for your Call and for your interest in our products.

We understand the current situation, and please be assured that we can still supply during this time without any hurdles. Our operations and export arrangements are running smoothly, and we remain fully ready to support your requirements.

As requested, we will share our complete price list for all products with you for your review.

We look forward to your feedback and to building a strong business relationship with you.

Best Regards,""",
            }
        ],
    },
    {
        "name": "Interested - positive call",
        "description": (
            "A positive call: the customer showed interest and is happy to continue. Send the company "
            "introduction and product range, and offer a Zoom / Google Meet."
        ),
        "enabled": True,
        "drafts": [
            {
                "name": "Introduction and product range",
                "subject": "Kafi Commodities - product range and introduction",
                "attachment_mode": "auto",
                "body": """Dear [contact_name],

It was nice speaking with you on the call.

As discussed, please find our product range below and briefing short introduction for your review.

This is [agent_name] and I am confident that you are familiar with our company Kafi Commodities (Pvt) Limited, which is a Pakistani food manufacturing and export company. We have been exporting a wide range of products globally since 1982, including to the USA, Canada, the Middle East, Europe, Asia, and Africa.

We export a wide range of products to markets worldwide, including Himalayan Pink Salt (edible and non-edible), Himalayan Black Salt, Sea Salt, and other FMCG products such as Rice, Paste, Pickle, Fried Onion, Spices, Sauces, Desserts, Pheni, and Vermicelli. We offer competitive prices, maintain high quality standards, and ensure hygienic processing in all our products.

Once we start working together, you will quickly see our commitment to quality, fair pricing, and dependable on time delivery, building a partnership you can rely on for the long run.

If you prefer to talk via Zoom or Google Meet, please share the meeting link so we can discuss in detail.

We look forward to your prompt response and to taking the next step together.

Best regards,""",
            }
        ],
    },
    {
        "name": "Poor line - asked to email",
        "description": (
            "A network or communication problem meant the call could not be held properly, or the "
            "customer asked us to continue by email. Ask for their requirements."
        ),
        "enabled": True,
        "drafts": [
            {
                "name": "Line issue - requirements request",
                "subject": "Following our call - Kafi Commodities",
                "attachment_mode": "none",
                "body": """Dear [contact_name],

I trust you are keeping well and safe.

I spoke to you on the phone a little while ago, but due to a line issue, we couldn't communicate properly. You asked me to contact you by email.

My name is [agent_name] from Kafi Commodities (Pvt) Limited, a Pakistan-based food manufacturing and export company.

We supply a range of food products to international markets, including Himalayan Pink Salt, Rice, Spices, Pickles, Sauces, Fried Onion, and other FMCG products.

If you are currently sourcing any of these products, please share the following details so we can prepare a quotation according to your requirements:

* Products of interest
* Preferred packaging
* Approximate order quantity
* Port of destination

If required, we can also arrange a Zoom or Google Meet to discuss your requirements in more detail.

I would be pleased to hear from you and discuss the possibility of working together.

Best regards,""",
            }
        ],
    },
    {
        "name": "Asked for catalogue or profile",
        "description": (
            "The customer was curious about our products and asked us to send the catalogue or the "
            "company profile to their email."
        ),
        "enabled": True,
        "drafts": [
            {
                "name": "Company profile",
                "subject": "Kafi Commodities - company profile",
                "attachment_mode": "auto",
                "body": """Dear [contact_name],

I trust you are keeping well and safe.

I spoke with you over the call, and you shared your email with me to send our profile.

This is [agent_name] and I am confident that you are familiar with our company Kafi Commodities (Pvt) Limited, which is a Pakistani food manufacturing and export company. We have been exporting a wide range of products globally since 1982, including to the USA, Canada, the Middle East, Europe, Asia, and Africa.

We export a wide range of salt products to markets across the globe, including Himalayan Pink Salt (both edible and non-edible), Himalayan Black Salt, and Sea Salt. We offer competitive market prices, maintain high quality standards, and ensure hygienic processing throughout.

Once we start working together, you will quickly see our commitment to quality, fair pricing, and dependable on time delivery, building a partnership you can rely on for the long run.

We look forward to your prompt response and to taking the next step together.

Best regards,""",
            }
        ],
    },
    {
        "name": "Call couldn't be made",
        "description": (
            "The call did not connect: not picked up, number not responding, wrong or unreachable "
            "number. All of these are one situation - the call could not be made."
        ),
        "enabled": True,
        "drafts": [
            {
                "name": "Tried to reach you",
                "subject": "Kafi Commodities - we tried to reach you",
                "attachment_mode": "none",
                "body": """Dear [company_name] Team,

I trust you are keeping well and safe,

I am reaching out from Kafi Commodities regarding our Pakistani food export services. I attempted to reach you by phone today to introduce our supply capabilities, but I was unable to connect.

We specialize in the export of premium """
                + _PRODUCT_LINE
                + """. We are interested in learning more about your import requirements and how we may support your operations in [country].

Please let us know if you have a preferred time for a brief introductory call or if you would like to continue this conversation via email.

Best regards,
Kafi Commodities Export Team""",
            },
            {
                "name": "Number not responding - active number please",
                "subject": "Kafi Commodities - could you share an active number?",
                "attachment_mode": "none",
                "body": """Dear [company_name] Team,

We tried to reach out to you, but it seems that the number is not responding. Could you please provide an active number where we can reach you?

In the meantime, we specialize in the export of premium """
                + _PRODUCT_LINE
                + """, and we would be glad to share our product details with you.

Best regards,
Kafi Commodities Export Team""",
            },
            {
                "name": "Call could not be made",
                "subject": "Kafi Commodities - our call could not be made",
                "attachment_mode": "none",
                "body": """Dear [company_name] Team,

We tried to reach out to you, but the call could not be made.

Please let us know a convenient number or time, or reply here if you would like to continue this conversation via email.

Best regards,
Kafi Commodities Export Team""",
            },
        ],
    },
    {
        "name": "Referred to the right person",
        "description": (
            "Someone at the company suggested we contact a different person for this category. The "
            "email goes to that new person, not to the caller. (Automatic sending for this one comes "
            "last - it needs the new person's name and email from the call.)"
        ),
        "enabled": False,
        "drafts": [
            {
                "name": "Referral introduction",
                "subject": "Introduction - Kafi Commodities",
                "attachment_mode": "auto",
                "body": """Dear [contact_name],

I trust you are keeping well and safe.

I am reaching out from Kafi Commodities Private Limited. I recently spoke with [referrer_name], who kindly suggested that I contact you regarding our product range, as you are the relevant person for this category.

We are exporters of premium Pakistani food products, including Himalayan salt, rice, spices, sauces, and other FMCG products. We would be pleased to explore the possibility of supplying [company_name] with products that match your current sourcing requirements.

Kindly find the attached file for your review where you can see our complete product range.

I would be happy to share our product catalogue, specifications, and competitive export pricing for your review.

If convenient for you, we would also be happy to arrange a brief Zoom or Google Meet at a time that suits your schedule, so we can discuss your requirements in more detail and explore potential cooperation.

Please let me know if this category is currently of interest to you, and I will be glad to provide the relevant details.

Best regards,""",
            }
        ],
    },
    {
        "name": "Do not disturb",
        "description": (
            "The customer says they are not available / do not want to be disturbed by phone calls. "
            "This is different from 'not interested'. We ask for their availability so a scheduled "
            "meeting can be arranged, by email and WhatsApp."
        ),
        "enabled": True,
        "drafts": [
            {
                "name": "Ask for availability",
                "subject": "Kafi Commodities - when would suit you for a short meeting?",
                "attachment_mode": "none",
                "body": """Dear [contact_name],

Thank you for your time.

We understand that you are not available on the phone for a call at the moment. However, we would like to know your schedule of availability so that we can arrange a scheduled meeting at a time that suits you.

Please let us know a convenient day and time, and the platform you prefer (Zoom, Google Meet or any other), and we will arrange it accordingly.

We look forward to hearing from you.

Best regards,""",
                "whatsapp_text": (
                    "Dear [contact_name], this is [agent_name] from Kafi Commodities. We understand "
                    "you are not available on the phone for a call. Could you please share your "
                    "availability so we can schedule a meeting at a time that suits you? Zoom, "
                    "Google Meet or any medium you prefer works for us. Thank you."
                ),
            }
        ],
    },
    {
        "name": "Not interested",
        "description": (
            "The customer politely says they are not interested. This is different from 'do not "
            "disturb'. We ask the reason (for example they already have a supplier) and mention our "
            "wider FMCG range, by email and WhatsApp."
        ),
        "enabled": True,
        "drafts": [
            {
                "name": "Ask the reason",
                "subject": "Kafi Commodities - may we ask what would suit you better?",
                "attachment_mode": "none",
                "body": """Dear [contact_name],

Thank you for letting us know.

We understand that you are not interested at the moment, and we respect that. If you don't mind sharing, we would like to understand the reason, for example whether you already have a supplier you are happy with.

In case it is of interest, we also offer a wide variety of FMCG products, including rice, spices, sauces, pickles, and more, which you might find useful.

If any of these fit your needs now or in the future, please let us know and we will be glad to share the details.

Best regards,""",
                "whatsapp_text": (
                    "Dear [contact_name], this is [agent_name] from Kafi Commodities. Thank you for "
                    "letting us know. If you don't mind sharing, may we ask the reason - for example, "
                    "do you already have a supplier? We also offer a variety of FMCG products (rice, "
                    "spices, sauces, pickles and more) that you might be interested in. Thank you."
                ),
            }
        ],
    },
]


def _insert_group(conn: Any, name: str, description: str, enabled: bool, order: int) -> int:
    return int(
        conn.execute(
            text(
                "INSERT INTO call_followup_groups (name, description, enabled, sort_order) "
                "VALUES (:n, :d, :e, :s) RETURNING id"
            ),
            {"n": name, "d": description, "e": enabled, "s": order},
        ).scalar()
    )


def _insert_draft(conn: Any, group_id: int, d: dict[str, Any], order: int) -> int:
    return int(
        conn.execute(
            text(
                "INSERT INTO call_followup_drafts "
                "(group_id, name, subject, body, whatsapp_text, attachment_mode, catalogue_ids, "
                "enabled, sort_order) "
                "VALUES (:g, :n, :s, :b, :w, :am, CAST(:c AS jsonb), :e, :o) RETURNING id"
            ),
            {
                "g": group_id,
                "n": d.get("name") or "Draft",
                "s": d.get("subject") or "",
                "b": d.get("body") or "",
                "w": d.get("whatsapp_text") or "",
                "am": d.get("attachment_mode") if d.get("attachment_mode") in ATTACHMENT_MODES else "none",
                "c": json.dumps(list(d.get("catalogue_ids") or [])),
                "e": bool(d.get("enabled", True)),
                "o": order,
            },
        ).scalar()
    )


def _apply_seed_v2(conn: Any) -> None:
    """Add the Do not disturb / Not interested drafts to databases seeded before they existed.

    Runs once (meta flag). Only fills a group that still has no drafts and the original
    placeholder description, so nothing the user edited is overwritten.
    """
    done = conn.execute(text("SELECT value FROM call_followup_meta WHERE key = 'seed_v2'")).scalar()
    if done:
        return
    for g in _SEED_GROUPS:
        if g["name"] not in ("Do not disturb", "Not interested"):
            continue
        row = conn.execute(
            text(
                "SELECT id, description FROM call_followup_groups "
                "WHERE name = :n ORDER BY id LIMIT 1"
            ),
            {"n": g["name"]},
        ).first()
        if row is None:
            continue
        gid = int(row[0])
        if "Drafts to be added" in (row[1] or ""):
            conn.execute(
                text(
                    "UPDATE call_followup_groups SET description = :d, updated_at = NOW() "
                    "WHERE id = :id"
                ),
                {"d": g["description"], "id": gid},
            )
        has = conn.execute(
            text("SELECT COUNT(*) FROM call_followup_drafts WHERE group_id = :g"), {"g": gid}
        ).scalar() or 0
        if int(has) == 0:
            for di, d in enumerate(g.get("drafts") or [], start=1):
                _insert_draft(conn, gid, d, di)
    conn.execute(
        text(
            "INSERT INTO call_followup_meta (key, value) VALUES ('seed_v2', '1') "
            "ON CONFLICT (key) DO NOTHING"
        )
    )


def seed_defaults_if_needed() -> None:
    """Load the starter situations once. A meta flag stops re-seeding after the user deletes them."""
    ensure_tables()
    with _LOCK:
        with engine.begin() as conn:
            done = conn.execute(
                text("SELECT value FROM call_followup_meta WHERE key = 'seeded'")
            ).scalar()
            if not done:
                existing = (
                    conn.execute(text("SELECT COUNT(*) FROM call_followup_groups")).scalar() or 0
                )
                if int(existing) == 0:
                    for gi, g in enumerate(_SEED_GROUPS, start=1):
                        gid = _insert_group(
                            conn, g["name"], g["description"], bool(g.get("enabled", True)), gi
                        )
                        for di, d in enumerate(g.get("drafts") or [], start=1):
                            _insert_draft(conn, gid, d, di)
                conn.execute(
                    text(
                        "INSERT INTO call_followup_meta (key, value) VALUES ('seeded', '1') "
                        "ON CONFLICT (key) DO NOTHING"
                    )
                )
            _apply_seed_v2(conn)


# --------------------------------------------------------------------------- reads


def _draft_out(row: Any) -> dict[str, Any]:
    d = dict(row._mapping)
    cats = d.get("catalogue_ids")
    if isinstance(cats, str):
        try:
            cats = json.loads(cats)
        except ValueError:
            cats = []
    d["catalogue_ids"] = cats if isinstance(cats, list) else []
    return d


def list_all() -> list[dict[str, Any]]:
    seed_defaults_if_needed()
    with engine.connect() as conn:
        groups = [
            dict(r._mapping)
            for r in conn.execute(
                text(f"SELECT {_GROUP_COLS} FROM call_followup_groups ORDER BY sort_order, id")
            )
        ]
        drafts = [
            _draft_out(r)
            for r in conn.execute(
                text(f"SELECT {_DRAFT_COLS} FROM call_followup_drafts ORDER BY sort_order, id")
            )
        ]
    by_group: dict[int, list[dict[str, Any]]] = {}
    for d in drafts:
        by_group.setdefault(int(d["group_id"]), []).append(d)
    for g in groups:
        g["drafts"] = by_group.get(int(g["id"]), [])
    return groups


def get_group(group_id: int) -> dict[str, Any] | None:
    ensure_tables()
    with engine.connect() as conn:
        row = conn.execute(
            text(f"SELECT {_GROUP_COLS} FROM call_followup_groups WHERE id = :id"),
            {"id": group_id},
        ).first()
        if row is None:
            return None
        group = dict(row._mapping)
        group["drafts"] = [
            _draft_out(r)
            for r in conn.execute(
                text(
                    f"SELECT {_DRAFT_COLS} FROM call_followup_drafts "
                    "WHERE group_id = :id ORDER BY sort_order, id"
                ),
                {"id": group_id},
            )
        ]
    return group


def get_draft(draft_id: int) -> dict[str, Any] | None:
    ensure_tables()
    with engine.connect() as conn:
        row = conn.execute(
            text(f"SELECT {_DRAFT_COLS} FROM call_followup_drafts WHERE id = :id"),
            {"id": draft_id},
        ).first()
    return _draft_out(row) if row is not None else None


# --------------------------------------------------------------------------- writes


def create_group(name: str, description: str = "", enabled: bool = True) -> dict[str, Any]:
    ensure_tables()
    with engine.begin() as conn:
        order = conn.execute(
            text("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM call_followup_groups")
        ).scalar()
        gid = _insert_group(conn, name.strip(), description or "", enabled, int(order or 1))
    group = get_group(gid)
    return group if group is not None else {"id": gid}


def _update_row(table: str, row_id: int, allowed: set[str], fields: dict[str, Any]) -> None:
    sets: list[str] = []
    params: dict[str, Any] = {"id": row_id}
    for key, value in fields.items():
        if key not in allowed:
            continue
        if key == "catalogue_ids":
            sets.append("catalogue_ids = CAST(:catalogue_ids AS jsonb)")
            params[key] = json.dumps(list(value or []))
        else:
            sets.append(f"{key} = :{key}")
            params[key] = value
    if not sets:
        return
    sets.append("updated_at = NOW()")
    with engine.begin() as conn:
        conn.execute(text(f"UPDATE {table} SET {', '.join(sets)} WHERE id = :id"), params)


def update_group(group_id: int, fields: dict[str, Any]) -> dict[str, Any] | None:
    ensure_tables()
    if get_group(group_id) is None:
        return None
    _update_row("call_followup_groups", group_id, _GROUP_FIELDS, fields)
    return get_group(group_id)


def delete_group(group_id: int) -> bool:
    ensure_tables()
    with engine.begin() as conn:
        res = conn.execute(text("DELETE FROM call_followup_groups WHERE id = :id"), {"id": group_id})
    return bool(res.rowcount)


def create_draft(group_id: int, fields: dict[str, Any]) -> dict[str, Any] | None:
    ensure_tables()
    if get_group(group_id) is None:
        return None
    with engine.begin() as conn:
        order = conn.execute(
            text(
                "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM call_followup_drafts "
                "WHERE group_id = :g"
            ),
            {"g": group_id},
        ).scalar()
        draft_id = _insert_draft(conn, group_id, fields, int(order or 1))
    return get_draft(draft_id)


def update_draft(draft_id: int, fields: dict[str, Any]) -> dict[str, Any] | None:
    ensure_tables()
    if get_draft(draft_id) is None:
        return None
    _update_row("call_followup_drafts", draft_id, _DRAFT_FIELDS, fields)
    return get_draft(draft_id)


def delete_draft(draft_id: int) -> bool:
    ensure_tables()
    with engine.begin() as conn:
        res = conn.execute(text("DELETE FROM call_followup_drafts WHERE id = :id"), {"id": draft_id})
    return bool(res.rowcount)



# --------------------------------------------------------------------------- sending mode


def get_mode() -> str:
    """off = old generic follow-up for everyone; test_only = situations for test calls only;
    all = situations for every call. Defaults to test_only."""
    ensure_tables()
    with engine.connect() as conn:
        value = conn.execute(text("SELECT value FROM call_followup_meta WHERE key = 'mode'")).scalar()
    return value if value in MODES else DEFAULT_MODE


def set_mode(mode: str) -> str:
    if mode not in MODES:
        raise ValueError(f"mode must be one of {', '.join(MODES)}")
    ensure_tables()
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO call_followup_meta (key, value) VALUES ('mode', :m) "
                "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"
            ),
            {"m": mode},
        )
    return mode
