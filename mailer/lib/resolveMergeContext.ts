/** Load buyer/contact merge fields for compose send (Railway API). */

import type { PersonalizeLead } from "@/lib/personalizeEmail";

const PRODUCTION_API_BASE = "https://kafi-sales-agent-production.up.railway.app/api";

function apiBase(): string {
  const candidates = [
    process.env.KAFI_API_BASE_URL,
    process.env.NEXT_PUBLIC_KAFI_API_BASE_URL,
    PRODUCTION_API_BASE,
  ];
  for (const raw of candidates) {
    const base = (raw || "").trim().replace(/\/$/, "");
    if (base) return base;
  }
  return "";
}

type ContactRow = {
  full_name?: string | null;
  email?: string | null;
  designation?: string | null;
};

export async function resolveMergeContext(
  authToken: string,
  opts: {
    buyer_id?: number;
    to_email?: string;
    company_name?: string;
    contact_name?: string;
    designation?: string;
  },
): Promise<PersonalizeLead> {
  const lead: PersonalizeLead = {
    company_name: opts.company_name?.trim() || undefined,
    contact_name: opts.contact_name?.trim() || undefined,
    contact_email: opts.to_email?.trim() || undefined,
    designation: opts.designation?.trim() || undefined,
  };

  const base = apiBase();
  const token = authToken.trim();
  if (!base || !token || !opts.buyer_id) {
    return lead;
  }

  try {
    const headers = { Authorization: `Bearer ${token}` };
    const [buyerRes, contactsRes] = await Promise.all([
      fetch(`${base}/leads/${opts.buyer_id}`, { headers, cache: "no-store" }),
      fetch(`${base}/leads/${opts.buyer_id}/contacts`, { headers, cache: "no-store" }),
    ]);

    if (buyerRes.ok) {
      const buyer = (await buyerRes.json()) as {
        company_name?: string;
        country?: string;
        industry?: string;
      };
      if (buyer.company_name) lead.company_name = buyer.company_name;
      if (buyer.country) lead.country = buyer.country;
      if (buyer.industry) lead.industry = buyer.industry;
    }

    if (contactsRes.ok) {
      const contacts = (await contactsRes.json()) as ContactRow[];
      const toNorm = (opts.to_email || "").trim().toLowerCase();
      const matched =
        contacts.find((c) => (c.email || "").trim().toLowerCase() === toNorm) ||
        contacts.find((c) => (c.full_name || "").trim()) ||
        contacts[0];
      if (matched) {
        if (!lead.contact_name && matched.full_name) lead.contact_name = matched.full_name;
        if (!lead.designation && matched.designation) lead.designation = matched.designation;
        if (!lead.contact_email && matched.email) lead.contact_email = matched.email;
      }
    }
  } catch {
    /* best-effort — send still works with partial merge fields */
  }

  return lead;
}
