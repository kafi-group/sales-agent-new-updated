"""Mail labels and compose drafts

Revision ID: 028_mail_labels_drafts
Revises: 027_lead_score_varchar
Create Date: 2026-07-28
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "028_mail_labels_drafts"
down_revision: Union[str, None] = "027_lead_score_varchar"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "mail_labels",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("app_users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("color", sa.String(length=32), nullable=False, server_default="#34d399"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_mail_labels_user_id", "mail_labels", ["user_id"])
    op.create_unique_constraint("uq_mail_labels_user_name", "mail_labels", ["user_id", "name"])

    op.create_table(
        "mail_label_assignments",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("label_id", sa.Integer(), sa.ForeignKey("mail_labels.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("app_users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("folder", sa.String(length=64), nullable=False, server_default="inbox"),
        sa.Column("message_uid", sa.String(length=128), nullable=False),
        sa.Column("message_id", sa.String(length=512), nullable=True),
        sa.Column("thread_id", sa.String(length=255), nullable=True),
        sa.Column("from_email", sa.String(length=255), nullable=True),
        sa.Column("subject_key", sa.String(length=255), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_mail_label_assignments_user_id", "mail_label_assignments", ["user_id"])
    op.create_index("ix_mail_label_assignments_label_id", "mail_label_assignments", ["label_id"])
    op.create_index(
        "ix_mail_label_assignments_lookup",
        "mail_label_assignments",
        ["user_id", "folder", "message_uid"],
    )
    op.create_unique_constraint(
        "uq_mail_label_assignment",
        "mail_label_assignments",
        ["user_id", "label_id", "folder", "message_uid"],
    )

    op.create_table(
        "mail_compose_drafts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("app_users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("to_addrs", sa.String(length=1000), nullable=False, server_default=""),
        sa.Column("cc_addrs", sa.String(length=1000), nullable=False, server_default=""),
        sa.Column("subject", sa.String(length=500), nullable=False, server_default=""),
        sa.Column("body", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_mail_compose_drafts_user_id", "mail_compose_drafts", ["user_id"])


def downgrade() -> None:
    op.drop_table("mail_compose_drafts")
    op.drop_table("mail_label_assignments")
    op.drop_table("mail_labels")
