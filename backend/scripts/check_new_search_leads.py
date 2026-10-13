"""One-off: investigate New search lead count spike."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import func, or_

from db.models import AppUser, AuditLog, Buyer, UserActivityEvent
from db.session import SessionLocal
from modules.leads import count_leads_table_sections, TARGETED_POOL_SOURCES, INCOMPLETE_ARCHIVES_SOURCE


def main() -> None:
    db = SessionLocal()
    try:
        counts = count_leads_table_sections(db)
        print("=== Section counts (admin) ===")
        print(f"New search lead (all): {counts.get('all')}")
        print(f"Master: {counts.get('master')}")
        print(f"Old clients: {counts.get('old_clients')}")

        since = datetime.now(timezone.utc) - timedelta(days=3)
        total_new = db.query(func.count(Buyer.id)).filter(Buyer.created_at >= since).scalar()
        print(f"\n=== Buyers created since {since.date()} UTC: {total_new} ===")

        by_day = (
            db.query(func.date(Buyer.created_at), func.count(Buyer.id))
            .filter(Buyer.created_at >= since)
            .group_by(func.date(Buyer.created_at))
            .order_by(func.date(Buyer.created_at))
            .all()
        )
        for day, n in by_day:
            print(f"  {day}: {n}")

        by_source = (
            db.query(Buyer.source, func.count(Buyer.id))
            .filter(Buyer.created_at >= since)
            .group_by(Buyer.source)
            .order_by(func.count(Buyer.id).desc())
            .limit(15)
            .all()
        )
        print("\n=== By source (last 3 days) ===")
        for src, n in by_source:
            print(f"  {src or '(null)'}: {n}")

        by_intake = (
            db.query(Buyer.intake_method, func.count(Buyer.id))
            .filter(Buyer.created_at >= since)
            .group_by(Buyer.intake_method)
            .order_by(func.count(Buyer.id).desc())
            .all()
        )
        print("\n=== By intake_method (last 3 days) ===")
        for method, n in by_intake:
            print(f"  {method or '(null)'}: {n}")

        pool_sources = list(TARGETED_POOL_SOURCES) + [INCOMPLETE_ARCHIVES_SOURCE, "old_clients"]
        unassigned_pool = (
            db.query(func.count(Buyer.id))
            .filter(
                Buyer.assigned_to_user_id.is_(None),
                or_(Buyer.source.is_(None), ~Buyer.source.in_(pool_sources)),
            )
            .scalar()
        )
        print(f"\nUnassigned non-pool buyers (rough): {unassigned_pool}")

        imports = (
            db.query(UserActivityEvent, AppUser.username, AppUser.full_name)
            .join(AppUser, AppUser.id == UserActivityEvent.user_id)
            .filter(
                UserActivityEvent.activity_type == "leads_imported",
                UserActivityEvent.created_at >= since,
            )
            .order_by(UserActivityEvent.created_at.desc())
            .all()
        )
        print(f"\n=== Lead import activity events (last 3 days): {len(imports)} ===")
        for ev, username, full_name in imports[:30]:
            det = ev.details or {}
            print(
                f"  {ev.created_at} | {full_name or username} ({username}) "
                f"| qty={ev.quantity} | {ev.summary} | details={det}"
            )

        audits = (
            db.query(AuditLog)
            .filter(AuditLog.created_at >= since, AuditLog.action.ilike("%import%"))
            .order_by(AuditLog.created_at.desc())
            .limit(25)
            .all()
        )
        print(f"\n=== Audit import-related (last 3 days): {len(audits)} ===")
        for row in audits[:20]:
            print(
                f"  {row.created_at} | actor={row.actor} | {row.action} "
                f"| entity={row.entity_type}:{row.entity_id} | {row.details}"
            )

        # Unassignments that could inflate pool
        unassign_audits = (
            db.query(AuditLog)
            .filter(
                AuditLog.created_at >= since,
                AuditLog.action.ilike("%unassign%"),
            )
            .order_by(AuditLog.created_at.desc())
            .limit(15)
            .all()
        )
        if unassign_audits:
            print(f"\n=== Recent unassign actions: {len(unassign_audits)} ===")
            for row in unassign_audits:
                print(f"  {row.created_at} | actor={row.actor} | {row.action} | {row.details}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
