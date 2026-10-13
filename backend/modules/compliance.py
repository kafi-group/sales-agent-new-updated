from sqlalchemy.orm import Session

from db.models import Buyer, ConsentStatus, Contact


def get_consent_summary(db: Session) -> dict[str, int]:
    contacts = db.query(Contact).all()
    summary = {"total": len(contacts), "unknown": 0, "granted": 0, "denied": 0, "with_birthday": 0}
    for contact in contacts:
        status = contact.consent_status.value if contact.consent_status else "unknown"
        if status in summary:
            summary[status] += 1
        if contact.date_of_birth:
            summary["with_birthday"] += 1
    return summary


def list_contacts_compliance(
    db: Session,
    *,
    consent: str | None = None,
    q: str | None = None,
) -> list[dict]:
    query = db.query(Contact, Buyer).join(Buyer, Contact.buyer_id == Buyer.id)
    if consent and consent in {"unknown", "granted", "denied"}:
        query = query.filter(Contact.consent_status == ConsentStatus(consent))

    rows = query.order_by(Buyer.company_name.asc(), Contact.full_name.asc()).all()
    results: list[dict] = []
    search = (q or "").strip().lower()

    for contact, buyer in rows:
        row = {
            "id": contact.id,
            "buyer_id": buyer.id,
            "company_name": buyer.company_name,
            "country": buyer.country,
            "full_name": contact.full_name,
            "designation": contact.designation,
            "email": contact.email,
            "phone": contact.phone,
            "date_of_birth": contact.date_of_birth,
            "nationality": contact.nationality,
            "consent_status": contact.consent_status.value if contact.consent_status else "unknown",
            "preferred_language": contact.preferred_language,
            "birthday_outreach_ok": contact.consent_status == ConsentStatus.granted
            and contact.date_of_birth is not None,
            "whatsapp_opt_in": bool(contact.whatsapp_opt_in),
        }
        if search:
            haystack = " ".join(
                filter(
                    None,
                    [
                        row["company_name"],
                        row["full_name"],
                        row["email"],
                        row["country"],
                        row["consent_status"],
                    ],
                )
            ).lower()
            if search not in haystack:
                continue
        results.append(row)
    return results


def bulk_update_consent(
    db: Session,
    contact_ids: list[int],
    consent_status: str,
) -> int:
    status = ConsentStatus(consent_status)
    updated = 0
    for contact_id in contact_ids:
        contact = db.get(Contact, contact_id)
        if not contact:
            continue
        contact.consent_status = status
        updated += 1
    if updated:
        db.commit()
    return updated


def bulk_update_whatsapp_opt_in(
    db: Session,
    contact_ids: list[int],
    opt_in: bool,
) -> int:
    updated = 0
    for contact_id in contact_ids:
        contact = db.get(Contact, contact_id)
        if not contact:
            continue
        contact.whatsapp_opt_in = opt_in
        updated += 1
    if updated:
        db.commit()
    return updated
