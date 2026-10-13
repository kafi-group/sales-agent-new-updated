"""Manual KPI activity log (off-system work — matches Daily KPI Report spreadsheet).

Revision ID: 048_manual_kpi_entries
Revises: 047_bulk_email_schedules
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "048_manual_kpi_entries"
down_revision: Union[str, None] = "047_bulk_email_schedules"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "manual_kpi_entries",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("app_users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("activity_date", sa.Date(), nullable=False),
        sa.Column("person_name", sa.String(length=255), nullable=True),
        sa.Column("company", sa.String(length=500), nullable=True),
        sa.Column("country", sa.String(length=120), nullable=True),
        sa.Column("contact_type", sa.String(length=80), nullable=True),
        sa.Column("follow_up_type", sa.String(length=80), nullable=True),
        sa.Column("wechat_contacts", sa.String(length=40), nullable=True),
        sa.Column("remarks", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    op.create_index("ix_manual_kpi_entries_user_id", "manual_kpi_entries", ["user_id"])
    op.create_index("ix_manual_kpi_entries_activity_date", "manual_kpi_entries", ["activity_date"])


def downgrade() -> None:
    op.drop_index("ix_manual_kpi_entries_activity_date", table_name="manual_kpi_entries")
    op.drop_index("ix_manual_kpi_entries_user_id", table_name="manual_kpi_entries")
    op.drop_table("manual_kpi_entries")
