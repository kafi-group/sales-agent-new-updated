"""Quick stats for email open tracking."""
from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import create_engine, func, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import NullPool

from db.models import EmailActivityEvent, Interaction
from modules.email_tracking import make_open_token, public_api_base, record_open


def main() -> None:
    url = os.environ.get("DATABASE_URL", "").replace(":5432/", ":6543/")
    if not url:
        raise SystemExit("DATABASE_URL required")
    db = sessionmaker(bind=create_engine(url, poolclass=NullPool))()
    db.execute(text("SET statement_timeout = '60s'"))

    opened = db.query(func.count(EmailActivityEvent.id)).filter(
        EmailActivityEvent.event_type == "opened"
    ).scalar()
    sent = db.query(func.count(EmailActivityEvent.id)).filter(
        EmailActivityEvent.event_type == "sent"
    ).scalar()
    print("public_api_base:", public_api_base())
    print("opened_events:", opened)
    print("sent_events:", sent)

    # Latest sent with interaction_id
    latest = (
        db.query(EmailActivityEvent)
        .filter(EmailActivityEvent.event_type == "sent", EmailActivityEvent.interaction_id.isnot(None))
        .order_by(EmailActivityEvent.id.desc())
        .limit(5)
        .all()
    )
    for e in latest:
        print(f"  sent id={e.id} interaction={e.interaction_id} user={e.user_id} at={e.created_at}")

    if latest:
        iid = latest[0].interaction_id
        token = make_open_token(interaction_id=iid, send_mode="individual")
        print(f"test_pixel_url: {public_api_base()}/api/track/email-open/{token}.gif")

    from datetime import datetime, timedelta, timezone
    from modules.email_activity import insights_stats

    since = datetime.now(timezone.utc) - timedelta(days=30)
    opens_30d = (
        db.query(func.count(EmailActivityEvent.id))
        .filter(
            EmailActivityEvent.event_type == "opened",
            EmailActivityEvent.created_at >= since,
        )
        .scalar()
    )
    print("opened_last_30d:", opens_30d)

    for e in (
        db.query(EmailActivityEvent)
        .filter(EmailActivityEvent.event_type == "opened")
        .order_by(EmailActivityEvent.id.desc())
        .limit(5)
    ):
        print(f"  open id={e.id} details={e.details} user={e.user_id}")

    stats = insights_stats(db, days=30, user_id=None, is_admin=True)
    print("insights totals:", stats.get("totals"))

    from modules.email_activity import _scoped_query
    from datetime import timedelta

    since2 = datetime.now(timezone.utc) - timedelta(days=30)
    q = _scoped_query(db, user_id=None, is_admin=True, channel="email")
    q = q.filter(EmailActivityEvent.created_at >= since2)
    rows = list(q.all())
    from collections import Counter
    c = Counter(e.event_type for e in rows)
    print("scoped row counts:", dict(c))
    open_in_rows = [e for e in rows if e.event_type == "opened"]
    print("opened in scoped rows:", len(open_in_rows))

    # Why are opens missing from email-scoped query?
    raw_opens = (
        db.query(EmailActivityEvent)
        .filter(EmailActivityEvent.event_type == "opened", EmailActivityEvent.created_at >= since2)
        .all()
    )
    from modules.email_activity import _is_whatsapp_event_clause
    for e in raw_opens[:5]:
        is_wa = db.query(EmailActivityEvent.id).filter(
            EmailActivityEvent.id == e.id, _is_whatsapp_event_clause()
        ).first()
        print(f"  raw open id={e.id} title={e.title!r} wa_match={bool(is_wa)} created={e.created_at}")

    email_opens = (
        db.query(func.count(EmailActivityEvent.id))
        .filter(
            EmailActivityEvent.event_type == "opened",
            EmailActivityEvent.created_at >= since2,
            ~_is_whatsapp_event_clause(),
        )
        .scalar()
    )
    print("email-filtered opens in 30d:", email_opens)
    channels = {}
    for e in raw_opens:
        d = e.details or {}
        ch = d.get("channel") if isinstance(d, dict) else None
        channels[ch] = channels.get(ch, 0) + 1
    print("open details.channel counts:", channels)


if __name__ == "__main__":
    main()
