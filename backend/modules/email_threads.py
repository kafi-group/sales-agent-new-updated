"""Group Outlook IMAP messages into conversation threads."""

from __future__ import annotations

import hashlib
import re
from typing import Any

from modules.inbox_cutoff import date_sort_key


_SUBJECT_PREFIX_RE = re.compile(
    r"^(?:(?:re|fw|fwd|aw|sv|antw|resp|rif)\s*:\s*)+",
    re.IGNORECASE,
)


def normalize_message_id(value: str | None) -> str | None:
    if not value:
        return None
    cleaned = value.strip().strip("<>").strip().lower()
    return cleaned or None


def normalize_subject(value: str | None) -> str:
    subject = (value or "").strip()
    while True:
        updated = _SUBJECT_PREFIX_RE.sub("", subject).strip()
        if updated == subject:
            break
        subject = updated
    return subject.lower() or "(no subject)"


def _parse_id_list(value: str | None) -> list[str]:
    if not value:
        return []
    parts = re.findall(r"<[^>]+>|[^<>\s,]+", value)
    out: list[str] = []
    for part in parts:
        mid = normalize_message_id(part)
        if mid:
            out.append(mid)
    return out


def message_key(message: dict[str, Any]) -> str:
    folder = (message.get("folder") or "INBOX").replace("/", "_")
    return f"{folder}:{message.get('uid')}"


def _participants(message: dict[str, Any], mailbox_email: str | None) -> set[str]:
    people: set[str] = set()
    for raw in (
        message.get("from_email"),
        *(message.get("to") or []),
        *(message.get("cc") or []),
    ):
        if not raw:
            continue
        email = str(raw).strip().lower()
        if email:
            people.add(email)
    if mailbox_email:
        people.add(mailbox_email.strip().lower())
    return people


def _subject_fallback_key(message: dict[str, Any], mailbox_email: str | None) -> str:
    subject = normalize_subject(message.get("subject"))
    mailbox = mailbox_email.strip().lower() if mailbox_email else None
    people = sorted(_participants(message, mailbox_email) - ({mailbox} if mailbox else set()))
    counterparties = ",".join(people[:4]) if people else "unknown"
    return f"{subject}|{counterparties}"


def _is_sent_folder_name(folder: str | None) -> bool:
    name = (folder or "").strip().lower().replace("\\", "/")
    if not name:
        return False
    if name.startswith("sent") or name.endswith(".sent") or name.endswith("/sent"):
        return True
    return "sent" in name.split(".") or "sent" in name.split("/")


def _is_inbound_message(message: dict[str, Any], mailbox_email: str | None) -> bool:
    if _is_sent_folder_name(message.get("folder")):
        return False
    if message.get("direction") == "outbound":
        return False
    mailbox = (mailbox_email or "").strip().lower()
    from_email = str(message.get("from_email") or "").strip().lower()
    if mailbox and from_email == mailbox:
        return False
    return True


def group_messages_into_threads(
    messages: list[dict[str, Any]],
    *,
    mailbox_email: str | None = None,
) -> list[dict[str, Any]]:
    """Return thread summaries newest-first."""
    if not messages:
        return []

    enriched: list[dict[str, Any]] = []
    for msg in messages:
        row = dict(msg)
        row["key"] = message_key(row)
        row["norm_message_id"] = normalize_message_id(row.get("message_id"))
        row["norm_in_reply_to"] = normalize_message_id(row.get("in_reply_to"))
        row["norm_references"] = _parse_id_list(row.get("references"))
        row["norm_subject"] = normalize_subject(row.get("subject"))
        enriched.append(row)

    parent: dict[str, str] = {row["key"]: row["key"] for row in enriched}

    def find(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: str, b: str) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    by_msgid: dict[str, str] = {}
    for row in enriched:
        mid = row["norm_message_id"]
        if mid and mid not in by_msgid:
            by_msgid[mid] = row["key"]

    for row in enriched:
        key = row["key"]
        related: list[str] = []
        if row["norm_in_reply_to"]:
            related.append(row["norm_in_reply_to"])
        related.extend(row["norm_references"])
        for mid in related:
            other = by_msgid.get(mid)
            if other:
                union(key, other)

    subject_buckets: dict[str, list[str]] = {}
    for row in enriched:
        fb = _subject_fallback_key(row, mailbox_email)
        subject_buckets.setdefault(fb, []).append(row["key"])
    for keys in subject_buckets.values():
        root = keys[0]
        for other in keys[1:]:
            union(root, other)

    clusters: dict[str, list[dict[str, Any]]] = {}
    for row in enriched:
        root = find(row["key"])
        clusters.setdefault(root, []).append(row)

    threads: list[dict[str, Any]] = []
    for members in clusters.values():
        members_sorted = sorted(members, key=lambda m: date_sort_key(m.get("date")))
        latest = members_sorted[-1]
        earliest = members_sorted[0]
        inbound = [m for m in members_sorted if _is_inbound_message(m, mailbox_email)]
        anchor = inbound[0] if inbound else earliest
        display_latest = inbound[-1] if inbound else latest

        participants: set[str] = set()
        for m in members_sorted:
            if m.get("from_email"):
                participants.add(str(m["from_email"]).strip())
            for addr in m.get("to") or []:
                if addr:
                    participants.add(str(addr).strip())

        unread_count = sum(
            1 for m in (inbound or members_sorted) if m.get("unread") and _is_inbound_message(m, mailbox_email)
        )
        if not inbound:
            unread_count = sum(1 for m in members_sorted if m.get("unread"))
        has_attachments = any(m.get("has_attachments") for m in members_sorted)

        # Stable id from first *received* message so Inbox list ↔ open-thread match
        # even when Sent copies are merged later for conversation view.
        root_mid = anchor.get("norm_message_id")
        if not root_mid:
            for m in inbound or members_sorted:
                if m.get("norm_message_id") and not m.get("norm_in_reply_to"):
                    root_mid = m["norm_message_id"]
                    break
        if not root_mid:
            root_mid = _subject_fallback_key(anchor, mailbox_email)
        thread_id = hashlib.sha1(str(root_mid).encode("utf-8")).hexdigest()[:20]

        raw_subject = anchor.get("subject") or "(no subject)"
        cleaned_subject = _SUBJECT_PREFIX_RE.sub("", raw_subject).strip() or raw_subject

        threads.append(
            {
                "thread_id": thread_id,
                "subject": cleaned_subject,
                "participants": sorted(participants),
                "message_count": len(members_sorted),
                "unread_count": unread_count,
                "latest_date": display_latest.get("date"),
                "latest_preview": display_latest.get("preview") or "",
                "latest_from_email": display_latest.get("from_email"),
                "latest_from_name": display_latest.get("from_name"),
                "has_attachments": has_attachments,
                "message_keys": [m["key"] for m in members_sorted],
                "messages": members_sorted,
            }
        )

    threads.sort(key=lambda t: date_sort_key(t.get("latest_date")), reverse=True)
    return threads


def filter_messages_for_open_conversation(
    messages: list[dict[str, Any]],
    *,
    mailbox_email: str | None,
) -> list[dict[str, Any]]:
    """Open-thread body: inbound always; outbound only when it is a real reply link.

    Prevents subject-only merges from dumping unrelated Sent mail into the reader.
    """
    if not messages:
        return []
    inbound = [m for m in messages if _is_inbound_message(m, mailbox_email)]
    outbound = [m for m in messages if not _is_inbound_message(m, mailbox_email)]
    if not inbound:
        return []
    if not outbound:
        return sorted(inbound, key=lambda m: date_sort_key(m.get("date")))

    inbound_mids = {
        mid
        for mid in (normalize_message_id(m.get("message_id")) for m in inbound)
        if mid
    }
    inbound_subjects = {normalize_subject(m.get("subject")) for m in inbound}
    linked: list[dict[str, Any]] = []
    for out in outbound:
        refs: set[str] = set()
        irt = normalize_message_id(out.get("in_reply_to"))
        if irt:
            refs.add(irt)
        refs.update(_parse_id_list(out.get("references")))
        out_mid = normalize_message_id(out.get("message_id"))
        header_linked = bool(refs & inbound_mids) or (
            bool(out_mid)
            and any(
                normalize_message_id(i.get("in_reply_to")) == out_mid
                or out_mid in _parse_id_list(i.get("references"))
                for i in inbound
            )
        )
        subject_linked = normalize_subject(out.get("subject")) in inbound_subjects
        if header_linked or subject_linked:
            linked.append(out)

    combined = inbound + linked
    return sorted(combined, key=lambda m: date_sort_key(m.get("date")))
