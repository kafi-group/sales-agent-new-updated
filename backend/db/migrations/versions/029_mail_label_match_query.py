"""Add match_query to mail_labels for domain/URL auto-routing.

Revision ID: 029_mail_label_match_query
Revises: 028_mail_labels_drafts
Create Date: 2026-07-28
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "029_mail_label_match_query"
down_revision: Union[str, None] = "028_mail_labels_drafts"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "mail_labels",
        sa.Column("match_query", sa.String(length=255), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("mail_labels", "match_query")
