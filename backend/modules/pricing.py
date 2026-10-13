"""Category-based pricing from ESSENCE order-sheet tiers."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

DATA_PATH = Path(__file__).resolve().parents[1] / "data" / "category_price_tiers.json"


@lru_cache(maxsize=1)
def load_pricing_config() -> dict:
    if not DATA_PATH.exists():
        return {"default_unit": "USD/carton", "categories": {}}
    return json.loads(DATA_PATH.read_text(encoding="utf-8"))


def get_category_pricing(category: str | None) -> dict:
    config = load_pricing_config()
    categories = config.get("categories", {})
    key = (category or "other").lower()
    pricing = categories.get(key) or categories.get("other", {})
    tiers = {k: v for k, v in pricing.items() if k != "unit"}
    return {
        "category": key,
        "unit": pricing.get("unit", config.get("default_unit", "USD/carton")),
        "price_tiers": tiers,
    }


def price_tiers_for_category(category: str | None) -> dict[str, float]:
    return get_category_pricing(category)["price_tiers"]


def price_unit_for_category(category: str | None) -> str:
    return get_category_pricing(category)["unit"]


def list_all_category_pricing() -> list[dict]:
    config = load_pricing_config()
    rows: list[dict] = []
    for category, pricing in sorted(config.get("categories", {}).items()):
        tiers = {k: v for k, v in pricing.items() if k != "unit"}
        rows.append(
            {
                "category": category,
                "unit": pricing.get("unit", config.get("default_unit")),
                "price_tiers": tiers,
            }
        )
    return rows
