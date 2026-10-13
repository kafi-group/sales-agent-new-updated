"""Add buyer meeting schedule fields for SCHEDULE MEETING list / PA bridge.

Revision ID: 052_buyer_meeting_schedule
Revises: 051_mail_label_mailbox_scope
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "052_buyer_meeting_schedule"
down_revision: Union[str, None] = "051_mail_label_mailbox_scope"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "buyers",
        sa.Column("meeting_status", sa.String(length=40), nullable=True),
    )
    op.add_column(
        "buyers",
        sa.Column("meeting_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "buyers",
        sa.Column("meeting_location", sa.String(length=512), nullable=True),
    )
    op.add_column(
        "buyers",
        sa.Column("meeting_notes", sa.Text(), nullable=True),
    )
    op.add_column(
        "buyers",
        sa.Column("meeting_priority", sa.Integer(), nullable=True),
    )
    op.create_index("ix_buyers_meeting_status", "buyers", ["meeting_status"])
    op.create_index("ix_buyers_meeting_at", "buyers", ["meeting_at"])


def downgrade() -> None:
    op.drop_index("ix_buyers_meeting_at", table_name="buyers")
    op.drop_index("ix_buyers_meeting_status", table_name="buyers")
    op.drop_column("buyers", "meeting_priority")
    op.drop_column("buyers", "meeting_notes")
    op.drop_column("buyers", "meeting_location")
    op.drop_column("buyers", "meeting_at")
    op.drop_column("buyers", "meeting_status")
