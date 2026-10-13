/** ITU country calling codes keyed by ISO 3166-1 alpha-2. */
export const COUNTRY_DIAL_CODES: Record<string, string> = {
  AF: "93",
  AL: "355",
  DZ: "213",
  AD: "376",
  AO: "244",
  AG: "1268",
  AR: "54",
  AM: "374",
  AU: "61",
  AT: "43",
  AZ: "994",
  BS: "1242",
  BH: "973",
  BD: "880",
  BB: "1246",
  BY: "375",
  BE: "32",
  BZ: "501",
  BJ: "229",
  BT: "975",
  BO: "591",
  BA: "387",
  BW: "267",
  BR: "55",
  BN: "673",
  BG: "359",
  BF: "226",
  BI: "257",
  CV: "238",
  KH: "855",
  CM: "237",
  CA: "1",
  CF: "236",
  TD: "235",
  CL: "56",
  CN: "86",
  CO: "57",
  KM: "269",
  CG: "242",
  CI: "225",
  CR: "506",
  HR: "385",
  CU: "53",
  CY: "357",
  CZ: "420",
  CD: "243",
  DK: "45",
  DJ: "253",
  DM: "1767",
  DO: "1809",
  EC: "593",
  EG: "20",
  SV: "503",
  GQ: "240",
  ER: "291",
  EE: "372",
  SZ: "268",
  ET: "251",
  FJ: "679",
  FI: "358",
  FR: "33",
  GA: "241",
  GM: "220",
  GE: "995",
  DE: "49",
  GH: "233",
  GR: "30",
  GD: "1473",
  GT: "502",
  GN: "224",
  GW: "245",
  GY: "592",
  HT: "509",
  HN: "504",
  HK: "852",
  HU: "36",
  IS: "354",
  IN: "91",
  ID: "62",
  IR: "98",
  IQ: "964",
  IE: "353",
  IL: "972",
  IT: "39",
  JM: "1876",
  JP: "81",
  JO: "962",
  KZ: "7",
  KE: "254",
  KI: "686",
  KP: "850",
  KR: "82",
  KW: "965",
  KG: "996",
  LA: "856",
  LV: "371",
  LB: "961",
  LS: "266",
  LR: "231",
  LY: "218",
  LI: "423",
  LT: "370",
  LU: "352",
  MG: "261",
  MW: "265",
  MY: "60",
  MV: "960",
  ML: "223",
  MT: "356",
  MH: "692",
  MR: "222",
  MU: "230",
  MX: "52",
  FM: "691",
  MD: "373",
  MC: "377",
  MN: "976",
  ME: "382",
  MA: "212",
  MZ: "258",
  MM: "95",
  NA: "264",
  NR: "674",
  NP: "977",
  NL: "31",
  NZ: "64",
  NI: "505",
  NE: "227",
  NG: "234",
  MK: "389",
  NO: "47",
  OM: "968",
  PK: "92",
  PS: "970",
  PW: "680",
  PA: "507",
  PG: "675",
  PY: "595",
  PE: "51",
  PH: "63",
  PL: "48",
  PT: "351",
  QA: "974",
  RO: "40",
  RU: "7",
  RW: "250",
  KN: "1869",
  LC: "1758",
  VC: "1784",
  WS: "685",
  SM: "378",
  ST: "239",
  SA: "966",
  SN: "221",
  RS: "381",
  SC: "248",
  SL: "232",
  SG: "65",
  SK: "421",
  SI: "386",
  SB: "677",
  SO: "252",
  ZA: "27",
  SS: "211",
  ES: "34",
  LK: "94",
  SD: "249",
  SR: "597",
  SE: "46",
  CH: "41",
  SY: "963",
  TW: "886",
  TJ: "992",
  TZ: "255",
  TH: "66",
  TL: "670",
  TG: "228",
  TO: "676",
  TT: "1868",
  TN: "216",
  TR: "90",
  TM: "993",
  TV: "688",
  UG: "256",
  UA: "380",
  AE: "971",
  GB: "44",
  US: "1",
  UY: "598",
  UZ: "998",
  VU: "678",
  VA: "39",
  VE: "58",
  VN: "84",
  YE: "967",
  ZM: "260",
  ZW: "263",
};

export function getDialCode(countryCode: string): string {
  return COUNTRY_DIAL_CODES[countryCode.toUpperCase()] ?? "";
}

export function formatDialCode(countryCode: string): string {
  const dial = getDialCode(countryCode);
  return dial ? `+${dial}` : "";
}

/** Build E.164 from ISO country code and local digits. */
export function buildE164(countryCode: string, localNumber: string): string | null {
  const raw = localNumber.trim();
  if (!raw) return null;

  if (raw.startsWith("+") || raw.startsWith("00")) {
    const digits = raw.startsWith("00")
      ? `+${raw.slice(2).replace(/\D/g, "")}`
      : `+${raw.slice(1).replace(/\D/g, "")}`;
    return /^\+\d{8,15}$/.test(digits) ? digits : null;
  }

  const dial = getDialCode(countryCode);
  if (!dial) return null;
  const local = raw.replace(/\D/g, "").replace(/^0+/, "");
  if (!local) return null;
  const full = `+${dial}${local}`;
  return /^\+\d{8,15}$/.test(full) ? full : null;
}

/** Longest dial-code match first so +971… beats +9… */
const _DIAL_CODE_ENTRIES = Object.entries(COUNTRY_DIAL_CODES).sort(
  (a, b) => b[1].length - a[1].length,
);

/**
 * Split a phone string into dialpad country + national digits.
 * Prefers an explicit +/00 prefix; otherwise uses ``countryHint`` ISO code.
 */
export function parsePhoneForDialpad(
  phone: string,
  countryHint?: string | null,
): { countryCode: string; digits: string } | null {
  const raw = phone.trim();
  if (!raw) return null;

  let digitsOnly = "";
  if (raw.startsWith("+")) {
    digitsOnly = raw.slice(1).replace(/\D/g, "");
  } else if (raw.startsWith("00")) {
    digitsOnly = raw.slice(2).replace(/\D/g, "");
  } else {
    const local = raw.replace(/\D/g, "").replace(/^0+/, "");
    if (!local) return null;
    const hint = (countryHint || "PK").toUpperCase();
    return { countryCode: COUNTRY_DIAL_CODES[hint] ? hint : "PK", digits: local.slice(0, 20) };
  }

  if (digitsOnly.length < 6) return null;

  for (const [iso, dial] of _DIAL_CODE_ENTRIES) {
    if (digitsOnly.startsWith(dial) && digitsOnly.length > dial.length) {
      return {
        countryCode: iso,
        digits: digitsOnly.slice(dial.length).slice(0, 20),
      };
    }
  }

  return { countryCode: "PK", digits: digitsOnly.slice(0, 20) };
}
