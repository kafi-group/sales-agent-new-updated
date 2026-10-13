"""Add interested_clients_list_at for Interested Clients leads table.

Revision ID: 036_interested_clients_list
Revises: 035_assigned_by_user_id
Create Date: 2026-07-31
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "036_interested_clients_list"
down_revision: Union[str, None] = "035_assigned_by_user_id"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    buyer_cols = {c["name"] for c in inspector.get_columns("buyers")}
    indexes = {ix["name"] for ix in inspector.get_indexes("buyers")}

    if "interested_clients_list_at" not in buyer_cols:
        op.add_column(
            "buyers",
            sa.Column("interested_clients_list_at", sa.DateTime(timezone=True), nullable=True),
        )

    if "ix_buyers_interested_clients_list_at" not in indexes:
        op.create_index(
            "ix_buyers_interested_clients_list_at",
            "buyers",
            ["interested_clients_list_at"],
        )

    # Seed from existing Follow up (call-outcome interested) placements.
    op.execute(
        sa.text(
            """
            UPDATE buyers
            SET interested_clients_list_at = COALESCE(interested_at, NOW())
            WHERE interested_at IS NOT NULL
              AND interested_clients_list_at IS NULL
            """
        )
    )


def downgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    buyer_cols = {c["name"] for c in inspector.get_columns("buyers")}
    indexes = {ix["name"] for ix in inspector.get_indexes("buyers")}

    if "ix_buyers_interested_clients_list_at" in indexes:
        op.drop_index("ix_buyers_interested_clients_list_at", table_name="buyers")
    if "interested_clients_list_at" in buyer_cols:
        op.drop_column("buyers", "interested_clients_list_at")
