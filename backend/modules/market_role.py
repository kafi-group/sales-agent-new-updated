"""Classify leads as exporters (sell/manufacture like Kafi) vs importers (buyers)."""

from dataclasses import dataclass, field
import re


@dataclass
class MarketRoleResult:
    role: str  # consumer (importer) | producer (exporter) | hybrid | unknown
    confidence: float
    reasoning: str
    producer_signals: list[str] = field(default_factory=list)
    consumer_signals: list[str] = field(default_factory=list)
    producer_tier: str | None = None  # strong | weak
    producer_conversion_pct: float | None = None
    producer_tier_reasoning: str | None = None


# (pattern, weight, human label)
_PRODUCER_PATTERNS: list[tuple[str, int, str]] = [
    (r"\bmanufactur", 3, "Manufacturing language"),
    (r"\bproducer\b", 3, "Describes self as producer"),
    (r"\bproduction (facility|plant|line)\b", 3, "Production facility"),
    (r"\b(processing plant|food plant|rice mill|flour mill)\b", 4, "Processing/milling facility"),
    (r"\b(our (own )?brand|our products|we produce|we manufacture)\b", 4, "Own-brand / manufacturing"),
    (r"\b(private label (manufacturer|production)|co-?packer|contract manufactur)\b", 4, "Private-label manufacturer"),
    (r"\b(factory|plant)\b", 2, "Factory/plant mentioned"),
    (r"\b(made in|crafted in|grown and packed)\b", 2, "Origin / made-in language"),
    (r"\b(food producer|commodity exporter|agro processor)\b", 3, "Food/commodity producer"),
    (r"\b(established (in|since) 19\d{2}).{0,80}\b(product|catalog|range)\b", 2, "Long-established product catalog"),
    (r"\b(shop now|add to cart|buy our)\b", 2, "Direct product sales"),
    (r"\b(essence|kafi)\b", 1, "Similar export brand cues"),
]

_CONSUMER_PATTERNS: list[tuple[str, int, str]] = [
    (r"\b(importer|importing|we import|imports from)\b", 4, "Importer language"),
    (r"\b(distributor|distribution company|wholesale distributor)\b", 4, "Distributor"),
    (r"\b(wholesale (buyer|food|grocery)|food wholesaler)\b", 4, "Wholesale buyer"),
    (r"\b(supermarket|grocery chain|retail chain|hypermarket)\b", 3, "Retail chain"),
    (r"\b(foodservice|horeca|catering supplier)\b", 3, "Foodservice / HORECA"),
    (r"\b(procurement|sourcing|we source|supplier network)\b", 3, "Procurement / sourcing"),
    (r"\b(stockist|re-?export|trading (house|company))\b", 3, "Trader / stockist"),
    (r"\b(buy from|supplied by|partner suppliers)\b", 2, "Buys from suppliers"),
    (r"\b(import (rice|food|spices|salt|sauces|pickles))\b", 4, "Imports food categories"),
    (r"\b(distribution network|nationwide delivery to retailers)\b", 2, "Distribution to retailers"),
]

_INDUSTRY_PRODUCER = (
    "manufacturer",
    "manufacturing",
    "producer",
    "mill",
    "factory",
    "processing",
    "packer",
    "grower",
)

_INDUSTRY_CONSUMER = (
    "importer",
    "import",
    "distributor",
    "distribution",
    "wholesale",
    "retailer",
    "retail",
    "trading",
    "trader",
    "supermarket",
    "grocery",
    "foodservice",
    "horeca",
)

# Website cues for a broad own-brand catalog (strong producer)
_CATALOG_BREADTH_PATTERNS: list[tuple[str, int, str]] = [
    (r"\b(full (product )?range|complete range|wide range|extensive range)\b", 3, "Wide product range"),
    (r"\b(\d{2,}\+?\s*products?|\d{2,}\+?\s*skus?)\b", 3, "Large SKU count"),
    (r"\b(one-?stop|end-?to-?end|comprehensive (catalog|portfolio))\b", 3, "Comprehensive catalog"),
    (r"\b(multiple categories|diverse portfolio|broad portfolio)\b", 2, "Multi-category portfolio"),
    (r"\b(rice|basmati|pickles?|chutneys?|sauces?|spices?|salt|honey|jams?).{0,40}(and|&).{0,40}(rice|basmati|pickles?|chutneys?|sauces?|spices?|salt|honey|jams?)\b", 2, "Several food verticals listed"),
]

_NARROW_CATALOG_PATTERNS: list[tuple[str, int, str]] = [
    (r"\b(specialist|specializ|focused on|solely|only produce)\b", 2, "Specialist positioning"),
    (r"\b(single product|one product|niche producer)\b", 3, "Niche / single-product focus"),
    (r"\b(leading .{0,30} (salt|rice|honey|pickle) (producer|manufacturer))\b", 2, "Single-category leader"),
]

# Kafi ESSENCE catalog has ~16 categories — used for coverage thresholds
_KAFI_CATEGORY_COUNT = 16
_STRONG_CATEGORY_MIN = 5
_STRONG_PRODUCT_TYPE_MIN = 10
_WEAK_CATEGORY_MAX = 2
_WEAK_PRODUCT_TYPE_MAX = 4


def _score_patterns(text: str, patterns: list[tuple[str, int, str]]) -> tuple[int, list[str]]:
    lowered = text.lower()
    score = 0
    hits: list[str] = []
    for pattern, weight, label in patterns:
        if re.search(pattern, lowered):
            score += weight
            if label not in hits:
                hits.append(label)
    return score, hits


def _industry_bonus(industry: str | None) -> tuple[int, int, list[str], list[str]]:
    if not industry:
        return 0, 0, [], []
    lowered = industry.lower()
    producer_hits: list[str] = []
    consumer_hits: list[str] = []
    producer_pts = 0
    consumer_pts = 0
    for token in _INDUSTRY_PRODUCER:
        if token in lowered:
            producer_pts += 2
            producer_hits.append(f"Industry: {industry}")
            break
    for token in _INDUSTRY_CONSUMER:
        if token in lowered:
            consumer_pts += 2
            consumer_hits.append(f"Industry: {industry}")
            break
    return producer_pts, consumer_pts, producer_hits, consumer_hits


def _unique_product_types(matched_products: list[dict] | None) -> int:
    if not matched_products:
        return 0
    keys = {p.get("type_key") or p.get("name", "").lower() for p in matched_products}
    return len({k for k in keys if k})


def _catalog_breadth_score(website_text: str) -> tuple[int, list[str]]:
    return _score_patterns(website_text, _CATALOG_BREADTH_PATTERNS)


def _narrow_catalog_score(website_text: str) -> tuple[int, list[str]]:
    return _score_patterns(website_text, _NARROW_CATALOG_PATTERNS)


def classify_producer_tier(
    *,
    website_text: str = "",
    matched_kafi_categories: list[str] | None = None,
    matched_products: list[dict] | None = None,
    consumer_signals: list[str] | None = None,
    producer_signals: list[str] | None = None,
    has_export_history: bool = False,
) -> tuple[str | None, float | None, str | None]:
    """Strong vs weak producer tier and white-label conversion probability (%)."""
    categories = matched_kafi_categories or []
    product_count = _unique_product_types(matched_products)
    category_count = len(categories)
    breadth_pts, breadth_hits = _catalog_breadth_score(website_text)
    narrow_pts, narrow_hits = _narrow_catalog_score(website_text)

    coverage = category_count / _KAFI_CATEGORY_COUNT if _KAFI_CATEGORY_COUNT else 0

    is_strong = (
        category_count >= _STRONG_CATEGORY_MIN
        or product_count >= _STRONG_PRODUCT_TYPE_MIN
        or coverage >= 0.35
        or breadth_pts >= 5
    )
    is_weak = (
        category_count <= _WEAK_CATEGORY_MAX
        and product_count <= _WEAK_PRODUCT_TYPE_MAX
        and not is_strong
    ) or (narrow_pts >= 4 and category_count <= 3 and not is_strong)

    if not is_strong and not is_weak:
        if category_count >= 4 or product_count >= 7 or breadth_pts >= 3:
            is_strong = True
        elif category_count <= 2 and product_count <= 5:
            is_weak = True
        else:
            is_weak = category_count < 4

    if is_strong:
        tier = "strong"
        conversion = round(max(5.0, min(22.0, 8.0 + category_count * 1.5)), 1)
        reasoning = (
            f"Broad catalog similar to Kafi ({category_count} overlapping categories, "
            f"{product_count} product types detected). Direct competitor — low conversion likelihood."
        )
        if breadth_hits:
            reasoning += f" Signals: {'; '.join(breadth_hits[:3])}."
        return tier, conversion, reasoning

    tier = "weak"
    conversion = _estimate_weak_producer_conversion(
        category_count=category_count,
        product_count=product_count,
        consumer_signals=consumer_signals or [],
        producer_signals=producer_signals or [],
        has_export_history=has_export_history,
        website_text=website_text,
        narrow_hits=narrow_hits,
    )
    gap = _KAFI_CATEGORY_COUNT - category_count
    reasoning = (
        f"Narrow exporter catalog ({category_count} overlapping categor{'y' if category_count == 1 else 'ies'}, "
        f"{product_count} product types). {gap} Kafi categories not on their site — cross-sell / white-label opportunity."
    )
    if narrow_hits:
        reasoning += f" Specialist signals: {'; '.join(narrow_hits[:2])}."
    reasoning += f" Estimated conversion to Kafi client: {conversion:.0f}%."
    return tier, conversion, reasoning


def _estimate_weak_producer_conversion(
    *,
    category_count: int,
    product_count: int,
    consumer_signals: list[str],
    producer_signals: list[str],
    has_export_history: bool,
    website_text: str,
    narrow_hits: list[str],
) -> float:
    """Probability (%) that a weak producer becomes a Kafi sourcing/resell client."""
    lowered = website_text.lower()
    pct = 48.0

    gap = _KAFI_CATEGORY_COUNT - category_count
    pct += min(gap * 2.2, 20.0)

    if category_count <= 2:
        pct += 10.0
    if product_count <= 3:
        pct += 6.0
    if narrow_hits:
        pct += 5.0

    distribution_cues = (
        "distributor" in lowered
        or "wholesale" in lowered
        or "export" in lowered
        or any("distributor" in s.lower() or "export" in s.lower() for s in consumer_signals)
    )
    if distribution_cues:
        pct += 12.0

    if consumer_signals:
        pct += min(len(consumer_signals) * 2.5, 10.0)

    if has_export_history:
        pct += 18.0

    if any("private label" in s.lower() or "co-packer" in s.lower() for s in producer_signals):
        pct += 8.0
    if "private label" in lowered or "white label" in lowered:
        pct += 8.0

    if "international" in lowered or "global" in lowered:
        pct += 5.0

    if category_count >= 4:
        pct -= 12.0

    return round(max(18.0, min(92.0, pct)), 1)


def classify_market_role(
    *,
    company_name: str = "",
    industry: str | None = None,
    website_summary: str | None = None,
    website_text: str = "",
    has_export_history: bool = False,
    matched_kafi_categories: list[str] | None = None,
    matched_products: list[dict] | None = None,
) -> MarketRoleResult:
    """Rule-based producer vs consumer classification from public signals."""
    corpus = " ".join(
        filter(
            None,
            [company_name, industry or "", website_summary or "", website_text[:15000]],
        )
    )
    if not corpus.strip():
        return MarketRoleResult(
            role="unknown",
            confidence=0.0,
            reasoning="Insufficient data to classify market role.",
        )

    producer_pts, producer_hits = _score_patterns(corpus, _PRODUCER_PATTERNS)
    consumer_pts, consumer_hits = _score_patterns(corpus, _CONSUMER_PATTERNS)

    ind_p, ind_c, ind_prod_hits, ind_cons_hits = _industry_bonus(industry)
    producer_pts += ind_p
    consumer_pts += ind_c
    producer_hits.extend(ind_prod_hits)
    consumer_hits.extend(ind_cons_hits)

    if has_export_history:
        consumer_pts += 5
        consumer_hits.append("Prior orders with Kafi")

    categories = matched_kafi_categories or []
    if categories and producer_pts >= 2:
        producer_pts += 3
        producer_hits.append(
            f"Sells similar product categories ({', '.join(categories[:3])})"
        )

    total = producer_pts + consumer_pts
    if total == 0:
        return MarketRoleResult(
            role="unknown",
            confidence=0.0,
            reasoning="No clear exporter or importer signals on website or profile.",
            producer_signals=producer_hits,
            consumer_signals=consumer_hits,
        )

    margin = abs(producer_pts - consumer_pts)
    confidence = min(0.95, 0.45 + margin * 0.08)

    if producer_pts >= 4 and consumer_pts >= 4 and margin <= 3:
        role = "hybrid"
        reasoning = (
            "Shows both manufacturing/own-brand and import/distribution signals — "
            "may compete in some categories but could also source externally."
        )
    elif producer_pts > consumer_pts and producer_pts >= 3:
        role = "producer"
        reasoning = (
            "Likely an exporter or brand owner selling their own products "
            f"({'; '.join(producer_hits[:4])})."
        )
    elif consumer_pts > producer_pts and consumer_pts >= 3:
        role = "consumer"
        reasoning = (
            "Likely an importer/distributor "
            f"({'; '.join(consumer_hits[:4])})."
        )
    elif producer_pts == consumer_pts and producer_pts >= 3:
        role = "hybrid"
        reasoning = "Balanced exporter and importer signals — treat as mixed role."
    else:
        role = "unknown"
        confidence = max(0.2, confidence * 0.5)
        reasoning = "Weak or conflicting signals; role unclear until more research."

    producer_tier: str | None = None
    producer_conversion_pct: float | None = None
    producer_tier_reasoning: str | None = None

    if role in ("producer", "hybrid"):
        producer_tier, producer_conversion_pct, producer_tier_reasoning = classify_producer_tier(
            website_text=website_text,
            matched_kafi_categories=categories,
            matched_products=matched_products,
            consumer_signals=consumer_hits,
            producer_signals=producer_hits,
            has_export_history=has_export_history,
        )
        tier_label = "Strong" if producer_tier == "strong" else "Weak"
        reasoning += (
            f" {tier_label} exporter"
            + (
                f" (~{producer_conversion_pct:.0f}% conversion potential)."
                if producer_tier == "weak" and producer_conversion_pct is not None
                else " — direct competitor."
            )
        )

    return MarketRoleResult(
        role=role,
        confidence=round(confidence, 2),
        reasoning=reasoning,
        producer_signals=producer_hits,
        consumer_signals=consumer_hits,
        producer_tier=producer_tier,
        producer_conversion_pct=producer_conversion_pct,
        producer_tier_reasoning=producer_tier_reasoning,
    )
