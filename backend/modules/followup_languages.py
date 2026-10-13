"""Languages for post-call follow-up email/WhatsApp translation.

Keep in sync with AI Sales Agent speaking-language options (plus ja / fil).
"""

from __future__ import annotations

FOLLOWUP_LANGUAGES: dict[str, dict[str, str]] = {
    "en": {
        "code": "en",
        "label": "English (Default)",
        "native": "English",
        "flag": "US",
    },
    "ur": {
        "code": "ur",
        "label": "Urdu (اردو)",
        "native": "Urdu",
        "flag": "PK",
    },
    "fr": {
        "code": "fr",
        "label": "French (Français)",
        "native": "French",
        "flag": "FR",
    },
    "ar": {
        "code": "ar",
        "label": "Arabic (العربية)",
        "native": "Arabic",
        "flag": "SA",
    },
    "de": {
        "code": "de",
        "label": "German (Deutsch)",
        "native": "German",
        "flag": "DE",
    },
    "ru": {
        "code": "ru",
        "label": "Russian (Русский)",
        "native": "Russian",
        "flag": "RU",
    },
    "zh": {
        "code": "zh",
        "label": "Chinese (中文)",
        "native": "Mandarin Chinese",
        "flag": "CN",
    },
    "ja": {
        "code": "ja",
        "label": "Japanese (日本語)",
        "native": "Japanese",
        "flag": "JP",
    },
    "fil": {
        "code": "fil",
        "label": "Filipino / Tagalog (Filipinas)",
        "native": "Filipino (Tagalog)",
        "flag": "PH",
    },
}


def list_followup_languages() -> list[dict[str, str]]:
    return [dict(row) for row in FOLLOWUP_LANGUAGES.values()]


def resolve_followup_language(code: str | None) -> dict[str, str]:
    key = (code or "en").strip().lower()
    if key in ("tl", "tagalog", "philippines", "ph"):
        key = "fil"
    if key in ("jp", "japanese"):
        key = "ja"
    return FOLLOWUP_LANGUAGES.get(key) or FOLLOWUP_LANGUAGES["en"]
