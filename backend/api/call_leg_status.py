"""Live status of the customer leg of a dashboard call (read-only).

Own router, registered with a guard in main.py, so it can never affect the existing call routes.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from api.deps import get_current_user
from db.models import AppUser
from modules import call_leg_status as leg_module

router = APIRouter(prefix="/call-legs", tags=["calls"])


@router.get("/status")
def get_call_leg_status(
    call_sid: str = Query(..., description="Twilio call SID of the browser leg (CA…)"),
    _user: AppUser = Depends(get_current_user),
):
    """Sync handler on purpose: FastAPI runs it in the thread pool, so the Twilio lookup (with its own
    short timeout) can never block the event loop."""
    try:
        return leg_module.leg_status(call_sid)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception:  # noqa: BLE001 - a status lookup must never break the dialpad
        return {"status": "unknown", "twilio_status": None, "attempts": 0}
