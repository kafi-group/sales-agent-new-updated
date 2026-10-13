"""Product chatbot API — image + text messages, multi-provider vision LLM."""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from api.deps import get_current_user, get_db
from db.models import AppUser

router = APIRouter(prefix="/chatbot", tags=["chatbot"])

_ALLOWED_IMAGE_TYPES = {
    "image/jpeg": "image/jpeg",
    "image/jpg": "image/jpeg",
    "image/png": "image/png",
    "image/webp": "image/webp",
    "image/gif": "image/gif",
}

MAX_IMAGE_BYTES = 10 * 1024 * 1024  # 10 MB


class ChatHistoryMessage(BaseModel):
    role: str  # "user" | "assistant"
    content: str


class ChatRequest(BaseModel):
    message: str
    history: list[ChatHistoryMessage] = []


class ChatResponse(BaseModel):
    reply: str
    provider: str
    model: str


class ChatStatusResponse(BaseModel):
    gemini: bool
    openai: bool
    anthropic: bool


@router.get("/status", response_model=ChatStatusResponse)
def chatbot_status() -> Any:
    from modules.product_chatbot import status
    return status()


@router.post("/chat", response_model=ChatResponse)
async def chat(
    message: str = Form(...),
    history: str = Form(default="[]"),
    image: Optional[UploadFile] = File(default=None),
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> Any:
    """Send a text message with an optional product image.

    - **message**: the user's question or request.
    - **history**: JSON array of `{role, content}` prior turns (stringified).
    - **image**: optional uploaded product image file.
    """
    import json

    from modules import activity as activity_module

    # Parse history
    try:
        raw_history: list[dict] = json.loads(history)
        if not isinstance(raw_history, list):
            raw_history = []
    except Exception:
        raw_history = []

    # Validate + read image
    image_bytes: bytes | None = None
    mime_type = "image/jpeg"
    if image and image.filename:
        content_type = (image.content_type or "image/jpeg").lower()
        resolved_mime = _ALLOWED_IMAGE_TYPES.get(content_type)
        if not resolved_mime:
            raise HTTPException(
                400,
                f"Unsupported image type '{content_type}'. "
                "Allowed: jpeg, png, webp, gif.",
            )
        image_bytes = await image.read()
        if len(image_bytes) > MAX_IMAGE_BYTES:
            raise HTTPException(400, "Image too large. Maximum size is 10 MB.")
        mime_type = resolved_mime

    if not message.strip():
        raise HTTPException(400, "Message cannot be empty.")

    is_new_session = not any(
        isinstance(m, dict) and m.get("role") == "user" for m in raw_history
    )

    try:
        from modules.product_chatbot import chat as chatbot_chat

        result = chatbot_chat(
            message=message.strip(),
            image_bytes=image_bytes,
            mime_type=mime_type,
            history=raw_history,
        )
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from exc

    if is_new_session:
        preview = message.strip()
        if len(preview) > 120:
            preview = preview[:117] + "…"
        activity_module.log_activity(
            db,
            user_id=user.id,
            activity_type=activity_module.BRAND_ASSISTANT_SESSION,
            title="Brand assistant session",
            summary=f"Started a brand assistant chat: {preview}",
            entity_type="chatbot",
            entity_id=None,
            details={"provider": result.get("provider"), "has_image": bool(image_bytes)},
        )

    return ChatResponse(
        reply=result["reply"],
        provider=result["provider"],
        model=result.get("model", ""),
    )
