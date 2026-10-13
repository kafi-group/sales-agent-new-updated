"""pg_trgm GIN indexes for ILIKE ("%term%") search — buyers + contacts free-text search/filters

Revision ID: 023_trgm_search_indexes
Revises: 022_perf_indexes
Create Date: 2026-07-22
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "023_trgm_search_indexes"
down_revision: Union[str, None] = "022_perf_indexes"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# (index_name, table_name, column)
_TRGM_INDEXES: list[tuple[str, str, str]] = [
    ("ix_trgm_buyers_company_name", "buyers", "company_name"),
    ("ix_trgm_buyers_country", "buyers", "country"),
    ("ix_trgm_buyers_industry", "buyers", "industry"),
    ("ix_trgm_buyers_company_grading", "buyers", "company_grading"),
    ("ix_trgm_buyers_product_interest", "buyers", "product_interest"),
    ("ix_trgm_buyers_city", "buyers", "city"),
    ("ix_trgm_buyers_address", "buyers", "address"),
    ("ix_trgm_buyers_remarks", "buyers", "remarks"),
    ("ix_trgm_buyers_assigned_to", "buyers", "assigned_to"),
    ("ix_trgm_contacts_full_name", "contacts", "full_name"),
    ("ix_trgm_contacts_email", "contacts", "email"),
    ("ix_trgm_contacts_phone", "contacts", "phone"),
    ("ix_trgm_contacts_designation", "contacts", "designation"),
    ("ix_trgm_contacts_secondary_mobile", "contacts", "secondary_mobile"),
    ("ix_trgm_contacts_primary_phone", "contacts", "primary_phone"),
    ("ix_trgm_contacts_secondary_phone", "contacts", "secondary_phone"),
    ("ix_trgm_contacts_secondary_email", "contacts", "secondary_email"),
]

# Plain btree indexes for the remaining exact-match filter columns that
# 022_perf_indexes didn't cover yet.
_BTREE_INDEXES: list[tuple[str, str, list[str]]] = [
    ("ix_buyers_city", "buyers", ["city"]),
    ("ix_buyers_company_grading", "buyers", ["company_grading"]),
]


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    # pg_trgm powers fast GIN indexes for ILIKE '%term%' style search — this
    # is what makes country/product/search filtering fast without needing a
    # dedicated search service. It's a standard, free Postgres extension and
    # is available on Supabase.
    try:
        op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    except Exception:
        # Without privileges to create the extension, skip trigram indexes
        # rather than failing the whole migration run — plain btree indexes
        # (below, and from 022_perf_indexes) still speed up exact filters.
        return

    for index_name, table_name, column in _TRGM_INDEXES:
        if table_name not in tables:
            continue
        existing = {idx["name"] for idx in inspector.get_indexes(table_name)}
        if index_name in existing:
            continue
        op.execute(
            f'CREATE INDEX "{index_name}" ON "{table_name}" '
            f'USING gin ("{column}" gin_trgm_ops)'
        )

    for index_name, table_name, columns in _BTREE_INDEXES:
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

    for index_name, table_name, _column in _TRGM_INDEXES:
        if table_name not in tables:
            continue
        existing = {idx["name"] for idx in inspector.get_indexes(table_name)}
        if index_name not in existing:
            continue
        op.drop_index(index_name, table_name=table_name)

    for index_name, table_name, _columns in _BTREE_INDEXES:
        if table_name not in tables:
            continue
        existing = {idx["name"] for idx in inspector.get_indexes(table_name)}
        if index_name not in existing:
            continue
        op.drop_index(index_name, table_name=table_name)
