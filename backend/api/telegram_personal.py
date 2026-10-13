"""Telegram Mobile — personal Telegram user account via MTProto bridge."""

from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from api.deps import get_current_user, get_db
from api.schemas import (
    TelegramPersonalTemplateCreate,
    TelegramPersonalTemplateRead,
    TelegramPersonalTemplateUpdate,
)
from db.models import AppUser, Buyer
from integrations import telegram_bridge_client as bridge
from modules import telegram_personal_templates as personal_templates_module
from modules.audit import log_action

router = APIRouter(prefix="/telegram-personal", tags=["telegram-personal"])


class PhoneLoginBody(BaseModel):
    phone: str = Field(..., min_length=8, max_length=32)


class CodeBody(BaseModel):
    code: str = Field(..., min_length=3, max_length=16)


class PasswordBody(BaseModel):
    password: str = Field(..., min_length=1, max_length=128)


class SendBody(BaseModel):
    to_phone: str = Field(..., min_length=5, max_length=64)
    message: str = Field(..., min_length=1, max_length=4000)


class BulkSendBody(BaseModel):
    buyer_ids: list[int] = Field(default_factory=list)
    phones: list[str] = Field(default_factory=list)
    message: str = Field(..., min_length=1, max_length=4000)


def _session(user: AppUser) -> str:
    return bridge.bridge_session_id(int(user.id), user.username)


def _personal_template_read(record) -> TelegramPersonalTemplateRead:
    return TelegramPersonalTemplateRead.model_validate(record)


@router.get("/templates", response_model=list[TelegramPersonalTemplateRead])
def list_personal_telegram_templates(
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> list[TelegramPersonalTemplateRead]:
    _ = user
    return [_personal_template_read(t) for t in personal_templates_module.list_templates(db)]


@router.post("/templates", response_model=TelegramPersonalTemplateRead, status_code=201)
def create_personal_telegram_template(
    payload: TelegramPersonalTemplateCreate,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> TelegramPersonalTemplateRead:
    try:
        record = personal_templates_module.create_template(
            db,
            name=payload.name,
            body=payload.body,
            created_by_user_id=user.id,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    log_action(
        db,
        entity_type="telegram_personal_template",
        entity_id=record.id,
        action="created",
        actor=user.username,
    )
    return _personal_template_read(record)


@router.put("/templates/{template_id}", response_model=TelegramPersonalTemplateRead)
def update_personal_telegram_template(
    template_id: int,
    payload: TelegramPersonalTemplateUpdate,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> TelegramPersonalTemplateRead:
    try:
        record = personal_templates_module.update_template(
            db,
            template_id,
            name=payload.name,
            body=payload.body,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not record:
        raise HTTPException(404, "Telegram template not found")
    log_action(
        db,
        entity_type="telegram_personal_template",
        entity_id=record.id,
        action="updated",
        actor=user.username,
    )
    return _personal_template_read(record)


@router.delete("/templates/{template_id}")
def delete_personal_telegram_template(
    template_id: int,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> dict[str, bool]:
    ok = personal_templates_module.delete_template(db, template_id)
    if not ok:
        raise HTTPException(404, "Telegram template not found")
    log_action(
        db,
        entity_type="telegram_personal_template",
        entity_id=template_id,
        action="deleted",
        actor=user.username,
    )
    return {"ok": True}


@router.get("/session")
def get_session(user: AppUser = Depends(get_current_user)):
    return {
        "session_id": _session(user),
        "bridge_configured": bridge.bridge_configured(),
    }


@router.get("/status")
def get_status(user: AppUser = Depends(get_current_user)):
    if not bridge.bridge_configured():
        return {
            "connected": False,
            "status": "unconfigured",
            "configured": False,
            "message": (
                "Telegram bridge not configured. Deploy telegram_bridge, set TELEGRAM_API_ID / "
                "TELEGRAM_API_HASH on the bridge and TELEGRAM_BRIDGE_URL on Sales Agent."
            ),
        }
    try:
        data = bridge.get_status(_session(user))
        # Bridge URL is configured; MTProto credentials live on the bridge itself.
        bridge_ready = bool(data.get("configured", False))
        data["configured"] = bridge_ready
        data["bridge_configured"] = True
        if not bridge_ready and not data.get("message"):
            data["message"] = (
                "Telegram bridge is reachable but TELEGRAM_API_ID / TELEGRAM_API_HASH "
                "are missing or invalid on the telegram_bridge Railway service "
                "(create them at https://my.telegram.org)."
            )
        return data
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, str(exc)) from exc


@router.post("/start-login")
def start_login(body: PhoneLoginBody, user: AppUser = Depends(get_current_user)):
    if not bridge.bridge_configured():
        raise HTTPException(503, "Telegram bridge is not configured")
    try:
        return bridge.start_login(_session(user), body.phone.strip())
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, str(exc)) from exc


@router.post("/start-qr-login")
def start_qr_login(user: AppUser = Depends(get_current_user)):
    if not bridge.bridge_configured():
        raise HTTPException(503, "Telegram bridge is not configured")
    try:
        return bridge.start_qr_login(_session(user))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, str(exc)) from exc


@router.post("/poll-qr-login")
def poll_qr_login(user: AppUser = Depends(get_current_user)):
    if not bridge.bridge_configured():
        raise HTTPException(503, "Telegram bridge is not configured")
    try:
        return bridge.poll_qr_login(_session(user))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, str(exc)) from exc


@router.post("/confirm-code")
def confirm_code(body: CodeBody, user: AppUser = Depends(get_current_user)):
    if not bridge.bridge_configured():
        raise HTTPException(503, "Telegram bridge is not configured")
    try:
        return bridge.confirm_code(_session(user), body.code.strip())
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, str(exc)) from exc


@router.post("/confirm-password")
def confirm_password(body: PasswordBody, user: AppUser = Depends(get_current_user)):
    if not bridge.bridge_configured():
        raise HTTPException(503, "Telegram bridge is not configured")
    try:
        return bridge.confirm_password(_session(user), body.password)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, str(exc)) from exc


@router.post("/disconnect")
def disconnect(user: AppUser = Depends(get_current_user)):
    if not bridge.bridge_configured():
        raise HTTPException(503, "Telegram bridge is not configured")
    try:
        return bridge.disconnect(_session(user))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, str(exc)) from exc


@router.post("/send")
def send_message(body: SendBody, user: AppUser = Depends(get_current_user)):
    if not bridge.bridge_configured():
        raise HTTPException(503, "Telegram bridge is not configured")
    try:
        status = bridge.get_status(_session(user))
        if not status.get("connected"):
            raise HTTPException(
                409,
                "Telegram Mobile is not connected. Open Telegram Mobile and link your phone.",
            )
        return bridge.send_message(_session(user), body.to_phone.strip(), body.message.strip())
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, str(exc)) from exc


@router.post("/bulk-send")
def bulk_send(
    body: BulkSendBody,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> Any:
    """Send Telegram Mobile message to multiple selected leads/buyers."""
    from modules import activity as activity_module
    from modules import buyers as buyers_module

    if not bridge.bridge_configured():
        raise HTTPException(503, "Telegram bridge is not configured")
    try:
        status = bridge.get_status(_session(user))
        if not status.get("connected"):
            raise HTTPException(
                409,
                "Telegram Mobile is not connected. Open Telegram Mobile and link your phone.",
            )

        targets: list[dict[str, Any]] = []
        for bid in body.buyer_ids:
            b = db.get(Buyer, bid)
            if not b:
                continue
            c = buyers_module.primary_contact_with_phone(db, bid)
            phone = (c.phone or c.wa_id) if c else None
            if phone:
                targets.append(
                    {
                        "buyer_id": bid,
                        "company_name": b.company_name,
                        "contact_name": c.full_name if c else None,
                        "phone": phone.strip(),
                    }
                )

        for ph in body.phones:
            cleaned = ph.strip()
            if cleaned and not any(t["phone"] == cleaned for t in targets):
                targets.append(
                    {
                        "buyer_id": None,
                        "company_name": "Lead",
                        "contact_name": None,
                        "phone": cleaned,
                    }
                )

        if not targets:
            raise HTTPException(400, "No valid phone numbers found for the selected leads.")

        sent_count = 0
        failed_count = 0
        results: list[dict[str, Any]] = []
        session_id = _session(user)

        for idx, t in enumerate(targets):
            if idx > 0:
                time.sleep(1.0)
            phone = t["phone"]
            try:
                msg_text = body.message
                if t.get("contact_name"):
                    msg_text = msg_text.replace("{{name}}", t["contact_name"]).replace(
                        "{{contact_name}}", t["contact_name"]
                    )
                else:
                    msg_text = msg_text.replace("{{name}}", "Sir/Madam").replace(
                        "{{contact_name}}", "Sir/Madam"
                    )
                if t.get("company_name"):
                    msg_text = msg_text.replace("{{company}}", t["company_name"]).replace(
                        "{{company_name}}", t["company_name"]
                    )
                bridge.send_message(session_id, phone, msg_text)
                sent_count += 1
                results.append({"phone": phone, "status": "sent", "company": t.get("company_name")})
            except Exception as exc:  # noqa: BLE001
                failed_count += 1
                results.append(
                    {
                        "phone": phone,
                        "status": "failed",
                        "error": str(exc),
                        "company": t.get("company_name"),
                    }
                )

        if sent_count > 0:
            activity_module.log_activity(
                db,
                user_id=user.id,
                activity_type="telegram_personal_sent",
                title="Bulk Telegram Mobile sent",
                summary=f"Sent {sent_count} Telegram message(s) via Telegram Mobile",
                quantity=sent_count,
                details={
                    "mode": "telegram_bulk",
                    "channel": "telegram",
                    "sent_count": sent_count,
                    "failed_count": failed_count,
                },
            )

        return {
            "sent_count": sent_count,
            "failed_count": failed_count,
            "skipped_count": 0,
            "results": results,
        }
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Bulk Telegram send failed: {exc}") from exc
