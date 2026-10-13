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
