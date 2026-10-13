"""Extract official Facebook, Instagram, and LinkedIn page URLs from website HTML."""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup

from modules.robots import USER_AGENT, can_fetch

_CONTACT_PATHS = ("", "contact", "contact-us", "about", "about-us", "products", "company")


@dataclass
class SocialLinks:
    facebook_url: str | None = None
    instagram_url: str | None = None
    linkedin_url: str | None = None

    def as_dict(self) -> dict[str, str | None]:
        return {
            "facebook_url": self.facebook_url,
            "instagram_url": self.instagram_url,
            "linkedin_url": self.linkedin_url,
        }


def _domain(url: str) -> str:
    try:
        host = urlparse(url).netloc.lower()
        return host[4:] if host.startswith("www.") else host
    except Exception:
        return ""


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


def _is_company_linkedin(url: str | None) -> bool:
    if not url:
        return False
    lowered = url.lower()
    return "/company/" in lowered or "/showcase/" in lowered


def _merge_socials(target: SocialLinks, found: dict[str, str | None]) -> None:
    for key, url in found.items():
        if not url or not str(url).strip():
            continue
        if key == "facebook_url" and not target.facebook_url:
            target.facebook_url = url
        elif key == "instagram_url" and not target.instagram_url:
            target.instagram_url = url
        elif key == "linkedin_url" and not target.linkedin_url:
            if _is_company_linkedin(url):
                target.linkedin_url = url


def extract_social_links_from_html(html: str) -> SocialLinks:
    if not html:
        return SocialLinks()

    soup = BeautifulSoup(html, "html.parser")
    found: dict[str, str] = {}
    for anchor in soup.find_all("a", href=True):
        href = anchor["href"].strip()
        if not href or href.startswith("#"):
            continue
        key = _social_key(href)
        if key and key not in found:
            found[key] = _clean_social_url(href)

    links = SocialLinks()
    _merge_socials(links, found)
    return links


def fetch_social_links_from_website(url: str, *, timeout: float = 10.0) -> SocialLinks:
    homepage = url.strip()
    if not homepage:
        return SocialLinks()
    if not homepage.startswith(("http://", "https://")):
        homepage = f"https://{homepage}"

    links = SocialLinks()
    with httpx.Client(
        timeout=timeout,
        follow_redirects=True,
        headers={"User-Agent": USER_AGENT},
    ) as client:
        for path in _CONTACT_PATHS:
            page_url = urljoin(homepage.rstrip("/") + "/", path.lstrip("/"))
            if not can_fetch(page_url):
                continue
            try:
                response = client.get(page_url)
                response.raise_for_status()
            except httpx.HTTPError:
                continue

            page_links = extract_social_links_from_html(response.text)
            _merge_socials(links, page_links.as_dict())
            if links.facebook_url and links.instagram_url and links.linkedin_url:
                break

    return links


def scrape_social_links(
    website_url: str | None,
    website_html: str | None = None,
) -> SocialLinks:
    links = extract_social_links_from_html(website_html or "")
    if website_url and not all(links.as_dict().values()):
        fetched = fetch_social_links_from_website(website_url)
        _merge_socials(links, fetched.as_dict())
    return links
