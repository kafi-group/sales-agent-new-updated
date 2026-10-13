"""add old client spreadsheet fields to buyers and contacts

Revision ID: 013_old_client_fields
Revises: 012_email_attachments
Create Date: 2026-07-10
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "013_old_client_fields"
down_revision: Union[str, None] = "012_email_attachments"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("buyers", sa.Column("legacy_serial_no", sa.Integer(), nullable=True))
    op.add_column("buyers", sa.Column("company_grading", sa.String(length=50), nullable=True))
    op.add_column("buyers", sa.Column("product_interest", sa.String(length=512), nullable=True))
    op.add_column("buyers", sa.Column("city", sa.String(length=255), nullable=True))
    op.add_column("buyers", sa.Column("address", sa.Text(), nullable=True))
    op.add_column("buyers", sa.Column("remarks", sa.Text(), nullable=True))

    op.add_column("contacts", sa.Column("secondary_mobile", sa.String(length=50), nullable=True))
    op.add_column("contacts", sa.Column("primary_phone", sa.String(length=50), nullable=True))
    op.add_column("contacts", sa.Column("secondary_phone", sa.String(length=50), nullable=True))
    op.add_column("contacts", sa.Column("secondary_email", sa.String(length=255), nullable=True))


def downgrade() -> None:
    op.drop_column("contacts", "secondary_email")
    op.drop_column("contacts", "secondary_phone")
    op.drop_column("contacts", "primary_phone")
    op.drop_column("contacts", "secondary_mobile")

    op.drop_column("buyers", "remarks")
    op.drop_column("buyers", "address")
    op.drop_column("buyers", "city")
    op.drop_column("buyers", "product_interest")
    op.drop_column("buyers", "company_grading")
    op.drop_column("buyers", "legacy_serial_no")
