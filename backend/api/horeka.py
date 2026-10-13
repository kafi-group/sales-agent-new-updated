"""API router for Horeka B2B Price List management, export, and email attachment."""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from api.schemas import EmailAttachmentRead
from db.session import get_db
from modules.horeka import (
    attach_horeka_price_list_as_attachment,
    create_horeka_item,
    delete_horeka_item,
    generate_horeka_excel,
    list_horeka_items,
    update_horeka_item,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/horeka", tags=["horeka"])


class HorekaItemCreate(BaseModel):
    category: str
    sub_category: Optional[str] = None
    brand: str = "ESSENCE"
    item_code: Optional[str] = None
    product_name: str
    packaging: str = "Standard Export Carton"
    unit: str = "USD/carton"
    standard_price: float = 0.0
    bulk_tier1_price: Optional[float] = None
    bulk_tier2_price: Optional[float] = None
    moq: Optional[str] = "10 Master Cartons"
    stock_status: str = "In Stock"
    notes: Optional[str] = None


class HorekaItemUpdate(BaseModel):
    category: Optional[str] = None
    sub_category: Optional[str] = None
    brand: Optional[str] = None
    item_code: Optional[str] = None
    product_name: Optional[str] = None
    packaging: Optional[str] = None
    unit: Optional[str] = None
    standard_price: Optional[float] = None
    bulk_tier1_price: Optional[float] = None
    bulk_tier2_price: Optional[float] = None
    moq: Optional[str] = None
    stock_status: Optional[str] = None
    notes: Optional[str] = None


@router.get("/items")
def get_horeka_items(
    category: Optional[str] = Query(default=None),
    search: Optional[str] = Query(default=None),
    stock_status: Optional[str] = Query(default=None),
    limit: int = Query(default=500, le=1000),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
):
    """List Horeka line items with optional category and search filters."""
    return list_horeka_items(
        db,
        category=category,
        search=search,
        stock_status=stock_status,
        limit=limit,
        offset=offset,
    )


@router.put("/items/{item_id}")
def update_item(
    item_id: int,
    payload: HorekaItemUpdate,
    db: Session = Depends(get_db),
):
    """Update line item prices, packaging, MOQ, or notes."""
    try:
        return update_horeka_item(db, item_id, payload.model_dump(exclude_unset=True))
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.post("/items", status_code=201)
def create_item(
    payload: HorekaItemCreate,
    db: Session = Depends(get_db),
):
    """Create a new Horeka line item."""
    return create_horeka_item(db, payload.model_dump())


@router.delete("/items/{item_id}")
def delete_item(
    item_id: int,
    db: Session = Depends(get_db),
):
    """Delete a Horeka line item."""
    success = delete_horeka_item(db, item_id)
    if not success:
        raise HTTPException(404, f"Item #{item_id} not found")
    return {"ok": True, "message": f"Item #{item_id} deleted"}


@router.get("/export-excel")
def export_excel(db: Session = Depends(get_db)):
    """Export formatted Excel spreadsheet of the Horeka B2B Price List."""
    excel_bytes = generate_horeka_excel(db)
    return Response(
        content=excel_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="Kafi_Horeka_B2B_Price_List.xlsx"'},
    )


@router.post("/attach", response_model=EmailAttachmentRead)
def attach_horeka_price_list(
    file_format: str = Query(default="excel"),
    db: Session = Depends(get_db),
):
    """Generate live Horeka B2B Price List and register as EmailAttachment."""
    att = attach_horeka_price_list_as_attachment(db, file_format=file_format)
    return EmailAttachmentRead(**att)
