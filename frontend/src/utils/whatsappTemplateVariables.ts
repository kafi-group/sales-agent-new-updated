/** Resolve Meta WhatsApp template {{1}}…{{n}} from lead/contact context. */

export type WhatsAppLeadContext = {
  company_name?: string | null;
  contact_name?: string | null;
  country?: string | null;
};

export function resolveContactSalutationName(lead: WhatsAppLeadContext): string {
  return (lead.contact_name || lead.company_name || "Sir/Madam").trim();
}

export function renderWhatsAppTemplatePreview(
  bodyText: string | null | undefined,
  variables: string[],
): string {
  if (!bodyText) return "";
  let out = bodyText;
  for (let i = 0; i < variables.length; i += 1) {
    const value = (variables[i] || "").trim();
    out = out.replaceAll(`{{${i + 1}}}`, value || `{{${i + 1}}}`);
  }
  // Legacy templates may contain bracket placeholders in the approved body text.
  const company = variables[1] || variables[0] || "";
  const contact = variables[0] || company;
  out = out.replace(/\[Company Name\]/gi, company);
  out = out.replace(/\[Contact Name\]/gi, contact);
  out = out.replace(/\[company_name\]/gi, company);
  out = out.replace(/\[contact_name\]/gi, contact);
  return out;
}

function contextAround(body: string, index: number, placeholder: string): string {
  if (index < 0) return "";
  return body.slice(Math.max(0, index - 40), index + placeholder.length + 40).toLowerCase();
}

export function suggestWhatsAppTemplateVariables(
  bodyText: string | null | undefined,
  variableCount: number,
  lead: WhatsAppLeadContext,
): string[] {
  const contact = resolveContactSalutationName(lead);
  const company = (lead.company_name || "").trim();
  const country = (lead.country || "").trim();
  const body = bodyText || "";

  const values: string[] = [];
  for (let i = 1; i <= variableCount; i += 1) {
    const placeholder = `{{${i}}}`;
    const idx = body.indexOf(placeholder);
    const context = contextAround(body, idx, placeholder);

    if (/dear\s*\{\{/.test(context) || (i === 1 && /^dear\s*\{\{1\}\}/i.test(body.trim()))) {
      values.push(contact);
    } else if (/company|organisation|organization|firm|business|client/.test(context)) {
      values.push(company || contact);
    } else if (/country|region|market/.test(context)) {
      values.push(country || company || contact);
    } else if (i === 1) {
      values.push(contact);
    } else if (i === 2) {
      values.push(company || contact);
    } else {
      values.push(company || contact);
    }
  }
  return values;
}

const PLACEHOLDER_VALUES = new Set([
  "[company name]",
  "[contact name]",
  "[company_name]",
  "[contact_name]",
  "company name",
  "contact name",
]);

export function mergeWhatsAppTemplateVariables(
  existing: string[],
  suggested: string[],
): string[] {
  return suggested.map((suggestedValue, index) => {
    const current = (existing[index] || "").trim();
    if (!current) return suggestedValue;
    if (PLACEHOLDER_VALUES.has(current.toLowerCase())) return suggestedValue;
    if (/^\{\{\d+\}\}$/.test(current)) return suggestedValue;
    return current;
  });
}
