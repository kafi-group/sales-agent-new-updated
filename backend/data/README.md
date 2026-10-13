# Kafi ESSENCE Product Catalog

**Source:** `ESSENCE ORDER SHEET.xlsx` (Kafi Commodities order sheet)

**Generated file:** `kafi_essence_catalog.json` — 177 products under the ESSENCE brand

## Categories

| Category | Count | Example buyer keywords |
|----------|-------|------------------------|
| pickles | 8 | pickle, achar, condiment |
| chutneys | 5 | chutney, asian sauce |
| pastes | 14 | garlic paste, ginger paste |
| sauces | 11 | hot sauce, ketchup, salsa |
| himalayan_salt | 29 | pink salt, gourmet salt |
| spices_masala | 32 | masala, biryani, spices |
| fried_onion | 7 | biryani ingredients |
| vermicelli_desserts | 15 | kunafa, kheer, dessert |
| rusks | 5 | bakery, snacks |
| jams_jellies | 18 | jam, spread |
| honey | 2 | honey, sidr |
| moringa_wellness | 14 | tea, wellness |
| vinegar_water | 4 | vinegar, rose water |
| juices | 6 | beverage |
| snacks_ingredients | 6 | food service |

## Re-import after Excel update

```bash
cd backend
python scripts/import_essence_catalog.py "path/to/ESSENCE ORDER SHEET.xlsx"
```

## Used by

- `modules/product_catalog.py` — keyword matching for lead research
- `modules/research.py` — product fit on website analysis
- `modules/lead_scoring.py` — AAA/AA/A company grade from catalog match + market/scale
- `modules/commerce.py` — cross-sell recommendations
