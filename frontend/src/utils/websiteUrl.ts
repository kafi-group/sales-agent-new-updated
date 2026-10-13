/** Website URL entry: prefix select + domain only (optional). */

export type WebsitePrefix = "https://" | "http://" | "www.";

export function composeWebsiteUrl(prefix: WebsitePrefix, domain: string): string | undefined {
  const raw = domain.trim().replace(/^\/+/, "");
  if (!raw) return undefined;

  // User pasted a full URL — keep it.
  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }

  // Strip accidental www. if prefix already adds it.
  const host = raw.replace(/^www\./i, "");
  if (!host) return undefined;

  if (prefix === "www.") {
    return `https://www.${host}`;
  }
  return `${prefix}${host}`;
}

export function splitWebsiteUrl(value: string | null | undefined): {
  prefix: WebsitePrefix;
  domain: string;
} {
  const raw = (value || "").trim();
  if (!raw) return { prefix: "https://", domain: "" };

  if (/^https:\/\/www\./i.test(raw)) {
    return { prefix: "www.", domain: raw.replace(/^https:\/\/www\./i, "") };
  }
  if (/^http:\/\//i.test(raw)) {
    return { prefix: "http://", domain: raw.replace(/^http:\/\//i, "") };
  }
  if (/^https:\/\//i.test(raw)) {
    return { prefix: "https://", domain: raw.replace(/^https:\/\//i, "") };
  }
  if (/^www\./i.test(raw)) {
    return { prefix: "www.", domain: raw.replace(/^www\./i, "") };
  }
  return { prefix: "https://", domain: raw };
}
