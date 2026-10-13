"""Canonical Sara = female, Rayan = male — use everywhere (calls, queue, UI labels)."""

from __future__ import annotations

import re
from typing import Any, Literal

FEMALE_PERSONA = "female"
MALE_PERSONA = "male"
SARA_NAME = "Sara"
RAYAN_NAME = "Rayan"
FEMALE_VOICE = "en-US-Neural2-F"
MALE_VOICE = "en-US-Neural2-D"

_FEMALE_TOKENS = frozenset(
    {"female", "sara", "sarah", "f", "woman", "girl", "lady", "joanna", "jenny"}
)
_MALE_TOKENS = frozenset({"male", "rayan", "ryan", "m", "man", "matthew", "guy", "elliot"})


def _norm(raw: str | None) -> str:
    return (raw or "").strip().lower()


def persona_gender(
    persona: str | None = None,
    *,
    voice_gender: str | None = None,
    gender_label: str | None = None,
    display_name: str | None = None,
    voice: str | None = None,
) -> Literal["female", "male"]:
    """Always map Sara → female and Rayan → male (ids, names, labels, voice ids)."""
    forced = _norm(voice_gender)
    if forced in _FEMALE_TOKENS or "sara" in forced or "fem" in forced:
        return "female"
    if forced in _MALE_TOKENS or "rayan" in forced or forced == "male":
        return "male"

    for candidate in (_norm(persona), _norm(gender_label), _norm(display_name)):
        if not candidate:
            continue
        if candidate in _FEMALE_TOKENS or "sara" in candidate or candidate.startswith("fem"):
            return "female"
        if candidate in _MALE_TOKENS or "rayan" in candidate or candidate == "male":
            return "male"

    voice_s = voice or ""
    if re.search(r"Neural2-F|Jenny|Female|-F\b|Joanna|Salli|Savannah|Rachel", voice_s, re.I):
        return "female"
    if re.search(r"Neural2-D|Neural2-A|Guy|Male|Matthew|Joey|Elliot|Antoni", voice_s, re.I):
        return "male"

    # Protected ids always win even if labels were corrupted.
    pid = _norm(persona)
    if pid == FEMALE_PERSONA:
        return "female"
    if pid == MALE_PERSONA:
        return "male"
    return "male"


def persona_display_name(
    persona: str | None,
    *,
    display_name: str | None = None,
    gender_label: str | None = None,
    voice: str | None = None,
) -> str:
    """Human label: Sara / Rayan for the two core agents; else registry name."""
    pid = _norm(persona)
    if pid == FEMALE_PERSONA or "sara" in pid:
        return SARA_NAME
    if pid == MALE_PERSONA or "rayan" in pid:
        return RAYAN_NAME
    custom = (display_name or "").strip()
    if custom:
        return custom
    gender = persona_gender(
        persona, gender_label=gender_label, display_name=display_name, voice=voice
    )
    return SARA_NAME if gender == "female" else RAYAN_NAME


def persona_voice_id(
    persona: str | None,
    *,
    voice_gender: str | None = None,
    gender_label: str | None = None,
    display_name: str | None = None,
    voice: str | None = None,
) -> str:
    gender = persona_gender(
        persona,
        voice_gender=voice_gender,
        gender_label=gender_label,
        display_name=display_name,
        voice=voice,
    )
    return FEMALE_VOICE if gender == "female" else MALE_VOICE


def enforce_sara_rayan_agent(row: dict[str, Any]) -> dict[str, Any]:
    """Mutate a registry/runner row so Sara/Rayan never lose their gender or voice."""
    aid = str(row.get("id") or row.get("persona") or "").strip()
    name = str(row.get("name") or row.get("display_name") or "").strip()
    name_l = name.lower()
    if aid == FEMALE_PERSONA or name_l in {"sara", "sarah"} or "sara" in name_l:
        row["id"] = row.get("id") or FEMALE_PERSONA
        if "persona" in row:
            row["persona"] = FEMALE_PERSONA
        row["gender_label"] = "female"
        row["voice"] = FEMALE_VOICE
        if not name or name_l in {"sara", "sarah", "female"}:
            if "name" in row or "display_name" not in row:
                row["name"] = row.get("name") or SARA_NAME
            if "display_name" in row:
                row["display_name"] = row.get("display_name") or SARA_NAME
    elif aid == MALE_PERSONA or name_l in {"rayan", "ryan"} or "rayan" in name_l:
        row["id"] = row.get("id") or MALE_PERSONA
        if "persona" in row:
            row["persona"] = MALE_PERSONA
        row["gender_label"] = "male"
        row["voice"] = MALE_VOICE
        if not name or name_l in {"rayan", "ryan", "male"}:
            if "name" in row or "display_name" not in row:
                row["name"] = row.get("name") or RAYAN_NAME
            if "display_name" in row:
                row["display_name"] = row.get("display_name") or RAYAN_NAME
    return row
