"""System recovery endpoints (admin) — reconnect DB pool without full redeploy."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy import text

from api.deps import get_session_token
from db.models import AppUserRole
from db.session import SessionLocal, engine
from modules import auth as auth_module

router = APIRouter(prefix="/system", tags=["system"])


def _require_admin_after_reconnect(token: str | None) -> None:
    """Authenticate after pool dispose so a dead pool does not block recovery."""
    db = SessionLocal()
    try:
        user = auth_module.get_user_by_token(db, token)
        if not user or not user.is_active:
            raise HTTPException(status_code=401, detail="Not authenticated")
        role = user.role.value if hasattr(user.role, "value") else str(user.role)
        if role != AppUserRole.admin.value:
            raise HTTPException(status_code=403, detail="Admin access required")
    finally:
        db.close()


@router.post("/reconnect-db")
def reconnect_database(
    token: str | None = Depends(get_session_token),
    x_recover_hint: str | None = Header(default=None, alias="x-recover-hint"),
) -> dict:
    """Dispose SQLAlchemy pool and verify Postgres is reachable again.

    Use when the app returns 503 / empty lists after overnight SSL drops.
    Does not restart Railway — if this endpoint itself 502s, redeploy the service.
    """
    _ = x_recover_hint  # reserved for future ops tooling
    disposed = False
    try:
        engine.dispose()
        disposed = True
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Could not dispose pool: {exc}") from exc

    db_ok = False
    db_error: str | None = None
    try:
        db = SessionLocal()
        try:
            db.execute(text("SELECT 1"))
            db_ok = True
        finally:
            db.close()
    except Exception as exc:  # noqa: BLE001
        db_error = str(exc)

    # Auth after reconnect so recovery works even when the old pool was dead.
    try:
        _require_admin_after_reconnect(token)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=f"DB reconnected but auth failed: {exc}") from exc

    if not db_ok:
        raise HTTPException(
            status_code=503,
            detail=f"Pool disposed but database still unreachable: {db_error or 'unknown'}",
        )

    return {
        "ok": True,
        "pool_disposed": disposed,
        "database": "connected",
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "note": (
            "Connection pool reset. Refresh the page. "
            "If the site still fails with 502, redeploy Kafi-Sales-Agent on Railway."
        ),
    }
