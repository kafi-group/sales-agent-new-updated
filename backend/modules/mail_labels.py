"""App-level mail labels (Gmail-style) keyed to IMAP message UIDs / threads."""

from __future__ import annotations

import re
from urllib.parse import urlparse

from typing import Any

from sqlalchemy.orm import Session

from db.models import MailLabel, MailLabelAssignment

FLAGGED_LABEL_NAME = "Flagged"
FLAGGED_LABEL_COLOR = "#f59e0b"


def is_flagged_label(label: MailLabel | None) -> bool:
    if not label:
        return False
    return (label.name or "").strip().lower() == FLAGGED_LABEL_NAME.lower()


def ensure_flagged_label(db: Session, user_id: int) -> MailLabel:
    """Per-user Flagged mailbox — no auto-routing rules; manual flag only."""
    existing = (
        db.query(MailLabel)
        .filter(MailLabel.user_id == user_id)
        .all()
    )
    for row in existing:
        if is_flagged_label(row):
            return row
    label = MailLabel(
        user_id=user_id,
        name=FLAGGED_LABEL_NAME,
        color=FLAGGED_LABEL_COLOR,
        match_query=None,
        match_keyword=None,
    )
    db.add(label)
    db.commit()
    db.refresh(label)
    return label


def _norm_subject(subject: str | None) -> str | None:
    if not subject:
        return None
    cleaned = re.sub(r"^(re|fw|fwd)\s*:\s*", "", subject.strip(), flags=re.I)
    cleaned = re.sub(r"\s+", " ", cleaned).strip().lower()
    return cleaned[:255] or None


def normalize_domain(raw: str | None) -> str | None:
    """Normalize a domain or full email address for routing (from/to addresses only)."""
    if not raw:
        return None
    text = raw.strip().lower()
    if not text:
        return None
    if "@" in text and " " not in text:
        local, _, host = text.partition("@")
        host = host.strip().removeprefix("www.")
        if local and host and "." in host:
            return f"{local}@{host}"[:255]
        return None
    if "://" in text or "/" in text:
        candidate = text if "://" in text else f"https://{text}"
        try:
            parsed = urlparse(candidate)
            host = (parsed.hostname or "").lower().removeprefix("www.")
            if host and "." in host:
                return host[:255]
        except Exception:
            pass
        return None
    text = text.removeprefix("www.")
    if "." in text and " " not in text:
        return text[:255]
    return None


def normalize_keyword(raw: str | None) -> str | None:
    """Normalize a free-text keyword for subject/body/preview matching."""
    if not raw:
        return None
    text = raw.strip().lower()
    if len(text) < 2:
        return None
    return text[:255]


def normalize_match_query(raw: str | None) -> str | None:
    """Legacy alias — treat as domain/email only."""
    return normalize_domain(raw)


def label_routing_summary(label: MailLabel) -> dict[str, str | None]:
    return {
        "domain": (label.match_query or "").strip() or None,
        "keyword": (label.match_keyword or "").strip() or None,
    }


def email_matches_domain_rule(email: str | None, rule: str | None) -> bool:
    """Match sender/recipient address against a full email or domain rule."""
    if not rule or not email:
        return False
    value = email.strip().lower()
    token = rule.strip().lower()
    if not value or not token:
        return False
    if "@" in token:
        return value == token
    if "@" not in value:
        return False
    domain = value.split("@", 1)[1]
    return domain == token or domain.endswith(f".{token}")


def text_matches_keyword(text: str | None, keyword: str | None) -> bool:
    if not keyword or not text:
        return False
    return keyword in text.lower()


def message_matches_label_rules(
    *,
    from_email: str | None,
    to_addrs: list[str] | None,
    from_name: str | None = None,
    subject: str | None = None,
    preview: str | None = None,
    body_text: str | None = None,
    label: MailLabel,
) -> bool:
    domain = normalize_domain(label.match_query)
    keyword = normalize_keyword(label.match_keyword)
    if not domain and not keyword:
        return False
    if domain:
        if email_matches_domain_rule(from_email, domain):
            return True
        for addr in to_addrs or []:
            if email_matches_domain_rule(addr, domain):
                return True
    if keyword:
        if text_matches_keyword(from_name, keyword):
            return True
        if text_matches_keyword(subject, keyword):
            return True
        if text_matches_keyword(preview, keyword):
            return True
        if text_matches_keyword(body_text, keyword):
            return True
    return False


def thread_matches_label_rules(thread: dict[str, Any], labels: list[MailLabel]) -> bool:
    for label in labels:
        domain = normalize_domain(label.match_query)
        keyword = normalize_keyword(label.match_keyword)
        if not domain and not keyword:
            continue
        if domain:
            if email_matches_domain_rule(thread.get("latest_from_email"), domain):
                return True
            for addr in thread.get("participants") or []:
                if email_matches_domain_rule(addr, domain):
                    return True
        if keyword:
            if text_matches_keyword(thread.get("latest_from_name"), keyword):
                return True
            if text_matches_keyword(thread.get("subject"), keyword):
                return True
            if text_matches_keyword(thread.get("latest_preview"), keyword):
                return True
    return False


def list_labels(db: Session, user_id: int) -> list[MailLabel]:
    ensure_flagged_label(db, user_id)
    rows = (
        db.query(MailLabel)
        .filter(MailLabel.user_id == user_id)
        .order_by(MailLabel.name.asc())
        .all()
    )
    # Keep Flagged first in API order for stable nav/count loading.
    flagged = [r for r in rows if is_flagged_label(r)]
    others = [r for r in rows if not is_flagged_label(r)]
    return flagged + others


def create_label(
    db: Session,
    user_id: int,
    *,
    name: str,
    color: str = "#34d399",
    match_query: str | None = None,
    match_keyword: str | None = None,
) -> MailLabel:
    cleaned = (name or "").strip()
    if not cleaned:
        raise ValueError("Label name is required")
    if cleaned.lower() == FLAGGED_LABEL_NAME.lower():
        raise ValueError('“Flagged” is a built-in mailbox — use the Flag button on an email')
    if len(cleaned) > 100:
        raise ValueError("Label name is too long")
    domain = normalize_domain(match_query)
    keyword = normalize_keyword(match_keyword)
    if match_query and not domain:
        raise ValueError("Domain must be a valid email (e.g. finance@kafi-group.com) or domain (e.g. kafi-group.com)")
    if match_keyword and not keyword:
        raise ValueError("Keyword must be at least 2 characters")
    if not domain and not keyword:
        raise ValueError("Set a domain or a keyword so mail can be routed into this label")
    existing = (
        db.query(MailLabel)
        .filter(MailLabel.user_id == user_id, MailLabel.name == cleaned)
        .first()
    )
    if existing:
        raise ValueError("A label with that name already exists")
    label = MailLabel(
        user_id=user_id,
        name=cleaned,
        color=(color or "#34d399").strip() or "#34d399",
        match_query=domain,
        match_keyword=keyword,
    )
    db.add(label)
    db.commit()
    db.refresh(label)
    return label


def rename_label(
    db: Session,
    user_id: int,
    label_id: int,
    *,
    new_name: str,
    new_color: str | None = None,
) -> MailLabel:
    cleaned = (new_name or "").strip()
    if not cleaned:
        raise ValueError("Label name is required")
    if len(cleaned) > 100:
        raise ValueError("Label name is too long")
    label = db.query(MailLabel).filter(MailLabel.id == label_id, MailLabel.user_id == user_id).first()
    if not label:
        raise ValueError("Label not found")
    if is_flagged_label(label):
        raise ValueError("The Flagged mailbox cannot be renamed")
    if cleaned.lower() == FLAGGED_LABEL_NAME.lower():
        raise ValueError('“Flagged” is reserved — pick another label name')
    existing = (
        db.query(MailLabel)
        .filter(MailLabel.user_id == user_id, MailLabel.name == cleaned, MailLabel.id != label_id)
        .first()
    )
    if existing:
        raise ValueError("A label with that name already exists")
    label.name = cleaned
    if new_color and new_color.strip():
        label.color = new_color.strip()
    db.commit()
    db.refresh(label)
    return label


def delete_label(db: Session, user_id: int, label_id: int) -> bool:
    """Remove label and all app-level assignments. IMAP messages are never deleted."""
    label = db.query(MailLabel).filter(MailLabel.id == label_id, MailLabel.user_id == user_id).first()
    if not label:
        return False
    if is_flagged_label(label):
        raise ValueError("The Flagged mailbox cannot be deleted")
    db.delete(label)
    db.commit()
    return True


def assign_label(
    db: Session,
    user_id: int,
    *,
    label_id: int,
    folder: str,
    message_uid: str,
    message_id: str | None = None,
    thread_id: str | None = None,
    from_email: str | None = None,
    subject: str | None = None,
    apply_similar: bool = False,
    mailbox_user_id: int | None = None,
    mailbox_user: Any | None = None,
) -> dict:
    label = db.query(MailLabel).filter(MailLabel.id == label_id, MailLabel.user_id == user_id).first()
    if not label:
        raise ValueError("Label not found")

    # Flagged is always one exact message — never domain/sender expansion.
    if is_flagged_label(label):
        apply_similar = False

    folder_key = (folder or "inbox").strip().lower() or "inbox"
    uid = (message_uid or "").strip()
    if not uid:
        raise ValueError("message_uid is required")

    mailbox_id = int(mailbox_user_id) if mailbox_user_id is not None else int(user_id)
    subject_key = _norm_subject(subject)
    from_norm = (from_email or "").strip().lower() or None

    def _upsert(
        *,
        folder: str,
        message_uid: str,
        message_id: str | None,
        thread_id: str | None,
        from_email: str | None,
        subject_key: str | None,
    ) -> bool:
        folder_norm = (folder or "inbox").strip().lower() or "inbox"
        row = (
            db.query(MailLabelAssignment)
            .filter(
                MailLabelAssignment.user_id == user_id,
                MailLabelAssignment.label_id == label_id,
                MailLabelAssignment.folder == folder_norm,
                MailLabelAssignment.message_uid == message_uid,
                MailLabelAssignment.mailbox_user_id == mailbox_id,
            )
            .first()
        )
        if row:
            return False
        db.add(
            MailLabelAssignment(
                label_id=label_id,
                user_id=user_id,
                folder=folder_norm,
                message_uid=message_uid,
                message_id=message_id,
                thread_id=thread_id,
                from_email=from_email,
                subject_key=subject_key,
                mailbox_user_id=mailbox_id,
            )
        )
        return True

    created = 0
    if _upsert(
        folder=folder_key,
        message_uid=uid,
        message_id=message_id,
        thread_id=thread_id,
        from_email=from_norm,
        subject_key=subject_key,
    ):
        created += 1

    similar = 0
    # Optional: label other messages that share sender or subject — as separate
    # exact UID rows (never for Flagged).
    if apply_similar and mailbox_user is not None and (subject_key or from_norm):
        try:
            from modules import inbox as inbox_module

            candidates = inbox_module.list_messages(
                mailbox_user, limit=120, folder="inbox"
            ) + inbox_module.list_messages(mailbox_user, limit=40, folder="sent")
        except Exception:
            candidates = []
        for message in candidates:
            other_uid = str(message.get("uid") or "").strip()
            if not other_uid or other_uid == uid:
                continue
            other_folder = (message.get("folder") or "inbox").strip().lower() or "inbox"
            other_from = (message.get("from_email") or "").strip().lower() or None
            other_subject = _norm_subject(message.get("subject"))
            same_from = bool(from_norm and other_from and from_norm == other_from)
            same_subject = bool(subject_key and other_subject and subject_key == other_subject)
            if not (same_from or same_subject):
                continue
            if _upsert(
                folder=other_folder,
                message_uid=other_uid,
                message_id=message.get("message_id"),
                thread_id=message.get("thread_id"),
                from_email=other_from,
                subject_key=other_subject,
            ):
                similar += 1
                created += 1

    db.commit()
    return {"assigned": created, "similar_rule": similar, "label_id": label_id}


def unassign_label(
    db: Session,
    user_id: int,
    *,
    label_id: int,
    folder: str,
    message_uid: str,
    mailbox_user_id: int | None = None,
) -> bool:
    folder_key = (folder or "inbox").strip().lower() or "inbox"
    mailbox_id = int(mailbox_user_id) if mailbox_user_id is not None else int(user_id)
    row = (
        db.query(MailLabelAssignment)
        .filter(
            MailLabelAssignment.user_id == user_id,
            MailLabelAssignment.label_id == label_id,
            MailLabelAssignment.folder == folder_key,
            MailLabelAssignment.message_uid == message_uid,
            MailLabelAssignment.mailbox_user_id == mailbox_id,
        )
        .first()
    )
    if not row:
        # Fallback: older rows / folder casing drift — still remove exact UID in mailbox.
        row = (
            db.query(MailLabelAssignment)
            .filter(
                MailLabelAssignment.user_id == user_id,
                MailLabelAssignment.label_id == label_id,
                MailLabelAssignment.message_uid == message_uid,
                MailLabelAssignment.mailbox_user_id == mailbox_id,
            )
            .first()
        )
    if not row:
        return False
    db.delete(row)
    db.commit()
    return True


def labels_for_messages(
    db: Session,
    user_id: int,
    *,
    folder: str,
    message_uids: list[str],
    mailbox_user_id: int | None = None,
) -> dict[str, list[dict]]:
    if not message_uids:
        return {}
    folder_key = (folder or "inbox").strip().lower() or "inbox"
    mailbox_id = int(mailbox_user_id) if mailbox_user_id is not None else int(user_id)
    rows = (
        db.query(MailLabelAssignment, MailLabel)
        .join(MailLabel, MailLabel.id == MailLabelAssignment.label_id)
        .filter(
            MailLabelAssignment.user_id == user_id,
            MailLabelAssignment.folder == folder_key,
            MailLabelAssignment.message_uid.in_(message_uids),
            MailLabelAssignment.mailbox_user_id == mailbox_id,
        )
        .all()
    )
    out: dict[str, list[dict]] = {}
    for assignment, label in rows:
        out.setdefault(assignment.message_uid, []).append(
            {
                "id": label.id,
                "name": label.name,
                "color": label.color,
                "match_query": label.match_query,
                "match_keyword": label.match_keyword,
                "is_system": is_flagged_label(label),
            }
        )
    return out


def message_keys_for_label(
    db: Session,
    user_id: int,
    label_id: int,
    *,
    mailbox_user_id: int | None = None,
) -> list[dict]:
    label = db.query(MailLabel).filter(MailLabel.id == label_id, MailLabel.user_id == user_id).first()
    if not label:
        raise ValueError("Label not found")
    q = db.query(MailLabelAssignment).filter(
        MailLabelAssignment.user_id == user_id,
        MailLabelAssignment.label_id == label_id,
    )
    if mailbox_user_id is not None:
        q = q.filter(MailLabelAssignment.mailbox_user_id == int(mailbox_user_id))
    rows = q.all()
    return [
        {
            "folder": r.folder,
            "message_uid": r.message_uid,
            "message_id": r.message_id,
            "thread_id": r.thread_id,
            "from_email": r.from_email,
            "subject_key": r.subject_key,
            "mailbox_user_id": r.mailbox_user_id,
        }
        for r in rows
    ]


def label_counts(
    db: Session,
    user_id: int,
    *,
    mailbox_user_id: int | None = None,
) -> dict[int, int]:
    from sqlalchemy import func as sa_func

    q = db.query(MailLabelAssignment.label_id, sa_func.count(MailLabelAssignment.id)).filter(
        MailLabelAssignment.user_id == user_id
    )
    if mailbox_user_id is not None:
        q = q.filter(MailLabelAssignment.mailbox_user_id == int(mailbox_user_id))
    rows = q.group_by(MailLabelAssignment.label_id).all()
    return {int(label_id): int(count) for label_id, count in rows}


def _message_key(folder: str | None, message_uid: str | None) -> tuple[str, str] | None:
    uid = (message_uid or "").strip()
    if not uid:
        return None
    folder_key = (folder or "inbox").strip().lower() or "inbox"
    return folder_key, uid


def message_matches_assignment_keys(
    *,
    folder: str | None,
    message_uid: str | None,
    keys: list[dict],
) -> bool:
    """Exact folder + UID only — never expand by sender/domain/subject."""
    current = _message_key(folder, message_uid)
    if not current:
        return False
    for key in keys:
        key_folder = (key.get("folder") or "inbox").strip().lower()
        key_uid = str(key.get("message_uid") or "").strip()
        if key_uid and key_folder == current[0] and key_uid == current[1]:
            return True
    return False


# Back-compat alias used by older call sites.
_message_matches_assignment_keys = message_matches_assignment_keys


def label_display_counts(
    db: Session,
    user,
    *,
    scan_limit: int = 100,
    mailbox_user_id: int | None = None,
    mailbox_user: Any | None = None,
) -> dict[int, int]:
    """Count messages visible in each label (rules + exact manual assignments)."""
    from modules import inbox as inbox_module

    labels = list_labels(db, user.id)
    if not labels:
        return {}

    mailbox_id = int(mailbox_user_id) if mailbox_user_id is not None else int(user.id)
    scan_user = mailbox_user or user

    assignment_rows = (
        db.query(MailLabelAssignment)
        .filter(
            MailLabelAssignment.user_id == user.id,
            MailLabelAssignment.mailbox_user_id == mailbox_id,
        )
        .all()
    )
    keys_by_label: dict[int, list[dict]] = {}
    for row in assignment_rows:
        keys_by_label.setdefault(int(row.label_id), []).append(
            {
                "folder": row.folder,
                "message_uid": row.message_uid,
            }
        )

    try:
        inbox_messages = inbox_module.list_messages(scan_user, limit=scan_limit, folder="inbox")
        sent_messages = inbox_module.list_messages(scan_user, limit=min(scan_limit, 40), folder="sent")
        messages = inbox_messages + sent_messages
    except Exception:
        return label_counts(db, user.id, mailbox_user_id=mailbox_id)

    counts: dict[int, int] = {}
    for label in labels:
        matched: set[tuple[str, str]] = set()
        keys = keys_by_label.get(int(label.id), [])
        # Flagged: manual assignments only (never domain/keyword routing).
        allow_rules = not is_flagged_label(label)

        # Do NOT resolve Flagged via live IMAP here — listMailLabels runs often and
        # per-UID fetches hang the Emails UI. Badge = assignment count; list hydrates UIDs.
        if is_flagged_label(label):
            for key in keys:
                parsed = _message_key(key.get("folder"), key.get("message_uid"))
                if parsed:
                    matched.add(parsed)
            counts[int(label.id)] = len(matched)
            continue

        for message in messages:
            folder = (message.get("folder") or "inbox").strip().lower() or "inbox"
            uid = str(message.get("uid") or "").strip()
            if not uid:
                continue
            current = (folder, uid)
            if current in matched:
                continue
            rules_hit = (
                allow_rules
                and message_matches_label_rules(
                    from_email=message.get("from_email"),
                    to_addrs=message.get("to") or [],
                    from_name=message.get("from_name"),
                    subject=message.get("subject"),
                    preview=message.get("preview"),
                    body_text=message.get("body_text"),
                    label=label,
                )
            )
            if rules_hit or _message_matches_assignment_keys(
                folder=folder,
                message_uid=uid,
                keys=keys,
            ):
                matched.add(current)
        for key in keys:
            parsed = _message_key(key.get("folder"), key.get("message_uid"))
            if parsed:
                matched.add(parsed)
        counts[int(label.id)] = len(matched)
    return counts
