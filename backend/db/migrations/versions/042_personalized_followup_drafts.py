"""Personalized post-call email/WhatsApp drafts from call captions.

Revision ID: 042_personalized_followups
Revises: 041_whatsapp_template_submit
Create Date: 2026-08-03
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect

revision: str = "042_personalized_followups"
down_revision: Union[str, None] = "041_whatsapp_template_submit"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    if "personalized_followup_drafts" in inspect(bind).get_table_names():
        return

    op.create_table(
        "personalized_followup_drafts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "interaction_id",
            sa.Integer(),
            sa.ForeignKey("interactions.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
        ),
        sa.Column(
            "buyer_id",
            sa.Integer(),
            sa.ForeignKey("buyers.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "contact_id",
            sa.Integer(),
            sa.ForeignKey("contacts.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_by_user_id",
            sa.Integer(),
            sa.ForeignKey("app_users.id", ondelete="SET NULL"),
            nullable=True,
            index=True,
        ),
        sa.Column("call_outcome", sa.String(40), nullable=False),
        sa.Column("status", sa.String(40), nullable=False, server_default="awaiting_transcript"),
        sa.Column("subject", sa.String(500), nullable=True),
        sa.Column("email_body", sa.Text(), nullable=True),
        sa.Column("whatsapp_body", sa.Text(), nullable=True),
        sa.Column("transcript_excerpt", sa.Text(), nullable=True),
        sa.Column("generation_error", sa.Text(), nullable=True),
        sa.Column("email_interaction_id", sa.Integer(), nullable=True),
        sa.Column("whatsapp_interaction_id", sa.Integer(), nullable=True),
        sa.Column("email_send_status", sa.String(40), nullable=True),
        sa.Column("whatsapp_send_status", sa.String(40), nullable=True),
        sa.Column("email_send_message", sa.Text(), nullable=True),
        sa.Column("whatsapp_send_message", sa.Text(), nullable=True),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )


def downgrade() -> None:
    bind = op.get_bind()
    if "personalized_followup_drafts" in inspect(bind).get_table_names():
        op.drop_table("personalized_followup_drafts")
