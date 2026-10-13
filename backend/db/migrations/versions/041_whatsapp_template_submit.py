"""WhatsApp template submission tracking and status notification events.

Revision ID: 041_whatsapp_template_submit
Revises: 040_lifecycle_meeting
Create Date: 2026-08-01
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect

revision: str = "041_whatsapp_template_submit"
down_revision: Union[str, None] = "040_lifecycle_meeting"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)

    wt_cols = {c["name"] for c in inspector.get_columns("whatsapp_templates")}
    if "submitted_by_user_id" not in wt_cols:
        op.add_column(
            "whatsapp_templates",
            sa.Column("submitted_by_user_id", sa.Integer(), nullable=True),
        )
        op.create_foreign_key(
            "fk_whatsapp_templates_submitted_by_user_id",
            "whatsapp_templates",
            "app_users",
            ["submitted_by_user_id"],
            ["id"],
            ondelete="SET NULL",
        )
    if "rejection_reason" not in wt_cols:
        op.add_column(
            "whatsapp_templates",
            sa.Column("rejection_reason", sa.Text(), nullable=True),
        )

    if "whatsapp_template_status_events" not in inspector.get_table_names():
        op.create_table(
            "whatsapp_template_status_events",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column(
                "template_id",
                sa.Integer(),
                sa.ForeignKey("whatsapp_templates.id", ondelete="CASCADE"),
                nullable=False,
                index=True,
            ),
            sa.Column(
                "user_id",
                sa.Integer(),
                sa.ForeignKey("app_users.id", ondelete="CASCADE"),
                nullable=False,
                index=True,
            ),
            sa.Column("event_type", sa.String(50), nullable=False),
            sa.Column("message", sa.String(500), nullable=False),
            sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.text("now()"),
                nullable=False,
            ),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    if "whatsapp_template_status_events" in inspector.get_table_names():
        op.drop_table("whatsapp_template_status_events")

    wt_cols = {c["name"] for c in inspector.get_columns("whatsapp_templates")}
    if "rejection_reason" in wt_cols:
        op.drop_column("whatsapp_templates", "rejection_reason")
    if "submitted_by_user_id" in wt_cols:
        op.drop_constraint(
            "fk_whatsapp_templates_submitted_by_user_id",
            "whatsapp_templates",
            type_="foreignkey",
        )
        op.drop_column("whatsapp_templates", "submitted_by_user_id")
