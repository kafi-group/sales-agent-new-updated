"""remove users table and lead assignment columns

Revision ID: 011_remove_users
Revises: 010_phone_channel
Create Date: 2026-07-08
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "011_remove_users"
down_revision: Union[str, None] = "010_phone_channel"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    if "buyers" in tables:
        buyer_cols = {column["name"] for column in inspector.get_columns("buyers")}
        fk_names = {fk["name"] for fk in inspector.get_foreign_keys("buyers")}

        if "fk_buyers_assigned_by_user_id_users" in fk_names:
            op.drop_constraint("fk_buyers_assigned_by_user_id_users", "buyers", type_="foreignkey")
        if "fk_buyers_assigned_user_id_users" in fk_names:
            op.drop_constraint("fk_buyers_assigned_user_id_users", "buyers", type_="foreignkey")

        if "assigned_by_user_id" in buyer_cols:
            op.drop_column("buyers", "assigned_by_user_id")
        if "assigned_user_id" in buyer_cols:
            op.drop_column("buyers", "assigned_user_id")
        if "assigned_at" in buyer_cols:
            op.drop_column("buyers", "assigned_at")

    if "users" in tables:
        op.drop_table("users")

    op.execute("DROP TYPE IF EXISTS userrole")


def downgrade() -> None:
    op.execute(
        """
        DO $$ BEGIN
            CREATE TYPE userrole AS ENUM ('admin', 'sales_manager', 'sales_agent');
        EXCEPTION
            WHEN duplicate_object THEN NULL;
        END $$;
        """
    )
    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("email", sa.String(length=255), nullable=False),
        sa.Column("full_name", sa.String(length=255), nullable=False),
        sa.Column(
            "role",
            sa.Enum("admin", "sales_manager", "sales_agent", name="userrole"),
            nullable=False,
            server_default="sales_agent",
        ),
        sa.Column("password_hash", sa.String(length=512), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_users_email", "users", ["email"], unique=True)

    op.add_column("buyers", sa.Column("assigned_user_id", sa.Integer(), nullable=True))
    op.add_column("buyers", sa.Column("assigned_by_user_id", sa.Integer(), nullable=True))
    op.add_column("buyers", sa.Column("assigned_at", sa.DateTime(timezone=True), nullable=True))
    op.create_foreign_key(
        "fk_buyers_assigned_user_id_users",
        "buyers",
        "users",
        ["assigned_user_id"],
        ["id"],
    )
    op.create_foreign_key(
        "fk_buyers_assigned_by_user_id_users",
        "buyers",
        "users",
        ["assigned_by_user_id"],
        ["id"],
    )
