"""Guard against overlapping bulk email sends to the same clients.

A second bulk send that shares buyer IDs with a run started in the last
``OVERLAP_WINDOW`` for the same user requires an explicit confirm_overlap flag.
After the window elapses, the same clients may be emailed again without warning.
"""

from __future__ import annotations

import threading
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

OVERLAP_WINDOW = timedelta(minutes=30)

_lock = threading.Lock()
_runs: list["BulkEmailRun"] = []


@dataclass
class BulkEmailRun:
    run_id: str
    user_id: int
    buyer_ids: frozenset[int]
    started_at: datetime
    finished_at: datetime | None = None
    in_progress: bool = True


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _prune_locked(now: datetime | None = None) -> None:
    now = now or _utcnow()
    cutoff = now - OVERLAP_WINDOW
    keep: list[BulkEmailRun] = []
    for run in _runs:
        # Keep in-progress forever until finished (then window applies).
        if run.in_progress:
            keep.append(run)
            continue
        end = run.finished_at or run.started_at
        if end >= cutoff:
            keep.append(run)
    _runs[:] = keep


def find_overlap(user_id: int, buyer_ids: list[int] | set[int]) -> dict[str, Any] | None:
    """Return overlap info if any recent/in-progress run shares clients, else None."""
    wanted = {int(b) for b in buyer_ids if b is not None}
    if not wanted:
        return None

    now = _utcnow()
    with _lock:
        _prune_locked(now)
        best: BulkEmailRun | None = None
        best_overlap: set[int] = set()
        for run in _runs:
            if run.user_id != user_id:
                continue
            shared = wanted & set(run.buyer_ids)
            if not shared:
                continue
            if best is None or run.started_at > best.started_at:
                best = run
                best_overlap = shared

        if best is None:
            return None

        elapsed = now - best.started_at
        remaining = OVERLAP_WINDOW - elapsed
        minutes_ago = max(0, int(elapsed.total_seconds() // 60))
        minutes_left = max(0, int(remaining.total_seconds() // 60) + (
            1 if remaining.total_seconds() % 60 > 0 else 0
        ))
        status = "still running" if best.in_progress else f"started ~{minutes_ago} min ago"
        return {
            "has_overlap": True,
            "overlapping_count": len(best_overlap),
            "overlapping_buyer_ids": sorted(best_overlap)[:50],
            "run_in_progress": best.in_progress,
            "minutes_ago": minutes_ago,
            "minutes_remaining": minutes_left,
            "message": (
                f"A bulk email for {len(best_overlap)} of these same client"
                f"{'s' if len(best_overlap) != 1 else ''} is {status}. "
                f"Starting another now may send duplicate emails. "
                f"Wait about {minutes_left} more minute"
                f"{'s' if minutes_left != 1 else ''} (30-minute window), "
                f"or confirm to send anyway."
            ),
        }


def begin_run(user_id: int, buyer_ids: list[int] | set[int]) -> str:
    run_id = uuid.uuid4().hex
    wanted = frozenset(int(b) for b in buyer_ids if b is not None)
    with _lock:
        _prune_locked()
        _runs.append(
            BulkEmailRun(
                run_id=run_id,
                user_id=user_id,
                buyer_ids=wanted,
                started_at=_utcnow(),
                in_progress=True,
            )
        )
    return run_id


def finish_run(run_id: str) -> None:
    now = _utcnow()
    with _lock:
        for run in _runs:
            if run.run_id == run_id:
                run.in_progress = False
                run.finished_at = now
                break
        _prune_locked(now)
