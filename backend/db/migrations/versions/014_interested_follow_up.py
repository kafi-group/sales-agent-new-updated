"""add interested client follow-up tracking on buyers

Revision ID: 014_interested_follow_up
Revises: 013_old_client_fields
Create Date: 2026-07-12
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "014_interested_follow_up"
down_revision: Union[str, None] = "013_old_client_fields"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "buyers",
        sa.Column("interested_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "buyers",
        sa.Column("interested_follow_up_ack_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("buyers", "interested_follow_up_ack_at")
    op.drop_column("buyers", "interested_at")
