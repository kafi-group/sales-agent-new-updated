"""Lead discovery — find prospect companies from seed lead, web search, or CSV."""

from __future__ import annotations

import csv
import html
import io
import re
import uuid
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup
from sqlalchemy.orm import Session

from modules.discovery_regions import (
    MAX_DISCOVERY_REGIONS,
    DiscoveryRegion,
    match_region_code,
    resolve_region_codes,
)
from modules import buyers as buyers_module
from modules.countries import (
    country_from_domain,
    country_from_phone,
    detect_countries_in_text,
    resolve_country_name,
)
from modules.product_catalog import load_catalog
from modules.research import ResearchModule
from modules.robots import USER_AGENT, can_fetch
from modules import web_search

_PARTNER_LINK_KEYWORDS = (
    "distributor",
    "partner",
    "retailer",
    "importer",
    "wholesale",
    "stockist",
    "dealer",
    "client",
    "customer",
    "supplier",
)
_SKIP_DOMAINS = (
    "facebook.com",
    "instagram.com",
    "twitter.com",
    "x.com",
    "linkedin.com",
    "youtube.com",
    "wikipedia.org",
    "google.com",
    "amazon.com",
    "ebay.com",
    # Firmographic / lead-gen directories — never treat as the company website
    "growjo.com",
    "compworth.com",
    "zoominfo.com",
    "datanyze.com",
    "rocketreach.co",
    "rocketreach.com",
    "apollo.io",
    "clearbit.com",
    "craft.co",
    "owler.com",
    "signalhire.com",
    "pitchbook.com",
    "cbinsights.com",
    "dnb.com",
    "appsruntheworld.com",
    "owler.com",
    "zoominfo.com",
)
# Trade-data / customs-intelligence platforms — not product importers we can sell to.
_SKIP_TRADE_DATA_DOMAINS = (
    "volza.com",
    "exportgenius.in",
    "exportgenius.com",
    "seair.co.in",
    "seair.com",
    "go4worldbusiness.com",
    "indonesiatradedata.com",
    "importgenius.com",
    "panjiva.com",
    "importyeti.com",
    "datamyne.com",
    "tradekey.com",
    "alibaba.com",
    "globalsources.com",
    "made-in-china.com",
    "ec21.com",
    "trademap.org",
    "eximpedia.com",
    "52wmb.com",
    "tradedata.pro",
    "customsinfo.com",
    "tradesns.com",
    "exportimportdata.com",
    "importexportdata.com",
    "tradeindia.com",
    "exportersindia.com",
    "kompass.com",
    "dnb.com",
    "bloomberg.com",
    "tradingeconomics.com",
    "zauba.com",
    "cybex.in",
    "export.gov",
)
# B2B directory / supplier-profile sites — NOT the company's own website, but they
# often carry accurate phone, address, and contact info we can use for enrichment.
_DIRECTORY_PROFILE_DOMAINS = (
    "freshdi.com",
    "europages.com",
    "europages.co.uk",
    "europages.de",
    "yellowpages.com",
    "yelp.com",
    "moneyhouse.ch",
    "zefix.ch",
    "local.ch",
    "cylex.ch",
    "wlw.de",
    "yalwa.com",
    "meritgateway.com",
    "allbiz.ch",
    "cybo.com",
    "zoominfo.com",
    "kununu.com",
    "northdata.com",
    "lixt.ch",
    "oeffnungszeitenbuch.de",
    "telefon-kontakte.ch",
    "dnb.com",
    "opencorporates.com",
    "companywall.ch",
    "firmenwissen.de",
    "kompass.com",
    "tuugo.ch",
    "wogibtswas.ch",
    "search.ch",
    "tel.search.ch",
    "panjiva.com",
    "volza.com",
    "importgenius.com",
    "datanyze.com",
    "signalhire.com",
    "crunchbase.com",
    "pitchbook.com",
)
# Free/webmail providers — acceptable contact emails for small businesses even when
# they don't match the company's own domain.
_FREE_EMAIL_PROVIDERS = frozenset(
    {
        "gmail.com",
        "googlemail.com",
        "outlook.com",
        "hotmail.com",
        "hotmail.co.uk",
        "live.com",
        "yahoo.com",
        "yahoo.co.uk",
        "ymail.com",
        "icloud.com",
        "me.com",
        "proton.me",
        "protonmail.com",
        "gmx.com",
        "gmx.de",
        "gmx.net",
        "aol.com",
        "mail.com",
        "web.de",
        "zoho.com",
    }
)
_TRADE_DATA_DOMAIN_KEYWORDS = (
    "tradedata",
    "exportdata",
    "importdata",
    "customsdata",
    "shipmentdata",
    "billoflading",
    "tradeintel",
    "eximpedia",
    "importexportdata",
    "exportimportdata",
)
_TRADE_DATA_TEXT_KEYWORDS = (
    "import export data",
    "import-export data",
    "customs data",
    "trade data",
    "shipment records",
    "bill of lading",
    "import database",
    "export database",
    "trade intelligence",
    "cargo data",
    "customs shipment",
    "import statistics",
    "export statistics",
    "hs code database",
    "hs code search",
    "global trade data",
    "import export database",
    "shipment database",
    "trade data provider",
    "customs import data",
    "export import data provider",
)
_SEARCH_QUERY_EXCLUSIONS = (
    "-volza",
    "-exportgenius",
    "-seair",
    "-go4worldbusiness",
    "-panjiva",
    "-importyeti",
    "-alibaba",
    '-"import export data"',
    '-"trade data"',
    "-indonesiatradedata",
)
_SKIP_URL_PARTS = ("/login", "/signup", "/cart", "/privacy", "/terms", "/cookie")
_INVALID_BUSINESS_NAME_PATTERNS = (
    r"\bcontact\s+list\b",
    r"\bimporters?\s+(in|contact|database|list)\b",
    r"\bexporters?\s+(in|contact|database|list)\b",
    r"\bbuyers?\s+(in|contact|database|list)\b",
    r"\btop\s+\d+\b",
    r"\blist\s+of\b",
    r"\b(?:buyers?|importers?|exporters?)\s+directory\b",
    r"\bwholesale\s+suppliers?\s+directory\b",
    r"\bconnect\s+with\s+verified\b",
    r"\bverified\s+.*\s+(buyers?|importers?)\b",
    r"\btrade\s+(data|intelligence)\b",
    r"\bimport\s+export\s+data\b",
    r"\bshipment\s+records?\b",
    r"\bready\s+to\s+export\b",
    r"\bretail\s+foods?\s+\d{4}\b",
    r"\bcustoms\s+data\b",
)
_INVALID_BUSINESS_NAME_RE = re.compile("|".join(_INVALID_BUSINESS_NAME_PATTERNS), re.I)
_COMPANY_SUFFIXES = re.compile(
    r"\b(llc|l\.l\.c|ltd|limited|inc|corp|gmbh|pte|pvt|trading|foods|food|group|international)\b",
    re.I,
)
_EMAIL_RE = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.I)
_EMAIL_ATTR_RE = re.compile(r"^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$", re.I)
# Phone patterns — separators allowed, but not decimal dots (coordinates/versions).
_PHONE_INLINE_RE = re.compile(
    r"(?:\+|00)\d{1,3}[\s()-]*\d{2,4}[\s()-]*\d{2,4}[\s()-]*\d{2,8}"
    r"|\(\d{2,5}\)[\s-]*\d{3,4}[\s-]*\d{3,4}"
    r"|\b\d{2,4}[\s-]\d{3,4}[\s-]\d{3,4}\b"
)
_DATE_LIKE_RE = re.compile(
    r"^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$|^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$"
)
_VERSION_LIKE_RE = re.compile(r"^\d+\.\d+")
_PHONE_LABEL_RE = re.compile(r"\b(phone|tel|telephone|mobile|fax|call us|contact|whatsapp)\b", re.I)
_CONTACT_PATHS = (
    "",
    "/contact",
    "/contact-us",
    "/contact-us/contact-us",
    "/contactus",
    "/en/contact",
    "/nl/contact",
    "/about",
    "/about-us",
    "/over-ons",
    "/impressum",
    "/company",
)
_NOT_FOUND = "Not found"
MAX_DISCOVERY_INDUSTRIES = 3
OLD_CLIENTS_IMPORT_PARSER = "old_clients_v2"


@dataclass
class DiscoveryCandidate:
    candidate_id: str
    company_name: str
    website_url: str | None = None
    contact_name: str | None = None
    email: str = _NOT_FOUND
    phone: str = _NOT_FOUND
    facebook_url: str = _NOT_FOUND
    instagram_url: str = _NOT_FOUND
    linkedin_url: str = _NOT_FOUND
    country: str | None = None
    industry: str | None = None
    legacy_serial_no: int | None = None
    company_grading: str | None = None
    designation: str | None = None
    secondary_mobile: str | None = None
    primary_phone: str | None = None
    secondary_phone: str | None = None
    secondary_email: str | None = None
    product_interest: str | None = None
    city: str | None = None
    address: str | None = None
    remarks: str | None = None
    remarks_03: str | None = None
    remarks_04: str | None = None
    source: str = "manual"
    source_detail: str = ""
    match_reason: str = ""
    already_exists: bool = False
    is_valid_business: bool = True
    invalid_reason: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "candidate_id": self.candidate_id,
            "company_name": self.company_name,
            "website_url": self.website_url,
            "contact_name": self.contact_name,
            "email": self.email,
            "phone": self.phone,
            "facebook_url": self.facebook_url,
            "instagram_url": self.instagram_url,
            "linkedin_url": self.linkedin_url,
            "country": self.country,
            "industry": self.industry,
            "legacy_serial_no": self.legacy_serial_no,
            "company_grading": self.company_grading,
            "designation": self.designation,
            "secondary_mobile": self.secondary_mobile,
            "primary_phone": self.primary_phone,
            "secondary_phone": self.secondary_phone,
            "secondary_email": self.secondary_email,
            "product_interest": self.product_interest,
            "city": self.city,
            "address": self.address,
            "remarks": self.remarks,
            "remarks_03": self.remarks_03,
            "remarks_04": self.remarks_04,
            "source": self.source,
            "source_detail": self.source_detail,
            "match_reason": self.match_reason,
            "already_exists": self.already_exists,
            "is_valid_business": self.is_valid_business,
            "invalid_reason": self.invalid_reason,
        }


@dataclass
class DiscoveryResult:
    candidates: list[DiscoveryCandidate] = field(default_factory=list)
    sources_used: list[str] = field(default_factory=list)
    messages: list[str] = field(default_factory=list)
    search_query: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "candidates": [c.to_dict() for c in self.candidates],
            "sources_used": self.sources_used,
            "messages": self.messages,
            "search_query": self.search_query,
        }


def _normalize_name(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


def _domain(url: str | None) -> str | None:
    if not url:
        return None
    try:
        parsed = urlparse(url if "://" in url else f"https://{url}")
        host = parsed.netloc.lower()
        return host[4:] if host.startswith("www.") else host
    except ValueError:
        return None


def _is_junk_dedupe_domain(domain: str | None) -> bool:
    """Social / directory / trade-data hosts must not collide distinct companies."""
    if not domain:
        return True
    host = domain.lower().strip()
    if host in {"example.com", "test.com", "localhost", "email.com", "mail.com"}:
        return True
    if _domain_matches_blocklist(host, _SKIP_DOMAINS):
        return True
    if _domain_matches_blocklist(host, _DIRECTORY_PROFILE_DOMAINS):
        return True
    if _is_trade_data_platform(host):
        return True
    return False


def _dedupe_domain(url: str | None) -> str | None:
    """Domain used for import duplicate detection — ignores junk hosts."""
    domain = _domain(url)
    if not domain or _is_junk_dedupe_domain(domain):
        return None
    return domain


def _homepage_url(url: str | None) -> str | None:
    if not url:
        return None
    try:
        parsed = urlparse(url if "://" in url else f"https://{url}")
        if not parsed.netloc:
            return None
        return f"{parsed.scheme or 'https'}://{parsed.netloc}"
    except ValueError:
        return None


def _clean_found(value: str | None) -> str:
    return value.strip() if value and value.strip() else _NOT_FOUND


def _value_or_none(value: str | None) -> str | None:
    if not value or value == _NOT_FOUND:
        return None
    return value


def _import_scope_for_source(import_source: str | None) -> dict[str, str | None]:
    """Keep old-client imports separate from the main leads table.

    Used for section-scoped replace/dedupe during import. Discovery "already
    exists" checks intentionally use all buyers (see discover paths) so an
    old client cannot be re-imported as a new discovery.

    Custom lists (e.g. new_salt_data_sep_2026) and targeted pools stay scoped
    to their own source key so imports only collide within that list.
    """
    normalized = (import_source or "").strip().lower()
    if normalized == "old_clients":
        return {"source": "old_clients", "exclude_source": None}
    if normalized == "incomplete_archives":
        return {"source": "incomplete_archives", "exclude_source": None}
    if normalized == "csv":
        # Leads-table spreadsheet imports only collide with other leads-table rows.
        return {"source": "csv", "exclude_source": None}
    if normalized in {
        "hyperstore_targeted",
        "targeted_distributor",
        "targeted_client",
        "khalid_focused_sales",
        "testing",
        "schedule_meeting",
    }:
        return {"source": normalized, "exclude_source": None}
    # Dynamic custom modules / user-created lists — isolate to that source.
    if normalized and normalized not in {
        "",
        "manual",
        "manual_dial",
        "discovery",
        "web_search",
        "website_links",
    }:
        return {"source": normalized, "exclude_source": None}
    return {"source": None, "exclude_source": "old_clients"}


def _discovery_existing_keys(db: Session) -> tuple[set[str], set[str]]:
    """Keys for marking already_exists — includes old clients so they are not rediscovered."""
    return _existing_buyer_keys(db)


def _existing_buyer_keys(
    db: Session,
    *,
    source: str | None = None,
    exclude_source: str | None = None,
    assigned_to_user_id: int | None = None,
) -> tuple[set[str], set[str]]:
    from sqlalchemy import func as sa_func

    from db.models import Buyer

    names: set[str] = set()
    domains: set[str] = set()
    excluded = {
        part.strip().lower()
        for part in (exclude_source or "").split(",")
        if part.strip()
    }

    # Push the source scoping to SQL (indexed) and only pull the two columns
    # we need — this used to load every column of every buyer in the table.
    query = db.query(Buyer.company_name, Buyer.website_url)
    if source:
        query = query.filter(sa_func.lower(Buyer.source) == source.strip().lower())
    if excluded:
        query = query.filter(
            ~sa_func.lower(sa_func.coalesce(Buyer.source, "")).in_(excluded)
        )
    if assigned_to_user_id is not None:
        query = query.filter(Buyer.assigned_to_user_id == assigned_to_user_id)

    for company_name, website_url in query.all():
        names.add(_normalize_name(company_name))
        domain = _dedupe_domain(website_url)
        if domain:
            domains.add(domain)
    return names, domains


def _mark_existing(
    candidates: list[DiscoveryCandidate],
    existing_names: set[str],
    existing_domains: set[str],
) -> None:
    for candidate in candidates:
        name_key = _normalize_name(candidate.company_name)
        domain = _dedupe_domain(candidate.website_url)
        if name_key in existing_names or (domain and domain in existing_domains):
            candidate.already_exists = True


def _mark_existing_by_contact(
    db: Session,
    candidates: list[DiscoveryCandidate],
    *,
    source: str | None = None,
    exclude_source: str | None = None,
    assigned_to_user_id: int | None = None,
) -> None:
    """Flag spreadsheet rows that match an existing contact (person+email / person+phone)."""
    from modules import buyers as buyers_module

    _, _, _, by_email, by_phone, by_person_email, by_person_phone = (
        buyers_module.build_buyer_lookup_index(
            db,
            source=source,
            exclude_source=exclude_source,
            assigned_to_user_id=assigned_to_user_id,
        )
    )
    for candidate in candidates:
        raw = {
            "contact_name": candidate.contact_name,
            "email": candidate.email,
            "secondary_email": getattr(candidate, "secondary_email", None),
            "phone": candidate.phone,
            "primary_phone": getattr(candidate, "primary_phone", None),
            "secondary_phone": getattr(candidate, "secondary_phone", None),
            "secondary_mobile": getattr(candidate, "secondary_mobile", None),
        }
        if _find_import_duplicate_buyer(
            raw,
            by_person_email=by_person_email,
            by_person_phone=by_person_phone,
            by_email=by_email,
            by_phone=by_phone,
        ):
            candidate.already_exists = True


def _dedupe_candidates(candidates: list[DiscoveryCandidate]) -> list[DiscoveryCandidate]:
    seen_names: set[str] = set()
    seen_domains: set[str] = set()
    unique: list[DiscoveryCandidate] = []
    for candidate in candidates:
        name_key = _normalize_name(candidate.company_name)
        domain = _domain(candidate.website_url)
        if name_key in seen_names:
            continue
        if domain and domain in seen_domains:
            continue
        seen_names.add(name_key)
        if domain:
            seen_domains.add(domain)
        unique.append(candidate)
    return unique


def _looks_like_company_name(text: str) -> bool:
    text = text.strip()
    if len(text) < 3 or len(text) > 120:
        return False
    if text.lower().startswith(("http", "www.", "click", "read more", "learn more")):
        return False
    if "@" in text:
        return False
    words = text.split()
    if len(words) >= 2 or _COMPANY_SUFFIXES.search(text):
        return True
    return text[0].isupper() and len(words) == 1 and len(text) >= 4


def _domain_matches_blocklist(domain: str | None, blocklist: tuple[str, ...]) -> bool:
    if not domain:
        return False
    host = domain.lower()
    return any(host == blocked or host.endswith(f".{blocked}") for blocked in blocklist)


def _text_has_trade_data_signals(*texts: str | None) -> bool:
    combined = " ".join(t for t in texts if t).lower()
    if not combined:
        return False
    return any(keyword in combined for keyword in _TRADE_DATA_TEXT_KEYWORDS)


def _is_trade_data_platform(
    domain: str | None,
    *texts: str | None,
) -> bool:
    """True when the result is a trade/cargo data site, not a product importer."""
    if _domain_matches_blocklist(domain, _SKIP_TRADE_DATA_DOMAINS):
        return True
    if domain and any(keyword in domain.lower() for keyword in _TRADE_DATA_DOMAIN_KEYWORDS):
        return True
    return _text_has_trade_data_signals(*texts)


def _clean_company_name(title: str) -> str:
    name = re.split(r"[-|–—:]", title)[0].strip()
    name = re.sub(r"\s+(home|homepage|official site)$", "", name, flags=re.I)
    return name[:120]


def _clean_social_url(url: str) -> str:
    parsed = urlparse(url)
    return parsed._replace(query="", fragment="").geturl().rstrip("/")


def _social_key(url: str) -> str | None:
    domain = _domain(url)
    if not domain:
        return None
    if "facebook.com" in domain:
        return "facebook_url"
    if "instagram.com" in domain:
        return "instagram_url"
    if "linkedin.com" in domain:
        return "linkedin_url"
    return None


def _best_email(emails: set[str], company_domain: str | None) -> str | None:
    blocked_prefixes = ("noreply@", "no-reply@", "donotreply@", "example@", "test@")
    blocked_domains = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".css", ".js")
    filtered = sorted(
        e.lower()
        for e in emails
        if _EMAIL_ATTR_RE.match(e)
        and not e.lower().startswith(blocked_prefixes)
        and not e.lower().endswith(blocked_domains)
        and "@" in e
        and "." in e.split("@", 1)[1]
    )
    if not filtered:
        return None
    if company_domain:
        cd = company_domain.lower()
        # 1. Prefer an email on the company's own domain (or a sub/parent domain).
        for email in filtered:
            domain = email.split("@", 1)[1]
            if (
                domain == cd
                or domain.endswith(f".{cd}")
                or cd.endswith(f".{domain}")
                or domain.endswith(cd)
                or cd.endswith(domain)
            ):
                return email
        # 2. Otherwise only accept free/webmail addresses. An email on a *different*
        #    registered company domain almost certainly belongs to someone else, so we
        #    reject it rather than attach a wrong contact to this lead.
        for email in filtered:
            if email.split("@", 1)[1] in _FREE_EMAIL_PROVIDERS:
                return email
        return None
    return filtered[0]


def _deobfuscate_emails(text: str) -> str:
    """Normalize common email obfuscation before regex extraction."""
    value = html.unescape(text)
    value = re.sub(r"\s*\[at\]\s*|\s*\(at\)\s*|\s*\{at\}\s*|\s+at\s+", "@", value, flags=re.I)
    value = re.sub(r"\s*\[dot\]\s*|\s*\(dot\)\s*|\s*\{dot\}\s*|\s+dot\s+", ".", value, flags=re.I)
    value = value.replace("&#64;", "@").replace("&commat;", "@")
    return value


def _extract_emails(soup: BeautifulSoup, raw_text: str) -> set[str]:
    emails: set[str] = set()

    for anchor in soup.find_all("a", href=True):
        href = anchor["href"].strip()
        if href.lower().startswith("mailto:"):
            address = href[7:].split("?")[0].strip()
            if address:
                emails.add(address)

    for element in soup.find_all(attrs={"itemprop": re.compile(r"email", re.I)}):
        text = element.get_text(" ", strip=True)
        if text:
            emails.update(_EMAIL_RE.findall(_deobfuscate_emails(text)))

    for element in soup.find_all(attrs={"data-email": True}):
        value = str(element.get("data-email", "")).strip()
        if value:
            emails.add(value)

    for element in soup.find_all(class_=re.compile(r"email|e-mail|mail", re.I)):
        text = element.get_text(" ", strip=True)
        if text:
            emails.update(_EMAIL_RE.findall(_deobfuscate_emails(text)))

    cleaned = _deobfuscate_emails(raw_text)
    emails.update(_EMAIL_RE.findall(cleaned))
    return emails


def _normalize_phone_raw(raw: str) -> str:
    value = raw.strip()
    value = re.sub(r"^tel:", "", value, flags=re.I)
    value = value.split("?")[0].split(";")[0].strip()
    return re.sub(r"\s+", " ", value)


def _is_valid_phone_candidate(raw: str) -> bool:
    value = _normalize_phone_raw(raw)
    if not value:
        return False

    if _DATE_LIKE_RE.match(value):
        return False

    if _VERSION_LIKE_RE.match(value):
        return False

    # Decimal numbers are usually coordinates, versions, or IDs — not phone numbers.
    if re.search(r"\d\.\d", value):
        return False

    if not re.match(r"^\+?[\d\s().-]+$", value):
        return False

    digits = re.sub(r"\D", "", value)
    if len(digits) < 8 or len(digits) > 15:
        return False

    if len(set(digits)) <= 2:
        return False

    # Reject compact YYYYMMDD date strings.
    if len(digits) == 8 and digits[:2] in ("19", "20"):
        year, month, day = int(digits[:4]), int(digits[4:6]), int(digits[6:8])
        if 1900 <= year <= 2099 and 1 <= month <= 12 and 1 <= day <= 31:
            return False

    # Reject dashed groups that look like calendar dates (e.g. 2024-01-15).
    parts = re.split(r"[\s./-]+", value)
    if len(parts) == 3 and all(part.isdigit() for part in parts):
        a, b, c = (int(part) for part in parts)
        if a > 31 and 1 <= b <= 12 and 1 <= c <= 31:
            return False
        if 1 <= a <= 31 and 1 <= b <= 12 and c >= 1900:
            return False

    has_separator = bool(re.search(r"[\s().-]", value))
    starts_intl = value.startswith("+") or value.startswith("00")

    # Long digit-only strings without + are usually IDs, not phone numbers.
    if not starts_intl and not has_separator and len(digits) > 11:
        return False

    # Require international prefix or human-readable grouping for regex matches.
    if not starts_intl and not has_separator:
        return False

    return True


def _phone_score(value: str) -> int:
    digits = re.sub(r"\D", "", value)
    score = 0
    if value.startswith("+") or value.startswith("00"):
        score += 40
    if re.search(r"[\s().-]", value):
        score += 25
    if 10 <= len(digits) <= 14:
        score += 30
    elif 8 <= len(digits) <= 15:
        score += 10
    if len(set(digits)) >= 5:
        score += 10
    return score


def _best_phone(phones: set[str]) -> str | None:
    valid: list[str] = []
    for phone in phones:
        normalized = _normalize_phone_raw(phone)
        if _is_valid_phone_candidate(normalized):
            valid.append(normalized)
    if not valid:
        return None
    return max(valid, key=_phone_score)


def _ranked_phones(phones: set[str]) -> list[str]:
    """Unique valid phones, best-first (for primary / secondary slots)."""
    seen: set[str] = set()
    ranked: list[str] = []
    for phone in phones:
        normalized = _normalize_phone_raw(phone)
        if not _is_valid_phone_candidate(normalized):
            continue
        digits = re.sub(r"\D", "", normalized)
        if digits in seen:
            continue
        seen.add(digits)
        ranked.append(normalized)
    ranked.sort(key=_phone_score, reverse=True)
    return ranked


def _looks_like_mobile(phone: str) -> bool:
    """Heuristic: mobiles are usually longer intl numbers; landlines often shorter local."""
    digits = re.sub(r"\D", "", phone or "")
    if digits.startswith("00"):
        digits = digits[2:]
    # Common mobile lengths with country code (e.g. +92 3xx…, +971 5x…).
    if 11 <= len(digits) <= 13:
        return True
    if phone.strip().startswith("+") and len(digits) >= 10:
        return True
    return False


def _assign_phone_slots(phones: set[str]) -> dict[str, str | None]:
    """Map scraped phones onto clients-table columns.

    Primary Mobile ← best mobile (else best overall)
    Secondary Mobile ← next mobile
    Primary Phone ← best landline-like
    Secondary Phone ← next landline / leftover
    """
    ranked = _ranked_phones(phones)
    if not ranked:
        return {
            "phone": None,
            "secondary_mobile": None,
            "primary_phone": None,
            "secondary_phone": None,
        }
    mobiles = [p for p in ranked if _looks_like_mobile(p)]
    landlines = [p for p in ranked if not _looks_like_mobile(p)]
    primary_mobile = mobiles[0] if mobiles else ranked[0]
    secondary_mobile = mobiles[1] if len(mobiles) > 1 else None
    primary_phone = landlines[0] if landlines else None
    leftover = [
        p
        for p in ranked
        if p not in {primary_mobile, secondary_mobile, primary_phone}
    ]
    secondary_phone = leftover[0] if leftover else (landlines[1] if len(landlines) > 1 else None)
    return {
        "phone": primary_mobile,
        "secondary_mobile": secondary_mobile,
        "primary_phone": primary_phone,
        "secondary_phone": secondary_phone,
    }


def _ranked_emails(emails: set[str], company_domain: str | None) -> list[str]:
    """Best company email first, then other plausible addresses (for secondary_email)."""
    primary = _best_email(emails, company_domain)
    ordered: list[str] = []
    if primary:
        ordered.append(primary)
    blocked_prefixes = ("noreply@", "no-reply@", "donotreply@", "example@", "test@")
    for email in sorted(e.lower() for e in emails if _EMAIL_ATTR_RE.match(e)):
        if email in ordered:
            continue
        if email.startswith(blocked_prefixes):
            continue
        ordered.append(email)
        if len(ordered) >= 4:
            break
    return ordered


_DESIGNATION_RE = re.compile(
    r"(?i)\b("
    r"chief executive officer|managing director|general manager|"
    r"sales (?:director|manager)|purchase (?:director|manager)|"
    r"procurement (?:director|manager)|operations (?:director|manager)|"
    r"co-?founder|founder|proprietor|partner|owner|"
    r"vice president|president|director|manager|ceo|cfo|coo|cto|md\b"
    r")"
)


def _extract_designation_from_pages(
    soups: list[BeautifulSoup],
    page_texts: list[str],
) -> str | None:
    """Pull a job title from schema.org microdata or labeled contact text."""
    for soup in soups:
        for element in soup.find_all(attrs={"itemprop": re.compile(r"jobTitle", re.I)}):
            value = (element.get("content") or element.get_text(" ", strip=True) or "").strip()
            if 2 <= len(value) <= 80 and _DESIGNATION_RE.search(value):
                return value[:120]
        for element in soup.find_all(class_=re.compile(r"job-?title|designation|position|role", re.I)):
            value = element.get_text(" ", strip=True)
            if 2 <= len(value) <= 80 and _DESIGNATION_RE.search(value):
                return value[:120]

    for text in page_texts:
        # "Name — Managing Director" / "Contact: Owner"
        for match in re.finditer(
            r"(?i)(?:designation|title|position|role)\s*[:\-–]\s*([A-Za-z][A-Za-z .,&/'-]{2,60})",
            text[:12000],
        ):
            value = match.group(1).strip(" .")
            if _DESIGNATION_RE.search(value):
                return value[:120]
        match = _DESIGNATION_RE.search(text[:8000])
        if match:
            # Prefer the full matched title phrase, title-cased lightly.
            raw = match.group(1).strip()
            if len(raw) <= 40:
                return raw.title() if raw.islower() or raw.isupper() else raw
    return None


def _extract_person_name_from_pages(soups: list[BeautifulSoup]) -> str | None:
    """Best-effort contact person from schema.org Person name on contact pages."""
    for soup in soups:
        for person in soup.find_all(attrs={"itemtype": re.compile(r"schema\.org/Person", re.I)}):
            name_el = person.find(attrs={"itemprop": re.compile(r"^name$", re.I)})
            if not name_el:
                continue
            name = (name_el.get("content") or name_el.get_text(" ", strip=True) or "").strip()
            if 2 <= len(name.split()) <= 5 and len(name) <= 80:
                lower = name.lower()
                if lower not in {"contact", "admin", "support", "info", "sales"}:
                    return name
    return None


def _extract_phones(soup: BeautifulSoup) -> set[str]:
    phones: set[str] = set()

    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()

    for anchor in soup.find_all("a", href=True):
        href = anchor["href"].strip()
        if href.lower().startswith("tel:"):
            phones.add(href[4:])

    for element in soup.find_all(attrs={"itemprop": re.compile(r"telephone", re.I)}):
        text = element.get_text(" ", strip=True)
        if text:
            phones.add(text)

    for element in soup.find_all(class_=re.compile(r"phone|tel|telephone|mobile|contact", re.I)):
        text = element.get_text(" ", strip=True)
        if not text or len(text) > 120:
            continue
        for match in _PHONE_INLINE_RE.finditer(text):
            phones.add(match.group(0))

    for element in soup.find_all(["p", "span", "div", "li", "td", "dd", "address"]):
        text = element.get_text(" ", strip=True)
        if not text or len(text) > 100:
            continue
        if _PHONE_LABEL_RE.search(text):
            for match in _PHONE_INLINE_RE.finditer(text):
                phones.add(match.group(0))

    return phones


def _infer_country_from_pages(
    *,
    page_texts: list[str],
    phones: set[str],
    company_domain: str | None,
    fallback: str | None,
    address_countries: list[str] | None = None,
) -> str | None:
    scores: dict[str, int] = {}

    for text in page_texts:
        for name, score in detect_countries_in_text(text).items():
            scores[name] = scores.get(name, 0) + score

    for raw_country in address_countries or []:
        resolved = resolve_country_name(raw_country)
        if resolved:
            scores[resolved] = scores.get(resolved, 0) + 30

    for phone in phones:
        inferred = country_from_phone(phone)
        if inferred:
            scores[inferred] = scores.get(inferred, 0) + 35

    domain_country = country_from_domain(company_domain)
    if domain_country:
        scores[domain_country] = scores.get(domain_country, 0) + 15

    if not scores:
        return resolve_country_name(fallback) or fallback

    best_name, best_score = max(scores.items(), key=lambda item: item[1])
    fallback_resolved = resolve_country_name(fallback)

    if fallback_resolved and fallback_resolved == best_name:
        return best_name

    # Strong website evidence overrides the search region assignment.
    if best_score >= 25:
        return best_name

    return fallback_resolved or best_name


_POSTAL_CODE_RE = re.compile(
    r"^\d{4,6}(-\d{3,4})?$"  # US / numeric
    r"|^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$"  # UK
    r"|^[A-Z]\d[A-Z]\s*\d[A-Z]\d$",  # Canada
    re.I,
)
_STREET_HINT_RE = re.compile(
    r"\b(street|st\.?|road|rd\.?|avenue|ave\.?|blvd|boulevard|lane|ln\.?|"
    r"drive|dr\.?|suite|ste\.?|floor|fl\.?|building|bldg|unit|plot|"
    r"industrial|zone|area|block|p\.?\s*o\.?\s*box|po box)\b",
    re.I,
)


def _is_plausible_city(city: str | None) -> bool:
    if not city:
        return False
    text = re.sub(r"\s+", " ", str(city)).strip(" ,.")
    if len(text) < 3 or len(text) > 50:
        return False
    if re.fullmatch(r"\d+[A-Z]{0,2}", text, re.I):
        return False
    if text.isupper() and len(text) <= 3:
        return False
    if text.lower() in {
        "the",
        "de",
        "company",
        "group",
        "organic",
        "contact",
        "address",
        "netherlands",
        "holland",
    }:
        return False
    if text.lower().startswith("gemeente "):
        return _is_plausible_city(text.split(" ", 1)[-1])
    return bool(re.search(r"[A-Za-z]{3,}", text))


def _clean_city_value(city: str | None) -> str | None:
    if not city:
        return None
    text = re.sub(r"\s+", " ", str(city)).strip(" ,.")
    if text.lower().startswith("gemeente "):
        text = text.split(" ", 1)[-1].strip()
    return text if _is_plausible_city(text) else None


def _looks_like_country_label(text: str, country: str | None = None) -> bool:
    """True when a comma segment is a country name/alias — not a city that implies one.

    ``resolve_country_name('Dubai')`` returns UAE, so we must not treat every
    resolving token as a country label to strip from the address.
    """
    t = (text or "").strip()
    if not t:
        return False
    resolved = resolve_country_name(t)
    if not resolved:
        return False
    t_l = t.lower()
    r_l = resolved.lower()
    if t_l == r_l:
        return True
    country_norm = (resolve_country_name(country) or country or "").strip().lower()
    if country_norm and t_l == country_norm:
        return True
    # Short aliases: UAE, UK, USA, KSA, etc.
    compact = re.sub(r"[^a-z]", "", t_l)
    return bool(resolved) and 2 <= len(compact) <= 4


def _parse_city_from_address(address: str | None, country: str | None = None) -> str | None:
    """Best-effort city from a postal address like '…, Dubai, United Arab Emirates'."""
    if not address or not str(address).strip():
        return None
    text = re.sub(r"\s+", " ", str(address).strip())
    parts = [p.strip(" ,") for p in text.split(",") if p.strip(" ,")]
    if not parts:
        return None

    # Drop trailing country / region labels (not cities like Dubai that map to a country).
    while parts and _looks_like_country_label(parts[-1], country):
        parts.pop()

    for part in reversed(parts):
        if _POSTAL_CODE_RE.match(part.replace(" ", "")):
            continue
        if _STREET_HINT_RE.search(part) and re.search(r"\d", part):
            continue
        if len(part) < 2 or len(part) > 80:
            continue
        # Prefer short locality-looking tokens (1–4 words).
        if len(part.split()) <= 4 and _is_plausible_city(part):
            return _clean_city_value(part)
    return None


def _extract_postal_address(soup: BeautifulSoup) -> dict[str, str | None]:
    """Pull street / city / country from schema.org PostalAddress microdata."""
    out: dict[str, str | None] = {"address": None, "city": None, "country": None}

    def _prop(name: str) -> str | None:
        for element in soup.find_all(attrs={"itemprop": re.compile(rf"^{name}$", re.I)}):
            value = (element.get("content") or element.get_text(" ", strip=True) or "").strip()
            if value:
                return value
        return None

    street = _prop("streetAddress")
    locality = _prop("addressLocality")
    region = _prop("addressRegion")
    postal = _prop("postalCode")
    country = _prop("addressCountry")

    if locality:
        out["city"] = locality
    if country:
        out["country"] = resolve_country_name(country) or country

    parts = [p for p in (street, locality, region, postal, country) if p]
    if parts:
        out["address"] = ", ".join(parts)
    elif soup.find("address"):
        # Fallback: first <address> block that looks like a postal address.
        for tag in soup.find_all("address"):
            text = re.sub(r"\s+", " ", tag.get_text(" ", strip=True))
            if 12 <= len(text) <= 220 and (
                "," in text or _STREET_HINT_RE.search(text) or re.search(r"\d", text)
            ):
                out["address"] = text
                break

    if out["address"] and not out["city"]:
        out["city"] = _parse_city_from_address(out["address"], out["country"])
    return out


def _apply_lookup_location(candidate: DiscoveryCandidate, lookup: dict[str, Any]) -> None:
    """Copy address/city (and country if missing) from a company search lookup."""
    if not candidate.address and lookup.get("address"):
        candidate.address = str(lookup["address"]).strip() or None
    if not candidate.country and lookup.get("country"):
        candidate.country = lookup["country"]
    if not candidate.city:
        city = _clean_city_value(lookup.get("city")) if lookup.get("city") else None
        if not city and candidate.address:
            city = _parse_city_from_address(candidate.address, candidate.country)
        if city:
            candidate.city = city


_PANJIVA_ADDR_RE = re.compile(
    r"(?:Address|Direcci[oó]n|Bezoekadres)?\s*"
    r"([A-Z0-9][A-Za-z0-9\s\.\-']{2,60}?\d[A-Za-z0-9\s\.\-]{0,20}?)"
    r"\s*[-–]\s*"
    r"([A-Za-z][A-Za-z\s\-']{1,40}?)"
    r"\s*[-–]\s*(?:[-–]\s*)?"
    r"(\d{3,6})?",
    re.I,
)
_NL_POSTAL_ADDR_RE = re.compile(
    r"("
    r"(?:[A-Z][A-Za-z0-9\.\-']*(?:straat|laan|weg|plein|singel|kade|gracht|dreef)"
    r"|[A-Z][A-Za-z]+(?:Street|Road|Avenue|Lane|Drive|Boulevard|Square)"
    r"|[A-Z][a-z]+\s+(?:Street|Road|Avenue|Lane|Drive|Boulevard|Square|Plein))"
    r"\s+\d{1,4}(?:\s*[-–]\s*\d{1,4})?"
    r")\s+"
    r"(\d{4}\s*[A-Z]{2})\s+"
    r"([A-Z][a-z]+(?:[\s\-][A-Z][a-z]+)*)"
    r"(?:\s*,?\s*(?:The\s+)?Netherlands|\s*,?\s*NL\b)?",
    re.I,
)
_LABELED_ADDR_RE = re.compile(
    r"(?:address|adress|bezoekadres|vestigingsadres|hoofdvestiging|"
    r"head\s*office|headquarters|registered\s*office|location)\s*[:\-]\s*"
    r"([A-Z0-9][^|\n]{12,120})",
    re.I,
)


def _normalize_found_address(raw: str, country: str | None = None) -> str | None:
    text = re.sub(r"\s+", " ", (raw or "").strip(" ,;|"))
    if len(text) < 8 or len(text) > 220:
        return None
    lower = text.lower()
    if any(
        junk in lower
        for junk in (
            "linkedin",
            "professional community",
            "sign up",
            "billion members",
            "www.",
            "http",
        )
    ):
        return None
    # Require a number (street/postal) — plain city names are handled separately.
    if not re.search(r"\d", text):
        return None
    # Drop trailing directory brand noise.
    text = re.sub(
        r"\s*[-–|]\s*(?:Panjiva|Volza|ZoomInfo|Datanyze|Crunchbase|Sign up|Contact).*$",
        "",
        text,
        flags=re.I,
    ).strip(" ,;|")
    if country and not detect_countries_in_text(text):
        country_label = resolve_country_name(country) or country
        if country_label and country_label.lower() not in text.lower():
            text = f"{text}, {country_label}"
    return text or None


def _extract_city_mention(
    title: str, snippet: str, company_name: str, country: str | None = None
) -> str | None:
    """Pull a city mention from search text when a full street address is unavailable."""
    blob = f"{title or ''} {snippet or ''}"
    if not blob.strip():
        return None
    name_norm = _normalize_name(_clean_company_name(company_name) or company_name)
    if name_norm and name_norm not in _normalize_name(blob):
        tokens = [t for t in name_norm.split() if len(t) >= 4][:2]
        if not tokens or not all(t in _normalize_name(blob) for t in tokens):
            return None
    patterns = (
        r"\b(?:based in|located in|headquartered in|gevestigd (?:te|in)|intrek in)\s+"
        r"(?:De\s+)?([A-Z][A-Za-z\s\-']{1,40})",
        r"\b([A-Z][A-Za-z\s\-']{1,40}),\s*(?:The\s+)?Netherlands\b",
        r"\b([A-Z][A-Za-z\s\-']{1,40}),\s*(?:United Kingdom|Germany|France|Belgium|UAE)\b",
    )
    for pattern in patterns:
        match = re.search(pattern, blob)
        if not match:
            continue
        city = re.sub(r"\s+", " ", match.group(1)).strip(" ,.")
        if len(city.split()) > 3:
            continue
        if _looks_like_country_label(city, country):
            continue
        if city.lower() in {"the", "de", "company", "group", "organic"}:
            continue
        return _clean_city_value(city)
    return None


def _extract_address_from_search_text(
    title: str,
    snippet: str,
    company_name: str,
    country: str | None = None,
) -> str | None:
    """Pull a postal address from directory-style search titles/snippets (e.g. Panjiva)."""
    blob = f"{title or ''} {snippet or ''}"
    if not blob.strip():
        return None
    name_token = _normalize_name(_clean_company_name(company_name) or company_name)
    if name_token and name_token not in _normalize_name(blob):
        # Require the company to be mentioned so we don't take a random address page.
        short = name_token.split()[:2]
        if not short or not all(tok in _normalize_name(blob) for tok in short if len(tok) >= 3):
            return None

    for match in _PANJIVA_ADDR_RE.finditer(blob):
        street, city, postal = match.group(1), match.group(2), match.group(3)
        city = re.sub(r"\s+", " ", city).strip(" -")
        if _looks_like_country_label(city, country):
            continue
        parts = [street.strip(), city]
        if postal:
            parts.insert(1, postal.strip())
        normalized = _normalize_found_address(", ".join(parts), country)
        if normalized:
            return normalized

    for match in _NL_POSTAL_ADDR_RE.finditer(blob):
        street, postal, city = match.group(1), match.group(2), match.group(3)
        city = re.sub(r"\s+", " ", city).strip(" ,")
        if _looks_like_country_label(city, country):
            continue
        normalized = _normalize_found_address(
            f"{street.strip()}, {postal.strip()}, {city}", country
        )
        if normalized:
            return normalized

    for match in _LABELED_ADDR_RE.finditer(blob):
        normalized = _normalize_found_address(match.group(1), country)
        if normalized and (
            re.search(r"\d", normalized) or _parse_city_from_address(normalized, country)
        ):
            return normalized
    return None


def _extract_addresses_from_page_text(
    text: str, country: str | None = None
) -> dict[str, str | None]:
    """Best-effort street/city from contact-page plain text (no microdata required)."""
    out: dict[str, str | None] = {"address": None, "city": None}
    if not text:
        return out
    compact = re.sub(r"\s+", " ", text)

    for match in _NL_POSTAL_ADDR_RE.finditer(compact):
        street, postal, city = match.group(1), match.group(2), match.group(3)
        city = re.sub(r"\s+", " ", city).strip(" ,")
        city = re.split(
            r"\b(?:The\s+)?Netherlands\b|\bUnited\s+Kingdom\b|\bGermany\b|\bBelgium\b|"
            r"\bNL\b|\bCONTACT\b|\bTel\b|\bPhone\b|\bEmail\b|\bwww\b",
            city,
            maxsplit=1,
            flags=re.I,
        )[0].strip(" ,")
        city = _clean_city_value(city)
        if not city or _looks_like_country_label(city, country):
            continue
        address = _normalize_found_address(
            f"{street.strip()}, {postal.strip()}, {city}", country
        )
        if address:
            out["address"] = address
            out["city"] = city
            return out

    for match in _LABELED_ADDR_RE.finditer(compact):
        address = _normalize_found_address(match.group(1), country)
        if not address:
            continue
        city = _parse_city_from_address(address, country)
        if city or re.search(r"\d", address):
            out["address"] = address
            out["city"] = city
            return out

    # HQ Amsterdam … Stationsplein 61 - 65 1012 AB Amsterdam
    hq = re.search(
        r"HQ\s+([A-Z][A-Za-z\s\-']{1,40}?)\s+.{0,80}?"
        r"([A-Z][A-Za-z0-9\s\.\-']{3,50}?\d{1,4}(?:\s*[-–]\s*\d{1,4})?\s+"
        r"\d{4}\s*[A-Z]{2}\s+[A-Z][A-Za-z\s\-']{1,40})",
        compact,
        re.I,
    )
    if hq:
        city_hint = hq.group(1).strip()
        address = _normalize_found_address(hq.group(2), country)
        if address:
            out["address"] = address
            out["city"] = _parse_city_from_address(address, country) or city_hint
            return out
    return out


def _nominatim_company_location(
    company_name: str, country: str | None = None
) -> dict[str, str | None]:
    """OpenStreetMap Nominatim fallback when SerpAPI knowledge/local panels are unavailable."""
    out: dict[str, str | None] = {"address": None, "city": None, "country": None}
    query = company_name.strip()
    if country:
        query = f"{query}, {country}"
    if len(query) < 3:
        return out
    try:
        response = httpx.get(
            "https://nominatim.openstreetmap.org/search",
            params={
                "q": query,
                "format": "json",
                "addressdetails": 1,
                "limit": 5,
            },
            headers={"User-Agent": "KafiSalesAgent/1.0 (lead-enrichment)"},
            timeout=12,
        )
        response.raise_for_status()
        rows = response.json()
    except Exception:
        return out

    name_norm = _normalize_name(_clean_company_name(company_name) or company_name)
    for row in rows or []:
        display = str(row.get("display_name") or "")
        if name_norm and name_norm not in _normalize_name(display):
            tokens = [t for t in name_norm.split() if len(t) >= 4][:2]
            if not tokens or not all(t in _normalize_name(display) for t in tokens):
                continue
        addr = row.get("address") or {}
        city = (
            addr.get("city")
            or addr.get("town")
            or addr.get("village")
            or addr.get("municipality")
            or addr.get("county")
        )
        road = addr.get("road") or addr.get("pedestrian")
        house = addr.get("house_number")
        postcode = addr.get("postcode")
        country_name = addr.get("country")
        street = " ".join(p for p in (house, road) if p).strip() or None
        parts = [p for p in (street, postcode, city, country_name) if p]
        if not parts and display:
            parts = [display]
        if not parts:
            continue
        out["address"] = _normalize_found_address(", ".join(parts), country or country_name)
        out["city"] = city
        out["country"] = resolve_country_name(country_name) or country_name
        return out
    return out


_COMPANY_STOP_WORDS = frozenset(
    {
        "the",
        "and",
        "for",
        "ltd",
        "limited",
        "llc",
        "inc",
        "corp",
        "pvt",
        "pte",
        "gmbh",
        "trading",
        "foods",
        "food",
        "international",
        "group",
        "company",
        "co",
    }
)


def _company_name_tokens(name: str) -> list[str]:
    tokens = re.split(r"\W+", name.lower())
    return [token for token in tokens if len(token) >= 3 and token not in _COMPANY_STOP_WORDS]


def _score_website_candidate(
    company_name: str,
    title: str,
    link: str,
    snippet: str = "",
) -> int:
    name_norm = _normalize_name(company_name)
    title_norm = _normalize_name(_clean_company_name(title))
    domain = (_domain(link) or "").replace("-", "").replace(".", "")
    score = 0

    if name_norm and title_norm and (name_norm in title_norm or title_norm in name_norm):
        score += 60
    else:
        title_tokens = set(_company_name_tokens(title))
        overlap = sum(
            1
            for token in _company_name_tokens(company_name)
            if token in title_tokens or token in domain
        )
        score += overlap * 20

    for token in _company_name_tokens(company_name):
        if token in domain:
            score += 15

    snippet_lower = snippet.lower()
    if snippet_lower and any(token in snippet_lower for token in _company_name_tokens(company_name)[:3]):
        score += 10

    return score


def _result_matches_name(
    company_name: str,
    title: str,
    link: str,
    snippet: str = "",
) -> bool:
    """Hard gate: only True when a search result is genuinely about this company.

    Prevents attaching an unrelated site (e.g. a generic listing) to a lead just
    because a fuzzy score crossed a threshold.
    """
    tokens = _company_name_tokens(company_name)
    if not tokens:
        return False

    name_norm = _normalize_name(company_name)
    title_norm = _normalize_name(title)
    clean_title_norm = _normalize_name(_clean_company_name(title))
    domain = (_domain(link) or "").replace("-", "").replace(".", "")
    snippet_norm = _normalize_name(snippet)

    # Strongest signal: the full company name appears in the title or domain.
    if name_norm and (name_norm in title_norm or name_norm in domain):
        return True
    if clean_title_norm and name_norm and (
        clean_title_norm in name_norm or name_norm in clean_title_norm
    ):
        return True

    tokens_in_domain = [t for t in tokens if t in domain]
    tokens_in_title = [t for t in tokens if t in title_norm]

    # A distinctive token (>=5 chars) present in the domain is a reliable match.
    if any(len(t) >= 5 for t in tokens_in_domain):
        return True

    # At least two distinct name tokens appearing across the domain/title.
    if len(set(tokens_in_domain) | set(tokens_in_title)) >= 2:
        return True

    # A domain token that is also reinforced in the result snippet.
    if tokens_in_domain and any(t in snippet_norm for t in tokens_in_domain):
        return True

    return False


def _domain_relates_to_name(company_name: str, link: str) -> bool:
    """True when the site's *domain* echoes the company name.

    A genuine company website's domain contains part of the company name. Aggregator
    / directory sites (e.g. meritgateway.com) mirror the name only in the page title
    while the domain is unrelated — this gate rejects those as the company's website.
    """
    domain = (_domain(link) or "").replace("-", "").replace(".", "")
    if not domain:
        return False
    name_norm = _normalize_name(company_name)
    if name_norm and (name_norm in domain or domain in name_norm):
        return True
    tokens = _company_name_tokens(company_name)
    # Require a reasonably distinctive token (>=4 chars) to appear in the domain.
    return any(len(t) >= 4 and t in domain for t in tokens)


def _phone_from_search_text(text: str | None) -> str | None:
    """Extract a phone number embedded in a search result title or snippet."""
    if not text:
        return None
    for match in _PHONE_INLINE_RE.finditer(text):
        phone = _normalize_phone_raw(match.group(0))
        if _is_valid_phone_candidate(phone):
            return phone
    return None


def _lookup_company_website(
    company_name: str,
    country: str | None = None,
    industry: str | None = None,
) -> str | None:
    """Find a company website via web search when CSV rows only have a name."""
    if not web_search.any_combined_provider_available() or not company_name.strip():
        return None

    queries = [f'"{company_name}" official website']
    if country:
        queries.append(f'"{company_name}" {country} company website')
    if industry:
        queries.append(f'"{company_name}" {industry.split(",")[0].strip()} website')

    best_url: str | None = None
    best_score = 0
    gl = _country_gl_code(country)

    for query in queries:
        found = web_search.search_combined(query, num=10, gl_code=gl)

        for item in found.organic:
            link = item.get("link") or ""
            title = item.get("title") or ""
            snippet = item.get("snippet") or ""
            domain = _domain(link)
            if not domain:
                continue
            if any(skip in domain for skip in _SKIP_DOMAINS):
                continue
            if any(part in link.lower() for part in _SKIP_URL_PARTS):
                continue
            if _is_trade_data_platform(domain, title, snippet):
                continue
            if _domain_matches_blocklist(domain, _DIRECTORY_PROFILE_DOMAINS):
                continue
            # Only consider results that genuinely reference this company AND whose
            # domain echoes the name (blocks aggregators that mirror the name in the
            # page title but sit on an unrelated domain).
            if not _result_matches_name(company_name, title, link, snippet):
                continue
            if not _domain_relates_to_name(company_name, link):
                continue

            score = _score_website_candidate(company_name, title, link, snippet)
            if score > best_score:
                best_score = score
                best_url = _homepage_url(link) or link

        if best_score >= 60:
            break

    return best_url if best_score >= 40 else None


def _company_lookup(
    company_name: str,
    country: str | None = None,
    industry: str | None = None,
    *,
    allow_soft_website_match: bool = False,
    require_location: bool = False,
) -> dict[str, str | None]:
    """Look a named company up via web search and return verified, associated details.

    Uses the richest data the provider gives: a knowledge panel and local business
    results (accurate phone/address) when available (SerpAPI), plus a strictly
    name-matched organic website. Also captures a B2B directory profile (e.g.
    freshdi.com) to use as a contact fallback. Never returns details that aren't
    clearly tied to the searched company name — otherwise the field stays blank.

    When ``allow_soft_website_match`` is True (old-client Research & Score), strong
    title matches are accepted even when the domain does not echo the company name.

    When ``require_location`` is True (clients table), keep searching until city /
    address are found even if a phone is already available.
    """
    result: dict[str, str | None] = {
        "website": None,
        "phone": None,
        "country": None,
        "address": None,
        "city": None,
        "directory_url": None,
        "source_detail": None,
        "linkedin_url": None,
        "facebook_url": None,
        "instagram_url": None,
    }

    # Wikidata SPARQL first — strong official website / social signals when present.
    try:
        from modules.company_enrichment import lookup_wikidata_company

        wiki = lookup_wikidata_company(company_name, country)
        if wiki.get("website"):
            result["website"] = wiki["website"]
            result["source_detail"] = wiki.get("source_detail") or "Wikidata SPARQL"
        for key in ("linkedin_url", "facebook_url", "instagram_url"):
            if wiki.get(key):
                result[key] = wiki[key]
    except Exception:
        pass

    if not web_search.any_combined_provider_available() or not company_name.strip():
        return result

    name_norm = _normalize_name(company_name)
    queries = [f'"{company_name}"']
    if country:
        queries.append(f'"{company_name}" {country}')
    # Cap at 2 initial queries so Research & Score stays interactive; an
    # address-focused query is appended later only when location is still missing.
    queries = queries[:2]

    best_url: str | None = None
    best_score = 0
    soft_url: str | None = None
    soft_score = 0
    gl = _country_gl_code(country)
    providers_used: set[str] = set()

    def _name_close(text: str | None) -> bool:
        other = _normalize_name(text or "")
        if not other or not name_norm:
            return False
        return name_norm in other or other in name_norm

    def _consume_search(found) -> None:
        nonlocal best_url, best_score, soft_url, soft_score
        if found.provider:
            providers_used.update(found.provider.split("+"))

        kg = found.knowledge_graph or {}
        if kg and (
            _name_close(kg.get("title"))
            or _result_matches_name(
                company_name, kg.get("title") or "", kg.get("website") or "", kg.get("description") or ""
            )
        ):
            kg_site = kg.get("website")
            if kg_site and not result["website"]:
                kg_domain = _domain(kg_site)
                if (
                    kg_domain
                    and not _is_trade_data_platform(kg_domain)
                    and not _domain_matches_blocklist(kg_domain, _SKIP_DOMAINS)
                    and not _domain_matches_blocklist(kg_domain, _DIRECTORY_PROFILE_DOMAINS)
                    and (
                        _domain_relates_to_name(company_name, kg_site)
                        or allow_soft_website_match
                        or (kg.get("description") or "").lower().find("wikidata") >= 0
                    )
                ):
                    result["website"] = _homepage_url(kg_site) or kg_site
                    result["source_detail"] = result["source_detail"] or "Knowledge panel"
            if not result["phone"] and kg.get("phone"):
                result["phone"] = str(kg["phone"]).strip()
            if not result["address"] and kg.get("address"):
                result["address"] = str(kg["address"]).strip()
            for key in ("linkedin_url", "facebook_url", "instagram_url"):
                if not result.get(key) and kg.get(key):
                    result[key] = str(kg[key]).strip()

        for place in found.local:
            if not _name_close(place.get("title")):
                continue
            if not result["phone"] and place.get("phone"):
                result["phone"] = str(place["phone"]).strip()
            if not result["address"] and place.get("address"):
                result["address"] = str(place["address"]).strip()
            break

        for item in found.organic:
            link = item.get("link") or ""
            title = item.get("title") or ""
            snippet = item.get("snippet") or ""
            domain = _domain(link)
            if not domain:
                continue
            if any(part in link.lower() for part in _SKIP_URL_PARTS):
                continue

            # Address / city from directory/trade titles & snippets even when the site
            # is not the company's own website (SerpAPI KG often unavailable).
            if (
                _name_close(_clean_company_name(title))
                or _result_matches_name(company_name, title, link, snippet)
            ):
                if not result["address"]:
                    parsed_addr = _extract_address_from_search_text(
                        title, snippet, company_name, country
                    )
                    if parsed_addr:
                        result["address"] = parsed_addr
                        result["source_detail"] = (
                            result["source_detail"] or "Address from search result"
                        )
                if not result["city"]:
                    city = _clean_city_value(
                        _extract_city_mention(title, snippet, company_name, country)
                    )
                    if city:
                        result["city"] = city

            if _domain_matches_blocklist(domain, _DIRECTORY_PROFILE_DOMAINS):
                if not result["directory_url"] and _name_close(_clean_company_name(title)):
                    result["directory_url"] = link
                if not result["phone"]:
                    for field in (title, snippet):
                        phone = _phone_from_search_text(field)
                        if phone:
                            result["phone"] = phone
                            break
                continue
            if any(skip in domain for skip in _SKIP_DOMAINS):
                continue
            if _is_trade_data_platform(domain, title, snippet):
                continue
            if not _result_matches_name(company_name, title, link, snippet):
                continue
            score = _score_website_candidate(company_name, title, link, snippet)
            relates = _domain_relates_to_name(company_name, link)
            if relates:
                if score > best_score:
                    best_score = score
                    best_url = _homepage_url(link) or link
            elif allow_soft_website_match and score >= 70 and score > soft_score:
                # Soft match only when the domain looks geographically plausible
                # for the known country (e.g. .nl for Netherlands) — blocks
                # firmographic junk sites that merely mention the company name.
                gl = _country_gl_code(country)
                tld_ok = bool(gl and domain.endswith(f".{gl}"))
                if tld_ok or score >= 90:
                    soft_score = score
                    soft_url = _homepage_url(link) or link

    for query in queries:
        found = web_search.search_combined(query, num=10, gl_code=gl)
        _consume_search(found)
        has_location = bool(result["address"] and result["city"])
        if require_location:
            # Clients table: city/address outrank phone — don't stop early on contact alone.
            if has_location and (result["website"] or best_score >= 60):
                break
        else:
            if result["website"] and result["phone"] and result["address"]:
                break
            if best_score >= 60 and result["address"]:
                break

    if not result["address"] or not result["city"]:
        address_query = f'"{company_name}" address OR headquarters OR bezoekadres'
        if country:
            address_query = (
                f'"{company_name}" {country} '
                f'(address OR headquarters OR bezoekadres OR Panjiva OR Europages)'
            )
        found = web_search.search_combined(address_query, num=8, gl_code=gl)
        _consume_search(found)

    # Clients table: one more location-focused pass when still missing city/address.
    if require_location and (not result["address"] or not result["city"]):
        city_query = f'"{company_name}"'
        if country:
            city_query = f'"{company_name}" {country} city OR location OR office'
        else:
            city_query = f'"{company_name}" city OR location OR office OR headquarters'
        found = web_search.search_combined(city_query, num=8, gl_code=gl)
        _consume_search(found)

    if not result["website"] and best_url and best_score >= 40:
        result["website"] = best_url
        result["source_detail"] = result["source_detail"] or "Website found via web search"
    elif not result["website"] and soft_url and soft_score >= 70:
        result["website"] = soft_url
        result["source_detail"] = (
            result["source_detail"] or "Website found via soft name match (search)"
        )

    if not result["address"]:
        nominatim = _nominatim_company_location(company_name, country)
        if nominatim.get("address"):
            result["address"] = nominatim["address"]
            if not result["country"] and nominatim.get("country"):
                result["country"] = nominatim["country"]
            result["source_detail"] = (
                f"{result['source_detail']}; OpenStreetMap" if result["source_detail"] else "OpenStreetMap"
            )

    if providers_used:
        label = " + ".join(sorted(providers_used))
        combined = f"Search: {label}"
        result["source_detail"] = (
            f"{result['source_detail']}; {combined}" if result["source_detail"] else combined
        )

    if result["address"] and not result["city"]:
        result["city"] = _parse_city_from_address(result["address"], country or result["country"])
    result["city"] = _clean_city_value(result.get("city"))

    if result["address"] and not result["country"]:
        detected = detect_countries_in_text(result["address"])
        if detected:
            result["country"] = max(detected.items(), key=lambda kv: kv[1])[0]

    return result


def _scrape_directory_profile(profile_url: str) -> dict[str, str | None]:
    """Pull phone/address from a B2B directory profile page."""
    details: dict[str, str | None] = {"phone": None, "address": None, "city": None}
    if not profile_url or not can_fetch(profile_url):
        return details
    try:
        response = httpx.get(
            profile_url,
            timeout=10,
            follow_redirects=True,
            headers={"User-Agent": USER_AGENT},
        )
        response.raise_for_status()
    except httpx.HTTPError:
        return details
    soup = BeautifulSoup(response.text, "html.parser")
    details["phone"] = _best_phone(_extract_phones(soup))
    postal = _extract_postal_address(soup)
    if postal.get("address"):
        details["address"] = postal["address"]
        details["city"] = postal.get("city")
    else:
        from_text = _extract_addresses_from_page_text(soup.get_text(" ", strip=True))
        details["address"] = from_text.get("address")
        details["city"] = from_text.get("city")
    return details


def _website_matches_company(name: str, url: str | None) -> bool:
    domain = (_domain(url) or "").replace("-", "").replace(".", "")
    if not domain:
        return False
    tokens = _company_name_tokens(name)
    if not tokens:
        return False
    return any(token in domain for token in tokens[:4])


def _candidate_has_business_presence(candidate: DiscoveryCandidate) -> bool:
    homepage = _homepage_url(candidate.website_url)
    if homepage:
        domain = _domain(homepage)
        if domain and not _is_trade_data_platform(domain, candidate.company_name, candidate.match_reason):
            return True
    if _value_or_none(candidate.email):
        return True
    if _value_or_none(candidate.phone):
        return True
    return any(
        _value_or_none(getattr(candidate, attr))
        for attr in ("facebook_url", "instagram_url", "linkedin_url")
    )


def _validate_business_name_only(name: str) -> tuple[bool, str]:
    cleaned = (name or "").strip()
    if not cleaned:
        return False, "missing company name"
    if _INVALID_BUSINESS_NAME_RE.search(cleaned):
        return False, "name looks like a directory or list page, not a company"
    if _text_has_trade_data_signals(cleaned):
        return False, "name looks like a trade-data or directory listing"
    if len(cleaned) > 100:
        return False, "name is too long to be a company"
    return True, ""


def _spreadsheet_row_has_signals(raw: dict[str, Any] | DiscoveryCandidate) -> bool:
    """True when a spreadsheet row already carries usable contact/location fields."""
    if isinstance(raw, DiscoveryCandidate):
        values = (
            raw.email,
            raw.phone,
            raw.city,
            raw.address,
            raw.country,
            raw.contact_name,
            raw.primary_phone,
            raw.secondary_mobile,
            raw.designation,
        )
    else:
        values = (
            raw.get("email"),
            raw.get("phone"),
            raw.get("city"),
            raw.get("address"),
            raw.get("country"),
            raw.get("contact_name"),
            raw.get("primary_phone"),
            raw.get("secondary_mobile"),
            raw.get("designation"),
        )
    for value in values:
        text = (value or "").strip()
        if text and text.lower() not in {_NOT_FOUND.lower(), "n/a", "na", "-", "none"}:
            if isinstance(raw, DiscoveryCandidate) and value == raw.contact_name:
                if text.lower() in {"general contact", "contact"}:
                    continue
            elif not isinstance(raw, DiscoveryCandidate) and value == raw.get("contact_name"):
                if text.lower() in {"general contact", "contact"}:
                    continue
            return True
    return False


def _validate_spreadsheet_company_name(
    name: str,
    raw: dict[str, Any] | DiscoveryCandidate | None = None,
) -> tuple[bool, str]:
    """Table spreadsheet imports: only require a non-empty company name.

    Sparse rows, directory-looking names, and thin contact data are still
    imported — duplicates are handled separately (skip/replace).
    """
    del raw  # retained for call-site compatibility
    cleaned = (name or "").strip()
    if not cleaned:
        return False, "missing company name"
    return True, ""


def _validate_business_candidate(candidate: DiscoveryCandidate) -> tuple[bool, str]:
    """Return whether this row is a verifiable importer/distributor/company."""
    name = (candidate.company_name or "").strip()
    valid_name, name_reason = _validate_business_name_only(name)
    if not valid_name:
        return False, name_reason

    if candidate.website_url and _is_trade_data_platform(
        _domain(candidate.website_url),
        candidate.company_name,
        candidate.match_reason,
    ):
        return False, "website is a trade-data or directory site"

    if not _candidate_has_business_presence(candidate):
        # Look the exact company name up online for a verified website/phone/contact.
        _enrich_candidate_contact(candidate, keep_row=True)

    if not _candidate_has_business_presence(candidate):
        return False, "no verifiable website, contact details, or social presence found online"

    homepage = _homepage_url(candidate.website_url)
    if homepage and _is_trade_data_platform(
        _domain(homepage),
        candidate.company_name,
        candidate.match_reason,
    ):
        return False, "website is a trade-data or directory site"

    has_contact_or_social = any(
        _value_or_none(getattr(candidate, attr))
        for attr in ("email", "phone", "facebook_url", "instagram_url", "linkedin_url")
    )
    if homepage and not has_contact_or_social and not _website_matches_company(name, homepage):
        return False, "website does not match the company name and no other business signals were found"

    return True, ""


def _flag_invalid_candidates(
    candidates: list[DiscoveryCandidate],
    *,
    for_spreadsheet: bool = False,
) -> int:
    # Spreadsheet table imports accept every parsed row as-is (enrich later).
    if for_spreadsheet:
        for candidate in candidates:
            candidate.is_valid_business = True
            candidate.invalid_reason = None
        return 0
    invalid_count = 0
    for candidate in candidates:
        valid, reason = _validate_business_name_only(candidate.company_name)
        if not valid:
            candidate.is_valid_business = False
            candidate.invalid_reason = f"Not a valid business — {reason}"
            invalid_count += 1
    return invalid_count


def _enrich_candidate_contact(
    candidate: DiscoveryCandidate,
    *,
    keep_row: bool = False,
    prioritize_location: bool = False,
) -> bool:
    homepage = _homepage_url(candidate.website_url)
    # Drop firmographic junk that was soft-matched as a "website" on earlier runs.
    if homepage and (
        _domain_matches_blocklist(_domain(homepage), _SKIP_DOMAINS)
        or _domain_matches_blocklist(_domain(homepage), _DIRECTORY_PROFILE_DOMAINS)
        or _is_trade_data_platform(_domain(homepage), candidate.company_name)
    ):
        homepage = None
        candidate.website_url = None

    directory_url: str | None = None
    soft_match = keep_row or candidate.source in {"csv", "old_clients", "manual"}
    needs_location = not (
        _clean_city_value(candidate.city) and (candidate.address or "").strip()
    )
    # Clients table: always chase location even when a phone already exists.
    force_location = prioritize_location and needs_location

    if not homepage:
        # Search via SerpAPI + DuckDuckGo + Google CSE + Wikidata and pull only
        # verified, name-matched details (website, phone, address, socials).
        lookup = _company_lookup(
            candidate.company_name,
            candidate.country,
            candidate.industry,
            allow_soft_website_match=soft_match,
            require_location=force_location or prioritize_location,
        )
        directory_url = lookup.get("directory_url")

        if lookup.get("website"):
            homepage = lookup["website"]
            candidate.website_url = homepage
            detail = lookup.get("source_detail") or "Website found via web search"
            candidate.source_detail = (
                f"{candidate.source_detail}; {detail}" if candidate.source_detail else detail
            )
            candidate.match_reason = (
                f"{candidate.match_reason}; {detail}" if candidate.match_reason else detail
            )

        if candidate.phone == _NOT_FOUND and lookup.get("phone"):
            candidate.phone = _clean_found(lookup["phone"])
        if not candidate.country and lookup.get("country"):
            candidate.country = lookup["country"]
        _apply_lookup_location(candidate, lookup)
        if candidate.linkedin_url == _NOT_FOUND and lookup.get("linkedin_url"):
            candidate.linkedin_url = _clean_found(lookup["linkedin_url"])
        if candidate.facebook_url == _NOT_FOUND and lookup.get("facebook_url"):
            candidate.facebook_url = _clean_found(lookup["facebook_url"])
        if candidate.instagram_url == _NOT_FOUND and lookup.get("instagram_url"):
            candidate.instagram_url = _clean_found(lookup["instagram_url"])
    else:
        # Website already known — still ask Wikidata for missing social links,
        # and company search for missing city/address (KG / local results).
        try:
            from modules.company_enrichment import lookup_wikidata_company

            wiki = lookup_wikidata_company(candidate.company_name, candidate.country)
            if candidate.linkedin_url == _NOT_FOUND and wiki.get("linkedin_url"):
                candidate.linkedin_url = _clean_found(wiki["linkedin_url"])
            if candidate.facebook_url == _NOT_FOUND and wiki.get("facebook_url"):
                candidate.facebook_url = _clean_found(wiki["facebook_url"])
            if candidate.instagram_url == _NOT_FOUND and wiki.get("instagram_url"):
                candidate.instagram_url = _clean_found(wiki["instagram_url"])
        except Exception:
            pass

        if (needs_location or force_location) and candidate.company_name:
            try:
                lookup = _company_lookup(
                    candidate.company_name,
                    candidate.country,
                    candidate.industry,
                    allow_soft_website_match=soft_match,
                    require_location=True,
                )
                directory_url = lookup.get("directory_url") or directory_url
                if candidate.phone == _NOT_FOUND and lookup.get("phone"):
                    candidate.phone = _clean_found(lookup["phone"])
                _apply_lookup_location(candidate, lookup)
                if lookup.get("address") or lookup.get("city"):
                    detail = "Address found via company search"
                    candidate.source_detail = (
                        f"{candidate.source_detail}; {detail}"
                        if candidate.source_detail
                        else detail
                    )
            except Exception:
                pass

    if not homepage:
        # No own website, but a directory profile or knowledge-panel phone may still
        # give us a verified contact for this exact company.
        if directory_url and (
            candidate.phone == _NOT_FOUND or not candidate.address or force_location
        ):
            profile = _scrape_directory_profile(directory_url)
            if candidate.phone == _NOT_FOUND and profile.get("phone"):
                candidate.phone = _clean_found(profile["phone"])
                if not candidate.country:
                    candidate.country = country_from_phone(candidate.phone) or candidate.country
            if not candidate.address and profile.get("address"):
                candidate.address = profile["address"]
            if not candidate.city and profile.get("city"):
                candidate.city = profile["city"]
            elif candidate.address and not candidate.city:
                candidate.city = _parse_city_from_address(
                    candidate.address, candidate.country
                )
        if keep_row:
            return True
        if _value_or_none(candidate.phone):
            return True
        return not _is_trade_data_platform(_domain(candidate.website_url), candidate.company_name)

    candidate.website_url = homepage
    emails: set[str] = set()
    phones: set[str] = set()
    socials: dict[str, str] = {}
    page_texts: list[str] = []
    page_soups: list[BeautifulSoup] = []
    address_countries: list[str] = []
    scraped_addresses: list[dict[str, str | None]] = []
    company_domain = _domain(homepage)
    fallback_country = candidate.country

    def _fetch_page(path: str) -> tuple[str, str] | None:
        page_url = urljoin(homepage.rstrip("/") + "/", path.lstrip("/"))
        if not can_fetch(page_url):
            return None
        try:
            with httpx.Client(
                timeout=6,
                follow_redirects=True,
                headers={"User-Agent": USER_AGENT},
            ) as client:
                response = client.get(page_url)
                response.raise_for_status()
                return page_url, response.text
        except httpx.HTTPError:
            return None

    # Fetch homepage + key contact/about paths in parallel.
    paths = list(_CONTACT_PATHS[:8])
    fetched: list[tuple[str, str]] = []
    with ThreadPoolExecutor(max_workers=min(6, len(paths))) as pool:
        futures = [pool.submit(_fetch_page, path) for path in paths]
        for future in as_completed(futures):
            try:
                item = future.result()
            except Exception:
                continue
            if item:
                fetched.append(item)

    for page_url, text in fetched:
        page_texts.append(text)
        soup = BeautifulSoup(text, "html.parser")
        page_soups.append(soup)
        emails.update(_extract_emails(soup, text))
        phones.update(_extract_phones(soup))

        for element in soup.find_all(attrs={"itemprop": re.compile(r"addressCountry", re.I)}):
            value = element.get("content") or element.get_text(" ", strip=True)
            if value:
                address_countries.append(value.strip())

        postal = _extract_postal_address(soup)
        if postal.get("address") or postal.get("city"):
            scraped_addresses.append(postal)
            if postal.get("country"):
                address_countries.append(str(postal["country"]))

        for anchor in soup.find_all("a", href=True):
            href = anchor["href"].strip()
            if not href:
                continue
            full_url = urljoin(page_url, href)
            key = _social_key(full_url)
            if key and key not in socials:
                socials[key] = _clean_social_url(full_url)

    phone_slots = _assign_phone_slots(phones)
    if candidate.phone == _NOT_FOUND and phone_slots.get("phone"):
        candidate.phone = _clean_found(phone_slots["phone"])
    if not candidate.secondary_mobile and phone_slots.get("secondary_mobile"):
        candidate.secondary_mobile = phone_slots["secondary_mobile"]
    if not candidate.primary_phone and phone_slots.get("primary_phone"):
        candidate.primary_phone = phone_slots["primary_phone"]
    if not candidate.secondary_phone and phone_slots.get("secondary_phone"):
        candidate.secondary_phone = phone_slots["secondary_phone"]

    email_list = _ranked_emails(emails, company_domain)
    if candidate.email == _NOT_FOUND and email_list:
        candidate.email = _clean_found(email_list[0])
    if not candidate.secondary_email and len(email_list) > 1:
        candidate.secondary_email = email_list[1]

    if not candidate.designation:
        candidate.designation = _extract_designation_from_pages(page_soups, page_texts)
    if not candidate.contact_name or candidate.contact_name.strip().lower() in {
        "general contact",
        "contact",
        "n/a",
        "na",
        "-",
    }:
        person = _extract_person_name_from_pages(page_soups)
        if person:
            candidate.contact_name = person

    # Only attach social links when the scraped site itself is tied to this company.
    # On a site that only loosely matches, its Facebook/Instagram/LinkedIn could
    # belong to someone else — better to leave those cells blank. A user-supplied
    # (CSV/manual) website is trusted even if its domain doesn't echo the name.
    site_is_trusted = soft_match or _website_matches_company(
        candidate.company_name, homepage
    )
    if site_is_trusted:
        if candidate.facebook_url == _NOT_FOUND:
            candidate.facebook_url = _clean_found(socials.get("facebook_url"))
        if candidate.instagram_url == _NOT_FOUND:
            candidate.instagram_url = _clean_found(socials.get("instagram_url"))
        if candidate.linkedin_url == _NOT_FOUND:
            candidate.linkedin_url = _clean_found(socials.get("linkedin_url"))
    if directory_url and (
        candidate.phone == _NOT_FOUND or not candidate.address or force_location
    ):
        profile = _scrape_directory_profile(directory_url)
        if candidate.phone == _NOT_FOUND and profile.get("phone"):
            candidate.phone = _clean_found(profile["phone"])
        if not candidate.address and profile.get("address"):
            candidate.address = profile["address"]
        if not candidate.city and profile.get("city"):
            candidate.city = profile["city"]
    if not candidate.country:
        candidate.country = _infer_country_from_pages(
            page_texts=page_texts,
            phones=phones,
            company_domain=company_domain,
            fallback=fallback_country,
            address_countries=address_countries,
        )

    # Prefer schema.org / <address> blocks from the company site for location.
    # Clients table: always prefer a stronger site address over a weak search snippet.
    if scraped_addresses and (not candidate.address or not candidate.city or prioritize_location):
        best = next(
            (row for row in scraped_addresses if row.get("address") and row.get("city")),
            scraped_addresses[0],
        )
        if (not candidate.address or prioritize_location) and best.get("address"):
            if not candidate.address or (
                prioritize_location and len(str(best["address"])) > len(candidate.address or "")
            ):
                candidate.address = best["address"]
        if not candidate.city and best.get("city"):
            candidate.city = best["city"]
        elif not candidate.city and candidate.address:
            candidate.city = _parse_city_from_address(candidate.address, candidate.country)
        if not candidate.country and best.get("country"):
            candidate.country = best["country"]
    if (not candidate.address or not candidate.city) and page_texts:
        from_pages = _extract_addresses_from_page_text(
            " ".join(page_texts)[:20000], candidate.country
        )
        if not candidate.address and from_pages.get("address"):
            candidate.address = from_pages["address"]
        if not candidate.city and from_pages.get("city"):
            candidate.city = from_pages["city"]
        elif candidate.address and not candidate.city:
            candidate.city = _parse_city_from_address(candidate.address, candidate.country)
    elif candidate.address and not candidate.city:
        candidate.city = _parse_city_from_address(candidate.address, candidate.country)

    candidate.city = _clean_city_value(candidate.city)

    # CompanyLens domain enrichment for remaining contact/social gaps.
    try:
        from modules.company_enrichment import companylens_available, enrich_domain_companylens

        if companylens_available() and company_domain:
            lens = enrich_domain_companylens(homepage)
            if candidate.email == _NOT_FOUND and lens.get("email"):
                candidate.email = _clean_found(str(lens["email"]))
            if candidate.phone == _NOT_FOUND and lens.get("phone"):
                candidate.phone = _clean_found(str(lens["phone"]))
            if site_is_trusted:
                if candidate.linkedin_url == _NOT_FOUND and lens.get("linkedin_url"):
                    candidate.linkedin_url = _clean_found(str(lens["linkedin_url"]))
                if candidate.facebook_url == _NOT_FOUND and lens.get("facebook_url"):
                    candidate.facebook_url = _clean_found(str(lens["facebook_url"]))
                if candidate.instagram_url == _NOT_FOUND and lens.get("instagram_url"):
                    candidate.instagram_url = _clean_found(str(lens["instagram_url"]))
            if lens.get("source_detail"):
                detail = str(lens["source_detail"])
                candidate.source_detail = (
                    f"{candidate.source_detail}; {detail}" if candidate.source_detail else detail
                )
    except Exception:
        pass

    page_preview = " ".join(page_texts)[:8000] if page_texts else ""
    if keep_row:
        return True
    if _is_trade_data_platform(company_domain, candidate.company_name, page_preview, candidate.match_reason):
        return False
    return True


def _enrich_candidates(candidates: list[DiscoveryCandidate]) -> None:
    kept: list[DiscoveryCandidate] = []
    for candidate in candidates:
        if not _enrich_candidate_contact(candidate):
            continue
        valid, reason = _validate_business_candidate(candidate)
        if valid:
            kept.append(candidate)
        else:
            candidate.is_valid_business = False
            candidate.invalid_reason = f"Not a valid business — {reason}"
    candidates[:] = kept


def _category_search_terms(categories: list[str], limit: int = 4) -> list[str]:
    catalog = load_catalog()
    keywords_map = catalog.get("category_buyer_keywords", {})
    terms: list[str] = []
    for category in categories:
        for kw in keywords_map.get(category, []):
            if kw not in terms:
                terms.append(kw)
            if len(terms) >= limit:
                return terms
    return terms


_COUNTRY_GL_CODES = {
    "us": "us",
    "usa": "us",
    "united states": "us",
    "uk": "gb",
    "united kingdom": "gb",
    "britain": "gb",
    "australia": "au",
    "au": "au",
    "canada": "ca",
    "ca": "ca",
    "mexico": "mx",
    "mx": "mx",
    "uae": "ae",
    "saudi arabia": "sa",
    "pakistan": "pk",
    "india": "in",
}


def _parse_list_field(value: str | None) -> list[str]:
    if not value:
        return []
    return [part.strip() for part in re.split(r"[,;]", value) if part.strip()]


def _country_gl_code(country: str | None) -> str | None:
    if not country:
        return None
    key = country.strip().lower()
    if key in _COUNTRY_GL_CODES:
        return _COUNTRY_GL_CODES[key]
    if len(key) == 2:
        return key
    return None


def _normalize_industries(
    industries: list[str] | None,
    industry: str | None,
) -> list[str]:
    resolved: list[str] = []
    for value in industries or []:
        trimmed = value.strip()
        if trimmed and trimmed not in resolved:
            resolved.append(trimmed)
    if not resolved and industry:
        for value in _parse_list_field(industry):
            if value not in resolved:
                resolved.append(value)
    return resolved[:MAX_DISCOVERY_INDUSTRIES]


def _industry_label(industries: list[str]) -> str | None:
    if not industries:
        return None
    return ", ".join(industries)


def _build_search_query(
    country: str | None,
    industries: list[str],
    categories: list[str],
) -> str:
    # Target businesses that sell/import food products — not trade-data platforms.
    parts: list[str] = ["food wholesaler distributor spices condiments grocery"]
    parts.extend(_category_search_terms(categories, limit=3))
    if country:
        parts.append(country)
    for industry in industries[:MAX_DISCOVERY_INDUSTRIES]:
        parts.append(industry)
    parts.extend(_SEARCH_QUERY_EXCLUSIONS)
    return " ".join(parts)


def _discover_via_web_search(
    query: str,
    limit: int,
    country: str | None,
    *,
    gl_code: str | None = None,
    industry_label: str | None = None,
) -> tuple[list[DiscoveryCandidate], list[str]]:
    if not web_search.any_combined_provider_available() and not web_search.any_provider_available():
        return [], []

    gl = gl_code or _country_gl_code(country)
    # Merge SerpAPI + DuckDuckGo + Google CSE + Wikidata so Discover Leads
    # sees candidates from every configured search source.
    found = web_search.search_combined(query, num=min(limit * 2, 20), gl_code=gl)
    if found.is_empty():
        found = web_search.search(query, num=min(limit * 2, 20), gl_code=gl)
    provider = found.provider or "web search"
    messages: list[str] = list(found.messages)

    organic_results = found.organic
    candidates: list[DiscoveryCandidate] = []
    filtered_out = 0
    trade_data_skipped = 0
    for item in organic_results:
        link = item.get("link") or ""
        title = item.get("title") or ""
        snippet = item.get("snippet") or ""

        domain = _domain(link)
        if not domain or any(skip in domain for skip in _SKIP_DOMAINS):
            filtered_out += 1
            continue
        if any(part in link.lower() for part in _SKIP_URL_PARTS):
            filtered_out += 1
            continue

        company_name = _clean_company_name(title)
        if not _looks_like_company_name(company_name):
            filtered_out += 1
            continue
        if not _validate_business_name_only(company_name)[0]:
            filtered_out += 1
            continue

        if _is_trade_data_platform(domain, company_name, title, snippet):
            trade_data_skipped += 1
            continue

        candidates.append(
            DiscoveryCandidate(
                candidate_id=str(uuid.uuid4()),
                company_name=company_name,
                website_url=_homepage_url(link) or link,
                country=country,
                industry=industry_label,
                source="web_search",
                source_detail=f"{provider} search",
                match_reason=snippet[:200] if snippet else f"Matched query: {query}",
            )
        )
        if len(candidates) >= limit:
            break

    if not candidates:
        if organic_results:
            detail = (
                f" ({trade_data_skipped} trade-data site(s) excluded)"
                if trade_data_skipped
                else ""
            )
            messages.append(
                f"{provider} returned {len(organic_results)} result(s) for {country or 'global'}, "
                f"but none looked like food importer/distributor websites after filtering{detail}."
            )
        else:
            messages.append(f"{provider} returned no results for {country or 'global'}.")
    elif filtered_out or trade_data_skipped:
        extras: list[str] = []
        if trade_data_skipped:
            extras.append(f"{trade_data_skipped} trade-data site(s) excluded")
        messages.append(
            f"{country or 'Global'}: kept {len(candidates)} compan{'y' if len(candidates) == 1 else 'ies'} "
            f"from {len(organic_results)} {provider} result(s)"
            + (f" ({'; '.join(extras)})" if extras else "")
            + "."
        )

    return candidates, messages


def _discover_via_serpapi_for_markets(
    regions: list[DiscoveryRegion],
    industries: list[str],
    categories: list[str],
    limit: int,
) -> tuple[list[DiscoveryCandidate], list[str], list[str]]:
    industry_label = _industry_label(industries)
    if not regions:
        query = _build_search_query(None, industries, categories)
        found, messages = _discover_via_web_search(
            query, limit, None, industry_label=industry_label
        )
        return found, messages, [query]

    per_market_limit = max(3, limit // len(regions))
    all_candidates: list[DiscoveryCandidate] = []
    messages: list[str] = []
    queries: list[str] = []

    for region in regions:
        query = _build_search_query(region["label"], industries, categories)
        queries.append(query)
        found, market_messages = _discover_via_web_search(
            query,
            per_market_limit,
            region["label"],
            gl_code=region["gl_code"],
            industry_label=industry_label,
        )
        all_candidates.extend(found)
        messages.extend(market_messages)

    return _dedupe_candidates(all_candidates)[:limit], messages, queries


def _discover_via_website_links(
    seed_url: str,
    country: str | None,
    industry: str | None,
    limit: int,
) -> list[DiscoveryCandidate]:
    if not can_fetch(seed_url):
        return []

    seed_domain = _domain(seed_url)
    candidates: list[DiscoveryCandidate] = []
    paths = ["", "/about", "/about-us", "/partners", "/distributors", "/clients", "/customers"]

    try:
        for path in paths:
            page_url = urljoin(seed_url.rstrip("/") + "/", path.lstrip("/"))
            if not can_fetch(page_url):
                continue
            try:
                response = httpx.get(
                    page_url,
                    timeout=15,
                    follow_redirects=True,
                    headers={"User-Agent": USER_AGENT},
                )
                response.raise_for_status()
            except httpx.HTTPError:
                continue

            soup = BeautifulSoup(response.text, "html.parser")
            for anchor in soup.find_all("a", href=True):
                href = anchor["href"].strip()
                if not href or href.startswith(("#", "mailto:", "tel:", "javascript:")):
                    continue

                full_url = urljoin(page_url, href)
                link_domain = _domain(full_url)
                if not link_domain or link_domain == seed_domain:
                    continue
                if any(skip in link_domain for skip in _SKIP_DOMAINS):
                    continue

                link_text = anchor.get_text(strip=True)
                context = f"{link_text} {anchor.get('title', '')}".lower()
                if not any(kw in context or kw in full_url.lower() for kw in _PARTNER_LINK_KEYWORDS):
                    if not _looks_like_company_name(link_text):
                        continue

                company_name = link_text if _looks_like_company_name(link_text) else link_domain.split(".")[0].title()
                if not _looks_like_company_name(company_name):
                    continue

                candidates.append(
                    DiscoveryCandidate(
                        candidate_id=str(uuid.uuid4()),
                        company_name=company_name[:120],
                        website_url=_homepage_url(full_url) or full_url,
                        country=country,
                        industry=industry,
                        source="website_links",
                        source_detail=f"Linked from {seed_domain}",
                        match_reason=f"Partner/distributor link on seed website ({path or '/'})",
                    )
                )
                if len(candidates) >= limit:
                    return _dedupe_candidates(candidates)
    except httpx.HTTPError:
        return _dedupe_candidates(candidates)

    return _dedupe_candidates(candidates)


def _resolve_seed_context(
    db: Session,
    seed_lead_id: int | None,
    industries: list[str],
    categories: list[str],
) -> tuple[list[str], list[str], str | None]:
    website_url: str | None = None
    if seed_lead_id:
        buyer = buyers_module.get_buyer(db, seed_lead_id)
        if buyer:
            if not industries and buyer.industry:
                industries = _normalize_industries(None, buyer.industry)
            website_url = buyer.website_url
            if not categories:
                profile = ResearchModule().research_buyer(db, seed_lead_id)
                categories = profile.matched_categories
    return industries, categories, website_url


def discovery_candidate_from_dict(data: dict[str, Any]) -> DiscoveryCandidate:
    return DiscoveryCandidate(
        candidate_id=data.get("candidate_id") or "",
        company_name=data["company_name"],
        website_url=data.get("website_url"),
        contact_name=data.get("contact_name"),
        email=data.get("email") or _NOT_FOUND,
        phone=data.get("phone") or _NOT_FOUND,
        facebook_url=data.get("facebook_url") or _NOT_FOUND,
        instagram_url=data.get("instagram_url") or _NOT_FOUND,
        linkedin_url=data.get("linkedin_url") or _NOT_FOUND,
        country=data.get("country"),
        industry=data.get("industry"),
        legacy_serial_no=data.get("legacy_serial_no"),
        company_grading=data.get("company_grading"),
        designation=data.get("designation"),
        secondary_mobile=data.get("secondary_mobile"),
        primary_phone=data.get("primary_phone"),
        secondary_phone=data.get("secondary_phone"),
        secondary_email=data.get("secondary_email"),
        product_interest=data.get("product_interest"),
        city=data.get("city"),
        address=data.get("address"),
        remarks=data.get("remarks"),
        source=data.get("source") or "manual",
        source_detail=data.get("source_detail") or "",
        match_reason=data.get("match_reason") or "",
        already_exists=bool(data.get("already_exists")),
        is_valid_business=data.get("is_valid_business", True),
        invalid_reason=data.get("invalid_reason"),
    )


def enrich_discovery_candidate(candidate: DiscoveryCandidate) -> DiscoveryCandidate:
    """Scrape contact details for one discovery candidate (quality over speed)."""
    _enrich_candidate_contact(candidate, keep_row=True)
    valid, invalid_reason = _validate_business_candidate(candidate)
    if not valid:
        candidate.is_valid_business = False
        candidate.invalid_reason = invalid_reason
    return candidate


def enrich_existing_buyer(db: Session, buyer_id: int) -> dict[str, Any]:
    """Fill incomplete buyer/contact fields via search + scrape + CompanyLens.

    Used by Research & Score so CSV / old-client rows get table columns filled
    (website, city, address, phones, emails, designation) before research_buyer
    scores the profile.

    Clients table (``source=old_clients``): city + address are highest priority;
    secondary phones/emails/owners are filled only when already discovered and
    still empty — never at the expense of location lookup.
    Leads table: prioritize website, email, phone, socials, country.
    """
    buyer = buyers_module.get_buyer(db, buyer_id)
    if not buyer:
        raise ValueError(f"Buyer {buyer_id} not found")

    contacts = buyers_module.list_contacts_for_buyer(db, buyer_id)
    contact = next((c for c in contacts if c.email or c.phone), contacts[0] if contacts else None)
    is_clients_table = (buyer.source or "").strip().lower() == "old_clients"

    def _is_junk_website(url: str | None) -> bool:
        if not (url or "").strip():
            return False
        host = _domain(url)
        return bool(
            _domain_matches_blocklist(host, _SKIP_DOMAINS)
            or _domain_matches_blocklist(host, _DIRECTORY_PROFILE_DOMAINS)
            or _is_trade_data_platform(host, buyer.company_name)
        )

    has_website = bool((buyer.website_url or "").strip()) and not _is_junk_website(buyer.website_url)
    has_social = bool(
        (buyer.facebook_company_url or "").strip()
        or (buyer.instagram_company_url or "").strip()
        or (buyer.linkedin_company_url or "").strip()
    )
    has_contact = bool(contact and ((contact.email or "").strip() or (contact.phone or "").strip()))
    has_location = bool(
        _clean_city_value(buyer.city) and (buyer.address or "").strip()
    )

    # Clients: never skip while city/address are missing — location outranks socials.
    # Leads: skip when outreach fields are already complete.
    if is_clients_table:
        if has_location and has_website and has_contact:
            return {
                "buyer_id": buyer_id,
                "filled_fields": [],
                "website_url": buyer.website_url,
                "source_detail": (
                    "Skipped enrichment — city, address, website, and primary contact already present"
                ),
                "skipped": True,
                "mode": "clients",
            }
    elif has_website and has_social and has_contact and has_location:
        return {
            "buyer_id": buyer_id,
            "filled_fields": [],
            "website_url": buyer.website_url,
            "source_detail": "Skipped enrichment — website, contact, socials, and location already present",
            "skipped": True,
            "mode": "leads",
        }

    placeholder_names = {"general contact", "contact", "n/a", "na", "-", ""}
    existing_name = (contact.full_name if contact else None) or None
    seed_name = existing_name if existing_name and existing_name.strip().lower() not in placeholder_names else None

    candidate = DiscoveryCandidate(
        candidate_id=f"buyer-{buyer_id}",
        company_name=buyer.company_name,
        website_url=None if _is_junk_website(buyer.website_url) else buyer.website_url,
        contact_name=seed_name,
        email=(contact.email if contact and contact.email else _NOT_FOUND),
        phone=(contact.phone if contact and contact.phone else _NOT_FOUND),
        facebook_url=buyer.facebook_company_url or _NOT_FOUND,
        instagram_url=buyer.instagram_company_url or _NOT_FOUND,
        linkedin_url=buyer.linkedin_company_url or _NOT_FOUND,
        country=buyer.country,
        industry=buyer.industry,
        designation=(contact.designation if contact else None),
        secondary_mobile=(contact.secondary_mobile if contact else None),
        primary_phone=(contact.primary_phone if contact else None),
        secondary_phone=(contact.secondary_phone if contact else None),
        secondary_email=(contact.secondary_email if contact else None),
        city=_clean_city_value(buyer.city),
        address=buyer.address,
        source=(buyer.source or "old_clients"),
        source_detail="Existing lead enrichment",
    )

    before = {
        "website_url": buyer.website_url,
        "facebook_company_url": buyer.facebook_company_url,
        "instagram_company_url": buyer.instagram_company_url,
        "linkedin_company_url": buyer.linkedin_company_url,
        "country": buyer.country,
        "industry": buyer.industry,
        "city": buyer.city,
        "address": buyer.address,
        "email": contact.email if contact else None,
        "phone": contact.phone if contact else None,
        "designation": contact.designation if contact else None,
        "secondary_mobile": contact.secondary_mobile if contact else None,
        "primary_phone": contact.primary_phone if contact else None,
        "secondary_phone": contact.secondary_phone if contact else None,
        "secondary_email": contact.secondary_email if contact else None,
        "contact_name": contact.full_name if contact else None,
    }

    _enrich_candidate_contact(
        candidate,
        keep_row=True,
        prioritize_location=is_clients_table,
    )

    buyer_updates: dict[str, Any] = {}
    existing_site_junk = _is_junk_website(buyer.website_url)
    if candidate.website_url and (not buyer.website_url or existing_site_junk):
        buyer_updates["website_url"] = candidate.website_url
    # Never clear an existing website (even junk) during AI Auto Data Update /
    # enrichment fills — only upgrade when we have a replacement URL.
    if not buyer.facebook_company_url and _value_or_none(candidate.facebook_url):
        buyer_updates["facebook_company_url"] = _value_or_none(candidate.facebook_url)
    if not buyer.instagram_company_url and _value_or_none(candidate.instagram_url):
        buyer_updates["instagram_company_url"] = _value_or_none(candidate.instagram_url)
    if not buyer.linkedin_company_url and _value_or_none(candidate.linkedin_url):
        buyer_updates["linkedin_company_url"] = _value_or_none(candidate.linkedin_url)
    if not buyer.country and candidate.country:
        buyer_updates["country"] = candidate.country
    if not buyer.industry and candidate.industry:
        buyer_updates["industry"] = candidate.industry

    # Location — fill empty cells only (never overwrite existing city/address).
    cleaned_city = _clean_city_value(candidate.city)
    if cleaned_city and (not buyer.city or not _is_plausible_city(buyer.city)):
        buyer_updates["city"] = cleaned_city
    if candidate.address and not (buyer.address or "").strip():
        buyer_updates["address"] = candidate.address

    if buyer_updates:
        buyers_module.update_buyer(db, buyer_id, buyer_updates)

    email = _value_or_none(candidate.email)
    phone = _value_or_none(candidate.phone)
    linkedin = _value_or_none(candidate.linkedin_url)
    contact_updates: dict[str, Any] = {}

    def _set_if_empty(field: str, value: str | None) -> None:
        if not value:
            return
        current = getattr(contact, field, None) if contact else None
        if contact and (current or "").strip():
            return
        contact_updates[field] = value

    if contact:
        _set_if_empty("email", email)
        _set_if_empty("phone", phone)
        if not contact.linkedin_profile_url and linkedin:
            contact_updates["linkedin_profile_url"] = linkedin
        # Clients columns — fill empty cells only (secondary is lowest priority).
        _set_if_empty("designation", (candidate.designation or "").strip() or None)
        _set_if_empty("secondary_mobile", (candidate.secondary_mobile or "").strip() or None)
        _set_if_empty("primary_phone", (candidate.primary_phone or "").strip() or None)
        _set_if_empty("secondary_phone", (candidate.secondary_phone or "").strip() or None)
        _set_if_empty("secondary_email", (candidate.secondary_email or "").strip() or None)
        new_name = (candidate.contact_name or "").strip()
        if (
            new_name
            and new_name.lower() not in placeholder_names
            and (contact.full_name or "").strip().lower() in placeholder_names
        ):
            contact_updates["full_name"] = new_name
        if contact_updates:
            buyers_module.update_contact(db, contact.id, contact_updates)
    elif email or phone or candidate.contact_name or candidate.designation:
        buyers_module.create_contact(
            db,
            {
                "buyer_id": buyer_id,
                "full_name": (candidate.contact_name or "").strip() or "General contact",
                "email": email,
                "phone": phone,
                "designation": (candidate.designation or "").strip() or None,
                "secondary_mobile": (candidate.secondary_mobile or "").strip() or None,
                "primary_phone": (candidate.primary_phone or "").strip() or None,
                "secondary_phone": (candidate.secondary_phone or "").strip() or None,
                "secondary_email": (candidate.secondary_email or "").strip() or None,
                "linkedin_profile_url": linkedin,
                "data_source": "enrichment",
                "consent_status": "unknown",
            },
        )
        contact_updates = {"created": True}

    db.refresh(buyer)
    filled = [key for key, value in buyer_updates.items() if value]
    if contact_updates:
        if contact_updates.get("created"):
            filled.append("contact.created")
        else:
            filled.extend(f"contact.{key}" for key in contact_updates)

    return {
        "buyer_id": buyer_id,
        "filled_fields": filled,
        "website_url": buyer.website_url,
        "source_detail": candidate.source_detail,
        "before": before,
        "mode": "clients" if is_clients_table else "leads",
    }


def discover_leads(
    db: Session,
    *,
    seed_lead_id: int | None = None,
    region_codes: list[str] | None = None,
    country: str | None = None,
    industry: str | None = None,
    industries: list[str] | None = None,
    categories: list[str] | None = None,
    limit: int = 15,
    use_web_search: bool = True,
    use_website_links: bool = True,
    skip_enrichment: bool = False,
) -> DiscoveryResult:
    categories = categories or []
    limit = max(1, min(limit, 15))
    result = DiscoveryResult()

    normalized_industries = _normalize_industries(industries, industry)
    normalized_industries, categories, seed_url = _resolve_seed_context(
        db, seed_lead_id, normalized_industries, categories
    )

    regions, region_messages = resolve_region_codes(region_codes)
    result.messages.extend(region_messages)

    if not regions and country:
        matched = match_region_code(country)
        if matched:
            regions, legacy_messages = resolve_region_codes([matched])
            result.messages.extend(legacy_messages)

    if not regions and not normalized_industries and not categories and not seed_url:
        result.messages.append(
            f"Select up to {MAX_DISCOVERY_REGIONS} target regions, or provide industry / a seed lead."
        )
        return result

    all_candidates: list[DiscoveryCandidate] = []
    region_labels = [region["label"] for region in regions]
    industry_label = _industry_label(normalized_industries)
    query = _build_search_query(
        region_labels[0] if region_labels else None,
        normalized_industries,
        categories,
    )
    result.search_query = query
    if len(regions) > 1:
        result.search_query = (
            f"{len(regions)} regions searched separately: {', '.join(region_labels)}. "
            f"Example query: {query}"
        )
    if industry_label and len(normalized_industries) > 1:
        result.search_query = (
            f"{result.search_query} · Industries: {industry_label}"
            if result.search_query
            else f"Industries: {industry_label}"
        )

    if use_web_search:
        if web_search.any_provider_available() or web_search.any_combined_provider_available():
            found, search_messages, queries = _discover_via_serpapi_for_markets(
                regions,
                normalized_industries,
                categories,
                limit,
            )
            if len(regions) <= 1 and queries:
                result.search_query = queries[0]
                if industry_label and len(normalized_industries) > 1:
                    result.search_query = f"{queries[0]} · Industries: {industry_label}"
            result.messages.extend(search_messages)
            if found:
                result.sources_used.append("web_search")
                all_candidates.extend(found)
            elif not search_messages:
                result.messages.append("Web search returned no results for this query.")
        else:
            result.messages.append(
                "No web-search provider available. Configure SERPAPI_API_KEY, "
                "GOOGLE_CSE_API_KEY + GOOGLE_CSE_ENGINE_ID, and/or install ddgs for DuckDuckGo."
            )

    if use_website_links and seed_url:
        found = _discover_via_website_links(
            seed_url,
            region_labels[0] if region_labels else None,
            industry_label,
            limit,
        )
        if found:
            result.sources_used.append("website_links")
            all_candidates.extend(found)
        elif seed_url:
            result.messages.append("No partner/distributor links found on the seed website.")

    all_candidates = _dedupe_candidates(all_candidates)[:limit]
    if not skip_enrichment:
        _enrich_candidates(all_candidates)
    existing_names, existing_domains = _discovery_existing_keys(db)
    _mark_existing(all_candidates, existing_names, existing_domains)
    result.candidates = all_candidates

    if not all_candidates and not result.messages:
        result.messages.append("No discovery candidates found. Try different filters or set BRAVE_API_KEY / SERPAPI_API_KEY.")
    return result


def _normalize_csv_header(field: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", field.strip().lower()).strip("_")


def _clean_spreadsheet_scalar(value: str) -> str:
    """Normalize Excel-exported numbers like '82559646661.0' and whitespace."""
    text = (value or "").strip()
    if re.fullmatch(r"\d+\.0+", text):
        return text.split(".", 1)[0]
    return text


def _parse_optional_int(value: str) -> int | None:
    cleaned = _clean_spreadsheet_scalar(value)
    if not cleaned:
        return None
    try:
        return int(float(cleaned))
    except ValueError:
        return None


def parse_csv_candidates(
    content: str,
    default_country: str | None = None,
    *,
    include_blank_names: bool = False,
) -> list[DiscoveryCandidate]:
    """Parse CSV with flexible headers (matches leads table export + old-client Excel columns)."""
    if not content.strip():
        return []

    sample = content[:8192]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",\t;|")
    except csv.Error:
        dialect = csv.excel

    reader = csv.DictReader(io.StringIO(content), dialect=dialect)
    if not reader.fieldnames:
        return []

    def col(*names: str) -> str | None:
        wanted = set(names)
        for field in reader.fieldnames or []:
            if _normalize_csv_header(field) in wanted:
                return field
        return None

    name_col = col(
        "company_name",
        "company",
        "name",
        "buyer",
        "organization",
        "organisation",
        "business_name",
        "business",
        "firm",
        "client",
        "customer",
        "account",
        "account_name",
    )
    website_col = col("website_url", "website", "url", "web", "site", "homepage")
    country_col = col("country", "market", "region", "nation", "location")
    industry_col = col(
        "industry",
        "sector",
        "type",
        "business_type",
        "busniess_type",
        "category",
    )
    contact_col = col(
        "contact_name",
        "contact",
        "full_name",
        "person",
        "contact_person",
        "representative",
        "attn",
        "attention",
    )
    email_col = col(
        "contact_email",
        "email",
        "e_mail",
        "e-mail",
        "mail",
        "primary_email",
        "primary_e_mail",
    )
    phone_col = col(
        "contact_phone",
        "phone",
        "telephone",
        "mobile",
        "tel",
        "cell",
        "primary_mobile_no",
        "primary_mobile",
        "primary_mobile_number",
    )
    linkedin_col = col("linkedin_company_url", "linkedin", "linkedin_url")
    facebook_col = col("facebook_company_url", "facebook", "facebook_url")
    instagram_col = col("instagram_company_url", "instagram", "instagram_url")
    serial_col = col("s_no", "serial_no", "serial", "legacy_serial_no", "no", "sr_no")
    grading_col = col("companies_grading", "company_grading", "grading", "grade")
    designation_col = col("designation", "title", "job_title", "position")
    secondary_mobile_col = col(
        "secondary_mobile_no",
        "secondary_mobile",
        "secondary_mobile_number",
        "alt_mobile",
    )
    primary_phone_col = col(
        "primary_phone_no",
        "primary_phone",
        "primary_telephone",
        "office_phone",
        "landline",
    )
    secondary_phone_col = col(
        "secondary_phone_no",
        "secondary_phone",
        "secondary_telephone",
        "alt_phone",
    )
    secondary_email_col = col(
        "secondary_email",
        "secondary_e_mail",
        "alt_email",
        "alternate_email",
    )
    product_col = col("product", "products", "product_interest", "product_focus")
    city_col = col("city", "town")
    address_col = col("address", "street_address", "full_address")
    remarks_col = col(
        "remarks",
        "remark",
        "notes",
        "note",
        "comment",
        "comments",
        "remarks_02",
        "remarks 02",
        "remark_02",
        "remark 02",
        "remarks2",
    )
    remarks_03_col = col("remarks_03", "remarks 03", "remark_03", "remark 03", "remarks3")
    remarks_04_col = col("remarks_04", "remarks 04", "remark_04", "remark 04", "remarks4")

    if not name_col and reader.fieldnames:
        name_col = reader.fieldnames[0]

    if not name_col:
        raise ValueError("CSV must include a company name column (company_name, company, or name).")

    def csv_value(row: dict[str, str], column: str | None) -> str:
        if not column:
            return ""
        return _clean_spreadsheet_scalar(row.get(column) or "")

    candidates: list[DiscoveryCandidate] = []
    for row in reader:
        name = csv_value(row, name_col)
        if not name and not include_blank_names:
            continue
        # Spreadsheet table imports keep blank/sparse rows as-is for later research.
        if include_blank_names and not name:
            # Skip only completely empty spreadsheet lines (no mapped field values).
            has_any = any(
                csv_value(row, column)
                for column in (
                    website_col,
                    country_col,
                    industry_col,
                    contact_col,
                    email_col,
                    phone_col,
                    linkedin_col,
                    facebook_col,
                    instagram_col,
                    secondary_mobile_col,
                    primary_phone_col,
                    secondary_phone_col,
                    secondary_email_col,
                    product_col,
                    city_col,
                    address_col,
                    remarks_col,
                    remarks_03_col,
                    remarks_04_col,
                    grading_col,
                    designation_col,
                    serial_col,
                )
                if column
            )
            if not has_any and not any((v or "").strip() for v in row.values()):
                continue
        website = csv_value(row, website_col)
        country_raw = csv_value(row, country_col)
        country = resolve_country_name(country_raw) if country_raw else None
        if not country and country_raw:
            country = country_raw
        industry = csv_value(row, industry_col)
        contact_name = csv_value(row, contact_col) or None
        email_raw = csv_value(row, email_col)
        email_clean = ""
        if email_raw:
            from modules.field_clean import normalize_email_or_empty

            email_clean = normalize_email_or_empty(email_raw)
        email = email_clean
        phone = csv_value(row, phone_col)
        linkedin = csv_value(row, linkedin_col)
        facebook = csv_value(row, facebook_col)
        instagram = csv_value(row, instagram_col)
        secondary_mobile = csv_value(row, secondary_mobile_col) or None
        primary_phone = csv_value(row, primary_phone_col) or None
        secondary_phone = csv_value(row, secondary_phone_col) or None
        secondary_email_raw = csv_value(row, secondary_email_col) or None
        secondary_email = secondary_email_raw
        if secondary_email_raw:
            from modules.field_clean import normalize_email_or_empty

            secondary_email = normalize_email_or_empty(secondary_email_raw) or None
        candidates.append(
            DiscoveryCandidate(
                candidate_id=str(uuid.uuid4()),
                company_name=name,
                website_url=_homepage_url(website) or website or None,
                contact_name=contact_name,
                email=email or _NOT_FOUND,
                phone=phone or _NOT_FOUND,
                linkedin_url=linkedin or _NOT_FOUND,
                facebook_url=facebook or _NOT_FOUND,
                instagram_url=instagram or _NOT_FOUND,
                country=country or default_country,
                industry=industry or None,
                legacy_serial_no=_parse_optional_int(csv_value(row, serial_col)),
                company_grading=csv_value(row, grading_col) or None,
                designation=csv_value(row, designation_col) or None,
                secondary_mobile=secondary_mobile,
                primary_phone=primary_phone,
                secondary_phone=secondary_phone,
                secondary_email=secondary_email,
                product_interest=csv_value(row, product_col) or None,
                city=csv_value(row, city_col) or None,
                address=csv_value(row, address_col) or None,
                remarks=csv_value(row, remarks_col) or None,
                remarks_03=csv_value(row, remarks_03_col) or None,
                remarks_04=csv_value(row, remarks_04_col) or None,
                source="csv",
                source_detail="CSV import",
                match_reason="Imported from CSV",
            )
        )
    return candidates


def _normalize_import_contact_fields(raw: dict[str, Any]) -> dict[str, Any]:
    from modules.field_clean import normalize_email_or_empty

    for key in ("email", "secondary_email", "contact_email"):
        val = raw.get(key)
        if val is None:
            continue
        text = str(val).strip()
        if not text or text == _NOT_FOUND:
            continue
        cleaned = normalize_email_or_empty(text)
        raw[key] = cleaned if cleaned else _NOT_FOUND
    return raw


def _import_contact_duplicate_keys(raw: dict[str, Any]) -> list[tuple[str, str]]:
    from modules.field_clean import email_dedupe_key, phone_dedupe_key

    keys: list[tuple[str, str]] = []
    for field in ("email", "secondary_email", "contact_email"):
        val = raw.get(field)
        if val and str(val).strip() not in {"", _NOT_FOUND}:
            email_key = email_dedupe_key(str(val))
            if email_key:
                keys.append(("email", email_key))
    for field in ("phone", "primary_phone", "secondary_phone", "secondary_mobile", "contact_phone"):
        val = raw.get(field)
        if val and str(val).strip() not in {"", _NOT_FOUND}:
            phone_key = phone_dedupe_key(str(val))
            if phone_key:
                keys.append(("phone", phone_key))
    return keys


def _find_import_duplicate_buyer(
    raw: dict[str, Any],
    *,
    by_person_email: dict[str, Any],
    by_person_phone: dict[str, Any],
    by_email: dict[str, Any],
    by_phone: dict[str, Any],
) -> Any | None:
    """Match existing lead by contact identity — never by company name alone.

    Priority:
      1) contact person + email
      2) contact person + phone
      3) email alone / phone alone only when contact person is blank
    Shared switchboard phones must not collapse different buyers at one company.
    """
    from modules.field_clean import (
        contact_name_dedupe_key,
        email_dedupe_key,
        person_email_dedupe_key,
        person_phone_dedupe_key,
        phone_dedupe_key,
    )

    contact_name = (raw.get("contact_name") or raw.get("contact_person") or "").strip()
    person_key = contact_name_dedupe_key(contact_name)

    email_vals = []
    for field in ("email", "secondary_email", "contact_email"):
        val = raw.get(field)
        if val and str(val).strip() not in {"", _NOT_FOUND}:
            email_vals.append(str(val))

    phone_vals = []
    for field in ("phone", "primary_phone", "secondary_phone", "secondary_mobile", "contact_phone"):
        val = raw.get(field)
        if val and str(val).strip() not in {"", _NOT_FOUND}:
            phone_vals.append(str(val))

    # 1) Contact person + email
    if person_key:
        for email_val in email_vals:
            combo = person_email_dedupe_key(contact_name, email_val)
            if combo and combo in by_person_email:
                return by_person_email[combo]

        # 2) Contact person + phone (different people can share a company line)
        for phone_val in phone_vals:
            combo = person_phone_dedupe_key(contact_name, phone_val)
            if combo and combo in by_person_phone:
                return by_person_phone[combo]
        return None

    # 3) Nameless rows only: email alone, then phone alone
    for email_val in email_vals:
        email_key = email_dedupe_key(email_val)
        if email_key and email_key in by_email:
            return by_email[email_key]
    for phone_val in phone_vals:
        phone_key = phone_dedupe_key(phone_val)
        if phone_key and phone_key in by_phone:
            return by_phone[phone_key]

    return None


def _field_or_not_found(raw: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = (raw.get(key) or "").strip()
        if value:
            return value
    return _NOT_FOUND


def _import_raw_to_candidate(raw: dict[str, Any]) -> DiscoveryCandidate:
    name = (raw.get("company_name") or "").strip()
    legacy_serial = raw.get("legacy_serial_no")
    if legacy_serial is not None and not isinstance(legacy_serial, int):
        legacy_serial = _parse_optional_int(str(legacy_serial))
    country_raw = (raw.get("country") or "").strip() or None
    country = resolve_country_name(country_raw) if country_raw else None
    if not country and country_raw:
        country = country_raw
    if not country:
        for phone_key in (
            "phone",
            "contact_phone",
            "primary_phone",
            "contact_primary_phone",
            "secondary_phone",
            "contact_secondary_phone",
            "secondary_mobile",
            "contact_secondary_mobile",
        ):
            phone_val = (raw.get(phone_key) or "").strip()
            if phone_val:
                inferred = country_from_phone(phone_val)
                if inferred:
                    country = inferred
                    break
    return DiscoveryCandidate(
        candidate_id=str(uuid.uuid4()),
        company_name=name,
        website_url=raw.get("website_url") or None,
        contact_name=(raw.get("contact_name") or "").strip() or None,
        email=_field_or_not_found(raw, "email", "contact_email"),
        phone=_field_or_not_found(raw, "phone", "contact_phone"),
        linkedin_url=_field_or_not_found(raw, "linkedin_url", "linkedin_company_url"),
        facebook_url=_field_or_not_found(raw, "facebook_url", "facebook_company_url"),
        instagram_url=_field_or_not_found(raw, "instagram_url", "instagram_company_url"),
        country=country,
        industry=raw.get("industry") or None,
        legacy_serial_no=legacy_serial,
        company_grading=(raw.get("company_grading") or "").strip() or None,
        designation=(raw.get("designation") or raw.get("contact_designation") or "").strip() or None,
        secondary_mobile=(raw.get("secondary_mobile") or raw.get("contact_secondary_mobile") or "").strip()
        or None,
        primary_phone=(raw.get("primary_phone") or raw.get("contact_primary_phone") or "").strip() or None,
        secondary_phone=(raw.get("secondary_phone") or raw.get("contact_secondary_phone") or "").strip()
        or None,
        secondary_email=(raw.get("secondary_email") or raw.get("contact_secondary_email") or "").strip()
        or None,
        product_interest=(raw.get("product_interest") or "").strip() or None,
        city=(raw.get("city") or "").strip() or None,
        address=(raw.get("address") or "").strip() or None,
        remarks=(raw.get("remarks") or "").strip() or None,
        remarks_03=(raw.get("remarks_03") or "").strip() or None,
        remarks_04=(raw.get("remarks_04") or "").strip() or None,
        source=raw.get("source") or "csv",
        source_detail="CSV import",
        match_reason="Imported from CSV",
    )


def _sync_candidate_to_raw(candidate: DiscoveryCandidate, raw: dict[str, Any]) -> dict[str, Any]:
    enriched = dict(raw)
    enriched["company_name"] = candidate.company_name
    if candidate.website_url:
        enriched["website_url"] = candidate.website_url
    if candidate.country:
        enriched["country"] = candidate.country
    if candidate.industry:
        enriched["industry"] = candidate.industry
    if candidate.contact_name:
        enriched["contact_name"] = candidate.contact_name
    if candidate.legacy_serial_no is not None:
        enriched["legacy_serial_no"] = candidate.legacy_serial_no
    for attr in (
        "company_grading",
        "designation",
        "secondary_mobile",
        "primary_phone",
        "secondary_phone",
        "secondary_email",
        "product_interest",
        "city",
        "address",
        "remarks",
        "remarks_03",
        "remarks_04",
    ):
        value = getattr(candidate, attr)
        if value:
            enriched[attr] = value

    for attr, key in (
        ("email", "email"),
        ("phone", "phone"),
        ("linkedin_url", "linkedin_url"),
        ("facebook_url", "facebook_url"),
        ("instagram_url", "instagram_url"),
    ):
        cleaned = _value_or_none(getattr(candidate, attr))
        if cleaned:
            enriched[key] = cleaned
    return enriched


def _enrich_import_raw(raw: dict[str, Any]) -> dict[str, Any]:
    """Scrape each CSV import row for website, contact, and social details."""
    name = (raw.get("company_name") or "").strip()
    if not name:
        return raw

    candidate = _import_raw_to_candidate(raw)
    _enrich_candidate_contact(candidate, keep_row=True)
    return _sync_candidate_to_raw(candidate, raw)


def _needs_import_enrichment(raw: dict[str, Any]) -> bool:
    """Skip re-scraping when CSV preview already found website, contact, and social links."""
    website = (raw.get("website_url") or "").strip()
    email = (raw.get("email") or "").strip()
    phone = (raw.get("phone") or "").strip()
    socials = [
        (raw.get("facebook_url") or "").strip(),
        (raw.get("instagram_url") or "").strip(),
        (raw.get("linkedin_url") or "").strip(),
    ]
    has_contact = any(
        value and value.lower() != _NOT_FOUND.lower() for value in (email, phone)
    )
    has_social = any(
        value and value.lower() != _NOT_FOUND.lower() for value in socials
    )
    if not website:
        return True
    if not has_contact:
        return True
    if not has_social:
        return True
    return False


def discover_from_csv(
    db: Session,
    content: str,
    default_country: str | None = None,
    *,
    for_leads_table: bool = False,
    import_source: str | None = None,
    assigned_to_user_id: int | None = None,
) -> DiscoveryResult:
    result = DiscoveryResult(sources_used=["csv"])
    try:
        candidates = parse_csv_candidates(
            content,
            default_country,
            include_blank_names=for_leads_table,
        )
    except ValueError as exc:
        result.messages.append(str(exc))
        return result

    if not candidates:
        result.messages.append("No rows found in CSV.")
        return result

    if import_source:
        pool_source = import_source.strip().lower()
        for candidate in candidates:
            candidate.source = pool_source

    scope_source = import_source if import_source else None
    scope = _import_scope_for_source(scope_source or ("csv" if for_leads_table else ""))
    invalid_count = _flag_invalid_candidates(
        candidates, for_spreadsheet=for_leads_table
    )
    if invalid_count and not for_leads_table:
        result.messages.append(
            f"{invalid_count} row(s) look like directories or list pages — they will not be imported."
        )
    if for_leads_table:
        result.messages.append(
            f"Loaded {len(candidates)} row(s) from file. "
            "Same company name can appear many times; duplicates are contact+email or "
            "contact+phone (shared company lines keep separate people). "
            "Use Import only to save mapped fields as-is, or Research & score later from the table."
        )
        without_website = sum(1 for c in candidates if not _homepage_url(c.website_url))
        if without_website and not web_search.any_combined_provider_available():
            result.messages.append(
                f"{without_website} row(s) have no website — Research & score later uses "
                "SerpAPI + DuckDuckGo + Google CSE + Wikidata (+ CompanyLens when configured)."
            )
        # Spreadsheet / all list imports: never flag by company name alone.
        _mark_existing_by_contact(
            db,
            candidates,
            source=scope.get("source"),
            exclude_source=scope.get("exclude_source"),
            assigned_to_user_id=assigned_to_user_id,
        )
    elif (scope_source or "").strip().lower() in {"old_clients", "incomplete_archives"}:
        _mark_existing_by_contact(
            db,
            candidates,
            source=scope.get("source"),
            exclude_source=scope.get("exclude_source"),
            assigned_to_user_id=assigned_to_user_id,
        )
        _enrich_candidates(candidates)
    else:
        # Discover panel: still flag against company/domain so we don't rediscover
        # companies that already exist anywhere in the CRM.
        existing_names, existing_domains = _discovery_existing_keys(db)
        _enrich_candidates(candidates)
        _mark_existing(candidates, existing_names, existing_domains)
    result.candidates = candidates
    return result


def import_candidates(
    db: Session,
    candidates: list[dict[str, Any]],
    *,
    auto_onboard: bool = False,
    replace_duplicates: bool = False,
    skip_enrichment: bool = False,
    assigned_to_user_id: int | None = None,
    progress_callback: Callable[[int, str, dict[str, int]], None] | None = None,
) -> dict[str, Any]:
    from modules import leads as leads_module
    from modules.audit import log_action

    created: list[Any] = []
    skipped: list[dict[str, str]] = []
    replaced: list[dict[str, Any]] = []
    onboard_results: list[dict[str, Any]] = []
    batch_source = next(
        ((raw.get("source") or "").strip() for raw in candidates if (raw.get("source") or "").strip()),
        "",
    )
    scope = _import_scope_for_source(batch_source)
    # Sales imports: only collide with that user's own assigned rows.
    # Admin imports (assigned_to_user_id=None): section-wide dedupe as before.
    by_name, by_domain, existing_scores, by_email, by_phone, by_person_email, by_person_phone = (
        buyers_module.build_buyer_lookup_index(
            db,
            **scope,
            assigned_to_user_id=assigned_to_user_id,
        )
    )
    # Junk/social hosts must not make unrelated companies look like duplicates.
    by_domain = {
        domain: buyer
        for domain, buyer in by_domain.items()
        if not _is_junk_dedupe_domain(domain)
    }
    existing_names = set(by_name.keys())
    existing_domains = set(by_domain.keys())

    # Cross-section block: Discover / generic imports must not recreate Old clients.
    # Targeted pools + custom lists are standalone — same company in Old clients is OK.
    other_names: set[str] = set()
    other_domains: set[str] = set()
    batch_source_norm = (batch_source or "").strip().lower()
    _standalone_import = {
        "old_clients",
        "incomplete_archives",
        "hyperstore_targeted",
        "targeted_distributor",
        "targeted_client",
        "khalid_focused_sales",
        "testing",
        "schedule_meeting",
    }
    scope_source = (scope.get("source") or "").strip().lower()
    is_standalone_list = batch_source_norm in _standalone_import or (
        bool(scope_source) and scope_source == batch_source_norm and batch_source_norm not in {"csv", ""}
    )
    if not is_standalone_list:
        other_names, other_domains = _existing_buyer_keys(
            db,
            source="old_clients",
            assigned_to_user_id=assigned_to_user_id,
        )

    def _import_data_score(raw: dict[str, Any]) -> int:
        points = 0
        if raw.get("website_url"):
            points += 10
        if raw.get("country"):
            points += 2
        if raw.get("industry"):
            points += 2
        if raw.get("company_grading"):
            points += 1
        if raw.get("product_interest"):
            points += 2
        if raw.get("city"):
            points += 1
        if raw.get("address"):
            points += 1
        if raw.get("remarks"):
            points += 1
        if _value_or_none(raw.get("linkedin_url")):
            points += 3
        if _value_or_none(raw.get("facebook_url")):
            points += 2
        if _value_or_none(raw.get("instagram_url")):
            points += 2
        if _value_or_none(raw.get("email")):
            points += 15
        if _value_or_none(raw.get("phone")):
            points += 5
        if raw.get("primary_phone"):
            points += 3
        if raw.get("secondary_mobile"):
            points += 2
        if raw.get("secondary_phone"):
            points += 2
        if raw.get("secondary_email"):
            points += 5
        return points

    persist_each_row = not skip_enrichment
    pending_since_flush = 0
    FLUSH_EVERY = 75
    # Spreadsheet imports: commit every row so a single bad row / lock / blip cannot
    # strand the rest of the sheet (e.g. stop at 133/284 with only ~133 saved).
    # Discover/enrichment imports keep larger checkpoints.
    COMMIT_EVERY = 1 if skip_enrichment else 50
    rows_since_checkpoint = 0
    # How much of `created` / `replaced` is actually committed to the DB right
    # now (vs. only staged in this Python-level list). `skipped` never needs
    # this — a skip has no DB side effect to roll back.
    committed_created = 0
    committed_replaced = 0

    if skip_enrichment:
        # Avoid per-attribute refresh queries after each periodic commit —
        # buyer/contact objects created earlier in the loop are still read
        # (e.g. existing.company_name, buyer.id) after later checkpoints.
        db.expire_on_commit = False

    def _flush_pending() -> None:
        nonlocal pending_since_flush
        if pending_since_flush > 0:
            db.flush()
            pending_since_flush = 0

    def _checkpoint_commit() -> None:
        nonlocal rows_since_checkpoint, pending_since_flush, committed_created, committed_replaced
        if not skip_enrichment:
            return
        rows_since_checkpoint += 1
        if rows_since_checkpoint >= COMMIT_EVERY:
            db.commit()
            rows_since_checkpoint = 0
            pending_since_flush = 0
            committed_created = len(created)
            committed_replaced = len(replaced)

    def _report_progress(processed: int, current_name: str) -> None:
        if progress_callback is None:
            return
        try:
            progress_callback(
                processed,
                current_name,
                {
                    "created": len(created),
                    "skipped": len(skipped),
                    "replaced": len(replaced),
                },
            )
        except Exception:  # noqa: BLE001 — progress reporting must never break the import
            pass

    try:
        for row_index, raw in enumerate(candidates):
            raw = _normalize_import_contact_fields(dict(raw))
            name = (raw.get("company_name") or "").strip()
            _report_progress(row_index, name or "(unnamed)")
            try:
                candidate = _import_raw_to_candidate(raw)
                if not skip_enrichment and _needs_import_enrichment(raw):
                    _enrich_candidate_contact(candidate, keep_row=True)

                # Spreadsheet table imports (skip_enrichment): copy every row as-is,
                # including blank/sparse company names — research & score later.
                # Discover / research imports still filter "not a valid business".
                if not skip_enrichment:
                    if not name:
                        skipped.append(
                            {"company_name": "(empty)", "reason": "Missing company name"}
                        )
                        _checkpoint_commit()
                        continue
                    valid, invalid_reason = _validate_business_candidate(candidate)
                    if not valid:
                        skipped.append(
                            {
                                "company_name": name,
                                "reason": f"Not a valid business — {invalid_reason}",
                            }
                        )
                        _checkpoint_commit()
                        continue

                raw = _sync_candidate_to_raw(candidate, raw)
                name = (raw.get("company_name") or "").strip()
                # DB requires company_name NOT NULL — store blank string when sheet had none.
                if not name and skip_enrichment:
                    raw["company_name"] = ""
                    name = ""

                if skip_enrichment and batch_source_norm == "old_clients":
                    from modules.incomplete_archives import is_fragmentary_import_row

                    if is_fragmentary_import_row(raw):
                        raw["source"] = "incomplete_archives"

                name_key = _normalize_name(name) if name else ""
                domain = _dedupe_domain(raw.get("website_url"))

                # Block cross-section duplicates (e.g. discovery matching an old client).
                if (name_key and name_key in other_names) or (
                    domain and domain in other_domains
                ):
                    reason = (
                        "Already an old client"
                        if batch_source_norm not in {"old_clients", "incomplete_archives"}
                        else "Already in Discover / Leads table"
                    )
                    skipped.append(
                        {"company_name": name or "(unnamed)", "reason": reason}
                    )
                    _checkpoint_commit()
                    continue

                existing = _find_import_duplicate_buyer(
                    raw,
                    by_person_email=by_person_email,
                    by_person_phone=by_person_phone,
                    by_email=by_email,
                    by_phone=by_phone,
                )
                if existing is not None:
                    should_replace = False
                    if replace_duplicates:
                        existing_score = existing_scores.get(
                            existing.id, buyers_module.buyer_data_score(db, existing)
                        )
                        import_score = _import_data_score(raw)
                        should_replace = existing_score < 8 or import_score > existing_score

                    if should_replace:
                        if assigned_to_user_id is not None and existing.assigned_to_user_id not in (
                            None,
                            assigned_to_user_id,
                        ):
                            skipped.append(
                                {
                                    "company_name": name,
                                    "reason": "Already in leads (assigned to another user)",
                                }
                            )
                            _checkpoint_commit()
                            continue
                        _flush_pending()
                        leads_module.delete_lead_table_row(
                            db, existing.id, commit=persist_each_row
                        )
                        existing_names.discard(_normalize_name(existing.company_name))
                        by_name.pop(_normalize_name(existing.company_name), None)
                        existing_domain = _dedupe_domain(existing.website_url)
                        if existing_domain:
                            existing_domains.discard(existing_domain)
                            by_domain.pop(existing_domain, None)
                        existing_scores.pop(existing.id, None)
                        replaced.append(
                            {
                                "company_name": name,
                                "replaced_id": existing.id,
                                "reason": "Replaced sparse duplicate with fresh CSV data",
                            }
                        )
                    else:
                        is_clients = batch_source_norm == "old_clients"
                        is_incomplete = batch_source_norm == "incomplete_archives"
                        if assigned_to_user_id is not None:
                            reason = (
                                "Already in your clients table"
                                if is_clients
                                else "Already in incomplete archives"
                                if is_incomplete
                                else "Already in your leads"
                            )
                        else:
                            reason = (
                                "Already in clients table"
                                if is_clients
                                else "Already in incomplete archives"
                                if is_incomplete
                                else "Already in leads"
                            )
                        skipped.append({"company_name": name, "reason": reason})
                        _checkpoint_commit()
                        continue

                buyer = buyers_module.create_buyer(
                    db,
                    {
                        "company_name": name,
                        "website_url": raw.get("website_url") or None,
                        "country": raw.get("country") or None,
                        "industry": raw.get("industry") or None,
                        "linkedin_company_url": _value_or_none(raw.get("linkedin_url")),
                        "facebook_company_url": _value_or_none(raw.get("facebook_url")),
                        "instagram_company_url": _value_or_none(raw.get("instagram_url")),
                        "source": raw.get("source") or "discovery",
                        "intake_method": (
                            "upload"
                            if skip_enrichment
                            and batch_source_norm
                            in {
                                "hyperstore_targeted",
                                "targeted_distributor",
                                "targeted_client",
                                "khalid_focused_sales",
                                "old_clients",
                                "incomplete_archives",
                            }
                            else (
                                "discover"
                                if batch_source_norm
                                in {"hyperstore_targeted", "targeted_distributor", "targeted_client", "khalid_focused_sales"}
                                else None
                            )
                        ),
                        "legacy_serial_no": raw.get("legacy_serial_no"),
                        "company_grading": (raw.get("company_grading") or None),
                        "product_interest": (raw.get("product_interest") or None),
                        "city": (raw.get("city") or None),
                        "address": (raw.get("address") or None),
                        "remarks": (raw.get("remarks") or None),
                        "remarks_03": (raw.get("remarks_03") or None),
                        "remarks_04": (raw.get("remarks_04") or None),
                    },
                    commit=persist_each_row,
                    flush=True,
                )
                if assigned_to_user_id is not None:
                    leads_module.apply_buyer_assignee(db, buyer, assigned_to_user_id)
                    if persist_each_row:
                        db.commit()
                        db.refresh(buyer)
                if name_key:
                    existing_names.add(name_key)
                    by_name[name_key] = buyer
                if domain:
                    existing_domains.add(domain)
                    by_domain[domain] = buyer
                from modules.field_clean import (
                    contact_name_dedupe_key,
                    person_email_dedupe_key,
                    person_phone_dedupe_key,
                )

                contact_name_for_key = (raw.get("contact_name") or "").strip()
                has_person = bool(contact_name_dedupe_key(contact_name_for_key))
                for kind, contact_key in _import_contact_duplicate_keys(raw):
                    if kind == "email":
                        if not has_person:
                            by_email[contact_key] = buyer
                        for email_field in ("email", "secondary_email", "contact_email"):
                            combo = person_email_dedupe_key(
                                contact_name_for_key, raw.get(email_field)
                            )
                            if combo:
                                by_person_email[combo] = buyer
                    else:
                        if not has_person:
                            by_phone[contact_key] = buyer
                        for phone_field in (
                            "phone",
                            "primary_phone",
                            "secondary_phone",
                            "secondary_mobile",
                            "contact_phone",
                        ):
                            combo = person_phone_dedupe_key(
                                contact_name_for_key, raw.get(phone_field)
                            )
                            if combo:
                                by_person_phone[combo] = buyer
                existing_scores[buyer.id] = _import_data_score(raw)
                created.append(buyer)
                if persist_each_row:
                    log_action(
                        db,
                        entity_type="buyer",
                        entity_id=buyer.id,
                        action="discovered_import",
                        details={
                            "source": raw.get("source"),
                            "email": _value_or_none(raw.get("email")),
                            "phone": _value_or_none(raw.get("phone")),
                            "facebook_url": _value_or_none(raw.get("facebook_url")),
                            "instagram_url": _value_or_none(raw.get("instagram_url")),
                            "linkedin_url": _value_or_none(raw.get("linkedin_url")),
                            "skip_enrichment": skip_enrichment,
                        },
                    )

                email = _value_or_none(raw.get("email"))
                phone = _value_or_none(raw.get("phone"))
                contact_name = (raw.get("contact_name") or "").strip() or "General contact"
                designation = (raw.get("designation") or "").strip() or None
                secondary_mobile = (raw.get("secondary_mobile") or "").strip() or None
                primary_phone = (raw.get("primary_phone") or "").strip() or None
                secondary_phone = (raw.get("secondary_phone") or "").strip() or None
                secondary_email = (raw.get("secondary_email") or "").strip() or None
                has_contact_details = any(
                    [
                        email,
                        phone,
                        contact_name != "General contact",
                        designation,
                        secondary_mobile,
                        primary_phone,
                        secondary_phone,
                        secondary_email,
                    ]
                )
                if has_contact_details:
                    buyers_module.create_contact(
                        db,
                        {
                            "buyer_id": buyer.id,
                            "full_name": contact_name,
                            "email": email,
                            "phone": phone,
                            "designation": designation,
                            "secondary_mobile": secondary_mobile,
                            "primary_phone": primary_phone,
                            "secondary_phone": secondary_phone,
                            "secondary_email": secondary_email,
                            "linkedin_profile_url": _value_or_none(raw.get("linkedin_url")),
                            "data_source": "discovery",
                            "consent_status": "unknown",
                        },
                        commit=persist_each_row,
                        flush=persist_each_row,
                    )
                    if not persist_each_row:
                        pending_since_flush += 1
                        if pending_since_flush >= FLUSH_EVERY:
                            _flush_pending()

                if auto_onboard:
                    try:
                        onboard = leads_module.onboard_buyer(db, buyer.id)
                        onboard_results.append(
                            {
                                "buyer_id": buyer.id,
                                "company_name": buyer.company_name,
                                "score": onboard.get("score"),
                                "reasoning": onboard.get("reasoning"),
                            }
                        )
                    except Exception as exc:
                        onboard_results.append(
                            {
                                "buyer_id": buyer.id,
                                "company_name": buyer.company_name,
                                "error": str(exc),
                            }
                        )

                _checkpoint_commit()
            except Exception as row_exc:  # noqa: BLE001 — keep importing remaining rows
                if not skip_enrichment:
                    raise
                try:
                    db.rollback()
                except Exception:  # noqa: BLE001
                    pass
                # Drop anything staged after the last successful commit.
                if len(created) > committed_created:
                    del created[committed_created:]
                if len(replaced) > committed_replaced:
                    del replaced[committed_replaced:]
                pending_since_flush = 0
                rows_since_checkpoint = 0
                skipped.append(
                    {
                        "company_name": name or f"(row {row_index + 1})",
                        "reason": f"Row error — {str(row_exc)[:180]}",
                    }
                )
                continue

        # Final report before commit — the job runner shows this as "committing".
        _report_progress(len(candidates), "")

        if skip_enrichment:
            _flush_pending()
            db.commit()
            log_action(
                db,
                entity_type="buyer",
                entity_id=0,
                action="bulk_discovered_import",
                details={
                    "created_count": len(created),
                    "skipped_count": len(skipped),
                    "replaced_count": len(replaced),
                    "skip_enrichment": True,
                },
            )
    except Exception as exc:
        if skip_enrichment:
            # Save whatever was already mapped and staged before the failure
            # instead of discarding the whole import. This only fails (falling
            # back to rollback) if the error itself already poisoned the
            # current DB transaction — in that case at most the rows since the
            # last COMMIT_EVERY checkpoint above are lost, not the whole batch.
            try:
                db.commit()
                committed_created = len(created)
                committed_replaced = len(replaced)
            except Exception:  # noqa: BLE001 — transaction already broken, discard it
                db.rollback()

            # `skipped` never touched the DB, so it's always safe to report in
            # full. `created` / `replaced` are trimmed to what's actually
            # committed so the caller never claims a row was saved when it
            # was rolled back.
            saved_created = created[:committed_created]
            saved_replaced = replaced[:committed_replaced]
            if saved_created or saved_replaced:
                from modules.leads import (
                    invalidate_lead_table_filters_cache,
                    invalidate_section_counts_cache,
                )

                invalidate_lead_table_filters_cache()
                invalidate_section_counts_cache()

            exc.partial_import_result = {  # type: ignore[attr-defined]
                "created_count": len(saved_created),
                "skipped_count": len(skipped),
                "replaced_count": len(saved_replaced),
                "created": saved_created,
                "skipped": skipped,
                "replaced": saved_replaced,
            }
        raise
    finally:
        if skip_enrichment:
            db.expire_on_commit = True

    if created or replaced:
        from modules.leads import invalidate_lead_table_filters_cache, invalidate_section_counts_cache

        invalidate_lead_table_filters_cache()
        invalidate_section_counts_cache()

    skip_reason_counts: dict[str, int] = {}
    for item in skipped:
        reason = (item.get("reason") or "Skipped").strip() or "Skipped"
        skip_reason_counts[reason] = skip_reason_counts.get(reason, 0) + 1

    auto_clean: dict[str, Any] | None = None
    if skip_enrichment and created:
        from modules.post_import_old_clients import (
            clean_contacts_for_buyer_ids,
            normalize_countries_for_buyer_ids,
        )

        buyer_ids = [buyer.id for buyer in created]
        auto_clean = {
            **clean_contacts_for_buyer_ids(db, buyer_ids),
            "countries_normalized": normalize_countries_for_buyer_ids(db, buyer_ids).get(
                "changed", 0
            ),
        }

    return {
        "created_count": len(created),
        "skipped_count": len(skipped),
        "replaced_count": len(replaced),
        "created": created,
        "skipped": skipped,
        "replaced": replaced,
        "onboard_results": onboard_results,
        "skip_reason_counts": skip_reason_counts,
        "auto_clean": auto_clean,
    }
