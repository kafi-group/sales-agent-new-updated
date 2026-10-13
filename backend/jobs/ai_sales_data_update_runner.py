"""Tick AI Auto Data Update schedules (Sara / Rayan)."""

from __future__ import annotations

from typing import Any


def run_data_update_tick() -> dict[str, Any]:
    """Start due schedules and process at most one contact per running persona (cooldown)."""
    from db.session import SessionLocal
    from modules import ai_sales_data_update as du
    from modules.ai_agent_persona import persona_display_name

    results: list[dict[str, Any]] = []

    for persona in du.personas_needing_start():
        try:
            from api import ai_sales_agent as asa

            pending = [
                t
                for t in asa._TASKS  # noqa: SLF001
                if t.get("persona") == persona
                and (t.get("queue_lane") or "outreach") == "data_update"
            ]
            du.start_run(persona, total=len(pending), force=False)
            for t in pending:
                t.pop("data_update_run_id", None)
            asa._persist_queue()  # noqa: SLF001
            if pending:
                try:
                    from modules import ai_sales_agent_log as asal

                    db_log = SessionLocal()
                    try:
                        asal.record_run_start(
                            db_log,
                            user=None,
                            persona=persona,
                            queue_lane="data_update",
                            tasks=pending,
                            user_label="Scheduler",
                            note=(
                                f"{persona_display_name(persona)} "
                                f"Data Update scheduled start ({len(pending)} contacts)"
                            ),
                        )
                    finally:
                        db_log.close()
                except Exception as log_exc:  # noqa: BLE001
                    print(f"AI Sales Agent scheduled data-update log failed: {log_exc}", flush=True)
            results.append({"persona": persona, "action": "started", "total": len(pending)})
        except Exception as exc:  # noqa: BLE001
            results.append({"persona": persona, "action": "start_failed", "error": str(exc)[:200]})

    for persona in du.running_personas():
        if du.should_stop_running(persona):
            du.complete_run(persona)
            results.append({"persona": persona, "action": "stopped_end_time"})
            continue

        if not du.cooldown_elapsed(persona):
            results.append({"persona": persona, "action": "cooldown"})
            continue

        status = du.get_status()
        sch = status["schedules"][persona]
        cooldown = int(sch.get("cooldown_sec") or du.DEFAULT_COOLDOWN_SEC)
        run_id = status["run_state"][persona].get("run_id")

        try:
            from api import ai_sales_agent as asa

            pending = [
                t
                for t in asa._TASKS  # noqa: SLF001
                if t.get("persona") == persona
                and (t.get("queue_lane") or "outreach") == "data_update"
                and t.get("data_update_run_id") != run_id
            ]

            if not pending:
                du.complete_run(persona)
                results.append({"persona": persona, "action": "completed"})
                continue

            task = pending[0]
            buyer_id = int(task.get("buyer_id") or 0)
            label = (
                task.get("company_name")
                or task.get("contact_name")
                or f"Lead #{buyer_id}"
            )
            du.mark_current(persona, buyer_id, str(label))

            db = SessionLocal()
            try:
                result = du.research_and_update_buyer(db, buyer_id)
            finally:
                db.close()

            task["data_update_run_id"] = run_id
            task["data_update_last"] = {
                "ok": result.get("ok"),
                "filled": result.get("filled") or [],
                "changes": result.get("changes") or [],
                "skipped": result.get("skipped"),
                "error": result.get("error"),
                "reason": result.get("reason"),
            }
            asa._persist_queue()  # noqa: SLF001

            du.record_contact_result(
                persona,
                buyer_id=buyer_id,
                label=str(label),
                result=result,
                cooldown_sec=cooldown,
            )
            results.append(
                {
                    "persona": persona,
                    "action": "processed",
                    "buyer_id": buyer_id,
                    "filled": result.get("filled") or [],
                    "ok": result.get("ok"),
                }
            )
        except Exception as exc:  # noqa: BLE001
            results.append({"persona": persona, "action": "error", "error": str(exc)[:300]})

    return {"results": results}
