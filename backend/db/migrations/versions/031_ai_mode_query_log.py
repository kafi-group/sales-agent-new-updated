"""AI Mode inbound query log (per-user keyword-matched emails).

Revision ID: 031_ai_mode_query_log
Revises: 030_ai_mode
Create Date: 2026-07-31
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "031_ai_mode_query_log"
down_revision: Union[str, None] = "030_ai_mode"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "ai_mode_query_log",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("app_users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("message_key", sa.String(length=512), nullable=False),
        sa.Column("folder", sa.String(length=64), nullable=False, server_default="inbox"),
        sa.Column("uid", sa.String(length=128), nullable=False),
        sa.Column("from_email", sa.String(length=255), nullable=True),
        sa.Column("from_name", sa.String(length=255), nullable=True),
        sa.Column("subject", sa.String(length=500), nullable=True),
        sa.Column("preview", sa.Text(), nullable=True),
        sa.Column("received_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
            index=True,
        ),
    )
    op.create_index(
        "ix_ai_mode_query_log_user_key",
        "ai_mode_query_log",
        ["user_id", "message_key"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("ix_ai_mode_query_log_user_key", table_name="ai_mode_query_log")
    op.drop_table("ai_mode_query_log")
