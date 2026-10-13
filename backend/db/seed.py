"""Seed sample data for local development."""

from datetime import date, timedelta

from sqlalchemy.orm import Session

from db.models import (
    Buyer,
    ConsentStatus,
    Contact,
    Product,
)


def seed_sample_data(db: Session) -> None:
    if db.query(Buyer).first():
        return

    buyer = Buyer(
        company_name="Gulf Foods Trading LLC",
        website_url="https://example.com/gulf-foods",
        country="UAE",
        industry="Food distribution",
        source="manual",
    )
    db.add(buyer)
    db.flush()

    contact = Contact(
        buyer_id=buyer.id,
        full_name="Ahmed Al-Rashid",
        designation="Procurement Manager",
        email="ahmed@gulffoods.example",
        phone="+971501234567",
        nationality="UAE",
        date_of_birth=date(1985, 3, 15),
        preferred_language="en",
        consent_status=ConsentStatus.granted,
        data_source="business_card",
    )
    db.add(contact)

    product = Product(
        name="Premium Basmati Rice",
        category="Grains",
        spec_sheet={"origin": "Pakistan", "grade": "Super Kernel", "moisture_max": "14%"},
        price_tiers={"standard": 850, "bulk_100mt": 820, "bulk_500mt": 790},
        moq="20 MT",
        packaging_options=["50kg PP bags", "1MT jumbo bags"],
        certifications=["ISO 22000", "Halal"],
    )
    db.add(product)
    db.commit()
