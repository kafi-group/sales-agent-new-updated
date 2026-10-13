"""AI Mode not interested clients activity log for Company lifecycle → Not Interested.

Revision ID: 039_not_interested_log
Revises: 038_ai_mode_enabled_at
Create Date: 2026-08-01
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect

revision: str = "039_not_interested_log"
down_revision: Union[str, None] = "038_ai_mode_enabled_at"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    if "ai_not_interested_activity_log" not in inspect(bind).get_table_names():
        op.create_table(
            "ai_not_interested_activity_log",
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
            sa.Column("source", sa.String(length=50), nullable=False, server_default="call"),
            sa.Column("message", sa.String(length=500), nullable=False, server_default=""),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.text("now()"),
                nullable=False,
                index=True,
            ),
        )

    # Backfill one placed event per buyer already on Not interested clients (latest call outcome).
    op.execute(
        """
        INSERT INTO ai_not_interested_activity_log (
            user_id, user_label, buyer_id, company_name, event_type, source, message, created_at
        )
        SELECT
            (SELECT id FROM app_users WHERE role = 'admin' ORDER BY id ASC LIMIT 1),
            'System',
            ranked.buyer_id,
            COALESCE(b.company_name, 'Unknown'),
            'placed',
            'backfill',
            'Imported from Not interested clients list',
            ranked.created_at
        FROM (
            SELECT DISTINCT ON (c.buyer_id)
                c.buyer_id,
                i.created_at
            FROM interactions i
            JOIN contacts c ON c.id = i.contact_id
            WHERE i.channel = 'phone'
              AND i.content ILIKE '%OUTCOME:%not_interested%'
            ORDER BY c.buyer_id, i.created_at DESC
        ) ranked
        JOIN buyers b ON b.id = ranked.buyer_id
        WHERE EXISTS (SELECT 1 FROM app_users WHERE role = 'admin')
          AND NOT EXISTS (
            SELECT 1 FROM ai_not_interested_activity_log existing
            WHERE existing.buyer_id = ranked.buyer_id
              AND existing.source = 'backfill'
          )
        """
    )


def downgrade() -> None:
    op.drop_table("ai_not_interested_activity_log")
