"""Tag personal Baileys WhatsApp messages with the Sales Agent user.

Revision ID: 049_personal_whatsapp_user
Revises: 048_manual_kpi_entries
"""

from typing import Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect

revision: str = "049_personal_whatsapp_user"
down_revision: Union[str, None] = "048_manual_kpi_entries"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    cols = {c["name"] for c in inspector.get_columns("interactions")}
    if "personal_whatsapp_user_id" not in cols:
        op.add_column(
            "interactions",
            sa.Column("personal_whatsapp_user_id", sa.Integer(), nullable=True),
        )
    indexes = {i["name"] for i in inspector.get_indexes("interactions")}
    if "ix_interactions_personal_whatsapp_user_id" not in indexes:
        op.create_index(
            "ix_interactions_personal_whatsapp_user_id",
            "interactions",
            ["personal_whatsapp_user_id"],
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    indexes = {i["name"] for i in inspector.get_indexes("interactions")}
    if "ix_interactions_personal_whatsapp_user_id" in indexes:
        op.drop_index("ix_interactions_personal_whatsapp_user_id", table_name="interactions")
    cols = {c["name"] for c in inspector.get_columns("interactions")}
    if "personal_whatsapp_user_id" in cols:
        op.drop_column("interactions", "personal_whatsapp_user_id")
