"""add email activity notifications

Revision ID: 015_email_activity
Revises: 014_interested_follow_up
Create Date: 2026-07-13
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "015_email_activity"
down_revision: Union[str, None] = "014_interested_follow_up"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "email_activity_events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("event_type", sa.String(length=64), nullable=False),
        sa.Column("severity", sa.String(length=20), nullable=False, server_default="info"),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("buyer_id", sa.Integer(), sa.ForeignKey("buyers.id"), nullable=True),
        sa.Column("contact_id", sa.Integer(), sa.ForeignKey("contacts.id"), nullable=True),
        sa.Column("interaction_id", sa.Integer(), sa.ForeignKey("interactions.id"), nullable=True),
        sa.Column("details", postgresql.JSONB(), nullable=True),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    op.create_index("ix_email_activity_events_created_at", "email_activity_events", ["created_at"])
    op.create_index("ix_email_activity_events_event_type", "email_activity_events", ["event_type"])
    op.create_index("ix_email_activity_events_read_at", "email_activity_events", ["read_at"])


def downgrade() -> None:
    op.drop_index("ix_email_activity_events_read_at", table_name="email_activity_events")
    op.drop_index("ix_email_activity_events_event_type", table_name="email_activity_events")
    op.drop_index("ix_email_activity_events_created_at", table_name="email_activity_events")
    op.drop_table("email_activity_events")
