"""Separate mail label keyword routing from domain routing.

Revision ID: 045_mail_label_match_keyword
Revises: 044_buyer_remarks_03_04
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "045_mail_label_match_keyword"
down_revision: Union[str, None] = "044_buyer_remarks_03_04"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "mail_labels",
        sa.Column("match_keyword", sa.String(length=255), nullable=True),
    )
    # Legacy: plain-text match_query values become keywords, not domains.
    op.execute(
        """
        UPDATE mail_labels
        SET match_keyword = match_query,
            match_query = NULL
        WHERE match_query IS NOT NULL
          AND match_query NOT LIKE '%@%'
          AND match_query NOT LIKE '%.%'
        """
    )


def downgrade() -> None:
    op.drop_column("mail_labels", "match_keyword")
