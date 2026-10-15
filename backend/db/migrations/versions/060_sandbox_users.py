"""060 — Sandbox test accounts and private copies of shared content."""

from alembic import op
import sqlalchemy as sa


revision = "060_sandbox_users"
down_revision = "059_mailer_picture_library_state"
branch_labels = None
depends_on = None


def _has_column(inspector, table: str, column: str) -> bool:
    if table not in inspector.get_table_names():
        return False
    return column in {col["name"] for col in inspector.get_columns(table)}


def _add_bool(inspector, table: str, column: str) -> None:
    if _has_column(inspector, table, column):
        return
    op.add_column(
        table,
        sa.Column(column, sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def _add_owner(inspector, table: str) -> None:
    if _has_column(inspector, table, "owner_user_id"):
        return
    op.add_column(table, sa.Column("owner_user_id", sa.Integer(), nullable=True))
    op.create_index(f"ix_{table}_owner_user_id", table, ["owner_user_id"])
    op.create_foreign_key(
        f"fk_{table}_owner_user_id",
        table,
        "app_users",
        ["owner_user_id"],
        ["id"],
        ondelete="SET NULL",
    )


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    _add_bool(inspector, "app_users", "is_sandbox")
    _add_owner(inspector, "email_templates")
    _add_owner(inspector, "custom_lead_modules")
    _add_owner(inspector, "horeka_line_items")


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    for table in ("horeka_line_items", "custom_lead_modules", "email_templates"):
        if not _has_column(inspector, table, "owner_user_id"):
            continue
        op.drop_constraint(f"fk_{table}_owner_user_id", table, type_="foreignkey")
        op.drop_index(f"ix_{table}_owner_user_id", table_name=table)
        op.drop_column(table, "owner_user_id")
    if _has_column(inspector, "app_users", "is_sandbox"):
        op.drop_column("app_users", "is_sandbox")
