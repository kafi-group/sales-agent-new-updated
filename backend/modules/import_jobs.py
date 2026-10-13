"""Background lead-import jobs with live progress.

Large spreadsheet imports (1000-2000+ rows) run in a worker thread with their
own DB session.  The API returns a job_id immediately and the frontend polls
GET /api/leads/import-jobs/{job_id} to drive a real progress bar.

In-memory registry is safe because Railway runs a single uvicorn worker
(see railway.toml).  Jobs are pruned after an hour.
"""

from __future__ import annotations

import threading
import time
import uuid
from typing import Any

_JOB_RETENTION_SECONDS = 3600.0
_MAX_RESULT_ROWS = 25000

_jobs: dict[str, dict[str, Any]] = {}
_lock = threading.Lock()

PHASE_LABELS = {
    "queued": "Waiting to start…",
    "running": "Saving leads into the table…",
    "committing": "Committing all rows to the database…",
    "verifying": "Verifying rows landed in the table…",
    "completed": "Import complete",
    "failed": "Import failed",
}


def _prune_locked() -> None:
    now = time.monotonic()
    stale = [
        job_id
        for job_id, job in _jobs.items()
        if job.get("status") in ("completed", "failed")
        and now - job.get("_finished_mono", now) > _JOB_RETENTION_SECONDS
    ]
    for job_id in stale:
        del _jobs[job_id]


def _update(job_id: str, **fields: Any) -> None:
    with _lock:
        job = _jobs.get(job_id)
        if job is not None:
            job.update(fields)


def get_job(job_id: str) -> dict[str, Any] | None:
    with _lock:
        job = _jobs.get(job_id)
        if job is None:
            return None
        snapshot = {k: v for k, v in job.items() if not k.startswith("_")}
    snapshot["phase_label"] = PHASE_LABELS.get(snapshot.get("status", ""), "")
    started = job.get("_started_mono")
    finished = job.get("_finished_mono")
    if started is not None:
        end = finished if finished is not None else time.monotonic()
        snapshot["elapsed_seconds"] = round(end - started, 1)
    else:
        snapshot["elapsed_seconds"] = 0.0
    return snapshot


def start_import_job(
    candidates: list[dict[str, Any]],
    *,
    auto_onboard: bool = False,
    replace_duplicates: bool = False,
    skip_enrichment: bool = False,
    assigned_to_user_id: int | None = None,
    user_id: int | None = None,
) -> str:
    """Register a job and kick off the import thread. Returns the job id."""
    if len(candidates) > _MAX_RESULT_ROWS:
        raise ValueError(f"Import at most {_MAX_RESULT_ROWS} rows per job")

    job_id = uuid.uuid4().hex
    import_source = next(
        ((raw.get("source") or "").strip() for raw in candidates if (raw.get("source") or "").strip()),
        None,
    )
    with _lock:
        _prune_locked()
        _jobs[job_id] = {
            "job_id": job_id,
            "status": "queued",
            "total": len(candidates),
            "processed": 0,
            "created_count": 0,
            "skipped_count": 0,
            "replaced_count": 0,
            "current_company": None,
            "error": None,
            "import_source": import_source,
            "verified_source_total": None,
            "created": None,
            "skipped": None,
            "replaced": None,
            "skip_reason_counts": None,
            "_started_mono": time.monotonic(),
            "_finished_mono": None,
        }

    thread = threading.Thread(
        target=_run_import,
        kwargs={
            "job_id": job_id,
            "candidates": candidates,
            "auto_onboard": auto_onboard,
            "replace_duplicates": replace_duplicates,
            "skip_enrichment": skip_enrichment,
            "assigned_to_user_id": assigned_to_user_id,
            "user_id": user_id,
            "import_source": import_source,
        },
        daemon=True,
        name=f"lead-import-{job_id[:8]}",
    )
    thread.start()
    return job_id


def _run_import(
    *,
    job_id: str,
    candidates: list[dict[str, Any]],
    auto_onboard: bool,
    replace_duplicates: bool,
    skip_enrichment: bool,
    assigned_to_user_id: int | None,
    user_id: int | None,
    import_source: str | None,
) -> None:
    from db.session import SessionLocal
    from modules.lead_discovery import import_candidates

    db = SessionLocal()
    try:
        total = len(candidates)

        def on_progress(processed: int, current_name: str, counts: dict[str, int]) -> None:
            # The final commit happens right after the last row is processed —
            # surface that as its own phase so the bar doesn't look stuck at 100%.
            status = "committing" if processed >= total else "running"
            _update(
                job_id,
                status=status,
                processed=processed,
                current_company=current_name or None,
                created_count=counts.get("created", 0),
                skipped_count=counts.get("skipped", 0),
                replaced_count=counts.get("replaced", 0),
            )

        _update(job_id, status="running")
        result = import_candidates(
            db,
            candidates,
            auto_onboard=auto_onboard,
            replace_duplicates=replace_duplicates,
            skip_enrichment=skip_enrichment,
            assigned_to_user_id=assigned_to_user_id,
            progress_callback=on_progress,
        )

        _update(job_id, status="verifying")
        created_count, skipped_rows, replaced_rows, verified_total = _finalize_import_result(
            db,
            result,
            import_source=import_source,
            job_id=job_id,
            user_id=user_id,
            assigned_to_user_id=assigned_to_user_id,
        )
        created_rows = [
            {"id": buyer.id, "company_name": buyer.company_name}
            for buyer in result.get("created", [])
        ]

        _update(
            job_id,
            status="completed",
            processed=total,
            current_company=None,
            created_count=created_count,
            skipped_count=len(skipped_rows),
            replaced_count=len(replaced_rows),
            verified_source_total=verified_total,
            created=created_rows,
            skipped=skipped_rows,
            replaced=replaced_rows,
            skip_reason_counts=result.get("skip_reason_counts") or {},
            _finished_mono=time.monotonic(),
        )
    except Exception as exc:  # noqa: BLE001 — job must always reach a terminal state
        # import_candidates commits in checkpoints (see COMMIT_EVERY) and, on
        # failure, makes a best-effort final commit of everything mapped so
        # far before re-raising — attaching what actually landed in the DB as
        # `partial_import_result`. Surface that here instead of reporting a
        # bare failure with no rows saved.
        partial = getattr(exc, "partial_import_result", None)
        if partial:
            created_count, skipped_rows, replaced_rows, verified_total = _finalize_import_result(
                db,
                partial,
                import_source=import_source,
                job_id=job_id,
                user_id=user_id,
                assigned_to_user_id=assigned_to_user_id,
            )
            created_rows = [
                {"id": buyer.id, "company_name": buyer.company_name}
                for buyer in partial.get("created", [])
            ]
            _update(
                job_id,
                status="failed",
                created_count=created_count,
                skipped_count=len(skipped_rows),
                replaced_count=len(replaced_rows),
                verified_source_total=verified_total,
                created=created_rows,
                skipped=skipped_rows,
                replaced=replaced_rows,
                error=(
                    f"{exc} — {created_count} lead(s) mapped before the error were "
                    "still saved to the table; re-run the import for the remaining rows."
                ),
                _finished_mono=time.monotonic(),
            )
        else:
            _update(
                job_id,
                status="failed",
                error=str(exc) or exc.__class__.__name__,
                _finished_mono=time.monotonic(),
            )
    finally:
        db.close()


def _post_import_country_repair(
    db: Any,
    *,
    import_source: str | None,
    assigned_to_user_id: int | None,
    created: list[Any],
) -> None:
    """Canonicalize country spellings after spreadsheet import (e.g. Srilanka → Sri Lanka)."""
    if (import_source or "").strip().lower() != "old_clients":
        return
    try:
        from modules.leads import invalidate_lead_table_filters_cache, invalidate_section_counts_cache
        from modules.post_import_old_clients import (
            backfill_country_from_phones,
            normalize_countries,
            normalize_countries_for_buyer_ids,
        )

        if created:
            normalize_countries_for_buyer_ids(db, [buyer.id for buyer in created])
        spelling = normalize_countries(
            db,
            source="old_clients",
            assigned_to_user_id=assigned_to_user_id,
        )
        phone_fill = backfill_country_from_phones(
            db,
            source="old_clients",
            assigned_to_user_id=assigned_to_user_id,
        )
        if spelling.get("changed") or phone_fill.get("changed"):
            invalidate_lead_table_filters_cache()
            invalidate_section_counts_cache()
    except Exception as exc:  # noqa: BLE001 — repair must not fail the import job
        print(f"Post-import country repair skipped: {exc}", flush=True)


def _finalize_import_result(
    db: Any,
    result: dict[str, Any],
    *,
    import_source: str | None,
    job_id: str,
    user_id: int | None,
    assigned_to_user_id: int | None = None,
) -> tuple[int, list[dict[str, str]], list[dict[str, Any]], int | None]:
    """Verify the DB row count for the import source and log the activity entry.

    Shared by both the successful-completion path and the partial-failure path
    so a mid-import error still gets an accurate, DB-verified saved count.
    """
    skipped_rows = list(result.get("skipped", []))
    replaced_rows = list(result.get("replaced", []))
    created_count = len(result.get("created", []))

    verified_total: int | None = None
    if import_source:
        try:
            from sqlalchemy import func as sa_func

            from db.models import Buyer

            verified_total = (
                db.query(sa_func.count(Buyer.id)).filter(Buyer.source == import_source).scalar()
            ) or 0
        except Exception:  # noqa: BLE001 — verification is best-effort
            verified_total = None

    if created_count > 0 and user_id is not None:
        try:
            from modules import activity as activity_module

            activity_module.log_activity(
                db,
                user_id=user_id,
                activity_type=activity_module.LEADS_IMPORTED,
                title="Leads imported",
                summary=f"Imported {created_count} lead{'s' if created_count != 1 else ''} into the table",
                quantity=created_count,
                entity_type="buyer",
                entity_id=None,
                details={
                    "created_count": created_count,
                    "skipped_count": len(skipped_rows),
                    "replaced_count": len(replaced_rows),
                    "import_job_id": job_id,
                    "import_source": import_source,
                },
            )
        except Exception:  # noqa: BLE001 — activity log must not fail the import
            pass

    if created_count > 0 and import_source:
        try:
            from modules.import_rollback import record_import_batch

            created_buyers = list(result.get("created") or [])
            buyer_ids = [
                int(getattr(b, "id", 0) or (b.get("id") if isinstance(b, dict) else 0) or 0)
                for b in created_buyers
            ]
            record_import_batch(
                db,
                source=import_source,
                buyer_ids=buyer_ids,
                created_by_user_id=user_id,
                import_job_id=job_id,
                commit=True,
            )
        except Exception as exc:  # noqa: BLE001
            print(f"Import batch record skipped: {exc}", flush=True)

    _post_import_country_repair(
        db,
        import_source=import_source,
        assigned_to_user_id=assigned_to_user_id,
        created=list(result.get("created") or []),
    )

    return created_count, skipped_rows, replaced_rows, verified_total
