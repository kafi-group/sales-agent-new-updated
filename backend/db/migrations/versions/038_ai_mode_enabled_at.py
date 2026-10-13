"""Track when AI Mode was enabled — auto-reply only for new mail after that moment.

Revision ID: 038_ai_mode_enabled_at
Revises: 037_ai_interested_activity_log
Create Date: 2026-08-01
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "038_ai_mode_enabled_at"
down_revision: Union[str, None] = "037_ai_interested_activity_log"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "ai_mode_settings",
        sa.Column("enabled_at", sa.DateTime(timezone=True), nullable=True),
    )
    # Do not auto-reply to inbox backlog — only mail arriving after this migration.
    op.execute(
        """
        UPDATE ai_mode_settings
        SET enabled_at = NOW()
        WHERE enabled = TRUE
        """
    )


def downgrade() -> None:
    op.drop_column("ai_mode_settings", "enabled_at")
