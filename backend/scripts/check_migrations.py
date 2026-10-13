"""Compare alembic_version in DB against migration files in repo."""

from __future__ import annotations

import re
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from sqlalchemy import create_engine, inspect, text

from config import settings

VERSIONS_DIR = BACKEND_DIR / "db" / "migrations" / "versions"


def load_revisions() -> dict[str, dict[str, str | None]]:
    revs: dict[str, dict[str, str | None]] = {}
    for path in sorted(VERSIONS_DIR.glob("*.py")):
        content = path.read_text(encoding="utf-8")
        rev_match = re.search(r'^revision:\s*str\s*=\s*"([^"]+)"', content, re.M)
        down_match = re.search(r"^down_revision:.*=\s*(.+)$", content, re.M)
        if not rev_match:
            continue
        rev = rev_match.group(1)
        down: str | None = None
        if down_match:
            raw = down_match.group(1).strip()
            if "None" not in raw:
                down = re.search(r'"([^"]+)"', raw)
                down = down.group(1) if down else raw.strip("'")
        revs[rev] = {"file": path.name, "down": down}
    return revs


def order_revisions(revs: dict[str, dict[str, str | None]]) -> list[str]:
    ordered: list[str] = []
    queue = [rev for rev, meta in revs.items() if meta["down"] is None]
    while queue:
        rev = queue.pop(0)
        ordered.append(rev)
        queue.extend(
            candidate
            for candidate, meta in revs.items()
            if meta["down"] == rev and candidate not in ordered
        )
    return ordered


def main() -> None:
    revs = load_revisions()
    ordered = order_revisions(revs)
    head = ordered[-1] if ordered else None

    engine = create_engine(settings.database_url)
    with engine.connect() as conn:
        try:
            rows = conn.execute(text("SELECT version_num FROM alembic_version")).fetchall()
            current = rows[0][0] if rows else None
        except Exception as exc:
            print(f"DB_QUERY_FAILED: {type(exc).__name__}: {exc}")
            return

    print(f"REPO_HEAD: {head}")
    print(f"DB_CURRENT: {current}")

    if current and current in ordered:
        pending = ordered[ordered.index(current) + 1 :]
        print(f"PENDING_COUNT: {len(pending)}")
        if pending:
            print("PENDING_MIGRATIONS:")
            for rev in pending:
                print(f"  - {rev} ({revs[rev]['file']})")
        else:
            print("STATUS: All migrations applied up to repo head.")
    elif current == head:
        print("STATUS: All migrations applied.")
    else:
        print(f"NOTE: Current revision {current!r} is not in the ordered chain.")

    insp = inspect(engine)
    tables = set(insp.get_table_names())
    cols = (
        {c["name"] for c in insp.get_columns("buyers")}
        if "buyers" in tables
        else set()
    )
    checks = {
        "035_assigned_by_user_id": "assigned_by_user_id" in cols,
        "036_interested_clients_list": "interested_clients_list_at" in cols,
        "037_ai_interested_activity_log": "ai_interested_activity_log" in tables,
        "039_not_interested_log": "ai_not_interested_activity_log" in tables,
        "038_ai_mode_enabled_at": "enabled_at" in {c["name"] for c in insp.get_columns("ai_mode_settings")} if "ai_mode_settings" in tables else False,
        "034_ai_follow_up_activity_log": "ai_follow_up_activity_log" in tables,
        "033_ai_call_activity_log": "ai_call_activity_log" in tables,
        "032_ai_lead_transfer_log": "ai_lead_transfer_log" in tables,
    }
    print("SCHEMA_CHECKS:")
    for rev, ok in checks.items():
        print(f"  {rev}: {'OK' if ok else 'MISSING'}")


if __name__ == "__main__":
    main()
