"""Data Synthesis API — upload scattered spreadsheets, download cleaned master file."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

from api.deps import require_admin
from api.schemas import (
    SynthesisJobStartResponse,
    SynthesisJobStatusResponse,
)
from db.models import AppUser
from modules.file_to_csv import SUPPORTED_UPLOAD_EXTENSIONS
from modules.upload_expand import ARCHIVE_EXTENSIONS, expand_data_synthesis_uploads

router = APIRouter(prefix="/data-synthesis", tags=["data-synthesis"])

_ALLOWED_UPLOAD_EXT = SUPPORTED_UPLOAD_EXTENSIONS | ARCHIVE_EXTENSIONS


@router.post("/start", response_model=SynthesisJobStartResponse)
async def start_data_synthesis(
    files: list[UploadFile] = File(...),
    baseline: UploadFile | None = File(None),
    check_db: bool = False,
    user: AppUser = Depends(require_admin),
):
    """Upload spreadsheets, folders (multi-part), ZIP, or RAR — start synthesis job."""
    from modules import synthesis_jobs

    if not files:
        raise HTTPException(400, "Select at least one Excel file, folder, ZIP, or RAR.")

    raw_uploads: list[tuple[str | None, bytes]] = []
    for upload in files:
        raw = await upload.read()
        if not raw:
            continue
        ext = Path((upload.filename or "").strip()).suffix.lower()
        if ext and ext not in _ALLOWED_UPLOAD_EXT:
            supported = ", ".join(sorted(_ALLOWED_UPLOAD_EXT))
            raise HTTPException(400, f"Unsupported file {upload.filename!r}. Use: {supported}")
        raw_uploads.append((upload.filename, raw))

    if not raw_uploads:
        raise HTTPException(400, "All uploaded files were empty.")

    try:
        uploads, expand_messages = expand_data_synthesis_uploads(raw_uploads)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    baseline_uploads: list[tuple[str | None, bytes]] | None = None
    if baseline is not None:
        baseline_raw = await baseline.read()
        if baseline_raw:
            baseline_uploads = [(baseline.filename, baseline_raw)]

    job_id = synthesis_jobs.start_synthesis_job(
        uploads,
        baseline_uploads=baseline_uploads,
        check_db=check_db,
        expand_messages=expand_messages,
    )
    return SynthesisJobStartResponse(
        job_id=job_id,
        file_count=len(uploads),
        upload_count=len(raw_uploads),
    )


@router.get("/jobs/{job_id}", response_model=SynthesisJobStatusResponse)
def get_synthesis_job_status(
    job_id: str,
    user: AppUser = Depends(require_admin),
):
    from modules import synthesis_jobs

    job = synthesis_jobs.get_job(job_id)
    if not job:
        raise HTTPException(404, "Synthesis job not found or expired.")
    return SynthesisJobStatusResponse(**job)


@router.get("/jobs/{job_id}/download")
def download_synthesis_result(
    job_id: str,
    user: AppUser = Depends(require_admin),
):
    from modules import synthesis_jobs

    job = synthesis_jobs.get_job(job_id)
    if not job:
        raise HTTPException(404, "Synthesis job not found or expired.")
    if job.get("status") != "completed":
        raise HTTPException(400, "Synthesis is not complete yet.")

    path = synthesis_jobs.get_job_output_path(job_id)
    if not path or not path.is_file():
        raise HTTPException(404, "Synthesized file is no longer available.")

    filename = job.get("output_filename") or path.name
    return FileResponse(
        path,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename=filename,
    )
