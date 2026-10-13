"""Pluggable web-search layer.

Two modes:
- ``search()`` — first provider in WEB_SEARCH_PROVIDERS that returns results (discovery).
- ``search_combined()`` — runs every provider in WEB_SEARCH_COMBINED_PROVIDERS and merges
  results (per-company CSV import / enrichment). Default: serpapi + duckduckgo.

Normalized shapes
-----------------
OrganicResult: {"title": str, "link": str, "snippet": str, "source": str?}
SearchResults:
    organic:        list[OrganicResult]
    knowledge_graph: dict   (title/website/phone/address/description) — may be empty
    local:          list[dict]  (title/phone/address)               — may be empty
    provider:       str    (e.g. "serpapi+duckduckgo")
    messages:       list[str]
"""

from __future__ import annotations

import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Any, Callable
from urllib.parse import urlparse

import httpx

from config import settings

# Fallback chain for market discovery (first hit wins).
_DEFAULT_ORDER = ("serpapi", "duckduckgo", "google_cse", "wikidata")
# Per-record enrichment merges these in parallel. Wikidata also runs as a dedicated
# name lookup inside lead_discovery (more accurate than query-string search).
_DEFAULT_COMBINED = ("serpapi", "duckduckgo", "google_cse")
# Keep provider HTTP calls short so enrichment cannot freeze the API worker.
_HTTP_TIMEOUT = 8.0
_COMBINED_PROVIDER_TIMEOUT = 12.0


@dataclass
class SearchResults:
    organic: list[dict[str, str]] = field(default_factory=list)
    knowledge_graph: dict[str, Any] = field(default_factory=dict)
    local: list[dict[str, Any]] = field(default_factory=list)
    provider: str | None = None
    messages: list[str] = field(default_factory=list)

    def is_empty(self) -> bool:
        return not self.organic and not self.knowledge_graph and not self.local


def _provider_order() -> list[str]:
    raw = getattr(settings, "web_search_providers", None)
    if not raw:
        return list(_DEFAULT_ORDER)
    order = [p.strip().lower() for p in raw.split(",") if p.strip()]
    return order or list(_DEFAULT_ORDER)


def _combined_providers() -> list[str]:
    raw = getattr(settings, "web_search_combined_providers", None)
    if raw is None:
        return list(_DEFAULT_COMBINED)
    order = [p.strip().lower() for p in raw.split(",") if p.strip()]
    return order or list(_DEFAULT_COMBINED)


def _normalize_link_key(link: str) -> str:
    try:
        parsed = urlparse(link.strip())
        host = parsed.netloc.lower()
        if host.startswith("www."):
            host = host[4:]
        path = parsed.path.rstrip("/").lower()
        return f"{host}{path}"
    except ValueError:
        return link.strip().lower().rstrip("/")


def _gl_to_region(gl_code: str | None) -> str | None:
    """Map a 2-letter Google gl code to a DuckDuckGo/brave region hint."""
    if not gl_code:
        return None
    return f"{gl_code.lower()}-{gl_code.lower()}"


# --------------------------------------------------------------------------- #
# SerpAPI multi-key rotation
# --------------------------------------------------------------------------- #


def _serpapi_configured_keys() -> list[str]:
    """Collect unique keys from SERPAPI_API_KEY + SERPAPI_API_KEY."""
    keys: list[str] = []
    seen: set[str] = set()
    for raw in (
        getattr(settings, "serpapi_api_key", None),
        getattr(settings, "serpapi_api_keys", None),
    ):
        if not raw:
            continue
        for part in str(raw).split(","):
            key = part.strip()
            if key and key not in seen:
                seen.add(key)
                keys.append(key)
    return keys


_QUOTA_ERROR_RE = re.compile(
    r"(ran out of searches|out of searches|monthly searches|"
    r"your account has run out|limit.*search|quota|too many requests)",
    re.I,
)


class _SerpApiKeyPool:
    """Rotate SerpAPI keys when monthly/hourly quota is exhausted.

    Preference order: configured key order (primary first). When a key returns
    429 / quota errors it is marked exhausted until account.json shows searches
    left again (checked on a cooldown), then the pool prefers the first healthy
    key — so it naturally switches back after monthly reset.
    """

    _RECHECK_SECONDS = 30 * 60  # re-check exhausted keys via account API every 30m

    def __init__(self) -> None:
        self._lock = threading.Lock()
        # key -> unix timestamp when we may re-check account.json
        self._exhausted_until: dict[str, float] = {}

    def available(self) -> bool:
        return bool(_serpapi_configured_keys())

    def _account_has_searches(self, api_key: str) -> bool | None:
        """Return True/False from account.json, or None if the check failed."""
        try:
            response = httpx.get(
                "https://serpapi.com/account.json",
                params={"api_key": api_key},
                timeout=_HTTP_TIMEOUT,
            )
            if response.status_code >= 400:
                return None
            data = response.json()
            left = data.get("total_searches_left")
            if left is None:
                left = data.get("plan_searches_left")
            if left is None:
                return None
            return int(left) > 0
        except Exception:
            return None

    def _is_usable(self, api_key: str, *, now: float) -> bool:
        until = self._exhausted_until.get(api_key)
        if until is None:
            return True
        if now < until:
            return False
        # Cooldown elapsed — ask SerpAPI if the key recovered (monthly reset).
        # Do the HTTP check outside the lock.
        return True  # tentatively; acquire() re-validates

    def _revalidate_exhausted(self, api_key: str) -> bool:
        """Return True if an exhausted key has searches again."""
        status = self._account_has_searches(api_key)
        now = time.time()
        with self._lock:
            if status is True:
                self._exhausted_until.pop(api_key, None)
                return True
            if status is False:
                self._exhausted_until[api_key] = now + self._RECHECK_SECONDS
                return False
            # Unknown — allow one live attempt.
            self._exhausted_until.pop(api_key, None)
            return True

    def acquire(self) -> str | None:
        keys = _serpapi_configured_keys()
        if not keys:
            return None
        now = time.time()
        candidates: list[tuple[str, bool]] = []
        with self._lock:
            for key in keys:
                until = self._exhausted_until.get(key)
                if until is None:
                    candidates.append((key, False))
                elif now >= until:
                    candidates.append((key, True))
            if not candidates:
                return keys[0]

        for key, needs_revalidate in candidates:
            if needs_revalidate and not self._revalidate_exhausted(key):
                continue
            return key
        return keys[0]

    def mark_exhausted(self, api_key: str, *, retry_after_seconds: float | None = None) -> None:
        wait = float(retry_after_seconds) if retry_after_seconds and retry_after_seconds > 0 else self._RECHECK_SECONDS
        with self._lock:
            self._exhausted_until[api_key] = time.time() + wait

    def mark_ok(self, api_key: str) -> None:
        with self._lock:
            self._exhausted_until.pop(api_key, None)

    def status_summary(self) -> dict[str, Any]:
        keys = _serpapi_configured_keys()
        now = time.time()
        with self._lock:
            exhausted = [
                i
                for i, k in enumerate(keys)
                if k in self._exhausted_until and self._exhausted_until[k] > now
            ]
            active = next(
                (
                    i
                    for i, k in enumerate(keys)
                    if k not in self._exhausted_until or self._exhausted_until[k] <= now
                ),
                None,
            )
            return {
                "configured_keys": len(keys),
                "active_key_index": active,
                "exhausted_count": len(exhausted),
            }


_serpapi_key_pool = _SerpApiKeyPool()


def _serpapi_quota_error(message: str | None = None, status_code: int | None = None) -> bool:
    if status_code == 429:
        return True
    if message and _QUOTA_ERROR_RE.search(message):
        return True
    return False


def _parse_retry_after(response: httpx.Response | None) -> float | None:
    if response is None:
        return None
    raw = response.headers.get("Retry-After")
    if not raw:
        return None
    try:
        return float(raw)
    except ValueError:
        return None


# --------------------------------------------------------------------------- #
# Providers
# --------------------------------------------------------------------------- #
def _search_serpapi_with_key(
    query: str,
    *,
    num: int,
    gl_code: str | None,
    api_key: str,
) -> tuple[SearchResults, bool, float | None]:
    """Run one SerpAPI search. Returns (results, quota_exhausted, retry_after)."""
    results = SearchResults(provider="serpapi")
    params: dict[str, str | int] = {
        "engine": "google",
        "q": query,
        "api_key": api_key,
        "num": num,
    }
    if gl_code:
        params["gl"] = gl_code

    try:
        response = httpx.get(
            "https://serpapi.com/search.json", params=params, timeout=_HTTP_TIMEOUT
        )
    except httpx.HTTPError as exc:
        results.messages.append(f"SerpAPI request failed: {exc}")
        return results, False, None

    if response.status_code == 429:
        results.messages.append(
            f"SerpAPI request failed: Client error '429 Too Many Requests'"
        )
        return results, True, _parse_retry_after(response)

    if response.status_code >= 400:
        results.messages.append(
            f"SerpAPI request failed: Client error '{response.status_code}'"
        )
        # Some quota messages come back as 400/401 with an error body.
        try:
            err = (response.json() or {}).get("error")
        except Exception:
            err = None
        exhausted = _serpapi_quota_error(str(err) if err else response.text, response.status_code)
        if err:
            results.messages.append(f"SerpAPI error: {err}")
        return results, exhausted, _parse_retry_after(response)

    try:
        data = response.json()
    except Exception as exc:
        results.messages.append(f"SerpAPI invalid JSON: {exc}")
        return results, False, None

    if err := data.get("error"):
        results.messages.append(f"SerpAPI error: {err}")
        return results, _serpapi_quota_error(str(err)), None

    for item in data.get("organic_results", []) or []:
        results.organic.append(
            {
                "title": item.get("title") or "",
                "link": item.get("link") or "",
                "snippet": item.get("snippet") or "",
            }
        )

    kg = data.get("knowledge_graph") or {}
    if kg:
        results.knowledge_graph = {
            "title": kg.get("title"),
            "website": kg.get("website"),
            "phone": kg.get("phone"),
            "address": kg.get("address"),
            "description": kg.get("description"),
        }

    local = data.get("local_results")
    places: list[dict] = []
    if isinstance(local, dict):
        places = local.get("places") or []
    elif isinstance(local, list):
        places = local
    for place in places:
        results.local.append(
            {
                "title": place.get("title"),
                "phone": place.get("phone"),
                "address": place.get("address"),
            }
        )

    return results, False, None


def _search_serpapi(query: str, *, num: int, gl_code: str | None) -> SearchResults:
    """Search via SerpAPI, rotating to the next key when quota is exhausted."""
    keys = _serpapi_configured_keys()
    if not keys:
        return SearchResults(provider="serpapi")

    tried: set[str] = set()
    merged_messages: list[str] = []

    for _ in range(len(keys)):
        api_key = _serpapi_key_pool.acquire()
        if not api_key or api_key in tried:
            break
        tried.add(api_key)
        key_index = keys.index(api_key) + 1
        results, exhausted, retry_after = _search_serpapi_with_key(
            query, num=num, gl_code=gl_code, api_key=api_key
        )
        if exhausted:
            _serpapi_key_pool.mark_exhausted(api_key, retry_after_seconds=retry_after)
            merged_messages.extend(results.messages)
            merged_messages.append(
                f"SerpAPI key #{key_index} exhausted — switching to next key if available"
            )
            continue

        if not results.is_empty():
            _serpapi_key_pool.mark_ok(api_key)
            if len(keys) > 1:
                results.messages.append(f"SerpAPI using key #{key_index} of {len(keys)}")
            results.messages = merged_messages + results.messages
            return results

        # Soft failure (empty / other error) — don't burn the rest of the keys
        # unless it looked like a quota problem (already handled above).
        results.messages = merged_messages + results.messages
        return results

    empty = SearchResults(provider="serpapi", messages=merged_messages)
    if not empty.messages:
        empty.messages.append("SerpAPI: all configured keys exhausted or unavailable")
    return empty


def _search_brave(query: str, *, num: int, gl_code: str | None) -> SearchResults:
    results = SearchResults(provider="brave")
    api_key = getattr(settings, "brave_api_key", None)
    if not api_key:
        return results

    params: dict[str, str | int] = {"q": query, "count": min(num, 20)}
    if gl_code:
        params["country"] = gl_code.upper()

    try:
        response = httpx.get(
            "https://api.search.brave.com/res/v1/web/search",
            params=params,
            headers={
                "Accept": "application/json",
                "X-Subscription-Token": api_key,
            },
            timeout=_HTTP_TIMEOUT,
        )
        response.raise_for_status()
        data = response.json()
    except httpx.HTTPError as exc:
        results.messages.append(f"Brave request failed: {exc}")
        return results

    web = (data.get("web") or {}).get("results", []) or []
    for item in web:
        results.organic.append(
            {
                "title": item.get("title") or "",
                "link": item.get("url") or "",
                "snippet": item.get("description") or "",
            }
        )

    return results


def _search_google_cse(query: str, *, num: int, gl_code: str | None) -> SearchResults:
    results = SearchResults(provider="google_cse")
    api_key = getattr(settings, "google_cse_api_key", None)
    engine_id = getattr(settings, "google_cse_engine_id", None)
    if not api_key or not engine_id:
        return results

    params: dict[str, str | int] = {
        "key": api_key,
        "cx": engine_id,
        "q": query,
        "num": min(num, 10),
    }
    if gl_code:
        params["gl"] = gl_code.lower()

    try:
        response = httpx.get(
            "https://www.googleapis.com/customsearch/v1", params=params, timeout=_HTTP_TIMEOUT
        )
        response.raise_for_status()
        data = response.json()
    except httpx.HTTPError as exc:
        results.messages.append(f"Google CSE request failed: {exc}")
        return results

    if err := data.get("error"):
        message = err.get("message") if isinstance(err, dict) else str(err)
        results.messages.append(f"Google CSE error: {message}")
        return results

    for item in data.get("items", []) or []:
        results.organic.append(
            {
                "title": item.get("title") or "",
                "link": item.get("link") or "",
                "snippet": item.get("snippet") or "",
            }
        )

    return results


def _search_duckduckgo(query: str, *, num: int, gl_code: str | None) -> SearchResults:
    results = SearchResults(provider="duckduckgo")
    try:
        from ddgs import DDGS
    except ImportError:
        results.messages.append("ddgs package not installed — run pip install ddgs")
        return results

    region = _gl_to_region(gl_code) or "wt-wt"
    try:
        with DDGS() as ddgs:
            hits = ddgs.text(query, region=region, max_results=min(num, 20))
            for item in hits or []:
                results.organic.append(
                    {
                        "title": item.get("title") or "",
                        "link": item.get("href") or item.get("url") or "",
                        "snippet": item.get("body") or "",
                    }
                )
    except Exception as exc:  # ddgs raises assorted network/ratelimit errors
        results.messages.append(f"DuckDuckGo request failed: {exc}")

    return results


def _search_wikidata(query: str, *, num: int, gl_code: str | None) -> SearchResults:
    """Resolve company websites/socials via Wikidata search + SPARQL claims."""
    results = SearchResults(provider="wikidata")
    # Queries are often '"Acme Foods" UAE' — strip quotes and keep the company phrase.
    cleaned = (query or "").replace('"', " ").strip()
    if not cleaned:
        return results

    # Prefer leading phrase before a regional qualifier when present.
    company_name = cleaned.split(",")[0].strip()
    for token in (" official website", " company website", " website"):
        if company_name.lower().endswith(token):
            company_name = company_name[: -len(token)].strip()

    try:
        from modules.company_enrichment import lookup_wikidata_company
    except Exception as exc:
        results.messages.append(f"Wikidata helper unavailable: {exc}")
        return results

    # gl_code is unused; country may still be embedded in the query string.
    country = None
    parts = cleaned.split()
    if len(parts) >= 2:
        # Last token as soft country hint when it looks like a word.
        maybe_country = parts[-1]
        if maybe_country.isalpha() and len(maybe_country) >= 2:
            country = maybe_country

    found = lookup_wikidata_company(company_name, country)
    if not found.get("website") and not found.get("linkedin_url"):
        if found.get("source_detail") is None:
            results.messages.append("Wikidata returned no matching company website.")
        return results

    label = found.get("label") or company_name
    website = found.get("website") or ""
    social_bits = [
        found.get("linkedin_url"),
        found.get("facebook_url"),
        found.get("instagram_url"),
    ]
    snippet_parts = [bit for bit in social_bits if bit]
    results.organic.append(
        {
            "title": f"{label} (Wikidata)",
            "link": website or (found.get("linkedin_url") or ""),
            "snippet": " · ".join(snippet_parts) or "Official company record on Wikidata",
            "source": "wikidata",
        }
    )
    results.knowledge_graph = {
        "title": label,
        "website": website or None,
        "phone": None,
        "address": None,
        "description": "Wikidata SPARQL company record",
        "linkedin_url": found.get("linkedin_url"),
        "facebook_url": found.get("facebook_url"),
        "instagram_url": found.get("instagram_url"),
    }
    return results


_PROVIDERS: dict[str, Callable[..., SearchResults]] = {
    "serpapi": _search_serpapi,
    "brave": _search_brave,
    "google_cse": _search_google_cse,
    "duckduckgo": _search_duckduckgo,
    "wikidata": _search_wikidata,
}


def provider_available(name: str) -> bool:
    if name == "serpapi":
        return _serpapi_key_pool.available()
    if name == "brave":
        return bool(getattr(settings, "brave_api_key", None))
    if name == "google_cse":
        return bool(
            getattr(settings, "google_cse_api_key", None)
            and getattr(settings, "google_cse_engine_id", None)
        )
    if name == "duckduckgo":
        try:
            import ddgs  # noqa: F401

            return True
        except ImportError:
            return False
    if name == "wikidata":
        return True
    return False


def any_provider_available() -> bool:
    return any(provider_available(name) for name in _provider_order())


def any_combined_provider_available() -> bool:
    return any(provider_available(name) for name in _combined_providers())


def search_combined(
    query: str,
    *,
    num: int = 10,
    gl_code: str | None = None,
) -> SearchResults:
    """Run every configured combined provider in parallel and merge results.

    Used for per-company enrichment so SerpAPI, DuckDuckGo, Google CSE, and Wikidata
    all contribute without blocking the API for tens of seconds sequentially.
    """
    names = [n for n in _combined_providers() if provider_available(n)]
    if not names:
        return search(query, num=num, gl_code=gl_code)

    merged = SearchResults()
    used: list[str] = []
    messages: list[str] = []
    seen_organic: set[str] = set()
    seen_local: set[str] = set()

    def _run(name: str) -> tuple[str, SearchResults]:
        provider_fn = _PROVIDERS.get(name)
        if not provider_fn:
            empty = SearchResults(provider=name)
            empty.messages.append(f"Unknown provider: {name}")
            return name, empty
        return name, provider_fn(query, num=num, gl_code=gl_code)

    provider_results: list[tuple[str, SearchResults]] = []
    with ThreadPoolExecutor(max_workers=max(1, len(names))) as pool:
        futures = {pool.submit(_run, name): name for name in names}
        try:
            for future in as_completed(futures, timeout=_COMBINED_PROVIDER_TIMEOUT):
                try:
                    provider_results.append(future.result())
                except Exception as exc:
                    name = futures[future]
                    failed = SearchResults(provider=name)
                    failed.messages.append(f"{name} failed: {exc}")
                    provider_results.append((name, failed))
        except TimeoutError:
            messages.append("Combined search timed out waiting for some providers.")
            for future, name in futures.items():
                if future.done():
                    try:
                        provider_results.append(future.result())
                    except Exception as exc:
                        failed = SearchResults(provider=name)
                        failed.messages.append(f"{name} failed: {exc}")
                        provider_results.append((name, failed))
                else:
                    future.cancel()
                    messages.append(f"{name} skipped after timeout.")

    # Preserve configured provider order when merging.
    order = {name: index for index, name in enumerate(names)}
    provider_results.sort(key=lambda item: order.get(item[0], 999))

    for name, result in provider_results:
        messages.extend(result.messages)
        if result.is_empty():
            continue
        used.append(name)

        if not merged.knowledge_graph and result.knowledge_graph:
            merged.knowledge_graph = dict(result.knowledge_graph)
        elif result.knowledge_graph:
            for key, value in result.knowledge_graph.items():
                if value and not merged.knowledge_graph.get(key):
                    merged.knowledge_graph[key] = value

        for place in result.local:
            key = f"{place.get('title') or ''}|{place.get('phone') or ''}"
            if key in seen_local:
                continue
            seen_local.add(key)
            merged.local.append(place)

        for item in result.organic:
            link = item.get("link") or ""
            key = _normalize_link_key(link) if link else ""
            if not key or key in seen_organic:
                continue
            seen_organic.add(key)
            merged.organic.append(
                {
                    "title": item.get("title") or "",
                    "link": link,
                    "snippet": item.get("snippet") or "",
                    "source": name,
                }
            )

    merged.provider = "+".join(used) if used else None
    merged.messages = messages
    if not merged.is_empty():
        return merged

    fallback = SearchResults(messages=messages or ["Combined search returned no results."])
    return fallback


def search(
    query: str,
    *,
    num: int = 10,
    gl_code: str | None = None,
) -> SearchResults:
    """Run a web search through the first available provider that returns results.

    Falls through the provider order until one yields organic/knowledge/local data.
    Collects messages from every attempted provider for diagnostics.
    """
    messages: list[str] = []
    last: SearchResults | None = None

    for name in _provider_order():
        provider = _PROVIDERS.get(name)
        if not provider or not provider_available(name):
            continue
        result = provider(query, num=num, gl_code=gl_code)
        messages.extend(result.messages)
        last = result
        if not result.is_empty():
            result.messages = messages
            return result

    fallback = last or SearchResults()
    fallback.messages = messages or ["No web-search provider is configured."]
    return fallback
