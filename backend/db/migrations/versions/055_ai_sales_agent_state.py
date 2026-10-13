"""Persist AI Sales Agent Sara/Rayan queue in Postgres.

Revision ID: 055_ai_sales_agent_state
Revises: 054_telegram_personal_templates
"""

from typing import Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "055_ai_sales_agent_state"
down_revision: Union[str, None] = "054_telegram_personal_templates"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ai_sales_agent_state",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("tasks", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("runners", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.execute(
        sa.text(
            "INSERT INTO ai_sales_agent_state (id, tasks, runners) "
            "VALUES (1, '[]'::jsonb, '[]'::jsonb) "
            "ON CONFLICT (id) DO NOTHING"
        )
    )


def downgrade() -> None:
    op.drop_table("ai_sales_agent_state")
