"""Sync, submit, and track WhatsApp message templates on the Meta WABA."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from db.models import (
    AppUser,
    AppUserRole,
    WhatsAppTemplate,
    WhatsAppTemplateStatus,
    WhatsAppTemplateStatusEvent,
)
from integrations.whatsapp_client import whatsapp_client

_STATUS_MAP = {
    "approved": WhatsAppTemplateStatus.approved,
    "pending": WhatsAppTemplateStatus.pending,
    "rejected": WhatsAppTemplateStatus.rejected,
    "paused": WhatsAppTemplateStatus.paused,
    "disabled": WhatsAppTemplateStatus.disabled,
}

_ALLOWED_CATEGORIES = frozenset({"MARKETING", "UTILITY", "AUTHENTICATION"})
_TEMPLATE_NAME_RE = re.compile(r"^[a-z0-9_]{1,512}$")
_BODY_VARIABLE_RE = re.compile(r"\{\{\s*(\d+)\s*\}\}")
_NAMED_VARIABLE_RE = re.compile(r"\{\{\s*([a-z][a-z0-9_]*)\s*\}\}", re.IGNORECASE)
_MEDIA_HEADER_FORMATS = frozenset({"IMAGE", "VIDEO", "DOCUMENT"})


def normalize_template_name(raw: str) -> str:
    """Meta requires lowercase letters, numbers, and underscores only."""
    cleaned = re.sub(r"[^a-z0-9_]+", "_", (raw or "").strip().lower())
    cleaned = re.sub(r"_+", "_", cleaned).strip("_")
    return (cleaned or "kafi_template")[:512]


def _positional_variable_count(text: str | None) -> int:
    """Meta body params are 1..N by highest index — not occurrence count.

    ``Hi {{1}}, welcome {{1}}`` still needs exactly 1 parameter.
    """
    if not text:
        return 0
    indexes = [int(match) for match in _BODY_VARIABLE_RE.findall(text)]
    return max(indexes) if indexes else 0


def _named_variables(text: str | None) -> list[str]:
    if not text:
        return []
    seen: list[str] = []
    for match in _NAMED_VARIABLE_RE.findall(text):
        name = str(match).strip().lower()
        if name and name not in seen and not name.isdigit():
            seen.append(name)
    return seen


def _extract_body_and_variables(components: list[dict[str, Any]]) -> tuple[str | None, int]:
    body_text = None
    variable_count = 0
    for component in components or []:
        if (component.get("type") or "").upper() == "BODY":
            body_text = component.get("text")
            if body_text:
                named = _named_variables(body_text)
                variable_count = len(named) if named else _positional_variable_count(body_text)
            break
    return body_text, variable_count


def _sanitize_template_text(value: str | None, *, fallback: str = "-") -> str:
    """Meta rejects blank / multiline body params (error 132012 / 132018)."""
    text = re.sub(r"[\r\n\t]+", " ", str(value or "")).strip()
    text = re.sub(r"\s{2,}", " ", text)
    if not text:
        text = fallback
    return text[:1024]


def _header_example_media_link(component: dict[str, Any]) -> str | None:
    example = component.get("example") or {}
    for key in ("header_handle", "header_url", "header_urls"):
        raw = example.get(key)
        if isinstance(raw, list) and raw:
            link = str(raw[0] or "").strip()
            if link.startswith("http"):
                return link
        if isinstance(raw, str) and raw.strip().startswith("http"):
            return raw.strip()
    for key in ("link", "url"):
        link = str(component.get(key) or "").strip()
        if link.startswith("http"):
            return link
    return None


def _find_component(components: list[dict[str, Any]] | None, type_name: str) -> dict[str, Any] | None:
    wanted = type_name.upper()
    for component in components or []:
        if (component.get("type") or "").upper() == wanted:
            return component
    return None


def _validate_body(body: str) -> None:
    text = (body or "").strip()
    if not text:
        raise ValueError("Template body is required")
    if len(text) > 1024:
        raise ValueError("Template body must be 1024 characters or fewer")
    if text.startswith("{{") or text.endswith("}}"):
        raise ValueError("Template body cannot start or end with a variable placeholder")


def build_components(*, body: str, footer: str | None = None) -> list[dict[str, Any]]:
    _validate_body(body)
    components: list[dict[str, Any]] = [{"type": "BODY", "text": body.strip()}]
    footer_text = (footer or "").strip()
    if footer_text:
        if len(footer_text) > 60:
            raise ValueError("Footer must be 60 characters or fewer")
        components.append({"type": "FOOTER", "text": footer_text})
    return components


def _upsert_template_from_meta(
    db: Session,
    raw: dict[str, Any],
    *,
    submitted_by_user_id: int | None = None,
) -> WhatsAppTemplate:
    meta_id = raw.get("id")
    name = raw.get("name")
    if not name:
        raise ValueError("Meta template payload missing name")

    components = raw.get("components") or []
    body_text, variable_count = _extract_body_and_variables(components)
    status = _STATUS_MAP.get((raw.get("status") or "").lower(), WhatsAppTemplateStatus.pending)

    record = None
    if meta_id:
        record = db.query(WhatsAppTemplate).filter_by(meta_template_id=str(meta_id)).first()
    if not record:
        record = (
            db.query(WhatsAppTemplate)
            .filter_by(name=name, language=raw.get("language") or "en")
            .first()
        )

    if not record:
        record = WhatsAppTemplate(meta_template_id=str(meta_id) if meta_id else None, name=name)
        db.add(record)
        if submitted_by_user_id is not None:
            record.submitted_by_user_id = submitted_by_user_id
    elif submitted_by_user_id is not None and record.submitted_by_user_id is None:
        record.submitted_by_user_id = submitted_by_user_id

    record.meta_template_id = str(meta_id) if meta_id else record.meta_template_id
    record.name = name
    record.category = raw.get("category")
    record.language = raw.get("language") or record.language or "en"
    record.status = status
    record.components = components
    record.body_text = body_text
    record.variable_count = variable_count
    record.synced_at = datetime.now(timezone.utc)
    return record


def _notify_users(
    db: Session,
    *,
    template: WhatsAppTemplate,
    event_type: str,
    message: str,
    user_ids: set[int],
) -> None:
    for uid in sorted(user_ids):
        if uid <= 0:
            continue
        db.add(
            WhatsAppTemplateStatusEvent(
                template_id=template.id,
                user_id=uid,
                event_type=event_type,
                message=message[:500],
            )
        )


def _admin_user_ids(db: Session) -> set[int]:
    rows = (
        db.query(AppUser.id)
        .filter(AppUser.role == AppUserRole.admin, AppUser.is_active.is_(True))
        .all()
    )
    return {int(row[0]) for row in rows}


def _notification_targets(db: Session, template: WhatsAppTemplate) -> set[int]:
    targets = _admin_user_ids(db)
    if template.submitted_by_user_id:
        targets.add(int(template.submitted_by_user_id))
    return targets


def sync_templates_from_meta(db: Session) -> dict[str, Any]:
    result = whatsapp_client.list_templates()
    if result.get("status") != "ok":
        return {
            "status": result.get("status", "error"),
            "message": result.get("message", "Template sync failed"),
            "synced_count": 0,
        }

    synced = 0
    for raw in result.get("templates") or []:
        _upsert_template_from_meta(db, raw)
        synced += 1

    db.commit()
    return {"status": "ok", "message": f"Synced {synced} template(s)", "synced_count": synced}


def create_template_for_meta(
    db: Session,
    *,
    user_id: int,
    name: str,
    category: str,
    language: str,
    body: str,
    footer: str | None = None,
) -> dict[str, Any]:
    """Create a template locally and submit it to Meta for review."""
    normalized_name = normalize_template_name(name)
    if not _TEMPLATE_NAME_RE.match(normalized_name):
        raise ValueError(
            "Template name must use lowercase letters, numbers, and underscores only "
            "(e.g. kafi_product_intro)."
        )

    category_key = (category or "UTILITY").strip().upper()
    if category_key not in _ALLOWED_CATEGORIES:
        raise ValueError("Category must be MARKETING, UTILITY, or AUTHENTICATION")

    language_code = (language or "en_US").strip() or "en_US"
    components = build_components(body=body, footer=footer)

    existing = (
        db.query(WhatsAppTemplate)
        .filter_by(name=normalized_name, language=language_code)
        .first()
    )
    if existing and existing.status in {
        WhatsAppTemplateStatus.approved,
        WhatsAppTemplateStatus.pending,
    }:
        raise ValueError(
            f"A template named '{normalized_name}' ({language_code}) already exists with "
            f"status '{existing.status.value}'."
        )

    submit_result = whatsapp_client.create_message_template(
        name=normalized_name,
        language=language_code,
        category=category_key,
        components=components,
    )
    if submit_result.get("status") != "submitted":
        raise ValueError(submit_result.get("message") or "Meta template submission failed")

    body_text, variable_count = _extract_body_and_variables(components)
    record = existing or WhatsAppTemplate(name=normalized_name, language=language_code)
    if not existing:
        db.add(record)

    record.meta_template_id = submit_result.get("meta_template_id") or record.meta_template_id
    record.category = category_key
    record.status = WhatsAppTemplateStatus.pending
    record.components = components
    record.body_text = body_text
    record.variable_count = variable_count
    record.submitted_by_user_id = user_id
    record.rejection_reason = None
    record.synced_at = datetime.now(timezone.utc)
    db.flush()

    message = (
        f"Template '{normalized_name}' submitted to Meta for review. "
        "You will be notified when it is approved or rejected."
    )
    _notify_users(
        db,
        template=record,
        event_type="submitted",
        message=message,
        user_ids=_notification_targets(db, record),
    )
    db.commit()
    db.refresh(record)

    return {
        "template": template_to_dict(record),
        "message": message,
        "meta_status": submit_result.get("meta_status") or "PENDING",
    }


def resubmit_template_for_meta(
    db: Session,
    *,
    template_id: int,
    user_id: int,
    body: str,
    footer: str | None = None,
    category: str | None = None,
) -> dict[str, Any]:
    """Update a local template and resubmit to Meta (rejected / paused / disabled only)."""
    record = get_template(db, template_id)
    if not record:
        raise ValueError("Template not found")
    if record.status == WhatsAppTemplateStatus.approved:
        raise ValueError(
            "Approved templates cannot be changed on Meta. Use Duplicate to submit a new name."
        )
    if record.status == WhatsAppTemplateStatus.pending:
        raise ValueError(
            "This template is still pending Meta review. Wait for the decision, or create "
            "a new template with a different name."
        )
    return create_template_for_meta(
        db,
        user_id=user_id,
        name=record.name,
        category=category or record.category or "UTILITY",
        language=record.language,
        body=body,
        footer=footer,
    )


def handle_template_status_webhook(db: Session, payload: dict[str, Any]) -> dict[str, Any]:
    """Apply Meta message_template_status_update webhook payload."""
    event = (payload.get("event") or payload.get("status") or "").strip().upper()
    template_name = (payload.get("message_template_name") or payload.get("name") or "").strip()
    language = (payload.get("message_template_language") or payload.get("language") or "en").strip()
    meta_id = payload.get("message_template_id") or payload.get("id")
    reason = payload.get("reason")

    if not template_name:
        return {"status": "ignored", "message": "No template name in webhook payload"}

    record = None
    if meta_id:
        record = (
            db.query(WhatsAppTemplate)
            .filter_by(meta_template_id=str(meta_id))
            .first()
        )
    if not record:
        record = (
            db.query(WhatsAppTemplate)
            .filter_by(name=template_name, language=language)
            .first()
        )
    if not record:
        record = WhatsAppTemplate(
            name=template_name,
            language=language,
            meta_template_id=str(meta_id) if meta_id else None,
        )
        db.add(record)

    if meta_id:
        record.meta_template_id = str(meta_id)

    status_key = event.lower()
    if status_key in _STATUS_MAP:
        record.status = _STATUS_MAP[status_key]
    elif event == "FLAGGED":
        record.status = WhatsAppTemplateStatus.paused

    if record.status == WhatsAppTemplateStatus.rejected:
        record.rejection_reason = str(reason).strip() if reason and str(reason).upper() != "NONE" else None
    elif record.status == WhatsAppTemplateStatus.approved:
        record.rejection_reason = None

    record.synced_at = datetime.now(timezone.utc)
    db.flush()

    if event == "APPROVED":
        notice = f"Meta approved WhatsApp template '{template_name}'. You can use it in campaigns now."
        event_type = "approved"
    elif event in {"REJECTED", "FLAGGED"}:
        detail = record.rejection_reason or "See Meta Business Manager for details."
        notice = f"Meta {event.lower()} WhatsApp template '{template_name}': {detail}"
        event_type = "rejected" if event == "REJECTED" else "paused"
    else:
        notice = f"WhatsApp template '{template_name}' status updated to {event or 'unknown'}."
        event_type = status_key or "updated"

    _notify_users(
        db,
        template=record,
        event_type=event_type,
        message=notice,
        user_ids=_notification_targets(db, record),
    )
    db.commit()
    return {"status": "ok", "template_id": record.id, "event": event}


def list_template_notifications(
    db: Session,
    *,
    user_id: int,
    unread_only: bool = True,
    limit: int = 50,
) -> dict[str, Any]:
    query = db.query(WhatsAppTemplateStatusEvent).filter(
        WhatsAppTemplateStatusEvent.user_id == user_id
    )
    if unread_only:
        query = query.filter(WhatsAppTemplateStatusEvent.read_at.is_(None))
    rows = (
        query.order_by(WhatsAppTemplateStatusEvent.created_at.desc())
        .limit(min(max(1, limit), 200))
        .all()
    )
    unread_count = (
        db.query(WhatsAppTemplateStatusEvent)
        .filter(
            WhatsAppTemplateStatusEvent.user_id == user_id,
            WhatsAppTemplateStatusEvent.read_at.is_(None),
        )
        .count()
    )
    return {
        "unread_count": int(unread_count),
        "rows": [notification_to_dict(row) for row in rows],
    }


def mark_template_notifications_read(
    db: Session,
    *,
    user_id: int,
    notification_ids: list[int] | None = None,
) -> int:
    now = datetime.now(timezone.utc)
    query = db.query(WhatsAppTemplateStatusEvent).filter(
        WhatsAppTemplateStatusEvent.user_id == user_id,
        WhatsAppTemplateStatusEvent.read_at.is_(None),
    )
    if notification_ids:
        query = query.filter(WhatsAppTemplateStatusEvent.id.in_(notification_ids))
    updated = query.update({WhatsAppTemplateStatusEvent.read_at: now}, synchronize_session=False)
    db.commit()
    return int(updated or 0)


def list_templates(db: Session, *, approved_only: bool = False) -> list[WhatsAppTemplate]:
    query = db.query(WhatsAppTemplate)
    if approved_only:
        query = query.filter(WhatsAppTemplate.status == WhatsAppTemplateStatus.approved)
    return query.order_by(WhatsAppTemplate.updated_at.desc()).all()


def get_template(db: Session, template_id: int) -> WhatsAppTemplate | None:
    return db.get(WhatsAppTemplate, template_id)


def delete_template_from_meta(db: Session, *, template_id: int) -> dict[str, Any]:
    """Delete a template on Meta (when configured) and remove the local row."""
    record = get_template(db, template_id)
    if not record:
        raise ValueError("Template not found")

    name = record.name
    meta_result = whatsapp_client.delete_message_template(
        name=name,
        hsm_id=record.meta_template_id,
    )
    status = str(meta_result.get("status") or "")
    if status not in {"deleted", "already_gone", "not_configured"}:
        raise ValueError(meta_result.get("message") or "Failed to delete template on Meta")

    db.query(WhatsAppTemplateStatusEvent).filter(
        WhatsAppTemplateStatusEvent.template_id == record.id
    ).delete(synchronize_session=False)
    db.delete(record)
    db.commit()

    if status == "not_configured":
        message = (
            f"Deleted '{name}' from this list. Meta is not configured, so it was not "
            "removed from WhatsApp Business Manager."
        )
    elif status == "already_gone":
        message = f"Deleted '{name}' from this list. It was already gone on Meta."
    else:
        message = f"Deleted WhatsApp template '{name}' from Meta and this list."
    return {"status": "ok", "message": message}


def resolve_contact_salutation_name(
    *,
    contact_name: str | None = None,
    company_name: str | None = None,
) -> str:
    for value in (contact_name, company_name):
        if value and str(value).strip():
            return str(value).strip()
    return "Sir/Madam"


def suggest_template_variables(
    body_text: str | None,
    variable_count: int,
    *,
    contact_name: str | None = None,
    company_name: str | None = None,
    country: str | None = None,
) -> list[str]:
    """Fill Meta {{1}}…{{n}} from lead context (matches mailer Dear XYZ behaviour)."""
    contact = resolve_contact_salutation_name(
        contact_name=contact_name,
        company_name=company_name,
    )
    company = (company_name or "").strip()
    country_val = (country or "").strip()
    body = body_text or ""

    values: list[str] = []
    for index in range(1, variable_count + 1):
        placeholder = f"{{{{{index}}}}}"
        pos = body.find(placeholder)
        context = ""
        if pos >= 0:
            start = max(0, pos - 40)
            end = pos + len(placeholder) + 40
            context = body[start:end].lower()

        if "dear" in context and "{{" in context:
            values.append(contact)
        elif any(
            token in context
            for token in ("company", "organisation", "organization", "firm", "business", "client")
        ):
            values.append(company or contact)
        elif any(token in context for token in ("country", "region", "market")):
            values.append(country_val or company or contact)
        elif index == 1:
            values.append(contact)
        elif index == 2:
            values.append(company or contact)
        else:
            values.append(company or contact)
    return values


def merge_template_variables(
    existing: list[str] | None,
    suggested: list[str],
) -> list[str]:
    """Keep user edits; replace empty or literal placeholder values."""
    placeholder_values = {
        "[company name]",
        "[contact name]",
        "[company_name]",
        "[contact_name]",
        "company name",
        "contact name",
    }
    existing = existing or []
    merged: list[str] = []
    for index, suggested_value in enumerate(suggested):
        current = (existing[index] if index < len(existing) else "").strip()
        if not current:
            merged.append(suggested_value)
            continue
        if current.lower() in placeholder_values:
            merged.append(suggested_value)
            continue
        if re.fullmatch(r"\{\{\d+\}\}", current):
            merged.append(suggested_value)
            continue
        merged.append(current)
    return merged


def render_variables(body_text: str, variables: list[str]) -> str:
    """Preview only — actual send uses Meta's {{n}} component substitution."""
    rendered = body_text or ""
    for index, value in enumerate(variables, start=1):
        rendered = rendered.replace(f"{{{{{index}}}}}", value)
    contact = variables[0] if variables else ""
    company = variables[1] if len(variables) > 1 else (variables[0] if variables else "")
    for pattern, replacement in (
        (r"\[Company Name\]", company),
        (r"\[Contact Name\]", contact),
        (r"\[company_name\]", company),
        (r"\[contact_name\]", contact),
    ):
        rendered = re.sub(pattern, replacement, rendered, flags=re.IGNORECASE)
    return rendered


def build_body_component(variables: list[str]) -> list[dict[str, Any]]:
    """Legacy helper — prefer :func:`build_template_send_components` for Meta sends."""
    cleaned = [_sanitize_template_text(value) for value in variables]
    if not cleaned:
        return []
    return [
        {
            "type": "body",
            "parameters": [{"type": "text", "text": value} for value in cleaned],
        }
    ]


def build_template_send_components(
    template: WhatsAppTemplate | None,
    variables: list[str] | None = None,
    *,
    header_media_url: str | None = None,
) -> list[dict[str, Any]]:
    """Build Meta send-time ``components`` so they match the approved template.

    Fixes common (#132012) failures:
    - IMAGE/VIDEO/DOCUMENT headers (must send typed media, not omit / send text)
    - Wrong body param count (duplicate ``{{1}}`` in body text)
    - Named body parameters
    - Dynamic URL button suffixes
    - Empty / multiline text values
    """
    variables = list(variables or [])
    components_out: list[dict[str, Any]] = []
    stored = list((template.components if template else None) or [])
    body_text = (template.body_text if template else None) or ""
    named = _named_variables(body_text)
    expected_body = (
        len(named)
        if named
        else (
            int(template.variable_count)
            if template and template.variable_count
            else _positional_variable_count(body_text)
        )
    )

    header = _find_component(stored, "HEADER")
    if header:
        fmt = str(header.get("format") or "TEXT").upper()
        if fmt in _MEDIA_HEADER_FORMATS:
            media_type = fmt.lower()  # image | video | document
            link = (header_media_url or "").strip() or _header_example_media_link(header)
            if not link:
                raise ValueError(
                    f"Template '{getattr(template, 'name', '')}' requires a {fmt} header. "
                    "Re-sync templates from Meta or provide a public media URL."
                )
            components_out.append(
                {
                    "type": "header",
                    "parameters": [
                        {
                            "type": media_type,
                            media_type: {"link": link},
                        }
                    ],
                }
            )
        elif fmt == "TEXT":
            header_text = str(header.get("text") or "")
            header_named = _named_variables(header_text)
            header_count = (
                len(header_named) if header_named else _positional_variable_count(header_text)
            )
            if header_count > 0:
                # Header vars come from the front of the variables list when UI only
                # collects body slots — fall back to first body value / company.
                header_values = variables[:header_count]
                while len(header_values) < header_count:
                    header_values.append(variables[0] if variables else "Customer")
                if header_named:
                    params = [
                        {
                            "type": "text",
                            "parameter_name": header_named[i],
                            "text": _sanitize_template_text(
                                header_values[i] if i < len(header_values) else None,
                                fallback="Customer",
                            ),
                        }
                        for i in range(header_count)
                    ]
                else:
                    params = [
                        {
                            "type": "text",
                            "text": _sanitize_template_text(
                                header_values[i] if i < len(header_values) else None,
                                fallback="Customer",
                            ),
                        }
                        for i in range(header_count)
                    ]
                components_out.append({"type": "header", "parameters": params})

    if expected_body > 0:
        body_values = list(variables)
        # If header consumed leading text vars, body still uses the same UI list
        # (Compose collects body slots only). Prefer full list for body.
        while len(body_values) < expected_body:
            body_values.append(body_values[-1] if body_values else "Customer")
        body_values = body_values[:expected_body]
        if named:
            params = [
                {
                    "type": "text",
                    "parameter_name": named[i],
                    "text": _sanitize_template_text(
                        body_values[i] if i < len(body_values) else None,
                        fallback="Customer",
                    ),
                }
                for i in range(expected_body)
            ]
        else:
            params = [
                {
                    "type": "text",
                    "text": _sanitize_template_text(
                        body_values[i] if i < len(body_values) else None,
                        fallback="Customer",
                    ),
                }
                for i in range(expected_body)
            ]
        components_out.append({"type": "body", "parameters": params})

    buttons_component = _find_component(stored, "BUTTONS")
    buttons = list((buttons_component or {}).get("buttons") or [])
    for index, button in enumerate(buttons):
        button_type = str(button.get("type") or "").upper()
        if button_type != "URL":
            continue
        url = str(button.get("url") or "")
        # Dynamic URL buttons end with {{1}} (suffix only at send time).
        if "{{" not in url:
            continue
        suffix = "info"
        if variables:
            # Prefer last variable (often a path/id); else company-ish first value.
            suffix = _sanitize_template_text(variables[-1], fallback="info")
            # URL suffixes must stay path-safe and short.
            suffix = re.sub(r"[^a-zA-Z0-9._\-/=]", "", suffix.replace(" ", "-"))[:64] or "info"
        components_out.append(
            {
                "type": "button",
                "sub_type": "url",
                "index": str(index),
                "parameters": [{"type": "text", "text": suffix}],
            }
        )

    return components_out


def notification_to_dict(row: WhatsAppTemplateStatusEvent) -> dict[str, Any]:
    return {
        "id": row.id,
        "template_id": row.template_id,
        "event_type": row.event_type,
        "message": row.message,
        "read_at": row.read_at.isoformat() if row.read_at else None,
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


def template_to_dict(template: WhatsAppTemplate) -> dict[str, Any]:
    return {
        "id": template.id,
        "meta_template_id": template.meta_template_id,
        "name": template.name,
        "category": template.category,
        "language": template.language,
        "status": template.status.value,
        "body_text": template.body_text,
        "variable_count": template.variable_count,
        "submitted_by_user_id": template.submitted_by_user_id,
        "rejection_reason": template.rejection_reason,
        "synced_at": template.synced_at,
    }
