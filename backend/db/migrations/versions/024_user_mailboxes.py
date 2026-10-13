"""Per-user mailbox credentials on app_users

Revision ID: 024_user_mailboxes
Revises: 023_trgm_search_indexes
Create Date: 2026-07-23
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "024_user_mailboxes"
down_revision: Union[str, None] = "023_trgm_search_indexes"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("app_users", sa.Column("mailbox_email", sa.String(length=255), nullable=True))
    op.add_column(
        "app_users",
        sa.Column("mailbox_password_encrypted", sa.Text(), nullable=True),
    )
    op.add_column(
        "app_users",
        sa.Column("mailbox_display_name", sa.String(length=255), nullable=True),
    )
    op.add_column(
        "app_users",
        sa.Column(
            "mailbox_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
    )
    op.create_index("ix_app_users_mailbox_email", "app_users", ["mailbox_email"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_app_users_mailbox_email", table_name="app_users")
    op.drop_column("app_users", "mailbox_enabled")
    op.drop_column("app_users", "mailbox_display_name")
    op.drop_column("app_users", "mailbox_password_encrypted")
    op.drop_column("app_users", "mailbox_email")
