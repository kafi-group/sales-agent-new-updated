from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urljoin

import httpx
from bs4 import BeautifulSoup
from sqlalchemy.orm import Session

from db.models import Buyer, BuyerResearchProfile, Contact, ExportHistory, Interaction
from modules.market_role import MarketRoleResult, classify_market_role
from modules.product_catalog import match_text_to_catalog
from modules.robots import USER_AGENT, can_fetch
from modules.social_links import scrape_social_links


@dataclass
class BuyerProfile:
    buyer_id: int
    company_name: str
    website_url: str | None
    country: str | None
    industry: str | None
    website_summary: str | None = None
    social_summary: str | None = None
    relationship_context: str | None = None
    signals: list[str] = field(default_factory=list)
    matched_categories: list[str] = field(default_factory=list)
    matched_products: list[dict] = field(default_factory=list)
    product_fit_score: int = 0
    market_role: str = "unknown"
    market_role_reasoning: str | None = None
    market_role_confidence: float | None = None
    producer_tier: str | None = None
    producer_conversion_pct: float | None = None
    producer_tier_reasoning: str | None = None
    researched_at: datetime | None = None
    raw: dict[str, Any] = field(default_factory=dict)


class ResearchModule:
    """Fetches public website content and builds a structured buyer profile."""

    def __init__(self, timeout: float = 15.0):
        self.timeout = timeout

    def fetch_website_summary(
        self, url: str | None
    ) -> tuple[str | None, list[str], str]:
        if not url:
            return None, [], ""

        homepage = url.strip()
        if not homepage.startswith(("http://", "https://")):
            homepage = f"https://{homepage}"

        signals: list[str] = []
        text_chunks: list[str] = []
        title = ""
        paths = ("", "about", "about-us", "products", "our-products", "contact", "contact-us")

        for path in paths:
            page_url = urljoin(homepage.rstrip("/") + "/", path.lstrip("/"))
            if not can_fetch(page_url, USER_AGENT):
                continue
            try:
                response = httpx.get(
                    page_url,
                    timeout=self.timeout,
                    follow_redirects=True,
                    headers={"User-Agent": USER_AGENT},
                )
                response.raise_for_status()
            except httpx.HTTPError:
                continue

            page_text = response.text
            text_chunks.append(page_text[:8000])
            lowered = page_text.lower()

            if not title:
                soup = BeautifulSoup(page_text, "html.parser")
                title = soup.title.string.strip() if soup.title and soup.title.string else ""
            if "certif" in lowered and "Certifications mentioned on website" not in signals:
                signals.append("Certifications mentioned on website")
            if any(k in lowered for k in ("export", "international", "global")):
                if "International/export language on website" not in signals:
                    signals.append("International/export language on website")

        if not text_chunks:
            if not can_fetch(homepage, USER_AGENT):
                return "Website fetch blocked by robots.txt", signals, ""
            try:
                response = httpx.get(
                    homepage,
                    timeout=self.timeout,
                    follow_redirects=True,
                    headers={"User-Agent": USER_AGENT},
                )
                response.raise_for_status()
                text_chunks.append(response.text[:12000])
            except httpx.HTTPError as exc:
                return f"Could not fetch website: {exc}", signals, ""

        combined_html = "\n".join(text_chunks)[:20000]
        soup = BeautifulSoup(text_chunks[0], "html.parser")
        paragraphs = [
            p.get_text(strip=True)
            for p in soup.find_all("p")
            if len(p.get_text(strip=True)) > 40
        ][:5]
        text_preview = " ".join(paragraphs)[:800]

        if title:
            signals.insert(0, f"Page title: {title}")

        summary = f"{title}. {text_preview}".strip() if title or text_preview else "No summary extracted."
        return summary, signals, combined_html

    def _enhance_summary_with_llm(
        self, company_name: str, website_text: str, current_summary: str
    ) -> str:
        from modules.llm_client import llm_client
        return llm_client.enhance_website_summary(
            company_name=company_name,
            website_text=website_text,
            current_summary=current_summary,
        )

    def build_relationship_context(
        self, db: Session, buyer_id: int
    ) -> tuple[str | None, list[str]]:
        exports = (
            db.query(ExportHistory)
            .filter(ExportHistory.buyer_id == buyer_id)
            .order_by(ExportHistory.order_date.desc())
            .limit(5)
            .all()
        )
        interactions = (
            db.query(Interaction)
            .join(Contact, Interaction.contact_id == Contact.id)
            .filter(Contact.buyer_id == buyer_id)
            .order_by(Interaction.created_at.desc())
            .limit(10)
            .all()
        )

        signals: list[str] = []
        parts: list[str] = []

        if exports:
            latest = exports[0]
            parts.append(
                f"{len(exports)} past export(s); latest order on {latest.order_date}."
            )
            signals.append("Existing export history")
        else:
            parts.append("No prior export history on record.")

        if interactions:
            parts.append(f"{len(interactions)} logged interaction(s).")
            recent = interactions[0]
            if recent.created_at:
                days = (datetime.now(recent.created_at.tzinfo) - recent.created_at).days
                if days <= 30:
                    signals.append("Recent engagement within 30 days")
        else:
            parts.append("No logged interactions yet.")

        return " ".join(parts), signals

    def research_buyer(
        self,
        db: Session,
        buyer_id: int,
        *,
        force_refresh: bool = False,
        cache_ttl_hours: float = 24.0,
    ) -> BuyerProfile:
        """Research a buyer. Uses a cached profile if it's fresher than cache_ttl_hours.

        Pass force_refresh=True to always re-fetch the website.
        """
        buyer = db.get(Buyer, buyer_id)
        if not buyer:
            raise ValueError(f"Buyer {buyer_id} not found")

        if not force_refresh:
            saved = self.get_saved_profile(db, buyer_id)
            if saved and saved.researched_at:
                age_hours = (
                    datetime.now(saved.researched_at.tzinfo) - saved.researched_at
                ).total_seconds() / 3600
                if age_hours < cache_ttl_hours:
                    return saved

        website_summary, web_signals, website_text = self.fetch_website_summary(buyer.website_url)
        if website_text and website_summary and website_summary != "No summary extracted.":
            website_summary = self._enhance_summary_with_llm(
                buyer.company_name, website_text, website_summary
            )
        relationship_context, rel_signals = self.build_relationship_context(db, buyer_id)

        fit_text = " ".join(
            filter(
                None,
                [
                    buyer.company_name,
                    buyer.industry or "",
                    website_summary or "",
                    website_text,
                    relationship_context or "",
                ],
            )
        )
        product_fit = match_text_to_catalog(fit_text)
        has_exports = any("export history" in s.lower() for s in rel_signals)
        role_result = classify_market_role(
            company_name=buyer.company_name,
            industry=buyer.industry,
            website_summary=website_summary,
            website_text=website_text,
            has_export_history=has_exports,
            matched_kafi_categories=product_fit.matched_categories,
            matched_products=product_fit.matched_products,
        )
        role_signals = _market_role_signals(role_result)

        self._persist_market_role(db, buyer, role_result)

        socials = scrape_social_links(buyer.website_url, website_text)
        self._persist_social_links(db, buyer, socials, force_refresh=force_refresh)
        social_parts = [
            label
            for label, url in (
                ("Facebook", socials.facebook_url),
                ("Instagram", socials.instagram_url),
                ("LinkedIn", socials.linkedin_url or buyer.linkedin_company_url),
            )
            if url
        ]
        social_summary = f"Social pages found: {', '.join(social_parts)}" if social_parts else None
        all_signals = web_signals + rel_signals + product_fit.signals + role_signals
        if social_parts:
            all_signals.append(f"Social presence: {', '.join(social_parts)}")

        profile = BuyerProfile(
            buyer_id=buyer.id,
            company_name=buyer.company_name,
            website_url=buyer.website_url,
            country=buyer.country,
            industry=buyer.industry,
            website_summary=website_summary,
            social_summary=social_summary,
            relationship_context=relationship_context,
            signals=all_signals,
            matched_categories=product_fit.matched_categories,
            matched_products=product_fit.matched_products,
            product_fit_score=product_fit.match_score,
            market_role=role_result.role,
            market_role_reasoning=role_result.reasoning,
            market_role_confidence=role_result.confidence,
            producer_tier=role_result.producer_tier,
            producer_conversion_pct=role_result.producer_conversion_pct,
            producer_tier_reasoning=role_result.producer_tier_reasoning,
            raw={
                "website_fetched": bool(buyer.website_url),
                "product_fit_score": product_fit.match_score,
                "matched_categories": product_fit.matched_categories,
                "matched_products": product_fit.matched_products,
                "market_role": role_result.role,
                "market_role_confidence": role_result.confidence,
                "market_role_producer_signals": role_result.producer_signals,
                "market_role_consumer_signals": role_result.consumer_signals,
                "producer_tier": role_result.producer_tier,
                "producer_conversion_pct": role_result.producer_conversion_pct,
                "producer_tier_reasoning": role_result.producer_tier_reasoning,
            },
        )
        self._persist_profile(db, profile)
        return profile

    def get_saved_profile(self, db: Session, buyer_id: int) -> BuyerProfile | None:
        buyer = db.get(Buyer, buyer_id)
        if not buyer:
            raise ValueError(f"Buyer {buyer_id} not found")

        record = (
            db.query(BuyerResearchProfile)
            .filter(BuyerResearchProfile.buyer_id == buyer_id)
            .first()
        )
        if not record:
            return None

        return _profile_from_record(buyer, record)

    def _persist_profile(self, db: Session, profile: BuyerProfile) -> BuyerResearchProfile:
        now = datetime.now(timezone.utc)
        record = (
            db.query(BuyerResearchProfile)
            .filter(BuyerResearchProfile.buyer_id == profile.buyer_id)
            .first()
        )
        if record:
            record.website_summary = profile.website_summary
            record.social_summary = profile.social_summary
            record.relationship_context = profile.relationship_context
            record.signals = profile.signals
            record.matched_categories = profile.matched_categories
            record.matched_products = profile.matched_products
            record.product_fit_score = profile.product_fit_score
            record.raw = profile.raw or None
            record.researched_at = now
        else:
            record = BuyerResearchProfile(
                buyer_id=profile.buyer_id,
                website_summary=profile.website_summary,
                social_summary=profile.social_summary,
                relationship_context=profile.relationship_context,
                signals=profile.signals,
                matched_categories=profile.matched_categories,
                matched_products=profile.matched_products,
                product_fit_score=profile.product_fit_score,
                raw=profile.raw or None,
                researched_at=now,
            )
            db.add(record)

        db.commit()
        db.refresh(record)
        profile.researched_at = record.researched_at
        return record

    def _persist_market_role(
        self, db: Session, buyer: Buyer, result: MarketRoleResult
    ) -> None:
        from db.models import MarketRole, ProducerTier

        buyer.market_role = MarketRole(result.role)
        buyer.market_role_reasoning = result.reasoning
        buyer.market_role_confidence = result.confidence
        if result.producer_tier:
            buyer.producer_tier = ProducerTier(result.producer_tier)
            buyer.producer_conversion_pct = result.producer_conversion_pct
            buyer.producer_tier_reasoning = result.producer_tier_reasoning
        else:
            buyer.producer_tier = None
            buyer.producer_conversion_pct = None
            buyer.producer_tier_reasoning = None
        db.commit()
        db.refresh(buyer)

    def _persist_social_links(
        self,
        db: Session,
        buyer: Buyer,
        socials,
        *,
        force_refresh: bool = False,
    ) -> None:
        updated = False
        if socials.facebook_url and (force_refresh or not buyer.facebook_company_url):
            buyer.facebook_company_url = socials.facebook_url
            updated = True
        if socials.instagram_url and (force_refresh or not buyer.instagram_company_url):
            buyer.instagram_company_url = socials.instagram_url
            updated = True
        if socials.linkedin_url and (force_refresh or not buyer.linkedin_company_url):
            buyer.linkedin_company_url = socials.linkedin_url
            updated = True
        if updated:
            db.commit()
            db.refresh(buyer)


def _profile_from_record(buyer: Buyer, record: BuyerResearchProfile) -> BuyerProfile:
    market_role = buyer.market_role.value if buyer.market_role else "unknown"
    producer_tier = buyer.producer_tier.value if buyer.producer_tier else None
    conversion_pct = (
        float(buyer.producer_conversion_pct)
        if buyer.producer_conversion_pct is not None
        else None
    )
    return BuyerProfile(
        buyer_id=buyer.id,
        company_name=buyer.company_name,
        website_url=buyer.website_url,
        country=buyer.country,
        industry=buyer.industry,
        website_summary=record.website_summary,
        social_summary=record.social_summary,
        relationship_context=record.relationship_context,
        signals=list(record.signals or []),
        matched_categories=list(record.matched_categories or []),
        matched_products=list(record.matched_products or []),
        product_fit_score=record.product_fit_score or 0,
        market_role=market_role,
        market_role_reasoning=buyer.market_role_reasoning,
        market_role_confidence=(
            float(buyer.market_role_confidence)
            if buyer.market_role_confidence is not None
            else None
        ),
        producer_tier=producer_tier,
        producer_conversion_pct=conversion_pct,
        producer_tier_reasoning=buyer.producer_tier_reasoning,
        researched_at=record.researched_at,
        raw=dict(record.raw or {}),
    )


def _market_role_signals(result: MarketRoleResult) -> list[str]:
    role_labels = {
        "consumer": "Importer",
        "producer": "Exporter",
        "hybrid": "Hybrid",
        "unknown": "Unclassified",
    }
    label = role_labels.get(result.role, result.role.replace("_", " ").title())
    signals = [f"Market role: {label}"]
    if result.producer_tier:
        tier_label = "Strong exporter" if result.producer_tier == "strong" else "Weak exporter"
        signals.append(f"Exporter tier: {tier_label}")
        if result.producer_conversion_pct is not None:
            signals.append(f"Exporter conversion potential: {result.producer_conversion_pct:.0f}%")
    if result.producer_signals:
        signals.append(f"Exporter signals: {', '.join(result.producer_signals[:3])}")
    if result.consumer_signals:
        signals.append(f"Importer signals: {', '.join(result.consumer_signals[:3])}")
    return signals
