"""What is happening on the OTHER end of a browser call.

The dialpad's "Call Connected" only means the browser reached Twilio. The real phone call is a
separate child leg (the <Dial> to the customer) that can be ringing, answered, busy, unanswered or
rejected by the phone network. This asks Twilio (read-only) for that child leg so the dialpad can say
so. It places no calls and changes nothing.
"""

from __future__ import annotations

import re
from typing import Any

from config import settings

_SID = re.compile(r"^CA[0-9a-fA-F]{32}$")

# Twilio child-leg status -> what the dialpad shows
_MAP = {
    "queued": "dialing",
    "initiated": "dialing",
    "ringing": "ringing",
    "in-progress": "answered",
    "busy": "busy",
    "no-answer": "no-answer",
    "failed": "failed",
    "canceled": "ended",
    "completed": "ended",
}


def valid_call_sid(value: str | None) -> bool:
    return bool(value and _SID.match(value))


def leg_status(parent_call_sid: str) -> dict[str, Any]:
    """Status of the newest customer leg under this browser call, plus how many legs were tried."""
    if not valid_call_sid(parent_call_sid):
        raise ValueError("Invalid call id")
    if not (settings.twilio_account_sid and settings.twilio_auth_token):
        return {"status": "unknown", "twilio_status": None, "attempts": 0}

    from twilio.http.http_client import TwilioHttpClient
    from twilio.rest import Client

    client = Client(
        settings.twilio_account_sid,
        settings.twilio_auth_token,
        http_client=TwilioHttpClient(timeout=6),  # never hang a worker on a slow Twilio answer
    )
    children = client.calls.list(parent_call_sid=parent_call_sid, limit=20)
    if not children:
        return {"status": "dialing", "twilio_status": None, "attempts": 0}
    newest = max(children, key=lambda c: c.date_created or c.start_time)
    raw = str(newest.status or "").lower()
    return {"status": _MAP.get(raw, "dialing"), "twilio_status": raw, "attempts": len(children)}
