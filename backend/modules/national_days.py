"""Static national day lookup by country (ISO-style country names)."""

NATIONAL_DAYS: dict[str, tuple[int, int, str]] = {
    "UAE": (12, 2, "UAE National Day"),
    "United Arab Emirates": (12, 2, "UAE National Day"),
    "Pakistan": (8, 14, "Pakistan Independence Day"),
    "India": (8, 15, "India Independence Day"),
    "Saudi Arabia": (9, 23, "Saudi National Day"),
    "Qatar": (12, 18, "Qatar National Day"),
    "Kuwait": (2, 25, "Kuwait National Day"),
    "Bahrain": (12, 16, "Bahrain National Day"),
    "Oman": (11, 18, "Oman National Day"),
    "Egypt": (7, 23, "Egypt Revolution Day"),
    "Turkey": (10, 29, "Republic Day"),
    "United Kingdom": (6, 2, "King's Official Birthday (observed)"),
    "USA": (7, 4, "Independence Day"),
    "United States": (7, 4, "Independence Day"),
}


def get_national_day(country: str | None) -> tuple[int, int, str] | None:
    if not country:
        return None
    return NATIONAL_DAYS.get(country.strip())
