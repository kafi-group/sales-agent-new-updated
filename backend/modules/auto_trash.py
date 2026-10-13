"""Auto Trash — learn from shared mailboxes' Trash, apply per-user toggle."""

from __future__ import annotations

import re
from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from db.models import AppUser, AutoTrashLog, AutoTrashProfile, AutoTrashSettings
from modules.inbox_triage import classify_email_triage

LEARN_TRASH_PER_MAILBOX = 150
SUBJECT_TOKEN_MIN = 3

# Preferred seed mailboxes (Asim's duty accounts + Khalid) — still learns from ALL configured mailboxes.
LEARN_FROM_EMAILS = frozenset(
    {
        "info@kafi-group.com",
        "marketing@kafi-group.com",
        "essence@kafi-group.com",
        "khalid.paracha@kafi-group.com",
        "khaled.paracha@kafi-group.com",
    }
)

# Never auto-trash sales-critical triage buckets.
PROTECTED_TRIAGE = frozenset(
    {
        "urgent",
        "action_required",
        "opportunity",
        "tax_notice_challan",
    }
)

MIN_SAMPLES_READY = 40
MIN_SENDER_HITS = 2
MIN_DOMAIN_HITS = 4
APPLY_INBOX_LIMIT = 35

_EMAIL_RE = re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.I)
_TOKEN_RE = re.compile(r"[a-z0-9]{4,}")

# Obvious scam / lottery spam — trash when Auto Trash is ON+Ready even if the
# sender was never seen in Trash (consumer Gmail one-offs, prize "tests", etc.).
_SPAM_SCAM_PHRASES = (
    "you have won",
    "you've won",
    "youve won",
    "congratulations you won",
    "congratulation you won",
    "claim your prize",
    "claim your reward",
    "claim now",
    "lottery winner",
    "jackpot",
    "prize winner",
    "won a $",
    "won $",
    "won usd",
    "shopping voucher",
    "shopping spree",
    "gift card winner",
    "million dollars",
    "nigerian prince",
    "wire transfer urgently",
    "share your bank details",
    "verify your account immediately to claim",
)
_SPAM_SCAM_COMBO_A = (
    "congratulat",
    "winner",
    "prize",
    "lottery",
    "jackpot",
)
_SPAM_SCAM_COMBO_B = (
    "$",
    "usd",
    "cash",
    "voucher",
    "gift card",
    "shopping",
    "claim",
)


def looks_like_obvious_spam_scam(*, subject: str | None, body: str | None) -> str | None:
    """High-confidence scam/lottery patterns (not learned-from-Trash)."""
    text = f"{subject or ''}\n{body or ''}".lower()
    if not text.strip():
        return None
    for phrase in _SPAM_SCAM_PHRASES:
        if phrase in text:
            return f"obvious spam/scam phrase ({phrase})"
    hit_a = [p for p in _SPAM_SCAM_COMBO_A if p in text]
    hit_b = [p for p in _SPAM_SCAM_COMBO_B if p in text]
    if hit_a and hit_b:
        return f"obvious spam/scam combo ({hit_a[0]}+{hit_b[0]})"
    # Subject-only lottery style: Congratulations + money amount
    subj = (subject or "").lower()
    if "congratulat" in subj and re.search(r"\$\s*\d|\d[\d,]*\s*(usd|dollars?)", subj):
        return "obvious spam/scam (congratulations + money in subject)"
    return None


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _norm_email(value: str | None) -> str:
    return (value or "").strip().lower()


def _domain_of(email: str) -> str:
    e = _norm_email(email)
    if "@" not in e:
        return ""
    return e.rsplit("@", 1)[-1]


def _message_key(msg: dict[str, Any]) -> str:
    mid = str(msg.get("message_id") or "").strip()
    if mid:
        return f"mid:{mid[:400]}"
    uid = str(msg.get("uid") or "").strip()
    folder = str(msg.get("folder") or "INBOX").strip()
    return f"uid:{folder}:{uid}"


def _subject_tokens(subject: str | None) -> list[str]:
    text = (subject or "").lower()
    stop = {
        "from",
        "with",
        "your",
        "this",
        "that",
        "have",
        "been",
        "will",
        "mail",
        "email",
        "please",
        "thanks",
        "thank",
        "dear",
        "kafi",
        "group",
        "http",
        "https",
        "www",
    }
    return [t for t in _TOKEN_RE.findall(text) if t not in stop][:12]


def get_or_create_settings(db: Session, user_id: int) -> AutoTrashSettings:
    try:
        row = db.get(AutoTrashSettings, int(user_id))
        if row:
            return row
        row = AutoTrashSettings(user_id=int(user_id), enabled=False)
        db.add(row)
        db.commit()
        db.refresh(row)
        return row
    except Exception:
        db.rollback()
        raise


def get_or_create_profile(db: Session) -> AutoTrashProfile:
    try:
        row = db.get(AutoTrashProfile, 1)
        if row:
            return row
        row = AutoTrashProfile(id=1, ready=False, rules={}, samples_seen=0)
        db.add(row)
        db.commit()
        db.refresh(row)
        return row
    except Exception:
        db.rollback()
        raise


def settings_fallback_dict(user_id: int) -> dict[str, Any]:
    """Returned when auto_trash tables are missing so the Inbox toggle stays usable."""
    return {
        "user_id": int(user_id),
        "enabled": False,
        "last_scan_at": None,
        "updated_at": None,
        "profile_ready": False,
        "samples_seen": 0,
        "last_learned_at": None,
        "can_auto_trash": False,
    }


def settings_to_dict(row: AutoTrashSettings, profile: AutoTrashProfile | None = None) -> dict[str, Any]:
    ready = bool(profile.ready) if profile else False
    return {
        "user_id": row.user_id,
        "enabled": bool(row.enabled),
        "last_scan_at": row.last_scan_at.isoformat() if row.last_scan_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
        "profile_ready": ready,
        "samples_seen": int(profile.samples_seen) if profile else 0,
        "last_learned_at": (
            profile.last_learned_at.isoformat() if profile and profile.last_learned_at else None
        ),
        "can_auto_trash": bool(row.enabled) and ready,
    }


def set_enabled(db: Session, user_id: int, enabled: bool) -> dict[str, Any]:
    row = get_or_create_settings(db, user_id)
    row.enabled = bool(enabled)
    row.updated_at = _now()
    db.commit()
    db.refresh(row)
    profile = get_or_create_profile(db)
    return settings_to_dict(row, profile)


def list_learning_mailbox_users(db: Session) -> list[AppUser]:
    """All active users with a working mailbox — preferred accounts first."""
    from modules.mailbox_accounts import resolve_user_mailbox

    users = (
        db.query(AppUser)
        .filter(AppUser.is_active.is_(True))
        .all()
    )
    preferred: list[AppUser] = []
    others: list[AppUser] = []
    seen: set[int] = set()
    for u in users:
        if u.id in seen:
            continue
        email = _norm_email(u.mailbox_email)
        if not email or not resolve_user_mailbox(u):
            continue
        seen.add(u.id)
        if email in LEARN_FROM_EMAILS:
            preferred.append(u)
        else:
            others.append(u)
    return preferred + others


def learn_from_trash(db: Session) -> dict[str, Any]:
    """Rebuild global rules from Trash across every configured mailbox."""
    from modules import inbox as inbox_module

    sender_counts: Counter[str] = Counter()
    domain_counts: Counter[str] = Counter()
    token_counts: Counter[str] = Counter()
    triage_counts: Counter[str] = Counter()
    samples = 0
    mailbox_stats: list[dict[str, Any]] = []
    errors: list[str] = []

    learners = list_learning_mailbox_users(db)
    for user in learners:
        try:
            trash = inbox_module.list_messages(
                user,
                limit=LEARN_TRASH_PER_MAILBOX,
                offset=0,
                folder="trash",
            )
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{_norm_email(user.mailbox_email)}: {exc}"[:180])
            continue

        n = 0
        for msg in trash:
            from_email = _norm_email(msg.get("from_email"))
            if not from_email or "@" not in from_email:
                # try extract from from_header
                m = _EMAIL_RE.search(str(msg.get("from") or msg.get("from_name") or ""))
                from_email = _norm_email(m.group(0) if m else "")
            if not from_email:
                continue
            n += 1
            samples += 1
            sender_counts[from_email] += 1
            dom = _domain_of(from_email)
            if dom:
                domain_counts[dom] += 1
            for tok in _subject_tokens(msg.get("subject")):
                token_counts[tok] += 1
            cat = classify_email_triage(
                subject=str(msg.get("subject") or ""),
                body=str(msg.get("preview") or msg.get("snippet") or msg.get("body") or ""),
                from_email=from_email,
            )
            if cat:
                triage_counts[cat] += 1

        mailbox_stats.append(
            {
                "user_id": user.id,
                "email": _norm_email(user.mailbox_email),
                "trash_sampled": n,
            }
        )

    senders = {
        email: count
        for email, count in sender_counts.items()
        if count >= MIN_SENDER_HITS
    }
    domains = {
        domain: count
        for domain, count in domain_counts.items()
        if count >= MIN_DOMAIN_HITS
        and domain
        not in {
            "gmail.com",
            "googlemail.com",
            "yahoo.com",
            "outlook.com",
            "hotmail.com",
            "live.com",
            "icloud.com",
            "kafi-group.com",
        }
    }
    tokens = {
        tok: count
        for tok, count in token_counts.most_common(80)
        if count >= SUBJECT_TOKEN_MIN
    }

    ready = samples >= MIN_SAMPLES_READY and (len(senders) >= 5 or len(domains) >= 3)
    rules = {
        "senders": senders,
        "domains": domains,
        "subject_tokens": tokens,
        "triage_in_trash": dict(triage_counts),
        "mailbox_stats": mailbox_stats,
        "min_sender_hits": MIN_SENDER_HITS,
        "min_domain_hits": MIN_DOMAIN_HITS,
    }

    profile = get_or_create_profile(db)
    profile.ready = ready
    profile.rules = rules
    profile.samples_seen = samples
    profile.last_learned_at = _now()
    profile.updated_at = _now()
    db.commit()

    return {
        "ok": True,
        "ready": ready,
        "samples_seen": samples,
        "senders": len(senders),
        "domains": len(domains),
        "mailboxes": mailbox_stats,
        "errors": errors[:8],
        "last_learned_at": profile.last_learned_at.isoformat() if profile.last_learned_at else None,
    }


def match_reason(msg: dict[str, Any], rules: dict[str, Any]) -> str | None:
    """Return reason string if message should auto-trash; else None."""
    from_email = _norm_email(msg.get("from_email"))
    subject = str(msg.get("subject") or "")
    body = str(msg.get("preview") or msg.get("snippet") or msg.get("body") or "")

    # 1) Obvious lottery / prize / scam — do not wait for Trash training, and do
    # not let default triage (action_required) protect these.
    spam_reason = looks_like_obvious_spam_scam(subject=subject, body=body)
    if spam_reason:
        return spam_reason

    triage = classify_email_triage(subject=subject, body=body, from_email=from_email)
    if triage in PROTECTED_TRIAGE:
        return None

    senders = rules.get("senders") or {}
    domains = rules.get("domains") or {}
    tokens = rules.get("subject_tokens") or {}

    if from_email and from_email in senders:
        return f"known trash sender ({senders[from_email]}× in trash)"

    dom = _domain_of(from_email)
    if dom and dom in domains:
        # Domain alone is enough when triage also looks promotional
        if triage in {"newsletter", "advertising", "invites_exhibitions", "info", "tracking"}:
            return f"trash domain {dom} + {triage}"
        if int(domains[dom]) >= MIN_DOMAIN_HITS + 2:
            return f"frequent trash domain {dom}"

    hits = [t for t in _subject_tokens(subject) if t in tokens]
    if len(hits) >= 2 and triage in {"newsletter", "advertising"}:
        return f"subject tokens {', '.join(hits[:3])} + {triage}"

    return None


def already_logged(db: Session, user_id: int, message_key: str) -> bool:
    return (
        db.query(AutoTrashLog.id)
        .filter(AutoTrashLog.user_id == int(user_id), AutoTrashLog.message_key == message_key)
        .first()
        is not None
    )


def apply_for_user(db: Session, user: AppUser, *, limit: int = APPLY_INBOX_LIMIT) -> dict[str, Any]:
    """Scan one user's inbox and auto-move matching mail to Trash (no prompts)."""
    from modules import inbox as inbox_module

    settings = get_or_create_settings(db, user.id)
    if not settings.enabled:
        return {"user_id": user.id, "skipped": True, "reason": "disabled"}

    profile = get_or_create_profile(db)
    if not profile.ready:
        return {"user_id": user.id, "skipped": True, "reason": "profile_not_ready"}

    rules = profile.rules if isinstance(profile.rules, dict) else {}
    try:
        inbox_msgs = inbox_module.list_messages(user, limit=limit, offset=0, folder="inbox")
    except Exception as exc:  # noqa: BLE001
        return {"user_id": user.id, "error": str(exc)[:200], "moved": 0}

    moved = 0
    scanned = 0
    errors: list[str] = []

    for msg in inbox_msgs:
        scanned += 1
        key = _message_key(msg)
        if already_logged(db, user.id, key):
            continue
        reason = match_reason(msg, rules)
        if not reason:
            continue

        uid = str(msg.get("uid") or "").strip()
        folder = str(msg.get("folder") or "INBOX")
        if not uid:
            continue

        try:
            result = inbox_module.move_message(
                user, uid, from_folder=folder, to_folder="trash"
            )
        except Exception as exc:  # noqa: BLE001
            errors.append(str(exc)[:120])
            continue

        status = "moved" if result.get("status") == "ok" else "error"
        triage = classify_email_triage(
            subject=str(msg.get("subject") or ""),
            body=str(msg.get("preview") or msg.get("snippet") or ""),
            from_email=_norm_email(msg.get("from_email")),
        )
        try:
            db.add(
                AutoTrashLog(
                    user_id=user.id,
                    message_key=key[:512],
                    from_email=_norm_email(msg.get("from_email"))[:255] or None,
                    subject=str(msg.get("subject") or "")[:500] or None,
                    reason=reason[:255],
                    triage_category=triage,
                    status=status,
                )
            )
            db.commit()
        except Exception:  # noqa: BLE001
            db.rollback()
            # Unique race — treat as already handled
            continue

        if status == "moved":
            moved += 1
        else:
            errors.append(str(result.get("message") or "move failed")[:120])

    settings.last_scan_at = _now()
    db.commit()
    return {
        "user_id": user.id,
        "mailbox": _norm_email(user.mailbox_email),
        "scanned": scanned,
        "moved": moved,
        "errors": errors[:5],
    }


def process_enabled_users(db: Session | None = None) -> dict[str, Any]:
    """Apply Auto Trash for every user who has the toggle ON."""
    from db.session import SessionLocal

    # Keep profile warm: learn if never ready / stale (>24h).
    warm = SessionLocal()
    try:
        profile = get_or_create_profile(warm)
        last = profile.last_learned_at
        if last is not None and last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
        stale = last is None or (_now() - last).total_seconds() > 86400
        if not profile.ready or stale:
            learn_from_trash(warm)
    except Exception as exc:  # noqa: BLE001
        print(f"Auto Trash warm learn skipped: {exc}", flush=True)
    finally:
        warm.close()

    owns_db = db is None
    list_db = db or SessionLocal()
    try:
        user_ids = [
            int(uid)
            for (uid,) in list_db.query(AutoTrashSettings.user_id)
            .join(AppUser, AppUser.id == AutoTrashSettings.user_id)
            .filter(
                AutoTrashSettings.enabled.is_(True),
                AppUser.is_active.is_(True),
                AppUser.mailbox_enabled.is_(True),
            )
            .all()
        ]
    finally:
        if owns_db:
            list_db.close()

    totals = {"users": 0, "moved": 0, "results": []}
    for uid in user_ids:
        session = SessionLocal()
        try:
            user = session.get(AppUser, uid)
            if not user:
                continue
            totals["users"] += 1
            result = apply_for_user(session, user)
            totals["moved"] += int(result.get("moved") or 0)
            totals["results"].append(result)
        except Exception as exc:  # noqa: BLE001
            totals["results"].append({"user_id": uid, "error": str(exc)[:200]})
        finally:
            try:
                session.rollback()
            except Exception:  # noqa: BLE001
                pass
            session.close()
    return totals


def daily_stats(db: Session, *, days: int = 14) -> dict[str, Any]:
    """Day-wise auto-trash counts per user (for Trash folder log)."""
    days = max(1, min(90, int(days)))
    since = _now() - timedelta(days=days)
    day_col = func.date(func.timezone("UTC", AutoTrashLog.created_at))
    rows = (
        db.query(
            day_col.label("day"),
            AutoTrashLog.user_id,
            AppUser.username,
            AppUser.mailbox_email,
            AppUser.full_name,
            func.count(AutoTrashLog.id),
        )
        .join(AppUser, AppUser.id == AutoTrashLog.user_id)
        .filter(
            AutoTrashLog.created_at >= since,
            AutoTrashLog.status == "moved",
        )
        .group_by(day_col, AutoTrashLog.user_id, AppUser.username, AppUser.mailbox_email, AppUser.full_name)
        .order_by(day_col.desc(), func.count(AutoTrashLog.id).desc())
        .all()
    )

    by_day: dict[str, list[dict[str, Any]]] = {}
    for day, user_id, username, mailbox_email, full_name, count in rows:
        day_key = day.isoformat() if hasattr(day, "isoformat") else str(day)
        by_day.setdefault(day_key, []).append(
            {
                "user_id": int(user_id),
                "username": username,
                "full_name": full_name,
                "mailbox_email": mailbox_email,
                "count": int(count),
            }
        )

    days_out = [
        {
            "date": day,
            "total": sum(u["count"] for u in users),
            "users": users,
        }
        for day, users in by_day.items()
    ]
    days_out.sort(key=lambda d: d["date"], reverse=True)
    return {"days": days_out, "since": since.date().isoformat()}
