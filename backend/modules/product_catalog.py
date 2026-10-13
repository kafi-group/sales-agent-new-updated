"""Kafi ESSENCE product catalog — loaded from data/kafi_essence_catalog.json."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

CATALOG_PATH = Path(__file__).resolve().parents[1] / "data" / "kafi_essence_catalog.json"


@dataclass
class ProductFitResult:
    matched_categories: list[str] = field(default_factory=list)
    matched_products: list[dict] = field(default_factory=list)
    match_score: int = 0
    signals: list[str] = field(default_factory=list)


@lru_cache(maxsize=1)
def load_catalog() -> dict:
    if not CATALOG_PATH.exists():
        return {"products": [], "categories": {}, "category_buyer_keywords": {}}
    return json.loads(CATALOG_PATH.read_text(encoding="utf-8"))


def list_categories() -> dict[str, int]:
    return load_catalog().get("categories", {})


def list_products(category: str | None = None) -> list[dict]:
    products = load_catalog().get("products", [])
    if category:
        return [p for p in products if p.get("category") == category]
    return products


def _normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", text.lower()).strip()


def normalize_product_name(name: str) -> str:
    """Collapse whitespace/case for exact-name deduplication."""
    return re.sub(r"\s+", " ", name.strip()).lower()


_SIZE_SUFFIX_PATTERNS = [
    re.compile(r"\s+\d+\s*to\s*\d+\s*mm\b.*$", re.I),
    re.compile(r'\s+\d+"\s*length\b.*$', re.I),
    re.compile(r"\s+\d+[\d.]*\s*(?:g|kg|gm|gms|ml|l|ltr|oz)\b.*$", re.I),
    re.compile(r"\s+(?:pet|glass)\s+(?:bottle|jar|pack)\b.*$", re.I),
    re.compile(r"\s+packed in master carton.*$", re.I),
    re.compile(r"\s+\d+\s*x\s*\d+.*$", re.I),
]


def product_type_key(name: str) -> str:
    """Normalize SKU name to a product type (strip sizes/packaging)."""
    n = re.sub(r"\s*-\s*essence\s*$", "", name.strip(), flags=re.I)
    for pattern in _SIZE_SUFFIX_PATTERNS:
        n = pattern.sub("", n)
    return re.sub(r"\s+", " ", n).strip().lower()


def product_dedupe_key(name: str) -> str:
    """One key per distinct product — type first, then exact normalized name."""
    type_key = product_type_key(name)
    if type_key:
        return f"type:{type_key}"
    normalized = normalize_product_name(name)
    return f"name:{normalized}" if normalized else ""


def _display_name_for_type(type_key: str, variant_names: list[str]) -> str:
    unique_upper = {v.strip().upper() for v in variant_names}
    if len(unique_upper) == 1:
        return variant_names[0].strip()
    words = type_key.split()
    return " ".join(w.capitalize() if w.isascii() else w for w in words)


def list_unique_product_types() -> list[dict[str, str]]:
    """One entry per product type — no duplicate sizes/packaging SKUs."""
    catalog = load_catalog()
    buckets: dict[str, dict[str, object]] = {}

    for product in catalog.get("products", []):
        name = product["name"]
        key = product_type_key(name)
        if not key:
            continue
        if key not in buckets:
            buckets[key] = {"category": product.get("category", "other"), "variants": [name]}
        else:
            variants = buckets[key]["variants"]
            assert isinstance(variants, list)
            variants.append(name)

    result: list[dict[str, str]] = []
    for key, data in buckets.items():
        variants = data["variants"]
        assert isinstance(variants, list)
        result.append(
            {
                "type_key": key,
                "name": _display_name_for_type(key, variants),
                "category": str(data["category"]),
            }
        )

    return sorted(result, key=lambda x: (x["category"], x["name"].lower()))


def match_text_to_catalog(text: str, *, limit: int = 15) -> ProductFitResult:
    """Match website/social/history text against Kafi product keywords."""
    if not text:
        return ProductFitResult()

    catalog = load_catalog()
    type_variants: dict[str, list[str]] = {}
    for p in catalog.get("products", []):
        tk = product_type_key(p["name"])
        type_variants.setdefault(tk, []).append(p["name"])

    normalized = _normalize_text(text)
    category_hits: dict[str, int] = {}
    product_hits: list[tuple[int, dict, str]] = []

    for product in catalog.get("products", []):
        best_kw = None
        best_len = 0
        for kw in product.get("match_keywords", []):
            kw_l = kw.lower()
            if len(kw_l) >= 3 and kw_l in normalized and len(kw_l) > best_len:
                best_kw = kw
                best_len = len(kw_l)
        if best_kw:
            cat = product["category"]
            category_hits[cat] = category_hits.get(cat, 0) + 1
            product_hits.append((best_len, product, best_kw))

    for cat, keywords in catalog.get("category_buyer_keywords", {}).items():
        for kw in keywords:
            kw_l = kw.lower()
            if len(kw_l) >= 4 and kw_l in normalized:
                category_hits[cat] = category_hits.get(cat, 0) + 1

    product_hits.sort(key=lambda x: x[0], reverse=True)
    matched_products = []
    seen_type_keys: set[str] = set()
    for _, product, kw in product_hits:
        type_key = product_type_key(product["name"])
        if type_key in seen_type_keys:
            continue
        seen_type_keys.add(type_key)
        matched_products.append(
            {
                "name": _display_name_for_type(type_key, type_variants.get(type_key, [product["name"]])),
                "category": product["category"],
                "matched_keyword": kw,
                "type_key": type_key,
            }
        )
        if len(matched_products) >= limit:
            break

    matched_categories = sorted(category_hits.keys(), key=lambda c: category_hits[c], reverse=True)
    signals = [
        f"Product fit: {cat} ({category_hits[cat]} keyword hits)"
        for cat in matched_categories[:5]
    ]

    score = min(sum(category_hits.values()) * 5, 50)

    return ProductFitResult(
        matched_categories=matched_categories,
        matched_products=matched_products,
        match_score=score,
        signals=signals,
    )


def cross_sell_for_categories(
    purchased_categories: list[str],
    *,
    limit: int = 5,
) -> list[dict]:
    """Legacy helper — prefer recommend_cross_sell_for_buyer() for buyer-specific results."""
    return recommend_cross_sell_for_buyer(
        matched_categories=[],
        matched_products=[],
        purchased_categories=purchased_categories,
        limit=limit,
    )


# Categories that pair well on the same retail / HORECA shelf or import container.
_CATEGORY_CROSS_SELL: dict[str, tuple[str, ...]] = {
    "rice": ("chutneys", "pickles", "sauces", "spices_masala", "himalayan_salt"),
    "pickles": ("chutneys", "sauces", "pastes", "spices_masala", "himalayan_salt", "fried_onion"),
    "chutneys": ("pickles", "sauces", "pastes", "spices_masala", "fried_onion"),
    "pastes": ("sauces", "pickles", "chutneys", "spices_masala", "fried_onion"),
    "sauces": ("pickles", "chutneys", "pastes", "spices_masala", "fried_onion"),
    "himalayan_salt": ("spices_masala", "sauces", "pickles", "chutneys", "fried_onion"),
    "spices_masala": ("himalayan_salt", "fried_onion", "pastes", "sauces", "pickles"),
    "fried_onion": ("spices_masala", "sauces", "pastes", "rice", "pickles"),
    "vermicelli_desserts": ("honey", "jams_jellies", "rusks", "moringa_wellness"),
    "rusks": ("jams_jellies", "honey", "vermicelli_desserts"),
    "jams_jellies": ("honey", "rusks", "vermicelli_desserts"),
    "honey": ("jams_jellies", "moringa_wellness", "vermicelli_desserts"),
    "moringa_wellness": ("honey", "vinegar_water", "spices_masala"),
    "vinegar_water": ("sauces", "pickles", "pastes", "spices_masala"),
    "juices": ("snacks_ingredients", "jams_jellies", "honey"),
    "snacks_ingredients": ("spices_masala", "fried_onion", "sauces", "pastes"),
}


def _format_category_label(category: str) -> str:
    return category.replace("_", " ")


def _pick_product_for_category(
    category: str,
    *,
    buyer_context: str,
    exclude_type_keys: set[str],
) -> dict | None:
    """Choose the best representative SKU in a category for this buyer."""
    products = list_products(category)
    if not products:
        return None

    normalized = _normalize_text(buyer_context) if buyer_context else ""
    best: tuple[int, dict] | None = None

    for product in products:
        type_key = product_type_key(product["name"])
        if type_key in exclude_type_keys:
            continue
        score = 0
        if normalized:
            for kw in product.get("match_keywords", []):
                kw_l = kw.lower()
                if len(kw_l) >= 4 and kw_l in normalized:
                    score += len(kw_l)
        if best is None or score > best[0]:
            best = (score, product)

    chosen = best[1] if best and best[0] > 0 else products[0]
    type_key = product_type_key(chosen["name"])
    variants = [p["name"] for p in products if product_type_key(p["name"]) == type_key]
    return {
        "name": _display_name_for_type(type_key, variants),
        "category": category,
        "type_key": type_key,
    }


def _cross_sell_rationale(
    *,
    target_category: str,
    anchor_categories: list[str],
    purchased_categories: list[str],
    from_research: bool,
) -> str:
    target = _format_category_label(target_category)
    if purchased_categories:
        bought = ", ".join(_format_category_label(c) for c in purchased_categories[:2])
        return (
            f"Already orders {bought} — ESSENCE {target} is a complementary add-on "
            f"for the same retail / food-service customers."
        )
    if from_research and anchor_categories:
        focus = ", ".join(_format_category_label(c) for c in anchor_categories[:2])
        return (
            f"Their profile fits {focus}; ESSENCE {target} expands the range without "
            f"competing with their current focus."
        )
    return f"ESSENCE {target} line may fit this buyer's food import profile."


def recommend_cross_sell_for_buyer(
    *,
    matched_categories: list[str],
    matched_products: list[dict],
    purchased_categories: list[str],
    buyer_context: str = "",
    limit: int = 5,
) -> list[dict]:
    """Suggest complementary ESSENCE products this specific buyer has not bought yet.

    Uses research fit + order history — never returns the same static list for every lead.
    """
    purchased = {c for c in purchased_categories if c and c != "other"}
    matched = [c for c in matched_categories if c and c != "other"]

    # Anchor on what they already buy or what research shows they sell/import.
    anchors = list(dict.fromkeys([*purchased, *matched]))

    if not anchors and buyer_context.strip():
        inferred = match_text_to_catalog(buyer_context, limit=8)
        matched = [c for c in inferred.matched_categories if c != "other"]
        anchors = matched

    if not anchors:
        return []

    already_type_keys = {
        str(p.get("type_key") or product_type_key(str(p.get("name", ""))))
        for p in matched_products
        if p.get("type_key") or p.get("name")
    }

    # Score complementary categories by how many anchors point at them.
    candidate_scores: dict[str, int] = {}
    for anchor in anchors:
        for idx, complement in enumerate(_CATEGORY_CROSS_SELL.get(anchor, ())):
            if complement in purchased or complement in anchors:
                continue
            weight = max(10 - idx, 1)
            if complement in matched:
                weight += 3
            candidate_scores[complement] = candidate_scores.get(complement, 0) + weight

    if not candidate_scores:
        return []

    ranked = sorted(candidate_scores.items(), key=lambda item: item[1], reverse=True)

    recommendations: list[dict] = []
    used_type_keys = set(already_type_keys)

    for category, _score in ranked:
        picked = _pick_product_for_category(
            category,
            buyer_context=buyer_context,
            exclude_type_keys=used_type_keys,
        )
        if not picked:
            continue
        used_type_keys.add(picked["type_key"])
        recommendations.append(
            {
                "category": category,
                "product_name": picked["name"],
                "rationale": _cross_sell_rationale(
                    target_category=category,
                    anchor_categories=anchors,
                    purchased_categories=list(purchased),
                    from_research=bool(matched),
                ),
            }
        )
        if len(recommendations) >= limit:
            break

    return recommendations
