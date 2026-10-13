"""058 — AI Sales Agent assign/run activity log."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "058_ai_sales_agent_run_log"
down_revision = "057_lead_import_batches"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "ai_sales_agent_run_log" in inspector.get_table_names():
        return
    op.create_table(
        "ai_sales_agent_run_log",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=True),
        sa.Column(
            "user_label",
            sa.String(length=120),
            nullable=False,
            server_default=sa.text("''"),
        ),
        sa.Column("event_kind", sa.String(length=32), nullable=False),
        sa.Column(
            "persona",
            sa.String(length=32),
            nullable=False,
            server_default=sa.text("''"),
        ),
        sa.Column("queue_lane", sa.String(length=32), nullable=True),
        sa.Column(
            "contact_count",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column(
            "contacts",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column("note", sa.String(length=500), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["user_id"], ["app_users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_ai_sales_agent_run_log_user_id", "ai_sales_agent_run_log", ["user_id"])
    op.create_index(
        "ix_ai_sales_agent_run_log_event_kind", "ai_sales_agent_run_log", ["event_kind"]
    )
    op.create_index(
        "ix_ai_sales_agent_run_log_created_at", "ai_sales_agent_run_log", ["created_at"]
    )
    op.create_index("ix_ai_sales_agent_run_log_persona", "ai_sales_agent_run_log", ["persona"])


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "ai_sales_agent_run_log" not in inspector.get_table_names():
        return
    op.drop_index("ix_ai_sales_agent_run_log_persona", table_name="ai_sales_agent_run_log")
    op.drop_index("ix_ai_sales_agent_run_log_created_at", table_name="ai_sales_agent_run_log")
    op.drop_index("ix_ai_sales_agent_run_log_event_kind", table_name="ai_sales_agent_run_log")
    op.drop_index("ix_ai_sales_agent_run_log_user_id", table_name="ai_sales_agent_run_log")
    op.drop_table("ai_sales_agent_run_log")
