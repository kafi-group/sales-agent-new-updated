from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from api.deps import get_db
from api.schemas import (
    BulkConsentUpdate,
    ComplianceContactRead,
    ConsentSummaryRead,
    ContactUpdate,
)
from modules.audit import log_action
from modules import buyers as buyers_module
from modules.compliance import bulk_update_consent, get_consent_summary, list_contacts_compliance

router = APIRouter(prefix="/compliance", tags=["compliance"])


@router.get("/summary", response_model=ConsentSummaryRead)
def compliance_summary(db: Session = Depends(get_db)):
    return ConsentSummaryRead(**get_consent_summary(db))


@router.get("/contacts", response_model=list[ComplianceContactRead])
def list_compliance_contacts(
    consent: str | None = None,
    q: str | None = None,
    db: Session = Depends(get_db),
):
    return [ComplianceContactRead(**row) for row in list_contacts_compliance(db, consent=consent, q=q)]


@router.patch("/contacts/bulk")
def bulk_consent_update(payload: BulkConsentUpdate, db: Session = Depends(get_db)):
    if payload.consent_status not in {"unknown", "granted", "denied"}:
        raise HTTPException(400, "Invalid consent status")
    if not payload.contact_ids:
        raise HTTPException(400, "No contacts selected")
    updated = bulk_update_consent(db, payload.contact_ids, payload.consent_status)
    log_action(
        db,
        entity_type="contact",
        entity_id=0,
        action="bulk_consent_update",
        details={"count": updated, "consent_status": payload.consent_status},
    )
    return {"updated_count": updated}


@router.patch("/contacts/{contact_id}", response_model=ComplianceContactRead)
def update_compliance_contact(
    contact_id: int,
    payload: ContactUpdate,
    db: Session = Depends(get_db),
):
    contact = buyers_module.update_contact(
        db, contact_id, payload.model_dump(exclude_unset=True)
    )
    if not contact:
        raise HTTPException(404, "Contact not found")
    log_action(
        db,
        entity_type="contact",
        entity_id=contact.id,
        action="consent_updated",
        details={"consent_status": contact.consent_status.value},
    )
    from modules.compliance import list_contacts_compliance

    rows = list_contacts_compliance(db, q=None)
    row = next((r for r in rows if r["id"] == contact_id), None)
    if not row:
        raise HTTPException(404, "Contact not found")
    return ComplianceContactRead(**row)
