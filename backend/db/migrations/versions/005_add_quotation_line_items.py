"""add quotation line items for multi-product quotes

Revision ID: 005_quotation_lines
Revises: 004_research_profile
Create Date: 2026-07-04

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "005_quotation_lines"
down_revision: Union[str, None] = "004_research_profile"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "quotation_line_items",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("quotation_id", sa.Integer(), nullable=False),
        sa.Column("product_id", sa.Integer(), nullable=False),
        sa.Column("quantity", sa.Numeric(12, 2), nullable=False),
        sa.Column("unit_price", sa.Numeric(12, 2), nullable=False),
        sa.Column("sort_order", sa.Integer(), server_default="0", nullable=False),
        sa.ForeignKeyConstraint(["product_id"], ["products.id"]),
        sa.ForeignKeyConstraint(["quotation_id"], ["quotations.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )

    conn = op.get_bind()
    rows = conn.execute(
        sa.text(
            "SELECT id, product_id, quantity, unit_price FROM quotations "
            "WHERE product_id IS NOT NULL"
        )
    ).fetchall()
    for row in rows:
        conn.execute(
            sa.text(
                "INSERT INTO quotation_line_items "
                "(quotation_id, product_id, quantity, unit_price, sort_order) "
                "VALUES (:qid, :pid, :qty, :price, 0)"
            ),
            {"qid": row[0], "pid": row[1], "qty": row[2], "price": row[3]},
        )

    op.alter_column("quotations", "product_id", existing_type=sa.Integer(), nullable=True)
    op.alter_column(
        "quotations",
        "quantity",
        existing_type=sa.Numeric(12, 2),
        nullable=True,
    )
    op.alter_column(
        "quotations",
        "unit_price",
        existing_type=sa.Numeric(12, 2),
        nullable=True,
    )


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(
        sa.text(
            """
            UPDATE quotations q SET
              product_id = li.product_id,
              quantity = li.quantity,
              unit_price = li.unit_price
            FROM (
              SELECT DISTINCT ON (quotation_id)
                quotation_id, product_id, quantity, unit_price
              FROM quotation_line_items
              ORDER BY quotation_id, sort_order, id
            ) li
            WHERE q.id = li.quotation_id AND q.product_id IS NULL
            """
        )
    )

    op.alter_column(
        "quotations",
        "unit_price",
        existing_type=sa.Numeric(12, 2),
        nullable=False,
    )
    op.alter_column(
        "quotations",
        "quantity",
        existing_type=sa.Numeric(12, 2),
        nullable=False,
    )
    op.alter_column("quotations", "product_id", existing_type=sa.Integer(), nullable=False)
    op.drop_table("quotation_line_items")
