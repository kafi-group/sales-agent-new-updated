/** Parse structured brand-assistant markdown into lead form fields. */

export interface ParsedBrandLead {
  company_name: string;
  country: string;
  industry: string;
  website_domain: string;
  website_prefix: "https://" | "http://" | "www.";
  address: string;
  contact_phone: string;
  contact_email: string;
  contact_name: string;
  contact_designation: string;
}

const EMPTY: ParsedBrandLead = {
  company_name: "",
  country: "",
  industry: "",
  website_domain: "",
  website_prefix: "https://",
  address: "",
  contact_phone: "",
  contact_email: "",
  contact_name: "",
  contact_designation: "",
};

function pickLine(text: string, patterns: RegExp[]): string {
  for (const line of text.split("\n")) {
    const trimmed = line.replace(/^[-*#\s]+/, "").trim();
    for (const re of patterns) {
      const m = trimmed.match(re);
      if (m?.[1]) return m[1].trim().replace(/\*\*/g, "");
    }
  }
  return "";
}

function pickAllPhones(text: string): string {
  const phones = text.match(/\+?\d[\d\s().-]{7,}\d/g) ?? [];
  return phones[0]?.trim() ?? "";
}

function pickEmail(text: string): string {
  const m = text.match(/[\w.+-]+@[\w.-]+\.\w{2,}/);
  return m?.[0] ?? "";
}

function parseWebsite(raw: string): Pick<ParsedBrandLead, "website_prefix" | "website_domain"> {
  const value = raw.trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  if (!value) return { website_prefix: "https://", website_domain: "" };
  if (raw.trim().toLowerCase().startsWith("http://")) {
    return { website_prefix: "http://", website_domain: value };
  }
  if (raw.trim().toLowerCase().startsWith("www.")) {
    return { website_prefix: "www.", website_domain: value };
  }
  return { website_prefix: "https://", website_domain: value };
}

export function parseBrandAssistantLead(text: string): ParsedBrandLead {
  if (!text.trim()) return { ...EMPTY };

  const company =
    pickLine(text, [
      /^(?:\*\*)?(?:brand name|company name|parent company)(?:\*\*)?:\s*(.+)$/i,
      /^(?:\*\*)?1\.\s*Brand Information[\s\S]*?(?:brand name|company name):\s*(.+)$/i,
    ]) ||
    pickLine(text, [/^#\s*(.+)$/]) ||
    "";

  const country =
    pickLine(text, [
      /^(?:\*\*)?(?:country|head office country)(?:\*\*)?:\s*(.+)$/i,
    ]) ||
    (text.match(/\b(United Arab Emirates|UAE|Saudi Arabia|Qatar|Oman|Kuwait|Bahrain|Pakistan|UK|USA)\b/i)?.[0] ??
      "");

  const industry = pickLine(text, [
    /^(?:\*\*)?(?:business type|industry|sector)(?:\*\*)?:\s*(.+)$/i,
  ]);

  const websiteRaw = pickLine(text, [
    /^(?:\*\*)?website(?:\*\*)?:\s*(.+)$/i,
    /^(?:\*\*)?website url(?:\*\*)?:\s*(.+)$/i,
  ]);
  const website = parseWebsite(websiteRaw);

  const address = pickLine(text, [
    /^(?:\*\*)?(?:head office address|address|office address)(?:\*\*)?:\s*(.+)$/i,
  ]);

  const phone =
    pickLine(text, [/^(?:\*\*)?(?:phone|phone numbers?|tel)(?:\*\*)?:\s*(.+)$/i]) ||
    pickAllPhones(text);

  const email =
    pickLine(text, [/^(?:\*\*)?(?:email|email addresses?)(?:\*\*)?:\s*(.+)$/i]) ||
    pickEmail(text);

  const designation = pickLine(text, [
    /^(?:\*\*)?(?:designation|role|job title)(?:\*\*)?:\s*(.+)$/i,
  ]);

  const contactName = pickLine(text, [
    /^(?:\*\*)?(?:contact person|contact name|person name)(?:\*\*)?:\s*(.+)$/i,
  ]);

  return {
    company_name: company,
    country,
    industry: industry.slice(0, 120),
    website_domain: website.website_domain,
    website_prefix: website.website_prefix,
    address,
    contact_phone: phone,
    contact_email: email,
    contact_name: contactName,
    contact_designation: designation,
  };
}
