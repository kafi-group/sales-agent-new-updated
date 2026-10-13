from enum import Enum

from sqlalchemy.orm import Session

from db.models import LeadScoreLabel
from modules.commerce import CommerceModule
from modules.comms_generator import CommsGenerator
from modules.lead_scoring import LeadScoringModule
from modules.research import ResearchModule
from modules.scheduler import SchedulerModule


class TriggerEvent(str, Enum):
    new_buyer = "new_buyer"
    inbound_message = "inbound_message"
    scheduled_job = "scheduled_job"
    manual_quotation = "manual_quotation"


class Orchestrator:
    """Routes events to the appropriate module(s)."""

    def __init__(self):
        self.research = ResearchModule()
        self.scoring = LeadScoringModule()
        self.commerce = CommerceModule()
        self.comms = CommsGenerator()
        self.scheduler = SchedulerModule()

    def handle_new_buyer(self, db: Session, buyer_id: int) -> dict:
        # Old-client / incomplete leads: discover website, city/address, phones,
        # emails, designation, and socials before research + score.
        enrichment: dict | None = None
        try:
            from modules.lead_discovery import enrich_existing_buyer

            enrichment = enrich_existing_buyer(db, buyer_id)
        except Exception as exc:
            enrichment = {"error": str(exc)}

        profile = self.research.research_buyer(db, buyer_id, force_refresh=True)
        score = self.scoring.score(db, profile)
        result: dict = {
            "buyer_id": buyer_id,
            "profile": profile,
            "score": score.score.value,
            "reasoning": score.reasoning,
            "enrichment": enrichment,
            "next_actions": [],
        }
        if score.score == LeadScoreLabel.AAA:
            result["next_actions"].append("notify_sales_rep")
            result["next_actions"].append("suggest_quotation")
        elif score.score == LeadScoreLabel.AA:
            result["next_actions"].append("queue_nurture_sequence")
            result["next_actions"].append("suggest_quotation")
        else:
            result["next_actions"].append("low_frequency_checkin")
        return result

    def handle_scheduled_job(self, db: Session) -> dict:
        events = self.scheduler.run_daily(db)
        return {"events_created": len(events), "event_ids": [e.id for e in events]}
