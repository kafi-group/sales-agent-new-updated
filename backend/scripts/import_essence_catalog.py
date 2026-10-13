"""Import ESSENCE ORDER SHEET.xlsx into backend/data/kafi_essence_catalog.json."""

import json
import re
import sys
from pathlib import Path

import openpyxl

BACKEND_DIR = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = Path.home() / "Downloads" / "ESSENCE ORDER SHEET.xlsx"
OUT = BACKEND_DIR / "data" / "kafi_essence_catalog.json"

CATEGORY_RULES = [
    ("pickles", ["pickle"]),
    ("chutneys", ["chutney"]),
    ("pastes", ["paste", "pasta sauce"]),
    ("sauces", ["sauce", "ketchup", "mayonnaise", "salsa", "mustard", "chipotle", "peri peri"]),
    (
        "himalayan_salt",
        [
            "himalayan",
            "pink salt",
            "black salt",
            "sea salt",
            "smoked salt",
            "garlic salt",
            "citrus salt",
            "spicy salt",
            "italian herbs salt",
            "iodized",
            "coarse salt",
        ],
    ),
    (
        "spices_masala",
        [
            "masala",
            "powder",
            "cumin",
            "coriander",
            "turmer",
            "garam",
            "kasuri",
            "chilli powder",
            "paprika",
            "peprica",
        ],
    ),
    ("fried_onion", ["fried onion"]),
    (
        "vermicelli_desserts",
        [
            "vermicelli",
            "kunafa",
            "pheni",
            "kheer",
            "custard",
            "sheer khurma",
            "lab - e - shireen",
            "dodh dullari",
            "sweets makhana",
            "rewri",
        ],
    ),
    ("rusks", ["rusk"]),
    ("jams_jellies", ["jam", "jelly"]),
    ("honey", ["honey", "sidr"]),
    ("moringa_wellness", ["moringa", "ispaghol"]),
    ("vinegar_water", ["vinegar", "rose water", "kewra water"]),
    ("juices", ["juice"]),
    ("snacks_ingredients", ["bread crumb", "papri", "boondhi", "dry dates", "miswak"]),
    ("rice", ["rice", "basmati", "irri"]),
]

CATEGORY_BUYER_KEYWORDS = {
    "pickles": ["pickle", "achar", "condiment", "ethnic food", "asian grocery"],
    "chutneys": ["chutney", "condiment", "indian food", "asian sauce", "halal food"],
    "pastes": ["garlic paste", "ginger paste", "cooking paste", "curry"],
    "sauces": ["sauce", "condiment", "hot sauce", "ethnic food"],
    "himalayan_salt": ["salt", "himalayan", "pink salt", "gourmet", "wellness", "spices"],
    "spices_masala": ["spices", "masala", "seasoning", "biryani", "halal"],
    "fried_onion": ["fried onion", "biryani", "food ingredients"],
    "vermicelli_desserts": ["dessert", "vermicelli", "kunafa", "confectionery", "sweet"],
    "rusks": ["rusk", "bakery", "snacks"],
    "jams_jellies": ["jam", "jelly", "spread", "breakfast"],
    "honey": ["honey", "natural", "wellness"],
    "moringa_wellness": ["moringa", "wellness", "tea", "organic", "health"],
    "vinegar_water": ["vinegar", "rose water", "kewra", "cooking ingredients"],
    "juices": ["juice", "beverage", "drinks"],
    "snacks_ingredients": ["snacks", "ingredients", "food service"],
    "rice": ["rice", "basmati", "grains", "staples", "food importer"],
    "other": ["food", "grocery", "import"],
}


def categorize(name: str) -> str:
    n = name.lower()
    for cat, kws in CATEGORY_RULES:
        if any(k in n for k in kws):
            return cat
    return "other"


def clean_name(name: str) -> str:
    name = re.sub(r"\s*-\s*ESSENCE\s*$", "", name, flags=re.I)
    name = re.sub(r"\s+", " ", name).strip()
    return name


def match_keywords(name: str, category: str) -> list[str]:
    n = name.lower()
    kws = set(CATEGORY_BUYER_KEYWORDS.get(category, []))
    for word in re.findall(r"[a-z]{3,}", n):
        if word not in ("essence", "packed", "master", "carton", "glass", "bottle"):
            kws.add(word)
    return sorted(kws)


def import_catalog(source: Path) -> dict:
    wb = openpyxl.load_workbook(source, read_only=True, data_only=True)
    ws = wb["ALL "]
    items = []
    seen: set[tuple[str, str]] = set()

    for row in ws.iter_rows(min_row=10, values_only=True):
        sno, desc, packaging, *_ = (row + (None,) * 6)[:6]
        if not isinstance(sno, (int, float)) or not desc or not str(desc).strip():
            continue
        raw_name = str(desc).strip()
        if raw_name.lower() in ("specification", "specificati"):
            continue
        name = clean_name(raw_name)
        if not name or len(name) < 3:
            continue
        packaging_str = str(packaging).strip() if packaging else None
        if packaging_str and packaging_str.lower() in ("specification", "specificati"):
            packaging_str = None
        cat = categorize(name)
        key = (name.lower(), (packaging_str or "").lower())
        if key in seen:
            continue
        seen.add(key)
        items.append(
            {
                "id": len(items) + 1,
                "sno": int(sno),
                "name": name,
                "brand": "ESSENCE",
                "category": cat,
                "packaging": packaging_str,
                "match_keywords": match_keywords(name, cat),
            }
        )
    wb.close()

    categories: dict[str, list[str]] = {}
    for item in items:
        categories.setdefault(item["category"], []).append(item["name"])

    return {
        "source": source.name,
        "company": "Kafi Commodities (Pvt.) Limited",
        "brand": "ESSENCE",
        "website": "https://www.kafi-group.com",
        "shipment_port": "Karachi Port",
        "product_count": len(items),
        "categories": {k: len(v) for k, v in sorted(categories.items())},
        "category_buyer_keywords": CATEGORY_BUYER_KEYWORDS,
        "products": items,
    }


def main() -> None:
    source = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SOURCE
    if not source.exists():
        raise SystemExit(f"Source file not found: {source}")

    catalog = import_catalog(source)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(catalog, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {catalog['product_count']} products to {OUT}")
    print("Categories:", catalog["categories"])


if __name__ == "__main__":
    main()
