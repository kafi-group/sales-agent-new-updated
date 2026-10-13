"""Call-time recommendation based on the buyer's country local time.

Kafi's reps place international calls, so we surface whether "now" falls
inside normal business hours (10 AM - 5 PM) in the buyer's country, using
each country's canonical/primary IANA timezone. Large multi-timezone
countries (US, Russia, Canada, Australia, Brazil, Indonesia, ...) use one
representative business-hub timezone rather than every internal zone.
"""

from __future__ import annotations

from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from modules.countries import resolve_country_name

CALL_WINDOW_START_HOUR = 10
CALL_WINDOW_END_HOUR = 17  # 5 PM, exclusive

# Canonical country name (as returned by modules.countries.resolve_country_name)
# -> representative IANA timezone.
COUNTRY_TIMEZONES: dict[str, str] = {
    "Afghanistan": "Asia/Kabul",
    "Albania": "Europe/Tirane",
    "Algeria": "Africa/Algiers",
    "Andorra": "Europe/Andorra",
    "Angola": "Africa/Luanda",
    "Antigua and Barbuda": "America/Antigua",
    "Argentina": "America/Argentina/Buenos_Aires",
    "Armenia": "Asia/Yerevan",
    "Australia": "Australia/Sydney",
    "Austria": "Europe/Vienna",
    "Azerbaijan": "Asia/Baku",
    "Bahamas": "America/Nassau",
    "Bahrain": "Asia/Bahrain",
    "Bangladesh": "Asia/Dhaka",
    "Barbados": "America/Barbados",
    "Belarus": "Europe/Minsk",
    "Belgium": "Europe/Brussels",
    "Belize": "America/Belize",
    "Benin": "Africa/Porto-Novo",
    "Bhutan": "Asia/Thimphu",
    "Bolivia": "America/La_Paz",
    "Bosnia and Herzegovina": "Europe/Sarajevo",
    "Botswana": "Africa/Gaborone",
    "Brazil": "America/Sao_Paulo",
    "Brunei": "Asia/Brunei",
    "Bulgaria": "Europe/Sofia",
    "Burkina Faso": "Africa/Ouagadougou",
    "Burundi": "Africa/Bujumbura",
    "Cabo Verde": "Atlantic/Cape_Verde",
    "Cambodia": "Asia/Phnom_Penh",
    "Cameroon": "Africa/Douala",
    "Canada": "America/Toronto",
    "Central African Republic": "Africa/Bangui",
    "Chad": "Africa/Ndjamena",
    "Chile": "America/Santiago",
    "China": "Asia/Shanghai",
    "Colombia": "America/Bogota",
    "Comoros": "Indian/Comoro",
    "Congo": "Africa/Brazzaville",
    "Costa Rica": "America/Costa_Rica",
    "Croatia": "Europe/Zagreb",
    "Cuba": "America/Havana",
    "Cyprus": "Asia/Nicosia",
    "Czechia": "Europe/Prague",
    "Democratic Republic of the Congo": "Africa/Kinshasa",
    "Denmark": "Europe/Copenhagen",
    "Djibouti": "Africa/Djibouti",
    "Dominica": "America/Dominica",
    "Dominican Republic": "America/Santo_Domingo",
    "Ecuador": "America/Guayaquil",
    "Egypt": "Africa/Cairo",
    "El Salvador": "America/El_Salvador",
    "Equatorial Guinea": "Africa/Malabo",
    "Eritrea": "Africa/Asmara",
    "Estonia": "Europe/Tallinn",
    "Eswatini": "Africa/Mbabane",
    "Ethiopia": "Africa/Addis_Ababa",
    "Fiji": "Pacific/Fiji",
    "Finland": "Europe/Helsinki",
    "France": "Europe/Paris",
    "Gabon": "Africa/Libreville",
    "Gambia": "Africa/Banjul",
    "Georgia": "Asia/Tbilisi",
    "Germany": "Europe/Berlin",
    "Ghana": "Africa/Accra",
    "Greece": "Europe/Athens",
    "Grenada": "America/Grenada",
    "Guatemala": "America/Guatemala",
    "Guinea": "Africa/Conakry",
    "Guinea-Bissau": "Africa/Bissau",
    "Guyana": "America/Guyana",
    "Haiti": "America/Port-au-Prince",
    "Honduras": "America/Tegucigalpa",
    "Hong Kong": "Asia/Hong_Kong",
    "Hungary": "Europe/Budapest",
    "Iceland": "Atlantic/Reykjavik",
    "India": "Asia/Kolkata",
    "Indonesia": "Asia/Jakarta",
    "Iran": "Asia/Tehran",
    "Iraq": "Asia/Baghdad",
    "Ireland": "Europe/Dublin",
    "Israel": "Asia/Jerusalem",
    "Italy": "Europe/Rome",
    "Ivory Coast": "Africa/Abidjan",
    "Jamaica": "America/Jamaica",
    "Japan": "Asia/Tokyo",
    "Jordan": "Asia/Amman",
    "Kazakhstan": "Asia/Almaty",
    "Kenya": "Africa/Nairobi",
    "Kiribati": "Pacific/Tarawa",
    "Kuwait": "Asia/Kuwait",
    "Kyrgyzstan": "Asia/Bishkek",
    "Laos": "Asia/Vientiane",
    "Latvia": "Europe/Riga",
    "Lebanon": "Asia/Beirut",
    "Lesotho": "Africa/Maseru",
    "Liberia": "Africa/Monrovia",
    "Libya": "Africa/Tripoli",
    "Liechtenstein": "Europe/Vaduz",
    "Lithuania": "Europe/Vilnius",
    "Luxembourg": "Europe/Luxembourg",
    "Madagascar": "Indian/Antananarivo",
    "Malawi": "Africa/Blantyre",
    "Malaysia": "Asia/Kuala_Lumpur",
    "Maldives": "Indian/Maldives",
    "Mali": "Africa/Bamako",
    "Malta": "Europe/Malta",
    "Marshall Islands": "Pacific/Majuro",
    "Mauritania": "Africa/Nouakchott",
    "Mauritius": "Indian/Mauritius",
    "Mexico": "America/Mexico_City",
    "Micronesia": "Pacific/Pohnpei",
    "Moldova": "Europe/Chisinau",
    "Monaco": "Europe/Monaco",
    "Mongolia": "Asia/Ulaanbaatar",
    "Montenegro": "Europe/Podgorica",
    "Morocco": "Africa/Casablanca",
    "Mozambique": "Africa/Maputo",
    "Myanmar": "Asia/Yangon",
    "Namibia": "Africa/Windhoek",
    "Nauru": "Pacific/Nauru",
    "Nepal": "Asia/Kathmandu",
    "Netherlands": "Europe/Amsterdam",
    "New Zealand": "Pacific/Auckland",
    "Nicaragua": "America/Managua",
    "Niger": "Africa/Niamey",
    "Nigeria": "Africa/Lagos",
    "North Korea": "Asia/Pyongyang",
    "North Macedonia": "Europe/Skopje",
    "Norway": "Europe/Oslo",
    "Oman": "Asia/Muscat",
    "Pakistan": "Asia/Karachi",
    "Palau": "Pacific/Palau",
    "Palestine": "Asia/Gaza",
    "Panama": "America/Panama",
    "Papua New Guinea": "Pacific/Port_Moresby",
    "Paraguay": "America/Asuncion",
    "Peru": "America/Lima",
    "Philippines": "Asia/Manila",
    "Poland": "Europe/Warsaw",
    "Portugal": "Europe/Lisbon",
    "Qatar": "Asia/Qatar",
    "Romania": "Europe/Bucharest",
    "Russia": "Europe/Moscow",
    "Rwanda": "Africa/Kigali",
    "Saint Kitts and Nevis": "America/St_Kitts",
    "Saint Lucia": "America/St_Lucia",
    "Saint Vincent and the Grenadines": "America/St_Vincent",
    "Samoa": "Pacific/Apia",
    "San Marino": "Europe/San_Marino",
    "Sao Tome and Principe": "Africa/Sao_Tome",
    "Saudi Arabia": "Asia/Riyadh",
    "Senegal": "Africa/Dakar",
    "Serbia": "Europe/Belgrade",
    "Seychelles": "Indian/Mahe",
    "Sierra Leone": "Africa/Freetown",
    "Singapore": "Asia/Singapore",
    "Slovakia": "Europe/Bratislava",
    "Slovenia": "Europe/Ljubljana",
    "Solomon Islands": "Pacific/Guadalcanal",
    "Somalia": "Africa/Mogadishu",
    "South Africa": "Africa/Johannesburg",
    "South Korea": "Asia/Seoul",
    "South Sudan": "Africa/Juba",
    "Spain": "Europe/Madrid",
    "Sri Lanka": "Asia/Colombo",
    "Sudan": "Africa/Khartoum",
    "Suriname": "America/Paramaribo",
    "Sweden": "Europe/Stockholm",
    "Switzerland": "Europe/Zurich",
    "Syria": "Asia/Damascus",
    "Taiwan": "Asia/Taipei",
    "Tajikistan": "Asia/Dushanbe",
    "Tanzania": "Africa/Dar_es_Salaam",
    "Thailand": "Asia/Bangkok",
    "Timor-Leste": "Asia/Dili",
    "Togo": "Africa/Lome",
    "Tonga": "Pacific/Tongatapu",
    "Trinidad and Tobago": "America/Port_of_Spain",
    "Tunisia": "Africa/Tunis",
    "Turkey": "Europe/Istanbul",
    "Turkmenistan": "Asia/Ashgabat",
    "Tuvalu": "Pacific/Funafuti",
    "Uganda": "Africa/Kampala",
    "Ukraine": "Europe/Kyiv",
    "United Arab Emirates": "Asia/Dubai",
    "United Kingdom": "Europe/London",
    "United States": "America/New_York",
    "Uruguay": "America/Montevideo",
    "Uzbekistan": "Asia/Tashkent",
    "Vanuatu": "Pacific/Efate",
    "Vatican City": "Europe/Vatican",
    "Venezuela": "America/Caracas",
    "Vietnam": "Asia/Ho_Chi_Minh",
    "Yemen": "Asia/Aden",
    "Zambia": "Africa/Lusaka",
    "Zimbabwe": "Africa/Harare",
}

_ZONE_CACHE: dict[str, ZoneInfo] = {}


def _zone(tz_name: str) -> ZoneInfo:
    zone = _ZONE_CACHE.get(tz_name)
    if zone is None:
        zone = ZoneInfo(tz_name)
        _ZONE_CACHE[tz_name] = zone
    return zone


def get_call_recommendation(
    country: str | None, *, now: datetime | None = None
) -> dict[str, object]:
    """Return whether now is a good time to call a buyer in `country`.

    Keys: call_recommended (bool | None), call_local_time (str | None,
    e.g. "2:35 PM"), call_timezone (str | None, IANA name), call_reason
    (str, human-readable tooltip text).
    """
    resolved = resolve_country_name(country) if country else None
    tz_name = COUNTRY_TIMEZONES.get(resolved) if resolved else None

    if not tz_name:
        return {
            "call_recommended": None,
            "call_local_time": None,
            "call_timezone": None,
            "call_reason": "Unknown country — can't determine local time.",
        }

    moment = (now or datetime.now(timezone.utc)).astimezone(_zone(tz_name))
    local_time_str = moment.strftime("%I:%M %p").lstrip("0")
    recommended = CALL_WINDOW_START_HOUR <= moment.hour < CALL_WINDOW_END_HOUR

    if recommended:
        reason = f"It's {local_time_str} right now in {resolved} — good time to call (10 AM–5 PM)."
    else:
        reason = f"It's {local_time_str} right now in {resolved} — outside calling hours (10 AM–5 PM)."

    return {
        "call_recommended": recommended,
        "call_local_time": local_time_str,
        "call_timezone": tz_name,
        "call_reason": reason,
    }


def countries_valid_to_call_now(*, now: datetime | None = None) -> list[dict[str, str]]:
    """Countries currently inside the 10 AM–5 PM calling window."""
    moment = now or datetime.now(timezone.utc)
    rows: list[dict[str, str]] = []
    for country in sorted(COUNTRY_TIMEZONES):
        timing = get_call_recommendation(country, now=moment)
        if timing["call_recommended"] is True:
            rows.append(
                {
                    "country": country,
                    "local_time": str(timing["call_local_time"] or ""),
                    "timezone": str(timing["call_timezone"] or ""),
                }
            )
    return rows
