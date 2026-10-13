"""add follow_up_at on buyers for manual reminders

Revision ID: 017_follow_up_at
Revises: 016_assigned_to
Create Date: 2026-07-14
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "017_follow_up_at"
down_revision: Union[str, None] = "016_assigned_to"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "buyers" not in inspector.get_table_names():
        return

    buyer_cols = {column["name"] for column in inspector.get_columns("buyers")}
    if "follow_up_at" not in buyer_cols:
        op.add_column(
            "buyers",
            sa.Column("follow_up_at", sa.DateTime(timezone=True), nullable=True),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "buyers" not in inspector.get_table_names():
        return

    buyer_cols = {column["name"] for column in inspector.get_columns("buyers")}
    if "follow_up_at" in buyer_cols:
        op.drop_column("buyers", "follow_up_at")
