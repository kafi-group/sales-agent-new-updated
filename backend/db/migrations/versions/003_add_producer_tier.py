"""add producer tier and conversion pct

Revision ID: 003_producer_tier
Revises: 002_market_role
Create Date: 2026-07-03

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "003_producer_tier"
down_revision: Union[str, None] = "002_market_role"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

producer_tier_enum = sa.Enum("strong", "weak", name="producertier")


def upgrade() -> None:
    producer_tier_enum.create(op.get_bind(), checkfirst=True)
    op.add_column("buyers", sa.Column("producer_tier", producer_tier_enum, nullable=True))
    op.add_column(
        "buyers",
        sa.Column("producer_conversion_pct", sa.Numeric(5, 2), nullable=True),
    )
    op.add_column(
        "buyers",
        sa.Column("producer_tier_reasoning", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("buyers", "producer_tier_reasoning")
    op.drop_column("buyers", "producer_conversion_pct")
    op.drop_column("buyers", "producer_tier")
    producer_tier_enum.drop(op.get_bind(), checkfirst=True)
