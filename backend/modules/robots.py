"""Minimal robots.txt check before fetching public websites."""

from __future__ import annotations

from urllib.parse import urlparse
from urllib.robotparser import RobotFileParser

import httpx

USER_AGENT = "KafiSalesAgent/1.0 (lead-research; contact sales@kafi-group.com)"


def can_fetch(url: str, user_agent: str = USER_AGENT) -> bool:
    """Return True if robots.txt permits fetching the URL for our user-agent."""
    try:
        parsed = urlparse(url)
        if not parsed.scheme or not parsed.netloc:
            return False
        robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"
        response = httpx.get(robots_url, timeout=8, follow_redirects=True)
        if response.status_code >= 400:
            return True
        rp = RobotFileParser()
        rp.parse(response.text.splitlines())
        return rp.can_fetch(user_agent, url)
    except (httpx.HTTPError, ValueError):
        return False
