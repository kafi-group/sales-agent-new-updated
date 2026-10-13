"""Move leads between master lists (admin only).

Own router, registered with a guard in main.py, so it can never affect the existing leads routes.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from api.deps import get_db, require_admin
from db.models import AppUser
from modules import master_list_move as master_list_move_module

router = APIRouter(prefix="/master-list-move", tags=["leads"])


class MoveToMasterListRequest(BaseModel):
    lead_ids: list[int] = Field(default_factory=list)
    target_master_type: str
    expected_count: int | None = None
    # Optional key of a user-created list to put the moved leads into (default: keep their section).
    target_section: str | None = None


@router.post("")
def move_leads_to_master_list(
    payload: MoveToMasterListRequest,
    db: Session = Depends(get_db),
    user: AppUser = Depends(require_admin),
):
    """Move exactly the given leads to another master list. Everything else stays attached."""
    unique = list(dict.fromkeys(int(x) for x in payload.lead_ids if int(x) > 0))
    if payload.expected_count is not None and payload.expected_count != len(unique):
        raise HTTPException(
            400,
            f"Selection mismatch: expected {payload.expected_count} leads but got {len(unique)}. "
            "Clear the selection and try again.",
        )
    try:
        return master_list_move_module.move_leads_to_master_list(
            db,
            lead_ids=unique,
            target_master_type=payload.target_master_type,
            by_username=user.username,
            target_section=payload.target_section,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
