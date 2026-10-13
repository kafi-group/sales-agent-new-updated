import { COUNTRY_TIMEZONES } from "../data/countryTimezones";

export const PKT_TIMEZONE = "Asia/Karachi";

export function timezoneForCountry(country: string | null | undefined): string {
  const name = (country || "").trim();
  if (!name) return PKT_TIMEZONE;
  if (COUNTRY_TIMEZONES[name]) return COUNTRY_TIMEZONES[name];
  const lower = name.toLowerCase();
  const hit = Object.entries(COUNTRY_TIMEZONES).find(([k]) => k.toLowerCase() === lower);
  return hit?.[1] ?? PKT_TIMEZONE;
}

function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0;
  return {
    y: Number(get("year")),
    mo: Number(get("month")),
    d: Number(get("day")),
    h: hour,
    mi: Number(get("minute")),
    s: Number(get("second")),
  };
}

/** Format a Date as `YYYY-MM-DDTHH:mm` wall clock in `timeZone`. */
export function toLocalInputValue(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;
}

/**
 * Interpret datetime-local wall time as local clock in `timeZone`, return UTC Date.
 * Example: Canada 14:00 on 2026-09-14 → correct UTC instant.
 */
export function wallTimeInZoneToDate(localInput: string, timeZone: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(localInput.trim());
  if (!m) throw new Error("Invalid date/time");
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  let utcMs = Date.UTC(y, mo - 1, d, h, mi, 0);
  for (let i = 0; i < 4; i += 1) {
    const parts = zonedParts(new Date(utcMs), timeZone);
    const asIfUtc = Date.UTC(parts.y, parts.mo - 1, parts.d, parts.h, parts.mi, 0);
    const desired = Date.UTC(y, mo - 1, d, h, mi, 0);
    utcMs += desired - asIfUtc;
  }
  return new Date(utcMs);
}

export function formatInTimezone(
  date: Date,
  timeZone: string,
  opts?: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    ...opts,
  }).format(date);
}

export function formatTimezoneShort(timeZone: string, at: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "short",
    }).formatToParts(at);
    return parts.find((p) => p.type === "timeZoneName")?.value ?? timeZone;
  } catch {
    return timeZone;
  }
}
