"""Admin undo of the last spreadsheet import into a list/source.

Records each successful import as a LeadImportBatch. Rollback deletes only the
buyer IDs created in that batch (empty → import → undo → empty again).

Window: ROLLBACK_WINDOW (default 1 hour). Only the latest non-rolled-back batch
for that source can be undone.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func as sa_func
from sqlalchemy.orm import Session

ROLLBACK_WINDOW = timedelta(hours=1)
# Time-gap heuristic when no batch row exists (imports done before this feature).
_HEURISTIC_GAP = timedelta(minutes=5)
_HEURISTIC_LOOKBACK = timedelta(hours=6)


def record_import_batch(
    db: Session,
    *,
    source: str | None,
    buyer_ids: list[int],
    created_by_user_id: int | None = None,
    import_job_id: str | None = None,
    commit: bool = True,
) -> dict[str, Any] | None:
    """Persist a batch so admin can Undo last import within the window."""
    src = (source or "").strip().lower()
    ids = sorted({int(x) for x in buyer_ids if int(x) > 0})
    if not src or not ids:
        return None

    from db.models import LeadImportBatch

    batch = LeadImportBatch(
        source=src,
        buyer_ids=ids,
        created_count=len(ids),
        created_by_user_id=created_by_user_id,
        import_job_id=(import_job_id or None),
    )
    db.add(batch)
    if commit:
        db.commit()
        db.refresh(batch)
    else:
        db.flush()
    return {
        "id": batch.id,
        "source": batch.source,
        "created_count": batch.created_count,
        "created_at": batch.created_at.isoformat() if batch.created_at else None,
    }


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _batch_to_status(batch: Any, *, remaining_seconds: float) -> dict[str, Any]:
    return {
        "available": remaining_seconds > 0 and not batch.rolled_back_at,
        "source": batch.source,
        "batch_id": batch.id,
        "created_count": int(batch.created_count or len(batch.buyer_ids or [])),
        "buyer_ids_count": len(batch.buyer_ids or []),
        "created_at": batch.created_at.isoformat() if batch.created_at else None,
        "created_by_user_id": batch.created_by_user_id,
        "expires_at": (
            (batch.created_at + ROLLBACK_WINDOW).isoformat() if batch.created_at else None
        ),
        "remaining_seconds": max(0, int(remaining_seconds)),
        "rolled_back_at": batch.rolled_back_at.isoformat() if batch.rolled_back_at else None,
        "heuristic": False,
    }


def _heuristic_last_import_buyer_ids(
    db: Session,
    source: str,
    *,
    enforce_window: bool = True,
) -> dict[str, Any] | None:
    """Infer last import when no LeadImportBatch row exists (pre-feature imports).

    Walk newest buyers for this source; stop at a created_at gap > 5 minutes.
    That contiguous newest cluster is treated as the last import.
    """
    from db.models import Buyer

    cutoff = _now() - _HEURISTIC_LOOKBACK
    rows = (
        db.query(Buyer.id, Buyer.created_at)
        .filter(
            sa_func.lower(Buyer.source) == source,
            Buyer.created_at.isnot(None),
            Buyer.created_at >= cutoff,
        )
        .order_by(Buyer.created_at.desc(), Buyer.id.desc())
        .all()
    )
    if not rows:
        return None

    cluster_ids: list[int] = [int(rows[0][0])]
    cluster_start = rows[0][1]
    prev_at = rows[0][1]
    for buyer_id, created_at in rows[1:]:
        if prev_at is None or created_at is None:
            break
        gap = prev_at - created_at
        if gap > _HEURISTIC_GAP:
            break
        cluster_ids.append(int(buyer_id))
        cluster_start = created_at
        prev_at = created_at

    if not cluster_ids:
        return None

    newest = rows[0][1]
    if newest is None:
        return None
    if newest.tzinfo is None:
        newest = newest.replace(tzinfo=timezone.utc)
    age = _now() - newest
    remaining = (ROLLBACK_WINDOW - age).total_seconds()
    if enforce_window and age > ROLLBACK_WINDOW:
        return None

    return {
        "available": True,
        "source": source,
        "batch_id": None,
        "created_count": len(cluster_ids),
        "buyer_ids_count": len(cluster_ids),
        "buyer_ids": cluster_ids,
        "created_at": cluster_start.isoformat() if cluster_start else newest.isoformat(),
        "created_by_user_id": None,
        "expires_at": (newest + ROLLBACK_WINDOW).isoformat(),
        "remaining_seconds": max(0, int(remaining)),
        "rolled_back_at": None,
        "heuristic": True,
    }


def get_rollback_status(
    db: Session,
    source: str,
    *,
    allow_expired: bool = False,
) -> dict[str, Any]:
    src = (source or "").strip().lower()
    if not src:
        return {"available": False, "source": "", "reason": "source required"}

    from db.models import LeadImportBatch

    batch = (
        db.query(LeadImportBatch)
        .filter(
            LeadImportBatch.source == src,
            LeadImportBatch.rolled_back_at.is_(None),
        )
        .order_by(LeadImportBatch.created_at.desc(), LeadImportBatch.id.desc())
        .first()
    )
    if batch and batch.created_at:
        created = batch.created_at
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        age = _now() - created
        remaining = (ROLLBACK_WINDOW - age).total_seconds()
        if (remaining > 0 or allow_expired) and batch.buyer_ids:
            return _batch_to_status(batch, remaining_seconds=max(0, remaining))
        if remaining <= 0:
            return {
                "available": False,
                "source": src,
                "batch_id": batch.id,
                "created_count": batch.created_count,
                "reason": "Rollback window expired (1 hour after import).",
                "expires_at": (created + ROLLBACK_WINDOW).isoformat(),
                "remaining_seconds": 0,
            }

    heuristic = _heuristic_last_import_buyer_ids(
        db, src, enforce_window=not allow_expired
    )
    if heuristic:
        return heuristic

    return {
        "available": False,
        "source": src,
        "reason": "No recent import to undo for this list.",
        "remaining_seconds": 0,
    }


def rollback_last_import(
    db: Session,
    *,
    source: str,
    actor_user_id: int | None = None,
    allow_expired: bool = False,
) -> dict[str, Any]:
    """Delete buyers from the last import batch for this source (admin only at API)."""
    from modules.audit import log_action
    from modules import buyers as buyers_module
    from modules.leads import invalidate_lead_table_filters_cache, invalidate_section_counts_cache
    from db.models import LeadImportBatch

    status = get_rollback_status(db, source, allow_expired=allow_expired)
    if not status.get("available"):
        raise ValueError(status.get("reason") or "Nothing to undo for this list.")

    src = status["source"]
    batch_id = status.get("batch_id")
    buyer_ids: list[int] = []

    if batch_id:
        batch = db.get(LeadImportBatch, int(batch_id))
        if not batch or batch.rolled_back_at is not None:
            raise ValueError("Import batch already rolled back or missing.")
        buyer_ids = [int(x) for x in (batch.buyer_ids or []) if int(x) > 0]
    else:
        buyer_ids = [int(x) for x in (status.get("buyer_ids") or []) if int(x) > 0]

    if not buyer_ids:
        raise ValueError("Import batch has no buyer IDs to delete.")

    # Only delete rows still in this source (moved-away leads are left alone).
    from db.models import Buyer

    still_here = [
        row[0]
        for row in db.query(Buyer.id)
        .filter(Buyer.id.in_(buyer_ids), sa_func.lower(Buyer.source) == src)
        .all()
    ]
    removed = buyers_module.delete_buyers_bulk(db, still_here, commit=False)

    if batch_id:
        batch = db.get(LeadImportBatch, int(batch_id))
        if batch:
            batch.rolled_back_at = _now()
            batch.rolled_back_by_user_id = actor_user_id

    log_action(
        db,
        entity_type="buyer",
        entity_id=0,
        action="import_rollback",
        actor=str(actor_user_id) if actor_user_id else "admin",
        details={
            "source": src,
            "batch_id": batch_id,
            "requested_ids": len(buyer_ids),
            "removed_count": removed,
            "heuristic": bool(status.get("heuristic")),
            "allow_expired": allow_expired,
        },
    )
    invalidate_lead_table_filters_cache()
    invalidate_section_counts_cache()

    remaining = (
        db.query(sa_func.count(Buyer.id))
        .filter(sa_func.lower(Buyer.source) == src)
        .scalar()
    ) or 0

    return {
        "ok": True,
        "source": src,
        "removed_count": removed,
        "remaining_count": int(remaining),
        "batch_id": batch_id,
        "heuristic": bool(status.get("heuristic")),
    }
