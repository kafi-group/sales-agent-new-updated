"""Repair buyers whose company_name is actually a location (city/country/address).

Moves the misplaced value into city / country / address, then recovers a real
company name from website title, domain brand, CompanyLens, contact email
domain, phone search, or LinkedIn slug. If no name can be found, company_name
becomes an empty string (allowed for sparse table rows).
"""

from __future__ import annotations

import json
import logging
import re
import time
from functools import lru_cache
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx
from sqlalchemy.orm import Session

from db.models import Buyer, Contact
from modules.countries import resolve_country_name
from modules import buyers as buyers_module

logger = logging.getLogger(__name__)

_DATA_DIR = Path(__file__).resolve().parent.parent / "data"
_ALIAS_PATH = _DATA_DIR / "location_company_aliases.json"

# Strong postal cues only — omit industrial/warehouse/zone (common in company names).
_STREET_HINT_RE = re.compile(
    r"\b(street|st\.|road|rd\.|avenue|ave\.|blvd\.?|boulevard|lane|ln\.|"
    r"drive|dr\.|suite|ste\.|floor|fl\.|building|bldg\.?|unit|plot|"
    r"p\.?\s*o\.?\s*box|po box|colony|nagar|chowk|society|township|"
    r"sector|phase|block|bypass|highway|expressway)\b",
    re.I,
)
# South Asian / Middle East neighbourhoods often pasted into company_name.
_AREA_NEIGHBOURHOODS = {
    "model town",
    "gulberg",
    "gulberg iii",
    "gulberg 3",
    "johar town",
    "dha",
    "d.h.a",
    "defence",
    "defense",
    "clifton",
    "bahria town",
    "askari",
    "cantt",
    "cantonment",
    "pechs",
    "nazimabad",
    "north nazimabad",
    "gulshan",
    "gulshan e iqbal",
    "tariq road",
    "shahrah e faisal",
    "i 8",
    "i 9",
    "i 10",
    "f 6",
    "f 7",
    "f 8",
    "f 10",
    "f 11",
    "g 8",
    "g 9",
    "g 10",
    "g 11",
    "blue area",
    "sattelite town",
    "satellite town",
    "westridge",
    "scheme 33",
    "korangi",
    "landhi",
    "saddar",
    "andheri",
    "bandra",
    "powai",
    "gurgaon",
    "gurugram",
    "noida",
    "greater noida",
    "whitefield",
    "koramangala",
    "indiranagar",
    "jayanagar",
    "salt lake",
    "banjara hills",
    "jubilee hills",
    "connaught place",
    "karol bagh",
    "lajpat nagar",
    "nehru place",
    "al quoz",
    "al qusais",
    "jebel ali",
    "jlt",
    "dubai investment park",
    "dip",
    "sharjah industrial",
    "ajman industrial",
}
_AREA_COUNTRY_HINTS = {
    "model town": "Pakistan",
    "gulberg": "Pakistan",
    "johar town": "Pakistan",
    "dha": "Pakistan",
    "defence": "Pakistan",
    "clifton": "Pakistan",
    "bahria town": "Pakistan",
    "pechs": "Pakistan",
    "nazimabad": "Pakistan",
    "korangi": "Pakistan",
    "andheri": "India",
    "bandra": "India",
    "gurgaon": "India",
    "gurugram": "India",
    "noida": "India",
    "whitefield": "India",
    "koramangala": "India",
    "banjara hills": "India",
    "karol bagh": "India",
    "lajpat nagar": "India",
    "al quoz": "United Arab Emirates",
    "al qusais": "United Arab Emirates",
    "jebel ali": "United Arab Emirates",
    "jlt": "United Arab Emirates",
}
_GENERIC_BUILDING_WORDS = {
    "business",
    "national",
    "international",
    "state",
    "city",
    "main",
    "new",
    "old",
    "the",
    "royal",
    "central",
    "global",
    "united",
    "general",
    "public",
    "private",
    "pakistani",
    "thai",
    "indian",
    "arab",
    "asian",
    "european",
}
# UK outward+inward postcodes: W1K 4QY, EN1 1DZ, ME2-4LT, SW1A1AA…
_UK_POSTCODE_RE = re.compile(
    r"\b([A-Z]{1,2}\d[A-Z\d]?(?:\s+|-)?\d[A-Z]{2})\b",
    re.I,
)
# Common UK counties / areas / towns that appear instead of company names.
_UK_COUNTIES = {
    "middlesex",
    "surrey",
    "essex",
    "kent",
    "hertfordshire",
    "herts",
    "bedfordshire",
    "beds",
    "berkshire",
    "berks",
    "buckinghamshire",
    "bucks",
    "oxfordshire",
    "oxon",
    "hampshire",
    "hants",
    "sussex",
    "east sussex",
    "west sussex",
    "dorset",
    "devon",
    "cornwall",
    "somerset",
    "wiltshire",
    "gloucestershire",
    "glos",
    "worcestershire",
    "worcs",
    "warwickshire",
    "warks",
    "staffordshire",
    "staffs",
    "shropshire",
    "salop",
    "cheshire",
    "lancashire",
    "lancs",
    "yorkshire",
    "north yorkshire",
    "south yorkshire",
    "west yorkshire",
    "east yorkshire",
    "durham",
    "cumbria",
    "northumberland",
    "nottinghamshire",
    "notts",
    "derbyshire",
    "leicestershire",
    "leics",
    "lincolnshire",
    "lincs",
    "norfolk",
    "suffolk",
    "cambridgeshire",
    "cambs",
    "greater london",
    "greater manchester",
    "west midlands",
    "merseyside",
    "tyne and wear",
    "glasgow",
    "edinburgh",
    "cardiff",
    "belfast",
    "bristol",
    "leeds",
    "sheffield",
    "liverpool",
    "newcastle",
    "brighton",
    "reading",
    "oxford",
    "cambridge",
    "enfield",
    "croydon",
    "romford",
    "ilford",
    "slough",
    "watford",
    "luton",
    "greenford",
    "rochester",
    "medway",
    "gillingham",
    "chatham",
    "gravesend",
    "dartford",
    "rainham",
    "dagenham",
    "barking",
    "hounslow",
    "ealing",
    "wembley",
    "harrow",
    "uxbridge",
    "nottingham",
    "oldham",
    "bolton",
    "stockport",
    "wigan",
    "preston",
    "blackburn",
    "bradford",
    "huddersfield",
    "wakefield",
    "doncaster",
    "rotherham",
    "barnsley",
    "chester",
    "warrington",
    "stoke",
    "stoke on trent",
    "coventry",
    "leicester",
    "derby",
    "northampton",
    "milton keynes",
    "peterborough",
    "norwich",
    "ipswich",
    "southend",
    "basildon",
    "maidstone",
    "canterbury",
    "ashford",
    "tunbridge wells",
    "guildford",
    "woking",
    "crawley",
    "worthing",
    "eastbourne",
    "hastings",
    "portsmouth",
    "southampton",
    "bournemouth",
    "poole",
    "exeter",
    "plymouth",
    "swansea",
    "newport",
    "aberdeen",
    "dundee",
    "middlesbrough",
    "sunderland",
    "hull",
    "york",
    "harrogate",
    "bath",
    "cheltenham",
    "worcester",
    "hereford",
    "shrewsbury",
    "telford",
    "wolverhampton",
    "dudley",
    "walsall",
    "west bromwich",
    "solihull",
    "sutton coldfield",
}
_COMPANY_SUFFIX_RE = re.compile(
    r"\b(llc|l\.l\.c|ltd|limited|inc|incorporated|corp|corporation|gmbh|"
    r"pte|pvt|trading|foods|food|group|international|co\.?|company|"
    r"enterprises|imports|exports|distributors?|wholesale|holdings?|"
    r"hypermarket|supermarket|warehouse|companhia)\b",
    re.I,
)
# Short aliases only — do NOT treat every ISO code (ARIA→BG, Swan→BW) as a country.
_STRICT_COUNTRY_ALIASES = {
    "uae",
    "uk",
    "usa",
    "us",
    "u.s.",
    "u.s.a.",
    "ksa",
    "rsa",
    "rok",
    "prc",
    "ua",
    "gb",
    "u.k.",
}
_FREE_EMAIL_DOMAINS = {
    "gmail.com",
    "yahoo.com",
    "yahoo.co.uk",
    "hotmail.com",
    "outlook.com",
    "live.com",
    "icloud.com",
    "aol.com",
    "mail.com",
    "proton.me",
    "protonmail.com",
    "gmx.com",
    "yandex.com",
}
# Frequent importer markets — used as city heuristics when company_name equals these.
_KNOWN_CITIES = {
    "dubai",
    "abu dhabi",
    "sharjah",
    "ajman",
    "ras al khaimah",
    "fujairah",
    "umm al quwain",
    "al ain",
    "riyadh",
    "jeddah",
    "dammam",
    "khobar",
    "mecca",
    "medina",
    "doha",
    "kuwait",
    "kuwait city",
    "manama",
    "muscat",
    "salalah",
    "amman",
    "cairo",
    "alexandria",
    "lagos",
    "nairobi",
    "johannesburg",
    "cape town",
    "durban",
    "karachi",
    "lahore",
    "islamabad",
    "singapore",
    "kuala lumpur",
    "jakarta",
    "bangkok",
    "ho chi minh",
    "hanoi",
    "manila",
    "london",
    "manchester",
    "birmingham",
    "rotterdam",
    "amsterdam",
    "hamburg",
    "berlin",
    "frankfurt",
    "paris",
    "marseille",
    "madrid",
    "barcelona",
    "milan",
    "rome",
    "toronto",
    "vancouver",
    "montreal",
    "new york",
    "los angeles",
    "houston",
    "chicago",
    "miami",
    "sydney",
    "melbourne",
    "perth",
    "auckland",
}


def _norm(text: str | None) -> str:
    return re.sub(r"\s+", " ", (text or "").strip())


def _norm_key(text: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (text or "").lower()).strip()


def _has_company_suffix(text: str) -> bool:
    return bool(_COMPANY_SUFFIX_RE.search(text or ""))


def _strict_country_name(text: str | None) -> str | None:
    """Resolve only when ``text`` is a real country name or a known short alias."""
    t = _norm(text)
    if not t or len(t) < 2:
        return None
    country = resolve_country_name(t)
    if not country:
        return None
    if _norm_key(t) == _norm_key(country):
        return country
    compact = re.sub(r"[^a-z.]", "", t.lower())
    if compact in _STRICT_COUNTRY_ALIASES:
        return country
    return None


def _normalise_uk_postcode(raw: str) -> str:
    compact = re.sub(r"[\s\-]+", "", (raw or "").upper())
    if len(compact) < 5:
        return compact
    return f"{compact[:-3]} {compact[-3:]}"


def _uk_postcode_in(text: str) -> str | None:
    m = _UK_POSTCODE_RE.search(text or "")
    if not m:
        return None
    return _normalise_uk_postcode(m.group(1))


def _place_before_postcode(text: str, postcode: str | None = None) -> str | None:
    """Text before UK postcode(s), e.g. 'London' / 'Kent' from postcode strings."""
    t = _norm(text)
    # Strip every postcode occurrence (handles "Kent, ME2 4LT, ME2 4DU")
    left = _UK_POSTCODE_RE.sub(" ", t)
    left = re.sub(r"\s+", " ", left).strip(" ,;-/")
    if not left or len(left) < 2 or len(left) > 60:
        return None
    if _has_company_suffix(left):
        return None
    # Prefer the rightmost geographic token when several places remain
    parts = [p.strip() for p in re.split(r"\s*,\s*", left) if p.strip()]
    if not parts:
        return None
    for part in reversed(parts):
        key = _norm_key(part)
        if key in _KNOWN_CITIES or key in _UK_COUNTIES:
            return part
    # Single remaining place phrase without digits
    if len(parts) == 1 and not re.search(r"\d", parts[0]) and len(parts[0].split()) <= 4:
        return parts[0]
    if not re.search(r"\d", left) and len(left.split()) <= 4:
        return left
    return parts[0] if len(parts[0].split()) <= 4 and not re.search(r"\d", parts[0]) else None


def _is_uk_place_token(text: str) -> bool:
    key = _norm_key(text)
    if not key or len(key) < 2:
        return False
    if key in _KNOWN_CITIES or key in _UK_COUNTIES:
        return True
    if key in {"england", "scotland", "wales", "northern ireland", "great britain", "uk", "u k"}:
        return True
    return False


def _classify_uk_place_chain(text: str) -> dict[str, Any] | None:
    """Detect UK-only place chains: 'Greenford, Middlesex' / 'Rochester, Kent, LONDON'."""
    t = _norm(text)
    if "," not in t or _has_company_suffix(t) or _uk_postcode_in(t):
        return None
    parts = [p.strip() for p in t.split(",") if p.strip()]
    if not (2 <= len(parts) <= 4):
        return None
    if any(re.search(r"\d", p) for p in parts):
        return None
    if any(len(p) > 40 for p in parts):
        return None

    keys = [_norm_key(p) for p in parts]
    uk_hits = sum(1 for p in parts if _is_uk_place_token(p))
    county_hits = sum(1 for k in keys if k in _UK_COUNTIES)

    # All segments are known UK places/counties/cities
    if uk_hits == len(parts):
        # Leftmost token is usually the town (Rochester, Kent, LONDON)
        return {
            "kind": "address",
            "address": t[:500],
            "city": parts[0][:255],
            "country": "United Kingdom",
        }

    # "SomeTown, Kent/Middlesex/…" — right side UK county, left looks like a place
    if len(parts) == 2 and keys[1] in _UK_COUNTIES:
        left = parts[0]
        if (
            not _has_company_suffix(left)
            and len(left.split()) <= 4
            and not left.isupper()
            and "house" not in left.lower()
            and "park" not in left.lower()
        ):
            return {
                "kind": "address",
                "address": t[:500],
                "city": left[:255],
                "country": "United Kingdom",
            }

    # Majority UK tokens with at least one county (e.g. Rochester, Kent, LONDON)
    if len(parts) >= 3 and uk_hits >= 2 and county_hits >= 1:
        city = next((p for p in parts if _norm_key(p) in _KNOWN_CITIES), parts[0])
        return {
            "kind": "address",
            "address": t[:500],
            "city": city[:255],
            "country": "United Kingdom",
        }

    return None


def _neighbourhood_in(text: str) -> str | None:
    key = _norm_key(text)
    for area in sorted(_AREA_NEIGHBOURHOODS, key=len, reverse=True):
        if key == area or f" {area} " in f" {key} " or key.endswith(f" {area}") or key.startswith(f"{area} "):
            return area
    return None


def _country_hint_from_text(text: str) -> str | None:
    area = _neighbourhood_in(text)
    if area and area in _AREA_COUNTRY_HINTS:
        return _AREA_COUNTRY_HINTS[area]
    t = _norm(text)
    if _uk_postcode_in(t):
        return "United Kingdom"
    if re.search(r"\bv\.?p\.?o\.?\b|\bvillage\s+post\b|\bgt\s+\w+\s+(rd|road)\b", t, re.I):
        return "India"
    return None


def _country_hint_from_phone(phone: str | None) -> str | None:
    digits = re.sub(r"\D", "", phone or "")
    if digits.startswith("00"):
        digits = digits[2:]
    if digits.startswith("92"):
        return "Pakistan"
    if digits.startswith("91"):
        return "India"
    if digits.startswith("971"):
        return "United Arab Emirates"
    if digits.startswith("966"):
        return "Saudi Arabia"
    if digits.startswith("974"):
        return "Qatar"
    if digits.startswith("965"):
        return "Kuwait"
    if digits.startswith("968"):
        return "Oman"
    if digits.startswith("973"):
        return "Bahrain"
    if digits.startswith("44"):
        return "United Kingdom"
    if digits.startswith("1") and len(digits) >= 11:
        return "United States"
    return None


def _looks_like_street_address(text: str) -> bool:
    """True for postal-looking strings (street cues, UK postcodes, SA neighbourhoods)."""
    t = _norm(text)
    if len(t) < 4:
        return False

    # UK postcode alone or with place: "W1K 4QY", "London, W1K 4QY", "Middlesex EN1 1DZ"
    if _uk_postcode_in(t):
        if _has_company_suffix(t) and not re.match(r"^\d", t):
            # "Acme Foods Ltd, London SW1A 1AA" — keep as company
            return False
        return True

    # Plot / house + neighbourhood: "40-E, Model Town"
    if _neighbourhood_in(t) and (
        re.match(r"^\d", t)
        or re.search(r"\b(?:plot|block|sector|phase|house|flat|apt|apartment)\b", t, re.I)
        or "," in t
    ):
        if _has_company_suffix(t):
            return False
        return True

    # Indian village / VPO / GT road style
    if re.search(r"\bv\.?p\.?o\.?\b", t, re.I) and not _has_company_suffix(t):
        return True
    if re.search(r"\b(?:gt|nh|sh)\s*[- ]?\s*\w+.+\b(?:rd|road)\b", t, re.I) and not _has_company_suffix(t):
        return True

    # "Brand House 56-57 km" / "Brand Tower, GT Road" — require address remainder
    # (do NOT treat trade-show names like "Mauri Center (Ref: Anuga 2013)" as addresses)
    building_addr = re.search(
        r"\b([A-Za-z][A-Za-z0-9&.'-]{2,40})\s+"
        r"(?:house|building|tower|plaza|complex|chambers)\b\s+"
        r"(?:"
        r"\d{1,4}\s*[-–]?\s*\d{0,4}\s*km\b|"
        r"\d{1,4}\s*mile|"
        r".{0,60}\b(?:road|rd\.?|street|st\.?|colony|nagar|bypass|highway)\b"
        r")",
        t,
        re.I,
    )
    if building_addr and building_addr.group(1).lower() not in _GENERIC_BUILDING_WORDS and not _has_company_suffix(t):
        return True

    # Bare road / colony phrasing without a leading company suffix
    if (
        not _has_company_suffix(t)
        and len(t.split()) <= 8
        and re.search(
            r"\b[\w.&'-]+(?:\s+[\w.&'-]+){0,4}\s+"
            r"(?:road|rd\.?|street|st\.?|avenue|ave\.?|lane|colony|nagar|chowk|bypass|highway)\b\s*$",
            t,
            re.I,
        )
        and not re.search(r"\b(safety|application|solutions|services|systems|technologies)\b", t, re.I)
    ):
        return True

    if len(t) < 10:
        return False
    if not re.search(r"\d", t):
        return False
    if not _STREET_HINT_RE.search(t):
        return False
    # "Dana Hypermarket - Salwa Road" / "Cargill … Road Safety" — business, not address
    if _has_company_suffix(t) and not re.match(r"^\d", t):
        return False
    if re.search(
        r"\b(hypermarket|supermarket|incorporated|corporation|prototyping|"
        r"application|safety|industrial)\b",
        t,
        re.I,
    ) and not re.match(r"^\d", t):
        return False
    # Prefer starting with a number / PO Box, or containing a clear street number pattern
    if re.match(r"^(?:p\.?\s*o\.?\s*box|po box)\b", t, re.I):
        return True
    if re.match(r"^\d", t):
        return True
    # "Unit 1, …" / "Suite 200 …"
    if re.match(r"^(?:unit|suite|ste\.?|plot|building|bldg\.?|block|sector|phase)\s*[A-Z0-9]", t, re.I):
        return True
    # Embedded house number before street word: "… 12 Industrial Road …"
    if re.search(
        r"\b\d{1,5}[A-Za-z]?\s+[A-Za-z].{0,40}\b(?:street|st\.|road|rd\.|avenue|ave\.|"
        r"blvd|boulevard|lane|ln\.|drive|dr\.|colony|nagar)\b",
        t,
        re.I,
    ):
        return True
    return False


def _domain_from_url(url: str | None) -> str | None:
    if not (url or "").strip():
        return None
    raw = url.strip()
    if "://" not in raw:
        raw = f"https://{raw}"
    try:
        host = urlparse(raw).netloc.lower()
    except Exception:
        return None
    if host.startswith("www."):
        host = host[4:]
    return host or None


def _brand_from_domain(domain: str | None) -> str | None:
    if not domain or "." not in domain:
        return None
    label = domain.split(".")[0].strip().lower()
    if not label or label in {"www", "mail", "email", "webmail", "smtp", "imap", "ftp"}:
        return None
    if label.isdigit() or len(label) < 3:
        return None
    # Property / directory hosts are not buyer brands
    if re.search(r"real.?estate|propert|homes?|rightmove|zoopla|directory|yellow", label):
        return None
    parts = [p for p in re.split(r"[-_]+", label) if p]
    if not parts:
        return None
    return " ".join(p.capitalize() for p in parts)[:120]


_JUNK_RECOVERED_NAMES = {
    "n/a",
    "na",
    "none",
    "null",
    "unknown",
    "-",
    "company",
    "companies",
    "home",
    "homepage",
    "welcome",
    "index",
    "untitled",
    "login",
    "sign in",
    "contact",
    "about",
    "about us",
    "official site",
    "official website",
    "house prices",
    "rightmove",
    "zoopla",
    "gumtree",
    "yelp",
    "yellow pages",
    "google maps",
    "maps",
    "directions",
    "postcode",
    "postcodes",
    "wikipedia",
    "facebook",
    "linkedin",
    "instagram",
    "twitter",
    "justdial",
    "indiamart",
    "tradeindia",
    "tilda information",
}
_JUNK_TITLE_FRAGMENTS = (
    "house prices",
    "rightmove",
    "zoopla",
    "google maps",
    "postcode",
    "phone numbers",
    "telephone numbers",
    "suppliers directory",
    "wholesale suppliers directory",
    "business directory",
    "yellow pages",
    "persons with significant control",
    "filing history",
    "company profile",
    "registered office",
    "endole",
    "companies house",
    "find and update",
    "real estate and management",
    "property for sale",
    "homes for sale",
)


@lru_cache(maxsize=1)
def _load_location_aliases() -> dict[str, str]:
    """fragment (normalized key) → company name from data/location_company_aliases.json."""
    try:
        raw = json.loads(_ALIAS_PATH.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.debug("location aliases not loaded: %s", exc)
        return {}
    aliases = raw.get("aliases") if isinstance(raw, dict) else None
    if not isinstance(aliases, dict):
        return {}
    out: dict[str, str] = {}
    for key, value in aliases.items():
        k = _norm_key(str(key))
        v = _norm(str(value))
        if k and v and not str(key).startswith("_"):
            out[k] = v
    return out


def _alias_company_from_texts(*texts: str | None) -> str | None:
    """Longest alias fragment match across company/address/city fields."""
    aliases = _load_location_aliases()
    if not aliases:
        return None
    blob = _norm_key(" ".join(t for t in texts if t))
    if not blob:
        return None
    best_key = ""
    best_name = None
    for key, name in aliases.items():
        if key in blob and len(key) > len(best_key):
            best_key = key
            best_name = name
    return best_name


def _clean_recovered_title(name: str | None) -> str | None:
    """Strip directory / Companies House / website chrome from a search title."""
    text = _norm(name)
    if not text:
        return None
    # "RAIGINS LTD persons with significant control" → "RAIGINS LTD"
    m = re.match(
        r"^(.+?\b(?:ltd|limited|llc|inc|incorporated|plc|gmbh|pvt|private\s+limited))\b",
        text,
        re.I,
    )
    if m:
        text = m.group(1).strip(" -|")
    text = re.sub(
        r"\s*[-|–—:]\s*(home|official site|official website|linkedin|facebook|wikipedia).*$",
        "",
        text,
        flags=re.I,
    )
    text = re.sub(
        r"\s+\b(information|official|website|homepage|uk|u\.k\.)\s*$",
        "",
        text,
        flags=re.I,
    )
    text = text.strip(" -|:")
    return text or None


def _looks_like_company_name(text: str) -> bool:
    """True when a recovered string looks like a trading name, not a webpage title."""
    t = _norm(text)
    if not t or len(t) > 80:
        return False
    if _has_company_suffix(t):
        return True
    if re.search(r"\b(foods?|rice|spices?|trading|imports?|exports?|mills?)\b", t, re.I):
        return True
    # Short brand-like tokens (Veetee, Tilda, Natco)
    words = t.split()
    if 1 <= len(words) <= 4 and not re.search(r"\d{3,}", t):
        if not re.search(
            r"\b(directory|phone|numbers|map|price|sale|office|address|road|street|lane)\b",
            t,
            re.I,
        ):
            return True
    return False


def _is_plausible_recovered_name(name: str | None, *, bad_location: str | None = None) -> bool:
    text = _clean_recovered_title(name) or _norm(name)
    if len(text) < 2 or len(text) > 120:
        return False
    low = text.lower()
    if low in _JUNK_RECOVERED_NAMES:
        return False
    if any(j in low for j in _JUNK_TITLE_FRAGMENTS):
        return False
    if low.startswith(("http://", "https://", "www.")):
        return False
    if "@" in text:
        return False
    if bad_location and _norm_key(text) == _norm_key(bad_location):
        return False
    # Reject pure locations as recovered "names"
    if classify_location_name(text) is not None and not _has_company_suffix(text):
        return False
    if not _looks_like_company_name(text):
        return False
    return True


def _name_from_address_blob(text: str | None, *, bad_location: str | None = None) -> str | None:
    """Pull a company from rich imported address strings."""
    t = _norm(text)
    if not t:
        return None
    # "Example: A.B. EXPLORATION LIMITED; …"
    example = re.search(
        r"\bexample:\s*([A-Za-z0-9][A-Za-z0-9 &.'\-]{2,80}?)(?:;|,|$)",
        t,
        re.I,
    )
    if example:
        name = _clean_recovered_title(example.group(1).strip(" ,.;"))
        if _is_plausible_recovered_name(name, bad_location=bad_location or t):
            return name[:120]
    # Leading "COMPANY NAME, 12 Street…" / "COMPANY NAME - 12 Street"
    lead = re.match(
        r"^([A-Za-z][A-Za-z0-9 &.'\-]{2,60}?)\s*[,–—-]\s*\d",
        t,
    )
    if lead:
        name = _clean_recovered_title(lead.group(1))
        if name and _has_company_suffix(name) and _is_plausible_recovered_name(name, bad_location=bad_location or t):
            return name[:120]
    # "X Business Park" only when X looks like a brand (not Industrial/Retail)
    park = re.search(
        r"\b([A-Za-z][A-Za-z0-9&.'-]{2,30})\s+Business\s+Park\b",
        t,
        re.I,
    )
    if park and park.group(1).lower() not in _GENERIC_BUILDING_WORDS | {"industrial", "retail", "office"}:
        name = park.group(1).strip()
        if name.isupper() or name.islower():
            name = name.capitalize()
        if _is_plausible_recovered_name(name, bad_location=bad_location or t):
            return name
    return _name_from_building_label(t)


def _name_from_building_label(text: str | None) -> str | None:
    """Pull a brand from labels like 'Veetee House 56-57 km' / 'Unit 1, Veetee House'."""
    t = _norm(text)
    if not t:
        return None
    # Prefer explicit "Example: COMPANY" crumbs from imported address blobs
    example = re.search(
        r"\bexample:\s*([A-Za-z0-9][A-Za-z0-9 &.'\-]{2,80}?)(?:;|,|$)",
        t,
        re.I,
    )
    if example:
        name = _clean_recovered_title(example.group(1).strip(" ,.;"))
        if _is_plausible_recovered_name(name, bad_location=t):
            return name[:120]
    # House/Tower/Plaza only — skip Centre/Center (too many venue / HQ labels)
    m = re.search(
        r"(?:^|,\s*)([A-Za-z][A-Za-z0-9&.'-]{2,40})\s+"
        r"(?:house|building|tower|plaza|complex|chambers)\b",
        t,
        re.I,
    )
    if not m:
        return None
    name = m.group(1).strip(" ,.")
    if name.lower() in _GENERIC_BUILDING_WORDS:
        return None
    # Title-case short brands for consistency
    if name.isupper() or name.islower():
        name = name.capitalize()
    if _is_plausible_recovered_name(name, bad_location=t):
        return name
    return None


def _collect_phones(contacts: list[Contact], buyer: Buyer | None = None) -> list[str]:
    phones: list[str] = []
    for contact in contacts:
        for attr in ("phone", "primary_phone", "secondary_phone", "secondary_mobile"):
            val = _norm(getattr(contact, attr, None))
            if val and val not in phones:
                phones.append(val)
    if buyer and buyer.address:
        # Phone glued onto address: "92-300-0844328. 40, E Model Town…"
        m = re.match(r"^(\+?\d[\d\s\-().]{7,20})\s*[.\s]", _norm(buyer.address))
        if m:
            val = m.group(1).strip()
            if val not in phones:
                phones.append(val)
    return phones


def _score_search_title(title: str, *, bad_location: str | None = None) -> int:
    cleaned = _clean_recovered_title(title) or ""
    if not _is_plausible_recovered_name(cleaned, bad_location=bad_location):
        return -1
    score = 1
    low = cleaned.lower()
    if _has_company_suffix(cleaned):
        score += 4
    if re.search(r"\b(foods?|rice|spices?|salt|trading|import|export|mills?)\b", low):
        score += 3
    if re.search(r"\b(directory|phone|map|price|estate|property)\b", low):
        score -= 5
    return score


def classify_location_name(raw: str | None) -> dict[str, Any] | None:
    """If ``raw`` looks like a location (not a company), return relocation fields.

    Conservative on purpose: short brand names (HANOS, Bayara, Puratos) must NOT
    be treated as cities. Only known cities, country labels, clear street addresses,
    or ``KnownCity, Country`` pairs qualify.
    """
    text = _norm(raw)
    if len(text) < 2:
        return None
    if _has_company_suffix(text):
        return None
    # Person / title cues — keep as company/contact, not location
    if re.match(r"^(dr|mr|mrs|ms|prof)\b", text, re.I):
        return None
    # Domain-like company handles
    if "." in text and re.search(r"\.[a-z]{2,}$", text, re.I):
        return None

    key = _norm_key(text)

    # Known city list (Dubai etc.)
    if key in _KNOWN_CITIES:
        return {
            "kind": "city",
            "city": text[:255],
            "country": None,
            "address": None,
        }

    # Pure country (strict — avoids ARIA/Swan/PT false positives)
    country_only = _strict_country_name(text)
    if country_only:
        return {
            "kind": "country",
            "country": country_only,
            "city": None,
            "address": None,
        }

    # Clear street / postal / neighbourhood address (UK + international)
    if _looks_like_street_address(text):
        from modules.lead_discovery import _parse_city_from_address

        city = _parse_city_from_address(text)
        parts = [p.strip() for p in text.split(",") if p.strip()]
        country = _strict_country_name(parts[-1]) if parts else None
        uk_pc = _uk_postcode_in(text)
        area = _neighbourhood_in(text)
        if uk_pc:
            country = country or "United Kingdom"
            place = _place_before_postcode(text)
            if place:
                place_key = _norm_key(place)
                if place_key in _KNOWN_CITIES or place_key in _UK_COUNTIES:
                    city = place
                elif len(place.split()) <= 4 and not re.search(r"\d", place):
                    city = place
        if area:
            # Prefer neighbourhood as city when plot/area style (Model Town)
            pretty = " ".join(w.capitalize() for w in area.split())
            if not city or _norm_key(city) == area:
                city = pretty
            country = country or _country_hint_from_text(text)
        if not country:
            country = _country_hint_from_text(text)
        if city and (
            _norm_key(city) not in _KNOWN_CITIES
            and _norm_key(city) not in _UK_COUNTIES
            and _norm_key(city) not in _AREA_NEIGHBOURHOODS
            and not uk_pc
            and not area
        ):
            city = None
        return {
            "kind": "address",
            "address": text[:500],
            "city": city,
            "country": country,
        }

    # Bare UK county / area / town name (no company suffix)
    if key in _UK_COUNTIES:
        return {
            "kind": "city",
            "city": text[:255],
            "country": "United Kingdom",
            "address": None,
        }

    # Bare known neighbourhood (Model Town, Gulberg, Al Quoz, …)
    if key in _AREA_NEIGHBOURHOODS:
        pretty = " ".join(w.capitalize() for w in key.split())
        return {
            "kind": "city",
            "city": pretty[:255],
            "country": _AREA_COUNTRY_HINTS.get(key),
            "address": text[:500],
        }

    # "Estate Rochester" / "Industrial Estate Dartford"
    estate = re.match(
        r"^(?:(?:industrial|trading|business)\s+)?estate\s+(.+)$",
        text,
        re.I,
    )
    if estate and _is_uk_place_token(estate.group(1)):
        place = estate.group(1).strip()
        return {
            "kind": "address",
            "address": text[:500],
            "city": place[:255],
            "country": "United Kingdom",
        }

    # UK place chains without postcodes: "Greenford, Middlesex"
    uk_chain = _classify_uk_place_chain(text)
    if uk_chain:
        return uk_chain

    # "KnownCity, Country" only — both sides must be clearly geographic
    for sep in (",", " - ", " – ", " — "):
        if sep not in text:
            continue
        left, right = [p.strip() for p in text.split(sep, 1)]
        if not left or not right:
            continue
        left_key = _norm_key(left)
        right_key = _norm_key(right)
        right_country = _strict_country_name(right)
        left_country = _strict_country_name(left)

        if right_country and left_key in _KNOWN_CITIES:
            return {
                "kind": "city_country",
                "city": left[:255],
                "country": right_country,
                "address": None,
            }
        if left_country and right_key in _KNOWN_CITIES:
            return {
                "kind": "city_country",
                "city": right[:255],
                "country": left_country,
                "address": None,
            }
        # Multi-word place + country (e.g. "Ras Al Khaimah, UAE")
        if (
            right_country
            and len(left.split()) >= 2
            and len(left) <= 40
            and not left.isupper()
            and not re.search(r"\d", left)
            and "house" not in left.lower()
            and "park" not in left.lower()
        ):
            return {
                "kind": "city_country",
                "city": left[:255],
                "country": right_country,
                "address": None,
            }

    return None


def _fetch_website_company_name(url: str) -> str | None:
    try:
        response = httpx.get(
            url if "://" in url else f"https://{url}",
            headers={
                "User-Agent": "KafiSalesAgent/1.0 (company-name-repair)",
                "Accept": "text/html,application/xhtml+xml",
            },
            follow_redirects=True,
            timeout=12,
        )
        response.raise_for_status()
        html = response.text[:400_000]
    except Exception:
        return None

    from modules.lead_discovery import _clean_company_name

    og = re.search(
        r'<meta[^>]+property=["\']og:site_name["\'][^>]+content=["\']([^"\']+)["\']',
        html,
        re.I,
    ) or re.search(
        r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:site_name["\']',
        html,
        re.I,
    )
    if og:
        name = _clean_company_name(og.group(1))
        if _is_plausible_recovered_name(name):
            return name

    title_m = re.search(r"<title[^>]*>(.*?)</title>", html, re.I | re.S)
    if title_m:
        name = _clean_company_name(re.sub(r"\s+", " ", title_m.group(1)))
        if _is_plausible_recovered_name(name):
            return name
    return None


def _recover_company_name(buyer: Buyer, contacts: list[Contact], *, bad_name: str) -> tuple[str | None, str]:
    """Try hard to recover a real company name. Returns (name_or_None, source)."""

    # 0) Curated aliases (postcode / street / building → known buyer)
    alias = _alias_company_from_texts(
        bad_name,
        buyer.address,
        buyer.city,
        buyer.company_name,
    )
    if _is_plausible_recovered_name(alias, bad_location=bad_name):
        return alias[:120], "location_alias"

    # 1) Brand / Example: crumbs in company_name or address blob
    for candidate in (bad_name, buyer.address):
        embedded = _name_from_address_blob(candidate, bad_location=bad_name)
        if embedded:
            return embedded, "address_blob"

    # 2) Website page title / og:site_name
    if buyer.website_url:
        name = _fetch_website_company_name(buyer.website_url)
        cleaned = _clean_recovered_title(name)
        if _is_plausible_recovered_name(cleaned, bad_location=bad_name):
            return cleaned[:120], "website_title"

    # 3) CompanyLens by domain
    domain = _domain_from_url(buyer.website_url)
    if domain:
        try:
            from modules.company_enrichment import enrich_domain_companylens

            lens = enrich_domain_companylens(domain)
            name = (lens.get("name") or "").strip() or None
            if _is_plausible_recovered_name(name, bad_location=bad_name):
                return name[:120], "companylens"
        except Exception:
            pass
        brand = _brand_from_domain(domain)
        # Domain brands are weak (mnrealestate) — only accept with company-like cues
        if brand and _has_company_suffix(brand) and _is_plausible_recovered_name(brand, bad_location=bad_name):
            return brand, "website_domain"

    # 4) Contact business email domain
    for contact in contacts:
        for email in (contact.email, contact.secondary_email):
            if not email or "@" not in email:
                continue
            host = email.split("@", 1)[1].strip().lower()
            if host in _FREE_EMAIL_DOMAINS:
                continue
            try:
                from modules.company_enrichment import enrich_domain_companylens

                lens = enrich_domain_companylens(host)
                name = (lens.get("name") or "").strip() or None
                if _is_plausible_recovered_name(name, bad_location=bad_name):
                    return name[:120], "email_domain_companylens"
            except Exception:
                pass
            brand = _brand_from_domain(host)
            if _is_plausible_recovered_name(brand, bad_location=bad_name):
                return brand[:120], "email_domain"

    # 5) LinkedIn company slug
    linkedin = (buyer.linkedin_company_url or "").strip()
    if "linkedin.com/company/" in linkedin.lower():
        slug = linkedin.rstrip("/").split("/")[-1]
        slug = re.sub(r"[^a-zA-Z0-9\-]", "", slug)
        if slug and len(slug) >= 3:
            brand = " ".join(p.capitalize() for p in slug.split("-") if p)
            if _is_plausible_recovered_name(brand, bad_location=bad_name):
                return brand[:120], "linkedin_slug"

    # 6) Phone / address web search (scored — reject directories & property pages)
    try:
        from modules import web_search
        from modules.lead_discovery import _clean_company_name

        phones = _collect_phones(contacts, buyer)
        queries: list[str] = []
        for phone in phones[:2]:
            digits = re.sub(r"\D", "", phone)
            if len(digits) >= 8:
                queries.append(f'"{phone}" rice OR food OR ltd OR limited OR foods')
                queries.append(f'"{phone}"')
        addr = _norm(buyer.address)
        # Prefer the cleaned street part of address (drop glued phone prefix)
        addr_core = re.sub(r"^[\d+\-().\s]{6,}[.\s]+", "", addr).strip() if addr else ""
        if addr_core and len(addr_core) >= 12:
            queries.append(f'"{addr_core[:90]}" rice OR food OR ltd OR limited')
            uk_pc = _uk_postcode_in(addr_core)
            if uk_pc:
                queries.append(f'"{uk_pc}" rice OR food OR ltd company')
        embedded = _name_from_building_label(bad_name)
        if embedded:
            queries.append(f'"{embedded}" rice OR food company')
        if bad_name and _uk_postcode_in(bad_name):
            queries.append(f'"{_uk_postcode_in(bad_name)}" rice OR food OR ltd')
        # Person name + place (when contact looks human, not a role)
        for contact in contacts[:2]:
            person = _norm(contact.full_name)
            if (
                person
                and not person.startswith("(")
                and re.match(r"^(mr|mrs|ms|miss|dr)\b", person, re.I)
                and buyer.city
            ):
                queries.append(f'"{person}" "{buyer.city}" rice OR food company')
                break
        if domain:
            queries.append(f"site:{domain}")

        best: tuple[int, str, str] | None = None  # score, name, source
        seen_q: set[str] = set()
        for query in queries:
            if query in seen_q:
                continue
            seen_q.add(query)
            if len(seen_q) > 6:
                break
            if not web_search.any_combined_provider_available():
                break
            found = web_search.search_combined(query, num=5)
            kg = (found.knowledge_graph or {}) if found else {}
            title = _clean_recovered_title((kg.get("title") or "").strip())
            score = _score_search_title(title or "", bad_location=bad_name)
            if score > 0 and (best is None or score > best[0]):
                best = (score, title[:120], "web_search_kg")
            for item in (found.organic or [])[:5]:
                title = _clean_recovered_title(_clean_company_name(item.get("title") or ""))
                link = (item.get("link") or "").lower()
                if any(
                    junk in link
                    for junk in (
                        "rightmove.",
                        "zoopla.",
                        "facebook.com",
                        "linkedin.com",
                        "wikipedia.org",
                        "justdial.com",
                        "maps.google",
                        "onthemarket.",
                        "gumtree.",
                        "yell.com",
                        "192.com",
                        "endole.co.uk",
                        "houseseeker",
                    )
                ):
                    continue
                item_domain = _domain_from_url(item.get("link") or "")
                if domain and item_domain and item_domain != domain:
                    continue
                score = _score_search_title(title or "", bad_location=bad_name)
                if score > 0 and (best is None or score > best[0]):
                    best = (score, title[:120], "web_search_organic")
            # Strong hit — stop early
            if best and best[0] >= 5:
                break
        if best and best[0] >= 2:
            return best[1], best[2]
    except Exception as exc:
        logger.debug("web search name recovery failed: %s", exc)

    return None, "not_found"


def _apply_location_fields(
    buyer: Buyer,
    loc: dict[str, Any],
    updates: dict[str, Any],
) -> None:
    city = loc.get("city")
    country = loc.get("country")
    address = loc.get("address")

    if city and not _norm(buyer.city):
        updates["city"] = city
    elif city and (
        _norm_key(buyer.city) == _norm_key(buyer.company_name)
        or _neighbourhood_in(buyer.city or "")
        or len(_norm(buyer.city)) <= 3
    ):
        # Replace plot fragments like "E Model Town" when we have a cleaner city
        updates["city"] = city

    if country:
        existing = _norm_key(buyer.country)
        if not existing:
            updates["country"] = country
        elif existing in {"uk", "united kingdom", "u k", "gb", "great britain"} and _norm_key(
            country
        ) not in {"uk", "united kingdom", "u k", "gb", "great britain"}:
            # Common import mistake: South Asian address tagged as UK
            updates["country"] = country

    if address and not _norm(buyer.address):
        updates["address"] = address
    elif address and _norm_key(buyer.address or "") == _norm_key(buyer.company_name):
        updates["address"] = address
    elif address and buyer.address:
        existing_addr = _norm(buyer.address)
        # Phone-prefixed / duplicated location junk in Address column
        if (
            re.match(r"^[\d+\-().\s]{6,}[.\s]", existing_addr)
            or _norm_key(buyer.company_name or "") in _norm_key(existing_addr)
            or _neighbourhood_in(existing_addr)
            and _neighbourhood_in(address)
        ):
            updates["address"] = address

    # If company was a city and city already held something else that looks empty of value
    if loc.get("kind") == "city" and city:
        if not _norm(buyer.city) or _norm_key(buyer.city) == _norm_key(buyer.company_name):
            updates["city"] = city


def repair_buyer_location_company_name(
    db: Session,
    buyer_id: int,
    *,
    dry_run: bool = False,
) -> dict[str, Any]:
    buyer = buyers_module.get_buyer(db, buyer_id)
    if not buyer:
        return {"buyer_id": buyer_id, "status": "missing"}

    original = _norm(buyer.company_name)
    loc = classify_location_name(original)
    if loc is None:
        return {
            "buyer_id": buyer_id,
            "status": "skipped",
            "company_name": original,
            "reason": "company_name_does_not_look_like_location",
        }

    contacts = buyers_module.list_contacts_for_buyer(db, buyer_id)
    # Dial-code country when the address text alone is ambiguous
    if not loc.get("country"):
        for contact in contacts:
            phone = (
                getattr(contact, "phone", None)
                or getattr(contact, "primary_phone", None)
                or getattr(contact, "mobile", None)
            )
            hinted = _country_hint_from_phone(phone)
            if hinted:
                loc = {**loc, "country": hinted}
                break
    elif _norm_key(str(loc.get("country") or "")) in {"uk", "united kingdom"}:
        # Prefer phone dial code over a weak UK default when clearly foreign
        for contact in contacts:
            phone = (
                getattr(contact, "phone", None)
                or getattr(contact, "primary_phone", None)
                or getattr(contact, "mobile", None)
            )
            hinted = _country_hint_from_phone(phone)
            if hinted and hinted != "United Kingdom":
                loc = {**loc, "country": hinted}
                break
    if dry_run:
        # Fast preview: local signals only (no live web).
        recovered, source = None, "dry_run_skip_lookup"
        alias = _alias_company_from_texts(original, buyer.address, buyer.city)
        if _is_plausible_recovered_name(alias, bad_location=original):
            recovered, source = alias, "location_alias_preview"
        if not recovered:
            embedded = _name_from_address_blob(original, bad_location=original) or _name_from_address_blob(
                buyer.address, bad_location=original
            )
            if embedded:
                recovered, source = embedded, "address_blob_preview"
        if not recovered:
            for contact in contacts:
                for email in (contact.email, contact.secondary_email):
                    if not email or "@" not in email:
                        continue
                    host = email.split("@", 1)[1].strip().lower()
                    if host in _FREE_EMAIL_DOMAINS:
                        continue
                    brand = _brand_from_domain(host)
                    if _is_plausible_recovered_name(brand, bad_location=original):
                        recovered, source = brand, "email_domain_preview"
                        break
                if recovered:
                    break
    else:
        recovered, source = _recover_company_name(buyer, contacts, bad_name=original)

    updates: dict[str, Any] = {}
    _apply_location_fields(buyer, loc, updates)

    new_name = recovered if recovered else ""
    updates["company_name"] = new_name

    note = f"[name-repair] moved company_name “{original}” → {loc.get('kind')}"
    if recovered:
        note += f"; recovered “{recovered}” via {source}"
    else:
        note += f"; company name not found ({source})"
    existing_remarks = _norm(buyer.remarks)
    if note not in existing_remarks:
        updates["remarks"] = f"{existing_remarks}\n{note}".strip() if existing_remarks else note

    result = {
        "buyer_id": buyer_id,
        "status": "repaired" if recovered else "relocated_name_empty",
        "old_company_name": original,
        "new_company_name": new_name or None,
        "location_kind": loc.get("kind"),
        "city": updates.get("city", buyer.city),
        "country": updates.get("country", buyer.country),
        "address": updates.get("address", buyer.address),
        "name_source": source,
        "dry_run": dry_run,
    }

    if dry_run:
        return result

    buyers_module.update_buyer(db, buyer_id, updates)
    return result


def repair_location_company_names(
    db: Session,
    *,
    source: str | None = "old_clients",
    exclude_source: str | None = None,
    assigned_to_user_id: int | None = None,
    unassigned_only: bool = False,
    dry_run: bool = False,
    limit: int | None = None,
    sleep_s: float = 0.15,
) -> dict[str, Any]:
    """Scan buyers and repair rows where company_name is a location."""
    from modules.leads import _apply_lead_table_scope

    query = _apply_lead_table_scope(
        db.query(Buyer),
        source=source,
        exclude_source=exclude_source,
        assigned_to_user_id=assigned_to_user_id,
        unassigned_only=unassigned_only,
    ).order_by(Buyer.id.asc())

    buyers = query.all()
    scanned = 0
    candidates = 0
    repaired = 0
    emptied = 0
    skipped = 0
    samples: list[dict[str, Any]] = []

    for buyer in buyers:
        scanned += 1
        if classify_location_name(buyer.company_name) is None:
            skipped += 1
            continue
        candidates += 1
        if limit is not None and (repaired + emptied) >= limit:
            # Count remaining candidates without repairing them
            continue
        row = repair_buyer_location_company_name(db, buyer.id, dry_run=dry_run)
        if row.get("status") == "repaired":
            repaired += 1
        elif row.get("status") == "relocated_name_empty":
            emptied += 1
        if len(samples) < 40:
            samples.append(row)
        if not dry_run and sleep_s > 0:
            time.sleep(sleep_s)

    return {
        "scanned": scanned,
        "location_name_candidates": candidates,
        "repaired_with_name": repaired,
        "relocated_name_empty": emptied,
        "skipped": skipped,
        "dry_run": dry_run,
        "samples": samples,
    }
