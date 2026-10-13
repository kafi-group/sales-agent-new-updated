from datetime import date

from sqlalchemy.orm import Session

from db.models import ScheduledEvent
from modules.scheduler import SchedulerModule

_scheduler = SchedulerModule()


def run(db: Session, today: date | None = None) -> list[ScheduledEvent]:
    return _scheduler.run_national_day_check(db, today)


if __name__ == "__main__":
    from db.session import SessionLocal

    session = SessionLocal()
    try:
        result = run(session)
        print(f"National day check: {len(result)} event(s)")
    finally:
        session.close()
