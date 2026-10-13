"""WhatsApp Cloud API — template sync, bulk campaign drafts, and inbound webhook.

Routers are mounted in main.py. See backend/.env.example for Meta Cloud API setup.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from api.deps import get_current_user, get_db, require_admin
from api.schemas import (
    BulkWhatsAppOptInUpdate,
    InteractionRead,
    WhatsAppBuyerPreviewResponse,
    WhatsAppCampaignDraftRequest,
    WhatsAppCampaignDraftResponse,
    WhatsAppConfigRead,
    WhatsAppConversationListResponse,
    WhatsAppConversationRead,
    WhatsAppReplyRequest,
    WhatsAppReplyResponse,
    WhatsAppTemplateCreateRequest,
    WhatsAppTemplateCreateResponse,
    WhatsAppTemplateDeleteResponse,
    WhatsAppTemplateResubmitRequest,
    WhatsAppTemplateNotificationsReadRequest,
    WhatsAppTemplateNotificationsResponse,
    WhatsAppTemplateRead,
    WhatsAppTemplateSyncResponse,
    WhatsAppTestSendRequest,
    WhatsAppTestSendResponse,
)
from config import settings
from db.models import AppUser, Contact, InteractionStatus
from integrations.voice_client import normalize_e164
from integrations.whatsapp_client import whatsapp_client
from modules.audit import log_action
from modules.comms_generator import get_comms

router = APIRouter(prefix="/whatsapp", tags=["whatsapp"])
comms = get_comms()


def _interaction_read(db: Session, interaction) -> InteractionRead:
    return InteractionRead(**comms.interaction_to_dict(db, interaction))


@router.get("/config", response_model=WhatsAppConfigRead)
def get_whatsapp_config():
    missing: list[str] = []
    if not settings.whatsapp_access_token:
        missing.append("WHATSAPP_ACCESS_TOKEN")
    if not settings.whatsapp_phone_number_id:
        missing.append("WHATSAPP_PHONE_NUMBER_ID")
    if not settings.whatsapp_business_account_id:
        missing.append("WHATSAPP_BUSINESS_ACCOUNT_ID")
    if not settings.whatsapp_webhook_verify_token:
        missing.append("WHATSAPP_WEBHOOK_VERIFY_TOKEN")
    if not settings.whatsapp_app_secret:
        missing.append("WHATSAPP_APP_SECRET")
    meta_api_ok: bool | None = None
    meta_api_message: str | None = None
    if settings.whatsapp_access_token and settings.whatsapp_business_account_id:
        access = whatsapp_client.verify_api_access()
        meta_api_ok = bool(access.get("ok"))
        meta_api_message = access.get("message")
    webhook_base = (settings.twilio_webhook_base_url or "").rstrip("/")
    # Prefer an explicit public API base when set for Twilio; same host serves WhatsApp webhooks.
    webhook_callback_url = (
        f"{webhook_base}/api/webhooks/whatsapp" if webhook_base else None
    )
    from modules.comms_generator import (
        _LAST_WEBHOOK_DISPLAY_NUMBER,
        _LAST_WEBHOOK_PHONE_NUMBER_ID,
        whatsapp_phone_number_id_mismatch,
    )

    mismatch = whatsapp_phone_number_id_mismatch()
    return WhatsAppConfigRead(
        configured=whatsapp_client.is_configured,
        webhook_configured=whatsapp_client.webhook_configured,
        phone_number_id_set=bool(settings.whatsapp_phone_number_id),
        business_account_id_set=bool(settings.whatsapp_business_account_id),
        app_secret_set=bool(settings.whatsapp_app_secret),
        display_number=settings.whatsapp_display_number,
        missing_env=missing,
        meta_api_ok=meta_api_ok,
        meta_api_message=meta_api_message,
        webhook_callback_url=webhook_callback_url,
        webhook_verify_token_set=bool(settings.whatsapp_webhook_verify_token),
        ready_for_two_way=bool(
            whatsapp_client.is_configured
            and whatsapp_client.webhook_configured
            and settings.whatsapp_app_secret
            and meta_api_ok is not False
        ),
        cloud_sending_enabled=whatsapp_client.sending_enabled,
        cloud_sending_paused_message=(
            None
            if whatsapp_client.sending_enabled
            else (
                "Meta Cloud WhatsApp SENDS are PAUSED. Templates will not go to Meta "
                "until WHATSAPP_CLOUD_SENDING_ENABLED=true (after Essence WABA billing works). "
                "WhatsApp Mobile / QR is unaffected."
            )
        ),
        phone_number_id_mismatch=mismatch,
        webhook_phone_number_id=_LAST_WEBHOOK_PHONE_NUMBER_ID,
        webhook_display_phone_number=_LAST_WEBHOOK_DISPLAY_NUMBER,
    )


@router.post("/test-send", response_model=WhatsAppTestSendResponse)
def whatsapp_test_send(
    payload: WhatsAppTestSendRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_admin),
):
    """Admin-only smoke test against Meta Cloud API.

    Free-form text only works inside the 24h customer-service window (recipient
    messaged you first). Outside that window, pass an approved ``template_name``
    (e.g. Meta's ``hello_world`` on a fresh WABA).
    """
    to = normalize_e164(payload.phone)
    if not to:
        raise HTTPException(400, f"Invalid phone number: {payload.phone!r}")

    if payload.template_name:
        result = whatsapp_client.send_template(
            phone=to,
            template_name=payload.template_name,
            language=payload.template_language or "en_US",
        )
    else:
        result = whatsapp_client.send_text(phone=to, message=payload.message)
    # If recipient phone matches an existing contact, record an Interaction row
    contact = (
        db.query(Contact)
        .filter(
            (Contact.phone == to) | (Contact.wa_id == to) | (Contact.primary_phone == to)
        )
        .first()
    )
    if contact:
        from db.models import Channel, Direction, HandledBy, Interaction, InteractionStatus
        ok = result.get("status") == "sent"
        ix = Interaction(
            contact_id=contact.id,
            channel=Channel.whatsapp,
            direction=Direction.outbound,
            status=InteractionStatus.sent if ok else InteractionStatus.draft,
            template_name=payload.template_name,
            content=(
                f"[WhatsApp Template: {payload.template_name}]"
                if payload.template_name
                else (payload.message or "")
            ),
            handled_by=HandledBy.human,
            provider_message_id=result.get("provider_message_id"),
            wa_status="sent" if ok else "failed",
            attachments=[
                {
                    "type": "whatsapp_send",
                    "to": to,
                    **(
                        {}
                        if ok
                        else {
                            "last_send_error": result.get("message")
                            or "WhatsApp test send failed"
                        }
                    ),
                }
            ],
        )
        db.add(ix)
        db.commit()

    log_action(
        db,
        entity_type="whatsapp",
        entity_id=0,
        action="test_send",
        actor=user.username,
        details={
            "to": to,
            "status": result.get("status"),
            "template_name": payload.template_name,
            "provider_message_id": result.get("provider_message_id"),
            "contact_id": contact.id if contact else None,
        },
    )
    return WhatsAppTestSendResponse(
        status=str(result.get("status") or "error"),
        message=str(result.get("message") or ""),
        to=to,
        provider_message_id=result.get("provider_message_id"),
    )


@router.get("/templates", response_model=list[WhatsAppTemplateRead])
def list_whatsapp_templates(
    approved_only: bool = False,
    db: Session = Depends(get_db),
):
    from modules import whatsapp_templates as templates_module

    rows = templates_module.list_templates(db, approved_only=approved_only)
    return [WhatsAppTemplateRead(**templates_module.template_to_dict(r)) for r in rows]


@router.post("/templates", response_model=WhatsAppTemplateCreateResponse, status_code=201)
def create_whatsapp_template(
    payload: WhatsAppTemplateCreateRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    """Submit a new WhatsApp template to Meta for review."""
    from modules import whatsapp_templates as templates_module

    try:
        result = templates_module.create_template_for_meta(
            db,
            user_id=user.id,
            name=payload.name,
            category=payload.category,
            language=payload.language,
            body=payload.body,
            footer=payload.footer,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    log_action(
        db,
        entity_type="whatsapp_template",
        entity_id=result["template"]["id"],
        action="submitted",
        actor=user.username,
        details={
            "name": result["template"]["name"],
            "meta_status": result.get("meta_status"),
        },
    )
    return WhatsAppTemplateCreateResponse(**result)


@router.put("/templates/{template_id}", response_model=WhatsAppTemplateCreateResponse)
def resubmit_whatsapp_template(
    template_id: int,
    payload: WhatsAppTemplateResubmitRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    """Edit a rejected/paused/disabled template and resubmit to Meta for review."""
    from modules import whatsapp_templates as templates_module

    try:
        result = templates_module.resubmit_template_for_meta(
            db,
            template_id=template_id,
            user_id=user.id,
            body=payload.body,
            footer=payload.footer,
            category=payload.category,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    log_action(
        db,
        entity_type="whatsapp_template",
        entity_id=result["template"]["id"],
        action="resubmitted",
        actor=user.username,
        details={
            "name": result["template"]["name"],
            "meta_status": result.get("meta_status"),
        },
    )
    return WhatsAppTemplateCreateResponse(**result)


@router.delete("/templates/{template_id}", response_model=WhatsAppTemplateDeleteResponse)
def delete_whatsapp_template(
    template_id: int,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    """Delete a WhatsApp template from Meta and the local list."""
    from modules import whatsapp_templates as templates_module

    try:
        result = templates_module.delete_template_from_meta(db, template_id=template_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    log_action(
        db,
        entity_type="whatsapp_template",
        entity_id=template_id,
        action="deleted",
        actor=user.username,
        details={"message": result.get("message")},
    )
    return WhatsAppTemplateDeleteResponse(**result)


@router.get("/templates/notifications", response_model=WhatsAppTemplateNotificationsResponse)
def list_whatsapp_template_notifications(
    unread_only: bool = True,
    limit: int = 50,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    from modules import whatsapp_templates as templates_module

    return WhatsAppTemplateNotificationsResponse(
        **templates_module.list_template_notifications(
            db, user_id=user.id, unread_only=unread_only, limit=limit
        )
    )


@router.post("/templates/notifications/read")
def mark_whatsapp_template_notifications_read(
    payload: WhatsAppTemplateNotificationsReadRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    from modules import whatsapp_templates as templates_module

    updated = templates_module.mark_template_notifications_read(
        db,
        user_id=user.id,
        notification_ids=payload.notification_ids,
    )
    return {"updated_count": updated}


@router.post("/templates/sync", response_model=WhatsAppTemplateSyncResponse)
def sync_whatsapp_templates(
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    from modules import whatsapp_templates as templates_module

    result = templates_module.sync_templates_from_meta(db)
    log_action(
        db,
        entity_type="whatsapp_template",
        entity_id=0,
        action="synced",
        actor=user.username,
        details=result,
    )
    return WhatsAppTemplateSyncResponse(**result)


@router.post("/campaign-drafts", response_model=WhatsAppCampaignDraftResponse)
def create_whatsapp_campaign_drafts(
    payload: WhatsAppCampaignDraftRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    from modules import activity as activity_module

    try:
        result = comms.create_whatsapp_campaign_drafts(
            db,
            buyer_ids=payload.buyer_ids,
            template_id=payload.template_id,
            template_variables=payload.template_variables,
            require_opt_in=payload.require_opt_in,
            # Bulk WhatsApp always sends immediately — no approval queue.
            send=True,
            user_id=user.id,
            to_phone=payload.to_phone,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    log_action(
        db,
        entity_type="interaction",
        entity_id=0,
        action="whatsapp_bulk_sent",
        actor=user.username,
        details={
            "template_id": payload.template_id,
            "created_count": result["created_count"],
            "skipped_count": result["skipped_count"],
            "sent_count": result.get("sent_count", 0),
            "failed_count": result.get("failed_count", 0),
            "send": True,
        },
    )
    sent_count = int(result.get("sent_count") or 0)
    if sent_count > 0:
        activity_module.log_activity(
            db,
            user_id=user.id,
            activity_type=activity_module.BULK_WHATSAPP_SENT,
            title="Bulk WhatsApp messages sent",
            summary=(
                f"Sent {sent_count} WhatsApp message{'s' if sent_count != 1 else ''} "
                f"(template #{payload.template_id})"
            ),
            quantity=sent_count,
            entity_type="whatsapp_template",
            entity_id=payload.template_id,
            details={"mode": "template", "channel": "whatsapp", "sent_count": sent_count},
        )
    return WhatsAppCampaignDraftResponse(**result)


@router.patch("/contacts/bulk-opt-in")
def bulk_update_whatsapp_opt_in(
    payload: BulkWhatsAppOptInUpdate,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    from modules.compliance import bulk_update_whatsapp_opt_in as bulk_update

    updated = bulk_update(db, payload.contact_ids, payload.opt_in)
    log_action(
        db,
        entity_type="contact",
        entity_id=0,
        action="bulk_whatsapp_opt_in_update",
        actor=user.username,
        details={"count": updated, "opt_in": payload.opt_in},
    )
    return {"updated_count": updated}


@router.get("/buyers/{buyer_id}/preview", response_model=WhatsAppBuyerPreviewResponse)
def whatsapp_buyer_preview(
    buyer_id: int,
    recent: int = Query(3, ge=1, le=10),
    db: Session = Depends(get_db),
    _user: AppUser = Depends(get_current_user),
):
    """Last few WhatsApp messages for a buyer profile (opens inbox via contact_id)."""
    preview = comms.get_whatsapp_buyer_preview(db, buyer_id=buyer_id, recent=recent)
    return WhatsAppBuyerPreviewResponse(
        buyer_id=preview["buyer_id"],
        contact_id=preview["contact_id"],
        contact_name=preview["contact_name"],
        contact_phone=preview["contact_phone"],
        within_session_window=preview["within_session_window"],
        total_messages=preview["total_messages"],
        messages=[_interaction_read(db, row) for row in preview["messages"]],
    )


@router.get("/conversations", response_model=WhatsAppConversationListResponse)
def list_whatsapp_conversations(
    page: int | str = 1,
    page_size: int | str = 20,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    """Company-wide Meta Cloud inbox — same threads for every Sales Agent user.

    Unlike Baileys QR (personal WhatsApp Mobile), there is one WhatsApp Business
    number. Do not filter by lead assignee or viewer; Khalid, Asim, and all reps
    must see the identical conversation list and status.
    """
    _ = user
    try:
        page_val = int(page) if page is not None else 1
    except (ValueError, TypeError):
        page_val = 1
    try:
        page_size_val = int(page_size) if page_size is not None else 20
    except (ValueError, TypeError):
        page_size_val = 20

    try:
        rows, total = comms.list_whatsapp_conversations(
            db,
            assigned_to_user_id=None,
            page=page_val,
            page_size=page_size_val,
        )
    except Exception as exc:  # noqa: BLE001
        import logging

        logging.getLogger(__name__).exception(
            "WhatsApp Cloud conversations list failed: %s", exc
        )
        raise HTTPException(
            503,
            "WhatsApp Meta inbox temporarily unavailable. Retry in a moment.",
        ) from exc
    page_val = max(1, page_val)
    page_size_val = min(max(1, page_size_val), 100)
    total_pages = max(1, (total + page_size_val - 1) // page_size_val)
    return WhatsAppConversationListResponse(
        total=total,
        page=page_val,
        page_size=page_size_val,
        total_pages=total_pages,
        rows=[WhatsAppConversationRead(**row) for row in rows],
    )


@router.get("/conversations/{contact_id}/messages", response_model=list[InteractionRead])
def list_whatsapp_conversation_messages(contact_id: str, db: Session = Depends(get_db)):
    try:
        cid = int(contact_id)
    except (ValueError, TypeError):
        return []
    try:
        rows = comms.list_whatsapp_messages(db, contact_id=cid)
    except Exception as exc:  # noqa: BLE001
        import logging

        logging.getLogger(__name__).exception(
            "WhatsApp Cloud thread messages failed for contact %s: %s", contact_id, exc
        )
        rows = []
    return [_interaction_read(db, row) for row in rows]


@router.post("/conversations/{contact_id}/reply", response_model=WhatsAppReplyResponse)
def reply_to_whatsapp_conversation(
    contact_id: int,
    payload: WhatsAppReplyRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    try:
        draft = comms.create_manual_whatsapp_draft(
            db, contact_id=contact_id, content=payload.content
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    send_result = None
    if payload.send:
        try:
            draft, send_result = comms.approve_draft(
                db,
                draft.id,
                approved_by=user.username,
                send=True,
                template_name=payload.template_name,
                template_language=payload.template_language or "en_US",
                template_variables=payload.template_variables or None,
                user_id=user.id,
                force_phone=(payload.to_phone or "").strip() or None,
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    log_action(
        db,
        entity_type="interaction",
        entity_id=draft.id,
        action="whatsapp_reply_sent" if draft.status == InteractionStatus.sent else "whatsapp_reply_drafted",
        actor=user.username,
        details={"contact_id": contact_id, "send": payload.send},
    )

    if draft.status == InteractionStatus.sent and payload.send:
        from modules import activity as activity_module

        activity_module.log_activity(
            db,
            user_id=user.id,
            activity_type=activity_module.PERSONAL_WHATSAPP_SENT,
            title="Personal WhatsApp sent",
            summary=f"Sent WhatsApp reply (interaction #{draft.id})",
            quantity=1,
            entity_type="interaction",
            entity_id=draft.id,
            details={"mode": "reply", "channel": "whatsapp", "contact_id": contact_id},
        )

    send_message = (send_result or {}).get("message")
    needs_template = bool(
        payload.send
        and draft.status != InteractionStatus.sent
        and send_message
        and any(
            token in (send_message or "").lower()
            for token in ("template", "24h", "24 hour", "re-engagement", "window")
        )
    )
    return WhatsAppReplyResponse(
        interaction=_interaction_read(db, draft),
        sent=draft.status == InteractionStatus.sent,
        send_status=(send_result or {}).get("status"),
        send_message=send_message,
        needs_template=needs_template,
    )


webhooks_router = APIRouter(prefix="/webhooks/whatsapp", tags=["whatsapp-webhooks"])


@webhooks_router.get("")
async def verify_whatsapp_webhook(request: Request):
    """Meta's one-time handshake when you subscribe the webhook URL."""
    from fastapi.responses import PlainTextResponse

    mode = request.query_params.get("hub.mode")
    token = request.query_params.get("hub.verify_token")
    challenge = request.query_params.get("hub.challenge") or ""

    if mode == "subscribe" and token and token == settings.whatsapp_webhook_verify_token:
        return PlainTextResponse(challenge)
    raise HTTPException(403, "Webhook verification failed")


def _inbound_message_text(message: dict) -> str:
    """Normalize Meta inbound message types into display text for the inbox."""
    msg_type = (message.get("type") or "text").lower()
    if msg_type == "text":
        return ((message.get("text") or {}).get("body") or "").strip()
    if msg_type == "button":
        return ((message.get("button") or {}).get("text") or "[button]").strip()
    if msg_type == "interactive":
        interactive = message.get("interactive") or {}
        reply = interactive.get("button_reply") or interactive.get("list_reply") or {}
        return (reply.get("title") or reply.get("id") or "[interactive reply]").strip()
    if msg_type == "image":
        caption = ((message.get("image") or {}).get("caption") or "").strip()
        return caption or "[image]"
    if msg_type == "audio":
        return "[audio]"
    if msg_type == "video":
        caption = ((message.get("video") or {}).get("caption") or "").strip()
        return caption or "[video]"
    if msg_type == "document":
        filename = ((message.get("document") or {}).get("filename") or "").strip()
        return f"[document{': ' + filename if filename else ''}]"
    if msg_type == "sticker":
        return "[sticker]"
    if msg_type == "location":
        loc = message.get("location") or {}
        name = (loc.get("name") or loc.get("address") or "").strip()
        return f"[location{': ' + name if name else ''}]"
    if msg_type == "contacts":
        return "[contact card]"
    if msg_type == "reaction":
        emoji = ((message.get("reaction") or {}).get("emoji") or "").strip()
        return f"[reaction{': ' + emoji if emoji else ''}]"
    return f"[{msg_type}]"


@webhooks_router.post("")
async def receive_whatsapp_webhook(request: Request, db: Session = Depends(get_db)):
    body = await request.body()
    signature = request.headers.get("X-Hub-Signature-256")
    if settings.whatsapp_app_secret and not whatsapp_client.verify_webhook_signature(
        payload=body, signature_header=signature
    ):
        raise HTTPException(403, "Invalid webhook signature")

    import json

    payload = json.loads(body.decode("utf-8") or "{}")
    for entry in payload.get("entry", []):
        for change in entry.get("changes", []):
            field = change.get("field")
            value = change.get("value", {})

            if field == "message_template_status_update":
                try:
                    from modules import whatsapp_templates as templates_module

                    templates_module.handle_template_status_webhook(db, value)
                except Exception:  # noqa: BLE001
                    pass
                continue

            # Profile names from Meta (parallel array to messages).
            profiles: dict[str, str] = {}
            for item in value.get("contacts") or []:
                wa = str(item.get("wa_id") or "").strip()
                name = ((item.get("profile") or {}).get("name") or "").strip()
                if wa and name:
                    profiles[wa] = name

            metadata = value.get("metadata") or {}
            if isinstance(metadata, dict):
                from modules.comms_generator import note_whatsapp_webhook_metadata

                note_whatsapp_webhook_metadata(
                    phone_number_id=str(metadata.get("phone_number_id") or "").strip()
                    or None,
                    display_phone_number=str(
                        metadata.get("display_phone_number") or ""
                    ).strip()
                    or None,
                )

            for message in value.get("messages", []):
                wa_id = str(message.get("from") or "").strip()
                if not wa_id:
                    continue
                text = _inbound_message_text(message)
                if not text:
                    continue
                provider_message_id = message.get("id")
                interaction = comms.record_inbound_whatsapp_message(
                    db,
                    wa_id=wa_id,
                    message_text=text,
                    provider_message_id=provider_message_id,
                    profile_name=profiles.get(wa_id),
                    create_reply_draft=False,
                    meta_timestamp=message.get("timestamp"),
                )
                if provider_message_id:
                    try:
                        whatsapp_client.mark_read(provider_message_id)
                    except Exception:  # noqa: BLE001
                        pass
                # AI Mode after-hours auto-reply (when enabled for assignee / any user).
                try:
                    from modules import ai_mode as ai_mode_module
                    from db.models import Contact

                    contact = None
                    if interaction is not None:
                        contact = db.get(Contact, interaction.contact_id)
                    if contact is None:
                        contact = comms._find_whatsapp_contact(db, wa_id)
                    if contact:
                        ai_mode_module.maybe_auto_reply_whatsapp(
                            db,
                            contact=contact,
                            message_text=text,
                            provider_message_id=provider_message_id,
                        )
                except Exception:  # noqa: BLE001
                    pass

            for status_update in value.get("statuses", []):
                message_id = status_update.get("id")
                status = status_update.get("status")
                if message_id and status:
                    err_text = None
                    errors = status_update.get("errors") or []
                    if errors and isinstance(errors, list):
                        first = errors[0] if isinstance(errors[0], dict) else {}
                        err_data = first.get("error_data") if isinstance(first, dict) else None
                        details = (
                            err_data.get("details")
                            if isinstance(err_data, dict)
                            else None
                        )
                        err_text = (
                            (first.get("title") if isinstance(first, dict) else None)
                            or (first.get("message") if isinstance(first, dict) else None)
                            or details
                        )
                    comms.update_whatsapp_message_status(
                        db,
                        provider_message_id=message_id,
                        status=status,
                        error_message=err_text,
                    )

    return {"status": "ok"}
