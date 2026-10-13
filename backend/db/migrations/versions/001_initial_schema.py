"""initial schema

Revision ID: 001_initial
Revises:
Create Date: 2026-07-01

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "001_initial"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "buyers",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("company_name", sa.String(length=255), nullable=False),
        sa.Column("website_url", sa.String(length=512), nullable=True),
        sa.Column("country", sa.String(length=100), nullable=True),
        sa.Column("industry", sa.String(length=255), nullable=True),
        sa.Column("linkedin_company_url", sa.String(length=512), nullable=True),
        sa.Column("source", sa.String(length=100), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "products",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("category", sa.String(length=100), nullable=True),
        sa.Column("spec_sheet", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("price_tiers", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("moq", sa.String(length=100), nullable=True),
        sa.Column("packaging_options", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("certifications", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "audit_logs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("entity_type", sa.String(length=100), nullable=False),
        sa.Column("entity_id", sa.Integer(), nullable=False),
        sa.Column("action", sa.String(length=100), nullable=False),
        sa.Column("actor", sa.String(length=255), nullable=True),
        sa.Column("details", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "contacts",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("buyer_id", sa.Integer(), nullable=False),
        sa.Column("full_name", sa.String(length=255), nullable=False),
        sa.Column("designation", sa.String(length=255), nullable=True),
        sa.Column("email", sa.String(length=255), nullable=True),
        sa.Column("phone", sa.String(length=50), nullable=True),
        sa.Column("linkedin_profile_url", sa.String(length=512), nullable=True),
        sa.Column("nationality", sa.String(length=100), nullable=True),
        sa.Column("date_of_birth", sa.Date(), nullable=True),
        sa.Column("preferred_language", sa.String(length=50), nullable=True),
        sa.Column(
            "consent_status",
            sa.Enum("unknown", "granted", "denied", name="consentstatus"),
            nullable=False,
        ),
        sa.Column("data_source", sa.String(length=100), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.ForeignKeyConstraint(["buyer_id"], ["buyers.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "export_history",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("buyer_id", sa.Integer(), nullable=False),
        sa.Column("product_id", sa.Integer(), nullable=False),
        sa.Column("order_date", sa.Date(), nullable=False),
        sa.Column("quantity", sa.Numeric(precision=12, scale=2), nullable=True),
        sa.Column("unit_price", sa.Numeric(precision=12, scale=2), nullable=True),
        sa.Column("destination_port", sa.String(length=255), nullable=True),
        sa.Column("incoterms", sa.String(length=20), nullable=True),
        sa.Column(
            "status",
            sa.Enum("pending", "shipped", "delivered", "cancelled", name="exportstatus"),
            nullable=True,
        ),
        sa.ForeignKeyConstraint(["buyer_id"], ["buyers.id"]),
        sa.ForeignKeyConstraint(["product_id"], ["products.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "lead_scores",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("buyer_id", sa.Integer(), nullable=False),
        sa.Column("score", sa.Enum("HOT", "WARM", "COLD", name="leadscorelabel"), nullable=False),
        sa.Column("reasoning", sa.Text(), nullable=False),
        sa.Column("score_factors", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("scored_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.ForeignKeyConstraint(["buyer_id"], ["buyers.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "quotations",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("buyer_id", sa.Integer(), nullable=False),
        sa.Column("product_id", sa.Integer(), nullable=False),
        sa.Column("quantity", sa.Numeric(precision=12, scale=2), nullable=False),
        sa.Column("unit_price", sa.Numeric(precision=12, scale=2), nullable=False),
        sa.Column("incoterms", sa.String(length=20), nullable=True),
        sa.Column("validity_date", sa.Date(), nullable=True),
        sa.Column(
            "status",
            sa.Enum("draft", "approved", "sent", "expired", name="quotationstatus"),
            nullable=True,
        ),
        sa.Column("pdf_path", sa.String(length=512), nullable=True),
        sa.Column("generated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["buyer_id"], ["buyers.id"]),
        sa.ForeignKeyConstraint(["product_id"], ["products.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "interactions",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("contact_id", sa.Integer(), nullable=False),
        sa.Column(
            "channel",
            sa.Enum("email", "whatsapp", "linkedin", "facebook", "instagram", name="channel"),
            nullable=False,
        ),
        sa.Column("direction", sa.Enum("inbound", "outbound", name="direction"), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("subject", sa.String(length=500), nullable=True),
        sa.Column("sentiment", sa.String(length=50), nullable=True),
        sa.Column("language", sa.String(length=50), nullable=True),
        sa.Column("handled_by", sa.Enum("agent", "human", name="handledby"), nullable=True),
        sa.Column(
            "status",
            sa.Enum("draft", "approved", "sent", "rejected", name="interactionstatus"),
            nullable=True,
        ),
        sa.Column("approved_by", sa.String(length=255), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.ForeignKeyConstraint(["contact_id"], ["contacts.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "scheduled_events",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("contact_id", sa.Integer(), nullable=False),
        sa.Column(
            "event_type",
            sa.Enum(
                "birthday",
                "national_day",
                "follow_up",
                "promotion_congrats",
                name="eventtype",
            ),
            nullable=False,
        ),
        sa.Column("trigger_date", sa.Date(), nullable=False),
        sa.Column(
            "status",
            sa.Enum("pending", "draft_created", "completed", "skipped", name="scheduledeventstatus"),
            nullable=True,
        ),
        sa.Column("message_draft", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=True),
        sa.ForeignKeyConstraint(["contact_id"], ["contacts.id"]),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    op.drop_table("scheduled_events")
    op.drop_table("interactions")
    op.drop_table("quotations")
    op.drop_table("lead_scores")
    op.drop_table("export_history")
    op.drop_table("contacts")
    op.drop_table("audit_logs")
    op.drop_table("products")
    op.drop_table("buyers")
    sa.Enum(name="scheduledeventstatus").drop(op.get_bind(), checkfirst=True)
    sa.Enum(name="eventtype").drop(op.get_bind(), checkfirst=True)
    sa.Enum(name="interactionstatus").drop(op.get_bind(), checkfirst=True)
    sa.Enum(name="handledby").drop(op.get_bind(), checkfirst=True)
    sa.Enum(name="direction").drop(op.get_bind(), checkfirst=True)
    sa.Enum(name="channel").drop(op.get_bind(), checkfirst=True)
    sa.Enum(name="quotationstatus").drop(op.get_bind(), checkfirst=True)
    sa.Enum(name="leadscorelabel").drop(op.get_bind(), checkfirst=True)
    sa.Enum(name="exportstatus").drop(op.get_bind(), checkfirst=True)
    sa.Enum(name="consentstatus").drop(op.get_bind(), checkfirst=True)
