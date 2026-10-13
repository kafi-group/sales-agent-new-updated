"""AI Mode lead transfer log for Assigned lifecycle tab.

Revision ID: 032_ai_lead_transfer_log
Revises: 031_ai_mode_query_log
Create Date: 2026-07-31
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "032_ai_lead_transfer_log"
down_revision: Union[str, None] = "031_ai_mode_query_log"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "ai_lead_transfer_log",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "by_user_id",
            sa.Integer(),
            sa.ForeignKey("app_users.id", ondelete="SET NULL"),
            nullable=True,
            index=True,
        ),
        sa.Column(
            "to_user_id",
            sa.Integer(),
            sa.ForeignKey("app_users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("to_label", sa.String(length=100), nullable=False, server_default=""),
        sa.Column("lead_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("buyer_ids", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("message", sa.String(length=500), nullable=False, server_default=""),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
            index=True,
        ),
    )


def downgrade() -> None:
    op.drop_table("ai_lead_transfer_log")
