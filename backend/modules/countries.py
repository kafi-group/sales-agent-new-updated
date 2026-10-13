"""Canonical country list and matching helpers for lead filters."""

from __future__ import annotations

import re

COUNTRY_DATA: list[tuple[str, str]] = [
    ("AF", "Afghanistan"),
    ("AL", "Albania"),
    ("DZ", "Algeria"),
    ("AD", "Andorra"),
    ("AO", "Angola"),
    ("AG", "Antigua and Barbuda"),
    ("AR", "Argentina"),
    ("AM", "Armenia"),
    ("AU", "Australia"),
    ("AT", "Austria"),
    ("AZ", "Azerbaijan"),
    ("BS", "Bahamas"),
    ("BH", "Bahrain"),
    ("BD", "Bangladesh"),
    ("BB", "Barbados"),
    ("BY", "Belarus"),
    ("BE", "Belgium"),
    ("BZ", "Belize"),
    ("BJ", "Benin"),
    ("BT", "Bhutan"),
    ("BO", "Bolivia"),
    ("BA", "Bosnia and Herzegovina"),
    ("BW", "Botswana"),
    ("BR", "Brazil"),
    ("BN", "Brunei"),
    ("BG", "Bulgaria"),
    ("BF", "Burkina Faso"),
    ("BI", "Burundi"),
    ("CV", "Cabo Verde"),
    ("KH", "Cambodia"),
    ("CM", "Cameroon"),
    ("CA", "Canada"),
    ("CF", "Central African Republic"),
    ("TD", "Chad"),
    ("CL", "Chile"),
    ("CN", "China"),
    ("CO", "Colombia"),
    ("KM", "Comoros"),
    ("CG", "Congo"),
    ("CR", "Costa Rica"),
    ("HR", "Croatia"),
    ("CU", "Cuba"),
    ("CY", "Cyprus"),
    ("CZ", "Czechia"),
    ("CD", "Democratic Republic of the Congo"),
    ("DK", "Denmark"),
    ("DJ", "Djibouti"),
    ("DM", "Dominica"),
    ("DO", "Dominican Republic"),
    ("EC", "Ecuador"),
    ("EG", "Egypt"),
    ("SV", "El Salvador"),
    ("GQ", "Equatorial Guinea"),
    ("ER", "Eritrea"),
    ("EE", "Estonia"),
    ("SZ", "Eswatini"),
    ("ET", "Ethiopia"),
    ("FJ", "Fiji"),
    ("FI", "Finland"),
    ("FR", "France"),
    ("GA", "Gabon"),
    ("GM", "Gambia"),
    ("GE", "Georgia"),
    ("DE", "Germany"),
    ("GH", "Ghana"),
    ("GR", "Greece"),
    ("GD", "Grenada"),
    ("GT", "Guatemala"),
    ("GN", "Guinea"),
    ("GW", "Guinea-Bissau"),
    ("GY", "Guyana"),
    ("HT", "Haiti"),
    ("HN", "Honduras"),
    ("HK", "Hong Kong"),
    ("HU", "Hungary"),
    ("IS", "Iceland"),
    ("IN", "India"),
    ("ID", "Indonesia"),
    ("IR", "Iran"),
    ("IQ", "Iraq"),
    ("IE", "Ireland"),
    ("IL", "Israel"),
    ("IT", "Italy"),
    ("CI", "Ivory Coast"),
    ("JM", "Jamaica"),
    ("JP", "Japan"),
    ("JO", "Jordan"),
    ("KZ", "Kazakhstan"),
    ("KE", "Kenya"),
    ("KI", "Kiribati"),
    ("KW", "Kuwait"),
    ("KG", "Kyrgyzstan"),
    ("LA", "Laos"),
    ("LV", "Latvia"),
    ("LB", "Lebanon"),
    ("LS", "Lesotho"),
    ("LR", "Liberia"),
    ("LY", "Libya"),
    ("LI", "Liechtenstein"),
    ("LT", "Lithuania"),
    ("LU", "Luxembourg"),
    ("MG", "Madagascar"),
    ("MW", "Malawi"),
    ("MY", "Malaysia"),
    ("MV", "Maldives"),
    ("ML", "Mali"),
    ("MT", "Malta"),
    ("MH", "Marshall Islands"),
    ("MR", "Mauritania"),
    ("MU", "Mauritius"),
    ("MX", "Mexico"),
    ("FM", "Micronesia"),
    ("MD", "Moldova"),
    ("MC", "Monaco"),
    ("MN", "Mongolia"),
    ("ME", "Montenegro"),
    ("MA", "Morocco"),
    ("MZ", "Mozambique"),
    ("MM", "Myanmar"),
    ("NA", "Namibia"),
    ("NR", "Nauru"),
    ("NP", "Nepal"),
    ("NL", "Netherlands"),
    ("NZ", "New Zealand"),
    ("NI", "Nicaragua"),
    ("NE", "Niger"),
    ("NG", "Nigeria"),
    ("KP", "North Korea"),
    ("MK", "North Macedonia"),
    ("NO", "Norway"),
    ("OM", "Oman"),
    ("PK", "Pakistan"),
    ("PW", "Palau"),
    ("PS", "Palestine"),
    ("PA", "Panama"),
    ("PG", "Papua New Guinea"),
    ("PY", "Paraguay"),
    ("PE", "Peru"),
    ("PH", "Philippines"),
    ("PL", "Poland"),
    ("PT", "Portugal"),
    ("QA", "Qatar"),
    ("RO", "Romania"),
    ("RU", "Russia"),
    ("RW", "Rwanda"),
    ("KN", "Saint Kitts and Nevis"),
    ("LC", "Saint Lucia"),
    ("VC", "Saint Vincent and the Grenadines"),
    ("WS", "Samoa"),
    ("SM", "San Marino"),
    ("ST", "Sao Tome and Principe"),
    ("SA", "Saudi Arabia"),
    ("SN", "Senegal"),
    ("RS", "Serbia"),
    ("SC", "Seychelles"),
    ("SL", "Sierra Leone"),
    ("SG", "Singapore"),
    ("SK", "Slovakia"),
    ("SI", "Slovenia"),
    ("SB", "Solomon Islands"),
    ("SO", "Somalia"),
    ("ZA", "South Africa"),
    ("KR", "South Korea"),
    ("SS", "South Sudan"),
    ("ES", "Spain"),
    ("LK", "Sri Lanka"),
    ("SD", "Sudan"),
    ("SR", "Suriname"),
    ("SE", "Sweden"),
    ("CH", "Switzerland"),
    ("SY", "Syria"),
    ("TW", "Taiwan"),
    ("TJ", "Tajikistan"),
    ("TZ", "Tanzania"),
    ("TH", "Thailand"),
    ("TL", "Timor-Leste"),
    ("TG", "Togo"),
    ("TO", "Tonga"),
    ("TT", "Trinidad and Tobago"),
    ("TN", "Tunisia"),
    ("TR", "Turkey"),
    ("TM", "Turkmenistan"),
    ("TV", "Tuvalu"),
    ("UG", "Uganda"),
    ("UA", "Ukraine"),
    ("AE", "United Arab Emirates"),
    ("GB", "United Kingdom"),
    ("US", "United States"),
    ("UY", "Uruguay"),
    ("UZ", "Uzbekistan"),
    ("VU", "Vanuatu"),
    ("VA", "Vatican City"),
    ("VE", "Venezuela"),
    ("VN", "Vietnam"),
    ("YE", "Yemen"),
    ("ZM", "Zambia"),
    ("ZW", "Zimbabwe"),
]

ALIASES: dict[str, list[str]] = {
    "AE": ["uae", "dubai", "abu dhabi", "sharjah", "emirates"],
    "US": ["usa", "america", "u.s.", "u.s.a."],
    "GB": ["uk", "britain", "england", "great britain"],
    "SA": ["ksa", "saudia", "kingdom of saudi arabia", "riyadh", "jeddah"],
    "KR": ["south korea", "republic of korea"],
    "KP": ["north korea"],
    "CZ": ["czech republic"],
    "CI": ["cote d'ivoire", "côte d'ivoire"],
    "CV": ["cape verde"],
    "HK": ["hongkong", "h.k.", "hong kong sar"],
    "LK": ["srilanka", "sri lanka", "ceylon"],
}

_BY_NAME = {name.lower(): (code, name) for code, name in COUNTRY_DATA}
_BY_CODE = {code.lower(): (code, name) for code, name in COUNTRY_DATA}

# Longest terms first so "saudi arabia" wins over shorter overlaps.
_COUNTRY_TEXT_TERMS: list[tuple[str, str]] = []
_seen_terms: set[str] = set()
for code, name in COUNTRY_DATA:
    for term in [name.lower(), *ALIASES.get(code, [])]:
        if len(term) < 3 or term in _seen_terms:
            continue
        _seen_terms.add(term)
        _COUNTRY_TEXT_TERMS.append((term, name))
_COUNTRY_TEXT_TERMS.sort(key=lambda item: len(item[0]), reverse=True)

_PHONE_COUNTRY_PREFIXES: list[tuple[str, str]] = [
    ("971", "United Arab Emirates"),
    ("966", "Saudi Arabia"),
    ("974", "Qatar"),
    ("965", "Kuwait"),
    ("968", "Oman"),
    ("973", "Bahrain"),
    ("92", "Pakistan"),
    ("91", "India"),
    ("94", "Sri Lanka"),
    ("880", "Bangladesh"),
    ("60", "Malaysia"),
    ("65", "Singapore"),
    ("62", "Indonesia"),
    ("852", "Hong Kong"),
    ("86", "China"),
    ("81", "Japan"),
    ("61", "Australia"),
    ("64", "New Zealand"),
    ("27", "South Africa"),
    ("234", "Nigeria"),
    ("254", "Kenya"),
    ("20", "Egypt"),
    ("49", "Germany"),
    ("33", "France"),
    ("39", "Italy"),
    ("34", "Spain"),
    ("31", "Netherlands"),
    ("44", "United Kingdom"),
    ("1", "United States"),
]

_TLD_COUNTRY_HINTS: dict[str, str] = {
    "ae": "United Arab Emirates",
    "sa": "Saudi Arabia",
    "qa": "Qatar",
    "kw": "Kuwait",
    "om": "Oman",
    "bh": "Bahrain",
    "pk": "Pakistan",
    "in": "India",
    "au": "Australia",
    "hk": "Hong Kong",
    "uk": "United Kingdom",
    "de": "Germany",
    "fr": "France",
}


def list_countries() -> list[dict[str, str]]:
    return [{"code": code, "name": name} for code, name in COUNTRY_DATA]


def country_search_terms(name: str) -> list[str]:
    """Return lowercase terms that should match a stored country value."""
    key = name.strip().lower()
    terms = {key, name.strip().lower()}
    if key in _BY_NAME:
        code, canonical = _BY_NAME[key]
        terms.add(canonical.lower())
        terms.add(re.sub(r"[^a-z]", "", canonical.lower()))
        terms.update(ALIASES.get(code, []))
        return sorted(terms)
    for code, canonical in COUNTRY_DATA:
        if key == canonical.lower():
            terms.add(canonical.lower())
            terms.add(re.sub(r"[^a-z]", "", canonical.lower()))
            terms.update(ALIASES.get(code, []))
            return sorted(terms)
    for code, aliases in ALIASES.items():
        if key in aliases or any(alias in key for alias in aliases):
            canonical = _BY_CODE[code.lower()][1]
            terms.add(canonical.lower())
            terms.add(re.sub(r"[^a-z]", "", canonical.lower()))
            terms.update(aliases)
    return sorted(terms)


def country_matches(stored: str | None, selected: str) -> bool:
    if not stored or not selected:
        return False
    stored_lower = stored.lower()
    for term in country_search_terms(selected):
        if term and term in stored_lower:
            return True
    return stored_lower == selected.strip().lower()


def resolve_country_name(value: str | None) -> str | None:
    """Map a country string (name, code, or alias) to canonical country name."""
    if not value:
        return None
    key = value.strip().lower()
    if not key:
        return None
    if key in _BY_NAME:
        return _BY_NAME[key][1]
    if key in _BY_CODE:
        return _BY_CODE[key][1]
    for code, aliases in ALIASES.items():
        if key in aliases:
            return _BY_CODE[code.lower()][1]
    # Collapsed spelling: "Srilanka" / "srilanka" → Sri Lanka
    collapsed = re.sub(r"[^a-z]", "", key)
    if collapsed:
        for code, name in COUNTRY_DATA:
            if collapsed == re.sub(r"[^a-z]", "", name.lower()):
                return name
        for code, aliases in ALIASES.items():
            for alias in aliases:
                if collapsed == re.sub(r"[^a-z]", "", alias):
                    return _BY_CODE[code.lower()][1]
    if len(key) >= 4:
        for term, name in _COUNTRY_TEXT_TERMS:
            if key == term or key in term or term in key:
                return name
    return None


def country_from_phone(phone: str | None) -> str | None:
    """Infer country from international dialing prefix."""
    if not phone:
        return None
    digits = re.sub(r"\D", "", phone)
    if digits.startswith("00"):
        digits = digits[2:]
    if not digits:
        return None
    for prefix, name in _PHONE_COUNTRY_PREFIXES:
        if digits.startswith(prefix):
            return name
    return None


def country_from_domain(domain: str | None) -> str | None:
    """Infer country from ccTLD when present (e.g. example.ae)."""
    if not domain:
        return None
    parts = domain.lower().split(".")
    if len(parts) < 2:
        return None
    tld = parts[-1]
    if tld in _TLD_COUNTRY_HINTS:
        return _TLD_COUNTRY_HINTS[tld]
    if len(parts) >= 3 and parts[-2] == "co" and parts[-1] == "uk":
        return "United Kingdom"
    if len(parts) >= 3 and parts[-1] == "au" and parts[-2] in {"com", "net", "org"}:
        return "Australia"
    return None


def detect_countries_in_text(text: str) -> dict[str, int]:
    """Score canonical country names mentioned in free text (word-boundary match)."""
    if not text:
        return {}
    lowered = text.lower()
    scores: dict[str, int] = {}
    for term, name in _COUNTRY_TEXT_TERMS:
        weight = 10 + min(len(term), 20)
        if re.search(rf"\b{re.escape(term)}\b", lowered):
            scores[name] = scores.get(name, 0) + weight
    return scores
