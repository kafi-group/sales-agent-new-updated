"""Execute due one-shot AI Auto Mode Start schedules (Sara / Rayan)."""

from __future__ import annotations

from typing import Any


def run_due_auto_mode_starts() -> dict[str, Any]:
    from db.models import AppUser
    from db.session import SessionLocal
    from modules.ai_sales_auto_mode import (
        due_scheduled_starts,
        mark_scheduled_start,
    )

    due = due_scheduled_starts()
    if not due:
        return {"ran": 0, "results": []}

    db = SessionLocal()
    results: list[dict[str, Any]] = []
    try:
        from api import ai_sales_agent as asa
        from api.ai_sales_agent import RunnerControlRequest
        from fastapi import HTTPException

        for item in due:
            sid = str(item.get("id") or "")
            persona = str(item.get("persona") or "female")
            mark_scheduled_start(sid, status="running")
            user = None
            created_by = item.get("created_by")
            if created_by:
                user = db.get(AppUser, int(created_by))
            if user is None or not getattr(user, "is_active", True):
                user = (
                    db.query(AppUser)
                    .filter(AppUser.is_active.is_(True))
                    .order_by(AppUser.id.asc())
                    .first()
                )
            if user is None:
                mark_scheduled_start(
                    sid,
                    status="failed",
                    error="No active user to run scheduled start",
                )
                results.append({"id": sid, "ok": False, "error": "no user"})
                continue
            try:
                result = asa.start_runner(
                    RunnerControlRequest(
                        persona=persona,
                        sequence=True,
                        task_id=None,
                        queue_lane="auto_mode",
                    ),
                    db=db,
                    user=user,
                )
                from modules.ai_agent_persona import persona_display_name

                name = persona_display_name(persona)
                # Bulk email path returns summary dict; dial path returns runner.
                msg = None
                if isinstance(result, dict):
                    sent = result.get("sent")
                    failed = result.get("failed")
                    if sent is not None:
                        msg = f"{name} scheduled bulk email finished: sent={sent}, failed={failed}"
                    else:
                        msg = f"{name} scheduled start began (status={result.get('status')})"
                mark_scheduled_start(sid, status="done", result_message=msg)
                results.append({"id": sid, "persona": persona, "ok": True, "message": msg})
            except HTTPException as exc:
                detail = exc.detail if isinstance(exc.detail, str) else str(exc.detail)
                mark_scheduled_start(sid, status="failed", error=detail[:400])
                results.append({"id": sid, "persona": persona, "ok": False, "error": detail[:200]})
            except Exception as exc:  # noqa: BLE001
                mark_scheduled_start(sid, status="failed", error=str(exc)[:400])
                results.append({"id": sid, "persona": persona, "ok": False, "error": str(exc)[:200]})
    finally:
        db.close()

    return {"ran": len(results), "results": results}
