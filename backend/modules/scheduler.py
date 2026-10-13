from datetime import date

from sqlalchemy.orm import Session

from db.models import (
    Buyer,
    ConsentStatus,
    Contact,
    EventType,
    ScheduledEvent,
    ScheduledEventStatus,
)
from modules.comms_generator import get_comms
from modules.national_days import get_national_day


class SchedulerModule:
    """Orchestrates daily scheduled checks — delegates to jobs/ scripts."""

    def run_birthday_check(self, db: Session, today: date | None = None) -> list[ScheduledEvent]:
        today = today or date.today()
        created: list[ScheduledEvent] = []
        comms = get_comms()

        for contact in db.query(Contact).all():
            if (
                contact.date_of_birth
                and contact.consent_status == ConsentStatus.granted
                and contact.date_of_birth.month == today.month
                and contact.date_of_birth.day == today.day
            ):
                event = self._create_event(
                    db,
                    contact,
                    EventType.birthday,
                    today,
                    f"Happy birthday, {contact.full_name}! Wishing you a wonderful day from Kafi Commodities.",
                    comms,
                )
                created.append(event)
        return created

    def run_national_day_check(self, db: Session, today: date | None = None) -> list[ScheduledEvent]:
        today = today or date.today()
        created: list[ScheduledEvent] = []
        comms = get_comms()

        for contact in db.query(Contact).all():
            buyer = db.get(Buyer, contact.buyer_id)
            national = get_national_day(buyer.country if buyer else None)
            if not national:
                continue
            month, day, holiday_name = national
            if month == today.month and day == today.day:
                event = self._create_event(
                    db,
                    contact,
                    EventType.national_day,
                    today,
                    f"Warm wishes on {holiday_name} to you and the team at "
                    f"{buyer.company_name if buyer else 'your company'}.",
                    comms,
                )
                created.append(event)
        return created

    def run_follow_up_check(self, db: Session, today: date | None = None) -> list[ScheduledEvent]:
        """Placeholder for quotation/export follow-up due dates."""
        _ = db, today
        return []

    def run_daily(self, db: Session, today: date | None = None) -> list[ScheduledEvent]:
        events: list[ScheduledEvent] = []
        events.extend(self.run_birthday_check(db, today))
        events.extend(self.run_national_day_check(db, today))
        events.extend(self.run_follow_up_check(db, today))
        return events

    def _create_event(
        self,
        db: Session,
        contact: Contact,
        event_type: EventType,
        trigger_date: date,
        message: str,
        comms,
    ) -> ScheduledEvent:
        existing = (
            db.query(ScheduledEvent)
            .filter(
                ScheduledEvent.contact_id == contact.id,
                ScheduledEvent.event_type == event_type,
                ScheduledEvent.trigger_date == trigger_date,
            )
            .first()
        )
        if existing:
            return existing

        event = ScheduledEvent(
            contact_id=contact.id,
            event_type=event_type,
            trigger_date=trigger_date,
            status=ScheduledEventStatus.draft_created,
            message_draft=message,
        )
        db.add(event)
        db.commit()
        db.refresh(event)

        if contact.consent_status == ConsentStatus.granted:
            comms.generate_email_draft(
                db,
                contact_id=contact.id,
                goal=event_type.value.replace("_", " "),
            )

        return event
