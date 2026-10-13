"""Structured company enrichment helpers (Wikidata SPARQL + CompanyLens).

These fill website / social / contact gaps that SERP organics often miss.
Used by lead_discovery enrichment and Research & Score (onboard).
"""

from __future__ import annotations

import logging
from typing import Any
from urllib.parse import quote, urlparse

import httpx

from config import settings

logger = logging.getLogger(__name__)

_WIKIDATA_SPARQL = "https://query.wikidata.org/sparql"
_WIKIDATA_SEARCH = "https://www.wikidata.org/w/api.php"
_COMPANYLENS_URL = "https://companylens.dev/api/enrich"
_USER_AGENT = (
    "KafiSalesAgent/1.0 (https://github.com/izoo2003/Kafi-Sales-Agent; "
    "lead-research; mailto:bot-traffic@wikimedia.org)"
)
_HTTP_TIMEOUT = 8.0


def _homepage(url: str | None) -> str | None:
    if not url:
        return None
    try:
        parsed = urlparse(url if "://" in url else f"https://{url}")
        if not parsed.netloc:
            return None
        return f"{parsed.scheme or 'https'}://{parsed.netloc}"
    except ValueError:
        return None


def _domain(url: str | None) -> str | None:
    homepage = _homepage(url)
    if not homepage:
        return None
    host = urlparse(homepage).netloc.lower()
    return host[4:] if host.startswith("www.") else host


def _normalize_name(name: str) -> str:
    return "".join(ch for ch in name.lower() if ch.isalnum())


def _names_close(a: str | None, b: str | None) -> bool:
    left = _normalize_name(a or "")
    right = _normalize_name(b or "")
    if not left or not right:
        return False
    return left in right or right in left


def _linkedin_url(identifier: str | None) -> str | None:
    if not identifier:
        return None
    value = identifier.strip()
    if not value:
        return None
    if value.startswith("http"):
        return value
    return f"https://www.linkedin.com/company/{quote(value.strip('/'))}"


def _facebook_url(identifier: str | None) -> str | None:
    if not identifier:
        return None
    value = identifier.strip()
    if not value:
        return None
    if value.startswith("http"):
        return value
    return f"https://www.facebook.com/{quote(value.strip('/'))}"


def _instagram_url(identifier: str | None) -> str | None:
    if not identifier:
        return None
    value = identifier.strip()
    if not value:
        return None
    if value.startswith("http"):
        return value
    return f"https://www.instagram.com/{quote(value.strip('/'))}"


def search_wikidata_entities(company_name: str, *, limit: int = 5) -> list[dict[str, str]]:
    """Find Wikidata entity IDs for a company name (MediaWiki search)."""
    name = (company_name or "").strip()
    if len(name) < 2:
        return []
    try:
        response = httpx.get(
            _WIKIDATA_SEARCH,
            params={
                "action": "wbsearchentities",
                "search": name,
                "language": "en",
                "type": "item",
                "limit": limit,
                "format": "json",
            },
            headers={"User-Agent": _USER_AGENT},
            timeout=_HTTP_TIMEOUT,
        )
        response.raise_for_status()
        data = response.json()
    except Exception as exc:
        logger.info("Wikidata search failed: %s", exc)
        return []

    hits: list[dict[str, str]] = []
    for item in data.get("search") or []:
        qid = item.get("id") or ""
        label = item.get("label") or ""
        if not qid:
            continue
        hits.append(
            {
                "id": qid,
                "label": label,
                "description": item.get("description") or "",
            }
        )
    return hits


def fetch_wikidata_claims_sparql(entity_ids: list[str]) -> list[dict[str, Any]]:
    """Pull official website + social claims via Wikidata SPARQL for known QIDs."""
    ids = [eid.strip().upper() for eid in entity_ids if eid and eid.upper().startswith("Q")]
    if not ids:
        return []

    values = " ".join(f"wd:{qid}" for qid in ids[:8])
    query = f"""
    SELECT ?item ?itemLabel ?website ?linkedin ?facebook ?instagram WHERE {{
      VALUES ?item {{ {values} }}
      OPTIONAL {{ ?item wdt:P856 ?website . }}
      OPTIONAL {{ ?item wdt:P4264 ?linkedin . }}
      OPTIONAL {{ ?item wdt:P2013 ?facebook . }}
      OPTIONAL {{ ?item wdt:P2003 ?instagram . }}
      SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }}
    }}
    """
    try:
        response = httpx.get(
            _WIKIDATA_SPARQL,
            params={"format": "json", "query": query},
            headers={"User-Agent": _USER_AGENT, "Accept": "application/sparql-results+json"},
            timeout=_HTTP_TIMEOUT,
        )
        response.raise_for_status()
        data = response.json()
    except Exception as exc:
        logger.info("Wikidata SPARQL failed: %s", exc)
        return []

    rows: list[dict[str, Any]] = []
    for binding in (data.get("results") or {}).get("bindings") or []:
        def _val(key: str) -> str | None:
            cell = binding.get(key) or {}
            value = cell.get("value")
            return str(value).strip() if value else None

        item_uri = _val("item") or ""
        qid = item_uri.rsplit("/", 1)[-1] if item_uri else None
        rows.append(
            {
                "id": qid,
                "label": _val("itemLabel"),
                "website": _homepage(_val("website")),
                "linkedin_url": _linkedin_url(_val("linkedin")),
                "facebook_url": _facebook_url(_val("facebook")),
                "instagram_url": _instagram_url(_val("instagram")),
            }
        )
    return rows


def lookup_wikidata_company(
    company_name: str,
    country: str | None = None,
) -> dict[str, str | None]:
    """Resolve company website/socials via Wikidata search + SPARQL claims."""
    result: dict[str, str | None] = {
        "website": None,
        "linkedin_url": None,
        "facebook_url": None,
        "instagram_url": None,
        "label": None,
        "source_detail": None,
    }
    hits = search_wikidata_entities(company_name, limit=5)
    if not hits:
        return result

    # Prefer label-close matches; keep description mention of country as a weak bonus.
    ranked: list[tuple[int, dict[str, str]]] = []
    country_hint = (country or "").strip().lower()
    for hit in hits:
        score = 0
        if _names_close(company_name, hit.get("label")):
            score += 50
        if _normalize_name(company_name) == _normalize_name(hit.get("label") or ""):
            score += 40
        desc = (hit.get("description") or "").lower()
        if country_hint and country_hint in desc:
            score += 10
        if "company" in desc or "business" in desc or "importer" in desc or "exporter" in desc:
            score += 5
        ranked.append((score, hit))
    ranked.sort(key=lambda item: item[0], reverse=True)
    if not ranked or ranked[0][0] < 50:
        return result

    top_ids = [hit["id"] for _, hit in ranked[:3]]
    claims = fetch_wikidata_claims_sparql(top_ids)
    for claim in claims:
        if not _names_close(company_name, claim.get("label")):
            continue
        if claim.get("website"):
            result["website"] = claim["website"]
            result["label"] = claim.get("label")
            result["linkedin_url"] = claim.get("linkedin_url")
            result["facebook_url"] = claim.get("facebook_url")
            result["instagram_url"] = claim.get("instagram_url")
            result["source_detail"] = "Wikidata SPARQL"
            return result

    # Fall back to best claim row even if label fuzzy (still from name search).
    for claim in claims:
        if claim.get("website"):
            result["website"] = claim["website"]
            result["label"] = claim.get("label")
            result["linkedin_url"] = claim.get("linkedin_url")
            result["facebook_url"] = claim.get("facebook_url")
            result["instagram_url"] = claim.get("instagram_url")
            result["source_detail"] = "Wikidata SPARQL"
            break
    return result


def companylens_available() -> bool:
    return bool(getattr(settings, "companylens_api_key", None))


def enrich_domain_companylens(domain_or_url: str) -> dict[str, Any]:
    """Enrich a known domain via CompanyLens (socials, contacts, firmographics)."""
    result: dict[str, Any] = {
        "website": None,
        "phone": None,
        "email": None,
        "linkedin_url": None,
        "facebook_url": None,
        "instagram_url": None,
        "name": None,
        "industry": None,
        "source_detail": None,
        "messages": [],
    }
    api_key = getattr(settings, "companylens_api_key", None)
    if not api_key:
        result["messages"].append("CompanyLens API key not configured.")
        return result

    domain = _domain(domain_or_url) or (domain_or_url or "").strip().lower()
    if domain.startswith("www."):
        domain = domain[4:]
    if not domain or "." not in domain:
        result["messages"].append("CompanyLens needs a valid domain.")
        return result

    try:
        response = httpx.get(
            _COMPANYLENS_URL,
            params={"domain": domain},
            headers={
                "Accept": "application/json",
                "X-API-Key": api_key,
                "Authorization": f"Bearer {api_key}",
                "User-Agent": _USER_AGENT,
            },
            timeout=_HTTP_TIMEOUT,
        )
        if response.status_code == 401 or response.status_code == 403:
            result["messages"].append("CompanyLens authentication failed — check COMPANYLENS_API_KEY.")
            return result
        if response.status_code == 404:
            result["messages"].append(f"CompanyLens has no profile for {domain}.")
            return result
        response.raise_for_status()
        data = response.json()
    except Exception as exc:
        result["messages"].append(f"CompanyLens request failed: {exc}")
        return result

    if not isinstance(data, dict):
        result["messages"].append("CompanyLens returned an unexpected payload.")
        return result

    # Support a few observed response shapes from companylens.dev docs.
    social = data.get("social") if isinstance(data.get("social"), dict) else {}
    contacts = data.get("contacts") if isinstance(data.get("contacts"), dict) else {}

    result["name"] = data.get("name") or data.get("company_name")
    result["industry"] = data.get("industry")
    result["website"] = _homepage(
        data.get("website")
        or data.get("website_url")
        or data.get("domain")
        or f"https://{domain}"
    )
    result["phone"] = (
        data.get("company_phone")
        or data.get("phone")
        or contacts.get("phone")
        or None
    )
    result["email"] = (
        data.get("company_email")
        or data.get("email")
        or contacts.get("email")
        or None
    )

    linkedin = social.get("linkedin") or data.get("linkedin") or data.get("linkedin_url")
    facebook = social.get("facebook") or data.get("facebook") or data.get("facebook_url")
    instagram = social.get("instagram") or data.get("instagram") or data.get("instagram_url")
    twitter = social.get("twitter") or data.get("twitter")

    result["linkedin_url"] = _linkedin_url(linkedin) if linkedin else None
    result["facebook_url"] = _facebook_url(facebook) if facebook else None
    result["instagram_url"] = _instagram_url(instagram) if instagram else None
    if not result["facebook_url"] and twitter and "facebook" in str(twitter).lower():
        result["facebook_url"] = _facebook_url(twitter)

    result["source_detail"] = "CompanyLens"
    return result
