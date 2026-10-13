"""add users and lead assignments

Revision ID: 008_users_assignments
Revises: 007_buyer_social_urls
Create Date: 2026-07-08

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "008_users_assignments"
down_revision: Union[str, None] = "007_buyer_social_urls"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

user_role = postgresql.ENUM(
    "admin",
    "sales_manager",
    "sales_agent",
    name="userrole",
    create_type=False,
)


def _ensure_userrole_enum(bind) -> None:
    """PostgreSQL-safe: skip if userrole already exists (partial prior run)."""
    bind.execute(
        sa.text(
            """
            DO $$ BEGIN
                CREATE TYPE userrole AS ENUM ('admin', 'sales_manager', 'sales_agent');
            EXCEPTION
                WHEN duplicate_object THEN NULL;
            END $$;
            """
        )
    )


def upgrade() -> None:
    bind = op.get_bind()
    _ensure_userrole_enum(bind)

    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    if "users" not in tables:
        op.create_table(
            "users",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("email", sa.String(length=255), nullable=False),
            sa.Column("full_name", sa.String(length=255), nullable=False),
            sa.Column("role", user_role, nullable=False, server_default="sales_agent"),
            sa.Column("password_hash", sa.String(length=512), nullable=False),
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        )
        op.create_index("ix_users_email", "users", ["email"], unique=True)
        tables.add("users")

    if "buyers" in tables:
        buyer_cols = {column["name"] for column in inspector.get_columns("buyers")}
        if "assigned_user_id" not in buyer_cols:
            op.add_column("buyers", sa.Column("assigned_user_id", sa.Integer(), nullable=True))
        if "assigned_at" not in buyer_cols:
            op.add_column("buyers", sa.Column("assigned_at", sa.DateTime(timezone=True), nullable=True))

        inspector = sa.inspect(bind)
        fk_names = {fk.get("name") for fk in inspector.get_foreign_keys("buyers")}
        if "fk_buyers_assigned_user_id_users" not in fk_names and "users" in tables:
            op.create_foreign_key(
                "fk_buyers_assigned_user_id_users",
                "buyers",
                "users",
                ["assigned_user_id"],
                ["id"],
            )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    if "buyers" in tables:
        fk_names = {fk.get("name") for fk in inspector.get_foreign_keys("buyers")}
        if "fk_buyers_assigned_user_id_users" in fk_names:
            op.drop_constraint("fk_buyers_assigned_user_id_users", "buyers", type_="foreignkey")

        buyer_cols = {column["name"] for column in inspector.get_columns("buyers")}
        if "assigned_at" in buyer_cols:
            op.drop_column("buyers", "assigned_at")
        if "assigned_user_id" in buyer_cols:
            op.drop_column("buyers", "assigned_user_id")

    if "users" in tables:
        op.drop_index("ix_users_email", table_name="users")
        op.drop_table("users")

    user_role.drop(bind, checkfirst=True)
