from datetime import date

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from api.deps import get_db
from jobs.daily_birthday_check import run as run_birthday_check
from jobs.follow_up_scheduler import run as run_follow_up_check
from jobs.national_day_check import run as run_national_day_check

router = APIRouter(prefix="/jobs", tags=["scheduler"])


@router.post("/daily")
def run_daily_jobs(db: Session = Depends(get_db)):
    today = date.today()
    birthday_events = run_birthday_check(db, today)
    national_events = run_national_day_check(db, today)
    follow_up_events = run_follow_up_check(db, today)
    return {
        "events_created": len(birthday_events) + len(national_events) + len(follow_up_events),
        "birthday_event_ids": [e.id for e in birthday_events],
        "national_day_event_ids": [e.id for e in national_events],
        "follow_up_event_ids": [e.id for e in follow_up_events],
    }


@router.post("/birthdays")
def run_birthday_jobs(db: Session = Depends(get_db)):
    events = run_birthday_check(db)
    return {"events_created": len(events), "event_ids": [e.id for e in events]}


@router.post("/national-days")
def run_national_day_jobs(db: Session = Depends(get_db)):
    events = run_national_day_check(db)
    return {"events_created": len(events), "event_ids": [e.id for e in events]}


@router.post("/follow-ups")
def run_follow_up_jobs(db: Session = Depends(get_db)):
    events = run_follow_up_check(db)
    return {"events_created": len(events), "event_ids": [e.id for e in events]}
