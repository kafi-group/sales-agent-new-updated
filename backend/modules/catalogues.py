"""Catalogues manager and dispatch module for Kafi FMCG & Salt PDF catalogues."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from modules.email_attachments import register_attachment_from_path, public_attachment

logger = logging.getLogger(__name__)

_BACKEND_DIR = Path(__file__).resolve().parent.parent
STATIC_CATALOGUES_DIR = _BACKEND_DIR / "static" / "catalogues"
FALLBACK_CATALOGUES_DIR = Path(r"D:\First AI World\Cursor Projects\sales, social, hr Aug 2026\catalogue")

# Gmail/Outlook hard-fail around 25 MB total. Keep a buffer for message body + MIME.
EMAIL_ATTACH_MAX_BYTES = 10 * 1024 * 1024  # deliverability-safe

CATALOGUES_DEF = [
    {
        "id": "edible_salt",
        "title": "Edible Salt Catalogue",
        "category": "Himalayan Salt",
        "description": "Premium food-grade Pink Himalayan Salt, fine, medium, coarse grain, grinder jars & bulk container packaging.",
        "filename": "EDIBLE SALT CATALOUGE.pdf",
        "badge": "Food Grade",
        "color": "emerald",
    },
    {
        "id": "all_products",
        "title": "Kafi All Product Catalogue",
        "category": "Master FMCG",
        "description": "Complete product portfolio: Basmati Rice, Spices, Masalas, Pickles, Chutneys, Pastes, Sauces, Jam, and Desserts.",
        "filename": "Kafi All Product Catalogue.pdf",
        "badge": "Full Range",
        "color": "blue",
    },
    {
        "id": "salt_catalogue",
        "title": "Kafi Salt Catalogue",
        "category": "Himalayan Salt",
        "description": "Comprehensive Himalayan Pink Salt portfolio: culinary retail packs, food service, animal lick blocks, and industrial export.",
        "filename": "Kafi Salt Catalogue.pdf",
        "badge": "B2B & Retail",
        "color": "amber",
    },
    {
        "id": "non_edible_salt",
        "title": "Non-Edible Pink Salt Catalogue",
        "category": "Wellness & Decor",
        "description": "Hand-crafted Himalayan Salt Lamps, candle holders, aromatherapy diffusers, salt tiles, bath crystals, and wellness blocks.",
        "filename": "NON EDIBLE PINK SALT CATALOUGE.pdf",
        "badge": "Wellness & Decor",
        "color": "purple",
    },
]


def resolve_catalogue_file_path(filename: str) -> Path | None:
    try:  # a PDF replaced from the dashboard wins over the bundled original
        from modules.catalogue_overrides import custom_file

        replaced = custom_file(filename)
    except Exception:  # noqa: BLE001 - never let this lookup break the bundled catalogues
        replaced = None
    if replaced is not None:
        return replaced
    primary = STATIC_CATALOGUES_DIR / filename
    if primary.is_file():
        return primary
    if FALLBACK_CATALOGUES_DIR.is_dir():
        fallback = FALLBACK_CATALOGUES_DIR / filename
        if fallback.is_file():
            return fallback
    return None


def list_catalogues() -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for item in CATALOGUES_DEF:
        path = resolve_catalogue_file_path(item["filename"])
        size_bytes = path.stat().st_size if path and path.is_file() else 0
        exists = path is not None and path.is_file()
        try:
            from modules.catalogue_overrides import custom_info

            replaced_info = custom_info(item["filename"])
        except Exception:  # noqa: BLE001
            replaced_info = {"custom": False, "updated_at": None}
        results.append(
            {
                **replaced_info,
                "id": item["id"],
                "title": item["title"],
                "category": item["category"],
                "description": item["description"],
                "filename": item["filename"],
                "badge": item["badge"],
                "color": item["color"],
                "size": size_bytes,
                "exists": exists,
                "download_url": f"/api/catalogues/{item['id']}/download",
            }
        )
    return results


def get_catalogue_by_id(cat_id: str) -> tuple[Path, dict[str, Any]]:
    matched = next((c for c in CATALOGUES_DEF if c["id"] == cat_id or c["filename"].lower() == cat_id.lower()), None)
    if not matched:
        raise ValueError(f"Catalogue not found: {cat_id}")
    path = resolve_catalogue_file_path(matched["filename"])
    if not path or not path.is_file():
        raise FileNotFoundError(f"Catalogue file not found on disk: {matched['filename']}")
    return path, matched


def attach_catalogues_as_attachments(cat_ids: list[str]) -> list[dict[str, Any]]:
    """Convert catalogue files to EmailAttachment objects for mail compose.

    Gmail/Outlook reject messages over ~25 MB, so files larger than
    EMAIL_ATTACH_MAX_BYTES are skipped — callers should send a download link instead.
    """
    attachments: list[dict[str, Any]] = []
    for cid in cat_ids:
        try:
            path, meta = get_catalogue_by_id(cid)
            size = path.stat().st_size
            if size > EMAIL_ATTACH_MAX_BYTES:
                logger.warning(
                    "Skipping catalogue %s as email attachment (%.1f MB > %s MB limit)",
                    cid,
                    size / (1024 * 1024),
                    EMAIL_ATTACH_MAX_BYTES // (1024 * 1024),
                )
                continue
            registered = register_attachment_from_path(path, filename=meta["filename"], content_type="application/pdf")
            attachments.append(
                {
                    "id": registered["id"],
                    "filename": registered["filename"],
                    "content_type": registered["content_type"],
                    "size": registered["size"],
                    "storage_path": registered["storage_path"],
                }
            )
        except Exception as exc:
            logger.warning("Failed to register catalogue %s as attachment: %s", cid, exc)
    return attachments
