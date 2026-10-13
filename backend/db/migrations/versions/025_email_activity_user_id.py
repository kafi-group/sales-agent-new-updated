"""Add user_id to email_activity_events for per-user scoping

Revision ID: 025_email_activity_user_id
Revises: 024_user_mailboxes
Create Date: 2026-07-24
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "025_email_activity_user_id"
down_revision: Union[str, None] = "024_user_mailboxes"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "email_activity_events",
        sa.Column("user_id", sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        "fk_email_activity_events_user_id_app_users",
        "email_activity_events",
        "app_users",
        ["user_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_email_activity_events_user_id",
        "email_activity_events",
        ["user_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_email_activity_events_user_id", table_name="email_activity_events")
    op.drop_constraint(
        "fk_email_activity_events_user_id_app_users",
        "email_activity_events",
        type_="foreignkey",
    )
    op.drop_column("email_activity_events", "user_id")
