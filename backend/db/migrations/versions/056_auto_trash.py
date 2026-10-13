"""Auto Trash settings, global learn profile, and move log.

Revision ID: 056_auto_trash
Revises: 055_ai_sales_agent_state
"""

from typing import Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "056_auto_trash"
down_revision: Union[str, None] = "055_ai_sales_agent_state"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "auto_trash_settings",
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("app_users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("last_scan_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )

    op.create_table(
        "auto_trash_profile",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("ready", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column(
            "rules",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column("samples_seen", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_learned_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    op.execute(
        sa.text(
            "INSERT INTO auto_trash_profile (id, ready, rules, samples_seen) "
            "VALUES (1, false, '{}'::jsonb, 0) "
            "ON CONFLICT (id) DO NOTHING"
        )
    )

    op.create_table(
        "auto_trash_log",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("app_users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("message_key", sa.String(length=512), nullable=False),
        sa.Column("from_email", sa.String(length=255), nullable=True),
        sa.Column("subject", sa.String(length=500), nullable=True),
        sa.Column("reason", sa.String(length=255), nullable=True),
        sa.Column("triage_category", sa.String(length=64), nullable=True),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="moved"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
            index=True,
        ),
    )
    op.create_index(
        "ix_auto_trash_log_user_message",
        "auto_trash_log",
        ["user_id", "message_key"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("ix_auto_trash_log_user_message", table_name="auto_trash_log")
    op.drop_table("auto_trash_log")
    op.drop_table("auto_trash_profile")
    op.drop_table("auto_trash_settings")
