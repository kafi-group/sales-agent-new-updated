"""add phone channel for call interactions

Revision ID: 010_phone_channel
Revises: 009_assigned_by_user
Create Date: 2026-07-08

"""

from typing import Sequence, Union

from alembic import op

revision: str = "010_phone_channel"
down_revision: Union[str, None] = "009_assigned_by_user"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("ALTER TYPE channel ADD VALUE IF NOT EXISTS 'phone'")


def downgrade() -> None:
    # PostgreSQL does not support removing enum values safely.
    pass
