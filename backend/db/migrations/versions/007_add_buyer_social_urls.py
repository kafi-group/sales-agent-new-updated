"""add buyer facebook and instagram urls

Revision ID: 007_buyer_social_urls
Revises: 006_email_templates
Create Date: 2026-07-07

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "007_buyer_social_urls"
down_revision: Union[str, None] = "006_email_templates"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("buyers", sa.Column("facebook_company_url", sa.String(length=512), nullable=True))
    op.add_column("buyers", sa.Column("instagram_company_url", sa.String(length=512), nullable=True))


def downgrade() -> None:
    op.drop_column("buyers", "instagram_company_url")
    op.drop_column("buyers", "facebook_company_url")
