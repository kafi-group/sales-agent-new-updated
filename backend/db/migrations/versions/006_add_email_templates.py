"""add email templates for bulk outreach

Revision ID: 006_email_templates
Revises: 005_quotation_lines
Create Date: 2026-07-06

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "006_email_templates"
down_revision: Union[str, None] = "005_quotation_lines"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

DEFAULT_SUBJECT = "Kafi Commodities — ESSENCE products for [company_name]"
DEFAULT_BODY = """Dear [contact_name],

I hope this message finds you well. We at Kafi Commodities (Pakistan) export premium food products under the ESSENCE brand — including rice, chutneys, sauces, pickles, Himalayan salt, and spices.

We would be pleased to explore how our range could support [company_name] in [country].

Please let us know if you would like specifications, samples, or pricing for your market.

Best regards,
Kafi Commodities Export Team"""


def upgrade() -> None:
    op.create_table(
        "email_templates",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("subject", sa.String(length=500), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
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
        sa.PrimaryKeyConstraint("id"),
    )
    conn = op.get_bind()
    conn.execute(
        sa.text(
            "INSERT INTO email_templates (name, subject, body) "
            "VALUES (:name, :subject, :body)"
        ),
        {"name": "ESSENCE introduction", "subject": DEFAULT_SUBJECT, "body": DEFAULT_BODY},
    )


def downgrade() -> None:
    op.drop_table("email_templates")
