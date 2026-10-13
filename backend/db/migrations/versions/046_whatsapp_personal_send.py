"""Separate WhatsApp Personal send status on post-call drafts.

Revision ID: 046_whatsapp_personal_send
Revises: 045_mail_label_match_keyword
"""

from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "046_whatsapp_personal_send"
down_revision: Union[str, None] = "045_mail_label_match_keyword"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "personalized_followup_drafts",
        sa.Column("whatsapp_personal_send_status", sa.String(length=40), nullable=True),
    )
    op.add_column(
        "personalized_followup_drafts",
        sa.Column("whatsapp_personal_send_message", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("personalized_followup_drafts", "whatsapp_personal_send_message")
    op.drop_column("personalized_followup_drafts", "whatsapp_personal_send_status")
