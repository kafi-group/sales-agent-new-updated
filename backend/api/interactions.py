from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from api.deps import get_current_user, get_db
from api.schemas import (
    BulkApproveRequest,
    BulkApproveResponse,
    BulkEmailDraftRequest,
    BulkEmailDraftResponse,
    BulkEmailOverlapCheckRequest,
    BulkEmailOverlapCheckResponse,
    BulkEmailSettingsRead,
    BulkManualEmailDraftRequest,
    DraftListResponse,
    EmailDraftRequest,
    InteractionApprove,
    InteractionApproveResponse,
    InteractionAttachmentsUpdate,
    InteractionRead,
    ManualEmailDraftRequest,
    ManualEmailSendResponse,
)
from config import settings
from db.models import AppUser, Channel, InteractionStatus
from modules import activity as activity_module
from modules import bulk_email_guard
from modules.audit import log_action
from modules.comms_generator import get_comms

router = APIRouter(prefix="/interactions", tags=["interactions"])
comms = get_comms()


def _require_no_bulk_overlap(
    user: AppUser,
    buyer_ids: list[int],
    *,
    confirm_overlap: bool,
) -> None:
    if confirm_overlap:
        return
    overlap = bulk_email_guard.find_overlap(user.id, buyer_ids)
    if overlap:
        raise HTTPException(status_code=409, detail=overlap["message"])


def _interaction_read(db: Session, interaction) -> InteractionRead:
    return InteractionRead(**comms.interaction_to_dict(db, interaction))


@router.get("/drafts", response_model=DraftListResponse)
def list_draft_interactions(
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
):
    drafts, total = comms.list_drafts(db, page=page, page_size=page_size)
    page = max(1, page)
    page_size = min(max(1, page_size), 100)
    total_pages = max(1, (total + page_size - 1) // page_size)
    return DraftListResponse(
        total=total,
        page=page,
        page_size=page_size,
        total_pages=total_pages,
        rows=[_interaction_read(db, draft) for draft in drafts],
    )


@router.get("", response_model=list[InteractionRead])
def list_interactions(db: Session = Depends(get_db)):
    rows = comms.list_interactions(db)
    return [_interaction_read(db, row) for row in rows]


@router.post("/email-draft", response_model=InteractionRead, status_code=201)
def create_email_draft(payload: EmailDraftRequest, db: Session = Depends(get_db)):
    try:
        draft = comms.generate_email_draft(
            db,
            contact_id=payload.contact_id,
            goal=payload.goal,
            product_name=payload.product_name,
            attachments=[a.model_dump() for a in payload.attachments],
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return _interaction_read(db, draft)


@router.post("/manual-email-draft", response_model=ManualEmailSendResponse, status_code=201)
def create_manual_email_draft(
    payload: ManualEmailDraftRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    try:
        draft = comms.create_manual_email_draft(
            db,
            buyer_id=payload.buyer_id,
            subject=payload.subject,
            body=payload.body,
            contact_id=payload.contact_id,
            attachments=[a.model_dump() for a in payload.attachments],
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
                mailbox_user=user,
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    log_action(
        db,
        entity_type="interaction",
        entity_id=draft.id,
        action="manual_email_sent" if payload.send else "manual_email_draft_created",
        details={
            "buyer_id": payload.buyer_id,
            "contact_id": draft.contact_id,
            "send": payload.send,
            "send_status": (send_result or {}).get("status"),
        },
    )
    if (send_result or {}).get("status") == "sent":
        activity_module.log_activity(
            db,
            user_id=user.id,
            activity_type=activity_module.PERSONAL_EMAILS_SENT,
            title="Personal email sent",
            summary=f"Sent personal email (manual draft #{draft.id})",
            quantity=1,
            entity_type="interaction",
            entity_id=draft.id,
            details={"mode": "manual", "buyer_id": payload.buyer_id},
        )
    return ManualEmailSendResponse(
        interaction=_interaction_read(db, draft),
        sent=(send_result or {}).get("status") == "sent",
        send_status=(send_result or {}).get("status"),
        send_message=(send_result or {}).get("message"),
    )


@router.get("/bulk-email-settings", response_model=BulkEmailSettingsRead)
def get_bulk_email_settings():
    return BulkEmailSettingsRead(
        batch_size=settings.bulk_email_batch_size,
        message_delay_seconds=settings.bulk_email_message_delay_seconds,
        batch_pause_seconds=settings.bulk_email_batch_pause_seconds,
        max_per_request=settings.bulk_email_max_per_request,
        gmail_daily_limit_hint=300,
        recommendation=(
            "Current settings: 50 per batch, 3s between emails, 60s between batches. "
            "Keep daily cold outreach under 100–200 emails per Outlook mailbox."
        ),
    )


@router.post("/bulk-email-overlap-check", response_model=BulkEmailOverlapCheckResponse)
def check_bulk_email_overlap(
    payload: BulkEmailOverlapCheckRequest,
    user: AppUser = Depends(get_current_user),
):
    """Warn if the same clients were already bulk-emailed within the last 30 minutes."""
    overlap = bulk_email_guard.find_overlap(user.id, payload.buyer_ids)
    if not overlap:
        return BulkEmailOverlapCheckResponse(has_overlap=False)
    return BulkEmailOverlapCheckResponse(**overlap)


@router.post("/bulk-manual-email-drafts", response_model=BulkEmailDraftResponse, status_code=201)
def create_bulk_manual_email_drafts(
    payload: BulkManualEmailDraftRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    from modules import activity as activity_module

    _require_no_bulk_overlap(
        user, payload.buyer_ids, confirm_overlap=payload.confirm_overlap
    )
    run_id = bulk_email_guard.begin_run(user.id, payload.buyer_ids)
    try:
        try:
            result = comms.create_bulk_manual_drafts(
                db,
                buyer_ids=payload.buyer_ids,
                subject=payload.subject,
                body=payload.body,
                attachments=[a.model_dump() for a in payload.attachments],
                # Bulk compose always sends immediately — no approval queue.
                send=True,
                mailbox_user=user,
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
    finally:
        bulk_email_guard.finish_run(run_id)

    log_action(
        db,
        entity_type="interaction",
        entity_id=0,
        action="bulk_emails_sent",
        actor=user.username,
        details={
            "mode": "manual",
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
            activity_type=activity_module.BULK_EMAILS_SENT,
            title="Bulk emails sent",
            summary=f"Sent {sent_count} bulk email{'s' if sent_count != 1 else ''} (manual)",
            quantity=sent_count,
            entity_type="interaction",
            entity_id=None,
            details={"mode": "manual", "sent_count": sent_count},
        )
    return BulkEmailDraftResponse(**result)


@router.post("/bulk-email-drafts", response_model=BulkEmailDraftResponse, status_code=201)
def create_bulk_email_drafts(
    payload: BulkEmailDraftRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    from modules import activity as activity_module

    _require_no_bulk_overlap(
        user, payload.buyer_ids, confirm_overlap=payload.confirm_overlap
    )
    run_id = bulk_email_guard.begin_run(user.id, payload.buyer_ids)
    try:
        result = comms.create_bulk_drafts_from_template(
            db,
            buyer_ids=payload.buyer_ids,
            template_id=payload.template_id,
            extra_attachments=[a.model_dump() for a in payload.attachments],
            # Bulk compose always sends immediately — no approval queue.
            send=True,
            mailbox_user=user,
        )
    finally:
        bulk_email_guard.finish_run(run_id)
    log_action(
        db,
        entity_type="interaction",
        entity_id=0,
        action="bulk_emails_sent",
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
            activity_type=activity_module.BULK_EMAILS_SENT,
            title="Bulk emails sent",
            summary=(
                f"Sent {sent_count} bulk email{'s' if sent_count != 1 else ''} "
                f"(template #{payload.template_id})"
            ),
            quantity=sent_count,
            entity_type="email_template",
            entity_id=payload.template_id,
            details={"mode": "template", "sent_count": sent_count},
        )
    return BulkEmailDraftResponse(**result)


@router.post("/bulk-approve", response_model=BulkApproveResponse)
def bulk_approve_interactions(
    payload: BulkApproveRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    from modules import activity as activity_module

    if len(payload.interaction_ids) > settings.bulk_email_max_per_request:
        raise HTTPException(
            400,
            f"Maximum {settings.bulk_email_max_per_request} emails per batch. "
            f"Split into smaller batches — the dashboard does this automatically.",
        )
    result = comms.bulk_approve_drafts(
        db,
        payload.interaction_ids,
        approved_by=payload.approved_by or user.username,
        send=payload.send,
        mailbox_user=user,
    )
    log_action(
        db,
        entity_type="interaction",
        entity_id=0,
        action="bulk_approved",
        actor=user.username,
        details={
            "send": payload.send,
            "sent_count": result["sent_count"],
            "failed_count": result["failed_count"],
        },
    )
    if payload.send:
        sent_count = int(result.get("sent_count") or 0)
        if sent_count > 0:
            activity_module.log_activity(
                db,
                user_id=user.id,
                activity_type=activity_module.BULK_EMAILS_SENT,
                title="Bulk emails sent",
                summary=f"Approved and sent {sent_count} email{'s' if sent_count != 1 else ''}",
                quantity=sent_count,
                entity_type="interaction",
                entity_id=None,
                details={"mode": "bulk_approve", "sent_count": sent_count},
            )
    return BulkApproveResponse(**result)


@router.post("/{interaction_id}/approve", response_model=InteractionApproveResponse)
def approve_interaction(
    interaction_id: int,
    payload: InteractionApprove,
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
):
    try:
        approved, send_result = comms.approve_draft(
            db,
            interaction_id,
            content=payload.content,
            approved_by=payload.approved_by or user.username,
            send=payload.send,
            template_name=payload.template_name,
            template_language=payload.template_language,
            template_variables=payload.template_variables or None,
            mailbox_user=user,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    log_action(
        db,
        entity_type="interaction",
        entity_id=approved.id,
        action="approved",
        actor=payload.approved_by,
    )

    sent = approved.status == InteractionStatus.sent
    send_status = send_result.get("status") if send_result else None
    send_message = send_result.get("message") if send_result else None

    if sent:
        log_action(
            db,
            entity_type="interaction",
            entity_id=approved.id,
            action="sent",
            actor=payload.approved_by,
            details=send_result,
        )
        # Single email approve/send counts as personal for KPI (bulk uses bulk endpoints).
        channel = (
            approved.channel.value
            if isinstance(approved.channel, Channel)
            else str(approved.channel)
        )
        if payload.send and channel == Channel.email.value:
            activity_module.log_activity(
                db,
                user_id=user.id,
                activity_type=activity_module.PERSONAL_EMAILS_SENT,
                title="Personal email sent",
                summary=f"Approved and sent email (interaction #{approved.id})",
                quantity=1,
                entity_type="interaction",
                entity_id=approved.id,
                details={"mode": "approve", "channel": channel},
            )
        elif payload.send and channel == Channel.whatsapp.value:
            activity_module.log_activity(
                db,
                user_id=user.id,
                activity_type=activity_module.PERSONAL_WHATSAPP_SENT,
                title="Personal WhatsApp sent",
                summary=f"Approved and sent WhatsApp (interaction #{approved.id})",
                quantity=1,
                entity_type="interaction",
                entity_id=approved.id,
                details={"mode": "approve", "channel": channel},
            )
    elif send_result and payload.send:
        log_action(
            db,
            entity_type="interaction",
            entity_id=approved.id,
            action="send_failed",
            actor=payload.approved_by,
            details=send_result,
        )

    return InteractionApproveResponse(
        interaction=_interaction_read(db, approved),
        sent=sent,
        send_status=send_status,
        send_message=send_message,
    )


@router.patch("/{interaction_id}/attachments", response_model=InteractionRead)
def update_draft_attachments(
    interaction_id: int,
    payload: InteractionAttachmentsUpdate,
    db: Session = Depends(get_db),
):
    try:
        draft = comms.update_draft_attachments(
            db,
            interaction_id,
            [a.model_dump() for a in payload.attachments],
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return _interaction_read(db, draft)


@router.post("/{interaction_id}/reject", response_model=InteractionRead)
def reject_interaction(interaction_id: int, db: Session = Depends(get_db)):
    try:
        rejected = comms.reject_draft(db, interaction_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    log_action(db, entity_type="interaction", entity_id=rejected.id, action="rejected")
    return _interaction_read(db, rejected)
