"""add assigned_to on buyers

Revision ID: 016_assigned_to
Revises: 015_email_activity
Create Date: 2026-07-13
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "016_assigned_to"
down_revision: Union[str, None] = "015_email_activity"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "buyers" not in inspector.get_table_names():
        return

    buyer_cols = {column["name"] for column in inspector.get_columns("buyers")}
    if "assigned_to" not in buyer_cols:
        op.add_column(
            "buyers",
            sa.Column(
                "assigned_to",
                sa.String(length=50),
                nullable=False,
                server_default="unassigned",
            ),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "buyers" not in inspector.get_table_names():
        return

    buyer_cols = {column["name"] for column in inspector.get_columns("buyers")}
    if "assigned_to" in buyer_cols:
        op.drop_column("buyers", "assigned_to")
