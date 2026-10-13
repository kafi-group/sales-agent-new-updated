from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

from api.schemas import EmailAttachmentRead
from modules.email_attachments import (
    complete_chunked_upload,
    init_chunked_upload,
    public_attachment,
    save_upload,
    save_upload_chunk,
)

router = APIRouter(prefix="/email", tags=["email-attachments"])


class ChunkInitRequest(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    content_type: str | None = None
    size: int = Field(gt=0)
    total_chunks: int = Field(ge=1, le=64)


class ChunkInitResponse(BaseModel):
    upload_id: str
    total_chunks: int


class ChunkCompleteRequest(BaseModel):
    upload_id: str = Field(min_length=8, max_length=64)


@router.post("/attachments", response_model=EmailAttachmentRead, status_code=201)
async def upload_email_attachment(file: UploadFile = File(...)):
    try:
        meta = await save_upload(file)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return EmailAttachmentRead(**public_attachment(meta))


@router.post("/attachments/chunk-init", response_model=ChunkInitResponse)
def init_email_attachment_chunks(payload: ChunkInitRequest):
    """Start a chunked upload (each later chunk stays under proxy body limits)."""
    try:
        result = init_chunked_upload(
            filename=payload.filename,
            content_type=payload.content_type,
            size=payload.size,
            total_chunks=payload.total_chunks,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return ChunkInitResponse(**result)


@router.post("/attachments/chunk")
async def upload_email_attachment_chunk(
    upload_id: str = Form(...),
    index: int = Form(...),
    file: UploadFile = File(...),
):
    try:
        result = await save_upload_chunk(upload_id, index, file)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return result


@router.post("/attachments/chunk-complete", response_model=EmailAttachmentRead, status_code=201)
def complete_email_attachment_chunks(payload: ChunkCompleteRequest):
    try:
        meta = complete_chunked_upload(payload.upload_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return EmailAttachmentRead(**public_attachment(meta))
