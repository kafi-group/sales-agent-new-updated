"""add market role to buyers

Revision ID: 002_market_role
Revises: 001_initial
Create Date: 2026-07-03

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "002_market_role"
down_revision: Union[str, None] = "001_initial"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

market_role_enum = sa.Enum(
    "consumer",
    "producer",
    "hybrid",
    "unknown",
    name="marketrole",
)


def upgrade() -> None:
    market_role_enum.create(op.get_bind(), checkfirst=True)
    op.add_column(
        "buyers",
        sa.Column(
            "market_role",
            market_role_enum,
            nullable=False,
            server_default="unknown",
        ),
    )
    op.add_column(
        "buyers",
        sa.Column("market_role_reasoning", sa.Text(), nullable=True),
    )
    op.add_column(
        "buyers",
        sa.Column("market_role_confidence", sa.Numeric(4, 2), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("buyers", "market_role_confidence")
    op.drop_column("buyers", "market_role_reasoning")
    op.drop_column("buyers", "market_role")
    market_role_enum.drop(op.get_bind(), checkfirst=True)
