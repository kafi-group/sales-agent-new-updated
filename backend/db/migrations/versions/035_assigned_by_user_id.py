"""Add assigned_by_user_id so Leads Sent To only counts admin-sent leads.

Revision ID: 035_assigned_by_user_id
Revises: 034_ai_follow_up_activity_log
Create Date: 2026-07-31
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import bindparam

revision: str = "035_assigned_by_user_id"
down_revision: Union[str, None] = "034_ai_follow_up_activity_log"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    buyer_cols = {c["name"] for c in inspector.get_columns("buyers")}
    fk_names = {fk["name"] for fk in inspector.get_foreign_keys("buyers")}
    indexes = {ix["name"] for ix in inspector.get_indexes("buyers")}

    if "assigned_by_user_id" not in buyer_cols:
        op.add_column(
            "buyers",
            sa.Column("assigned_by_user_id", sa.Integer(), nullable=True),
        )

    # Legacy FK pointed at removed `users` table — replace with app_users.
    if "fk_buyers_assigned_by_user_id_users" in fk_names:
        op.drop_constraint(
            "fk_buyers_assigned_by_user_id_users",
            "buyers",
            type_="foreignkey",
        )
        fk_names.discard("fk_buyers_assigned_by_user_id_users")

    if "fk_buyers_assigned_by_user_id_app_users" not in fk_names:
        op.create_foreign_key(
            "fk_buyers_assigned_by_user_id_app_users",
            "buyers",
            "app_users",
            ["assigned_by_user_id"],
            ["id"],
            ondelete="SET NULL",
        )

    if "ix_buyers_assigned_by_user_id" not in indexes:
        op.create_index(
            "ix_buyers_assigned_by_user_id",
            "buyers",
            ["assigned_by_user_id"],
        )

    # Backfill from admin transfer log (buyer_ids JSON on each transfer event).
    if "ai_lead_transfer_log" not in inspector.get_table_names():
        return

    admin_ids = {
        int(r[0])
        for r in conn.execute(sa.text("SELECT id FROM app_users")).fetchall()
    }
    rows = conn.execute(
        sa.text(
            "SELECT by_user_id, buyer_ids FROM ai_lead_transfer_log "
            "WHERE buyer_ids IS NOT NULL ORDER BY id ASC"
        )
    ).fetchall()
    stmt = sa.text(
        "UPDATE buyers SET assigned_by_user_id = :by_id "
        "WHERE id IN :ids AND assigned_to_user_id IS NOT NULL"
    ).bindparams(bindparam("ids", expanding=True))
    for by_user_id, buyer_ids in rows:
        if not buyer_ids or by_user_id is None:
            continue
        by_id = int(by_user_id)
        if by_id not in admin_ids:
            continue
        ids = [int(x) for x in buyer_ids if x is not None]
        for start in range(0, len(ids), 200):
            chunk = ids[start : start + 200]
            if chunk:
                conn.execute(stmt, {"by_id": by_id, "ids": chunk})


def downgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    buyer_cols = {c["name"] for c in inspector.get_columns("buyers")}
    fk_names = {fk["name"] for fk in inspector.get_foreign_keys("buyers")}
    indexes = {ix["name"] for ix in inspector.get_indexes("buyers")}

    if "ix_buyers_assigned_by_user_id" in indexes:
        op.drop_index("ix_buyers_assigned_by_user_id", table_name="buyers")
    if "fk_buyers_assigned_by_user_id_app_users" in fk_names:
        op.drop_constraint(
            "fk_buyers_assigned_by_user_id_app_users",
            "buyers",
            type_="foreignkey",
        )
    if "assigned_by_user_id" in buyer_cols:
        op.drop_column("buyers", "assigned_by_user_id")
