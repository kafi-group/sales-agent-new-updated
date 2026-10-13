"""Add remarks_03 and remarks_04 on buyers for targeted pool spreadsheets.

Revision ID: 044_buyer_remarks_03_04
Revises: 043_buyer_intake_method
Create Date: 2026-08-08
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect

revision: str = "044_buyer_remarks_03_04"
down_revision: Union[str, None] = "043_buyer_intake_method"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    cols = {c["name"] for c in inspect(bind).get_columns("buyers")}
    if "remarks_03" not in cols:
        op.add_column("buyers", sa.Column("remarks_03", sa.Text(), nullable=True))
    if "remarks_04" not in cols:
        op.add_column("buyers", sa.Column("remarks_04", sa.Text(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    cols = {c["name"] for c in inspect(bind).get_columns("buyers")}
    if "remarks_04" in cols:
        op.drop_column("buyers", "remarks_04")
    if "remarks_03" in cols:
        op.drop_column("buyers", "remarks_03")
