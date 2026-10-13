"""Run due AI Sales Agent recurring processes (Sara / Rayan)."""

from __future__ import annotations

from typing import Any


def run_due_processes() -> dict[str, Any]:
    from db.models import AppUser, AppUserRole
    from db.session import SessionLocal
    from modules.ai_sales_processes import due_processes, mark_process_ran

    due = due_processes()
    if not due:
        return {"ran": 0, "results": []}

    db = SessionLocal()
    results: list[dict[str, Any]] = []
    try:
        operator = (
            db.query(AppUser)
            .filter(AppUser.is_active.is_(True), AppUser.role == AppUserRole.admin)
            .order_by(AppUser.id.asc())
            .first()
        )
        if operator is None:
            operator = db.query(AppUser).filter(AppUser.is_active.is_(True)).order_by(AppUser.id.asc()).first()
        if operator is None:
            return {"ran": 0, "error": "No active user to run processes", "results": []}

        from api import ai_sales_agent as asa

        for proc in due:
            try:
                result = asa.execute_recurring_process(db, process=proc, user=operator)
                from datetime import datetime
                from zoneinfo import ZoneInfo

                run_key = datetime.now(ZoneInfo("Asia/Karachi")).strftime("%Y-%m-%dT%H:%M")
                mark_process_ran(proc["id"], run_key, result)
                results.append({"id": proc["id"], "name": proc.get("name"), "ok": True, "result": result})
            except Exception as exc:  # noqa: BLE001
                results.append({"id": proc["id"], "name": proc.get("name"), "ok": False, "error": str(exc)[:300]})
    finally:
        db.close()

    return {"ran": len(results), "results": results}
