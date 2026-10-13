/** Per-recipient merge fields — supports {{company_name}}, [company_name], [Company Name]. */

export type PersonalizeLead = {
  company_name?: string | null;
  contact_name?: string | null;
  contact_email?: string | null;
  designation?: string | null;
  country?: string | null;
  industry?: string | null;
};

const FIELD_ALIASES: Record<string, Array<keyof PersonalizeLead | string>> = {
  company_name: ["company_name", "company name", "company"],
  contact_name: [
    "contact_name",
    "contact name",
    "contact",
    "client name",
    "client_name",
    "client",
    "name",
  ],
  contact_email: ["contact_email", "contact email", "email"],
  designation: ["designation", "title", "job title", "job_title"],
  country: ["country"],
  industry: ["industry"],
};

export function resolveContactSalutationName(lead: PersonalizeLead): string {
  return (lead.contact_name || lead.company_name || "Sir/Madam").trim();
}

function fieldValue(lead: PersonalizeLead, key: string): string {
  const k = key as keyof PersonalizeLead;
  if (k === "contact_name") {
    return resolveContactSalutationName(lead);
  }
  if (k === "company_name") {
    return (lead.company_name || "").trim();
  }
  if (k === "contact_email") {
    return (lead.contact_email || "").trim();
  }
  if (k === "designation") {
    return (lead.designation || "").trim();
  }
  return String(lead[k] ?? "").trim();
}

function aliasToCanonical(alias: string): string | null {
  const norm = alias.trim().toLowerCase().replace(/\s+/g, " ");
  for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
    if (aliases.some((a) => a.toLowerCase().replace(/\s+/g, " ") === norm)) {
      return canonical;
    }
  }
  return null;
}

export function personalizeEmailText(template: string, lead: PersonalizeLead): string {
  if (!template) return template;
  let out = template;

  // {{company_name}} and {{Company Name}}
  out = out.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, rawKey: string) => {
    const canonical = aliasToCanonical(rawKey);
    return canonical ? fieldValue(lead, canonical) : _match;
  });

  // [company_name] and [Company Name]
  out = out.replace(/\[([^\]]+)\]/g, (match, rawKey: string) => {
    const canonical = aliasToCanonical(rawKey);
    return canonical ? fieldValue(lead, canonical) : match;
  });

  return out;
}

function plainBodyStart(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .trim();
}

/** Prepend "Dear {name}," when the body does not already open with a salutation. */
export function ensureDearSalutation(body: string, contactName: string): string {
  if (!body?.trim()) {
    const name = (contactName || "Sir/Madam").trim();
    return `Dear ${name},\n\n`;
  }
  if (/^dear\s+/i.test(plainBodyStart(body))) return body;
  const name = (contactName || "Sir/Madam").trim();
  const greeting = `Dear ${name},`;
  const isHtml = /<[a-z][\s\S]*>/i.test(body);
  if (isHtml) {
    return `<p>${greeting}</p>${body}`;
  }
  return `${greeting}\n\n${body}`;
}
