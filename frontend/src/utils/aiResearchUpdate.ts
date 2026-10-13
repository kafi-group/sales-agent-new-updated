/** Shared types + helpers for Modify → AI Research & Update → review/save. */

import type { LeadTableRow, LeadTableRowUpdate } from "../api/client";
import type { ParsedBrandLead } from "./parseBrandAssistantLead";
import { parseBrandAssistantLead } from "./parseBrandAssistantLead";

export type AiResearchFieldKey =
  | "company_name"
  | "country"
  | "industry"
  | "website_url"
  | "address"
  | "contact_name"
  | "contact_email"
  | "contact_phone"
  | "contact_designation";

export const AI_RESEARCH_FIELD_LABELS: Record<AiResearchFieldKey, string> = {
  company_name: "Company name",
  country: "Country",
  industry: "Business type",
  website_url: "Website",
  address: "Address",
  contact_name: "Contact person",
  contact_email: "Email",
  contact_phone: "Phone",
  contact_designation: "Designation",
};

export type AiResearchContactSnapshot = Pick<
  LeadTableRow,
  | "id"
  | "company_name"
  | "country"
  | "industry"
  | "website_url"
  | "address"
  | "city"
  | "contact_id"
  | "contact_name"
  | "contact_email"
  | "contact_phone"
  | "contact_designation"
  | "contact_secondary_mobile"
  | "company_grading"
  | "product_interest"
>;

export type AiResearchFieldChange = {
  field: AiResearchFieldKey;
  label: string;
  before: string;
  after: string;
};

export type AiResearchReviewItem = {
  leadId: number;
  displayName: string;
  changes: AiResearchFieldChange[];
  updatePayload: LeadTableRowUpdate;
};

function isBlank(value: string | null | undefined): boolean {
  const v = (value ?? "").trim();
  return !v || v === "—" || v === "-" || /^not\s+found$/i.test(v);
}

function cleanFound(value: string): string {
  const v = value.trim().replace(/\*\*/g, "");
  if (isBlank(v)) return "";
  if (/^provided data\b/i.test(v)) {
    const rest = v.replace(/^provided data\s*[:\-–]?\s*/i, "").trim();
    return isBlank(rest) ? "" : rest;
  }
  return v;
}

export function snapshotLeadForAiResearch(row: LeadTableRow): AiResearchContactSnapshot {
  return {
    id: row.id,
    company_name: row.company_name ?? "",
    country: row.country,
    industry: row.industry,
    website_url: row.website_url,
    address: row.address,
    city: row.city,
    contact_id: row.contact_id,
    contact_name: row.contact_name,
    contact_email: row.contact_email,
    contact_phone: row.contact_phone ?? row.contact_primary_phone,
    contact_designation: row.contact_designation,
    contact_secondary_mobile: row.contact_secondary_mobile,
    company_grading: row.company_grading,
    product_interest: row.product_interest,
  };
}

export function listMissingAiResearchFields(
  snap: AiResearchContactSnapshot,
): AiResearchFieldKey[] {
  const checks: Array<[AiResearchFieldKey, string | null | undefined]> = [
    ["company_name", snap.company_name],
    ["country", snap.country],
    ["industry", snap.industry],
    ["website_url", snap.website_url],
    ["address", snap.address],
    ["contact_name", snap.contact_name],
    ["contact_email", snap.contact_email],
    ["contact_phone", snap.contact_phone],
    ["contact_designation", snap.contact_designation],
  ];
  return checks.filter(([, v]) => isBlank(v)).map(([k]) => k);
}

export function buildAiResearchPrompt(snap: AiResearchContactSnapshot): string {
  const known: string[] = [];
  const push = (label: string, value: string | null | undefined) => {
    if (!isBlank(value)) known.push(`- ${label}: ${String(value).trim()}`);
  };
  push("Company name", snap.company_name);
  push("Contact person", snap.contact_name);
  push("Phone", snap.contact_phone);
  push("Secondary mobile", snap.contact_secondary_mobile);
  push("Email", snap.contact_email);
  push("Country", snap.country);
  push("City", snap.city);
  push("Business type", snap.industry);
  push("Website", snap.website_url);
  push("Address", snap.address);
  push("Company grading", snap.company_grading);
  push("Product interest", snap.product_interest);

  const missing = listMissingAiResearchFields(snap);
  const missingLabels = missing.map((k) => AI_RESEARCH_FIELD_LABELS[k]);

  return (
    `I have this CRM contact with incomplete data. Search the internet and fill ONLY the missing fields. ` +
    `Do not invent facts — write "Not found" when unknown. Do not change fields that are already provided.\n\n` +
    `Known data:\n${known.length ? known.join("\n") : "- (almost nothing on file)"}\n\n` +
    `Missing fields to find: ${missingLabels.length ? missingLabels.join(", ") : "any useful company/contact details"}.\n\n` +
    `Return a clear structured profile with these labels on their own lines:\n` +
    `Company name:\nCountry:\nBusiness type:\nWebsite:\nAddress:\nPhone:\nEmail:\nContact person:\nDesignation:\n` +
    `Company overview:`
  );
}

function parsedToFieldMap(parsed: ParsedBrandLead): Partial<Record<AiResearchFieldKey, string>> {
  let websiteUrl = "";
  if (parsed.website_domain.trim()) {
    const domain = parsed.website_domain.trim().replace(/^\/+/, "");
    if (parsed.website_prefix === "www.") {
      websiteUrl = `https://www.${domain.replace(/^www\./i, "")}`;
    } else if (parsed.website_prefix === "http://") {
      websiteUrl = `http://${domain}`;
    } else {
      websiteUrl = `https://${domain.replace(/^www\./i, "")}`;
    }
  }

  return {
    company_name: cleanFound(parsed.company_name),
    country: cleanFound(parsed.country),
    industry: cleanFound(parsed.industry),
    website_url: cleanFound(websiteUrl),
    address: cleanFound(parsed.address),
    contact_name: cleanFound(parsed.contact_name),
    contact_email: cleanFound(parsed.contact_email),
    contact_phone: cleanFound(parsed.contact_phone),
    contact_designation: cleanFound(parsed.contact_designation),
  };
}

/** Build before/after review items — only empty CRM fields that AI filled. */
export function buildAiResearchReviewItems(
  contacts: AiResearchContactSnapshot[],
  assistantByLeadId: Record<number, string>,
): AiResearchReviewItem[] {
  const items: AiResearchReviewItem[] = [];

  for (const snap of contacts) {
    const reply = assistantByLeadId[snap.id];
    if (!reply?.trim()) continue;

    const parsed = parseBrandAssistantLead(reply);
    // Prefer contact person from labels if parser left it empty
    if (!parsed.contact_name) {
      const m = reply.match(/(?:contact person|contact name)\s*:\s*(.+)/i);
      if (m?.[1]) parsed.contact_name = cleanFound(m[1]);
    }

    const found = parsedToFieldMap(parsed);
    const changes: AiResearchFieldChange[] = [];
    const updatePayload: LeadTableRowUpdate = {};

    const current: Record<AiResearchFieldKey, string | null | undefined> = {
      company_name: snap.company_name,
      country: snap.country,
      industry: snap.industry,
      website_url: snap.website_url,
      address: snap.address,
      contact_name: snap.contact_name,
      contact_email: snap.contact_email,
      contact_phone: snap.contact_phone,
      contact_designation: snap.contact_designation,
    };

    for (const field of Object.keys(AI_RESEARCH_FIELD_LABELS) as AiResearchFieldKey[]) {
      if (!isBlank(current[field])) continue;
      const after = found[field] ?? "";
      if (!after) continue;
      changes.push({
        field,
        label: AI_RESEARCH_FIELD_LABELS[field],
        before: isBlank(current[field]) ? "—" : String(current[field]),
        after,
      });
      (updatePayload as Record<string, string>)[field] = after;
    }

    if (changes.length === 0) continue;

    // Never wipe existing contact/company data — only patch fields we filled, and
    // target the same contact row when we know its id.
    if (snap.contact_id != null) {
      updatePayload.contact_id = snap.contact_id;
    }
    updatePayload.fill_missing_only = true;

    const displayName =
      snap.company_name?.trim() ||
      snap.contact_name?.trim() ||
      snap.contact_phone?.trim() ||
      `Lead #${snap.id}`;

    items.push({ leadId: snap.id, displayName, changes, updatePayload });
  }

  return items;
}
