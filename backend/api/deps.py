"""Shared API dependencies."""

from __future__ import annotations

from fastapi import Depends, Header, HTTPException, Request
from sqlalchemy.orm import Session

from config import settings
from db.models import AppUser, AppUserRole
from db.session import SessionLocal, get_db
from modules import auth as auth_module

__all__ = [
    "get_db",
    "get_session_token",
    "get_bearer_token",
    "get_current_user",
    "get_current_user_released",
    "require_admin",
    "verify_agent_bridge_secret",
]


def get_session_token(
    request: Request,
    authorization: str | None = Header(default=None),
) -> str | None:
    """Session token from Bearer header or httpOnly cookie."""
    return auth_module.extract_session_token(
        authorization=authorization,
        cookies=request.cookies,
    )


# Back-compat alias used by older route signatures.
def get_bearer_token(
    request: Request,
    authorization: str | None = Header(default=None),
) -> str | None:
    return get_session_token(request, authorization)


def get_current_user(
    request: Request,
    db: Session = Depends(get_db),
    token: str | None = Depends(get_session_token),
) -> AppUser:
    # Middleware may already have validated the session — reuse that user id
    # so polling endpoints don't re-query app_user_sessions every time.
    user_id = getattr(request.state, "user_id", None)
    if user_id is not None:
        cached_user = auth_module.get_cached_user_by_id(int(user_id))
        if cached_user and cached_user.is_active:
            return cached_user
        try:
            user = db.get(AppUser, int(user_id))
            if user and user.is_active:
                auth_module.cache_user_object(user)
                return user
        except Exception:
            pass

    user = auth_module.get_user_by_token(db, token)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user


def get_current_user_released(
    request: Request,
    token: str | None = Depends(get_session_token),
) -> AppUser:
    """Load the user then close the DB session before the route runs.

    Use on IMAP/SMTP/LLM routes so long I/O does not pin a QueuePool connection
    (that was exhausting the pool under CRM + inbox polling on Railway).
    """
    # Fast-path: middleware already validated the session and the user is cached.
    # This avoids opening a DB connection at all on the vast majority of requests.
    user_id = getattr(request.state, "user_id", None)
    if user_id is not None:
        cached_user = auth_module.get_cached_user_by_id(int(user_id))
        if cached_user and cached_user.is_active:
            return cached_user

    db = SessionLocal()
    try:
        user: AppUser | None = None
        if user_id is not None:
            user = db.get(AppUser, int(user_id))
            if user and not user.is_active:
                user = None
        if user is None:
            user = auth_module.get_user_by_token(db, token)
        if not user:
            raise HTTPException(status_code=401, detail="Not authenticated")
        auth_module.cache_user_object(user)
        # Touch column attrs so they remain available after expunge.
        _ = (
            user.id,
            user.username,
            user.full_name,
            user.role,
            user.is_active,
            user.mailbox_email,
            user.mailbox_password_encrypted,
            user.mailbox_display_name,
            user.mailbox_enabled,
        )
        db.expunge(user)
        return user
    finally:
        db.close()


def require_admin(user: AppUser = Depends(get_current_user)) -> AppUser:
    role = user.role.value if isinstance(user.role, AppUserRole) else str(user.role)
    if role != AppUserRole.admin.value:
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


def verify_agent_bridge_secret(
    x_bridge_secret: str | None = Header(default=None, alias="x-bridge-secret"),
    authorization: str | None = Header(default=None, alias="authorization"),
) -> None:
    """Shared secret for bank-recon / PA / CNF bridge (supports x-bridge-secret or Authorization: Bearer)."""
    expected = (settings.agent_bridge_secret or "").strip()
    if not expected:
        raise HTTPException(status_code=503, detail="Agent bridge is not configured")
    provided = (x_bridge_secret or "").strip()
    if not provided and authorization:
        auth_clean = authorization.strip()
        if auth_clean.lower().startswith("bearer "):
            provided = auth_clean[7:].strip()
        else:
            provided = auth_clean
    if not provided or provided != expected:
        raise HTTPException(status_code=401, detail="Unauthorized")
