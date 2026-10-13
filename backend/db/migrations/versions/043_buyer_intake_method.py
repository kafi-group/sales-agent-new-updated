"""Add intake_method on buyers for targeted pool upload vs discover toggle.

Revision ID: 043_buyer_intake_method
Revises: 042_personalized_followups
Create Date: 2026-08-08
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect

revision: str = "043_buyer_intake_method"
down_revision: Union[str, None] = "042_personalized_followups"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    cols = {c["name"] for c in inspect(bind).get_columns("buyers")}
    if "intake_method" in cols:
        return
    op.add_column(
        "buyers",
        sa.Column("intake_method", sa.String(40), nullable=True),
    )
    op.create_index("ix_buyers_intake_method", "buyers", ["intake_method"])


def downgrade() -> None:
    bind = op.get_bind()
    cols = {c["name"] for c in inspect(bind).get_columns("buyers")}
    if "intake_method" not in cols:
        return
    op.drop_index("ix_buyers_intake_method", table_name="buyers")
    op.drop_column("buyers", "intake_method")
