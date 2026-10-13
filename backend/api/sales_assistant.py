"""Sales assistant API — gated co-pilot with tools + navigation."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from api.deps import get_current_user, get_db
from db.models import AppUser

router = APIRouter(prefix="/sales-assistant", tags=["sales-assistant"])


class SalesAssistantHistoryMessage(BaseModel):
    role: str
    content: str


class SalesAssistantUnlockRequest(BaseModel):
    access_code: str


class SalesAssistantUnlockResponse(BaseModel):
    ok: bool


class SalesAssistantStatusResponse(BaseModel):
    enabled: bool


class SalesAssistantChatRequest(BaseModel):
    message: str
    access_code: str
    history: list[SalesAssistantHistoryMessage] = Field(default_factory=list)


class SalesAssistantChatResponse(BaseModel):
    reply: str
    actions: list[dict[str, Any]] = Field(default_factory=list)
    provider: str = "gemini"
    model: str = ""


@router.get("/status", response_model=SalesAssistantStatusResponse)
def sales_assistant_status() -> Any:
    from modules import sales_assistant as assistant_module

    return {"enabled": assistant_module.llm_enabled()}


@router.post("/unlock", response_model=SalesAssistantUnlockResponse)
def sales_assistant_unlock(
    payload: SalesAssistantUnlockRequest,
    user: AppUser = Depends(get_current_user),
) -> Any:
    _ = user
    from modules import sales_assistant as assistant_module

    if not assistant_module.access_code_valid(payload.access_code):
        raise HTTPException(403, "Invalid access code.")
    return {"ok": True}


@router.post("/chat", response_model=SalesAssistantChatResponse)
def sales_assistant_chat(
    payload: SalesAssistantChatRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> Any:
    from modules import sales_assistant as assistant_module

    if not assistant_module.access_code_valid(payload.access_code):
        raise HTTPException(403, "Invalid access code.")
    if not assistant_module.llm_enabled():
        raise HTTPException(
            503,
            "Sales assistant is not configured. Set SALES_ASSISTANT_GEMINI_API_KEY on the backend.",
        )
    cleaned = (payload.message or "").strip()
    if not cleaned:
        raise HTTPException(400, "Message cannot be empty.")

    history = [
        {"role": m.role, "content": m.content}
        for m in payload.history
        if m.content.strip()
    ][-20:]

    try:
        result = assistant_module.chat(
            db,
            user,
            message=cleaned,
            history=history,
        )
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from exc

    return SalesAssistantChatResponse(**result)
