"""FastAPI endpoints for managing dynamic custom lead modules & testing lists."""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from api.deps import get_current_user, get_db
from db.models import AppUser, Buyer
from modules import custom_modules as cm_module

router = APIRouter(prefix="/leads/custom-modules", tags=["custom-modules"])


class CustomModuleCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=150)
    key: Optional[str] = Field(None, max_length=100)
    description: Optional[str] = None
    icon: Optional[str] = "📋"
    color: Optional[str] = "#3b82f6"


class CustomModuleUpdateRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    icon: Optional[str] = None
    color: Optional[str] = None
    is_enabled: Optional[bool] = None
    order_index: Optional[int] = None


class AddRecipientRequest(BaseModel):
    contact_name: Optional[str] = None
    company_name: Optional[str] = None
    email: Optional[str] = None
    secondary_email: Optional[str] = None
    primary_mobile: Optional[str] = None
    designation: Optional[str] = None
    country: Optional[str] = "Pakistan"
    city: Optional[str] = "Karachi"
    remarks: Optional[str] = None


@router.get("")
def get_custom_modules_list(
    include_disabled: bool = True,
    master_type: str = "fmcg",
    db: Session = Depends(get_db),
    user: AppUser = Depends(get_current_user),
) -> list[dict[str, Any]]:
    """List all custom & built-in modules with counts matching the leads table scope."""
    from modules.sandbox import owned_scope_user_id

    assignee = owned_scope_user_id(user)
    return cm_module.list_custom_modules(
        db,
        include_disabled=include_disabled,
        master_type=master_type or "fmcg",
        assigned_to_user_id=assignee,
        viewer=user,
    )


@router.post("")
def create_new_custom_module(
    payload: CustomModuleCreateRequest,
    db: Session = Depends(get_db),
    _user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Create a new custom lead list/module."""
    from modules.sandbox import is_sandbox_user

    try:
        return cm_module.create_custom_module(
            db,
            {
                **payload.model_dump(),
                "owner_user_id": _user.id if is_sandbox_user(_user) else None,
            },
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.patch("/{key}")
def update_module_settings(
    key: str,
    payload: CustomModuleUpdateRequest,
    db: Session = Depends(get_db),
    _user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Update settings or toggle visibility for a module."""
    try:
        return cm_module.update_custom_module(
            db, key, payload.model_dump(exclude_unset=True), viewer=_user
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.delete("/{key}")
def delete_module_list(
    key: str,
    db: Session = Depends(get_db),
    _user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Delete a custom module and reset its leads back to Old clients."""
    try:
        return cm_module.delete_custom_module(db, key, viewer=_user)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/{key}/seed-staff")
def seed_staff_for_testing(
    key: str,
    db: Session = Depends(get_db),
    _user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Seed or update Kafi Commodities staff members into the testing list."""
    from modules.sandbox import is_sandbox_user

    if is_sandbox_user(_user):
        raise HTTPException(403, "This test account cannot load company staff into a list")
    seeded = cm_module.seed_testing_staff(db)
    return {
        "status": "ok",
        "key": key,
        "seeded_count": len(seeded),
        "recipients": seeded,
    }


@router.post("/{key}/add-recipient")
def add_custom_recipient(
    key: str,
    payload: AddRecipientRequest,
    db: Session = Depends(get_db),
    _user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Add a custom staff or test recipient directly to this module."""
    try:
        module = cm_module._module_for(db, key)
        cm_module.assert_module_visible(db, module, _user)
        result = cm_module.add_recipient_to_module(db, key, payload.model_dump())
        from modules.sandbox import is_sandbox_user
        from modules.leads import apply_buyer_assignee

        if is_sandbox_user(_user):
            buyer = db.get(Buyer, result["id"])
            if buyer is not None:
                apply_buyer_assignee(db, buyer, _user.id)
                db.commit()
        return result
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
