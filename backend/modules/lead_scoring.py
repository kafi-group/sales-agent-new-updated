"""Company-grade scoring (AAA / AA / A) — replaces HOT / WARM / COLD.

Grade reflects importer quality: product-range fit, market/country strength,
and business scale — not post-call “how warm they felt.”

AI / rule-based grades live only in ``lead_scores``. Spreadsheet
``buyers.company_grading`` is the imported Excel grade and must never be
copied into or overwritten by scoring. Sales may still edit company_grading
manually in the table.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from db.models import Contact, ExportHistory, Interaction, LeadScore, LeadScoreLabel
from modules.research import BuyerProfile

# Strong Kafi export markets — importers here score higher when other signals match.
_PRIORITY_MARKETS = {
    "united arab emirates",
    "uae",
    "saudi arabia",
    "qatar",
    "kuwait",
    "bahrain",
    "oman",
    "united kingdom",
    "germany",
    "netherlands",
    "france",
    "belgium",
    "united states",
    "canada",
    "australia",
    "singapore",
    "malaysia",
    "south africa",
}


def _country_is_priority(country: str | None) -> bool:
    if not country:
        return False
    from modules.countries import resolve_country_name

    resolved = (resolve_country_name(country) or country).strip().lower()
    return resolved in _PRIORITY_MARKETS or any(
        key in resolved for key in ("emirates", "saudi", "kingdom")
    )


def _scale_signals(profile: BuyerProfile) -> list[str]:
    blob = " ".join(
        [
            profile.website_summary or "",
            profile.relationship_context or "",
            " ".join(profile.signals or []),
            " ".join(profile.matched_categories or []),
        ]
    ).lower()
    hits: list[str] = []
    checks = [
        ("distributor", "distributor / wholesale language"),
        ("import", "import language"),
        ("export", "export / international language"),
        ("warehouse", "warehouse / logistics language"),
        ("supermarket", "retail / supermarket language"),
        ("horeca", "HORECA / foodservice language"),
        ("chain", "multi-outlet / chain language"),
        ("bulk", "bulk / wholesale volume language"),
        ("fcl", "container / FCL scale language"),
        ("multi-country", "multi-country footprint"),
        ("worldwide", "worldwide / global footprint"),
    ]
    for needle, label in checks:
        if needle in blob:
            hits.append(label)
    return hits


class LeadScoringModule:
    """Rule-based company grading (AAA / AA / A) with optional LLM reasoning."""

    def score(self, db: Session, profile: BuyerProfile) -> LeadScore:
        factors: list[dict[str, str | int | float]] = []
        points = 0

        exports = (
            db.query(ExportHistory)
            .filter(ExportHistory.buyer_id == profile.buyer_id)
            .all()
        )
        if exports:
            points += 35
            factors.append(
                {
                    "factor": "export_history",
                    "weight": 35,
                    "note": f"{len(exports)} past orders with Kafi — proven importer",
                }
            )
            total_value = sum(
                float(e.quantity or 0) * float(e.unit_price or 0) for e in exports
            )
            if total_value > 100_000:
                points += 20
                factors.append(
                    {
                        "factor": "order_value",
                        "weight": 20,
                        "note": "High lifetime value — large-scale account",
                    }
                )
            elif total_value > 25_000:
                points += 10
                factors.append(
                    {
                        "factor": "order_value",
                        "weight": 10,
                        "note": "Solid lifetime value",
                    }
                )

        if profile.raw.get("product_fit_score"):
            fit_pts = min(int(profile.raw["product_fit_score"]), 30)
            if fit_pts:
                points += fit_pts
                factors.append(
                    {
                        "factor": "product_range_fit",
                        "weight": fit_pts,
                        "note": (
                            "Product-range match: "
                            + (", ".join(profile.matched_categories[:5]) or "catalog keywords")
                        ),
                    }
                )

        for signal in profile.signals:
            if signal.startswith("Product fit:"):
                points += 6
                factors.append({"factor": "product_fit", "weight": 6, "note": signal})
            if "International/export" in signal:
                points += 5
                factors.append({"factor": "signal", "weight": 5, "note": signal})

        scale_hits = _scale_signals(profile)
        if scale_hits:
            scale_pts = min(8 + len(scale_hits) * 4, 28)
            points += scale_pts
            factors.append(
                {
                    "factor": "company_scale",
                    "weight": scale_pts,
                    "note": "Scale signals: " + "; ".join(scale_hits[:5]),
                }
            )

        if _country_is_priority(profile.country):
            points += 12
            factors.append(
                {
                    "factor": "market_quality",
                    "weight": 12,
                    "note": f"Priority / strong export market ({profile.country})",
                }
            )
        elif profile.country:
            points += 3
            factors.append(
                {
                    "factor": "market_quality",
                    "weight": 3,
                    "note": f"Market on file ({profile.country})",
                }
            )

        role = profile.market_role or profile.raw.get("market_role") or "unknown"
        producer_tier = profile.producer_tier or profile.raw.get("producer_tier")
        conversion_pct = profile.producer_conversion_pct or profile.raw.get(
            "producer_conversion_pct"
        )

        if role == "consumer":
            points += 15
            factors.append(
                {
                    "factor": "market_role",
                    "weight": 15,
                    "note": "Importer / buyer role (consumer)",
                }
            )
        elif role == "producer":
            if producer_tier == "weak" and conversion_pct is not None and conversion_pct >= 45:
                points -= 8
                factors.append(
                    {
                        "factor": "weak_producer",
                        "weight": -8,
                        "note": (
                            f"Narrow producer with {conversion_pct:.0f}% white-label potential"
                        ),
                    }
                )
            else:
                points -= 30
                factors.append(
                    {
                        "factor": "market_role",
                        "weight": -30,
                        "note": "Strong producer/competitor — weak importer grade",
                    }
                )
        elif role == "hybrid":
            points -= 8
            factors.append(
                {
                    "factor": "market_role",
                    "weight": -8,
                    "note": "Mixed producer/buyer — verify scale before treating as AAA",
                }
            )

        # Light engagement bonus (does not dominate grade — grade is company quality)
        cutoff = datetime.now(timezone.utc) - timedelta(days=90)
        recent_interactions = (
            db.query(Interaction)
            .join(Contact, Interaction.contact_id == Contact.id)
            .filter(Contact.buyer_id == profile.buyer_id)
            .filter(Interaction.created_at >= cutoff)
            .count()
        )
        if recent_interactions:
            eng = min(recent_interactions * 4, 12)
            points += eng
            factors.append(
                {
                    "factor": "recent_engagement",
                    "weight": eng,
                    "note": f"{recent_interactions} interactions in 90 days",
                }
            )

        points = max(points, 0)

        if points >= 55:
            label = LeadScoreLabel.AAA
            reasoning = (
                "AAA company grade: strong product-range fit and/or large-scale importer "
                f"signals in a solid market"
                + (
                    f" ({', '.join(profile.matched_categories[:3])})"
                    if profile.matched_categories
                    else ""
                )
                + "."
            )
        elif points >= 25:
            label = LeadScoreLabel.AA
            reasoning = (
                "AA company grade: moderate product-range or market fit — solid mid-tier "
                "account; sales can upgrade to AAA after calls if scale proves out."
            )
        else:
            label = LeadScoreLabel.A
            if role == "producer" and not (
                producer_tier == "weak" and conversion_pct is not None and conversion_pct >= 45
            ):
                reasoning = (
                    "A company grade: strong producer/competitor profile — poor importer fit."
                )
            else:
                reasoning = (
                    "A company grade: limited product-range fit, weak scale signals, or "
                    "low-priority market. Sales can revise after calling."
                )

        reasoning = self._maybe_llm_reasoning(
            db=db,
            profile=profile,
            fallback_label=label.value,
            fallback_reasoning=reasoning,
            score_factors=factors,
        )
        if isinstance(reasoning, dict):
            raw_score = str(reasoning.get("score") or label.value).upper().replace(" ", "")
            # Accept legacy LLM slips
            legacy = {"HOT": "AAA", "WARM": "AA", "COLD": "A"}
            raw_score = legacy.get(raw_score, raw_score)
            try:
                label = LeadScoreLabel(raw_score)
            except ValueError:
                pass
            factors = reasoning.get("key_factors", factors) or factors
            reasoning = reasoning.get("reasoning") or reasoning

        record = LeadScore(
            buyer_id=profile.buyer_id,
            score=label,
            reasoning=str(reasoning),
            score_factors={"points": points, "factors": factors},
        )
        db.add(record)
        # Do NOT write to buyers.company_grading — that field is the Excel /
        # spreadsheet grade (and optional sales override). AI grade is lead_scores only.
        db.commit()
        db.refresh(record)
        return record

    def _maybe_llm_reasoning(
        self,
        *,
        db: Session,
        profile: BuyerProfile,
        fallback_label: str,
        fallback_reasoning: str,
        score_factors: list,
    ) -> dict | str:
        from modules.llm_client import llm_client

        if not llm_client.enabled:
            return fallback_reasoning

        cutoff = datetime.now(timezone.utc) - timedelta(days=90)
        interactions_rows = (
            db.query(Interaction)
            .join(Contact, Interaction.contact_id == Contact.id)
            .filter(Contact.buyer_id == profile.buyer_id)
            .filter(Interaction.created_at >= cutoff)
            .limit(5)
            .all()
        )
        exports_rows = (
            db.query(ExportHistory)
            .filter(ExportHistory.buyer_id == profile.buyer_id)
            .order_by(ExportHistory.order_date.desc())
            .limit(5)
            .all()
        )

        buyer_profile_str = (
            f"Company: {profile.company_name}\n"
            f"Country: {profile.country or 'unknown'}\n"
            f"Industry: {profile.industry or 'unknown'}\n"
            f"Market role: {profile.market_role}\n"
            f"Website summary: {profile.website_summary or 'n/a'}\n"
            f"Matched categories: {', '.join(profile.matched_categories) or 'none'}\n"
            f"Product fit score: {profile.product_fit_score}\n"
            f"Rule-based grade (independent of any spreadsheet grade): "
            f"{fallback_label} — {fallback_reasoning}\n"
            f"Score factors: {score_factors}\n"
            f"IMPORTANT: Ignore any Excel/spreadsheet company grading. "
            f"Compute your own AAA/AA/A from the research signals above."
        )
        interactions_str = "\n".join(
            f"- [{i.channel}] {i.direction} on {i.created_at}: {(i.content or '')[:120]}"
            for i in interactions_rows
        ) or "None in last 90 days"
        exports_str = "\n".join(
            f"- {e.order_date}: qty {e.quantity} @ {e.unit_price}"
            for e in exports_rows
        ) or "No export history"

        return llm_client.score_lead(
            buyer_profile=buyer_profile_str,
            interactions=interactions_str,
            export_history=exports_str,
            fallback_label=fallback_label,
            fallback_reasoning=fallback_reasoning,
        )
