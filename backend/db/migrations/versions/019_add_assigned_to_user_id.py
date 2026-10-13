"""add assigned_to_user_id on buyers for per-user lead assignment

Revision ID: 019_assigned_to_user
Revises: 018_app_users
Create Date: 2026-07-14
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "019_assigned_to_user"
down_revision: Union[str, None] = "018_app_users"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "buyers" not in inspector.get_table_names():
        return

    buyer_cols = {column["name"] for column in inspector.get_columns("buyers")}
    if "assigned_to_user_id" not in buyer_cols:
        op.add_column(
            "buyers",
            sa.Column("assigned_to_user_id", sa.Integer(), nullable=True),
        )

    inspector = sa.inspect(bind)
    fk_names = {fk.get("name") for fk in inspector.get_foreign_keys("buyers")}
    if "fk_buyers_assigned_to_user_id_app_users" not in fk_names:
        if "app_users" in inspector.get_table_names():
            op.create_foreign_key(
                "fk_buyers_assigned_to_user_id_app_users",
                "buyers",
                "app_users",
                ["assigned_to_user_id"],
                ["id"],
                ondelete="SET NULL",
            )

    inspector = sa.inspect(bind)
    indexes = {idx["name"] for idx in inspector.get_indexes("buyers")}
    if "ix_buyers_assigned_to_user_id" not in indexes:
        op.create_index(
            "ix_buyers_assigned_to_user_id",
            "buyers",
            ["assigned_to_user_id"],
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "buyers" not in inspector.get_table_names():
        return

    indexes = {idx["name"] for idx in inspector.get_indexes("buyers")}
    if "ix_buyers_assigned_to_user_id" in indexes:
        op.drop_index("ix_buyers_assigned_to_user_id", table_name="buyers")

    fk_names = {fk.get("name") for fk in inspector.get_foreign_keys("buyers")}
    if "fk_buyers_assigned_to_user_id_app_users" in fk_names:
        op.drop_constraint(
            "fk_buyers_assigned_to_user_id_app_users",
            "buyers",
            type_="foreignkey",
        )

    buyer_cols = {column["name"] for column in inspector.get_columns("buyers")}
    if "assigned_to_user_id" in buyer_cols:
        op.drop_column("buyers", "assigned_to_user_id")
