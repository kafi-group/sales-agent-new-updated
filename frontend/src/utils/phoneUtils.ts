import { findCountry } from "../data/countries";
import { COUNTRY_DIAL_CODES } from "../data/countryDialCodes";

/** Longest dial-code match first so +971… beats +9… */
const DIAL_CODE_LIST = Object.entries(COUNTRY_DIAL_CODES)
  .map(([iso, code]) => ({ iso, code }))
  .sort((a, b) => b.code.length - a.code.length);

export interface PhoneZeroCheckResult {
  hasZeroError: boolean;
  originalPhone: string;
  dialCode: string; // e.g. "92"
  iso: string; // e.g. "PK"
  correctedPhone: string; // e.g. "+923142867152"
}

export function detectLeadingZeroAfterCountryCode(
  phone: string,
  _countryHint?: string | null
): PhoneZeroCheckResult | null {
  if (!phone) return null;
  const raw = phone.trim();

  let dialCode = "";
  let iso = "";
  let restDigits = "";

  if (raw.startsWith("+")) {
    const digitsOnly = raw.slice(1).replace(/\D/g, "");
    for (const item of DIAL_CODE_LIST) {
      if (digitsOnly.startsWith(item.code)) {
        dialCode = item.code;
        iso = item.iso;
        restDigits = digitsOnly.slice(item.code.length);
        break;
      }
    }
  } else if (raw.startsWith("00")) {
    const digitsOnly = raw.slice(2).replace(/\D/g, "");
    for (const item of DIAL_CODE_LIST) {
      if (digitsOnly.startsWith(item.code)) {
        dialCode = item.code;
        iso = item.iso;
        restDigits = digitsOnly.slice(item.code.length);
        break;
      }
    }
  }

  // Check if restDigits starts with '0' immediately after the country code
  if (dialCode && restDigits.startsWith("0")) {
    const fixedRest = restDigits.replace(/^0+/, "");
    if (fixedRest.length >= 6) {
      const correctedPhone = `+${dialCode}${fixedRest}`;
      return {
        hasZeroError: true,
        originalPhone: raw,
        dialCode,
        iso,
        correctedPhone,
      };
    }
  }

  return null;
}

function dialPrefixForCountryHint(countryHint?: string | null): string | null {
  const match = findCountry(countryHint);
  if (!match) return null;
  const code = COUNTRY_DIAL_CODES[match.code as keyof typeof COUNTRY_DIAL_CODES];
  return code ?? null;
}

function nationalDigitsToE164(digits: string, countryHint?: string | null): string | null {
  const d = digits.replace(/\D/g, "");
  if (!d) return null;

  const prefixes: string[] = [];
  const fromCountry = dialPrefixForCountryHint(countryHint);
  if (fromCountry) prefixes.push(fromCountry);

  for (const item of DIAL_CODE_LIST) {
    if (d.startsWith(item.code) && !prefixes.includes(item.code)) {
      prefixes.push(item.code);
    }
  }
  if (/^5\d{8}$/.test(d) && !prefixes.includes("971")) {
    prefixes.push("971");
  }

  const national = d.startsWith("0") ? d.slice(1) : d;
  for (const prefix of prefixes) {
    const candidate = national.startsWith(prefix) ? `+${national}` : `+${prefix}${national}`;
    if (/^\+\d{8,15}$/.test(candidate)) return candidate;
  }
  return null;
}

/** Best-effort E.164 for UI preview (matches backend send normalization). */
export function normalizeE164Preview(phone: string, countryHint?: string | null): string | null {
  if (!phone?.trim()) return null;

  const zeroFix = detectLeadingZeroAfterCountryCode(phone, countryHint);
  if (zeroFix?.correctedPhone) return zeroFix.correctedPhone;

  let cleaned = phone.trim().replace(/[^\d+]/g, "");
  if (cleaned.startsWith("00")) cleaned = `+${cleaned.slice(2)}`;

  const bare = cleaned.startsWith("+") ? cleaned.slice(1) : cleaned;

  if (!cleaned.startsWith("+")) {
    if (/^03\d{9}$/.test(bare)) cleaned = `+92${bare.slice(1)}`;
    else if (/^3\d{9}$/.test(bare)) cleaned = `+92${bare}`;
    else if (/^92\d{10}$/.test(bare)) cleaned = `+${bare}`;
    else {
      const fixed = nationalDigitsToE164(bare, countryHint);
      cleaned = fixed ?? `+${bare}`;
    }
  } else if (/^\+03\d{9}$/.test(cleaned)) {
    cleaned = `+92${cleaned.slice(2)}`;
  } else if (/^\+0\d{8,14}$/.test(cleaned)) {
    const fixed = nationalDigitsToE164(cleaned.slice(2), countryHint);
    if (fixed) cleaned = fixed;
  }

  if (/^\+\d{8,15}$/.test(cleaned)) return cleaned;
  const fixed = nationalDigitsToE164(bare, countryHint);
  return fixed && /^\+\d{8,15}$/.test(fixed) ? fixed : null;
}

/** One-line confirmation shown above Send in Meta template modals. */
export function whatsAppMetaSendPreviewLine(opts: {
  toPhone?: string | null;
  countryHint?: string | null;
  recipientCount?: number;
  channel?: "meta" | "personal";
}): string {
  const personal = opts.channel === "personal";
  const count = opts.recipientCount ?? 1;

  if (opts.toPhone?.trim()) {
    const formatted =
      normalizeE164Preview(opts.toPhone.trim(), opts.countryHint) ?? opts.toPhone.trim();
    if (personal) {
      return `Your scanned WhatsApp will message ${formatted}.`;
    }
    return `Meta Cloud API will send to ${formatted}.`;
  }

  if (personal) {
    return count === 1
      ? "Your scanned WhatsApp will message this lead’s best mobile."
      : `Your scanned WhatsApp will message each lead’s number (${count} contacts).`;
  }

  return count === 1
    ? "Meta Cloud API will send to this lead’s best WhatsApp mobile (country-aware)."
    : `Meta Cloud API will send to each lead’s best WhatsApp mobile (${count} contacts).`;
}
