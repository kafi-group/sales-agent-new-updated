"""add indexes for leads table performance (source, country, buyer_id fks, interaction lookups)

Revision ID: 022_perf_indexes
Revises: 021_add_whatsapp
Create Date: 2026-07-22
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "022_perf_indexes"
down_revision: Union[str, None] = "021_add_whatsapp"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# (index_name, table_name, columns)
_INDEXES: list[tuple[str, str, list[str]]] = [
    ("ix_buyers_source", "buyers", ["source"]),
    ("ix_buyers_country", "buyers", ["country"]),
    ("ix_buyers_market_role", "buyers", ["market_role"]),
    ("ix_buyers_company_name", "buyers", ["company_name"]),
    ("ix_buyers_created_at", "buyers", ["created_at"]),
    ("ix_contacts_buyer_id", "contacts", ["buyer_id"]),
    ("ix_lead_scores_buyer_id", "lead_scores", ["buyer_id"]),
    ("ix_lead_scores_buyer_id_scored_at", "lead_scores", ["buyer_id", "scored_at"]),
    ("ix_interactions_contact_id", "interactions", ["contact_id"]),
    ("ix_interactions_channel", "interactions", ["channel"]),
    ("ix_interactions_created_at", "interactions", ["created_at"]),
    ("ix_export_history_buyer_id", "export_history", ["buyer_id"]),
]


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    for index_name, table_name, columns in _INDEXES:
        if table_name not in tables:
            continue
        existing = {idx["name"] for idx in inspector.get_indexes(table_name)}
        if index_name in existing:
            continue
        op.create_index(index_name, table_name, columns)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    for index_name, table_name, _columns in _INDEXES:
        if table_name not in tables:
            continue
        existing = {idx["name"] for idx in inspector.get_indexes(table_name)}
        if index_name not in existing:
            continue
        op.drop_index(index_name, table_name=table_name)
