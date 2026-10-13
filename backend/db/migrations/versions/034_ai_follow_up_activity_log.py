"""AI Mode follow-up activity log for Follow-up lifecycle tab.

Revision ID: 034_ai_follow_up_activity_log
Revises: 033_ai_call_activity_log
Create Date: 2026-07-31
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "034_ai_follow_up_activity_log"
down_revision: Union[str, None] = "033_ai_call_activity_log"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "ai_follow_up_activity_log",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("app_users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("user_label", sa.String(length=100), nullable=False, server_default=""),
        sa.Column(
            "buyer_id",
            sa.Integer(),
            sa.ForeignKey("buyers.id", ondelete="SET NULL"),
            nullable=True,
            index=True,
        ),
        sa.Column("company_name", sa.String(length=255), nullable=False, server_default=""),
        sa.Column("event_type", sa.String(length=50), nullable=False, server_default="placed"),
        sa.Column("follow_up_at", sa.DateTime(timezone=True), nullable=True),
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
    op.drop_table("ai_follow_up_activity_log")
