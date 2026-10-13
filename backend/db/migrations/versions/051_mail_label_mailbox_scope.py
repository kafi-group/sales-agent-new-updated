"""Scope mail label assignments to a mailbox (Asim multi-inbox).

Revision ID: 051_mail_label_mailbox_scope
Revises: 050_ai_training_selected
Create Date: 2026-09-11
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "051_mail_label_mailbox_scope"
down_revision: Union[str, None] = "050_ai_training_selected"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "mail_label_assignments",
        sa.Column("mailbox_user_id", sa.Integer(), nullable=True),
    )
    op.create_index(
        "ix_mail_label_assignments_mailbox_user_id",
        "mail_label_assignments",
        ["mailbox_user_id"],
    )
    # Existing rows: treat as belonging to the assigning user (single-mailbox users).
    op.execute(
        """
        UPDATE mail_label_assignments
        SET mailbox_user_id = user_id
        WHERE mailbox_user_id IS NULL
        """
    )
    op.alter_column(
        "mail_label_assignments",
        "mailbox_user_id",
        existing_type=sa.Integer(),
        nullable=False,
    )
    op.drop_constraint("uq_mail_label_assignment", "mail_label_assignments", type_="unique")
    op.create_unique_constraint(
        "uq_mail_label_assignment",
        "mail_label_assignments",
        ["user_id", "label_id", "folder", "message_uid", "mailbox_user_id"],
    )


def downgrade() -> None:
    op.drop_constraint("uq_mail_label_assignment", "mail_label_assignments", type_="unique")
    op.create_unique_constraint(
        "uq_mail_label_assignment",
        "mail_label_assignments",
        ["user_id", "label_id", "folder", "message_uid"],
    )
    op.drop_index(
        "ix_mail_label_assignments_mailbox_user_id",
        table_name="mail_label_assignments",
    )
    op.drop_column("mail_label_assignments", "mailbox_user_id")
