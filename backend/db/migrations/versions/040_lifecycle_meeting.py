"""Quotation Sent meeting schedule fields on ai_company_lifecycle.

Revision ID: 040_lifecycle_meeting
Revises: 039_not_interested_log
Create Date: 2026-08-01
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect

revision: str = "040_lifecycle_meeting"
down_revision: Union[str, None] = "039_not_interested_log"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    cols = {c["name"] for c in inspect(bind).get_columns("ai_company_lifecycle")}

    if "meeting_status" not in cols:
        op.add_column(
            "ai_company_lifecycle",
            sa.Column(
                "meeting_status",
                sa.String(length=30),
                nullable=False,
                server_default="not_scheduled",
            ),
        )
    if "meeting_at" not in cols:
        op.add_column(
            "ai_company_lifecycle",
            sa.Column("meeting_at", sa.DateTime(timezone=True), nullable=True),
        )
    if "meeting_reminder_sent_at" not in cols:
        op.add_column(
            "ai_company_lifecycle",
            sa.Column("meeting_reminder_sent_at", sa.DateTime(timezone=True), nullable=True),
        )


def downgrade() -> None:
    bind = op.get_bind()
    cols = {c["name"] for c in inspect(bind).get_columns("ai_company_lifecycle")}
    if "meeting_reminder_sent_at" in cols:
        op.drop_column("ai_company_lifecycle", "meeting_reminder_sent_at")
    if "meeting_at" in cols:
        op.drop_column("ai_company_lifecycle", "meeting_at")
    if "meeting_status" in cols:
        op.drop_column("ai_company_lifecycle", "meeting_status")
