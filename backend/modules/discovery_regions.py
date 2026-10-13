"""Canonical target markets for lead discovery — all countries."""

from __future__ import annotations

from typing import TypedDict

from modules.countries import COUNTRY_DATA

class DiscoveryRegion(TypedDict):
    code: str
    label: str
    group: str
    gl_code: str


MAX_DISCOVERY_REGIONS = 3

# ISO alpha-2 -> UI group (every country in COUNTRY_DATA must appear in one set)
_NORTH_AMERICA = {
    "US", "CA", "MX", "GT", "HN", "SV", "NI", "CR", "PA", "BZ", "CU", "DO", "HT",
    "JM", "TT", "BB", "BS", "AG", "DM", "GD", "KN", "LC", "VC",
}
_SOUTH_AMERICA = {
    "AR", "BO", "BR", "CL", "CO", "EC", "GY", "PY", "PE", "SR", "UY", "VE",
}
_EUROPE = {
    "AL", "AD", "AT", "BY", "BE", "BA", "BG", "HR", "CY", "CZ", "DK", "EE", "FI",
    "FR", "DE", "GR", "HU", "IS", "IE", "IT", "LV", "LI", "LT", "LU", "MT", "MD",
    "MC", "ME", "NL", "MK", "NO", "PL", "PT", "RO", "RU", "SM", "RS", "SK", "SI",
    "ES", "SE", "CH", "UA", "GB", "VA",
}
_MIDDLE_EAST = {
    "AE", "BH", "IR", "IQ", "IL", "JO", "KW", "LB", "OM", "PS", "QA", "SA", "SY",
    "TR", "YE",
}
_AFRICA = {
    "DZ", "AO", "BJ", "BW", "BF", "BI", "CV", "CM", "CF", "TD", "KM", "CG", "CD",
    "CI", "DJ", "EG", "GQ", "ER", "SZ", "ET", "GA", "GM", "GH", "GN", "GW", "KE",
    "LS", "LR", "LY", "MG", "MW", "ML", "MR", "MU", "MA", "MZ", "NA", "NE", "NG",
    "RW", "ST", "SN", "SC", "SL", "SO", "ZA", "SS", "SD", "TZ", "TG", "TN", "UG",
    "ZM", "ZW",
}
_ASIA_PACIFIC = {
    "AF", "AM", "AZ", "BD", "BT", "BN", "KH", "CN", "GE", "IN", "ID", "JP", "KZ",
    "KP", "KR", "KG", "LA", "MY", "MV", "MN", "MM", "NP", "PK", "PH", "SG", "LK",
    "TW", "TJ", "TH", "TL", "TM", "UZ", "VN",
}
_OCEANIA = {
    "AU", "NZ", "FJ", "KI", "MH", "FM", "NR", "PW", "PG", "WS", "SB", "TO", "TV",
    "VU",
}

_GROUP_ORDER = (
    "Middle East",
    "Africa",
    "Asia Pacific",
    "Europe",
    "North America",
    "South America",
    "Oceania",
)

_CODE_TO_GROUP: dict[str, str] = {}
for code in _MIDDLE_EAST:
    _CODE_TO_GROUP[code] = "Middle East"
for code in _AFRICA:
    _CODE_TO_GROUP[code] = "Africa"
for code in _ASIA_PACIFIC:
    _CODE_TO_GROUP[code] = "Asia Pacific"
for code in _EUROPE:
    _CODE_TO_GROUP[code] = "Europe"
for code in _NORTH_AMERICA:
    _CODE_TO_GROUP[code] = "North America"
for code in _SOUTH_AMERICA:
    _CODE_TO_GROUP[code] = "South America"
for code in _OCEANIA:
    _CODE_TO_GROUP[code] = "Oceania"

# Friendlier labels for a few markets (legacy UI names)
_LABEL_OVERRIDES: dict[str, str] = {
    "AE": "UAE",
    "GB": "United Kingdom",
    "US": "United States",
}

# Google `gl` param — UK uses gb
_GL_CODE_OVERRIDES: dict[str, str] = {
    "GB": "gb",
}

# Legacy discovery codes still accepted by the API
_LEGACY_CODE_ALIASES: dict[str, str] = {
    "uk": "gb",
}


def _region_group(iso_code: str) -> str:
    return _CODE_TO_GROUP.get(iso_code, "Asia Pacific")


def _build_discovery_regions() -> list[DiscoveryRegion]:
    regions: list[DiscoveryRegion] = []
    for iso_code, name in COUNTRY_DATA:
        code = iso_code.lower()
        regions.append(
            {
                "code": code,
                "label": _LABEL_OVERRIDES.get(iso_code, name),
                "group": _region_group(iso_code),
                "gl_code": _GL_CODE_OVERRIDES.get(iso_code, code),
            }
        )

    group_rank = {name: index for index, name in enumerate(_GROUP_ORDER)}
    regions.sort(
        key=lambda region: (
            group_rank.get(region["group"], 99),
            region["label"].lower(),
        )
    )
    return regions


DISCOVERY_REGIONS: list[DiscoveryRegion] = _build_discovery_regions()

_REGION_BY_CODE: dict[str, DiscoveryRegion] = {region["code"]: region for region in DISCOVERY_REGIONS}
for legacy, canonical in _LEGACY_CODE_ALIASES.items():
    if canonical in _REGION_BY_CODE:
        _REGION_BY_CODE[legacy] = _REGION_BY_CODE[canonical]

_REGION_BY_LABEL = {region["label"].lower(): region for region in DISCOVERY_REGIONS}


def list_discovery_regions() -> dict[str, object]:
    return {
        "max_regions": MAX_DISCOVERY_REGIONS,
        "regions": DISCOVERY_REGIONS,
    }


def resolve_region_codes(codes: list[str] | None) -> tuple[list[DiscoveryRegion], list[str]]:
    """Validate region codes; return resolved regions and any error messages."""
    if not codes:
        return [], []

    messages: list[str] = []
    if len(codes) > MAX_DISCOVERY_REGIONS:
        messages.append(f"Select at most {MAX_DISCOVERY_REGIONS} regions.")
        codes = codes[:MAX_DISCOVERY_REGIONS]

    resolved: list[DiscoveryRegion] = []
    seen: set[str] = set()
    for code in codes:
        normalized = code.strip().lower()
        if not normalized or normalized in seen:
            continue
        normalized = _LEGACY_CODE_ALIASES.get(normalized, normalized)
        region = _REGION_BY_CODE.get(normalized)
        if not region:
            messages.append(f"Unknown region code: {code}")
            continue
        seen.add(region["code"])
        resolved.append(region)

    return resolved, messages


def match_region_code(value: str | None) -> str | None:
    if not value:
        return None
    key = value.strip().lower()
    if key in _LEGACY_CODE_ALIASES:
        key = _LEGACY_CODE_ALIASES[key]
    if key in _REGION_BY_CODE:
        return _REGION_BY_CODE[key]["code"]
    if key in _REGION_BY_LABEL:
        return _REGION_BY_LABEL[key]["code"]
    for region in DISCOVERY_REGIONS:
        if key == region["label"].lower():
            return region["code"]
    # Avoid short-substring false positives (e.g. "au" inside unrelated text).
    if len(key) >= 4:
        matches = [
            region
            for region in DISCOVERY_REGIONS
            if key in region["label"].lower() or region["label"].lower() in key
        ]
        if matches:
            return max(matches, key=lambda region: len(region["label"]))["code"]

    from modules.countries import resolve_country_name

    canonical = resolve_country_name(value)
    if canonical:
        for region in DISCOVERY_REGIONS:
            if region["label"].lower() == canonical.lower():
                return region["code"]
    return None
