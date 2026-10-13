"""057 — lead_import_batches for admin Undo last import."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "057_lead_import_batches"
down_revision = "056_auto_trash"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "lead_import_batches",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("source", sa.String(length=100), nullable=False),
        sa.Column("buyer_ids", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("created_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_by_user_id", sa.Integer(), nullable=True),
        sa.Column("import_job_id", sa.String(length=64), nullable=True),
        sa.Column("rolled_back_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("rolled_back_by_user_id", sa.Integer(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["app_users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["rolled_back_by_user_id"], ["app_users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_lead_import_batches_source", "lead_import_batches", ["source"])
    op.create_index("ix_lead_import_batches_created_at", "lead_import_batches", ["created_at"])
    op.create_index(
        "ix_lead_import_batches_created_by_user_id",
        "lead_import_batches",
        ["created_by_user_id"],
    )
    op.create_index(
        "ix_lead_import_batches_import_job_id",
        "lead_import_batches",
        ["import_job_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_lead_import_batches_import_job_id", table_name="lead_import_batches")
    op.drop_index("ix_lead_import_batches_created_by_user_id", table_name="lead_import_batches")
    op.drop_index("ix_lead_import_batches_created_at", table_name="lead_import_batches")
    op.drop_index("ix_lead_import_batches_source", table_name="lead_import_batches")
    op.drop_table("lead_import_batches")
