"""add app_users and sessions for dashboard login

Revision ID: 018_app_users
Revises: 017_follow_up_at
Create Date: 2026-07-14
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "018_app_users"
down_revision: Union[str, None] = "017_follow_up_at"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

app_user_role = postgresql.ENUM(
    "admin",
    "user",
    name="app_user_role",
    create_type=False,
)


def _ensure_app_user_role(bind) -> None:
    bind.execute(
        sa.text(
            """
            DO $$ BEGIN
                CREATE TYPE app_user_role AS ENUM ('admin', 'user');
            EXCEPTION
                WHEN duplicate_object THEN NULL;
            END $$;
            """
        )
    )


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    _ensure_app_user_role(bind)

    if "app_users" not in tables:
        op.create_table(
            "app_users",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("username", sa.String(length=100), nullable=False),
            sa.Column("full_name", sa.String(length=255), nullable=False),
            sa.Column("role", app_user_role, nullable=False, server_default="user"),
            sa.Column("password_hash", sa.String(length=512), nullable=False),
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        )
        op.create_index("ix_app_users_username", "app_users", ["username"], unique=True)

    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())
    if "app_user_sessions" not in tables:
        op.create_table(
            "app_user_sessions",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column(
                "user_id",
                sa.Integer(),
                sa.ForeignKey("app_users.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("token", sa.String(length=128), nullable=False),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        )
        op.create_index("ix_app_user_sessions_token", "app_user_sessions", ["token"], unique=True)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    if "app_user_sessions" in tables:
        op.drop_index("ix_app_user_sessions_token", table_name="app_user_sessions")
        op.drop_table("app_user_sessions")

    if "app_users" in tables:
        op.drop_index("ix_app_users_username", table_name="app_users")
        op.drop_table("app_users")

    op.execute("DROP TYPE IF EXISTS app_user_role")
