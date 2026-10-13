"""Kafi carton dimensions — loaded from data/kafi_carton_dimensions.json."""

from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path

DIMENSIONS_PATH = Path(__file__).resolve().parents[1] / "data" / "kafi_carton_dimensions.json"


@lru_cache(maxsize=1)
def load_dimensions() -> dict:
    if not DIMENSIONS_PATH.exists():
        return {"entries": []}
    return json.loads(DIMENSIONS_PATH.read_text(encoding="utf-8"))


def list_entries(*, brand: str | None = None, q: str | None = None) -> list[dict]:
    entries = load_dimensions().get("entries", [])
    if brand:
        brand_l = brand.lower()
        entries = [e for e in entries if (e.get("brand") or "").lower() == brand_l]
    if q:
        needle = q.lower()
        entries = [
            e
            for e in entries
            if needle in (e.get("product") or "").lower()
            or needle in (e.get("packing") or "").lower()
        ]
    return entries


def lookup_for_product(product_name: str, packaging: str | None = None) -> dict | None:
    """Best-effort match of a catalog product name to carton dimensions."""
    if not product_name:
        return None

    name_l = product_name.lower()
    packaging_l = (packaging or "").lower()
    entries = load_dimensions().get("entries", [])

    def score(entry: dict) -> int:
        product = (entry.get("product") or "").lower()
        packing = (entry.get("packing") or "").lower()
        s = 0
        for token in re.findall(r"[a-z0-9]+", name_l):
            if len(token) >= 4 and token in product:
                s += len(token)
        if packaging_l and packaging_l in packing:
            s += 20
        if "essence" in name_l and entry.get("brand") == "ESSENCE":
            s += 5
        return s

    ranked = sorted(entries, key=score, reverse=True)
    if ranked and score(ranked[0]) >= 8:
        return ranked[0]
    return None
