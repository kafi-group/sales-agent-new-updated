"""Add bulk_email_schedules for scheduled Vercel mailer campaigns.

Revision ID: 047_bulk_email_schedules
Revises: 046_whatsapp_personal_send
"""

from typing import Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "047_bulk_email_schedules"
down_revision: Union[str, None] = "046_whatsapp_personal_send"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "bulk_email_schedules",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("app_users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("mailbox_email", sa.String(length=255), nullable=False),
        sa.Column("username", sa.String(length=100), nullable=False),
        sa.Column("display_name", sa.String(length=255), nullable=True),
        sa.Column("buyer_ids", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("leads", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("subject", sa.String(length=500), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("scheduled_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("batch_size", sa.Integer(), nullable=False, server_default="10"),
        sa.Column("message_delay_seconds", sa.Float(), nullable=False, server_default="2"),
        sa.Column("batch_pause_seconds", sa.Float(), nullable=False, server_default="45"),
        sa.Column("status", sa.String(length=30), nullable=False, server_default="pending"),
        sa.Column("result_message", sa.Text(), nullable=True),
        sa.Column("executed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    op.create_index("ix_bulk_email_schedules_user_id", "bulk_email_schedules", ["user_id"])
    op.create_index("ix_bulk_email_schedules_scheduled_at", "bulk_email_schedules", ["scheduled_at"])
    op.create_index("ix_bulk_email_schedules_status", "bulk_email_schedules", ["status"])


def downgrade() -> None:
    op.drop_index("ix_bulk_email_schedules_status", table_name="bulk_email_schedules")
    op.drop_index("ix_bulk_email_schedules_scheduled_at", table_name="bulk_email_schedules")
    op.drop_index("ix_bulk_email_schedules_user_id", table_name="bulk_email_schedules")
    op.drop_table("bulk_email_schedules")
