"""add email attachments to interactions and templates

Revision ID: 012_email_attachments
Revises: 011_remove_users
Create Date: 2026-07-09
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "012_email_attachments"
down_revision: Union[str, None] = "011_remove_users"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "interactions",
        sa.Column("attachments", JSONB, nullable=False, server_default="[]"),
    )
    op.add_column(
        "email_templates",
        sa.Column("attachments", JSONB, nullable=False, server_default="[]"),
    )


def downgrade() -> None:
    op.drop_column("email_templates", "attachments")
    op.drop_column("interactions", "attachments")
