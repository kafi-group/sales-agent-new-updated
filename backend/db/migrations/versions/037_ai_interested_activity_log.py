"""AI Mode interested clients activity log for Company lifecycle → Interested.

Revision ID: 037_ai_interested_activity_log
Revises: 036_interested_clients_list
Create Date: 2026-08-01
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "037_ai_interested_activity_log"
down_revision: Union[str, None] = "036_interested_clients_list"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "ai_interested_activity_log",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("app_users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("user_label", sa.String(length=100), nullable=False, server_default=""),
        sa.Column(
            "buyer_id",
            sa.Integer(),
            sa.ForeignKey("buyers.id", ondelete="SET NULL"),
            nullable=True,
            index=True,
        ),
        sa.Column("company_name", sa.String(length=255), nullable=False, server_default=""),
        sa.Column("event_type", sa.String(length=50), nullable=False, server_default="placed"),
        sa.Column("source", sa.String(length=50), nullable=False, server_default="manual"),
        sa.Column("message", sa.String(length=500), nullable=False, server_default=""),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
            index=True,
        ),
    )

    # Backfill one placed event per buyer already on Interested Clients (no user attribution).
    op.execute(
        """
        INSERT INTO ai_interested_activity_log (
            user_id, user_label, buyer_id, company_name, event_type, source, message, created_at
        )
        SELECT
            (SELECT id FROM app_users WHERE role = 'admin' ORDER BY id ASC LIMIT 1),
            'System',
            b.id,
            COALESCE(b.company_name, 'Unknown'),
            'placed',
            'backfill',
            'Imported from Interested Clients list',
            COALESCE(b.interested_clients_list_at, NOW())
        FROM buyers b
        WHERE b.interested_clients_list_at IS NOT NULL
          AND EXISTS (SELECT 1 FROM app_users WHERE role = 'admin')
        """
    )


def downgrade() -> None:
    op.drop_table("ai_interested_activity_log")
