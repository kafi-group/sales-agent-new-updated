"""Settings admin: Active Master Lists + AI Sales Agents (PIN 07860)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from api.deps import get_current_user, get_db, require_admin
from db.models import AppUser
from modules import org_admin_config as org
from modules import sales_assistant as assistant_module

router = APIRouter(prefix="/org-admin", tags=["org-admin"])


def _require_pin(pin: str | None) -> None:
    if not assistant_module.access_code_valid(pin):
        raise HTTPException(403, "Invalid access code. Please use access code: 07860")


class PinBody(BaseModel):
    pin: str = Field(..., min_length=1)


class MasterListUpsert(BaseModel):
    pin: str
    key: str | None = None
    label: str
    enabled: bool = True
    sort_order: int | None = None


class MasterListDelete(BaseModel):
    pin: str
    key: str


class UserAccessUpdate(BaseModel):
    pin: str
    user_id: int
    master_list_keys: list[str] = Field(default_factory=list)


class AgentAccessUpdate(BaseModel):
    pin: str
    agent_id: str
    master_list_keys: list[str] = Field(default_factory=list)


class AiAgentUpsert(BaseModel):
    pin: str
    id: str | None = None
    name: str
    active: bool = True
    product_focus: str = ""
    voice: str | None = None


class AiAgentDelete(BaseModel):
    pin: str
    id: str


@router.post("/unlock")
def unlock_org_admin(payload: PinBody, user: AppUser = Depends(require_admin)) -> dict[str, Any]:
    _ = user
    _require_pin(payload.pin)
    return {"ok": True, **org.admin_snapshot()}


@router.get("/master-lists")
def list_master_lists_for_me(
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Enabled master lists the current user may use in the sidebar."""
    role = user.role.value if hasattr(user.role, "value") else str(user.role)
    is_admin = role == "admin"
    keys = org.master_keys_for_user(user.id, is_admin=is_admin)
    all_enabled = org.get_master_lists(include_disabled=False)
    allowed = [r for r in all_enabled if r["key"] in keys]
    return {"master_lists": allowed}


@router.get("/master-lists/admin")
def list_master_lists_admin(
    pin: str,
    user: AppUser = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    _ = user
    _require_pin(pin)
    from modules import auth as auth_module

    users = [
        {
            "id": u.id,
            "username": u.username,
            "display_name": u.display_name,
            "role": u.role.value if hasattr(u.role, "value") else str(u.role),
        }
        for u in auth_module.list_users(db)
    ]
    return {
        "master_lists": org.get_master_lists(include_disabled=True),
        "user_master_access": org.get_user_master_access(),
        "agent_master_access": org.get_agent_master_access(),
        "users": users,
    }


@router.post("/master-lists")
def upsert_master_list(
    payload: MasterListUpsert,
    user: AppUser = Depends(require_admin),
) -> dict[str, Any]:
    _ = user
    _require_pin(payload.pin)
    try:
        row = org.upsert_master_list(
            key=payload.key,
            label=payload.label,
            enabled=payload.enabled,
            sort_order=payload.sort_order,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"ok": True, "master_list": row}


@router.post("/master-lists/delete")
def delete_master_list(
    payload: MasterListDelete,
    user: AppUser = Depends(require_admin),
) -> dict[str, Any]:
    _ = user
    _require_pin(payload.pin)
    try:
        org.delete_master_list(payload.key)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"ok": True}


@router.post("/master-lists/user-access")
def set_user_master_access(
    payload: UserAccessUpdate,
    user: AppUser = Depends(require_admin),
) -> dict[str, Any]:
    _ = user
    _require_pin(payload.pin)
    keys = org.set_user_master_access(payload.user_id, payload.master_list_keys)
    return {"ok": True, "user_id": payload.user_id, "master_list_keys": keys}


@router.post("/master-lists/agent-access")
def set_agent_master_access(
    payload: AgentAccessUpdate,
    user: AppUser = Depends(require_admin),
) -> dict[str, Any]:
    _ = user
    _require_pin(payload.pin)
    try:
        keys = org.set_agent_master_access(payload.agent_id, payload.master_list_keys)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"ok": True, "agent_id": payload.agent_id, "master_list_keys": keys}


@router.get("/ai-sales-agents")
def list_ai_agents(
    active_only: bool = False,
    master_type: str | None = None,
    user: AppUser = Depends(get_current_user),
) -> dict[str, Any]:
    """List AI Sales Agents. Optional master_type → only agents ticked for that Active Master List."""
    _ = user
    rows = org.list_ai_sales_agents(active_only=active_only)
    mt = (master_type or "").strip()
    if mt:
        rows = [r for r in rows if mt in org.master_keys_for_agent(str(r.get("id") or ""))]
    return {"agents": rows, "master_type": mt or None}


@router.post("/ai-sales-agents")
def upsert_ai_agent(
    payload: AiAgentUpsert,
    user: AppUser = Depends(require_admin),
) -> dict[str, Any]:
    _ = user
    _require_pin(payload.pin)
    try:
        row = org.upsert_ai_sales_agent(
            agent_id=payload.id,
            name=payload.name,
            active=payload.active,
            product_focus=payload.product_focus,
            voice=payload.voice,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    # Keep in-memory runners in sync without clearing the queue.
    try:
        from api import ai_sales_agent as asa

        asa.sync_runners_from_registry()
    except Exception:  # noqa: BLE001
        pass
    try:
        from modules import ai_sales_data_update as du

        du.ensure_persona_slots(org.active_agent_ids())
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True, "agent": row}


@router.post("/ai-sales-agents/delete")
def delete_ai_agent(
    payload: AiAgentDelete,
    user: AppUser = Depends(require_admin),
) -> dict[str, Any]:
    _ = user
    _require_pin(payload.pin)
    try:
        org.delete_ai_sales_agent(payload.id)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    try:
        from api import ai_sales_agent as asa

        asa.sync_runners_from_registry()
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True}
