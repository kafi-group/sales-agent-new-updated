"""Canonical product-category taxonomy for the free-text `Buyer.product_interest` field.

Old-client / CSV-imported records store `product_interest` as messy free text
(e.g. "Rice, Salt & Spices", "HIMALAYAN PINK SALT FINE", "Paste & Pickle").
This module maps that free text onto a small set of canonical categories
(Rice, Himalayan Salt, Chutney, Oil, ...) so the "Product" filter shows one
clean entry per category instead of ~150 near-duplicate raw strings.

A single buyer can match multiple categories (e.g. "Rice, Oil" matches both
Rice and Oil) — matching is keyword-based substring search, not exclusive.
"""

from __future__ import annotations

import re

# label -> keywords (lowercase). A keyword matches if it appears at a word
# boundary in the product_interest text, so "rice" won't match "price" but
# will match "rice", "riced", "1121 rice", etc.
PRODUCT_CATEGORIES: dict[str, list[str]] = {
    "Rice": ["rice"],
    "Himalayan Salt": ["salt"],
    "Spices & Masala": ["spice", "masala", "peppercorn", "pepper"],
    "Pickles & Achar": ["pickle", "achar"],
    "Chutney": ["chutney"],
    "Sauces & Ketchup": ["sauce", "mayonnaise", "ketchup"],
    "Pastes": ["paste"],
    "Fried Onion": ["onion"],
    "Jams & Jellies": ["jam", "jelly", "jellies"],
    "Vermicelli & Desserts": ["vermicelli", "custard", "dessert", "sevai", "seviyan"],
    "Juices & Drinks": ["juice", "drink", "beverage"],
    "Honey": ["honey"],
    "Moringa & Wellness": ["moringa", "wellness", "herbal"],
    "Snacks & Nimco": ["nimco", "chips", "samosa", "spring roll", "snack", "kurkure"],
    "Vinegar": ["vinegar", "vineger"],
    "Oil": ["oil"],
    "Rusks & Bakery": ["rusk", "bakery", "bread"],
    "Wheat & Grains": ["wheat", "grain", "oilseed"],
    "Poultry & Meat": ["poultry", "meat", "chicken"],
    "Groceries & FMCG": ["grocery", "groceries", "fmcg", "food stuff", "foodstuff"],
}

# Rows whose product_interest doesn't hit any keyword above still fall under
# this label so they remain filterable/visible rather than disappearing.
OTHER_CATEGORY_LABEL = "Other"

_KEYWORD_PATTERNS: dict[str, list[re.Pattern[str]]] = {
    label: [re.compile(r"\b" + re.escape(keyword)) for keyword in keywords]
    for label, keywords in PRODUCT_CATEGORIES.items()
}

ALL_CATEGORY_LABELS: list[str] = sorted(PRODUCT_CATEGORIES.keys())


def categorize_product_text(text: str | None) -> list[str]:
    """Return every canonical category label whose keywords appear in `text`.

    A buyer with "Rice, Oil" in product_interest returns ["Oil", "Rice"] so it
    shows up under both filters. Falls back to [OTHER_CATEGORY_LABEL] when the
    text is non-empty but matches nothing, and [] when text is empty.
    """
    normalized = (text or "").strip().lower()
    if not normalized:
        return []
    matches = [
        label
        for label, patterns in _KEYWORD_PATTERNS.items()
        if any(pattern.search(normalized) for pattern in patterns)
    ]
    if matches:
        return sorted(matches)
    return [OTHER_CATEGORY_LABEL]


def keywords_for_category(label: str) -> list[str] | None:
    """Keyword list for a canonical category label, or None if unrecognized."""
    return PRODUCT_CATEGORIES.get(label)


def distinct_category_labels(raw_values: list[str | None]) -> list[str]:
    """Given distinct raw product_interest strings, return which canonical
    categories actually occur among them (plus "Other" if any are uncategorized).
    """
    found: set[str] = set()
    for raw in raw_values:
        found.update(categorize_product_text(raw))
    ordered = sorted(label for label in found if label != OTHER_CATEGORY_LABEL)
    if OTHER_CATEGORY_LABEL in found:
        ordered.append(OTHER_CATEGORY_LABEL)
    return ordered
