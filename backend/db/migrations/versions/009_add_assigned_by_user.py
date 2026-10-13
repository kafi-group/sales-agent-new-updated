"""add assigned_by_user_id for sent leads tracking

Revision ID: 009_assigned_by_user
Revises: 008_users_assignments
Create Date: 2026-07-08

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "009_assigned_by_user"
down_revision: Union[str, None] = "008_users_assignments"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "buyers" not in inspector.get_table_names():
        return

    buyer_cols = {column["name"] for column in inspector.get_columns("buyers")}
    if "assigned_by_user_id" not in buyer_cols:
        op.add_column("buyers", sa.Column("assigned_by_user_id", sa.Integer(), nullable=True))

    inspector = sa.inspect(bind)
    fk_names = {fk.get("name") for fk in inspector.get_foreign_keys("buyers")}
    if "fk_buyers_assigned_by_user_id_users" not in fk_names:
        op.create_foreign_key(
            "fk_buyers_assigned_by_user_id_users",
            "buyers",
            "users",
            ["assigned_by_user_id"],
            ["id"],
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "buyers" not in inspector.get_table_names():
        return

    fk_names = {fk.get("name") for fk in inspector.get_foreign_keys("buyers")}
    if "fk_buyers_assigned_by_user_id_users" in fk_names:
        op.drop_constraint("fk_buyers_assigned_by_user_id_users", "buyers", type_="foreignkey")

    buyer_cols = {column["name"] for column in inspector.get_columns("buyers")}
    if "assigned_by_user_id" in buyer_cols:
        op.drop_column("buyers", "assigned_by_user_id")
