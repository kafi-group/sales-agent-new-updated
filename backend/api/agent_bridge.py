"""Read-only bridge for Kafi Main SaaS / PA dashboard (bank-recon-demo).

Authenticated with header: x-bridge-secret: <AGENT_BRIDGE_SECRET>
Server-side only — never expose the secret to browsers.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from api.deps import get_db, verify_agent_bridge_secret
from modules import agent_bridge as bridge_module

_BRIDGE_DEPS = [Depends(verify_agent_bridge_secret)]


def _mount_bridge_routes(router: APIRouter) -> None:
    @router.get("/summary")
    def agent_bridge_summary(db: Session = Depends(get_db)) -> dict:
        try:
            return bridge_module.bridge_summary(db)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(502, f"Could not build summary: {exc}") from exc

    @router.get("/leads")
    def agent_bridge_leads(
        limit: int = Query(default=20, ge=1, le=100),
        db: Session = Depends(get_db),
    ) -> dict:
        try:
            return bridge_module.bridge_leads(db, limit=limit)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(502, f"Could not list leads: {exc}") from exc

    @router.get("/pipeline")
    def agent_bridge_pipeline(db: Session = Depends(get_db)) -> dict:
        try:
            return bridge_module.bridge_pipeline(db)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(502, f"Could not load pipeline: {exc}") from exc

    @router.get("/calls")
    def agent_bridge_calls(
        limit: int = Query(default=20, ge=1, le=100),
        db: Session = Depends(get_db),
    ) -> dict:
        try:
            return bridge_module.bridge_calls(db, limit=limit)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(502, f"Could not list calls: {exc}") from exc

    @router.get("/meetings")
    def agent_bridge_meetings(
        limit: int = Query(default=100, ge=1, le=500),
        db: Session = Depends(get_db),
    ) -> dict:
        """Confirmed SCHEDULE MEETING rows for PA Travel & Loyalty (scheduled only)."""
        try:
            from modules import leads as leads_module

            items = leads_module.list_scheduled_meetings_for_bridge(db, limit=limit)
            return {"count": len(items), "meetings": items}
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(502, f"Could not list meetings: {exc}") from exc

    @router.get("/performance")
    def agent_bridge_performance(db: Session = Depends(get_db)) -> dict:
        try:
            return bridge_module.bridge_performance(db)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(502, f"Could not load performance: {exc}") from exc

    @router.get("/emails")
    def agent_bridge_emails(
        limit: int = Query(default=20, ge=1, le=100),
        db: Session = Depends(get_db),
    ) -> dict:
        try:
            return bridge_module.bridge_emails(db, limit=limit)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(502, f"Could not list emails: {exc}") from exc

    @router.post("/send-email")
    def agent_bridge_send_email(
        payload: dict,
        db: Session = Depends(get_db),
    ) -> dict:
        try:
            return bridge_module.send_bridge_email(db, payload)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(502, f"Could not send email: {exc}") from exc

    @router.post("/auto-reply-email")
    def agent_bridge_auto_reply_email(
        payload: dict,
        db: Session = Depends(get_db),
    ) -> dict:
        return bridge_module.auto_reply_bridge_email(db, payload)

    @router.get("/live-pricing")
    def agent_bridge_live_pricing(sku: str = Query(..., min_length=1)) -> dict:
        try:
            return bridge_module.fetch_live_pricing(sku)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(502, f"Could not fetch live pricing: {exc}") from exc

    @router.get("/live-card")
    def agent_bridge_live_card(
        sku: str = Query(..., min_length=1),
        format: str = Query(default="image"),
    ) -> dict:
        try:
            return bridge_module.fetch_pricing_card(sku, format_type=format)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(502, f"Could not fetch live pricing card: {exc}") from exc

    @router.get("/live-quotation-card")
    def agent_bridge_live_quotation_card(
        id: str = Query(..., min_length=1),
        format: str = Query(default="pdf"),
    ) -> dict:
        try:
            return bridge_module.fetch_quotation_card(id, format_type=format)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(502, f"Could not fetch live quotation card: {exc}") from exc

    @router.post("/attach-pricing-card")
    def agent_bridge_attach_pricing_card(payload: dict) -> dict:
        sku = str(payload.get("sku") or "").strip()
        if not sku:
            raise HTTPException(400, "sku is required")
        fmt = str(payload.get("format") or "image").strip()
        try:
            return bridge_module.attach_live_pricing_card(sku, format_type=fmt)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(502, f"Could not attach pricing card: {exc}") from exc

    @router.post("/attach-quotation-card")
    def agent_bridge_attach_quotation_card(payload: dict) -> dict:
        quotation_id = str(payload.get("quotation_id") or payload.get("id") or "").strip()
        if not quotation_id:
            raise HTTPException(400, "quotation_id is required")
        fmt = str(payload.get("format") or "pdf").strip()
        try:
            return bridge_module.attach_live_quotation_card(quotation_id, format_type=fmt)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(502, f"Could not attach quotation card: {exc}") from exc


router = APIRouter(
    prefix="/agent-bridge",
    tags=["agent-bridge"],
    dependencies=_BRIDGE_DEPS,
)
_mount_bridge_routes(router)

# Alias under /api/webhooks/ so the path bypasses session auth even on older deploys.
webhook_router = APIRouter(
    prefix="/webhooks/agent-bridge",
    tags=["agent-bridge"],
    dependencies=_BRIDGE_DEPS,
)
_mount_bridge_routes(webhook_router)

# Authenticated router for logged-in CRM users in the dashboard
from api.deps import get_current_user

user_router = APIRouter(
    prefix="/cnf-bridge",
    tags=["cnf-bridge"],
    dependencies=[Depends(get_current_user)],
)
_mount_bridge_routes(user_router)

