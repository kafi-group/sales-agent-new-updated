"""add whatsapp cloud api support — contact fields, interaction fields, templates table

Revision ID: 021_add_whatsapp
Revises: 020_user_activity
Create Date: 2026-07-17

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "021_add_whatsapp"
down_revision: Union[str, None] = "020_user_activity"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    contact_columns = {c["name"] for c in inspector.get_columns("contacts")}
    if "wa_id" not in contact_columns:
        op.add_column("contacts", sa.Column("wa_id", sa.String(50), nullable=True))
    if "whatsapp_opt_in" not in contact_columns:
        op.add_column(
            "contacts",
            sa.Column(
                "whatsapp_opt_in",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            ),
        )
    if "whatsapp_window_expires_at" not in contact_columns:
        op.add_column(
            "contacts",
            sa.Column("whatsapp_window_expires_at", sa.DateTime(timezone=True), nullable=True),
        )

    interaction_columns = {c["name"] for c in inspector.get_columns("interactions")}
    if "provider_message_id" not in interaction_columns:
        op.add_column(
            "interactions", sa.Column("provider_message_id", sa.String(128), nullable=True)
        )
    if "template_name" not in interaction_columns:
        op.add_column("interactions", sa.Column("template_name", sa.String(255), nullable=True))
    if "wa_status" not in interaction_columns:
        op.add_column("interactions", sa.Column("wa_status", sa.String(50), nullable=True))

    # Re-inspect after possible column adds so index creation is safe on partial runs.
    inspector = sa.inspect(bind)
    interaction_columns = {c["name"] for c in inspector.get_columns("interactions")}
    existing_indexes = {idx["name"] for idx in inspector.get_indexes("interactions")}
    if (
        "provider_message_id" in interaction_columns
        and "ix_interactions_provider_message_id" not in existing_indexes
    ):
        op.create_index(
            "ix_interactions_provider_message_id",
            "interactions",
            ["provider_message_id"],
        )

    # Enum may already exist from a partial previous run; create_table must not
    # emit a second CREATE TYPE (use create_type=False).
    op.execute(
        """
        DO $$ BEGIN
            CREATE TYPE whatsapptemplatestatus AS ENUM (
                'approved', 'pending', 'rejected', 'paused', 'disabled'
            );
        EXCEPTION
            WHEN duplicate_object THEN null;
        END $$;
        """
    )
    whatsapp_template_status = postgresql.ENUM(
        "approved",
        "pending",
        "rejected",
        "paused",
        "disabled",
        name="whatsapptemplatestatus",
        create_type=False,
    )

    inspector = sa.inspect(bind)
    if "whatsapp_templates" not in inspector.get_table_names():
        op.create_table(
            "whatsapp_templates",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("meta_template_id", sa.String(128), nullable=True, unique=True),
            sa.Column("name", sa.String(255), nullable=False),
            sa.Column("category", sa.String(50), nullable=True),
            sa.Column("language", sa.String(20), nullable=False, server_default="en"),
            sa.Column(
                "status",
                whatsapp_template_status,
                nullable=False,
                server_default="pending",
            ),
            sa.Column("components", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
            sa.Column("body_text", sa.Text(), nullable=True),
            sa.Column("variable_count", sa.Integer(), nullable=False, server_default="0"),
            sa.Column(
                "synced_at",
                sa.DateTime(timezone=True),
                server_default=sa.text("now()"),
                nullable=False,
            ),
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
        op.create_index(
            "ix_whatsapp_templates_meta_template_id",
            "whatsapp_templates",
            ["meta_template_id"],
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if "whatsapp_templates" in inspector.get_table_names():
        op.drop_index("ix_whatsapp_templates_meta_template_id", table_name="whatsapp_templates")
        op.drop_table("whatsapp_templates")
    op.execute("DROP TYPE IF EXISTS whatsapptemplatestatus")

    interaction_columns = {c["name"] for c in inspector.get_columns("interactions")}
    if "wa_status" in interaction_columns:
        op.drop_column("interactions", "wa_status")
    if "template_name" in interaction_columns:
        op.drop_column("interactions", "template_name")
    if "provider_message_id" in interaction_columns:
        existing_indexes = {idx["name"] for idx in inspector.get_indexes("interactions")}
        if "ix_interactions_provider_message_id" in existing_indexes:
            op.drop_index("ix_interactions_provider_message_id", table_name="interactions")
        op.drop_column("interactions", "provider_message_id")

    contact_columns = {c["name"] for c in inspector.get_columns("contacts")}
    if "whatsapp_window_expires_at" in contact_columns:
        op.drop_column("contacts", "whatsapp_window_expires_at")
    if "whatsapp_opt_in" in contact_columns:
        op.drop_column("contacts", "whatsapp_opt_in")
    if "wa_id" in contact_columns:
        op.drop_column("contacts", "wa_id")
