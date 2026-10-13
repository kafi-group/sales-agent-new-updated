"""Add personal WhatsApp templates for QR/Baileys free-text reuse.

Revision ID: 053_whatsapp_personal_templates
Revises: 052_buyer_meeting_schedule
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "053_whatsapp_personal_templates"
down_revision: Union[str, None] = "052_buyer_meeting_schedule"
branch_labels = None
depends_on = None

DEFAULT_BODY = (
    "Dear {{name}},\n\n"
    "I hope this message finds you well. We at Kafi Commodities would like to connect "
    "with {{company}} regarding our ESSENCE product range.\n\n"
    "Please let us know if you would like specifications or current pricing.\n\n"
    "Best regards,\nKafi Commodities Export Team"
)


def upgrade() -> None:
    op.create_table(
        "whatsapp_personal_templates",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("created_by_user_id", sa.Integer(), nullable=True),
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
        sa.ForeignKeyConstraint(
            ["created_by_user_id"],
            ["app_users.id"],
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_whatsapp_personal_templates_created_by_user_id",
        "whatsapp_personal_templates",
        ["created_by_user_id"],
    )
    conn = op.get_bind()
    conn.execute(
        sa.text(
            "INSERT INTO whatsapp_personal_templates (name, body) "
            "VALUES (:name, :body)"
        ),
        {"name": "ESSENCE introduction", "body": DEFAULT_BODY},
    )


def downgrade() -> None:
    op.drop_index(
        "ix_whatsapp_personal_templates_created_by_user_id",
        table_name="whatsapp_personal_templates",
    )
    op.drop_table("whatsapp_personal_templates")
