"""Persist Sara/Rayan AI Sales Agent queue in Postgres (survives Railway redeploys).

Assigned contacts remain until DELETE /tasks/{id} (manual Remove).
"""

from __future__ import annotations

import copy
import threading
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session, attributes

from db.models import AiSalesAgentState
from db.session import SessionLocal

_LOCK = threading.Lock()
_STATE_ID = 1
_MAX_TASKS = 500


def _runner_snap(runners: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for r in runners:
        out.append(
            {
                "persona": r.get("persona"),
                "operator_user_id": r.get("operator_user_id"),
                "pending_count": r.get("pending_count") or 0,
            }
        )
    return out


def _tasks_for_persist(tasks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Deep-copy so we never mutate live in-memory task dicts."""
    trimmed = tasks[-_MAX_TASKS:] if len(tasks) > _MAX_TASKS else tasks
    snap: list[dict[str, Any]] = []
    for t in trimmed:
        row = copy.deepcopy(t)
        # Active dials are saved as queued so a restart does not leave ghost in_progress.
        if row.get("status") == "in_progress":
            row["status"] = "queued"
            row["outcome"] = None
            row["call_sid"] = None
            row["remarks"] = "Still assigned — call interrupted by server restart; ready to dial again."
            row.pop("started_at", None)
        snap.append(row)
    return snap


def load_queue_state() -> dict[str, Any]:
    db = SessionLocal()
    try:
        row = db.get(AiSalesAgentState, _STATE_ID)
        if not row:
            return {"tasks": [], "runners": []}
        tasks = row.tasks if isinstance(row.tasks, list) else []
        runners = row.runners if isinstance(row.runners, list) else []
        return {"tasks": list(tasks), "runners": list(runners)}
    except Exception as exc:  # noqa: BLE001
        print(f"AI Sales queue DB load failed: {exc}", flush=True)
        return {"tasks": [], "runners": []}
    finally:
        db.close()


def save_queue_state(*, tasks: list[dict[str, Any]], runners: list[dict[str, Any]]) -> None:
    payload_tasks = _tasks_for_persist(tasks)
    payload_runners = _runner_snap(runners)
    with _LOCK:
        db = SessionLocal()
        try:
            row = db.get(AiSalesAgentState, _STATE_ID)
            if row is None:
                row = AiSalesAgentState(
                    id=_STATE_ID,
                    tasks=payload_tasks,
                    runners=payload_runners,
                    updated_at=datetime.now(timezone.utc),
                )
                db.add(row)
            else:
                row.tasks = payload_tasks
                row.runners = payload_runners
                row.updated_at = datetime.now(timezone.utc)
                attributes.flag_modified(row, "tasks")
                attributes.flag_modified(row, "runners")
            db.commit()
        except Exception as exc:  # noqa: BLE001
            db.rollback()
            print(f"AI Sales queue DB save failed: {exc}", flush=True)
        finally:
            db.close()


def ensure_state_table(db: Session | None = None) -> None:
    """Create table if migration has not run yet (idempotent)."""
    owns = db is None
    session = db or SessionLocal()
    try:
        AiSalesAgentState.__table__.create(bind=session.get_bind(), checkfirst=True)
        # Ensure singleton row exists
        if session.get(AiSalesAgentState, _STATE_ID) is None:
            session.add(
                AiSalesAgentState(
                    id=_STATE_ID,
                    tasks=[],
                    runners=[],
                    updated_at=datetime.now(timezone.utc),
                )
            )
        if owns:
            session.commit()
    except Exception as exc:  # noqa: BLE001
        if owns:
            session.rollback()
        print(f"AI Sales queue table ensure failed: {exc}", flush=True)
    finally:
        if owns:
            session.close()
