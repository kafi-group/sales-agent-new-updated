"""AI Mode settings, auto-reply log, company lifecycle, remarks history.

Revision ID: 030_ai_mode
Revises: 029_mail_label_match_query
Create Date: 2026-07-29
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "030_ai_mode"
down_revision: Union[str, None] = "029_mail_label_match_query"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "ai_mode_settings",
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("app_users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("email_auto_reply_enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("whatsapp_auto_reply_enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("form_url", sa.String(length=512), nullable=True),
        sa.Column("email_subject_template", sa.String(length=500), nullable=False, server_default=""),
        sa.Column("email_body_template", sa.Text(), nullable=False, server_default=""),
        sa.Column("whatsapp_body_template", sa.Text(), nullable=False, server_default=""),
        sa.Column("query_keywords", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("last_email_processed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )

    op.create_table(
        "ai_mode_auto_reply_log",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("app_users.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("channel", sa.String(length=32), nullable=False, index=True),
        sa.Column("message_key", sa.String(length=512), nullable=False, index=True),
        sa.Column("recipient", sa.String(length=255), nullable=True),
        sa.Column("subject", sa.String(length=500), nullable=True),
        sa.Column("preview", sa.Text(), nullable=True),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="sent"),
        sa.Column("detail", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False, index=True),
    )
    op.create_index(
        "ix_ai_mode_auto_reply_log_user_key",
        "ai_mode_auto_reply_log",
        ["user_id", "message_key"],
        unique=True,
    )

    op.create_table(
        "ai_company_lifecycle",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "buyer_id",
            sa.Integer(),
            sa.ForeignKey("buyers.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
            index=True,
        ),
        sa.Column("stage", sa.String(length=50), nullable=False, server_default="new_lead", index=True),
        sa.Column("stage_entered_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("history", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("updated_by_user_id", sa.Integer(), sa.ForeignKey("app_users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )

    op.add_column(
        "buyers",
        sa.Column("remarks_history", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("buyers", "remarks_history")
    op.drop_table("ai_company_lifecycle")
    op.drop_index("ix_ai_mode_auto_reply_log_user_key", table_name="ai_mode_auto_reply_log")
    op.drop_table("ai_mode_auto_reply_log")
    op.drop_table("ai_mode_settings")
