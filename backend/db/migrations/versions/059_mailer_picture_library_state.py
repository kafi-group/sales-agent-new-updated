"""059 — Persist shared mailer picture library in Postgres."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "059_mailer_picture_library_state"
down_revision = "058_ai_sales_agent_run_log"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "mailer_picture_library_state" in inspector.get_table_names():
        return
    op.create_table(
        "mailer_picture_library_state",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column(
            "groups",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.execute(
        "INSERT INTO mailer_picture_library_state (id, groups) "
        "VALUES (1, '[]'::jsonb) "
        "ON CONFLICT (id) DO NOTHING"
    )


def downgrade() -> None:
    op.drop_table("mailer_picture_library_state")
