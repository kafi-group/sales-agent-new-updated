"""Background Data Synthesis jobs with live progress."""

from __future__ import annotations

import threading
import time
import uuid
from pathlib import Path
from typing import Any

from db.session import SessionLocal

_JOB_RETENTION_SECONDS = 3600.0
_RESULTS_DIR = Path(__file__).resolve().parent.parent / "data" / "synthesis_outputs"
_RESULTS_DIR.mkdir(parents=True, exist_ok=True)

_jobs: dict[str, dict[str, Any]] = {}
_lock = threading.Lock()

PHASE_LABELS = {
    "queued": "Waiting to start…",
    "parsing": "Reading spreadsheets…",
    "cleaning": "Cleaning and mapping rows…",
    "deduplicating": "Checking duplicates against master…",
    "merging": "Merging duplicate rows…",
    "exporting": "Building cleaned master file…",
    "completed": "Synthesis complete",
    "failed": "Synthesis failed",
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
        path = _jobs[job_id].get("output_path")
        if path:
            try:
                Path(path).unlink(missing_ok=True)
            except OSError:
                pass
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
    snapshot["phase_label"] = PHASE_LABELS.get(snapshot.get("status", ""), snapshot.get("phase", ""))
    started = job.get("_started_mono")
    finished = job.get("_finished_mono")
    if started is not None:
        end = finished if finished is not None else time.monotonic()
        snapshot["elapsed_seconds"] = round(end - started, 1)
    else:
        snapshot["elapsed_seconds"] = 0.0
    total = snapshot.get("total") or 0
    processed = snapshot.get("processed") or 0
    if snapshot.get("status") == "completed":
        snapshot["percent"] = 100
    elif total > 0:
        snapshot["percent"] = min(99, int(processed * 100 / total))
    else:
        snapshot["percent"] = 0
    return snapshot


def get_job_output_path(job_id: str) -> Path | None:
    with _lock:
        job = _jobs.get(job_id)
        if not job or job.get("status") != "completed":
            return None
        path = job.get("output_path")
    return Path(path) if path else None


def start_synthesis_job(
    uploads: list[tuple[str | None, bytes]],
    *,
    baseline_uploads: list[tuple[str | None, bytes]] | None = None,
    check_db: bool = False,
    expand_messages: list[str] | None = None,
) -> str:
    job_id = uuid.uuid4().hex
    with _lock:
        _prune_locked()
        _jobs[job_id] = {
            "job_id": job_id,
            "status": "queued",
            "phase": "queued",
            "total": 0,
            "processed": 0,
            "raw_rows": 0,
            "output_rows": 0,
            "merged_duplicates": 0,
            "skipped_existing": 0,
            "sheets_processed": 0,
            "files_processed": 0,
            "current_company": None,
            "messages": list(expand_messages or []),
            "error": None,
            "output_filename": None,
            "output_path": None,
            "_started_mono": time.monotonic(),
            "_finished_mono": None,
        }

    thread = threading.Thread(
        target=_run_synthesis,
        kwargs={
            "job_id": job_id,
            "uploads": uploads,
            "baseline_uploads": baseline_uploads,
            "check_db": check_db,
        },
        daemon=True,
        name=f"data-synthesis-{job_id[:8]}",
    )
    thread.start()
    return job_id


def _run_synthesis(
    job_id: str,
    uploads: list[tuple[str | None, bytes]],
    *,
    baseline_uploads: list[tuple[str | None, bytes]] | None,
    check_db: bool,
) -> None:
    from modules.data_synthesis import export_master_xlsx, iter_spreadsheet_tables, run_synthesis

    try:
        _update(job_id, status="parsing", phase="parsing")

        total = 0
        for filename, raw in uploads:
            for _file_name, _sheet_name, _headers, rows in iter_spreadsheet_tables(filename, raw):
                total += len(rows)
        _update(job_id, total=max(total, 1))

        db = SessionLocal()
        try:

            def progress(fields: dict[str, Any]) -> None:
                phase = fields.get("phase") or "cleaning"
                _update(
                    job_id,
                    status=phase if phase in PHASE_LABELS else "cleaning",
                    phase=phase,
                    processed=fields.get("processed", 0),
                    total=fields.get("total") or total or 1,
                    current_company=fields.get("current_company"),
                )

            result = run_synthesis(
                uploads,
                baseline_uploads=baseline_uploads,
                db=db,
                check_db=check_db,
                progress=progress,
            )
        finally:
            db.close()

        _update(job_id, status="exporting", phase="exporting")
        xlsx_bytes = export_master_xlsx(result.output_rows)
        output_filename = f"Master-Contacts-SYNTHESIZED-{job_id[:8]}.xlsx"
        output_path = _RESULTS_DIR / f"{job_id}.xlsx"
        output_path.write_bytes(xlsx_bytes)

        finished = time.monotonic()
        with _lock:
            job = _jobs.get(job_id)
            if job is not None:
                job.update(
                    {
                        "status": "completed",
                        "phase": "completed",
                        "processed": job.get("total") or total or 1,
                        "raw_rows": result.raw_rows,
                        "output_rows": len(result.output_rows),
                        "merged_duplicates": result.merged_duplicates,
                        "skipped_existing": result.skipped_existing,
                        "sheets_processed": result.sheets_processed,
                        "files_processed": result.files_processed,
                        "messages": list(job.get("messages") or []) + result.messages,
                        "output_filename": output_filename,
                        "output_path": str(output_path),
                        "_finished_mono": finished,
                    }
                )
    except Exception as exc:  # noqa: BLE001
        with _lock:
            job = _jobs.get(job_id)
            if job is not None:
                job.update(
                    {
                        "status": "failed",
                        "phase": "failed",
                        "error": str(exc),
                        "_finished_mono": time.monotonic(),
                    }
                )
