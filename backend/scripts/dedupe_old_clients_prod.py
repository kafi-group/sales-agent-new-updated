"""Dedupe Old clients only — production maintenance."""
from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from modules.leads import dedupe_leads_table, invalidate_section_counts_cache, count_leads_table_sections


def main() -> None:
    url = (os.environ.get("DATABASE_URL") or "").strip()
    if not url:
        raise SystemExit("DATABASE_URL required")
    Session = sessionmaker(bind=create_engine(url, pool_pre_ping=True))
    with Session() as db:
        db.execute(text("SET statement_timeout = '900s'"))
        before = count_leads_table_sections(db)
        print("Before master:", before.get("master"), "old_clients pool:", before.get("old_clients"))
        result = dedupe_leads_table(db, source="old_clients")
        db.commit()
        invalidate_section_counts_cache()
        after = count_leads_table_sections(db)
        print("Dedupe removed:", result.get("removed_count"))
        print("After master:", after.get("master"), "old_clients pool:", after.get("old_clients"))


if __name__ == "__main__":
    main()
