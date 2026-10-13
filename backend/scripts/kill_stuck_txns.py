"""One-shot: kill stuck idle-in-transaction backends blocking buyers updates."""
from sqlalchemy import text

from db.session import SessionLocal

db = SessionLocal()
try:
    stuck = db.execute(
        text(
            """
            SELECT pid, state, now() - xact_start AS age, left(query, 100) AS q
            FROM pg_stat_activity
            WHERE datname = current_database()
              AND pid <> pg_backend_pid()
              AND state = 'idle in transaction'
            """
        )
    ).fetchall()
    print("STUCK", len(stuck))
    for row in stuck:
        print(dict(row._mapping))
        ok = db.execute(
            text("SELECT pg_terminate_backend(:p)"), {"p": row[0]}
        ).scalar()
        print("term", row[0], ok)
    db.commit()
    print("done")
finally:
    db.close()
